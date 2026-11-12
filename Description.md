# Description

## 中文版（≤350 字符）

把 Jupyter Notebook（.ipynb）转成 PDF，专治中文乱码。核心机制：①渲染全在浏览器完成（nbformat v3/v4 归一化 + markdown-it + KaTeX + highlight.js），笔记本文件不出本机，中文字体天然正确；②允许 notebook 内嵌 HTML 原样生效（经 DOMPurify 白名单净化），对齐 Jupyter 原味（In[n] 提示符、经典配色）；③OSS 外链/attachment/base64 图全部嵌入；④CELL_BREAK 标记会被识别并消费（v1.2 起不再强制换页，长文档自然续排）；⑤双引擎导出：本地 pdf-server（无头 Chromium）优先，云端 Cloudflare Worker + Browser Rendering 兜底，产出带书签大纲与页码。

## English

**ipynb-to-pdf** converts Jupyter notebooks (.ipynb) to PDF with first-class CJK support — no more tofu boxes (□□□).

What makes it work:

1. **Everything renders in your browser** (nbformat v3/v4 normalization → markdown-it → KaTeX → highlight.js). The notebook file never leaves your machine, and Chinese text uses your local fonts, so it can never turn into garbled glyphs.
2. **Jupyter-faithful output**: inline HTML in markdown cells (`<font>`, `<center>`, `<style>`) passes through a DOMPurify allow-list (classic tags kept, scripts stripped), code cells get `In [n]:` prompts with the classic CodeMirror color scheme, and stream outputs are ANSI-stripped plain text — matching nbconvert behavior.
3. **Every image makes it into the PDF**: remote OSS/image-host URLs, `attachment:` embedded images, and base64 output figures (matplotlib) are all loaded and embedded.
4. **`<!-- CELL_BREAK -->` markers are recognised and consumed** — as of v1.2 they no longer force a page break (that left big gaps at page bottoms); long documents flow naturally.
5. **Dual-engine export**: a local headless-Chromium service (`npm run pdf-server`) is preferred; a self-deployed Cloudflare Worker (Browser Rendering quick actions, US Letter with page-number footer and sidebar outline) is the fallback. Both engines produce bookmarked, page-numbered PDFs; if neither is reachable the UI says exactly how to fix it — no dead ends.

Target users: students and engineers studying from Chinese Jupyter courseware who need clean, shareable PDFs without installing Jupyter, nbconvert, or LaTeX.

Tech stack: TypeScript + Vite (no framework), markdown-it, KaTeX, highlight.js, DOMPurify; puppeteer-core for the local engine; Cloudflare Workers + Browser Rendering + Workers Assets for the cloud engine.
