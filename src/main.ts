/**
 * main.ts — 页面逻辑（v3）：本地服务 → 云端 Worker 双引擎路由，无打印对话框。
 * PDF 均带侧边栏书签大纲（outline，h1-h3 生成）+ 页脚页码。
 */

import './style.css';
import '@phosphor-icons/web/regular/style.css';
import 'katex/dist/katex.min.css';   // KaTeX 公式排版必需，缺了公式会碎裂（预览与导出共用渲染产物）
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
let printing = false;       // 转换防重入
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
      `${stats.cells} 个单元格（${stats.markdown} markdown，${stats.code} 代码），` +
      `${stats.images} 张图片，约 ${estimatePages(html)} 页`;
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

/* ---------------- 转换路由：本地服务 → 云端 Worker，无打印对话框 ---------------- */

/** 本地导出服务是否可达（带 1.2s 超时探测，60s TTL 缓存） */
const LOCAL_PROBE_TTL_MS = 60_000;
let localProbe: Promise<boolean> | null = null;
let localProbeAt = 0;
function probeLocal(): Promise<boolean> {
  const now = Date.now();
  if (!localProbe || now - localProbeAt > LOCAL_PROBE_TTL_MS) {
    localProbeAt = now;
    localProbe = (async () => {
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 1200);
        const r = await fetch('http://127.0.0.1:8787/api/local-pdf', {
          method: 'OPTIONS',
          signal: ctrl.signal,
        });
        clearTimeout(t);
        return r.ok;
      } catch { return false; }
    })();
  }
  return localProbe;
}

async function convertToPdf(): Promise<void> {
  if (!loaded || printing) return;
  convertBtn.disabled = true;
  printing = true;
  const filename = loaded.name.replace(/\.ipynb$/i, '');
  const doc = buildPrintDocument(loaded.bodyHtml, filename);
  try {
    // ---- 路径 1：本地导出服务（无头 Chromium，带书签 + 页码页脚） ----
    if (await probeLocal()) {
      setStatus('info', '正在生成本地 PDF…');
      try {
        const resp = await fetch('http://127.0.0.1:8787/api/local-pdf', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ html: doc }),
        });
        if (!resp.ok) throw new Error(`本地服务返回 ${resp.status}`);
        const blob = await resp.blob();
        if (blob.type !== 'application/pdf' || blob.size < 100) throw new Error('返回内容不是有效 PDF');
        downloadBlob(blob, filename);
        setStatus('success', '<i class="ph ph-check-circle" aria-hidden="true"></i> PDF 已生成（本地引擎，含侧边栏书签），开始下载。');
        convertBtn.disabled = false;
        printing = false;
        return;
      } catch (localErr) {
        // 探测通过但转换失败（服务中途崩溃/渲染超时）：回退云端而不是直接报死
        console.warn('[ipynb-to-pdf] 本地引擎失败，回退云端：', localErr);
      }
    }

    // ---- 路径 2：云端 Worker（Browser Rendering，含书签 + 页码页脚） ----
    setStatus('info', `正在生成 PDF…${renderStages(0)}`);
    setStatus('info', `正在生成 PDF…${renderStages(1)}`);
    const resp = await fetch('/api/pdf', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ html: doc, filename }),
    });
    if (!resp.ok) throw new Error(`服务端返回 ${resp.status}`);
    setStatus('info', `正在生成 PDF…${renderStages(2)}`);
    const blob = await resp.blob();
    if (blob.type !== 'application/pdf' || blob.size < 100) throw new Error('返回内容不是有效 PDF');
    downloadBlob(blob, filename);
    setStatus('success', '<i class="ph ph-check-circle" aria-hidden="true"></i> PDF 已生成（云端，含侧边栏书签），开始下载。');
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    // 两条引擎路径都不可用。本地开发给出可操作的解决方法；部署环境只展示友好提示，
    // 不暴露 npm 命令等内部细节，仅保留一行错误详情便于用户反馈给管理员排查。
    const isLocalDev = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
    if (isLocalDev) {
      setStatus('error',
        'PDF 引擎不可用（本地服务未启动，且云端不可达）。<br>' +
        '解决方法：<b>npm run pdf-server</b> 启动本地导出服务后重试；' +
        '或将本项目部署到 Cloudflare（<b>npm run deploy</b>）。<br>' +
        `<span style="font-size:.85em">错误详情：${detail}</span>`);
    } else {
      setStatus('error',
        'PDF 生成暂时失败，请稍后重试。<br>' +
        '若多次重试仍失败，请将下面的信息反馈给管理员：<br>' +
        `<span style="font-size:.85em">错误详情：${detail}</span>`);
    }
  }
  convertBtn.disabled = false;
  printing = false;
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename + '.pdf';
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
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
