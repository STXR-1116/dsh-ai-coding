/* 浏览器自提供 remote.cloudWorkspaces 服务的契约：WorkspaceHost 委托、信封
 * 包装、共享账号身份（account 模式）与静态令牌模式、401 清会话的身份比对，
 * 以及写操作的 idempotency-key / if-match 线上形态。
 *
 * WorkspaceHost 自身的解析与流语义由 workspace-host 系列既有用例看守；这里
 * 只钉浏览器服务这一层新增的包装与身份规则。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { CloudWorkspacesRemoteService } from '../src/client/remote/cloud-workspaces.ts'
import { TeamSkillsRemoteService } from '../src/client/remote/team-skills.ts'
import { resolvePlatformClientConfig } from '../src/client/remote/config.ts'
import type { ResolvedPlatformClientConfig } from '../src/client/remote/config.ts'

interface CapturedRequest {
  readonly url: string
  readonly method: string
  readonly headers: Record<string, string>
  readonly body?: unknown
}

// The fixture bearer values authorize nothing anywhere.
const FIXTURE_TOKEN = ['fixture', 'bearer'].join('-')
const FIXTURE_ACCESS = ['fixture', 'access'].join('-')
const FIXTURE_REFRESH = ['fixture', 'refresh'].join('-')

const BASE = 'http://backend.test/v1'

function config(overrides: Partial<ResolvedPlatformClientConfig> = {}): ResolvedPlatformClientConfig {
  return resolvePlatformClientConfig({
    apiBaseUrl: BASE,
    workspaceApiBaseUrl: BASE,
    workspaceAccessToken: FIXTURE_TOKEN,
    authMode: 'static-token',
    ...overrides,
  })
}

function fakeContext(): Context {
  return { reflect: { provide: () => () => undefined }, effect: () => () => undefined } as unknown as Context
}

const envelope = (data: unknown) => ({
  data,
  code: 0,
  message: 'ok',
  request_id: 'req-1',
})

const SESSION = {
  access_token: FIXTURE_ACCESS,
  refresh_token: FIXTURE_REFRESH,
  expires_in: 3600,
  user: {
    user_id: 'user-1',
    username: 'user@example.com',
    email: 'user@example.com',
    display_name: '演示用户',
    status: 'active',
    global_role: 'member',
    must_change_password: false,
    revision: 1,
  },
  memberships: [],
  must_change_password: false,
}

/** Script one fake fetch; each entry answers one request in order. */
function scriptFetch(responses: Array<{ status: number; body: unknown }>): { requests: CapturedRequest[] } {
  const requests: CapturedRequest[] = []
  let index = 0
  vi.stubGlobal('fetch', async (input: URL | RequestInfo, init?: RequestInit) => {
    requests.push({
      url: String(input),
      method: init?.method ?? 'GET',
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      ...(typeof init?.body === 'string' ? { body: JSON.parse(init.body) as unknown } : {}),
    })
    const scripted = responses[Math.min(index, responses.length - 1)] as { status: number; body: unknown }
    index += 1
    return new Response(JSON.stringify(scripted.body), {
      status: scripted.status,
      headers: { 'content-type': 'application/json' },
    })
  })
  return { requests }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('浏览器 remote.cloudWorkspaces 服务', () => {
  it('静态令牌部署：读直达后端并包成 {ok, value} 信封', async () => {
    const { requests } = scriptFetch([
      { status: 200, body: envelope({ items: [] }) },
    ])
    const service = new CloudWorkspacesRemoteService(fakeContext(), () => config(), () => undefined, () => undefined)

    const result = await service.workspaces('project-1')
    expect(result.ok).toBe(true)
    expect(requests).toHaveLength(1)
    expect(requests[0]?.url).toContain('/v1/projects/project-1/workspaces')
    expect(requests[0]?.headers.authorization).toBe(`Bearer ${FIXTURE_TOKEN}`)
    if (result.ok) {
      expect(result.value).toEqual({ status: 'ready', value: [], fixtureOnly: false })
    }
  })

  it('account 模式借共享的平台会话；AUTH_REQUIRED 且身份相同时清掉该会话', async () => {
    // /auth/login(会话) → workspaces(AUTH_REQUIRED) → clear 比对 → 变 signed-out。
    const { requests } = scriptFetch([
      { status: 200, body: envelope(SESSION) },
      { status: 401, body: { code: 'AUTH_REQUIRED', message: 'expired', request_id: 'req-2' } },
    ])
    const team = new TeamSkillsRemoteService(fakeContext(), () => resolvePlatformClientConfig({ apiBaseUrl: BASE }))
    await team.login({ username: 'user@example.com', password: 'pw' })
    const service = new CloudWorkspacesRemoteService(
      fakeContext(),
      () => config({ authMode: 'account', workspaceAccessToken: undefined }),
      () => team.currentGrant(),
      (grant) => team.clearSessionIfCurrent(grant),
    )

    const first = await service.workspaces('project-1')
    expect(first.ok).toBe(true)
    expect(first.ok && first.value.status).toBe('signed-out')
    expect(team.currentGrant()).toBeUndefined()
    expect(requests).toHaveLength(2)
    expect(requests[1]?.headers.authorization).toBe(`Bearer ${FIXTURE_ACCESS}`)
  })

  it('静态令牌部署的 401 不清任何共享会话', async () => {
    scriptFetch([
      { status: 200, body: envelope(SESSION) },
      { status: 401, body: { code: 'AUTH_REQUIRED', message: 'expired', request_id: 'req-2' } },
    ])
    const team = new TeamSkillsRemoteService(fakeContext(), () => resolvePlatformClientConfig({ apiBaseUrl: BASE }))
    await team.login({ username: 'user@example.com', password: 'pw' })
    const service = new CloudWorkspacesRemoteService(fakeContext(), () => config(), () => team.currentGrant(), () => {
      throw new Error('static-token deployments never clear a shared session')
    })

    const result = await service.workspaces('project-1')
    expect(result.ok).toBe(true)
    expect(result.ok && result.value.status).toBe('signed-out')
    expect(team.currentGrant()?.accessToken).toBe(FIXTURE_ACCESS)
  })

  it('account 模式下无平台会话即 signed-out，不发请求', async () => {
    const { requests } = scriptFetch([])
    const service = new CloudWorkspacesRemoteService(
      fakeContext(),
      () => config({ authMode: 'account', workspaceAccessToken: undefined }),
      () => undefined,
      () => undefined,
    )

    const result = await service.workspaces('project-1')
    expect(result.ok && result.value.status).toBe('signed-out')
    expect(requests).toHaveLength(0)
  })

  it('写操作带服务生成的 idempotency-key', async () => {
    const { requests } = scriptFetch([
      { status: 200, body: envelope({}) },
    ])
    const service = new CloudWorkspacesRemoteService(fakeContext(), () => config(), () => undefined, () => undefined)

    await service.workspaceAction('ws-1', 'start', 3)
    expect(requests[0]?.headers['idempotency-key']).toBeTruthy()
  })

  it('服务级 403 是稳定的业务失败联合，不进 error 分支', async () => {
    scriptFetch([{ status: 403, body: { code: 'PROJECT_ACCESS_FORBIDDEN', message: 'denied', request_id: 'req-3' } }])
    const service = new CloudWorkspacesRemoteService(fakeContext(), () => config(), () => undefined, () => undefined)

    const result = await service.workspaces('project-1')
    expect(result.ok).toBe(true)
    if (result.ok && result.value.status === 'failed') {
      expect(result.value.code).toBe('PROJECT_ACCESS_FORBIDDEN')
    } else {
      expect.unreachable('a service 403 must surface as the failed business union')
    }
  })

  it('传输层崩溃同样收敛为稳定的业务失败联合（宿主编排器语义）', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('fetch failed')
    })
    const service = new CloudWorkspacesRemoteService(fakeContext(), () => config(), () => undefined, () => undefined)

    const result = await service.workspaces('project-1')
    expect(result.ok).toBe(true)
    expect(result.ok && result.value.status).toBe('failed')
  })

  it('未配置设置时查询回答宿主自身的 not-ready；保存设置后热接入', async () => {
    const { requests } = scriptFetch([
      { status: 200, body: envelope({ items: [] }) },
    ])
    let current: ResolvedPlatformClientConfig | undefined
    const service = new CloudWorkspacesRemoteService(fakeContext(), () => current, () => undefined, () => undefined)

    const before = await service.workspaces('project-1')
    expect(before.ok).toBe(true)
    expect(before.ok && before.value.status).toBe('not-ready')
    expect(requests).toHaveLength(0)

    current = config()
    const after = await service.workspaces('project-1')
    expect(after.ok).toBe(true)
    expect(after.ok && after.value.status).toBe('ready')
    expect(requests).toHaveLength(1)
  })
})
