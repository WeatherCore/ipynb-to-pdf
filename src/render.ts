/**
 * render.ts — 渲染核心：把 NotebookDoc 变成一段自包含、可打印的 HTML
 *
 * 设计原则：
 * 1. 与 Jupyter/nbconvert 原味对齐：markdown 直通 HTML、代码带 In [n] 标签、
 *    输出区独立列、经典 CodeMirror 配色；
 * 2. 一切动态内容在生成后立即 sanitize（DOMPurify），保证字符串拼接安全；
 * 3. 打印友好：CELL_BREAK → page-break，代码块/表格/图片防劈开。
 */

import DOMPurify from 'dompurify';
import hljs from 'highlight.js/lib/common';
import { NotebookDoc, NormCell, stripAnsi } from './notebook';
import { createMathExtractor } from './katex';

/** CELL_BREAK 标记：老师做课件时留下的分页意图 */
const CELL_BREAK_RE = /<!--\s*CELL_BREAK\s*-->/g;

/** markdown-it：html:true 让 <font>/<div>/<style>/&emsp; 原样通过（Jupyter 行为） */
import MarkdownIt from 'markdown-it';
const md = new MarkdownIt({ html: true, linkify: true, breaks: false });
const math = createMathExtractor();

/** 链接默认在新窗口打开（预览体验），打印时无害 */
const defaultLinkOpen = md.renderer.rules.link_open ||
  ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  tokens[idx].attrSet('target', '_blank');
  tokens[idx].attrSet('rel', 'noopener');
  return defaultLinkOpen(tokens, idx, options, env, self);
};

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c] as string));
}

/** sanitize 动态 HTML（输出区/内联 HTML/公式产物），不允许脚本 */
function sanitize(html: string): string {
  return DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true, svg: true, svgFilters: true },
    ADD_TAGS: ['style'],
    ADD_ATTR: ['target', 'align', 'face', 'size', 'color', 'bgcolor', 'background', 'valign'],
    // Jupyter 输出里常见 iframe（如 YouTube 嵌入）在打印场景没有意义，直接去掉
    FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'form'],
    FORBID_ATTR: ['srcset', 'onerror', 'onload'],
  });
}

/** markdown 单元 → HTML。公式先抽取，HTML 直通交给 markdown-it，附件图替换为 data URI */
function renderMarkdown(src: string, attachments?: Map<string, string>): string {
  const extracted = math.extract(src);
  const rendered = md.render(extracted);
  let html = math.restore(rendered);
  if (attachments && attachments.size > 0) {
    // nbformat attachments：![alt](attachment:名.png) → data URI
    html = html.replace(/src="attachment:([^"]+)"/g, (m, name: string) => {
      const uri = attachments.get(name);
      return uri ? `src="${uri}"` : m;
    });
  }
  return html;
}

/** 代码单元高亮。未知语言退回纯文本。 */
function highlightCode(code: string, lang: string): string {
  const langMap: Record<string, string> = {
    ipython: 'python', ipython3: 'python', py: 'python',
    sh: 'bash', shell: 'bash', zsh: 'bash', console: 'bash',
    yml: 'yaml', rb: 'ruby', golang: 'go',
  };
  const mapped = langMap[lang.toLowerCase()] ?? lang.toLowerCase();
  if (mapped && hljs.getLanguage(mapped)) {
    try {
      return hljs.highlight(code, { language: mapped, ignoreIllegals: true }).value;
    } catch { /* fallthrough */ }
  }
  return esc(code);
}

/** CELL_BREAK → 分页 div；同时去掉该注释避免原样显示 */
const PAGE_BREAK_DIV = '\n\n<div class="page-break"></div>\n\n';

/** markdown 源里的 CELL_BREAK 注释替换为分页 div（html:true 直通渲染） */
function injectPageBreaks(src: string): { html: string; breaks: number } {
  const matches = src.match(CELL_BREAK_RE);
  return { html: src.replace(CELL_BREAK_RE, PAGE_BREAK_DIV), breaks: matches ? matches.length : 0 };
}

export interface RenderResult {
  /** 完整 notebook HTML（不含外层 <html>，嵌入预览区与导出共用） */
  html: string;
  /** 统计信息（UI 展示 + 验收用） */
  stats: {
    cells: number;
    markdown: number;
    code: number;
    outputs: number;
    pageBreaks: number;
    images: number;
    widgets: number;
    externalImages: number;
    embeddedImages: number;
  };
}

export function renderNotebook(doc: NotebookDoc): RenderResult {
  const stats: RenderResult['stats'] = {
    cells: doc.cells.length, markdown: 0, code: 0, outputs: 0,
    pageBreaks: 0, images: 0, widgets: doc.widgetCount,
    externalImages: 0, embeddedImages: 0,
  };

  const chunks: string[] = [];

  for (const cell of doc.cells) {
    if (cell.type === 'markdown') {
      stats.markdown++;
      const injected = injectPageBreaks(cell.source);
      stats.pageBreaks += injected.breaks;
      const seg = renderMarkdown(injected.html, cell.attachments);
      // CELL_BREAK 在 cell 开头时渲染结果以分页 div 起头；纯空白且无分页的才跳过
      if (seg.replace(PAGE_BREAK_DIV, '').trim() === '' && injected.breaks === 0) continue;
      chunks.push(`<div class="cell cell-markdown">${seg}</div>`);
      continue;
    }

    if (cell.type === 'raw') {
      // nbconvert 默认行为：raw cell 原样作为 HTML 透传（可能含分页标记）
      const injected = injectPageBreaks(cell.source);
      stats.pageBreaks += injected.breaks;
      const seg = sanitize(injected.html);
      if (seg.replace(PAGE_BREAK_DIV, '').trim() === '' && injected.breaks === 0) continue;
      chunks.push(`<div class="cell cell-raw">${seg}</div>`);
      continue;
    }

    // ---- code cell ----
    stats.code++;
    const label = cell.execCount !== null ? `In [${cell.execCount}]:` : 'In [ ]:';
    const lang = doc.language;
    const codeHtml = highlightCode(cell.source.replace(CELL_BREAK_RE, ''), lang);

    let outHtml = '';
    for (const o of cell.outputs) {
      stats.outputs++;
      switch (o.kind) {
        case 'stream':
          outHtml += `<div class="output-stream"><pre>${esc(o.text ?? '')}</pre></div>`;
          break;
        case 'text':
          // execute_result 的 text/plain 包一层 Out[n]
          outHtml += `<div class="output-result"><pre>${esc(o.text ?? '')}</pre></div>`;
          break;
        case 'html':
          outHtml += `<div class="output-html">${sanitize(o.html ?? '')}</div>`;
          break;
        case 'latex':
          outHtml += `<div class="output-latex">${math.restore(math.extract(`$$${o.latex}$$`))}</div>`;
          break;
        case 'image': {
          stats.images++;
          if (o.data && o.data.length > 0 && !o.data.startsWith('http')) stats.embeddedImages++;
          outHtml += `<div class="output-image"><img src="data:${o.mime};base64,${o.data ?? ''}" alt="notebook output" /></div>`;
          break;
        }
        case 'error':
          outHtml += `<div class="output-error"><span class="err-name">${esc(o.ename ?? '')}</span>` +
            `<span class="err-value">${esc(o.evalue ?? '')}</span><pre>${esc(o.text ?? '')}</pre></div>`;
          break;
      }
    }

    chunks.push(
      `<div class="cell cell-code">` +
      `<div class="code-input"><div class="prompt">${esc(label)}</div>` +
      `<pre class="code-holder hljs"><code>${codeHtml}</code></pre></div>` +
      (outHtml ? `<div class="code-output">${outHtml}</div>` : ``) +
      `</div>`,
    );
  }

  // 统计外链图数量（验收项 3）
  const joined = chunks.join('');
  stats.externalImages = (joined.match(/<img [^>]*src="https?:\/\//g) ?? []).length;
  stats.images += stats.externalImages;

  return { html: joined, stats };
}

/** 导出/云端发送用的完整文档：Jupyter 原味样式 + US Letter 打印参数 */
export function buildPrintDocument(bodyHtml: string, title: string): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<title>${esc(title)}</title>
<style>${PRINT_CSS}</style>
</head>
<body>
<article class="notebook-print">${bodyHtml}</article>
</body>
</html>`;
}

/** US Letter：8.5in × 11in，2cm 边距（@page 与云端 pdfOptions 保持一致） */
export const PAGE_OPTIONS = {
  format: 'letter' as const,
  marginCm: 2,
};

export const PRINT_CSS = `
@page { size: letter; margin: 2cm; }
* { box-sizing: border-box; }
html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
body {
  margin: 0; color: #222; font-size: 10.5pt; line-height: 1.75;
  font-family: -apple-system, "Segoe UI", "Helvetica Neue", "PingFang SC",
    "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", "Source Han Sans SC", sans-serif;
  word-wrap: break-word;
}
.notebook-print { padding: 0 4px; }

/* ---------- 原味单元格 ---------- */
.cell { margin: 0 0 10px; }
.cell-markdown > :first-child { margin-top: 0; }
.cell-markdown > :last-child { margin-bottom: 0; }
.cell-markdown h1, .cell-markdown h2, .cell-markdown h3,
.cell-markdown h4, .cell-markdown h5, .cell-markdown h6 {
  margin: 0.9em 0 0.45em; line-height: 1.35; font-weight: 700; break-after: avoid;
}
.cell-markdown h1 { font-size: 1.9em; border-bottom: 2px solid #e0e0e0; padding-bottom: .25em; }
.cell-markdown h2 { font-size: 1.5em; border-bottom: 1px solid #e8e8e8; padding-bottom: .2em; }
.cell-markdown h3 { font-size: 1.22em; }
.cell-markdown p { margin: .5em 0; }
.cell-markdown ul, .cell-markdown ol { margin: .4em 0; padding-left: 2em; }
.cell-markdown li { margin: .18em 0; }
.cell-markdown blockquote {
  margin: .6em 0; padding: .1em 1em; color: #555; border-left: 4px solid #dfe2e5;
}
.cell-markdown hr { border: none; border-top: 1px solid #ddd; margin: 1em 0; }
.cell-markdown a { color: #106ba3; text-decoration: none; }
.cell-markdown code {
  font-family: "JetBrains Mono", Consolas, "Courier New", "PingFang SC", "Microsoft YaHei", monospace;
  font-size: .88em; background: #f5f5f5; border: 1px solid #e6e6e6;
  border-radius: 3px; padding: .08em .35em;
}

/* 表格：原味细线风 */
.cell-markdown table, .output-html table {
  border-collapse: collapse; margin: .6em 0; max-width: 100%;
  break-inside: avoid; font-size: .95em;
}
.cell-markdown th, .cell-markdown td, .output-html th, .output-html td {
  border: 1px solid #d8d8d8; padding: 4px 9px; text-align: left; vertical-align: top;
}
.cell-markdown th, .output-html th { background: #f4f4f4; font-weight: 700; }
.cell-markdown tr:nth-child(even) td, .output-html tr:nth-child(even) td { background: #fafafa; }

/* 图片：不劈开、不超宽 */
.cell-markdown img, .output-image img, .output-html img {
  max-width: 100%; height: auto; break-inside: avoid;
}

/* ---------- 代码单元：经典 Jupyter 双列 ---------- */
.cell-code { break-inside: auto; }
.code-input { display: flex; align-items: stretch; }
.prompt {
  flex: 0 0 auto; min-width: 64px; text-align: right; padding: 6px 10px 0 0;
  color: #d84315; font-family: Consolas, monospace; font-size: .85em; user-select: none;
}
.code-holder {
  flex: 1 1 auto; margin: 0; padding: 7px 10px; overflow-x: hidden;
  background: #f7f7f7; border: 1px solid #cfcfcf; border-left: 3px solid #ff7f0e;
  border-radius: 2px; font-family: "JetBrains Mono", Consolas, "Courier New", monospace;
  font-size: .88em; line-height: 1.55; white-space: pre-wrap; word-break: break-all;
}
.code-output { margin: 2px 0 4px 64px; }
.output-stream pre, .output-result pre {
  margin: 0; padding: 6px 10px; background: transparent;
  font-family: "JetBrains Mono", Consolas, monospace; font-size: .86em;
  line-height: 1.5; white-space: pre-wrap; word-break: break-all;
}
.output-result pre { color: #333; }
.output-html { padding: 2px 0; }
.output-latex { padding: 4px 8px; }
.output-image { padding: 4px 0; }
.output-error {
  border: 1px solid #f3b6b6; background: #fdf3f3; border-radius: 2px;
  padding: 6px 10px; margin: 2px 0 4px; font-size: .86em;
}
.err-name { color: #b71c1c; font-weight: 700; margin-right: 8px; }
.err-value { color: #b71c1c; }
.output-error pre { margin: 4px 0 0; white-space: pre-wrap; word-break: break-all; color: #7c3030; }

/* ---------- KaTeX ---------- */
.katex { font-size: 1.05em; }
.katex-display { margin: .6em 0; break-inside: avoid; }
.math-error { color: #b71c1c; background: #fdf3f3; }

/* ---------- highlight.js：经典 CodeMirror/Jupyter 配色 ---------- */
.hljs { color: #333; background: transparent; }
.hljs-comment, .hljs-quote { color: #998; font-style: italic; }
.hljs-keyword, .hljs-selector-tag, .hljs-subst { color: #333; font-weight: 700; }
.hljs-number, .hljs-literal, .hljs-variable, .hljs-template-variable,
.hljs-tag .hljs-attr { color: #008080; }
.hljs-string, .hljs-doctag { color: #d14; }
.hljs-title, .hljs-section, .hljs-title.class_, .hljs-title.function_ { color: #900; font-weight: 700; }
.hljs-type, .hljs-class .hljs-title { color: #458; font-weight: 700; }
.hljs-attr, .hljs-attribute, .hljs-name { color: #008080; }
.hljs-built_in, .hljs-builtin-name { color: #0086b3; }
.hljs-meta { color: #999; }
.hljs-deletion { color: #b71c1c; }
.hljs-addition { color: #22863a; }
.hljs-emphasis { font-style: italic; }
.hljs-strong { font-weight: 700; }

/* ---------- 分页 ---------- */
.page-break { break-before: page; page-break-before: always; height: 0; margin: 0; }
@media print {
  .page-break { break-before: page; }
  .cell-code .code-holder { break-inside: avoid; }
  .cell-markdown pre, .cell-markdown table, .cell-markdown img,
  .output-image, .output-html table { break-inside: avoid; }
  h1, h2, h3 { break-after: avoid; }
}
`;
