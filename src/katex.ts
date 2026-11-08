/**
 * katex.ts — 数学公式支持
 *
 * Jupyter 的 markdown（marked-it 时代）用 $...$ / $$...$$ 包裹公式，
 * nbconvert 会先把这些替换成 MathJax 元素。这里在 markdown-it 渲染
 * 之前扫描原始文本，把公式抽成占位符，渲染后再用 KaTeX 还原，
 * 避免公式里的下划线/星号被 markdown 规则吃掉。
 */

import katex from 'katex';

/** math-rule:vN:<base64(源码)> —— 不可被 markdown 改写的占位符 */
const PLACEHOLDER_PREFIX = 'xmathrulez';
const PLACEHOLDER_RE = new RegExp(`${PLACEHOLDER_PREFIX}(\\d+)${PLACEHOLDER_PREFIX}`, 'g');

interface MathToken {
  display: boolean;
  source: string;
}

export interface MathExtractor {
  /** 扫描 markdown 源码，公式替换为占位符后返回新文本 */
  extract: (src: string) => string;
  /** 把占位符还原成 KaTeX HTML（对最终 HTML 字符串操作） */
  restore: (html: string) => string;
}

/** 提取时跳过这些区域：围栏代码块、行内代码、HTML 注释（含 CELL_BREAK） */
function maskProtected(src: string): string {
  const kept: string[] = [];
  const protect = (s: string) => {
    kept.push(s);
    return `\x00K${kept.length - 1}\x00`;
  };
  return src
    // 围栏代码块（``` 或 ~~~）
    .replace(/(^|\n)([ \t]*)(`{3,}|~{3,})[\s\S]*?\n[ \t]*\2(?:\3|`{3,}|~{3,})[ \t]*(?=\n|$)/g,
      (m) => protect(m))
    // 行内代码
    .replace(/(`+)([\s\S]*?)\1/g, (m) => protect(m))
    // HTML 注释（CELL_BREAK 等自有标记）
    .replace(/<!--[\s\S]*?-->/g, (m) => protect(m))
    .replace(/(\x00K\d+\x00)/g, (m) => m) // no-op，保持结构清晰
    // 还原保护段
    .replace(/\x00K(\d+)\x00/g, (_, i) => kept[Number(i)]);
}

export function createMathExtractor(): MathExtractor {
  const tokens: MathToken[] = [];

  const extract = (src: string): string => {
    const safe = maskProtected(src);
    // $$...$$（display，可跨行）优先，再 $...$（inline，不跨段）
    let out = safe.replace(/\$\$([\s\S]+?)\$\$/g, (_, tex) => {
      const idx = tokens.push({ display: true, source: tex.trim() }) - 1;
      return `${PLACEHOLDER_PREFIX}${idx}${PLACEHOLDER_PREFIX}`;
    });
    out = out.replace(/(?<!\\)\$(?!\s)((?:\\.|[^$\n\\])+?)(?<!\\)\$(?!\d)/g, (_, tex) => {
      const idx = tokens.push({ display: false, source: tex.trim() }) - 1;
      return `${PLACEHOLDER_PREFIX}${idx}${PLACEHOLDER_PREFIX}`;
    });
    return out;
  };

  const restore = (html: string): string => {
    return html.replace(PLACEHOLDER_RE, (_, idx) => {
      const t = tokens[Number(idx)];
      if (!t) return '';
      try {
        return katex.renderToString(t.source, {
          displayMode: t.display,
          throwOnError: false,
          strict: false,
          output: 'html',
        });
      } catch {
        return `<code class="math-error">${escapeHtml(t.source)}</code>`;
      }
    });
  };

  return { extract, restore };
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c] as string));
}

/** $n$ 后紧跟数字的误判规避 + 货币金额（如 $100）不做公式 */
export function looksLikeCurrency(before: string, tex: string): boolean {
  return /\d\s*$/.test(before) && /^\d/.test(tex);
}
