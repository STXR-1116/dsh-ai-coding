// @vitest-environment jsdom
/* oxlint-disable typescript/no-base-to-string -- Fetch 判定按 wire URL 断言（套件既有约定）。 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import React from 'react'
import { AdminDashboard } from '../src/components/admin-dashboard.tsx'

// 蓝图阶段 0（0-2）：后台 loadPage 不得再用空数组伪造 ready 渲染门。
// 判据：任一 PageId 在不发起治理读取时不得进入 ready；服务失败呈现失败而非空；
// cloud-* 页面接到真实数据行。本规格以「主读取失败 → 框架必须进入错误态
// （状态胶囊需要处理、页面标题不得渲染）」为判别性断言：伪造 ready 的旧实现下，
// 治理读取失败时胶囊仍是「已连接」，waitFor('需要处理') 必然超时。

vi.mock('next-auth/react', () => ({ signIn: vi.fn(), signOut: vi.fn() }))

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

function configure(fetcher: typeof fetch): void {
  vi.stubEnv('NEXT_PUBLIC_TEAM_SKILL_API_URL', 'http://service.test/v1')
  vi.stubEnv('NEXT_PUBLIC_TEAM_SKILL_ACCESS_TOKEN', 'admin-demo')
  vi.stubGlobal('fetch', fetcher)
}

const SESSION = { user: { id: 'admin-1', name: '平台管理员' }, role: 'admin' as const, mustChangePassword: false }

function response(value: unknown, status = 200): Response {
  return new Response(JSON.stringify({
    code: status >= 400 ? 'UPSTREAM_UNAVAILABLE' : 0,
    message: status >= 400 ? '下游依赖不可用' : 'ok',
    request_id: 'test-request',
    data: status >= 400 ? null : value,
  }), { status, headers: { 'content-type': 'application/json' } })
}

const project = {
  project_id: 'project-alpha',
  organization_id: 'org-alpha',
  organization_name: '星河 AI 平台',
  name: '协作台前端',
  description: '',
  status: 'active',
  created_by: 'admin-1',
  created_at: '2026-09-01T00:00:00.000Z',
  updated_at: '2026-09-01T00:00:00.000Z',
  revision: 1,
  member_count: 2,
  asset_count: 0,
}

const memory = {
  memory_id: 'm-1',
  team_id: 'team-alpha',
  project_id: 'project-alpha',
  content: 'Alpha uses strict TypeScript checks.',
  layer: 'L1',
  captured_by_user_id: 'member-1',
  created_at: '2026-09-02T00:00:00Z',
  updated_at: '2026-09-02T00:00:00Z',
  revision: 1,
  status: 'ACTIVE',
  importance: 0.8,
  recall_count: 0,
  last_recalled_at: null,
  source_kind: 'agent_turn',
}

const summaryBlock = {
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
}

const overviewPayload = {
  from: '2026-09-01T00:00:00.000Z',
  to: '2026-09-06T00:00:00.000Z',
  has_data: true,
  summary: summaryBlock,
  buckets: [],
  retention_days: 90,
}

const summaryPayload = {
  project_id: 'project-alpha',
  from: '2026-09-01T00:00:00.000Z',
  to: '2026-09-06T00:00:00.000Z',
  has_data: false,
  summary: summaryBlock,
  models: [],
  tools: [],
  delivery: summaryBlock.delivery,
  retention_days: 90,
}

const eventsPayload = {
  project_id: 'project-alpha',
  items: [],
  next_cursor: null,
  has_more: false,
  retention_days: 90,
}

const agentType = {
  agent_type_id: 'at-claude-code',
  key: 'claude-code',
  name: 'Claude Code 执行器',
  capabilities: ['read', 'write'],
  readiness: 'ready',
  schema_version: '1',
  schema: [
    { key: 'permission_mode', label: '权限模式', type: 'enum', required: true, affects_publish: true, description: null, enum: ['approval', 'auto'] },
  ],
}

const profile = {
  agent_profile_id: 'ap-1',
  organization_id: 'org-alpha',
  name: '默认研发代理',
  description: '默认执行配置',
  agent_type_id: 'at-claude-code',
  agent_type_name: 'Claude Code 执行器',
  agent_type_readiness: 'ready',
  skill_count: 1,
  knowledge_count: 0,
  memory_name: null,
  project_count: 1,
  status: 'published',
  readiness: 'ready',
  unavailable_reason: null,
  created_by: '平台管理员',
  created_at: '2026-09-01T00:00:00.000Z',
  updated_at: '2026-09-02T00:00:00.000Z',
  revision: 4,
  versions: [
    {
      agent_profile_version_id: 'apv-1',
      version: 'v1',
      status: 'published',
      model: 'deepseek-v3.2',
      reasoning: 'medium',
      asset_bindings: { skills: [{ asset_version_id: 'skill:code-review@1.0.0', required: true, order: 1 }], knowledge_bases: [], memory: null },
      asset_version_ids: ['skill:code-review@1.0.0'],
      execution_policy: { permission_mode: 'approval' },
      type_extension_config: { permission_mode: 'approval' },
      credential_ref: { name: 'deepseek-main', kind: 'api_key', authorized: true, readiness: 'ready' },
      change_summary: '首个版本',
      published_at: '2026-09-01T00:00:00.000Z',
      published_by: '平台管理员',
    },
  ],
  project_bindings: [
    { project_id: 'project-alpha', agent_profile_version_id: 'apv-1', default: true, revision: 1 },
  ],
}

const workspace = {
  workspace_id: 'ws-alpha-1',
  project_id: 'project-alpha',
  owner_user_id: 'member-1',
  repository_id: 'repo-1',
  branch: 'main',
  display_name: '云工作台主空间',
  default_agent_profile_version_id: 'apv-1',
  status: 'ready',
  revision: 7,
  last_error: null,
  created_at: '2026-09-01T00:00:00Z',
  updated_at: '2026-09-09T00:00:00Z',
}

const run = {
  run_id: 'run-op-1',
  project_id: 'project-alpha',
  workspace_id: 'ws-alpha-1',
  session_id: 'sess-9',
  agent_profile_version_id: 'apv-1',
  asset_version_ids: ['skill:code-review@1.0.0'],
  workspace_revision: 7,
  status: 'succeeded',
  write_mode: 'read_only',
  lease_id: null,
  revision: 4,
  error_code: null,
  created_at: '2026-09-09T00:00:00Z',
  updated_at: '2026-09-09T00:05:00Z',
}

const audit = {
  occurred_at: '2026-09-09T01:00:00Z',
  actor_user_id: 'member-1',
  actor_name: '演示成员',
  request_id: 'req-1',
  organization_id: 'org-alpha',
  project_id: 'project-alpha',
  workspace_id: 'ws-alpha-1',
  session_id: 'sess-1',
  run_id: null,
  agent_profile_id: null,
  agent_profile_version_id: null,
  asset_version_ids: null,
  revision: 8,
  action: 'workspace.stop',
  result: 'succeeded',
  error_code: null,
}

function makeFetcher(fail?: string): ReturnType<typeof vi.fn> {
  return vi.fn<typeof fetch>(async (input: Parameters<typeof fetch>[0]) => {
    const url = String(input)
    if (fail !== undefined && url.includes(fail)) return response({ code: 'UPSTREAM_UNAVAILABLE', message: '下游依赖不可用' }, 503)
    if (url.includes('/telemetry/summary')) return response(summaryPayload)
    if (url.includes('/telemetry/events')) return response(eventsPayload)
    if (url.includes('/admin/telemetry/overview')) return response(overviewPayload)
    if (url.includes('/project-memory/list')) return response({ items: [memory], next_cursor: null, total_estimate: 1 })
    if (url.includes('/admin/agent-profiles')) return response({ items: [profile] })
    if (url.includes('/admin/agent-types')) return response({ items: [agentType] })
    if (url.includes('/admin/workspaces')) return response({ items: [workspace] })
    if (url.includes('/admin/runs')) return response({ items: [run] })
    if (url.includes('/admin/audits')) return response([audit])
    if (url.includes('/admin/projects')) return response({ items: [project] })
    return response([])
  })
}

async function openFromModule(moduleName: RegExp, subnavLabel: string, pageName: string | RegExp): Promise<void> {
  fireEvent.click(screen.getByRole('button', { name: moduleName }))
  const nav = await screen.findByLabelText(subnavLabel)
  fireEvent.click(within(nav).getByRole('button', { name: pageName }))
}

type PageCase = {
  readonly label: string
  readonly heading: string
  readonly primary: string
  readonly open: () => Promise<void>
  /** 页面接到真实数据行时可见的代表性内容（undefined = 只断言标题与请求日志）。 */
  readonly marker?: string
}

const PAGE_CASES: readonly PageCase[] = [
  {
    label: 'memory-library',
    heading: '项目团队记忆库',
    primary: '/project-memory/list',
    open: async () => {
      fireEvent.click(await screen.findByRole('button', { name: /^记忆库/ }))
    },
    marker: 'Alpha uses strict TypeScript checks.',
  },
  {
    label: 'telemetry-overview',
    heading: '总览',
    primary: '/admin/telemetry/overview',
    open: async () => {
      await openFromModule(/^运行与审计/u, '运行与审计子导航', '总览')
    },
  },
  {
    label: 'telemetry-project',
    heading: '项目详情',
    primary: '/telemetry/summary',
    open: async () => {
      await openFromModule(/^运行与审计/u, '运行与审计子导航', '项目详情')
    },
  },
  {
    label: 'telemetry-events',
    heading: '事件诊断',
    primary: '/telemetry/events',
    open: async () => {
      await openFromModule(/^运行与审计/u, '运行与审计子导航', '事件诊断')
    },
  },
  {
    label: 'cloud-types',
    heading: 'Agent 类型',
    primary: '/admin/agent-types',
    open: async () => {
      await openFromModule(/^Agent 配置/u, 'Agent 配置子导航', /^Agent 类型/u)
    },
    marker: 'Claude Code 执行器',
  },
  {
    label: 'cloud-profiles',
    heading: 'Agent 配置',
    primary: '/admin/agent-profiles',
    open: async () => {
      await openFromModule(/^Agent 配置/u, 'Agent 配置子导航', /^Agent 配置/u)
    },
    marker: '默认研发代理',
  },
  {
    label: 'cloud-ops',
    heading: 'Workspace 运维',
    primary: '/admin/workspaces',
    open: async () => {
      await openFromModule(/^云工作空间运维/u, '云工作空间运维子导航', /^Workspace 运维/u)
    },
    marker: 'ws-alpha-1',
  },
  {
    label: 'cloud-runs',
    heading: 'Agent Run',
    primary: '/admin/runs',
    open: async () => {
      await openFromModule(/^云工作空间运维/u, '云工作空间运维子导航', 'Agent Run')
    },
    marker: 'run-op-1',
  },
  {
    label: 'cloud-audits',
    heading: '审计',
    primary: '/admin/audits',
    open: async () => {
      await openFromModule(/^运行与审计/u, '运行与审计子导航', '审计')
    },
    marker: '演示成员',
  },
]

describe('loadPage 真实读取门（0-2）', () => {
  for (const page of PAGE_CASES) {
    it(`${page.label}：主读取失败时框架呈现失败而非伪造 ready`, async () => {
      const fetcher = makeFetcher(page.primary)
      configure(fetcher)
      render(React.createElement(AdminDashboard, { session: SESSION }))

      await page.open()

      // 框架必须进入错误态：状态胶囊「需要处理」，而不是「已连接」下渲染页面。
      await waitFor(
        () => {
          expect(screen.getByText('需要处理')).toBeTruthy()
        },
        { timeout: 5_000 },
      )
      expect(screen.queryByText('已连接')).toBeNull()
      // 框架 ErrorState（role=alert）在渲染，页面级 h2 标题不在——模块级 h1 同名不受影响。
      expect(screen.getByRole('alert')).toBeTruthy()
      expect(screen.queryByRole('heading', { name: page.heading, level: 2 })).toBeNull()
      // 失败读取确实发生过（缺口的不是请求，而是旧实现把失败当成功）。
      await waitFor(
        () => {
          expect(fetcher.mock.calls.some(([url]) => String(url).includes(page.primary))).toBe(true)
        },
        { timeout: 5_000 },
      )
    })
  }

  for (const page of PAGE_CASES) {
    it(`${page.label}：读取成功（含空数据）时 ready，且真实数据行/治理读取可达`, async () => {
      const fetcher = makeFetcher()
      configure(fetcher)
      render(React.createElement(AdminDashboard, { session: SESSION }))

      await page.open()

      expect(await screen.findByRole('heading', { name: page.heading })).toBeTruthy()
      expect(screen.getByText('已连接')).toBeTruthy()
      // ready 前必须真的发起过该页的治理读取（旧实现对 9 个 PageId 零读取即 ready）。
      await waitFor(
        () => {
          expect(fetcher.mock.calls.some(([url]) => String(url).includes(page.primary))).toBe(true)
        },
        { timeout: 5_000 },
      )
      if (page.marker !== undefined) {
        expect(await screen.findByText(page.marker)).toBeTruthy()
      }
    })
  }
})
