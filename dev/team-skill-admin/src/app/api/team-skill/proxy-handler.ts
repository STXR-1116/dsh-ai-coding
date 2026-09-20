/** Team Skill 管理后台反向代理核心：鉴权注入与上游异常→稳定 JSON 503。 */
import type { NextRequest } from 'next/server'

type RouteContext = { readonly params: Promise<{ readonly path: readonly string[] }> }

export type ProxyTokenReader = (request: NextRequest) => Promise<string | undefined>

export async function handleTeamSkillProxy(
  request: NextRequest,
  context: RouteContext,
  readToken: ProxyTokenReader = defaultTokenReader,
): Promise<Response> {
  const requestId = crypto.randomUUID()
  const { path } = await context.params
  const useV3MemoryRoute = path[0] === 'v3' && path[1] === 'project-memory'
  const baseUrl = readEnv('TEAM_SKILL_SERVICE_URL')
  const memoryBase = useV3MemoryRoute ? readEnv('MEMORY_SERVICE_URL') : undefined
  const upstreamBase = useV3MemoryRoute ? memoryBase : baseUrl
  if (upstreamBase === undefined)
    return Response.json(
      {
        code: useV3MemoryRoute ? 'MEMORY_SERVICE_UNAVAILABLE' : 'SERVICE_UNAVAILABLE',
        message: useV3MemoryRoute ? 'MemoryService 尚未配置' : 'Skill 服务尚未配置',
        request_id: requestId,
        data: null,
      },
      { status: 503 },
    )
  const accessToken = await readToken(request)
  if (accessToken === undefined)
    return Response.json(
      { code: 'AUTH_REQUIRED', message: '需要有效的后台 Session', request_id: requestId, data: null },
      { status: 401 },
    )
  const upstreamPath = useV3MemoryRoute ? path.slice(1) : path
  const suffix = upstreamPath.map(encodeUpstreamSegment).join('/')
  const target = `${upstreamBase}/${suffix}${request.nextUrl.search}`
  const headers = new Headers(request.headers)
  headers.delete('cookie')
  headers.delete('host')
  headers.set('Authorization', `Bearer ${accessToken}`)
  const body = request.method === 'GET' || request.method === 'HEAD' ? undefined : await request.arrayBuffer()
  // An event stream is long-lived by contract: a deadline here would abort a
  // healthy subscription every 30 seconds and the admin would never see a live
  // badge longer than that. The stream still ends when the caller disconnects,
  // because the upstream request is aborted with it.
  const wantsStream = request.headers.get('accept')?.includes('text/event-stream') === true
  let upstream: Response
  try {
    // 上游 DNS 失败、连接拒绝或超时会以异常抛出；不捕获会交给 Next 运行时返回
    // HTML 500，后台客户端只能得到 INVALID_RESPONSE 且丢失 request_id 关联。
    upstream = await fetch(target, {
      method: request.method,
      headers,
      body,
      redirect: 'manual',
      cache: 'no-store',
      ...(wantsStream ? { signal: request.signal } : { signal: AbortSignal.timeout(30_000) }),
    })
  } catch (error) {
    const reason = error instanceof Error && error.name === 'TimeoutError' ? 'upstream timeout' : 'upstream unreachable'
    return Response.json(
      { code: 'UPSTREAM_UNAVAILABLE', message: `Skill 服务请求失败：${reason}`, request_id: requestId, data: null },
      { status: 503 },
    )
  }
  const responseHeaders = new Headers(upstream.headers)
  responseHeaders.delete('set-cookie')
  responseHeaders.set('x-request-id', requestId)
  return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers: responseHeaders })
}

/**
 * 编码一个上游路径段。
 *
 * `params.path` 已由 Next 解码，直接 `encodeURIComponent` 会把 `:publish` /
 * `:archive` / `:clone` 这类子资源动词编码成 `%3A`。服务端按**原始**路径段里的
 * `:` 切分动词（`rawSegment.indexOf(':')`），因此 `%3A` 会让上游切不出动词、
 * 把整段当成 profile id，所有 `:verb` 路由都以 404 结束。
 * `:` 是 RFC 3986 允许出现在路径段中的字符（sub-delim），这里原样保留。
 */
function encodeUpstreamSegment(segment: string): string {
  return encodeURIComponent(segment).replaceAll('%3A', ':')
}

/** 与 auth.ts 相同的去尾斜杠 env 读取；此处独立读取避免把 Next Auth 打入测试解析图。 */
function readEnv(name: string): string | undefined {  const value = process.env[name]?.trim()
  if (value === undefined || value.length === 0) return undefined
  return value.replace(/\/$/u, '')
}

/** 缺省 Token 读取器：延迟加载 Next Auth JWT 会话（与 route.ts 的
 * sessionTokenReader 同一逻辑；route 始终显式传入，此处仅作缺省兜底）。 */
export const defaultTokenReader: ProxyTokenReader = async (request) => {
  const { getToken } = await import('next-auth/jwt')
  const { authSecret } = await import('../../../auth.ts')
  const token = await getToken({ req: request, secret: authSecret })
  return token !== null && typeof token.accessToken === 'string' ? token.accessToken : undefined
}
