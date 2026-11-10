/**
 * 本地导出服务 — 无头 Chromium（本机 Edge/Chrome）直接渲染 PDF：
 * 与浏览器 Ctrl+P 无关：无对话框、参数全代码控制、产出带
 * 侧边栏书签大纲（outline，由 h1/h2/h3 自动生成）+ 页脚页码的 PDF。
 *
 * 启动：npm run pdf-server（端口 8787，仅监听 127.0.0.1）
 * 仅本地开发/自用场景；部署到 Cloudflare 后由 Worker 的 Browser Rendering 路径接管。
 *
 * 请求校验三件套（防 DNS rebinding 与恶意网页静默调用）：
 * Origin 白名单 → Host 必须是本机 → Content-Type 必须是 JSON。
 * 注意：浏览器端「探测后启动 pdf-server」场景由前端 60s TTL 探测覆盖；
 * 但 pdf-server 的浏览器进程常驻内存，SIGINT 之外没有自动休眠。
 */

import puppeteer, { Browser } from 'puppeteer-core';
import { existsSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

const PORT = Number(process.env.PDF_SERVER_PORT ?? 8787);
/** 允许调用本服务的来源（vite 默认端口 + 本文件服务自身预览） */
const ALLOWED_ORIGINS = new Set([
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost:4173',
  'http://127.0.0.1:4173',
]);

/** 本机浏览器定位：优先 Edge，回退 Chrome */
const CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
];

let browser: Browser | null = null;

async function getBrowser(): Promise<Browser> {
  if (browser) return browser;
  const exe = CANDIDATES.find((p) => existsSync(p));
  if (!exe) throw new Error('未找到 Edge/Chrome，请确认已安装');
  browser = await puppeteer.launch({
    executablePath: exe,
    headless: true,
    args: ['--disable-gpu', '--no-first-run'],
  });
  return browser;
}

/** 与 render.ts PRINT_CSS 的 @page 一致：Letter、2cm 边距 */
const PDF_OPTS = {
  printBackground: true,
  preferCSSPageSize: true,
  displayHeaderFooter: true,
  headerTemplate: '<div></div>',
  footerTemplate:
    `<div style="width:100%;font-size:9px;color:#888;text-align:center;` +
    `font-family:-apple-system,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif;">` +
    `第 <span class="pageNumber"></span> 页 / 共 <span class="totalPages"></span> 页</div>`,
  margin: { top: '2cm', bottom: '2cm', left: '2cm', right: '2cm' },
  outline: true, // PDF 侧边栏书签大纲（Chromium 实验特性）
  timeout: 120_000,
} as const;

function cors(req: IncomingMessage, res: ServerResponse): boolean {
  const origin = req.headers.origin ?? '';
  // DNS rebinding / 恶意网页加固：仅接受本机来源与 Host，其余一律 403/404
  if (origin) {
    if (!ALLOWED_ORIGINS.has(origin)) {
      res.writeHead(403, { 'Content-Type': 'application/json' })
        .end(JSON.stringify({ error: 'origin not allowed' }));
      return false;
    }
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  }
  // 无 Origin 的请求（curl / 同源 POST）必须是同源 Host
  const host = (req.headers.host ?? '').split(':')[0];
  if (host !== '127.0.0.1' && host !== 'localhost') {
    res.writeHead(403, { 'Content-Type': 'application/json' })
      .end(JSON.stringify({ error: 'host not allowed' }));
    return false;
  }
  if (req.method === 'OPTIONS') {
    res.writeHead(204).end();
    return false;
  }
  if (req.method !== 'POST' || !req.url?.startsWith('/api/local-pdf')) {
    res.writeHead(404, { 'Content-Type': 'application/json' })
      .end(JSON.stringify({ error: 'POST /api/local-pdf only' }));
    return false;
  }
  if (!/^application\/json\b/i.test(String(req.headers['content-type'] ?? ''))) {
    res.writeHead(415, { 'Content-Type': 'application/json' })
      .end(JSON.stringify({ error: 'Content-Type must be application/json' }));
    return false;
  }
  return true;
}

const server = createServer(async (req, res) => {
  if (!cors(req, res)) return;

  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  let body: { html?: string };
  try {
    body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'bad json' }));
    return;
  }
  const html = body.html ?? '';
  if (html.length < 20 || html.length > 60_000_000) {
    res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'html size out of range' }));
    return;
  }

  try {
    const b = await getBrowser();
    const page = await b.newPage();
    await page.setContent(html, { waitUntil: 'load', timeout: 120_000 });
    // 显式等待网络空闲（新版 puppeteer 推荐用法，替代 networkidle0）
    await page.waitForNetworkIdle({ idleTime: 700, timeout: 60_000 }).catch(() => { /* 超时继续：长文档总有慢图 */ });
    // 等待所有图片完成（二次确认，OSS 慢图兜底）
    await page.evaluate(() => Promise.all(
      Array.from(document.images)
        .filter((img) => !img.complete)
        .map((img) => new Promise<void>((r) => { img.onload = () => r(); img.onerror = () => r(); })),
    ));
    const pdf = Buffer.from(await page.pdf({ ...PDF_OPTS }));
    await page.close();

    res.writeHead(200, {
      'Content-Type': 'application/pdf',
      'Content-Disposition': 'attachment; filename="notebook.pdf"',
      'X-Outline': 'true',
    });
    res.end(pdf);
  } catch (e) {
    res.writeHead(502, { 'Content-Type': 'application/json' })
      .end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
  }
});

// 只绑回环地址：本机自用，不对局域网开放
server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[pdf-server] 端口 ${PORT} 已被占用。`);
    console.error('  通常是上一次的服务还在跑。解决：');
    console.error(`  PowerShell:  Get-NetTCPConnection -LocalPort ${PORT} | Select -Expand OwningProcess | % { Stop-Process -Id $_ -Force }`);
    console.error(`  或换端口：   $env:PDF_SERVER_PORT=8788 后重新 npm run pdf-server`);
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[pdf-server] http://127.0.0.1:${PORT} (仅本机可用)`);
});

process.on('SIGINT', async () => {
  if (browser) await browser.close();
  process.exit(0);
});
