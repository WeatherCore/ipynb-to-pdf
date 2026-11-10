/**
 * katex.ts — 数学公式支持
 *
 * Jupyter 的 markdown 用 $...$ / $$...$$ 包裹公式，nbconvert 会先把这些
 * 替换成 MathJax 元素。这里在 markdown-it 渲染之前扫描原始文本，把公式抽成
 * 占位符，渲染后再用 KaTeX 还原，避免公式里的下划线/星号被 markdown 规则吃掉。
 *
 * extract 分三步（关键：还原保护段发生在数学抽取之后）：
 *   1. mask：围栏代码块 / 行内代码 / HTML 注释 换成 \x00K<idx>\x00 占位
 *   2. 抽数：在屏蔽文本上扫描 $$…$$ 与 $…$（被保护区域内即使有 $ 也不会被抽）
 *   3. unmask：把保护段原样放回——此时公式占位符已就位，围栏原封不动交给 markdown-it
 * 旧实现在此处把 mask/unmask 合并在同一次 replace 链里（恒等函数），保护从未生效。
 */

import katex from 'katex';

/** 公式占位符：xmathrulez<idx>xmathrulez —— 不含 $、不含 markdown 元字符 */
const PLACEHOLDER_PREFIX = 'xmathrulez';
const PLACEHOLDER_RE = new RegExp(`${PLACEHOLDER_PREFIX}(\\d+)${PLACEHOLDER_PREFIX}`, 'g');

interface MathToken {
  display: boolean;
  source: string;
}

export interface MathExtractor {
  /** 扫描 markdown 源码，公式替换为占位符后返回新文本（保护段原样放回） */
  extract: (src: string) => string;
  /** 把占位符还原成 KaTeX HTML（对最终 HTML 字符串操作） */
  restore: (html: string) => string;
}

/** 屏蔽待保护段：返回屏蔽文本与还原函数（必须在数学抽取之后调用还原） */
function maskProtected(src: string): { masked: string; unmask: (t: string) => string } {
  const kept: string[] = [];
  const protect = (s: string) => {
    kept.push(s);
    return `\x00K${kept.length - 1}\x00`;
  };
  const masked = src
    // 围栏代码块（``` 或 ~~~，可缩进；闭合围栏允许更长/异种标记）
    .replace(/(^|\n)([ \t]*)(`{3,}|~{3,})[\s\S]*?\n[ \t]*\2(?:\3|`{3,}|~{3,})[ \t]*(?=\n|$)/g,
      (m) => protect(m))
    // 行内代码（成对反引号）
    .replace(/(`+)([\s\S]*?)\1/g, (m) => protect(m))
    // HTML 注释（CELL_BREAK 等自有标记）
    .replace(/<!--[\s\S]*?-->/g, (m) => protect(m));
  const unmask = (t: string): string =>
    t.replace(/\x00K(\d+)\x00/g, (_, i) => kept[Number(i)] ?? '');
  return { masked, unmask };
}

export function createMathExtractor(): MathExtractor {
  const tokens: MathToken[] = [];

  const extract = (src: string): string => {
    const { masked, unmask } = maskProtected(src);
    // $$...$$（display，可跨行）优先，再 $...$（inline，不跨行）
    let out = masked.replace(/\$\$([\s\S]+?)\$\$/g, (_, tex) => {
      const idx = tokens.push({ display: true, source: tex.trim() }) - 1;
      return `${PLACEHOLDER_PREFIX}${idx}${PLACEHOLDER_PREFIX}`;
    });
    out = out.replace(/(?<!\\)\$(?!\s)((?:\\.|[^$\n\\])+?)(?<!\\)\$(?!\d)/g, (_, tex) => {
      const idx = tokens.push({ display: false, source: tex.trim() }) - 1;
      return `${PLACEHOLDER_PREFIX}${idx}${PLACEHOLDER_PREFIX}`;
    });
    // 数学抽取完成后再还原保护段：公式占位符已就位，围栏/行内代码原样返回
    return unmask(out);
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
