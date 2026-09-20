// @vitest-environment jsdom
/* oxlint-disable typescript/no-base-to-string -- Fetch spy assertions inspect RequestInfo wire values. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import React from 'react'
import { AdminDashboard } from '../src/components/admin-dashboard.tsx'
import { TeamSkillApi } from '../src/lib/team-skill-api.ts'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

function response(value: unknown, status = 200): Response {
  const record = typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
  const data = status < 400 && record !== undefined && Object.hasOwn(record, 'data') ? record.data : value
  return new Response(JSON.stringify({
    code: status >= 400 ? (typeof record?.code === 'string' ? record.code : `HTTP_${status}`) : 0,
    message: status >= 400 ? (typeof record?.message === 'string' ? record.message : 'failed') : 'ok',
    request_id: 'test-request',
    data: status >= 400 ? null : data,
  }), { status, headers: { 'content-type': 'application/json' } })
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
    {
      agent_profile_version_id: 'apv-2',
      version: 'v2',
      status: 'draft',
      model: 'deepseek-v3.2',
      reasoning: 'high',
      asset_bindings: { skills: [{ asset_version_id: 'skill:code-review@1.0.0', required: true, order: 1 }], knowledge_bases: [], memory: null },
      asset_version_ids: ['skill:code-review@1.0.0'],
      execution_policy: { permission_mode: 'approval' },
      type_extension_config: { permission_mode: 'approval' },
      credential_ref: null,
      change_summary: '提高推理档位',
    },
  ],
  project_bindings: [
    { project_id: 'project-alpha', agent_profile_version_id: 'apv-1', default: true, revision: 1 },
  ],
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

const candidates = [
  {
    asset_id: 'skill:code-review@1.0.0',
    asset_type: 'skill',
    version: '1.0.0',
    name: '代码评审 Skill',
    authorized: true,
    readiness: 'ready',
    invalid_reason: null, updated_at: '2026-09-01T00:00:00.000Z',
  },
  {
    asset_id: 'knowledge:k-3@v1',
    asset_type: 'knowledge',
    version: 'v1',
    name: '知识库 k-3（旧版文档）',
    authorized: true,
    readiness: 'unavailable',
    invalid_reason: '知识库已下线', updated_at: '2026-07-01T00:00:00.000Z',
  },
  {
    asset_id: 'memory:m-9@v1',
    asset_type: 'memory',
    version: 'v1',
    name: '记忆库 m-9（未授权）',
    authorized: false,
    readiness: 'unavailable',
    invalid_reason: '资产未授权给该项目', updated_at: '2026-09-01T00:00:00.000Z',
  },
]

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

function configure(fetcher: typeof fetch): void {
  vi.stubEnv('NEXT_PUBLIC_TEAM_SKILL_API_URL', 'http://service.test/v1')
  vi.stubEnv('NEXT_PUBLIC_TEAM_SKILL_ACCESS_TOKEN', 'admin-demo')
  vi.stubGlobal('fetch', fetcher)
}

const SESSION = { user: { id: 'admin-1', name: '平台管理员' }, role: 'admin' as const, mustChangePassword: false }

function routeFor(url: string): string {
  return url.replace(/^https?:\/\/service\.test/u, '').replace(/^\/api\/team-skill/u, '')
}

describe('cloud workspace admin API', () => {
  it('sends If-Match and Idempotency-Key when publishing a profile version', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => response({ agent_profile_version_id: 'apv-2', status: 'published' }))
    const api = new TeamSkillApi({ baseUrl: 'https://service.test/v1', accessToken: 'token', fetcher })
    const result = await api.publishCloudAgentProfileVersion('ap-1', 'apv-2', 4, 'idem-publish-1')
    expect(result.ok).toBe(true)
    const [input, init] = fetcher.mock.calls[0]
    expect(routeFor(String(input))).toBe('/v1/admin/agent-profiles/ap-1/versions/apv-2:publish')
    expect(init?.method).toBe('POST')
    expect(new Headers(init?.headers).get('If-Match')).toBe('4')
    expect(new Headers(init?.headers).get('Idempotency-Key')).toBe('idem-publish-1')
  })

  it('maps a workspace stop revision conflict to a stable business error', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => response({ code: 'REVISION_CONFLICT', message: '工作空间已被其他修改更新' }, 409))
    const api = new TeamSkillApi({ baseUrl: 'https://service.test/v1', accessToken: 'token', fetcher })
    expect(await api.stopCloudWorkspace('ws-alpha-1', 7, 'idem-stop-1')).toEqual({
      ok: false,
      error: { kind: 'revision-conflict', code: 'REVISION_CONFLICT', message: '工作空间已被其他修改更新' },
      // 云工作空间结果必须携带服务端证据（响应头 / request_id / HTTP 状态）。
      evidence: { fixtureOnly: false, requestId: 'test-request', status: 409 },
    })
    const [, init] = fetcher.mock.calls[0]
    expect(JSON.parse(init?.body as string)).toMatchObject({ expected_workspace_revision: 7 })
  })

  it('rejects audit rows without a literal non-empty actor_name', async () => {
    const missing = { ...audit } as Record<string, unknown>
    delete missing.actor_name
    const api = new TeamSkillApi({
      baseUrl: 'https://service.test/v1',
      accessToken: 'token',
      fetcher: async () => response([missing]),
    })
    await expect(api.cloudAudits({ workspaceId: 'ws-alpha-1' })).resolves.toMatchObject({
      ok: false,
      error: { code: 'INVALID_RESPONSE' },
    })
  })

  it('serves filtered workspace audit rows', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => response([audit]))
    const api = new TeamSkillApi({ baseUrl: 'https://service.test/v1', accessToken: 'token', fetcher })
    const result = await api.cloudAudits({ workspaceId: 'ws-alpha-1', action: 'workspace.stop' })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value[0].actor_name).toBe('演示成员')
    expect(routeFor(String(fetcher.mock.calls[0][0]))).toBe('/v1/admin/audits?workspace_id=ws-alpha-1&action=workspace.stop')
  })
})

describe('cloud workspace admin pages', () => {
  it('opens the cloud workspace group and lists agent profiles with publish actions', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => response({ items: [profile] }))
    configure(fetcher)
    render(React.createElement(AdminDashboard, { session: SESSION }))

    vi.stubGlobal('confirm', vi.fn(() => true))
    fireEvent.click(screen.getByRole('button', { name: /^Agent 配置/ }))
    const workspaceNav = await screen.findByLabelText('Agent 配置子导航')
    fireEvent.click(within(workspaceNav).getByRole('button', { name: /^Agent 配置/u }))
    expect(await screen.findByText(/ap-1/u)).toBeTruthy()
    expect(screen.getAllByText(/apv-2/).length).toBeGreaterThan(0)

    const publishButtons = screen.getAllByRole('button', { name: /发布版本/u })
    const draftPublish = publishButtons.find(button => (button.getAttribute('data-version') ?? '') === 'apv-2')
    expect(draftPublish).toBeDefined()
    fireEvent.click(draftPublish as HTMLElement)
    await waitFor(() => {
      const publishCall = fetcher.mock.calls.find(([input]) => String(input).includes(':publish'))
      expect(publishCall).toBeDefined()
    })
    const [input, init] = fetcher.mock.calls.find(([input]) => String(input).includes(':publish')) as [
      RequestInfo | URL,
      RequestInit | undefined,
    ]
    expect(String(input)).toContain('/admin/agent-profiles/ap-1/versions/apv-2:publish')
    expect(new Headers(init?.headers).get('If-Match')).toBe('4')
    expect(new Headers(init?.headers).get('Idempotency-Key')).toBeTruthy()
  })

  it('lists workspaces and stops one with the current revision', async () => {
    const fetcher = vi.fn<typeof fetch>(async (_input, init) => {
      if (init?.method === 'POST') return response({ ...workspace, status: 'stopped', revision: 8 })
      return response({ items: [workspace] })
    })
    configure(fetcher)
    vi.stubGlobal('confirm', vi.fn(() => true))
    render(React.createElement(AdminDashboard, { session: SESSION }))

    fireEvent.click(screen.getByRole('button', { name: /^云工作空间运维/ }))
    const opsNav = await screen.findByLabelText('云工作空间运维子导航')
    fireEvent.click(within(opsNav).getByRole('button', { name: /^Workspace 运维/u }))
    expect(await screen.findByText('ws-alpha-1')).toBeTruthy()
    fireEvent.click(await screen.findByRole('button', { name: /停止/u }))
    await waitFor(() => {
      const stopCall = fetcher.mock.calls.find(([input]) => String(input).includes(':stop'))
      expect(stopCall).toBeDefined()
    })
    const [input, init] = fetcher.mock.calls.find(([input]) => String(input).includes(':stop')) as [
      RequestInfo | URL,
      RequestInit | undefined,
    ]
    expect(String(input)).toContain('/admin/workspaces/ws-alpha-1:stop')
    expect(JSON.parse(init?.body as string)).toMatchObject({ expected_workspace_revision: 7 })
    expect(new Headers(init?.headers).get('Idempotency-Key')).toBeTruthy()
  })

  it('creates a draft agent profile and a new draft version from the admin page', async () => {
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const url = routeFor(String(input))
      if (url.includes('/admin/agent-types')) return response({ items: [agentType] })
      if (url.includes('/admin/asset-candidates')) return response({ items: candidates })
      if (init?.method === 'POST' && url.endsWith('/versions')) return response({ agent_profile_version_id: 'apv-3', version: 'v3', status: 'draft' })
      if (init?.method === 'POST') return response({ agent_profile_id: 'ap-2', status: 'draft' })
      return response({ items: [profile] })
    })
    configure(fetcher)
    render(React.createElement(AdminDashboard, { session: SESSION }))

    fireEvent.click(screen.getByRole('button', { name: /^Agent 配置/ }))
    const workspaceNav = await screen.findByLabelText('Agent 配置子导航')
    fireEvent.click(within(workspaceNav).getByRole('button', { name: /^Agent 配置/u }))
    await screen.findByText(/ap-1/u)
    // 资产候选展示名称与 readiness/失效原因；不可用资产在两类选择器里都不可选。
    expect((await screen.findAllByText(/知识库 k-3/u, {}, { timeout: 5_000 })).length).toBeGreaterThanOrEqual(1)
    const blockedChip = screen.getAllByRole('button', { name: '资产-知识库 k-3（旧版文档）' })[0] as HTMLButtonElement
    expect(blockedChip.disabled).toBe(true)
    expect(screen.getAllByText(/知识库已下线/u).length).toBeGreaterThanOrEqual(1)
    const memorySelect = screen.getAllByLabelText('资产-记忆库')[0] as HTMLSelectElement
    const unauthorizedOption = [...memorySelect.options].find(option => option.textContent?.includes('记忆库 m-9（未授权）'))
    expect(unauthorizedOption).toBeDefined()
    expect(unauthorizedOption?.disabled).toBe(true)

    fireEvent.change(screen.getByLabelText('创建配置名称'), { target: { value: '审计代理' } })
    fireEvent.change(screen.getByLabelText('创建 Agent 类型'), { target: { value: 'at-claude-code' } })
    fireEvent.click(screen.getAllByRole('checkbox', { name: '资产-代码评审 Skill' })[0])
    fireEvent.click(screen.getByRole('button', { name: /创建草稿/u }))
    await waitFor(() => {
      const createCall = fetcher.mock.calls.find(([input, init]) => String(input).endsWith('/admin/agent-profiles') && init?.method === 'POST')
      expect(createCall).toBeDefined()
    })
    const createCall = fetcher.mock.calls.find(([input, init]) => String(input).endsWith('/admin/agent-profiles') && init?.method === 'POST') as [RequestInfo | URL, RequestInit | undefined]
    const createInit = createCall?.[1]
    expect(JSON.parse(String(createInit?.body ?? '{}'))).toMatchObject({
      name: '审计代理',
      agent_type_id: 'at-claude-code',
      asset_bindings: { skills: [{ asset_version_id: 'skill:code-review@1.0.0', required: true, order: 1 }] },
    })
    expect(new Headers(createInit?.headers).get('Idempotency-Key')).toBeTruthy()

    // 创建新版本先展开字段表单，提交时携带明确选择的字段。
    const versionButtons = screen.getAllByRole('button', { name: /创建新版本/u })
    fireEvent.click(versionButtons[0])
    const summary = await screen.findByLabelText('新版本摘要-ap-1')
    fireEvent.change(summary, { target: { value: '补充审计字段' } })
    fireEvent.click(screen.getAllByRole('button', { name: /提交新版本/u })[0])
    await waitFor(() => {
      expect(fetcher.mock.calls.some(([input]) => String(input).includes('/versions'))).toBe(true)
    })
    const versionCall = fetcher.mock.calls.find(([input]) => String(input).includes('/versions')) as [RequestInfo | URL, RequestInit | undefined]
    expect(JSON.parse(String(versionCall[1]?.body ?? '{}'))).toMatchObject({
      change_summary: '补充审计字段',
      asset_bindings: { skills: [{ asset_version_id: 'skill:code-review@1.0.0', required: true }] },
    })
    // 新版本提交携带读取时的 profile revision（If-Match）。
    expect(new Headers(versionCall[1]?.headers).get('If-Match')).toBe('4')
  }, 20_000)

  it('edits the latest draft in place and refuses to mutate published profiles', async () => {
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const url = routeFor(String(input))
      if (url.includes('/admin/agent-types')) return response({ items: [agentType] })
      if (url.includes('/admin/asset-candidates')) return response({ items: candidates })
      if (init?.method === 'PUT') return response({ agent_profile_id: 'ap-1', revision: 5 })
      return response({ items: [profile] })
    })
    configure(fetcher)
    render(React.createElement(AdminDashboard, { session: SESSION }))
    fireEvent.click(screen.getByRole('button', { name: /^Agent 配置/ }))
    const workspaceNav = await screen.findByLabelText('Agent 配置子导航')
    fireEvent.click(within(workspaceNav).getByRole('button', { name: /^Agent 配置/u }))
    await screen.findByText(/ap-1/u, {}, { timeout: 5_000 })

    // 草稿可原地编辑：修改模型并保存 → PUT 携带 If-Match revision。
    const editor = within(screen.getByLabelText('编辑草稿-ap-1'))
    const modelInput = editor.getByLabelText('配置模型')
    fireEvent.change(modelInput, { target: { value: 'deepseek-v3.5' } })
    fireEvent.click(screen.getByLabelText('保存草稿-ap-1'))
    await waitFor(() => {
      expect(fetcher.mock.calls.some(([input, init]) => String(input).includes('/admin/agent-profiles/ap-1') && init?.method === 'PUT')).toBe(true)
    })
    const putCall = fetcher.mock.calls.find(([input, init]) => String(input).includes('/admin/agent-profiles/ap-1') && init?.method === 'PUT') as [RequestInfo | URL, RequestInit | undefined]
    expect(JSON.parse(String(putCall[1]?.body ?? '{}'))).toMatchObject({ model: 'deepseek-v3.5' })
    expect(new Headers(putCall[1]?.headers).get('If-Match')).toBe('4')

    // 最新版本是 draft 时提供编辑区；发布后由服务端 409 拒绝原地修改。
    expect(screen.getByLabelText('编辑草稿-ap-1')).toBeTruthy()
  }, 20_000)

  it('binds a published version as project default and unbinds it', async () => {
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const url = routeFor(String(input))
      if (url.includes('/admin/agent-types')) return response({ items: [agentType] })
      if (url.includes('/admin/asset-candidates')) return response({ items: candidates })
      if (init?.method === 'PUT' && url.includes('/project-bindings')) return response({ project_id: 'project-alpha', default: true })
      if (init?.method === 'DELETE') return response({ project_id: 'project-alpha' })
      return response({ items: [profile] })
    })
    configure(fetcher)
    vi.stubGlobal('confirm', vi.fn(() => true))
    render(React.createElement(AdminDashboard, { session: SESSION }))
    fireEvent.click(screen.getByRole('button', { name: /^Agent 配置/ }))
    const workspaceNav = await screen.findByLabelText('Agent 配置子导航')
    fireEvent.click(within(workspaceNav).getByRole('button', { name: /^Agent 配置/u }))
    await screen.findByText(/ap-1/u, {}, { timeout: 5_000 })

    fireEvent.click(screen.getByLabelText('设为默认-默认研发代理'))
    await waitFor(() => {
      const call = fetcher.mock.calls.find(([input, init]) => String(input).includes('/project-bindings') && init?.method === 'PUT')
      expect(call).toBeDefined()
    })
    const defaultCall = fetcher.mock.calls.find(([input, init]) => String(input).includes('/project-bindings') && init?.method === 'PUT') as [RequestInfo | URL, RequestInit | undefined]
    expect(JSON.parse(String(defaultCall[1]?.body ?? '{}'))).toMatchObject({ default: true, agent_profile_version_id: 'apv-1' })

    fireEvent.click(screen.getAllByRole('button', { name: /解除绑定/u })[0])
    await waitFor(() => {
      expect(fetcher.mock.calls.some(([input, init]) => String(input).includes('/project-bindings') && init?.method === 'DELETE')).toBe(true)
    })
  }, 20_000)

  it('shows the service rejection reason when a version cannot be published', async () => {
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const url = routeFor(String(input))
      if (url.includes('/admin/agent-types')) return response({ items: [agentType] })
      if (url.includes('/admin/asset-candidates')) return response({ items: candidates })
      if (init?.method === 'POST' && url.includes(':publish')) {
        return response({ code: 'VALIDATION_ERROR', message: '资产 knowledge:k-3@v1 不可用：知识库已下线' }, 422)
      }
      return response({ items: [profile] })
    })
    configure(fetcher)
    render(React.createElement(AdminDashboard, { session: SESSION }))
    fireEvent.click(screen.getByRole('button', { name: /^Agent 配置/ }))
    const workspaceNav = await screen.findByLabelText('Agent 配置子导航')
    fireEvent.click(within(workspaceNav).getByRole('button', { name: /^Agent 配置/u }))
    await screen.findByText(/ap-1/u, {}, { timeout: 5_000 })
    vi.stubGlobal('confirm', vi.fn(() => true))

    fireEvent.click(screen.getByRole('button', { name: /发布版本/u }))
    await waitFor(() => {
      expect(screen.getAllByText(/知识库已下线/u).length).toBeGreaterThanOrEqual(1)
    })
  }, 20_000)

  it('lists agent executor types with readiness on a dedicated page', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => response({ items: [
      { agent_type_id: 'at-claude-code', key: 'claude_code', name: 'Claude Code', capabilities: ['terminal'], readiness: 'ready', schema_version: '1', schema: [] },
    ] }))
    configure(fetcher)
    render(React.createElement(AdminDashboard, { session: SESSION }))

    fireEvent.click(screen.getByRole('button', { name: /^Agent 配置/ }))
    const typesNav = await screen.findByLabelText('Agent 配置子导航')
    fireEvent.click(within(typesNav).getByRole('button', { name: /^Agent 类型/u }))
    expect(await screen.findByText('at-claude-code')).toBeTruthy()
    expect(screen.getByText('ready')).toBeTruthy()
    expect(fetcher.mock.calls.some(([input]) => String(input).endsWith('/admin/agent-types'))).toBe(true)
  })

  it('shows a workspace detail with recent audits and asks for confirmation before stop', async () => {
    const confirmSpy = vi.fn(() => true)
    vi.stubGlobal('confirm', confirmSpy)
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input)
      if (init?.method === 'POST') return response({ ...workspace, status: 'stopped', revision: 8 })
      if (url.includes('/admin/workspaces/ws-alpha-1')) {
        return response({
          ...workspace,
          recent_audits: [audit],
          runs: [{
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
          }],
          config_snapshot: { agent_profile_version_id: 'apv-1', model: 'deepseek-v3.2', asset_version_ids: ['skill:code-review@1.0.0'] },
        })
      }
      return response({ items: [workspace] })
    })
    configure(fetcher)
    render(React.createElement(AdminDashboard, { session: SESSION }))

    fireEvent.click(screen.getByRole('button', { name: /^云工作空间运维/ }))
    const opsNav = await screen.findByLabelText('云工作空间运维子导航')
    fireEvent.click(within(opsNav).getByRole('button', { name: /^Workspace 运维/u }))
    await screen.findByText('ws-alpha-1')

    fireEvent.click(screen.getByRole('button', { name: '停止' }))
    await waitFor(() => {
      expect(confirmSpy).toHaveBeenCalled()
    })
    const stopCall = fetcher.mock.calls.find(([input]) => String(input).includes(':stop'))
    expect(stopCall).toBeDefined()

    fireEvent.click(screen.getByRole('button', { name: '查看详情' }))
    expect(await screen.findByText(/概览/u)).toBeTruthy()
    expect(await screen.findByText(/Agent Runs/u)).toBeTruthy()
    expect(screen.getAllByText(/run-op-1/).length).toBeGreaterThan(0)
    expect(screen.getAllByText(/配置快照/u).length).toBeGreaterThan(0)
    expect(screen.getByText(/最近审计/u)).toBeTruthy()
  })

  it('does not send the stop request when the operator declines confirmation', async () => {
    vi.stubGlobal('confirm', vi.fn(() => false))
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      if (init?.method === 'POST') return response({ ...workspace, status: 'stopped', revision: 8 })
      return response({ items: [workspace] })
    })
    configure(fetcher)
    render(React.createElement(AdminDashboard, { session: SESSION }))

    fireEvent.click(screen.getByRole('button', { name: /^云工作空间运维/ }))
    const opsNav = await screen.findByLabelText('云工作空间运维子导航')
    fireEvent.click(within(opsNav).getByRole('button', { name: /^Workspace 运维/u }))
    await screen.findByText('ws-alpha-1')
    fireEvent.click(screen.getByRole('button', { name: '停止' }))
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(fetcher.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false)
  })

  it('shows a field-level diff between two agent profile versions', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => response({ items: [profile] }))
    configure(fetcher)
    render(React.createElement(AdminDashboard, { session: SESSION }))

    fireEvent.click(screen.getByRole('button', { name: /^Agent 配置/ }))
    const profilesNav = await screen.findByLabelText('Agent 配置子导航')
    fireEvent.click(within(profilesNav).getByRole('button', { name: /^Agent 配置/u }))
    await new Promise(r => setTimeout(r, 400))
    console.log('SECTION_HTML', (document.querySelector('section.cloud-profile')?.outerHTML ?? 'NO SECTION').slice(-600))

    console.log('VD_COUNT', document.querySelectorAll('.version-diff').length, '| SEL', document.querySelectorAll('.version-diff select').length)
    const diffRegion = screen.queryByLabelText('版本差异')
    console.log('DIFF_NODE', diffRegion === null ? 'null' : 'found', '| SELECTS', document.querySelectorAll('[aria-label=基准版本]').length, document.querySelectorAll('[aria-label=对比版本]').length)
    if (diffRegion === null) throw new Error('diff region missing')
    expect(diffRegion).toBeTruthy()
    // 基准 v1（published）vs 对比 v2（draft）：默认选前两个版本
    expect(within(diffRegion).getByText('medium')).toBeTruthy()
    expect(within(diffRegion).getByText('high')).toBeTruthy()
    expect(within(diffRegion).getByText('提示规则')).toBeTruthy()
  })

  it('renders audit rows with the literal actor_name column', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => response([audit]))
    configure(fetcher)
    render(React.createElement(AdminDashboard, { session: SESSION }))

    fireEvent.click(screen.getByRole('button', { name: /^运行与审计/ }))
    const auditNav = await screen.findByLabelText('运行与审计子导航')
    fireEvent.click(within(auditNav).getByRole('button', { name: '审计' }))
    expect(await screen.findByText('演示成员')).toBeTruthy()
    expect(screen.getByText(/workspace\.stop/u)).toBeTruthy()
  })
})


describe('UX-09 关系链跨页跳转', () => {
  function configureDetailFetcher(fetcher: unknown): void {
    configure(fetcher)
  }

  it('jumps from the ops detail to the Run page and the workspace audit page', async () => {
    // 0-2 起渲染门读取 Agent Run/审计页的主端点：stub 必须提供对应合法报文。
    const runRow = {
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
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input)
      if (url.includes('/admin/runs') && init?.method === 'POST') return response({ items: [runRow] })
      if (init?.method === 'POST') return response({ ...workspace, status: 'stopped', revision: 8 })
      if (url.includes('/admin/audits')) return response([audit])
      if (url.includes('/admin/workspaces/ws-alpha-1')) {
        return response({
          ...workspace,
          recent_audits: [audit],
          runs: [{
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
          }],
          config_snapshot: { agent_profile_version_id: 'apv-1', model: 'deepseek-v3.2', asset_version_ids: [] },
        })
      }
      return response({ items: [workspace] })
    })
    configureDetailFetcher(fetcher)
    render(React.createElement(AdminDashboard, { session: SESSION }))

    fireEvent.click(screen.getByRole('button', { name: /^云工作空间运维/ }))
    const opsNav = await screen.findByLabelText('云工作空间运维子导航')
    fireEvent.click(within(opsNav).getByRole('button', { name: /^Workspace 运维/u }))
    await screen.findByText('ws-alpha-1')
    fireEvent.click(screen.getByRole('button', { name: '查看详情' }))
    await screen.findByText(/Agent Runs/u)

    // 关系链在详情中可跳转：Run 行 → Agent Run 页
    fireEvent.click(screen.getByRole('button', { name: '查看 Run run-op-1' }))
    expect(await screen.findByRole('heading', { name: 'Agent Run' })).toBeTruthy()

    // 回到运维详情：审计行 → Workspace 审计页
    fireEvent.click(screen.getByRole('button', { name: /^云工作空间运维/ }))
    fireEvent.click(within(await screen.findByLabelText('云工作空间运维子导航')).getByRole('button', { name: /^Workspace 运维/u }))
    await screen.findByText('ws-alpha-1')
    fireEvent.click(screen.getByRole('button', { name: '查看详情' }))
    await screen.findByText(/最近审计/u)
    fireEvent.click(screen.getByRole('button', { name: '查看审计' }))
    expect(await screen.findByRole('heading', { name: '审计' })).toBeTruthy()
  })
})

/**
 * RUX-05：关系链按钮必须携带目标对象的不透明 ID 与筛选条件，目标页据此
 * 直接选中对象并显示来源 Workspace；刷新与浏览器后退保持上下文；越权或
 * 对象不存在时显示服务端声明之外的显式失败，而不是一张空表。
 */
describe('RUX-05 关系链对象上下文', () => {
  const focusedRun = {
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
  const otherRun = { ...focusedRun, run_id: 'run-other-9', workspace_id: 'ws-other-9' }
  const opsDetail = {
    ...workspace,
    recent_audits: [audit],
    runs: [focusedRun],
    config_snapshot: { agent_profile_version_id: 'apv-1', model: 'deepseek-v3.2', asset_version_ids: [] },
  }

  function configureRelationFetcher(runRows: readonly unknown[] = [focusedRun]): void {
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input)
      if (url.includes('/admin/workspaces/ws-alpha-1')) return response(opsDetail)
      if (url.includes('/admin/workspaces')) return response({ items: [workspace] })
      if (url.includes('/admin/runs') && init?.method === 'POST') return response({ items: runRows })
      if (url.includes('/admin/audits')) return response([audit])
      return response({ items: [] })
    })
    configure(fetcher)
  }

  async function openOpsDetail(): Promise<void> {
    fireEvent.click(screen.getByRole('button', { name: /^云工作空间运维/ }))
    const nav = await screen.findByLabelText('云工作空间运维子导航')
    fireEvent.click(within(nav).getByRole('button', { name: /^Workspace 运维/u }))
    await screen.findByText('ws-alpha-1')
    fireEvent.click(screen.getByRole('button', { name: '查看详情' }))
    await screen.findByText(/Agent Runs/u)
  }

  function queryParams(): URLSearchParams {
    return new URLSearchParams(window.location.search)
  }

  afterEach(() => {
    window.history.replaceState({}, '', '/')
  })

  it('carries the Run into the target URL, filter, source note and selected row', async () => {
    configureRelationFetcher()
    render(React.createElement(AdminDashboard, { session: SESSION }))
    await openOpsDetail()

    fireEvent.click(screen.getByRole('button', { name: '查看 Run run-op-1' }))
    expect(await screen.findByRole('heading', { name: 'Agent Run' })).toBeTruthy()

    const params = queryParams()
    expect(params.get('page')).toBe('cloud-runs')
    expect(params.get('workspaceId')).toBe('ws-alpha-1')
    expect(params.get('runId')).toBe('run-op-1')
    expect(await screen.findByText(/来自 Workspace ws-alpha-1 · Run run-op-1/u)).toBeTruthy()
    expect(await screen.findByLabelText('Run Workspace 筛选')).toHaveProperty('value', 'ws-alpha-1')
    const row = (await screen.findByText('run-op-1')).closest('tr')
    expect(row?.getAttribute('aria-current')).toBe('true')
  })

  it('restores page and object context on refresh', async () => {
    configureRelationFetcher()
    render(React.createElement(AdminDashboard, { session: SESSION }))
    await openOpsDetail()
    fireEvent.click(screen.getByRole('button', { name: '查看 Run run-op-1' }))
    await screen.findByRole('heading', { name: 'Agent Run' })
    cleanup()

    // 刷新：同一个 URL 重新挂载整个后台壳层。
    render(React.createElement(AdminDashboard, { session: SESSION }))
    expect(await screen.findByRole('heading', { name: 'Agent Run' })).toBeTruthy()
    expect(await screen.findByText(/来自 Workspace ws-alpha-1 · Run run-op-1/u)).toBeTruthy()
    expect(await screen.findByLabelText('Run Workspace 筛选')).toHaveProperty('value', 'ws-alpha-1')
  })

  it('restores page and object context on browser back', async () => {
    configureRelationFetcher()
    render(React.createElement(AdminDashboard, { session: SESSION }))
    await openOpsDetail()
    fireEvent.click(screen.getByRole('button', { name: '查看 Run run-op-1' }))
    await screen.findByRole('heading', { name: 'Agent Run' })

    window.history.pushState({}, '', '/?page=cloud-audits&workspaceId=ws-alpha-1&requestId=req-1')
    window.dispatchEvent(new PopStateEvent('popstate'))

    expect(await screen.findByRole('heading', { name: '审计' })).toBeTruthy()
    expect(await screen.findByText('来自 Workspace ws-alpha-1 · 审计请求 req-1')).toBeTruthy()
    expect(await screen.findByLabelText('审计 Workspace 筛选')).toHaveProperty('value', 'ws-alpha-1')
    const row = (await screen.findByText('req-1')).closest('tr')
    expect(row?.getAttribute('aria-current')).toBe('true')
  })

  it('shows an explicit failure instead of an empty list when the target Run is absent', async () => {
    configureRelationFetcher([otherRun])
    render(React.createElement(AdminDashboard, { session: SESSION }))
    await openOpsDetail()

    fireEvent.click(screen.getByRole('button', { name: '查看 Run run-op-1' }))
    await screen.findByRole('heading', { name: 'Agent Run' })

    const missing = await screen.findByText(/服务端未返回目标 Run run-op-1/u)
    expect(missing.getAttribute('data-relation-missing')).toBe('true')
    expect(missing.getAttribute('role')).toBe('alert')
    // 目标对象不在服务端结果里时列表不得再声称成功：目标行不存在。
    expect(screen.queryByText('run-op-1')).toBeNull()
  })

  it('carries the audit request id when jumping from an audit row', async () => {
    configureRelationFetcher()
    render(React.createElement(AdminDashboard, { session: SESSION }))
    await openOpsDetail()

    fireEvent.click(screen.getByRole('button', { name: '查看审计' }))
    expect(await screen.findByRole('heading', { name: '审计' })).toBeTruthy()

    const params = queryParams()
    expect(params.get('page')).toBe('cloud-audits')
    expect(params.get('workspaceId')).toBe('ws-alpha-1')
    expect(params.get('requestId')).toBe('req-1')
    expect(await screen.findByText('来自 Workspace ws-alpha-1 · 审计请求 req-1')).toBeTruthy()
    expect(await screen.findByLabelText('审计 Workspace 筛选')).toHaveProperty('value', 'ws-alpha-1')
  })

  it('opens the source workspace detail when jumping back from a run row', async () => {
    configureRelationFetcher()
    render(React.createElement(AdminDashboard, { session: SESSION }))
    await openOpsDetail()
    fireEvent.click(screen.getByRole('button', { name: '查看 Run run-op-1' }))
    await screen.findByLabelText('Run Workspace 筛选')

    fireEvent.click(screen.getByRole('button', { name: 'Workspace' }))

    const params = queryParams()
    expect(params.get('page')).toBe('cloud-ops')
    expect(params.get('workspaceId')).toBe('ws-alpha-1')
    expect(params.get('runId')).toBe('run-op-1')
    expect(await screen.findByText(/来自 Workspace ws-alpha-1 · Run run-op-1/u)).toBeTruthy()
    expect(await screen.findByRole('region', { name: 'Workspace 详情' })).toBeTruthy()
  })
})
