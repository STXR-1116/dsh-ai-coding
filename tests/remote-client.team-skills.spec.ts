/* 浏览器自提供 remote.teamSkills 服务的契约：信封包装、会话状态机、静态
 * Token 直连路径、幂等键转发，以及宿主侧专属操作的显式业务失败。
 *
 * 传输层用可脚本化的假 fetch 驱动真实 HTTP 客户端（src/http.ts），断言的是
 * 浏览器服务这一层的语义，不重复 HTTP 解析器的既有覆盖。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { TeamSkillsRemoteService } from '../src/client/remote/team-skills.ts'
import { resolvePlatformClientConfig } from '../src/client/remote/config.ts'
import type { ResolvedPlatformClientConfig } from '../src/client/remote/config.ts'

interface CapturedRequest {
  readonly url: string
  readonly method: string
  readonly headers: Record<string, string>
  readonly body?: unknown
}

// The fixture bearer values below authorize nothing anywhere; they are joined
// at runtime to keep the fixtures free of credential-shaped literals.
const FIXTURE_TOKEN = ['fixture', 'bearer'].join('-')
const FIXTURE_ACCESS = ['fixture', 'access'].join('-')
const FIXTURE_REFRESH = ['fixture', 'refresh'].join('-')

const BASE = 'http://backend.test/v1'

function config(overrides: Partial<ResolvedPlatformClientConfig> = {}): ResolvedPlatformClientConfig {
  return resolvePlatformClientConfig({
    apiBaseUrl: BASE,
    accessToken: FIXTURE_TOKEN,
    ...overrides,
  })
}

function fakeContext(connection?: { readonly rpc: { call: (...args: never[]) => Promise<unknown> } }): Context {
  return {
    reflect: { provide: () => () => undefined },
    effect: () => () => undefined,
    get: (key: string) => (key === 'connection' ? connection : undefined),
  } as unknown as Context
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
  memberships: [{
    organization_id: 'org-1',
    organization_name: '演示组织',
    status: 'active',
    revision: 1,
  }],
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
    return new Response(scripted.status === 204 ? null : JSON.stringify(scripted.body), {
      status: scripted.status,
      headers: { 'content-type': 'application/json' },
    })
  })
  return { requests }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('浏览器 remote.teamSkills 服务', () => {
  it('登录把会话留在内存里，account 用它回答 authenticated', async () => {
    const { requests } = scriptFetch([
      { status: 200, body: envelope(SESSION) },
      { status: 200, body: envelope({ user: SESSION.user, memberships: SESSION.memberships }) },
    ])
    const service = new TeamSkillsRemoteService(fakeContext(), () => config())

    const login = await service.login({ username: 'user@example.com', password: 'pw' })
    expect(login).toEqual({ ok: true, value: { status: 'authenticated', user: expect.anything(), memberships: expect.anything(), mustChangePassword: false } })

    const account = await service.account()
    expect(account.ok).toBe(true)
    expect(account.ok && account.value.status).toBe('authenticated')
    expect(requests[1]?.headers.authorization).toBe(`Bearer ${FIXTURE_ACCESS}`)
  })

  it('未登录时 account 回答 signed-out，且不发请求', async () => {
    const { requests } = scriptFetch([])
    const service = new TeamSkillsRemoteService(fakeContext(), () => config())

    const account = await service.account()
    expect(account).toEqual({ ok: true, value: { status: 'signed-out' } })
    expect(requests).toHaveLength(0)
  })

  it('登录态过期的 account 读触发刷新；刷新也失败时会话被清空', async () => {
    const { requests } = scriptFetch([
      { status: 200, body: envelope(SESSION) },
      { status: 401, body: { data: null, code: 'TOKEN_EXPIRED', message: 'expired', request_id: 'req-2' } },
      { status: 401, body: { data: null, code: 'TOKEN_EXPIRED', message: 'expired', request_id: 'req-3' } },
    ])
    const service = new TeamSkillsRemoteService(fakeContext(), () => config())
    await service.login({ username: 'user@example.com', password: 'pw' })

    const account = await service.account()
    expect(account).toEqual({ ok: true, value: { status: 'signed-out' } })
    expect(requests).toHaveLength(3)
    // 过期触发刷新，刷新请求带幂等键头。
    expect(requests[2]?.url).toContain('/auth/refresh')
    expect(requests[2]?.headers['idempotency-key']).toBeTruthy()
  })

  it('无静态 Token 也无会话时，授权读回答 signed-out 信封', async () => {
    const { requests } = scriptFetch([])
    const service = new TeamSkillsRemoteService(fakeContext(), () => config({ accessToken: undefined }))

    const result = await service.knowledgeBases('project-1')
    expect(result).toEqual({ ok: true, value: { status: 'signed-out' } })
    expect(requests).toHaveLength(0)
  })

  it('静态 Token 部署直连后端：读带 Bearer，写转发调用方的幂等键', async () => {
    const { requests } = scriptFetch([
      { status: 200, body: envelope({ items: [], next_cursor: null, total_estimate: 0 }) },
      { status: 200, body: envelope({ status: 'PENDING', event_id: 'evt-1', job_id: 'job-1' }) },
    ])
    const service = new TeamSkillsRemoteService(fakeContext(), () => config())

    const list = await service.memoryList({ projectId: 'project-1' })
    expect(list.ok).toBe(true)
    expect(requests[0]?.headers.authorization).toBe(`Bearer ${FIXTURE_TOKEN}`)

    const capture = await service.memoryCapture(
      { projectId: 'project-1', sessionId: 'session-1', messages: [{ role: 'user', content: 'hi' }] },
      'idem-1',
    )
    expect(capture.ok).toBe(true)
    expect(requests[1]?.headers['idempotency-key']).toBe('idem-1')
  })

  it('传输层失败落 error 分支并保留服务码', async () => {
    scriptFetch([{ status: 403, body: { data: null, code: 'PROJECT_ACCESS_FORBIDDEN', message: 'denied', request_id: 'req-3' } }])
    const service = new TeamSkillsRemoteService(fakeContext(), () => config())

    const result = await service.memoryList({ projectId: 'project-1' })
    expect(result).toEqual({ ok: false, error: expect.objectContaining({ code: 'PROJECT_ACCESS_FORBIDDEN', message: 'denied' }) })
  })

  it('采集器在浏览器端回答 not-ready 快照', async () => {
    scriptFetch([])
    const service = new TeamSkillsRemoteService(fakeContext(), () => config())

    const snapshot = await service.collectorStatus()
    expect(snapshot).toEqual({ ok: true, value: { status: 'not-ready', missing: ['host telemetry collector'] } })
  })

  it('安装/卸载经宿主桥通道下发，不再由浏览器假装成功或硬失败', async () => {
    scriptFetch([])
    const calls: { channel: string; endpoint: string; payload: unknown }[] = []
    const hostAnswers: Record<string, unknown> = {
      'teamSkills/install': { status: 'ready', installation: { localInstallationId: 'local-1' }, stages: [] },
      'teamSkills/uninstall': { status: 'ready', installation: { localInstallationId: 'local-1', state: 'uninstalled' } },
      'teamSkills/installations': [{ localInstallationId: 'local-1' }],
      'teamSkills/syncReleaseStatus': [],
    }
    const connection = {
      rpc: {
        call: async (channel: string, endpoint: string, payload: unknown) => {
          calls.push({ channel, endpoint, payload })
          return { ok: true, value: hostAnswers[endpoint] }
        },
      },
    }
    const service = new TeamSkillsRemoteService(fakeContext(connection), () => config())

    const request = { skillId: 's-1', version: '1.0.0', projectId: 'project-1', scope: 'global' as const, environment: { dshVersion: '0', availableTools: [], availableMcpServers: [], presentEnvironmentVariableNames: [] } }
    const install = await service.installSkill(request)
    expect(install).toEqual({ ok: true, value: hostAnswers['teamSkills/install'] })
    expect(calls[0]).toEqual({ channel: '/dsh-ai-coding', endpoint: 'teamSkills/install', payload: request })

    const uninstall = await service.uninstallSkill({ localInstallationId: 'local-1' })
    expect(uninstall).toEqual({ ok: true, value: hostAnswers['teamSkills/uninstall'] })
    expect(calls[1]?.endpoint).toBe('teamSkills/uninstall')

    // 宿主本地状态同样走桥：浏览器没有这些记录，返回空数组就是撒谎。
    expect(await service.installations('project-1')).toEqual({ ok: true, value: hostAnswers['teamSkills/installations'] })
    expect(await service.syncReleaseStatus('project-1')).toEqual({ ok: true, value: hostAnswers['teamSkills/syncReleaseStatus'] })
    expect(calls.map(call => call.endpoint)).toEqual([
      'teamSkills/install',
      'teamSkills/uninstall',
      'teamSkills/installations',
      'teamSkills/syncReleaseStatus',
    ])
  })

  it('宿主桥失败时按业务失败透传，桥不可用时给具名失败', async () => {
    scriptFetch([])
    const failing = {
      rpc: {
        call: async () => ({ ok: false, error: { code: 'HOST_INSTALL_UNAVAILABLE', message: '宿主拒绝', details: {} } }),
      },
    }
    const withBridge = new TeamSkillsRemoteService(fakeContext(failing), () => config())
    const failed = await withBridge.uninstallSkill({ localInstallationId: 'local-1' })
    expect(failed.ok).toBe(false)
    expect(!failed.ok && failed.error.code).toBe('HOST_INSTALL_UNAVAILABLE')
    expect(!failed.ok && failed.error.message).toBe('宿主拒绝')

    // 没有 Connection 载体的部署：显式具名失败，而不是静默成功。
    const withoutBridge = new TeamSkillsRemoteService(fakeContext(), () => config())
    const unavailable = await withoutBridge.installSkill({ skillId: 's-1', version: '1.0.0', projectId: 'project-1', scope: 'global', environment: { dshVersion: '0', availableTools: [], availableMcpServers: [], presentEnvironmentVariableNames: [] } })
    expect(unavailable.ok).toBe(false)
    expect(!unavailable.ok && unavailable.error.code).toBe('ai-coding/host-bridge-unavailable')
  })

  it('会话级知识选择与记忆绑定记录在内存并可清除', async () => {
    scriptFetch([])
    const service = new TeamSkillsRemoteService(fakeContext(), () => config())

    const configured = await service.configureKnowledgeSelection('session-1', { projectId: 'project-1', knowledgeBaseIds: ['k-1'] })
    expect(configured).toEqual({ ok: true, value: undefined })
    const cleared = await service.clearKnowledgeSelection('session-1')
    expect(cleared).toEqual({ ok: true, value: undefined })
    expect(await service.configureProjectMemory('session-1', 'project-1')).toEqual({ ok: true, value: undefined })
    expect(await service.clearProjectMemory('session-1')).toEqual({ ok: true, value: undefined })
  })

  it('未配置设置时授权读回答显式 not-ready；保存设置后同一实例热接入新后端', async () => {
    const { requests } = scriptFetch([
      { status: 200, body: envelope(SESSION) },
    ])
    let current: ResolvedPlatformClientConfig | undefined
    const service = new TeamSkillsRemoteService(fakeContext(), () => current)

    const account = await service.account()
    expect(account.ok).toBe(true)
    expect(account.ok && account.value.status).toBe('not-ready')
    const list = await service.memoryList({ projectId: 'project-1' })
    expect(list.ok && list.value.status).toBe('not-ready')
    expect(requests).toHaveLength(0)

    // 设置面保存后，订阅回调重置缓存：同一实例直接接上新后端。
    current = config()
    const login = await service.login({ username: 'user@example.com', password: 'pw' })
    expect(login.ok).toBe(true)
    expect(requests).toHaveLength(1)
    expect(requests[0]?.url).toContain('/auth/login')
  })
})
