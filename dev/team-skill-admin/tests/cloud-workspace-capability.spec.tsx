// @vitest-environment jsdom
/* oxlint-disable typescript/no-base-to-string -- Fetch 适配器断言检查 RequestInfo 线值。 */
/* 云工作空间后台能力状态反向测试（P2-08 后台半边）。
 *
 * 页面级用例走真实 HTTP fixture（apps/team-skill-service 的 http 服务），断言：
 *  - 服务端响应头 `x-fixture-only`
 *  - 统一响应 envelope（code / message / request_id / data）
 *  - 审计行字面 `result`
 *  - 页面上服务端声明的状态文字
 * 另有非 fixture 响应缺字段、生产未实现、协议错误的失败用例：
 * 空数组 / 空详情不得被当成成功。
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import React from 'react'
import type { AddressInfo } from 'node:net'
import { createTeamSkillService } from '../../../apps/team-skill-service/src/server.ts'
import { AdminDashboard } from '../src/components/admin-dashboard.tsx'
import { TeamSkillApi } from '../src/lib/team-skill-api.ts'

const SESSION = { user: { id: 'admin-1', name: '平台管理员' }, role: 'admin' as const, mustChangePassword: false }

const services: ReturnType<typeof createTeamSkillService>[] = []
let realFetch: typeof fetch
let serviceBaseUrl = ''
let adminToken = ''
/** 真实 fixture 场景头：由测试驱动真实 HTTP 失败路径。 */
let fixtureScenario: string | undefined

beforeAll(async () => {
  realFetch = globalThis.fetch
  const service = createTeamSkillService({ port: 0 })
  services.push(service)
  await service.listen()
  serviceBaseUrl = `http://127.0.0.1:${(service.server.address() as AddressInfo).port}/v1`
  const login = await realFetch(`${serviceBaseUrl}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin@example.com', password: 'admin-pass' }),
  })
  expect(login.status).toBe(200)
  adminToken = ((await login.json()) as { data: { access_token: string } }).data.access_token
})

afterAll(async () => {
  for (const service of services.splice(0)) {
    service.server.closeAllConnections()
    await new Promise<void>((resolve) => {
      service.server.close(() => {
        resolve()
      })
    })
  }
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  fixtureScenario = undefined
})

/**
 * 把后台页面的 `/api/team-skill` 代理请求转发到真实 fixture http 服务，
 * 只补上会话令牌；响应（含 `x-fixture-only` 头与 envelope）完全来自真实服务。
 */
function stubFixtureProxy(): void {
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = String(input)
    const target = raw.startsWith('/api/team-skill') ? `${serviceBaseUrl}${raw.slice('/api/team-skill'.length)}` : raw
    const headers = new Headers(init?.headers)
    headers.set('authorization', `Bearer ${adminToken}`)
    if (fixtureScenario !== undefined) headers.set('x-fixture-scenario', fixtureScenario)
    return realFetch(target, { ...init, headers })
  })
}

/**
 * 与 {@link stubFixtureProxy} 相同，但事件流返回给定的 SSE 正文。
 *
 * 事件流走的是同一条 `/api/team-skill/*` 同源代理链，因此页面看到的仍是代理
 * 响应；只有上游正文被替换成不合法的服务事件。
 */
function stubFixtureProxyWithStream(body: string): void {
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (raw.includes('/admin/events/stream')) {
      return new Response(body, {
        status: 200,
        headers: { 'content-type': 'text/event-stream', 'x-fixture-only': 'true' },
      })
    }
    const target = raw.startsWith('/api/team-skill') ? `${serviceBaseUrl}${raw.slice('/api/team-skill'.length)}` : raw
    const headers = new Headers(init?.headers)
    headers.set('authorization', `Bearer ${adminToken}`)
    if (fixtureScenario !== undefined) headers.set('x-fixture-scenario', fixtureScenario)
    return realFetch(target, { ...init, headers })
  })
}

async function adminGet(path: string): Promise<Response> {
  const headers: Record<string, string> = { authorization: `Bearer ${adminToken}` }
  if (fixtureScenario !== undefined) headers['x-fixture-scenario'] = fixtureScenario
  return realFetch(`${serviceBaseUrl}${path}`, { headers })
}

async function capabilityRow(fn: string): Promise<HTMLElement> {
  return waitFor(() => {
    const node = document.querySelector(`[data-capability="${fn}"]`)
    if (node === null) throw new Error(`能力状态行 ${fn} 尚未渲染`)
    return node as HTMLElement
  })
}

async function openWorkspacePage(name: RegExp): Promise<void> {
  // Agent 类型/配置 live in the Agent 配置 module; 运维/Run live in 云工作空间运维.
  const group = /Agent (类型|配置)/u.test(name.source) ? 'Agent 配置' : /审计/u.test(name.source) ? '运行与审计' : '云工作空间运维'
  fireEvent.click(screen.getByRole('button', { name: new RegExp(`^${group}`) }))
  const nav = await screen.findByLabelText(`${group}子导航`)
  fireEvent.click(within(nav).getByRole('button', { name }))
}

function envelopeBody(value: unknown, requestId = 'test-request'): Response {
  return new Response(JSON.stringify({ code: 0, message: 'ok', request_id: requestId, data: value }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

function errorEnvelope(code: string, message: string, status: number): Response {
  return new Response(JSON.stringify({ code, message, request_id: 'test-error', data: null }), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('cloud workspace capability status (real HTTP fixture)', () => {
  it('agent types: 响应头 + envelope + fixture-only 状态文字', async () => {
    stubFixtureProxy()

    const raw = await adminGet('/admin/agent-types')
    expect(raw.status).toBe(200)
    expect(raw.headers.get('x-fixture-only')).toBe('true')
    const envelope = (await raw.json()) as {
      code: number
      message: string
      request_id: string
      data: { items: Array<{ agent_type_id: string }> }
    }
    expect(envelope.code).toBe(0)
    expect(envelope.request_id.length).toBeGreaterThan(0)
    expect(envelope.data.items.map(item => item.agent_type_id)).toContain('at-claude-code')

    render(React.createElement(AdminDashboard, { session: SESSION }))
    await openWorkspacePage(/^Agent 类型/u)
    expect(await screen.findByText('at-claude-code')).toBeTruthy()

    const row = await capabilityRow('agent-types')
    expect(row.getAttribute('data-status')).toBe('fixture-only')
    expect(row.textContent).toContain('fixture-only')
    // 服务端声明的响应头必须出现在状态说明里，而不是被吞掉当成成功。
    expect(row.textContent).toContain('x-fixture-only')
    expect(document.querySelector('[data-status="ready"]')).toBeNull()
  })

  it('workspaces: 列表行声明 fixture_only，页面呈现 fixture-only 而非成功', async () => {
    stubFixtureProxy()

    const raw = await adminGet('/admin/workspaces')
    expect(raw.headers.get('x-fixture-only')).toBe('true')
    const envelope = (await raw.json()) as { code: number; data: { items: Array<{ workspace_id: string; fixture_only?: boolean }> } }
    expect(envelope.code).toBe(0)
    expect(envelope.data.items.some(item => item.fixture_only === true)).toBe(true)

    render(React.createElement(AdminDashboard, { session: SESSION }))
    await openWorkspacePage(/^Workspace 运维/u)
    expect(await screen.findByText('ws-alpha-1')).toBeTruthy()

    const row = await capabilityRow('workspaces')
    expect(row.getAttribute('data-status')).toBe('fixture-only')
    expect(row.textContent).toContain('fixture-only')
    expect(document.querySelector('[data-status="ready"]')).toBeNull()
  })

  it('audits: envelope + 审计 result + fixture-only 状态文字', async () => {
    stubFixtureProxy()

    const detail = await adminGet('/admin/workspaces/ws-alpha-1')
    const revision = ((await detail.json()) as { data: { revision: number } }).data.revision
    const stop = await realFetch(`${serviceBaseUrl}/admin/workspaces/ws-alpha-1:stop`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${adminToken}`,
        'content-type': 'application/json',
        'idempotency-key': `p208-audit-${String(revision)}`,
      },
      body: JSON.stringify({ expected_workspace_revision: revision }),
    })
    expect(stop.status).toBe(200)

    const raw = await adminGet('/admin/audits')
    expect(raw.headers.get('x-fixture-only')).toBe('true')
    const envelope = (await raw.json()) as {
      code: number
      data: Array<{ actor_name: string; action: string; result: string; request_id: string }>
    }
    expect(envelope.code).toBe(0)
    expect(envelope.data.length).toBeGreaterThan(0)
    for (const row of envelope.data) expect(['succeeded', 'failed']).toContain(row.result)
    expect(envelope.data.some(row => row.result === 'succeeded')).toBe(true)

    render(React.createElement(AdminDashboard, { session: SESSION }))
    await openWorkspacePage(/^审计$/u)
    expect(await screen.findByText(/admin\.workspace\.stop/u)).toBeTruthy()
    expect(screen.getAllByText(/succeeded/u).length).toBeGreaterThan(0)

    const row = await capabilityRow('audits')
    expect(row.getAttribute('data-status')).toBe('fixture-only')
    expect(row.textContent).toContain('fixture-only')
  })

  it('workspace detail: 真实详情渲染关系字段，并单独声明 workspace-detail 状态', async () => {
    stubFixtureProxy()

    const raw = await adminGet('/admin/workspaces/ws-alpha-1')
    expect(raw.headers.get('x-fixture-only')).toBe('true')
    const payload = (await raw.json()) as { data: { recent_audits: unknown[]; runs: unknown[]; config_snapshot: unknown } }
    expect(Array.isArray(payload.data.recent_audits)).toBe(true)
    expect(Array.isArray(payload.data.runs)).toBe(true)
    expect(Object.hasOwn(payload.data, 'config_snapshot')).toBe(true)

    render(React.createElement(AdminDashboard, { session: SESSION }))
    await openWorkspacePage(/^Workspace 运维/u)
    await screen.findByText('ws-alpha-1')
    fireEvent.click(screen.getAllByRole('button', { name: '查看详情' })[0])
    expect(await screen.findByText(/最近审计/u)).toBeTruthy()

    const row = await capabilityRow('workspace-detail')
    expect(row.getAttribute('data-status')).toBe('fixture-only')
    expect(row.textContent).toContain('fixture-only')
  })

  it('service unavailable: 真实 503 SERVICE_UNAVAILABLE 呈现失败，且不把空表当成功', async () => {
    fixtureScenario = 'workspace-downstream-failure'
    stubFixtureProxy()

    const raw = await adminGet('/admin/agent-types')
    expect(raw.status).toBe(503)
    expect(((await raw.json()) as { code: string }).code).toBe('SERVICE_UNAVAILABLE')

    render(React.createElement(AdminDashboard, { session: SESSION }))
    await openWorkspacePage(/^Agent 类型/u)

    // 0-2 起渲染门读取同一端点：503 在框架层呈现失败（错误码可见、胶囊「需要处理」），
    // 页面与其能力状态行都不作为空成功渲染。
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('SERVICE_UNAVAILABLE')
    expect(screen.getByText('需要处理')).toBeTruthy()
    expect(document.querySelector('[data-capability="agent-types"]')).toBeNull()
    expect(document.querySelector('[data-status="ready"], [data-status="fixture-only"]')).toBeNull()
  })
})

describe('cloud workspace capability status (non-fixture / protocol failures)', () => {
  it('production not implemented: 呈现 not-ready', async () => {
    vi.stubEnv('NEXT_PUBLIC_TEAM_SKILL_API_URL', 'http://service.test/v1')
    vi.stubGlobal('fetch', vi.fn(async () => errorEnvelope('NOT_IMPLEMENTED', '生产能力未提供', 501)))
    render(React.createElement(AdminDashboard, { session: SESSION }))
    await openWorkspacePage(/^Agent 类型/u)

    // 渲染门读取失败：框架错误态携带服务端稳定错误码，不以空列表冒充成功。
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('NOT_IMPLEMENTED')
    expect(screen.getByText('需要处理')).toBeTruthy()
    expect(document.querySelector('[data-capability="agent-types"]')).toBeNull()
    expect(document.querySelector('[data-status="ready"]')).toBeNull()
  })

  it('protocol error: 非 envelope 响应呈现 BLOCKED', async () => {
    vi.stubEnv('NEXT_PUBLIC_TEAM_SKILL_API_URL', 'http://service.test/v1')
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>gateway</html>', {
      status: 200,
      headers: { 'content-type': 'text/html' },
    })))
    render(React.createElement(AdminDashboard, { session: SESSION }))
    await openWorkspacePage(/^Agent 类型/u)

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('INVALID_RESPONSE')
    expect(screen.getByText('需要处理')).toBeTruthy()
    expect(document.querySelector('[data-capability="agent-types"]')).toBeNull()
    expect(document.querySelector('[data-status="ready"]')).toBeNull()
  })

  it('non-fixture 响应缺少必需字段：呈现 BLOCKED，不渲染为空成功', async () => {
    vi.stubEnv('NEXT_PUBLIC_TEAM_SKILL_API_URL', 'http://service.test/v1')
    vi.stubGlobal('fetch', vi.fn(async () => envelopeBody({ items: [{ name: '缺少标识的类型' }] })))
    render(React.createElement(AdminDashboard, { session: SESSION }))
    await openWorkspacePage(/^Agent 类型/u)

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('INVALID_RESPONSE')
    // 缺字段的行不得作为列表内容展示成成功。
    expect(screen.queryByText('缺少标识的类型')).toBeNull()
    expect(document.querySelector('[data-capability="agent-types"]')).toBeNull()
    expect(document.querySelector('[data-status="ready"]')).toBeNull()
  })

  it('non-fixture 空数组：状态为 ready 但显式标记 data-empty，不静默当成功', async () => {
    vi.stubEnv('NEXT_PUBLIC_TEAM_SKILL_API_URL', 'http://service.test/v1')
    vi.stubGlobal('fetch', vi.fn(async () => envelopeBody({ items: [] })))
    render(React.createElement(AdminDashboard, { session: SESSION }))
    await openWorkspacePage(/^Agent 类型/u)

    const row = await capabilityRow('agent-types')
    expect(row.getAttribute('data-empty')).toBe('true')
    expect(row.textContent).toContain('0 条')
  })
})

describe('cloud workspace API strictness (no silent empty defaults)', () => {
  const headers = { 'content-type': 'application/json' }

  it('workspace detail 缺少 recent_audits/runs/config_snapshot 时为 INVALID_RESPONSE', async () => {
    const api = new TeamSkillApi({
      baseUrl: 'https://service.test/v1',
      accessToken: 'token',
      fetcher: async () => new Response(JSON.stringify({
        code: 0,
        message: 'ok',
        request_id: 'r-detail',
        // A contract-complete row: the check under test is the nested detail
        // requirement, not the row's own members.
        data: {
          workspace_id: 'ws-1',
          project_id: 'project-alpha',
          owner_user_id: 'member-1',
          repository_id: 'repo-1',
          branch: 'main',
          display_name: 'space',
          default_agent_profile_version_id: 'apv-1',
          status: 'ready',
          revision: 3,
          last_error: null,
          created_at: '2026-09-01T00:00:00Z',
          updated_at: '2026-09-09T00:00:00Z',
        },
      }), { status: 200, headers }),
    })
    const result = await api.cloudWorkspace('ws-1')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toMatchObject({ kind: 'service', code: 'INVALID_RESPONSE' })
      if (result.error.kind === 'service') expect(result.error.message).toContain('recent_audits')
    }
  })

  it('malformed 事件帧：页面呈现协议错误，不显示已连接且不合并该事件', async () => {
    // 缺 revision 的事件：字段合同不允许，reader 必须整体拒绝该帧。
    const badFrame = [
      'event: workspace.updated',
      'id: evt-bad',
      'data: {"event_id":"evt-bad","resource_type":"workspace","resource_id":"ws-phantom","event_type":"workspace.updated","occurred_at":"2026-09-11T00:00:00Z","payload":{}}',
      '',
      '',
    ].join('\n')
    stubFixtureProxyWithStream(badFrame)

    render(React.createElement(AdminDashboard, { session: SESSION }))
    await openWorkspacePage(/^Workspace 运维/u)

    const badge = await waitFor(() => {
      const node = document.querySelector('[data-stream-status]')
      if (node === null) throw new Error('实时状态徽标尚未渲染')
      return node as HTMLElement
    })
    // 状态跃迁到协议错误，并且页面从不声称已连接。
    await waitFor(() => {
      expect(badge.getAttribute('data-stream-status')).toBe('stale')
    })
    expect(badge.textContent).toContain('事件协议错误')
    expect(badge.textContent).not.toContain('已连接')

    // 被拒绝的帧没有进入页面状态：它的 resource_id 从不出现在表格里，
    // 而服务端快照（真实 fixture）仍然正常呈现。
    await waitFor(() => {
      expect(screen.getAllByText('ws-alpha-1').length).toBeGreaterThan(0)
    })
    expect(screen.queryByText('ws-phantom')).toBeNull()
  })

  it('agent types 行缺少 readiness 时为 INVALID_RESPONSE', async () => {
    const api = new TeamSkillApi({
      baseUrl: 'https://service.test/v1',
      accessToken: 'token',
      fetcher: async () => new Response(JSON.stringify({
        code: 0,
        message: 'ok',
        request_id: 'r-types',
        data: { items: [{ agent_type_id: 'at-1', key: 'k', name: 'n', capabilities: [] }] },
      }), { status: 200, headers }),
    })
    await expect(api.cloudAgentTypes()).resolves.toMatchObject({
      ok: false,
      error: { kind: 'service', code: 'INVALID_RESPONSE' },
    })
  })

  it('成功响应携带服务端证据（fixture 头 / request_id）', async () => {
    const api = new TeamSkillApi({
      baseUrl: 'https://service.test/v1',
      accessToken: 'token',
      fetcher: async () => new Response(JSON.stringify({
        code: 0,
        message: 'ok',
        request_id: 'r-evidence',
        data: { items: [{ agent_type_id: 'at-1', key: 'k', name: 'n', capabilities: ['terminal'], readiness: 'ready', schema_version: '1', schema: [] }] },
      }), { status: 200, headers: { ...headers, 'x-fixture-only': 'true' } }),
    })
    const result = await api.cloudAgentTypes()
    expect(result.ok).toBe(true)
    expect(result.evidence.fixtureOnly).toBe(true)
    expect(result.evidence.requestId).toBe('r-evidence')
  })
})
