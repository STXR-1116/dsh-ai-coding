/* oxlint-disable typescript/no-base-to-string -- RequestInfo 字符串化是本捕获器的职责。 */
/**
 * AFC-01 / AFC-07 请求捕获器：包装全局 fetch，记录治理请求的方法、URL、请求体与响应证据
 * （x-fixture-only、request_id、HTTP 状态、响应 envelope），供全链路闭环测试断言
 * "后台请求体 + fixture 响应 + request_id"同时存在。
 *
 * 两个调用面共享同一个包装器：后台页面挂载后 `CloudProfilesPage` 还会打开
 * `/admin/events/stream` 的事件流（`TeamSkillApi.cloudStream` 走同一 fetcher）。
 * 事件流是不可读完的长连接，缓冲区必须把它的 body 原样交回调用方——由订阅者持有唯一
 * reader；只有一次性 JSON envelope 才在这里读完并留证。
 */

export interface CapturedRequest {
  readonly url: string
  readonly method: string
  readonly headers: Record<string, string>
  readonly body?: unknown
  readonly requestId: string
  readonly fixtureOnly: boolean
  /** HTTP 状态码；请求未发出时为 0。 */
  readonly status: number
  /** 解析后的 JSON envelope（非 JSON / 事件流为 undefined）。 */
  readonly responseBody?: unknown
  /** 事件流等长连接：body 未被捕获器读取，调用方持有 reader。 */
  readonly streaming: boolean
}

export function captureRequests(
  captured: CapturedRequest[],
  adminToken: string,
): typeof globalThis.fetch {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const response = await globalThis.fetch(input, init)
    const headers: Record<string, string> = {}
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = value
    })
    headers.authorization = `Bearer ${adminToken}`
    let body: unknown
    if (typeof init?.body === 'string') {
      try {
        body = JSON.parse(init.body)
      } catch {
        body = init.body
      }
    }
    const contentType = response.headers.get('content-type') ?? ''
    const fixtureOnly = response.headers.get('x-fixture-only') === 'true'
    // 事件流：body 交给订阅者独享的 reader，捕获器只留下请求侧证据。
    if (contentType.startsWith('text/event-stream')) {
      captured.push({
        url: String(input),
        method: init?.method ?? 'GET',
        headers,
        body,
        requestId: '',
        fixtureOnly,
        status: response.status,
        streaming: true,
      })
      return response
    }
    let requestId = ''
    let responseBody: unknown
    // Response body 只能读一次：读出文本后重建两个响应（一个供调用方，一个留证）。
    const text = await response.text()
    try {
      const parsed = JSON.parse(text) as { request_id?: unknown }
      responseBody = parsed
      if (typeof parsed.request_id === 'string') requestId = parsed.request_id
    } catch {
      // 空响应等非 JSON 体：不记录 request_id。
    }
    const rebuilt = new Response(text, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    })
    captured.push({
      url: String(input),
      method: init?.method ?? 'GET',
      headers,
      body,
      requestId,
      fixtureOnly,
      status: response.status,
      responseBody,
      streaming: false,
    })
    return rebuilt
  }
}
