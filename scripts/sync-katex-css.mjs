/**
 * sync-katex-css.mjs — 把 node_modules 里 katex 的打印样式生成为 TS 常量文件
 *
 * 为什么不用 Vite 的 `?raw` 导入：导出链路有三条消费方（Vite 前端、tsx 起的
 * node-render 验收、esbuild 打包的 .acceptance/render.mjs），`?raw` 是 Vite 专属
 * 约定，后两条不认识。生成式常量对三条链路都成立。
 *
 * katex 版本升级后重跑：node scripts/sync-katex-css.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const cssPath = require.resolve('katex/dist/katex.min.css');
const css = readFileSync(cssPath, 'utf8');

const banner =
  `/**\n` +
  ` * katex-print-css.ts — 自动生成文件（勿手改）。\n` +
  ` * 来源：${cssPath}\n` +
  ` * 再生成：node scripts/sync-katex-css.mjs\n` +
  ` * 用途：buildPrintDocument 把它内嵌进导出 HTML，无头渲染引擎\n` +
  ` * （本地 pdf-server / 云端 Worker）不经过 Vite，缺它公式必碎裂。\n` +
  ` */\n`;

// JSON.stringify 转义保证反引号 / ${ / 反斜杠都不会破坏模板字面量
const out = `${banner}export default ${JSON.stringify(css)};\n`;
writeFileSync(new URL('../src/katex-print-css.ts', import.meta.url), out, 'utf8');
console.log(`[sync-katex-css] written src/katex-print-css.ts (${css.length} chars)`);
