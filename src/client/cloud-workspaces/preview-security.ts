/**
 * HTML 预览的安全地板（蓝图 §5.2，2-3）：工作台对服务端声明的 sandbox
 * token 与 CSP 只收窄、永不放宽。服务端声明的策略是收窄建议，不是安全
 * 边界；不透明 origin（剥除 allow-same-origin）与 CSP 地板（断网络、断
 * 对象/表单/基准导航、资源白名单限内联与 data:）由工作台强制。
 */

/** 工作台允许透传的 sandbox token 词表；输出顺序按此冻结。 */
export const PREVIEW_SANDBOX_TOKENS = ['allow-scripts', 'allow-forms'] as const

/**
 * 按 sandbox 词表收窄服务端声明的 token。
 * @param declared - 服务端声明的 sandbox token。
 * @returns 实际应用的 sandbox 属性值：词表内声明按词表顺序排列，词表外
 * （含 allow-same-origin、allow-top-navigation、allow-popups）一律丢弃；
 * 声明为空时应用为空，不发明 token。
 */
export function isolatedPreviewSandbox(declared: readonly string[]): string {
  const tokens = new Set(declared)
  return PREVIEW_SANDBOX_TOKENS.filter(token => tokens.has(token)).join(' ')
}

/**
 * 预览文档的 CSP 地板：静态 HTML 预览只放行内联脚本/样式与 data: 资源。
 * connect-src 'none' 断开 fetch/XHR/beacon（token 外带通道）；object/frame/
 * form-action/base-uri 'none' 断开对象嵌入与导航式外带；白名单不含通配符
 * 与 http(s):/file:（网络与本地文件）。安全不变量固定，不是部署可调项。
 */
export const PREVIEW_CSP_FLOOR = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  'img-src data:',
  'font-src data:',
  'media-src data:',
  "connect-src 'none'",
  "object-src 'none'",
  "frame-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
].join('; ')

/** Escapes a value for use inside a double-quoted HTML attribute. */
function escapeHtmlAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}

function cspMeta(policy: string): string {
  return `<meta http-equiv="Content-Security-Policy" content="${escapeHtmlAttribute(policy)}">`
}

/**
 * 把安全地板与（可选的）服务端声明 CSP 安装为预览文档自身的 meta 策略。
 * 浏览器对多份策略取交集，声明策略因此只能收窄；地板 meta 安装在 `head`
 * 首位——meta 策略只有位于 `head` 前部才被采纳。
 * @param content - 服务端返回的 HTML 文档或片段。
 * @param declaredCsp - 服务端声明的策略；空串表示未声明（地板仍然安装）。
 * @returns 装入 iframe `srcdoc` 的文档。
 */
export function applyPreviewSecurity(content: string, declaredCsp: string): string {
  const metas = declaredCsp === '' ? cspMeta(PREVIEW_CSP_FLOOR) : `${cspMeta(PREVIEW_CSP_FLOOR)}${cspMeta(declaredCsp)}`
  const headOpen = content.indexOf('<head')
  if (headOpen !== -1) {
    const headClose = content.indexOf('>', headOpen)
    if (headClose !== -1) return `${content.slice(0, headClose + 1)}${metas}${content.slice(headClose + 1)}`
  }
  const htmlOpen = content.indexOf('<html')
  if (htmlOpen !== -1) {
    const htmlClose = content.indexOf('>', htmlOpen)
    if (htmlClose !== -1) return `${content.slice(0, htmlClose + 1)}<head>${metas}</head>${content.slice(htmlClose + 1)}`
  }
  return `<!DOCTYPE html><html><head>${metas}</head><body>${content}</body></html>`
}
