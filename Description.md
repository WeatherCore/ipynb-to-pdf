# Description

## 中文版（≤350 字符）

把 Jupyter Notebook（.ipynb）转成 PDF，专治中文乱码。核心机制：①渲染全在浏览器完成（nbformat v3/v4 归一化 + markdown-it + KaTeX + highlight.js），笔记本文件不出本机，中文字体天然正确；②允许 notebook 内嵌 HTML 原样生效，对齐 Jupyter 原味（In[n] 提示符、经典配色）；③OSS 外链/attachment/base64 图全部嵌入；④CELL_BREAK 注释自动转分页符；⑤Cloudflare Worker + Browser Run 一键云端导出（US Letter + 页码），额度尽自动回退浏览器打印。

## English

**ipynb-to-pdf** converts Jupyter notebooks (.ipynb) to PDF with first-class CJK support — no more tofu boxes (□□□).

What makes it work:

1. **Everything renders in your browser** (nbformat v3/v4 normalization → markdown-it → KaTeX → highlight.js). The notebook file never leaves your machine, and Chinese text uses your local fonts, so it can never turn into garbled glyphs.
2. **Jupyter-faithful output**: inline HTML in markdown cells (`<font>`, `<center>`, `<style>`) passes through untouched, code cells get `In [n]:` prompts with the classic CodeMirror color scheme, and stream outputs are ANSI-stripped plain text — matching nbconvert behavior.
3. **Every image makes it into the PDF**: remote OSS/image-host URLs, `attachment:` embedded images, and base64 output figures (matplotlib) are all loaded and embedded.
4. **`<!-- CELL_BREAK -->` comments become real page breaks** — preserving page-intent markers left in courseware notebooks.
5. **One-click cloud export via a single Cloudflare Worker** (static site + `/api/pdf` using Browser Run quick actions, US Letter with page-number footer). When the free browser-time quota runs out or the backend is absent, it automatically falls back to the browser's native print-to-PDF, so the tool never dead-ends.

Target users: students and engineers studying from Chinese Jupyter courseware who need clean, shareable PDFs without installing Jupyter, nbconvert, or LaTeX.

Tech stack: TypeScript + Vite (no framework), markdown-it, KaTeX, highlight.js, DOMPurify; Cloudflare Workers + Browser Run + Workers Assets.
