/**
 * notebook.ts — 解析与规范化 .ipynb（nbformat v3 / v4）
 *
 * 目标：把两种历史格式的差异在入口处抹平，下游渲染器只面对
 * 一种干净的中间表示（NormalizedCell / NormOutput），不必到处写 if (v3)。
 *
 * v3 差异清单（均在本文件内抹平，下游无感知）：
 * - cells 在 worksheets[n].cells 而非顶层
 * - heading_cell（带 level 字段）→ 归一化成带 # 的 markdown
 * - 代码源字段叫 input，执行计数叫 prompt_number
 * - 输出平铺（png/jpeg/svg/latex/text 键）而非 mimebundle
 * - 输出类型名 pyout / pyerr（v4 为 execute_result / error）
 */

/** 归一化后的输出 */
export interface NormOutput {
  kind: 'stream' | 'html' | 'image' | 'text' | 'latex' | 'error';
  /** stream / text / error 转储用的纯文本（已去除 ANSI 转义） */
  text?: string;
  /** 已 sanitize 的 HTML 片段（text/html 或 svg 输出） */
  html?: string;
  /** 图片 mime + base64 负载（不含 data: 前缀） */
  mime?: string;
  data?: string;
  /** LaTeX 源码（text/latex 输出） */
  latex?: string;
  /** error 输出三元组 */
  ename?: string;
  evalue?: string;
}

/** 归一化后的单元格 */
export interface NormCell {
  type: 'markdown' | 'code' | 'raw';
  source: string;
  execCount: number | null;
  outputs: NormOutput[];
  /** 附件名 → data URI（nbformat attachments，转成 data: 直接可嵌） */
  attachments: Map<string, string>;
}

export interface NotebookDoc {
  nbformat: 3 | 4;
  cells: NormCell[];
  /** 代码语言（用于高亮），如 python */
  language: string;
  kernelName: string;
  /** 交互式 widget 输出数量（渲染时跳过并在 UI 提示） */
  widgetCount: number;
}

const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07|[\x00-\x08\x0b\x0c\x0e-\x1f]/g;

/** 去掉终端 ANSI 颜色/控制序列，输出文本只留可读内容 */
export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '');
}

/** nbformat 里 source 可能是字符串或多行数组，统一成字符串 */
function joinSource(src: unknown): string {
  if (Array.isArray(src)) return src.map(String).join('');
  return typeof src === 'string' ? src : String(src ?? '');
}

/** 附件 map（名 → { mime: base64 }）转成 名 → data URI */
function normalizeAttachments(att: unknown): Map<string, string> {
  const out = new Map<string, string>();
  if (att && typeof att === 'object') {
    for (const [name, bundle] of Object.entries(att as Record<string, unknown>)) {
      if (bundle && typeof bundle === 'object') {
        const entries = Object.entries(bundle as Record<string, string>);
        if (entries.length > 0) {
          const [mime, b64] = entries[0];
          out.set(name, `data:${mime};base64,${b64}`);
        }
      }
    }
  }
  return out;
}

/** 从 language_info / kernelspec 推断 hljs 语言名 */
function detectLanguage(meta: Record<string, any>): string {
  const lexer = String(meta?.language_info?.pygments_lexer ?? '');
  if (/^ipython/.test(lexer)) return 'python';
  const lang = String(meta?.language_info?.name ?? '').toLowerCase();
  if (lang === 'ipython' || lang === 'ipython3') return 'python';
  return lang || 'python';
}

class WidgetCounter {
  count = 0;
  /** v4：mimebundle 里带 widget key 即计数；返回是否为 widget 包 */
  checkBundle(data: unknown): boolean {
    if (data && typeof data === 'object' &&
        'application/vnd.jupyter.widget-view+json' in (data as object)) {
      this.count++;
      return true;
    }
    return false;
  }
  /** v3：output_type 直接是 display_data 且带 'application/vnd.jupyter.widget-view+json' 字段 */
  checkV3Output(o: Record<string, unknown>): void {
    if ('application/vnd.jupyter.widget-view+json' in o) this.count++;
  }
}

/** 把 v4 mimebundle 输出转成 NormOutput[]（display_data / execute_result 共用） */
function bundleToOutputs(
  data: Record<string, unknown> | undefined,
  widgets: WidgetCounter,
): NormOutput[] {
  const outs: NormOutput[] = [];
  if (!data) return outs;
  const isWidget = widgets.checkBundle(data);
  const get = (k: string) => {
    const v = data[k];
    if (v === undefined || v === null) return undefined;
    return Array.isArray(v) ? v.map(String).join('') : String(v);
  };
  const html = get('text/html');
  if (html !== undefined) outs.push({ kind: 'html', html });
  const svg = get('image/svg+xml');
  if (svg !== undefined) outs.push({ kind: 'html', html: svg });
  for (const mime of ['image/png', 'image/jpeg', 'image/gif', 'image/webp']) {
    const v = get(mime);
    if (v !== undefined) outs.push({ kind: 'image', mime, data: v });
  }
  const latex = get('text/latex');
  if (latex !== undefined) outs.push({ kind: 'latex', latex });
  // text/plain 放最后：Jupyter 里 html/svg 存在时纯文本不重复渲染；
  // widget 输出（只有 text/plain 占位）整包跳过，避免 "Interactive widget" 文本泄漏
  const text = get('text/plain');
  if (text !== undefined && outs.length === 0 && !isWidget) {
    outs.push({ kind: 'text', text: stripAnsi(text) });
  }
  return outs;
}

/** v4 输出（stream/display_data/execute_result/error）归一化 */
function normV4Output(o: Record<string, any>, widgets: WidgetCounter): NormOutput[] {
  switch (o.output_type) {
    case 'stream':
      return [{ kind: 'stream', text: stripAnsi(joinSource(o.text)) }];
    case 'display_data':
    case 'execute_result':
      return bundleToOutputs(o.data, widgets);
    case 'error':
      return [{
        kind: 'error',
        ename: stripAnsi(String(o.ename ?? 'Error')),
        evalue: stripAnsi(String(o.evalue ?? '')),
        text: stripAnsi(joinSource(o.traceback)),
      }];
    default:
      return [];
  }
}

/** v3（nbformat 3，如 Anaconda 老环境导出）输出归一化：字段直接平铺而非 mimebundle */
function normV3Output(o: Record<string, any>, widgets: WidgetCounter): NormOutput[] {
  const outs: NormOutput[] = [];
  const get = (k: string) => {
    const v = o[k];
    if (v === undefined || v === null) return undefined;
    return Array.isArray(v) ? v.map(String).join('') : String(v);
  };
  widgets.checkV3Output(o);
  switch (o.output_type) {
    case 'stream':
      return [{ kind: 'stream', text: stripAnsi(get('text') ?? '') }];
    case 'pyout':
    case 'display_data': {
      // v3 pyout 的 text/html 键名是 html（不带 text/ 前缀）
      const html = get('html');
      if (html !== undefined) outs.push({ kind: 'html', html });
      const svg = get('svg');
      if (svg !== undefined) outs.push({ kind: 'html', html: svg });
      for (const [k, mime] of [['png', 'image/png'], ['jpeg', 'image/jpeg'], ['gif', 'image/gif']] as const) {
        const v = get(k);
        if (v !== undefined) outs.push({ kind: 'image', mime, data: v });
      }
      const latex = get('latex');
      if (latex !== undefined) outs.push({ kind: 'latex', latex });
      // v3 的纯文本键是 text（pyout 里作为 text/plain 出现）
      const text = get('text');
      if (text !== undefined && outs.length === 0) outs.push({ kind: 'text', text: stripAnsi(text) });
      return outs;
    }
    case 'pyerr':
      return [{
        kind: 'error',
        ename: stripAnsi(String(o.ename ?? 'Error')),
        evalue: stripAnsi(String(o.evalue ?? '')),
        text: stripAnsi(joinSource(o.traceback)),
      }];
    default:
      return outs;
  }
}

/**
 * 解析并校验 .ipynb JSON。不合法时抛出带中文说明的 Error，
 * message 会直接展示给用户。
 */
export function parseNotebook(jsonText: string): NotebookDoc {
  let raw: any;
  try {
    raw = JSON.parse(jsonText);
  } catch (e) {
    throw new Error('文件不是合法的 JSON，无法作为 .ipynb 解析。');
  }
  if (!raw || typeof raw !== 'object') {
    throw new Error('这看起来不是一个 Jupyter Notebook 文件。');
  }
  // nbformat v3（老 Anaconda/ipython 2.x 导出）：cells 藏在 worksheets[n].cells，
  // 代码字段叫 input/prompt_number，输出平铺（png/jpeg/svg/latex 而非 mimebundle）。
  // v4 及未知版本：cells 在顶层。三处差异在下方归一化函数里抹平。
  const nbformat: 3 | 4 = raw.nbformat === 3 ? 3 : 4;
  let cellList: unknown[] | undefined = raw.cells;
  if (nbformat === 3 && !Array.isArray(cellList)) {
    const sheets = Array.isArray(raw.worksheets) ? raw.worksheets : [];
    cellList = sheets.flatMap((ws: Record<string, any>) =>
      Array.isArray(ws?.cells) ? ws.cells : [],
    );
  }
  if (!Array.isArray(cellList)) {
    throw new Error('缺少 cells 字段——这看起来不是一个 Jupyter Notebook 文件。');
  }
  const meta = raw.metadata ?? {};
  const widgets = new WidgetCounter();

  const cells: NormCell[] = (cellList as Record<string, any>[]).map((c) => {
    // v3 标题单元是 heading_cell；这里统一映射：heading → markdown（层级进 source）
    const isHeading = c.cell_type === 'heading';
    const type = c.cell_type === 'code' ? 'code'
      : c.cell_type === 'raw' ? 'raw'
      : 'markdown'; // markdown / heading
    let source = joinSource(c.source);
    if (isHeading) source = `${'#'.repeat(Math.min(Math.max(Number(c.level) || 1, 1), 6))} ${source}`;
    const cell: NormCell = {
      type,
      source,
      execCount: null,
      outputs: [],
      attachments: normalizeAttachments(c.attachments),
    };
    if (type === 'code') {
      // v4: execution_count；v3: prompt_number（且源字段是 input）
      cell.execCount = typeof c.execution_count === 'number'
        ? c.execution_count
        : typeof c.prompt_number === 'number'
          ? c.prompt_number
          : null;
      if (nbformat === 3 && typeof c.input !== 'undefined') cell.source = joinSource(c.input);
      const outputs = Array.isArray(c.outputs) ? c.outputs : [];
      cell.outputs = outputs.flatMap((o: Record<string, any>) =>
        nbformat === 3 ? normV3Output(o, widgets) : normV4Output(o, widgets),
      );
    }
    return cell;
  });

  return {
    nbformat,
    cells,
    language: detectLanguage(meta),
    kernelName: String(meta?.kernelspec?.display_name ?? meta?.kernelspec?.name ?? ''),
    widgetCount: widgets.count,
  };
}
