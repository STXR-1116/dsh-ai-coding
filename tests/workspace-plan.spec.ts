/* oxlint-disable typescript/no-base-to-string -- Fetch stubs stringify RequestInfo wire values. */
/**
 * 1-1「Plan 实体」平台层验收（契约：API 需求 §11.6）。
 *
 * 覆盖三面：
 *   1. `parsePlan` 严格解析——字段集闭包、未知状态显式 unknown、缺字段协议错误；
 *   2. WorkspaceHost 计划生命周期——列表/创建/编辑（If-Match + 幂等键）/确认，
 *      服务失败映射为 failed 结果且保留稳定错误码；
 *   3. Run 对已确认计划的不可变引用——createRun 携带 plan_id，快照带只读 planId
 *      （draft 归 Plan：运行只引用 confirmed 计划，判定在 fixture 契约测试中）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkspaceHttpClient, parsePlan, parseRun } from '../src/workspace-http.ts'
import { WorkspaceHost } from '../src/workspace-host.ts'
import type { WorkspaceSessionProvider } from '../src/workspace-host.ts'

afterEach(() => {
  vi.restoreAllMocks()
})

function session(): WorkspaceSessionProvider {
  const current = 'plan-token'
  return {
    read: async () => ({ accessToken: current, identity: `identity:${current}` }),
    clear: async () => false,
  }
}

const planDto = {
  plan_id: 'plan-1',
  workspace_id: 'ws-1',
  project_id: 'project-alpha',
  goal: '为发布流水线补齐回归测试',
  steps: [{ title: '梳理现有用例' }, { title: '补充边界用例', depends_on: [0] }],
  agent_profile_version_id: 'apv-1',
  asset_version_ids: ['skill:code-review@1.0.0'],
  status: 'draft',
  revision: 2,
  created_by: 'admin-1',
  created_at: '2026-09-16T00:00:00.000Z',
  updated_at: '2026-09-16T00:01:00.000Z',
  edits: [
    {
      edit_id: 'edit-1',
      editor: '平台管理员',
      edited_at: '2026-09-16T00:01:00.000Z',
      change_summary: '补充边界步骤',
      revision_before: 1,
      revision_after: 2,
      before: {
        goal: '初始目标',
        steps: [{ title: '梳理现有用例' }],
        agent_profile_version_id: 'apv-1',
        asset_version_ids: ['skill:code-review@1.0.0'],
      },
    },
  ],
  fixture_only: true,
}

const runDto = {
  run_id: 'run-1',
  project_id: 'project-alpha',
  workspace_id: 'ws-1',
  session_id: 'sess-1',
  agent_profile_version_id: 'apv-1',
  asset_version_ids: ['skill:code-review@1.0.0'],
  execution_policy: { permission_mode: 'approval' },
  workspace_revision: 3,
  status: 'preparing',
  write_mode: 'read_only',
  lease_id: null,
  revision: 1,
  plan_id: 'plan-1',
  error_code: null,
  created_at: '2026-09-16T00:00:00.000Z',
  updated_at: '2026-09-16T00:00:00.000Z',
}

/** 按路径脚本响应的 fetch 桩；记录全部请求以便断言方法/头/体。 */
interface StubRoute {
  readonly match: (url: string, method: string) => boolean
  readonly respond: () => { readonly status: number; readonly body: unknown }
}

function stubFetch(routes: StubRoute[]): {
  readonly fetcher: typeof globalThis.fetch
  readonly calls: Array<{
    readonly url: string
    readonly method: string
    readonly headers: Record<string, string>
    readonly body: unknown
  }>
} {
  const calls: Array<{
    readonly url: string
    readonly method: string
    readonly headers: Record<string, string>
    readonly body: unknown
  }> = []
  const fetcher = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    const headers: Record<string, string> = {}
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = value
    })
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined
    calls.push({ url, method, headers, body })
    const route = routes.find(route => route.match(url, method))
    if (route === undefined) {
      return new Response(JSON.stringify({ code: 'RESOURCE_NOT_FOUND', message: '未脚本化', request_id: 'r', data: null }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      })
    }
    const { status, body: payload } = route.respond()
    // 错误响应必须本身就是错误信封（data:null）；只有 2xx 才包成功信封。
    if (status >= 400) {
      return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } })
    }
    return new Response(JSON.stringify({ code: 0, message: 'ok', request_id: 'r', data: payload }), {
      status,
      headers: { 'content-type': 'application/json', 'x-fixture-only': 'true' },
    })
  })
  return { fetcher, calls }
}

describe('parsePlan 严格解析', () => {
  it('契约字段集闭包：解析结果只含声明的字段，多余字段不进入结果', () => {
    const plan = parsePlan(planDto)
    expect(Object.keys(plan).sort()).toEqual([
      'agentProfileVersionId',
      'assetVersionIds',
      'createdAt',
      'createdBy',
      'edits',
      'goal',
      'planId',
      'projectId',
      'revision',
      'status',
      'steps',
      'updatedAt',
      'workspaceId',
    ])
    expect(plan.status).toBe('draft')
    expect(plan.edits[0]?.before.goal).toBe('初始目标')
  })

  it('未知计划状态显式映射 unknown，不吞成 draft/confirmed', () => {
    expect(parsePlan({ ...planDto, status: 'archived' }).status).toBe('unknown')
    expect(parsePlan({ ...planDto, status: 42 }).status).toBe('unknown')
  })

  it('缺字段是协议漂移：抛 SERVICE_PROTOCOL_ERROR 而不是默认值', () => {
    const missing = { ...planDto } as Record<string, unknown>
    delete missing['goal']
    expect(() => parsePlan(missing)).toThrow(/goal/u)
  })

  it('parseRun 的可选 plan_id：有则保留（不可变引用），无则缺席', () => {
    expect(parseRun(runDto).planId).toBe('plan-1')
    const without = { ...runDto } as Record<string, unknown>
    delete without['plan_id']
    expect(Object.hasOwn(parseRun(without), 'planId')).toBe(false)
  })
})

describe('WorkspaceHost 计划生命周期', () => {
  it('createPlan/workspacePlans/updatePlan/confirmPlan 走契约路径并携带并发与幂等头', async () => {
    const { fetcher, calls } = stubFetch([
      { match: (url, method) => method === 'POST' && url.endsWith('/v1/workspaces/ws-1/plans'), respond: () => ({ status: 201, body: planDto }) },
      { match: (url, method) => method === 'GET' && url.endsWith('/v1/workspaces/ws-1/plans'), respond: () => ({ status: 200, body: { items: [planDto] } }) },
      { match: url => url.includes('/plans/plan-1:confirm'), respond: () => ({ status: 200, body: { ...planDto, status: 'confirmed' } }) },
      { match: url => url.includes('/plans/plan-1'), respond: () => ({ status: 200, body: planDto }) },
    ])
    const host = new WorkspaceHost({ apiBaseUrl: 'http://service.test', session: session(), fetch: fetcher })

    const created = await host.createPlan({
      workspaceId: 'ws-1',
      goal: planDto.goal,
      steps: [{ title: '梳理现有用例' }, { title: '补充边界用例', dependsOn: [0] }],
      agentProfileVersionId: 'apv-1',
      assetVersionIds: ['skill:code-review@1.0.0'],
    })
    expect(created.status).toBe('ready')
    const createdPlan = created.status === 'ready' ? created.value : undefined
    expect(createdPlan?.status).toBe('draft')

    const listed = await host.workspacePlans('ws-1')
    expect(listed.status).toBe('ready')
    const listedPlans = listed.status === 'ready' ? listed.value : undefined
    expect(listedPlans?.length).toBe(1)

    const updated = await host.updatePlan({
      workspaceId: 'ws-1',
      planId: 'plan-1',
      goal: '新目标',
      steps: [{ title: '新步骤' }],
      changeSummary: '调整步骤',
      expectedRevision: 2,
    })
    expect(updated.status).toBe('ready')
    const updatedPlan = updated.status === 'ready' ? updated.value : undefined
    expect(updatedPlan?.edits).toHaveLength(1)

    const confirmed = await host.confirmPlan({ workspaceId: 'ws-1', planId: 'plan-1' })
    expect(confirmed.status).toBe('ready')
    const confirmedPlan = confirmed.status === 'ready' ? confirmed.value : undefined
    expect(confirmedPlan?.status).toBe('confirmed')

    // wire 断言：方法/路径/并发与幂等头。
    const createCall = calls.find(call => call.method === 'POST' && call.url.endsWith('/plans'))
    expect(createCall?.headers['idempotency-key']).toBeTruthy()
    expect(createCall?.body).toMatchObject({ goal: planDto.goal, agent_profile_version_id: 'apv-1' })
    const editCall = calls.find(call => call.method === 'PUT')
    expect(editCall?.url.endsWith('/v1/workspaces/ws-1/plans/plan-1')).toBe(true)
    expect(editCall?.headers['if-match']).toBe('2')
    expect(editCall?.headers['idempotency-key']).toBeTruthy()
    expect(editCall?.body).toMatchObject({ change_summary: '调整步骤' })
    const confirmCall = calls.find(call => call.url.includes(':confirm'))
    expect(confirmCall?.method).toBe('POST')
    expect(confirmCall?.headers['idempotency-key']).toBeTruthy()
  })

  it('服务失败映射为 failed 并保留稳定错误码（不把失败当成功）', async () => {
    const { fetcher } = stubFetch([
      {
        match: (url, method) => method === 'PUT' && url.includes('/plans/plan-1'),
        respond: () => ({ status: 409, body: { code: 'REVISION_CONFLICT', message: '计划已被其他编辑更新' } }),
      },
    ])
    const host = new WorkspaceHost({ apiBaseUrl: 'http://service.test', session: session(), fetch: fetcher })
    const result = await host.updatePlan({
      workspaceId: 'ws-1',
      planId: 'plan-1',
      goal: 'x',
      steps: [{ title: 's' }],
      changeSummary: '并发冲突',
      expectedRevision: 1,
    })
    expect(result.status).toBe('failed')
    if (result.status === 'failed') expect(result.code).toBe('REVISION_CONFLICT')
  })

  it('createRun 携带 plan_id，快照携带只读 planId', async () => {
    const { fetcher, calls } = stubFetch([
      { match: url => url.endsWith('/runs'), respond: () => ({ status: 202, body: runDto }) },
    ])
    const host = new WorkspaceHost({ apiBaseUrl: 'http://service.test', session: session(), fetch: fetcher })
    const result = await host.createRun({
      workspaceId: 'ws-1',
      sessionId: 'sess-1',
      writeMode: 'read_only',
      expectedWorkspaceRevision: 3,
      planId: 'plan-1',
    })
    expect(result.status).toBe('ready')
    const run = result.status === 'ready' ? result.value : undefined
    expect(run?.planId).toBe('plan-1')
    const runCall = calls.find(call => call.url.endsWith('/runs'))
    expect((runCall?.body as Record<string, unknown>)['plan_id']).toBe('plan-1')
  })
})

describe('WorkspaceHttpClient 计划路径', () => {
  it('请求走 /v1 契约前缀（base 归一化）', async () => {
    const { fetcher, calls } = stubFetch([
      { match: () => true, respond: () => ({ status: 200, body: { items: [planDto], next_cursor: null } }) },
    ])
    const client = new WorkspaceHttpClient('http://service.test', fetcher)
    const response = await client.request('/v1/workspaces/ws-1/plans', {}, 'plan-token')
    expect(response.fixtureOnly).toBe(true)
    expect(calls[0]?.url).toBe('http://service.test/v1/workspaces/ws-1/plans')
  })
})
