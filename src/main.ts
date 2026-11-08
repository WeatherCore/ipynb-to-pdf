/**
 * main.ts — 页面逻辑（v2：全窗口拖放 + 骨架屏 + 示例 + 云端进度细化 + 移动端强化）
 *
 * 唯一转换按钮：先请求 /api/pdf（Worker + Browser Rendering），
 * 失败（无后端/额度尽/网络错误）时自动回退 window.print()，UI 不区分两条路。
 */

import './style.css';
import '@phosphor-icons/web/regular/style.css';
import 'katex/dist/katex.min.css';   // KaTeX 公式排版必需，缺了公式会碎裂
import { parseNotebook } from './notebook';
import { renderNotebook, buildPrintDocument, PRINT_CSS } from './render';

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el as T;
};

const dropZone = $('drop-zone');
const fileInput = $<HTMLInputElement>('file-input');
const loading = $('loading');
const loadingText = $('loading-text');
const skeleton = $('skeleton');
const previewBar = $('preview-bar');
const fileNameEl = $('file-name');
const fileStatsEl = $('file-stats');
const convertBtn = $<HTMLButtonElement>('convert-btn');
const exampleBtn = $<HTMLButtonElement>('example-btn');
const resetBtn = $<HTMLButtonElement>('reset-btn');
const convertStatus = $('convert-status');
const preview = $('preview');
const notebookEl = $<HTMLDivElement>('notebook');
const unsupported = $('unsupported');
const unsupportedText = $('unsupported-text');
const dropOverlay = $('window-drop-overlay');

interface LoadedDoc {
  name: string;
  bodyHtml: string;
  stats: ReturnType<typeof renderNotebook>['stats'];
}

let loaded: LoadedDoc | null = null;
let printing = false;       // print 回退防重入
let dragDepth = 0;          // 全窗口拖放：子元素进出计数

function show(el: HTMLElement, visible: boolean): void {
  el.hidden = !visible;
}

function setStatus(kind: 'info' | 'success' | 'error', html: string): void {
  convertStatus.className = `convert-status ${kind}`;
  convertStatus.innerHTML = html;
  show(convertStatus, true);
}

function clearStatus(): void {
  convertStatus.innerHTML = '';
  show(convertStatus, false);
}

/** 云端转换阶段提示：发送 HTML → 浏览器渲染 → 生成 PDF */
function renderStages(active: number): string {
  const stages = ['发送 HTML', '浏览器渲染', '生成 PDF'];
  return `<div class="stages">` + stages.map((s, i) => {
    const cls = i < active ? 'done' : i === active ? 'active' : '';
    const icon = i < active ? 'ph-check-circle' : i === active ? 'ph-circle-notch' : 'ph-circle';
    return `<span class="stage ${cls}"><i class="ph ${icon}" aria-hidden="true"></i>${s}</span>`;
  }).join('') + `</div>`;
}

/** 把渲染好的 HTML（含打印 CSS）注入预览区 */
function mountPreview(bodyHtml: string): void {
  // 打印样式只在预览容器内生效：scoped 注入，避免污染应用 UI
  let style = document.getElementById('preview-style') as HTMLStyleElement | null;
  if (!style) {
    style = document.createElement('style');
    style.id = 'preview-style';
    document.head.appendChild(style);
  }
  // 预览不需要 @page 分页效果，去掉 @page 行，其余样式原样预览
  style.textContent = PRINT_CSS.replace(/@page[^{]*\{[^}]*\}\s*/g, '');
  notebookEl.innerHTML = bodyHtml;
  show(preview, true);
}

function resetView(): void {
  clearStatus();
  show(unsupported, false);
  show(preview, false);
  show(previewBar, false);
  show(skeleton, false);
  show(loading, false);
}

async function loadFile(file: File): Promise<void> {
  if (!/\.ipynb$/i.test(file.name) && file.type !== 'application/json') {
    setStatus('error', '请选择 <b>.ipynb</b> 文件（Jupyter Notebook）。');
    return;
  }
  resetView();
  show(skeleton, true);          // 骨架屏先占位（形状对齐最终预览）
  loadingText.textContent = '正在渲染预览…';

  // 让骨架屏先画一帧再进入同步解析
  await new Promise((r) => setTimeout(r, 30));
  try {
    const text = await file.text();
    const doc = parseNotebook(text);
    const { html, stats } = renderNotebook(doc);
    loaded = { name: file.name, bodyHtml: html, stats };

    show(skeleton, false);
    mountPreview(html);
    fileNameEl.textContent = file.name;
    fileNameEl.title = file.name;
    fileStatsEl.textContent =
      `${stats.cells} 个单元格 · ${stats.markdown} markdown · ${stats.code} 代码 · ` +
      `${stats.images} 张图片 · 约 ${estimatePages(html)} 页`;
    show(previewBar, true);
    if (window.matchMedia('(max-width: 640px)').matches) {
      // 移动端：预览条出现后滚到视口顶部，让用户立刻看到文件名和转换按钮
      previewBar.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    if (doc.widgetCount > 0) {
      unsupportedText.innerHTML =
        `检测到 <b>${doc.widgetCount}</b> 个交互式 widget 输出。` +
        `widget 是动态控件，无法进入 PDF，已自动跳过；其余内容正常渲染。`;
      show(unsupported, true);
    }
  } catch (e) {
    loaded = null;
    show(skeleton, false);
    setStatus('error', `渲染失败：${e instanceof Error ? e.message : String(e)}`);
  }
}

/** 粗略页数估算（展示用，云端返回的真实 PDF 才是权威） */
function estimatePages(html: string): number {
  const textLen = html.replace(/<[^>]+>/g, '').length;
  const imgCount = (html.match(/<img /g) ?? []).length;
  return Math.max(1, Math.round(textLen / 4200 + imgCount * 0.45));
}

/* ---------------- 云端转换（阶段进度）+ 打印兜底 ---------------- */

async function convertToPdf(): Promise<void> {
  if (!loaded || printing) return;
  convertBtn.disabled = true;
  printing = true;
  try {
    setStatus('info', `正在生成 PDF…${renderStages(0)}`);
    const doc = buildPrintDocument(loaded.bodyHtml, loaded.name.replace(/\.ipynb$/i, ''));
    const filename = loaded.name.replace(/\.ipynb$/i, '');

    // 阶段 1 完成 → 阶段 2：发送 HTML
    setStatus('info', `正在生成 PDF…${renderStages(1)}`);
    const resp = await fetch('/api/pdf', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ html: doc, filename }),
    });
    if (!resp.ok) throw new Error(`服务端返回 ${resp.status}`);

    // 阶段 3：拿到 PDF 流
    setStatus('info', `正在生成 PDF…${renderStages(2)}`);
    const blob = await resp.blob();
    if (blob.type !== 'application/pdf' || blob.size < 100) {
      throw new Error('返回内容不是有效 PDF');
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename + '.pdf';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
    setStatus('success', '<i class="ph ph-check-circle" aria-hidden="true"></i> PDF 已生成并开始下载。');
  } catch (e) {
    // 回退：浏览器打印 → 另存为 PDF。本机字体，中文永远不乱码。
    setStatus('info',
      '云端导出不可用（可能是未部署后端或免费额度用完），已改用<b>浏览器打印</b>导出：' +
      '在打印对话框中选择「另存为 PDF」，纸张选 Letter、边距默认、勾选「背景图形」即可。');
    setTimeout(() => {
      window.print();
      printing = false;
    }, 400);
    return;
  }
  convertBtn.disabled = false;
  printing = false;
}

/* ---------------- 内置示例 notebook ---------------- */

/** 一个覆盖核心功能的小示例：markdown / 代码 / 输出 / 表格 / 公式 */
const EXAMPLE_NB = JSON.stringify({
  cells: [
    { cell_type: 'markdown', metadata: {}, source: ['# 示例笔记本\n', '这是一个**内置示例**，用来体验转换效果。\n', '\n', '| 功能 | 状态 |\n', '| :--- | :--- |\n', '| Markdown 渲染 | ✓ |\n', '| 代码高亮 | ✓ |\n', '| 数学公式 | ✓ |\n'] },
    { cell_type: 'markdown', metadata: {}, source: ['## 公式示例\n', '\n', '质能方程 $E = mc^2$，以及高斯积分：\n', '$$\n', '\\int_{-\\infty}^{\\infty} e^{-x^2}\\,dx = \\sqrt{\\pi}\n', '$$'] },
    { cell_type: 'code', execution_count: 1, metadata: {}, outputs: [{ name: 'stdout', output_type: 'stream', text: ['Hello, 世界!\n', '中文输出正常 ✓\n'] }], source: ['# 第一个代码单元\n', 'print("Hello, 世界!")\n', 'print("中文输出正常 ✓")'] },
    { cell_type: 'code', execution_count: 2, metadata: {}, outputs: [{ data: { 'text/plain': ['[2, 4, 6, 8, 10]'] }, execution_count: 2, metadata: {}, output_type: 'execute_result' }], source: ['[n * 2 for n in range(1, 6)]'] },
    { cell_type: 'markdown', metadata: {}, source: ['<!-- CELL_BREAK -->\n', '## 分页之后\n', '\n', '上面有 `CELL_BREAK` 标记，所以这一节从新的一页开始。'] },
  ],
  metadata: { kernelspec: { display_name: 'Python 3', language: 'python', name: 'python3' }, language_info: { name: 'python', version: '3.12.0' } },
  nbformat: 4,
  nbformat_minor: 5,
});

async function loadExample(): Promise<void> {
  const file = new File([EXAMPLE_NB], '示例.ipynb', { type: 'application/json' });
  await loadFile(file);
}

/* ---------------- 事件绑定 ---------------- */

// 拖放区（点击 / 键盘）
dropZone.addEventListener('click', () => fileInput.click());
dropZone.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); }
});
fileInput.addEventListener('change', () => {
  const f = fileInput.files?.[0];
  if (f) loadFile(f);
  fileInput.value = '';
});

// 拖放区自身的高亮
dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('dragover'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
dropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropZone.classList.remove('dragover');
});

// 全窗口拖放：任何位置松手都加载（dragenter/dragleave 计数防子元素抖动）
window.addEventListener('dragenter', (e) => {
  if (![...e.dataTransfer?.types ?? []].includes('Files')) return;
  e.preventDefault();
  dragDepth++;
  dropOverlay.hidden = false;
  dropZone.classList.add('dragover');
});
window.addEventListener('dragleave', (e) => {
  if (dragDepth > 0) dragDepth--;
  if (dragDepth === 0) {
    dropOverlay.hidden = true;
    dropZone.classList.remove('dragover');
  }
});
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  dropOverlay.hidden = true;
  dropZone.classList.remove('dragover');
  const f = e.dataTransfer?.files?.[0];
  if (f) loadFile(f);
});

// 粘贴
window.addEventListener('paste', (e) => {
  const f = Array.from(e.clipboardData?.files ?? [])[0];
  if (f) loadFile(f);
});

// 按钮
convertBtn.addEventListener('click', convertToPdf);
exampleBtn.addEventListener('click', loadExample);
resetBtn.addEventListener('click', () => {
  loaded = null;
  resetView();
  fileInput.click();
});

// URL 参数 ?example=1：自动加载内置示例（演示/自检用）
if (new URLSearchParams(location.search).get('example') === '1') {
  void loadExample();
}
