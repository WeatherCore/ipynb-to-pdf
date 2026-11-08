/**
 * Worker 入口：静态资源 + POST /api/pdf
 *
 * /api/pdf 用 Browser Rendering 的 quickAction("pdf") 把前端送来的
 * 完整 HTML 渲染成 PDF（US Letter、2cm 边距、页脚页码），流式返回。
 * 页面本身由 ASSETS 服务（vite build 产物），无需额外路由。
 */

interface Env {
  BROWSER: BrowserRun;
  ASSETS: Fetcher;
}

/** 快速操作参数见 CF 文档 /browser-run/quick-actions/pdf-endpoint */
const PDF_OPTIONS = {
  pdfOptions: {
    format: 'letter' as const,
    printBackground: true,
    preferCSSPageSize: true,
    displayHeaderFooter: true,
    footerTemplate:
      `<div style="width:100%;font-size:9px;color:#888;text-align:center;` +
      `font-family:-apple-system,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif;">` +
      `第 <span class="pageNumber"></span> 页 / 共 <span class="totalPages"></span> 页</div>`,
    headerTemplate: '<div></div>',
    margin: { top: '2cm', bottom: '2cm', left: '2cm', right: '2cm' },
    timeout: 30000,
  },
};

const jsonHeaders = { 'Content-Type': 'application/json; charset=utf-8' };

function jsonError(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: message }), { status, headers: jsonHeaders });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/api/pdf') {
      if (request.method !== 'POST') {
        return jsonError(405, 'Method Not Allowed: POST only');
      }
      let body: { html?: string };
      try {
        body = await request.json();
      } catch {
        return jsonError(400, '请求体不是合法 JSON');
      }
      const html = body.html;
      if (typeof html !== 'string' || html.length < 20) {
        return jsonError(400, '缺少 html 字段或内容过短');
      }
      // 上限保护：免费档浏览器时长有限，拒绝异常巨大负载（约 25MB 文本）
      if (html.length > 25_000_000) {
        return jsonError(413, 'HTML 过大，请拆分 notebook 后重试');
      }

      try {
        const pdf = await env.BROWSER.quickAction('pdf', { html, ...PDF_OPTIONS });
        return new Response(pdf.body, {
          headers: {
            'Content-Type': 'application/pdf',
            'Content-Disposition': 'attachment; filename="notebook.pdf"',
          },
        });
      } catch (e) {
        return jsonError(502, `浏览器渲染失败：${e instanceof Error ? e.message : String(e)}`);
      }
    }

    // 其余路径交给静态资源（index.html、JS、CSS…）
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
