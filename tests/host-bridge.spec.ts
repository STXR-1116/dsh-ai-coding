/* 宿主桥的宿主半边。
 *
 * 桥自己注册一条 `/dsh-ai-coding` 前缀路由，并把鉴权交给
 * `connection.requestRejection()`（Connection 文档里写给其它 Web 路由的那一对
 * 「先过 Host/Origin 围栏，再过浏览器会话」）。这里用假的 req/res 直接驱动那条
 * handler，钉住 HTTP 语义与信封契约：
 *
 * - 未通过鉴权 → 401/403，且**不**触碰宿主操作；
 * - 非 POST / 非 JSON / 非 client-request 信封 / 超大 body → 各自的显式状态码；
 * - 合法请求 → 分发到 TeamSkillHost，并回带同一个 rpcId 的 server-response；
 * - 业务结果走 `{ok:true}`，未注册端点与宿主抛错走 `{ok:false,error}`，绝不抛出。
 *
 * 同时验证注册只声明 `['connection','webServer']` 这一对依赖，以及注册是 fiber
 * 拥有的 effect（卸载行即撤回路由）。
 */
import { describe, expect, it, vi } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import {
  HOST_BRIDGE_CHANNEL,
  HOST_BRIDGE_ENDPOINTS,
  HOST_BRIDGE_UNKNOWN_ENDPOINT,
  installHostBridge,
} from '../src/host-bridge.ts'
import type { TeamSkillHost } from '../src/host.ts'

/** What the route handler produced, as the socket would carry it. */
interface Recorded {
  status?: number
  headers?: Record<string, string>
  body?: string
}

/** A request double: headers, method, url and an async body. */
function request(options: {
  method?: string
  url?: string
  contentType?: string | undefined
  body?: string
} = {}): IncomingMessage {
  const raw = options.body ?? ''
  return {
    method: options.method ?? 'POST',
    url: options.url ?? `${HOST_BRIDGE_CHANNEL}/${HOST_BRIDGE_ENDPOINTS.installations}`,
    headers: options.contentType === undefined ? {} : { 'content-type': options.contentType },
    async *[Symbol.asyncIterator]() {
      if (raw.length > 0) yield Buffer.from(raw)
    },
  } as unknown as IncomingMessage
}

/** A response double recording what the handler wrote. */
function response(recorded: Recorded): ServerResponse {
  return {
    writeHead: (status: number, headers?: Record<string, string>) => {
      recorded.status = status
      recorded.headers = headers
    },
    end: (body?: string) => { recorded.body = body },
  } as unknown as ServerResponse
}

/** A host double recording which operation ran and with what payload. */
function fakeHost(overrides: Partial<Record<string, unknown>> = {}) {
  const calls: { operation: string; payload: unknown }[] = []
  const record = (operation: string) => (payload: unknown) => {
    calls.push({ operation, payload })
    const answer = overrides[operation]
    if (answer instanceof Error) return Promise.reject(answer)
    return Promise.resolve(answer ?? { status: 'ready' })
  }
  return {
    host: {
      install: record('install'),
      uninstall: record('uninstall'),
      installations: record('installations'),
      syncReleaseStatus: record('syncReleaseStatus'),
    } as unknown as TeamSkillHost,
    calls,
  }
}

/**
 * Register the bridge against doubles and hand back the route it mounted.
 * @param rejection - what Connection's fence answers for this deployment.
 */
function mount(host: TeamSkillHost, rejection: 401 | 403 | undefined = undefined) {
  const recorded: Recorded = {}
  let route: WebRoute | undefined
  const effect = vi.fn((run: () => unknown) => { run(); return async () => undefined })
  const inject = vi.fn((deps: readonly string[], body: (ctx: Context) => void) => {
    body({
      webServer: { register: (candidate: WebRoute) => { route = candidate; return () => undefined } },
      connection: { requestRejection: () => rejection },
      effect,
    } as unknown as Context)
  })
  installHostBridge({ inject } as unknown as Context, host)
  return {
    inject,
    effect,
    recorded,
    getRoute: () => {
      if (route === undefined) throw new Error('the bridge registered no route')
      return route
    },
  }
}

/** Send one request through the mounted route and return what was written. */
async function send(
  mounted: ReturnType<typeof mount>,
  options: Parameters<typeof request>[0],
): Promise<Recorded> {
  await mounted.getRoute().handler(request(options), response(mounted.recorded))
  // The handler starts an async body it does not await; one macrotask settles it.
  await new Promise(resolve => setTimeout(resolve, 0))
  return mounted.recorded
}

const envelope = (method: string, payload: unknown = null) =>
  JSON.stringify({ type: 'client-request', rpcId: '11111111-1111-4111-8111-111111111111', method, payload })

describe('宿主桥注册', () => {
  it('只声明 connection 与 webServer 这一对依赖', () => {
    const mounted = mount(fakeHost().host)
    expect(mounted.inject).toHaveBeenCalledTimes(1)
    expect(mounted.inject.mock.calls[0]?.[0]).toEqual(['connection', 'webServer'])
  })

  it('把前缀路由挂在自己的通道上，且注册是 fiber 拥有的 effect', () => {
    const mounted = mount(fakeHost().host)
    const route = mounted.getRoute()
    expect(route.kind).toBe('prefix')
    expect(route.path).toBe(HOST_BRIDGE_CHANNEL)
    expect(mounted.effect).toHaveBeenCalledTimes(1)
    expect(mounted.effect.mock.calls[0]?.[1]).toContain(HOST_BRIDGE_CHANNEL)
  })
})

describe('宿主桥的 HTTP 与信封语义', () => {
  it('未通过鉴权时回 401/403，且不触碰宿主操作', async () => {
    const { host, calls } = fakeHost()
    for (const rejection of [401, 403] as const) {
      const mounted = mount(host, rejection)
      const recorded = await send(mounted, { contentType: 'application/json', body: envelope(HOST_BRIDGE_ENDPOINTS.installations) })
      expect(recorded.status).toBe(rejection)
    }
    expect(calls).toEqual([])
  })

  it('非 POST、非 JSON、非信封、超大 body 各自响亮拒绝', async () => {
    const mounted = mount(fakeHost().host)
    expect((await send(mounted, { method: 'GET', contentType: 'application/json' })).status).toBe(405)
    expect((await send(mounted, { contentType: 'text/plain', body: '{}' })).status).toBe(415)
    expect((await send(mounted, { contentType: 'application/json', body: 'not json' })).status).toBe(400)
    expect((await send(mounted, { contentType: 'application/json', body: '{"type":"nope"}' })).status).toBe(400)
    const huge = JSON.stringify({ type: 'client-request', rpcId: 'x'.repeat(40), method: 'm', payload: 'y'.repeat(2 * 1024 * 1024) })
    expect((await send(mounted, { contentType: 'application/json', body: huge })).status).toBe(413)
  })

  it('通道外的路径回 404', async () => {
    const mounted = mount(fakeHost().host)
    const recorded = await send(mounted, { url: '/somewhere-else', contentType: 'application/json', body: envelope('x') })
    expect(recorded.status).toBe(404)
  })

  it('四个端点各自落到 TeamSkillHost 的对应方法并原样透传 payload', async () => {
    const { host, calls } = fakeHost()
    const mounted = mount(host)

    await send(mounted, { url: `${HOST_BRIDGE_CHANNEL}/${HOST_BRIDGE_ENDPOINTS.installations}`, contentType: 'application/json', body: envelope(HOST_BRIDGE_ENDPOINTS.installations, 'project-1') })
    await send(mounted, { url: `${HOST_BRIDGE_CHANNEL}/${HOST_BRIDGE_ENDPOINTS.syncReleaseStatus}`, contentType: 'application/json', body: envelope(HOST_BRIDGE_ENDPOINTS.syncReleaseStatus, 'project-1') })
    const installRequest = { skillId: 's-1', version: '1.0.0', projectId: 'project-1', scope: 'global' }
    await send(mounted, { url: `${HOST_BRIDGE_CHANNEL}/${HOST_BRIDGE_ENDPOINTS.install}`, contentType: 'application/json', body: envelope(HOST_BRIDGE_ENDPOINTS.install, installRequest) })
    const uninstallRequest = { localInstallationId: 'local-1' }
    await send(mounted, { url: `${HOST_BRIDGE_CHANNEL}/${HOST_BRIDGE_ENDPOINTS.uninstall}`, contentType: 'application/json', body: envelope(HOST_BRIDGE_ENDPOINTS.uninstall, uninstallRequest) })

    expect(calls).toEqual([
      { operation: 'installations', payload: 'project-1' },
      { operation: 'syncReleaseStatus', payload: 'project-1' },
      { operation: 'install', payload: installRequest },
      { operation: 'uninstall', payload: uninstallRequest },
    ])
  })

  it('回带同一个 rpcId 的 server-response，业务结果走成功分支', async () => {
    const answer = { status: 'ready', installation: { localInstallationId: 'local-1' } }
    const mounted = mount(fakeHost({ install: answer }).host)
    const recorded = await send(mounted, { url: `${HOST_BRIDGE_CHANNEL}/${HOST_BRIDGE_ENDPOINTS.install}`, contentType: 'application/json', body: envelope(HOST_BRIDGE_ENDPOINTS.install, {}) })

    expect(recorded.status).toBe(200)
    expect(recorded.headers?.['cache-control']).toBe('no-store')
    const parsed = JSON.parse(recorded.body ?? '{}')
    expect(parsed.type).toBe('server-response')
    // 调用方按 rpcId 做相关性校验，回错 id 会被判成传输失败。
    expect(parsed.rpcId).toBe('11111111-1111-4111-8111-111111111111')
    expect(parsed.result).toEqual({ ok: true, value: answer })
  })

  it('未注册端点回本插件的具名失败，而不是 404 或抛错', async () => {
    const mounted = mount(fakeHost().host)
    const recorded = await send(mounted, { url: `${HOST_BRIDGE_CHANNEL}/teamSkills/nope`, contentType: 'application/json', body: envelope('teamSkills/nope') })
    expect(recorded.status).toBe(200)
    expect(JSON.parse(recorded.body ?? '{}').result).toMatchObject({
      ok: false,
      error: { code: HOST_BRIDGE_UNKNOWN_ENDPOINT },
    })
  })

  it('宿主抛错折叠成失败分支，不把异常漏给调用方', async () => {
    const mounted = mount(fakeHost({ uninstall: new Error('宿主磁盘只读') }).host)
    const recorded = await send(mounted, { url: `${HOST_BRIDGE_CHANNEL}/${HOST_BRIDGE_ENDPOINTS.uninstall}`, contentType: 'application/json', body: envelope(HOST_BRIDGE_ENDPOINTS.uninstall, {}) })
    expect(JSON.parse(recorded.body ?? '{}').result).toMatchObject({
      ok: false,
      error: { code: 'gateway/internal', message: '宿主磁盘只读' },
    })
  })
})

describe('通道与端点常量', () => {
  it('通道是本插件独占的绝对前缀，端点不与他人共名', () => {
    expect(HOST_BRIDGE_CHANNEL.startsWith('/')).toBe(true)
    // 共享 /api 通道由 api-gateway 逐端点认领；本插件用独立前缀避免撞名。
    expect(HOST_BRIDGE_CHANNEL).not.toBe('/api')
    const endpoints = Object.values(HOST_BRIDGE_ENDPOINTS)
    expect(new Set(endpoints).size).toBe(endpoints.length)
    for (const endpoint of endpoints) expect(endpoint.startsWith('teamSkills/')).toBe(true)
  })

  it('两个半边引用同一组常量，浏览器侧不另写一份', async () => {
    const browser = await import('../src/client/remote/host-call.ts')
    expect(browser.callHostBridge).toBeTypeOf('function')
    expect(Object.keys(browser)).not.toContain('HOST_BRIDGE_CHANNEL')
    expect(HOST_BRIDGE_CHANNEL).toBe('/dsh-ai-coding')
  })
})
