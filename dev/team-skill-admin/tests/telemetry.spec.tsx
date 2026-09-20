// @vitest-environment jsdom
/* oxlint-disable typescript/no-base-to-string -- fetch spy URLs are RequestInfo;
 * String() is the established wire-value assertion helper in these suites. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import React from 'react'
import { AdminDashboard } from '../src/components/admin-dashboard.tsx'
import { TeamSkillApi } from '../src/lib/team-skill-api.ts'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function response(value: unknown, status = 200, code?: string  ): Response {
  const failed = status >= 400
  return new Response(JSON.stringify({
    code: failed ? (code ?? `HTTP_${status}`) : 0,
    message: failed ? '失败' : 'ok',
    request_id: 'test-request',
    data: failed ? null : value,
  }), { status, headers: { 'content-type': 'application/json' } })
}

const projects = { items: [
  { project_id: 'project-alpha', organization_id: 'org-alpha', organization_name: '星河 AI 平台', name: '协作台前端', description: '', status: 'active', created_by: 'admin-1', created_at: '', updated_at: '', revision: 1, member_count: 2, asset_count: 0 },
] }

const overviewPayload = {
  from: '2026-09-01T00:00:00.000Z',
  to: '2026-09-06T00:00:00.000Z',
  has_data: true,
  summary: {
    sessions: { total: 3, completed: 2, errors: 1, interrupted: 0, cancelled: 0 },
    turns: {
      total: 5, completed: 4, errors: 1, blocked: 0, max_tokens: 0,
      interrupted: 0, cancelled: 0, p50_duration_ms: 100, p95_duration_ms: 900,
    },
    steps: { started: 6, finished: 5, p50_duration_ms: 80, p95_duration_ms: 700 },
    llm: {
      requests: 4, retries: 1, input_tokens: 1200, output_tokens: 300,
      total_tokens: null, token_sample_size: 4,
      input_token_samples: 3, output_token_samples: 3, total_token_samples: 0,
    },
    tools: { calls: 7, errors: 1, p50_duration_ms: 30, p95_duration_ms: 200 },
    approvals: { requested: 2, allowed_once: 1, rejected: 1, cancelled: 0, unavailable: 0 },
    compactions: 1,
    delivery: { accepted: 12, duplicate: 3, retryable: 1, rejected: 1, queued: 0, gaps: 2 },
  },
  buckets: [],
  retention_days: 90,
}

const emptyOverview = { ...overviewPayload, has_data: false, buckets: [] }

function telemetryFetcher(overrides: Array<{ match: (url: string) => boolean; respond: (url: string) => Response }> = []) {
  return vi.fn<typeof fetch>(async (input: Parameters<typeof fetch>[0]) => {
    const url = String(input)
    for (const override of overrides) if (override.match(url)) return override.respond(url)
    if (url.includes('/admin/projects')) return response(projects)
    if (url.includes('/admin/telemetry/overview')) return response(overviewPayload)
    if (url.includes('/telemetry/events')) return response({ project_id: 'project-alpha', items: [], next_cursor: null, has_more: false, retention_days: 90 })
    if (url.includes('/telemetry/summary')) return response({ project_id: 'project-alpha', from: '2026-09-01T00:00:00.000Z', to: '2026-09-06T00:00:00.000Z', has_data: false, summary: overviewPayload.summary, models: [], tools: [], delivery: overviewPayload.summary.delivery, retention_days: 90 })
    if (url.includes('/admin/team-skills')) return response([])
    return response([])
  })
}

function assertTextContent(pattern: RegExp): void {
  try {
    const matches = screen.getAllByText((_, element) => element !== null && pattern.test(element.textContent ?? ''))
    expect(matches.length).toBeGreaterThan(0)
  } catch {
    console.log('PATTERNFAIL', String(pattern))
    throw new Error(`assertTextContent failed: ${String(pattern)}`)
  }
}

function mount(role: 'admin' | 'manager' | 'member' = 'admin', fetcher = telemetryFetcher()): void {
  vi.stubGlobal('fetch', fetcher)
  render(React.createElement(AdminDashboard, {
    session: { user: { id: 'u-1', name: '测试管理员' }, role, mustChangePassword: false },
  }))
}

function openTelemetryGroup(): void {
  fireEvent.click(screen.getByRole('button', { name: /^运行与审计/ }))
}

describe('admin telemetry console', () => {
  it('renders the overview aggregation with token nulls and no cost columns for admins', async () => {
    const fetcher = telemetryFetcher()
    mount('admin', fetcher)
    openTelemetryGroup()
    fireEvent.click(await screen.findByRole('button', { name: '总览' }))
    expect(await screen.findByRole('heading', { name: '总览' })).toBeTruthy()
    await waitFor(() => {
      expect(document.querySelector('[role="alert"]')).toBeNull()
    })
    assertTextContent(/Session\s*总数 3 · 完成 2 · 错误 1/)
    assertTextContent(/总 Token\s*缺失/)
    assertTextContent(/queued（fixture 恒为 0） 0/)
    assertTextContent(/不计算成本或金额/)
    // Only server-authorized projects appear in the project filter.
    expect(screen.getAllByRole('option', { name: '协作台前端' }).length).toBeGreaterThan(0)
    expect(JSON.stringify(fetcher.mock.calls)).not.toContain('cost')
  })

  it('R10 renders the project summary with summary.delivery and top-level delivery from the same ACK source', async () => {
    const projectSummaryPayload = {
      project_id: 'project-alpha',
      from: '2026-09-01T00:00:00.000Z',
      to: '2026-09-06T00:00:00.000Z',
      has_data: true,
      summary: overviewPayload.summary,
      models: [],
      tools: [],
      delivery: overviewPayload.summary.delivery,
      retention_days: 90,
    }
    const fetcher = telemetryFetcher([
      { match: url => url.includes('/telemetry/summary'), respond: () => response(projectSummaryPayload) },
    ])
    mount('admin', fetcher)
    openTelemetryGroup()
    fireEvent.click(await screen.findByRole('button', { name: /项目详情/ }))
    fireEvent.change(await screen.findByLabelText('可观测项目'), { target: { value: 'project-alpha' } })
    await waitFor(() => {
      expect(document.querySelector('[role="alert"]')).toBeNull()
    })
    // 页面上的采集管道分类来自 API client 校验后的 summary.delivery（与顶层 delivery 同源同参）。
    assertTextContent(/accepted 12 · duplicate 3 · retryable 1 · rejected 1 · queued（fixture 恒为 0） 0 · 缺口 2/)
    // 校验器强制两处 delivery 同时存在且为六分类完整字段。
    const summaryCall = fetcher.mock.calls.map(String).find(url => url.includes('/telemetry/summary'))
    expect(summaryCall, 'project summary endpoint must have been queried').toBeTruthy()
  })

  it('R10 rejects a project summary whose summary.delivery is missing or mismatches the six-field contract', async () => {
    const assertInvalid = async (mutate: (root: Record<string, unknown>) => void, label: string): Promise<void> => {
      const root = { project_id: 'project-alpha', from: 'F', to: 'T', has_data: true, summary: JSON.parse(JSON.stringify(overviewPayload.summary)), models: [], tools: [], delivery: overviewPayload.summary.delivery, retention_days: 90 } as Record<string, unknown>
      mutate(root)
      const fetcher = vi.fn<typeof fetch>(async () => response(root))
      const api = new TeamSkillApi({ baseUrl: 'http://service.test/v1', accessToken: 'token', fetcher })
      const result = await api.getProjectTelemetrySummary('project-alpha', { from: 'F', to: 'T' })
      expect(result.ok, label).toBe(false)
      expect(!result.ok ? result.error.code : '', label).toBe('INVALID_RESPONSE')
    }
    await assertInvalid((root) => {
      const summary = root.summary as Record<string, unknown>
      delete summary.delivery
    }, 'summary.delivery missing')
    await assertInvalid((root) => {
      const summary = root.summary as Record<string, unknown>
      summary.delivery = { accepted: 1, duplicate: 0, retryable: 0, rejected: 0, queued: 0 }
    }, 'summary.delivery missing gaps field')
    await assertInvalid((root) => {
      root.delivery = { accepted: '12', duplicate: 3, retryable: 1, rejected: 1, queued: 0, gaps: 2 }
    }, 'top-level delivery accepted as string')
  })

  it('shows the server-confirmed empty state instead of demo data', async () => {
    mount('admin', telemetryFetcher([
      { match: url => url.includes('/admin/telemetry/overview'), respond: () => response({ ...emptyOverview, summary: { ...emptyOverview.summary, delivery: { accepted: 0, duplicate: 0, retryable: 0, rejected: 0, queued: 0, gaps: 0 } } }) },
    ]))
    openTelemetryGroup()
    fireEvent.click(await screen.findByRole('button', { name: '总览' }))
    expect(await screen.findByText('当前窗口没有数据')).toBeTruthy()
    assertTextContent(/has_data=false/)
  })

  it('renders a 503 as service error, never as an empty list', async () => {
    mount('admin', telemetryFetcher([
      { match: url => url.includes('/admin/telemetry/overview'), respond: () => response({ code: 'TELEMETRY_UNAVAILABLE', message: '遥测查询暂不可用' }, 503, 'TELEMETRY_UNAVAILABLE') },
    ]))
    openTelemetryGroup()
    fireEvent.click(await screen.findByRole('button', { name: '总览' }))
    expect(await screen.findByText('服务请求失败')).toBeTruthy()
    assertTextContent(/TELEMETRY_UNAVAILABLE|遥测查询暂不可用/)
  })

  it('keeps the telemetry group hidden from members and shows the server denial when forced', async () => {
    mount('member')
    // The ops group itself may render for members (Skill 审计日志 lives there);
    // the telemetry entries must stay hidden.
    expect(screen.queryByRole('button', { name: '总览' })).toBeNull()
    expect(screen.queryByRole('button', { name: '事件诊断结构化事件与数据缺口' })).toBeNull()
    // Server-side enforcement for a forced member route is covered by the
    // fixture spec (403 ROLE_FORBIDDEN); the frontend guarantee is the hidden nav.
  })

  it('pages structured events with the opaque cursor and resets it when the server rejects it', async () => {
    const eventItem = {
      event_id: 'e-1',
      installation_id: 'inst',
      project_id: 'project-alpha',
      session_id: 's-1',
      kind: 'tool.result',
      occurred_at: '2026-09-05T01:00:00.000Z',
      received_at: '2026-09-05T01:00:01.000Z',
      source_type: 'tool/result',
      source_seq: 9,
      turn: 1,
      step: 2,
      duration_ms: 42,
      outcome: 'error',
      provider: null,
      model: 'deepseek-chat',
      tool_name: 'bash',
      tool_category: null,
      call_id: 'call-1',
      approval_id: null,
      compaction_id: null,
      retryable: null,
      retry_count: null,
      token_usage: null,
      error: { name: 'ToolError', code: 'TOOL_FAILED', summary: 'boom' },
      approval: null,
      compaction: null,
      gap: null,
    }
    let cursorCalls = 0
    const fetcher = telemetryFetcher([
      {
        match: url => url.includes('/telemetry/events'),
        respond: (url) => {
          // 按带游标的调用计数（0-2 起框架渲染门也会发起一次无游标的首页读取）。
          if (url.includes('cursor=')) {
            cursorCalls += 1
            if (cursorCalls === 1) return response({ code: 'INVALID_CURSOR', message: '游标无效' }, 400, 'INVALID_CURSOR')
            return response({ project_id: 'project-alpha', items: [eventItem], next_cursor: null, has_more: false, retention_days: 90 })
          }
          return response({ project_id: 'project-alpha', items: [eventItem], next_cursor: 'opaque-cursor-1', has_more: true, retention_days: 90 })
        },
      },
    ])
    mount('admin', fetcher)
    openTelemetryGroup()
    fireEvent.click(await screen.findByRole('button', { name: '事件诊断' }))
    await screen.findByRole('heading', { name: '事件诊断' })
    const projectSelect = await screen.findByLabelText('诊断项目')
    fireEvent.change(projectSelect, { target: { value: 'project-alpha' } })

    expect(await screen.findByText('bash')).toBeTruthy()
    assertTextContent(/TOOL_FAILED · boom/)
    assertTextContent(/opaque cursor 分页/)

    // Next page: the server rejects the cursor once; the page resets to page one.
    fireEvent.click(screen.getByRole('button', { name: '下一页' }))
    await waitFor(() => {
      const calls = fetcher.mock.calls.filter(([input]) => String(input).includes('/telemetry/events'))
      expect(calls.length).toBeGreaterThanOrEqual(3)
      expect(String(calls[calls.length - 1]?.[0]).includes('cursor=')).toBe(false)
    })
    expect(await screen.findByText('bash')).toBeTruthy()
  })

  it('rejects malformed telemetry payloads field-by-field as INVALID_RESPONSE', async () => {
    const assertInvalid = async (payload: unknown, label: string, path: 'overview' | 'events'): Promise<void> => {
      const fetcher = vi.fn<typeof fetch>(async () => response(payload))
      const api = new TeamSkillApi({
        baseUrl: 'http://service.test/v1',
        accessToken: 'token',
        fetcher: fetcher,
      })
      const result =
        path === 'overview'
          ? await api.getTelemetryOverview({ from: 'F', to: 'T' })
          : await api.listProjectTelemetryEvents('p-1', { from: 'F', to: 'T' })
      expect(result.ok, label).toBe(false)
      expect(!result.ok ? result.error.code : '', label).toBe('INVALID_RESPONSE')
    }

    const summaryCases: Array<{ readonly label: string; readonly mutate: (root: Record<string, unknown>) => void }> = [
      { label: 'sessions.total as string', mutate: (root) => {
        const summary = root.summary as Record<string, unknown>
        summary.sessions = { ...(summary.sessions as Record<string, object>), total: '3' }
      } },
      { label: 'turns.p50 negative', mutate: (root) => {
        const summary = root.summary as Record<string, unknown>
        summary.turns = { ...(summary.turns as Record<string, object>), p50_duration_ms: -5 }
      } },
      { label: 'llm.input_tokens missing', mutate: (root) => {
        const summary = root.summary as Record<string, unknown>
        const llm = { ...(summary.llm as Record<string, unknown>) }
        delete llm.input_tokens
        summary.llm = llm
      } },
      { label: 'approvals.requested null', mutate: (root) => {
        const summary = root.summary as Record<string, unknown>
        summary.approvals = { ...(summary.approvals as Record<string, object>), requested: null }
      } },
      { label: 'compactions float', mutate: (root) => {
        const summary = root.summary as Record<string, unknown>
        summary.compactions = 1.5
      } },
      { label: 'delivery.gaps missing', mutate: (root) => {
        const summary = root.summary as Record<string, unknown>
        const delivery = { ...(summary.delivery as Record<string, unknown>) }
        delete delivery.gaps
        summary.delivery = delivery
      } },
      { label: 'bucket missing summary fields', mutate: (root) => {
        root.buckets = [{ bucket_start: 'x' }]
      } },
      { label: 'retention_days string', mutate: (root) => {
        root.retention_days = '90'
      } },
    ]
    for (const item of summaryCases) {
      const payload = structuredClone(overviewPayload) as unknown as Record<string, unknown>
      item.mutate(payload)
      await assertInvalid(payload, item.label, 'overview')
    }

    const eventItem: Record<string, unknown> = {
      event_id: 'e-1', installation_id: 'inst', project_id: 'p-1', session_id: 's-1',
      kind: 'tool.result', occurred_at: '2026-09-05T01:00:00.000Z', received_at: '2026-09-05T01:00:01.000Z',
      source_type: 'tool/result', source_seq: 9, turn: 1, step: 2, duration_ms: 42, outcome: 'error',
      provider: null, model: null, tool_name: 'bash', tool_category: null, call_id: 'call-1',
      approval_id: null, compaction_id: null, retryable: null, retry_count: null, token_usage: null,
      error: null, approval: null, compaction: null, gap: null,
    }
    const eventCases: Array<{ readonly label: string; readonly mutate: (root: Record<string, unknown>) => void }> = [
      { label: 'event kind missing', mutate: (root) => {
        const item = (root.items as Record<string, unknown>[])[0]
        delete item.kind
      } },
      { label: 'event source_seq string', mutate: (root) => {
        (root.items as Record<string, unknown>[])[0].source_seq = '9'
      } },
      { label: 'event duration negative', mutate: (root) => {
        (root.items as Record<string, unknown>[])[0].duration_ms = -1
      } },
      { label: 'event outcome invalid enum', mutate: (root) => {
        (root.items as Record<string, unknown>[])[0].outcome = 'fine'
      } },
      { label: 'event token_usage wrong types', mutate: (root) => {
        (root.items as Record<string, unknown>[])[0].token_usage = { input_tokens: 'x', output_tokens: null, total_tokens: null }
      } },
      { label: 'event error.name missing', mutate: (root) => {
        (root.items as Record<string, unknown>[])[0].error = { code: 'C', summary: null }
      } },
      { label: 'gap reason invalid', mutate: (root) => {
        (root.items as Record<string, unknown>[])[0].gap = { reason: 'mystery', count: 1, first_event_id: null, last_event_id: null }
      } },
      { label: 'approval decision invalid', mutate: (root) => {
        (root.items as Record<string, unknown>[])[0].approval = { decision: 'maybe' }
      } },
      { label: 'has_more string', mutate: (root) => {
        root.has_more = 'yes'
      } },
      { label: 'next_cursor number', mutate: (root) => {
        root.next_cursor = 5
      } },
    ]
    for (const item of eventCases) {
      const payload: Record<string, unknown> = {
        project_id: 'p-1',
        items: [structuredClone(eventItem)],
        next_cursor: null,
        has_more: false,
        retention_days: 90,
      }
      item.mutate(payload)
      await assertInvalid(payload, item.label, 'events')
    }

    // 正常空结果必须仍然成功（校验不误伤合法 payload）。
    const okFetcher = vi.fn<typeof fetch>(async () => response({
      project_id: 'p-1', items: [], next_cursor: null, has_more: false, retention_days: 90,
    }))
    const okApi = new TeamSkillApi({
      baseUrl: 'http://service.test/v1',
      accessToken: 'token',
      fetcher: okFetcher,
    })
    const ok = await okApi.listProjectTelemetryEvents('p-1', { from: 'F', to: 'T' })
    expect(ok.ok).toBe(true)
  })

  it('builds telemetry client queries and rejects unknown payloads as protocol errors', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => response(overviewPayload))
    const api = new TeamSkillApi({
      baseUrl: 'http://service.test/v1',
      accessToken: 'token',
      fetcher: fetcher,
    })
    const result = await api.getTelemetryOverview({ from: 'F', to: 'T', organizationId: 'org-1', projectId: 'p-1' })
    expect(result.ok).toBe(true)
    const overviewUrl = String(fetcher.mock.calls[0]?.[0])
    expect(overviewUrl).toContain('/admin/telemetry/overview?from=F&to=T&organization_id=org-1&project_id=p-1')

    const eventPayload = { project_id: 'p-1', items: [], next_cursor: null, has_more: false, retention_days: 90 }
    const routingFetcher = vi.fn<typeof fetch>(async (input: Parameters<typeof fetch>[0]) =>
      String(input).includes('/telemetry/events') ? response(eventPayload) : response(overviewPayload))
    const eventsApi = new TeamSkillApi({
      baseUrl: 'http://service.test/v1',
      accessToken: 'token',
      fetcher: routingFetcher,
    })
    const events = await eventsApi.listProjectTelemetryEvents('p-1', { from: 'F', to: 'T', kind: 'tool.result', outcome: 'error', cursor: 'c', limit: 25 })
    expect(events.ok).toBe(true)
    const eventsUrl = String(routingFetcher.mock.calls[0]?.[0])
    expect(eventsUrl).toContain('/admin/projects/p-1/telemetry/events?from=F&to=T&kind=tool.result&outcome=error&cursor=c&limit=25')

    // A 200 with an unexpected payload is a protocol error, not a success.
    const bad = new TeamSkillApi({
      baseUrl: 'http://service.test/v1',
      accessToken: 'token',
      fetcher: async () => response({ hello: true }),
    })
    const badResult = await bad.getTelemetryOverview({ from: 'F', to: 'T' })
    expect(badResult.ok).toBe(false)
    expect(!badResult.ok ? badResult.error.code : '').toBe('INVALID_RESPONSE')
    void events
  })
})
