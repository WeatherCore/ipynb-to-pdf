/**
 * node-render.ts — 验收专用入口：在 Node 里调用浏览器渲染逻辑
 * （DOMPurify 需要 DOM，这里用 jsdom 顶替；仅测试用，不进构建产物）
 */

// @ts-expect-error jsdom 无内置类型（仅验收脚本使用，不进构建产物）
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!DOCTYPE html><body></body>');
// DOMPurify 在 import 时探测 window，必须先于 render 模块加载
(globalThis as any).window = dom.window;
(globalThis as any).document = dom.window.document;
(globalThis as any).DOMPurify = undefined;

const { parseNotebook } = await import('./notebook');
const { renderNotebook, buildPrintDocument } = await import('./render');

export { parseNotebook, renderNotebook, buildPrintDocument };
