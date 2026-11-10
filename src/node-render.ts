/**
 * node-render.ts — 验收专用入口：在 Node 里调用浏览器渲染逻辑
 * （DOMPurify 需要 DOM，这里用 jsdom 顶替；仅测试用，不进构建产物。
 *  tsconfig include 只收 src，本文件会被 tsc 检查但 jsdom 是 devDependency，
 *  构建产物（vite build 入口是 index.html → main.ts）不会引用到它。）
 */

// jsdom 31 未内置类型声明，装 @types/jsdom（见 devDependencies）
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!DOCTYPE html><body></body>');
// DOMPurify 在 import 时探测 window，必须先于 render 模块加载
(globalThis as any).window = dom.window;
(globalThis as any).document = dom.window.document;

const { parseNotebook } = await import('./notebook');
const { renderNotebook, buildPrintDocument } = await import('./render');

export { parseNotebook, renderNotebook, buildPrintDocument };
