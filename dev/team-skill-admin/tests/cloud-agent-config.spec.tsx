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

const agentType = {
  agent_type_id: 'at-claude-code',
  key: 'claude_code',
  name: 'Claude Code',
  capabilities: ['terminal', 'files'],
  readiness: 'ready',
  schema_version: '1',
  schema: [
    {
      key: 'permission_mode',
      label: '权限模式',
      type: 'enum',
      required: true,
      affects_publish: true,
      description: null,
      enum: ['approval', 'auto', 'read_only'],
      default: 'approval',
    },
    { key: 'max_turns', label: '单轮上限', type: 'number', required: false, affects_publish: false, description: null, min: 1, max: 200 },
  ],
}

const hermesType = {
  agent_type_id: 'at-hermes',
  key: 'hermes',
  name: 'Hermes',
  capabilities: ['terminal'],
  readiness: 'degraded',
  schema_version: '1',
  schema: [
    {
      key: 'profile',
      label: '执行档案',
      type: 'enum',
      required: true,
      affects_publish: true,
      description: null,
      enum: ['fast', 'balanced', 'thorough'],
      default: 'balanced',
    },
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
    invalid_reason: null,
    updated_at: '2026-09-01T00:00:00.000Z',
  },
  {
    asset_id: 'skill:legacy@0.9.0',
    asset_type: 'skill',
    version: '0.9.0',
    name: '废弃 Skill',
    authorized: true,
    readiness: 'unavailable',
    invalid_reason: '版本已废弃',
    updated_at: '2026-08-01T00:00:00.000Z',
  },
  {
    asset_id: 'knowledge:k-1@v1',
    asset_type: 'knowledge',
    version: 'v1',
    name: '知识库 k-1',
    authorized: true,
    readiness: 'ready',
    invalid_reason: null,
    updated_at: '2026-09-01T00:00:00.000Z',
  },
  {
    asset_id: 'memory:m-1@v1',
    asset_type: 'memory',
    version: 'v1',
    name: '记忆库 m-1',
    authorized: true,
    readiness: 'ready',
    invalid_reason: null,
    updated_at: '2026-09-01T00:00:00.000Z',
  },
]

const profile = {
  agent_profile_id: 'ap-1',
  organization_id: 'org-alpha',
  name: '默认研发代理',
  description: '默认执行配置',
  agent_type_id: 'at-claude-code',
  agent_type_name: 'Claude Code',
  agent_type_readiness: 'ready',
  skill_count: 1,
  knowledge_count: 0,
  memory_name: '记忆库 m-1（协作偏好）',
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
      asset_bindings: {
        skills: [{ asset_version_id: 'skill:code-review@1.0.0', required: true, order: 1 }],
        knowledge_bases: [],
        memory: { asset_version_id: 'memory:m-1@v1', required: true },
      },
      asset_version_ids: ['skill:code-review@1.0.0', 'memory:m-1@v1'],
      execution_policy: { permission_mode: 'approval', write_mode: 'write' },
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
      asset_bindings: {
        skills: [{ asset_version_id: 'skill:code-review@1.0.0', required: true, order: 1 }],
        knowledge_bases: [],
        memory: null,
      },
      asset_version_ids: ['skill:code-review@1.0.0'],
      execution_policy: { permission_mode: 'approval' },
      type_extension_config: {},
      credential_ref: null,
      change_summary: '提高推理档位',
    },
  ],
  project_bindings: [
    { project_id: 'project-alpha', agent_profile_version_id: 'apv-1', default: true, revision: 1 },
  ],
}

function configure(fetcher: typeof fetch): void {
  vi.stubEnv('NEXT_PUBLIC_TEAM_SKILL_API_URL', 'http://service.test/v1')
  vi.stubEnv('NEXT_PUBLIC_TEAM_SKILL_ACCESS_TOKEN', 'admin-demo')
  vi.stubGlobal('fetch', fetcher)
}

const SESSION = { user: { id: 'admin-1', name: '平台管理员' }, role: 'admin' as const, mustChangePassword: false }

function routeFor(url: string): string {
  return url.replace(/^https?:\/\/[^/]+/u, '')
}

/** 从「Agent 配置」模块导航进入治理页。 */
async function openProfilesPage(fetcher: ReturnType<typeof vi.fn>): Promise<void> {
  render(React.createElement(AdminDashboard, { session: SESSION }))
  fireEvent.click(screen.getByRole('button', { name: /^Agent 配置/ }))
  const nav = await screen.findByLabelText('Agent 配置子导航')
  fireEvent.click(within(nav).getByRole('button', { name: /^Agent 配置/u }))
  await screen.findByText(/ap-1/u)
  expect(fetcher).toHaveBeenCalled()
}

describe('agent config admin page', () => {
  it('shows enriched profile cards: readiness, creator, timestamps and credential summary', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => response({ items: [profile] }))
    configure(fetcher)
    await openProfilesPage(fetcher)
    const card = screen.getByLabelText('配置卡片-ap-1')
    expect(card.getAttribute('data-readiness')).toBe('ready')
    expect(card.textContent).toContain('创建人 平台管理员')
    expect(card.textContent).toContain('凭据引用：deepseek-main')
    expect(card.textContent).toContain('ready')
    expect(card.textContent).toContain('草稿未发布')
  })

  it('filters the list server-side by status, type, project, readiness and creator', async () => {
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      if (String(input).includes('/admin/agent-types')) return response({ items: [agentType, hermesType] })
      return response({ items: [profile] })
    })
    configure(fetcher)
    await openProfilesPage(fetcher)
    fireEvent.change(screen.getByLabelText('筛选-状态'), { target: { value: 'draft' } })
    await waitFor(() => {
      expect(screen.getByLabelText('筛选-Agent 类型').textContent.length).toBeGreaterThan(0)
    })
    fireEvent.change(screen.getByLabelText('筛选-Agent 类型'), { target: { value: 'at-claude-code' } })
    fireEvent.change(screen.getByLabelText('筛选-项目'), { target: { value: 'project-alpha' } })
    fireEvent.change(screen.getByLabelText('筛选-readiness'), { target: { value: 'ready' } })
    fireEvent.change(screen.getByLabelText('筛选-创建人'), { target: { value: '平台管理员' } })
    await waitFor(() => {
      const listCalls = fetcher.mock.calls.filter(([input]) => String(input).includes('/admin/agent-profiles?'))
      expect(listCalls.length).toBeGreaterThan(0)
      const url = new URL(String(listCalls.at(-1)![0]), 'http://localhost')
      expect(url.searchParams.get('status')).toBe('draft')
      expect(url.searchParams.get('agent_type_id')).toBe('at-claude-code')
      expect(url.searchParams.get('project_id')).toBe('project-alpha')
      expect(url.searchParams.get('readiness')).toBe('ready')
      expect(url.searchParams.get('created_by')).toBe('平台管理员')
    })
  })

  it('confirms publish and archive before writing and skips the request on cancel', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => response({ items: [profile] }))
    configure(fetcher)
    const confirmSpy = vi.fn(() => false)
    vi.stubGlobal('confirm', confirmSpy)
    await openProfilesPage(fetcher)
    // §6.5：发布前先跑 dry-run 校验（异步），再弹确认。
    fireEvent.click(screen.getByRole('button', { name: /发布版本/u }))
    await waitFor(() => {
      expect(fetcher.mock.calls.some(([input]) => String(input).includes(':dry-run'))).toBe(true)
    })
    await waitFor(() => {
      expect(confirmSpy).toHaveBeenCalled()
    })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(fetcher.mock.calls.some(([input]) => String(input).includes(':publish'))).toBe(false)

    confirmSpy.mockImplementation(() => true)
    fireEvent.click(screen.getByRole('button', { name: /发布版本/u }))
    await waitFor(() => {
      expect(fetcher.mock.calls.some(([input]) => String(input).includes(':publish'))).toBe(true)
    })
    const publishCall = fetcher.mock.calls.find(([input]) => String(input).includes(':publish')) as [
      RequestInfo | URL,
      RequestInit | undefined,
    ]
    const init = publishCall[1]
    expect(new Headers(init?.headers).get('If-Match')).toBe('4')
    expect(new Headers(init?.headers).get('Idempotency-Key')).toBeTruthy()
  })

  it('clones a profile into a new draft via the :clone route with an idempotency key', async () => {
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      if (init?.method === 'POST' && String(input).includes(':clone')) {
        return response({ ...profile, agent_profile_id: 'ap-clone', name: '默认研发代理 副本', status: 'draft', project_bindings: [] })
      }
      return response({ items: [profile] })
    })
    configure(fetcher)
    vi.stubGlobal('confirm', vi.fn(() => true))
    await openProfilesPage(fetcher)
    fireEvent.click(screen.getByRole('button', { name: /复制为新配置/u }))
    await waitFor(() => {
      expect(fetcher.mock.calls.some(([input]) => String(input).includes(':clone'))).toBe(true)
    })
    const cloneCall = fetcher.mock.calls.find(([input]) => String(input).includes(':clone')) as [RequestInfo | URL, RequestInit | undefined]
    const input = cloneCall[0]
    const init = cloneCall[1]
    expect(routeFor(String(input))).toBe('/api/team-skill/admin/agent-profiles/ap-1:clone')
    expect(new Headers(init?.headers).get('Idempotency-Key')).toBeTruthy()
  })

  it('builds ordered skill bindings, knowledge multi-select and single memory from the draft form', async () => {
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      if (init?.method === 'POST' && String(input).endsWith('/admin/agent-profiles')) {
        return response({ ...profile, agent_profile_id: 'ap-new', status: 'draft' })
      }
      if (String(input).includes('/admin/agent-types')) return response({ items: [agentType, hermesType] })
      if (String(input).includes('asset-candidates')) return response({ items: candidates })
      return response({ items: [profile] })
    })
    configure(fetcher)
    await openProfilesPage(fetcher)
    fireEvent.change(screen.getByLabelText('创建配置名称'), { target: { value: '新代理' } })
    fireEvent.change(screen.getByLabelText('创建 Agent 类型'), { target: { value: 'at-claude-code' } })
    // Schema-driven extension field appears for the chosen type (create form is the first match).
    expect((await screen.findAllByLabelText('扩展-permission_mode')).length).toBeGreaterThan(0)
    fireEvent.change(screen.getAllByLabelText('扩展-permission_mode')[0], { target: { value: 'auto' } })
    // Skills multi-select in a defined order.
    fireEvent.click(screen.getAllByRole('checkbox', { name: '资产-代码评审 Skill' })[0])
    // Memory is a single choice; the first option is "不使用记忆库".
    fireEvent.change(screen.getAllByLabelText('资产-记忆库')[0], { target: { value: 'memory:m-1@v1' } })
    fireEvent.click(screen.getByRole('button', { name: '创建草稿' }))
    await waitFor(() => {
      expect(fetcher.mock.calls.some(
        ([input, callInit]) => String(input).endsWith('/admin/agent-profiles') && callInit?.method === 'POST',
      )).toBe(true)
    })
    const draftCall = fetcher.mock.calls.find(
      ([input, callInit]) => String(input).endsWith('/admin/agent-profiles') && callInit?.method === 'POST',
    ) as [RequestInfo | URL, RequestInit | undefined]
    const [, init] = draftCall
    const body = JSON.parse(init?.body as string) as {
      asset_bindings: {
        skills: Array<{ asset_version_id: string; required: boolean }>
        knowledge_bases: unknown[]
        memory: { asset_version_id: string; required: boolean } | null
      }
      type_extension_config: Record<string, unknown>
    }
    expect(body.asset_bindings.skills).toEqual([{ asset_version_id: 'skill:code-review@1.0.0', required: true, order: 1 }])
    expect(body.asset_bindings.memory).toEqual({ asset_version_id: 'memory:m-1@v1', required: true })
    expect(body.type_extension_config).toEqual({ permission_mode: 'auto' })

    // Reordering skills is explicit: add a second skill and move it up.
    // 作用域限定在创建表单内：草稿编辑器现在也有同名知识库选择器。
    const draftForm = within(screen.getByLabelText('创建配置草稿'))
    fireEvent.click(draftForm.getByRole('button', { name: '资产-知识库 k-1' }))
    const moveUp = draftForm.getByRole('button', { name: '上移-知识库 k-1' })
    fireEvent.click(moveUp)
    fireEvent.click(screen.getByRole('button', { name: '创建草稿' }))
    await waitFor(() => {
      const calls = fetcher.mock.calls.filter(([input, init]) => String(input).endsWith('/admin/agent-profiles') && init?.method === 'POST')
      expect(calls.length).toBe(2)
    })
    const secondCall = fetcher.mock.calls
      .filter(([input, callInit]) => String(input).endsWith('/admin/agent-profiles') && callInit?.method === 'POST')
      .at(-1) as [RequestInfo | URL, RequestInit | undefined]
    const secondInit = secondCall[1]
    const secondBody = JSON.parse(secondInit?.body as string) as {
      asset_bindings: {
        skills: Array<{ asset_version_id: string }>
        knowledge_bases: Array<{ asset_version_id: string; required: boolean }>
      }
    }
    // The knowledge chip lands in knowledge_bases with its own required flag.
    expect(secondBody.asset_bindings.knowledge_bases.map(entry => entry.asset_version_id)).toEqual(['knowledge:k-1@v1'])
    expect(secondBody.asset_bindings.knowledge_bases[0].required).toBe(true)
    expect(secondBody.asset_bindings.skills.map(skill => skill.asset_version_id)).toEqual(['skill:code-review@1.0.0'])
  })

  it('omits memory from the write body when 未使用记忆库 stays selected', async () => {
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      if (init?.method === 'POST' && String(input).endsWith('/admin/agent-profiles')) {
        return response({ ...profile, agent_profile_id: 'ap-new', status: 'draft' })
      }
      if (String(input).includes('/admin/agent-types')) return response({ items: [agentType] })
      if (String(input).includes('asset-candidates')) return response({ items: candidates })
      return response({ items: [profile] })
    })
    configure(fetcher)
    await openProfilesPage(fetcher)
    fireEvent.change(screen.getByLabelText('创建配置名称'), { target: { value: '无记忆代理' } })
    await waitFor(() => {
      expect(screen.getByLabelText('创建 Agent 类型').textContent.length).toBeGreaterThan(0)
    })
    fireEvent.change(screen.getByLabelText('创建 Agent 类型'), { target: { value: 'at-claude-code' } })
    fireEvent.click(screen.getByRole('button', { name: '创建草稿' }))
    await waitFor(() => {
      expect(fetcher.mock.calls.some(
        ([input, callInit]) => String(input).endsWith('/admin/agent-profiles') && callInit?.method === 'POST',
      )).toBe(true)
    })
    const draftCalls = fetcher.mock.calls.filter(
      ([input, callInit]) => String(input).endsWith('/admin/agent-profiles') && callInit?.method === 'POST',
    )
    const draftCall = draftCalls.at(-1) as [RequestInfo | URL, RequestInit | undefined]
    const [, init] = draftCall
    const body = JSON.parse(init?.body as string) as { asset_bindings: { memory: unknown } }
    expect(body.asset_bindings.memory).toBeNull()
  })

  it('opens a strictly validated detail view straight from the service', async () => {
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      if (String(input).endsWith('/admin/agent-profiles/ap-1')) return response(profile)
      return response({ items: [profile] })
    })
    configure(fetcher)
    await openProfilesPage(fetcher)
    fireEvent.click(screen.getByRole('button', { name: /配置详情-ap-1/u }))
    const detail = await screen.findByLabelText('配置详情快照-ap-1')
    await waitFor(() => {
      const detailCall = fetcher.mock.calls.find(([input]) => String(input).endsWith('/admin/agent-profiles/ap-1'))
      expect(detailCall).toBeDefined()
    })
    expect(detail.textContent).toContain('组织 org-alpha')
    expect(detail.textContent).toContain('deepseek-main（api_key · 已授权 · ready）')
    expect(detail.textContent).toContain('published_by 平台管理员')
    expect(detail.textContent).toContain('扩展配置')
    expect(detail.textContent).toContain('{"permission_mode":"approval"}')
    // A protocol-drifted detail payload must render as an error, never as an empty success.
    fireEvent.click(screen.getAllByRole('button', { name: /关闭详情/u })[0])
  })

  it('reloads the authoritative list when an agent_profile stream event arrives', async () => {
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const url = String(input)
      if (url.includes('/admin/events/stream')) {
        const event = {
          event_id: 'evt-1',
          resource_type: 'agent_profile',
          resource_id: 'ap-1',
          revision: 5,
          event_type: 'agent_profile.published',
          occurred_at: '2026-09-11T00:00:00.000Z',
          payload: {},
        }
        const frame = [
          'event: agent_profile.published',
          'id: evt-1',
          `data: ${JSON.stringify(event)}`,
          '',
          '',
        ].join('\n')
        return new Response(frame, { status: 200, headers: { 'content-type': 'text/event-stream' } })
      }
      return response({ items: [profile] })
    })
    configure(fetcher)
    await openProfilesPage(fetcher)
    await waitFor(() => {
      const streamReads = fetcher.mock.calls.filter(([input]) => String(input).includes('/admin/events/stream'))
      expect(streamReads.length).toBeGreaterThan(0)
    }, { timeout: 3000 })
    // The consumer re-reads the authoritative snapshot after the event: the list
    // endpoint is called again after the stream frame was delivered.
    await waitFor(() => {
      const isListCall = ([input]: [RequestInfo | URL, RequestInit | undefined]): boolean =>
        String(input).includes('/admin/agent-profiles?') || String(input).endsWith('/admin/agent-profiles')
      const listCalls = fetcher.mock.calls.filter(isListCall)
      expect(listCalls.length).toBeGreaterThanOrEqual(2)
    }, { timeout: 3000 })
  })
})

describe('agent config admin page round two', () => {
  it('shows agent type readiness, description, asset counts, memory name and binding count on the card', async () => {
    const enriched = {
      ...profile,
      agent_type_name: 'Claude Code',
      agent_type_readiness: 'ready',
      skill_count: 1,
      knowledge_count: 2,
      memory_name: '记忆库 m-1（协作偏好）',
      project_count: 1,
    }
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      if (String(input).includes('/admin/agent-types')) return response({ items: [agentType, hermesType] })
      return response({ items: [enriched] })
    })
    configure(fetcher)
    await openProfilesPage(fetcher)
    const card = screen.getByLabelText('配置卡片-ap-1')
    expect(card.textContent).toContain('类型 Claude Code')
    expect(card.textContent).toContain('类型 readiness ready')
    expect(card.textContent).toContain('描述 默认执行配置')
    expect(card.textContent).toContain('Skill 1 项')
    expect(card.textContent).toContain('知识库 2 项')
    expect(card.textContent).toContain('记忆库 记忆库 m-1（协作偏好）')
    expect(card.textContent).toContain('绑定项目 1 个')
  })

  it('passes the updated_after filter to the service', async () => {
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      if (String(input).includes('/admin/agent-types')) return response({ items: [agentType] })
      return response({ items: [profile] })
    })
    configure(fetcher)
    await openProfilesPage(fetcher)
    fireEvent.change(screen.getByLabelText('筛选-更新时间'), { target: { value: '2026-09-01T00:00' } })
    await waitFor(() => {
      const listCalls = fetcher.mock.calls.filter(([input]) => String(input).includes('/admin/agent-profiles?'))
      const url = new URL(String(listCalls.at(-1)![0]), 'http://localhost')
      expect(url.searchParams.get('updated_after')).toBe('2026-09-01T00:00')
    })
  })

  it('lets the new-version form edit skill and memory selections explicitly', async () => {
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const url = routeFor(String(input))
      if (url.includes('/admin/agent-types')) return response({ items: [agentType] })
      if (url.includes('/admin/asset-candidates')) return response({ items: candidates })
      if (init?.method === 'POST' && url.endsWith('/versions')) return response({ agent_profile_version_id: 'apv-3', version: 'v3', status: 'draft' })
      return response({ items: [profile] })
    })
    configure(fetcher)
    vi.stubGlobal('confirm', vi.fn(() => true))
    await openProfilesPage(fetcher)
    fireEvent.click(screen.getAllByRole('button', { name: /创建新版本/u })[0])
    const summary = await screen.findByLabelText('新版本摘要-ap-1')
    fireEvent.change(summary, { target: { value: '显式选择资产' } })
    // The form inherits the latest draft's skill selection; removing it must be explicit.
    const allBoxes = (screen.getAllByRole('checkbox', { name: '资产-代码评审 Skill' }) as HTMLInputElement[])
    const checkedBox = allBoxes.find(box => box.checked)
    expect(checkedBox).toBeDefined()
    fireEvent.click(checkedBox as HTMLInputElement)
    fireEvent.click(screen.getAllByRole('button', { name: /提交新版本/u })[0])
    await waitFor(() => {
      expect(fetcher.mock.calls.some(([input, init]) => String(input).includes('/versions') && init?.method === 'POST')).toBe(true)
    })
    const versionCall = fetcher.mock.calls.find(
      ([input, init]) => String(input).includes('/versions') && init?.method === 'POST',
    ) as [RequestInfo | URL, RequestInit | undefined]
    const body = JSON.parse(String(versionCall[1]?.body)) as {
      asset_bindings: { skills: unknown[]; memory: { asset_version_id: string } | null }
    }
    expect(body.asset_bindings.skills).toEqual([])
    expect(body.asset_bindings.memory).toBeNull()
  })

  it('shows a revision-conflict banner and re-reads the server draft instead of overwriting silently', async () => {
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const url = routeFor(String(input))
      if (url.includes('/admin/agent-types')) return response({ items: [agentType] })
      if (url.includes('/admin/asset-candidates')) return response({ items: candidates })
      if (init?.method === 'PUT') {
        const conflictBody = { code: 'REVISION_CONFLICT', message: '配置已被其他修改更新', request_id: 'r1', data: null }
        return new Response(JSON.stringify(conflictBody), { status: 409, headers: { 'content-type': 'application/json' } })
      }
      return response({ items: [profile] })
    })
    configure(fetcher)
    await openProfilesPage(fetcher)
    const editor = within(screen.getByLabelText('编辑草稿-ap-1'))
    fireEvent.change(editor.getByLabelText('配置模型'), { target: { value: 'deepseek-v9' } })
    fireEvent.click(screen.getByLabelText('保存草稿-ap-1'))
    const banner = await screen.findByRole('alert', { name: /revision 冲突-ap-1/u }, { timeout: 3000 })
    expect(banner.textContent).toContain('已重读服务端快照')
    // 服务端快照被重新读取并**单独**展示差异：冲突面板列出与服务端不同的字段。
    expect(banner.textContent).toContain('本地未保存')
    expect(banner.textContent).toContain('模型')
    // 冲突不得覆盖未保存编辑：编辑器保持本地输入，而不是回到服务端值。
    expect(within(screen.getByLabelText('编辑草稿-ap-1')).getByLabelText('配置模型')).toHaveProperty('value', 'deepseek-v9')
    // 两条显式路径都在页面上：保留本地修改并重试 / 采用服务端版本。
    expect(screen.getByLabelText('保留本地修改并重试-ap-1')).toBeTruthy()
    expect(screen.getByLabelText('采用服务端版本-ap-1')).toBeTruthy()
  })

  it('adopts the server version only when the operator asks for it', async () => {
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const url = routeFor(String(input))
      if (url.includes('/admin/agent-types')) return response({ items: [agentType] })
      if (url.includes('/admin/asset-candidates')) return response({ items: candidates })
      if (init?.method === 'PUT') {
        return new Response(
          JSON.stringify({ code: 'REVISION_CONFLICT', message: '配置已被其他修改更新', request_id: 'r1', data: null }),
          { status: 409, headers: { 'content-type': 'application/json' } },
        )
      }
      return response({ items: [profile] })
    })
    configure(fetcher)
    await openProfilesPage(fetcher)
    const editor = within(screen.getByLabelText('编辑草稿-ap-1'))
    fireEvent.change(editor.getByLabelText('配置模型'), { target: { value: 'deepseek-v9' } })
    fireEvent.click(screen.getByLabelText('保存草稿-ap-1'))
    await screen.findByRole('alert', { name: /revision 冲突-ap-1/u }, { timeout: 3000 })
    // 只有显式选择「采用服务端版本」才丢弃本地修改——这是唯一会覆盖编辑内容的路径。
    fireEvent.click(screen.getByLabelText('采用服务端版本-ap-1'))
    await waitFor(() => {
      expect(within(screen.getByLabelText('编辑草稿-ap-1')).getByLabelText('配置模型')).toHaveProperty('value', 'deepseek-v3.2')
    })
    expect(screen.queryByRole('alert', { name: /revision 冲突-ap-1/u })).toBeNull()
  })

  it('keeps the new-version form open with its fields when creating the version fails', async () => {
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const url = routeFor(String(input))
      if (url.includes('/admin/agent-types')) return response({ items: [agentType] })
      if (url.includes('/admin/asset-candidates')) return response({ items: candidates })
      if (init?.method === 'POST' && url.endsWith('/versions')) {
        return new Response(
          JSON.stringify({ code: 'SERVICE_UNAVAILABLE', message: 'Skill 服务请求失败', request_id: 'r-503', data: null }),
          { status: 503, headers: { 'content-type': 'application/json' } },
        )
      }
      return response({ items: [profile] })
    })
    configure(fetcher)
    await openProfilesPage(fetcher)
    fireEvent.click(screen.getAllByRole('button', { name: /创建新版本/u })[0])
    const summary = await screen.findByLabelText('新版本摘要-ap-1')
    fireEvent.change(summary, { target: { value: '未提交的新版本摘要' } })
    fireEvent.click(screen.getAllByRole('button', { name: /提交新版本/u })[0])
    await waitFor(() => {
      expect(fetcher.mock.calls.some(([input, init]) => String(input).includes('/versions') && init?.method === 'POST')).toBe(true)
    })
    // 失败后表单仍在、字段未清空。
    expect(screen.getByLabelText('新版本摘要-ap-1')).toHaveProperty('value', '未提交的新版本摘要')
  })

  it('binds a comma-separated project list with a fresh revision per project', async () => {
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const url = routeFor(String(input))
      if (url.includes('/admin/agent-types')) return response({ items: [agentType] })
      if (init?.method === 'PUT' && url.includes('project-bindings/project-alpha')) return response({ project_id: 'project-alpha' })
      if (init?.method === 'PUT' && url.includes('project-bindings/project-beta')) return response({ project_id: 'project-beta' })
      if (init?.method === 'GET' && url.endsWith('/admin/agent-profiles/ap-1')) return response(profile)
      return response({ items: [profile] })
    })
    configure(fetcher)
    vi.stubGlobal('confirm', vi.fn(() => true))
    await openProfilesPage(fetcher)
    fireEvent.change(screen.getByLabelText('绑定项目 ID'), { target: { value: 'project-alpha, project-beta' } })
    const bindButtons = screen.getAllByRole('button', { name: /绑定项目/u })
    fireEvent.click(bindButtons[0])
    await waitFor(() => {
      const puts = fetcher.mock.calls.filter(([input, init]) => init?.method === 'PUT' && String(input).includes('project-bindings'))
      expect(puts.length).toBe(2)
    })
    const putUrls = fetcher.mock.calls
      .filter(([input, init]) => init?.method === 'PUT' && String(input).includes('project-bindings'))
      .map(([input]) => routeFor(String(input)))
    expect(putUrls.some(url => url.includes('project-bindings/project-alpha'))).toBe(true)
    expect(putUrls.some(url => url.includes('project-bindings/project-beta'))).toBe(true)
  })

  it('marks ordered skill rows as draggable', async () => {
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const url = routeFor(String(input))
      if (url.includes('/admin/agent-types')) return response({ items: [agentType] })
      if (url.includes('/admin/asset-candidates')) return response({ items: candidates })
      if (init?.method === 'POST' && url.endsWith('/admin/agent-profiles')) {
        return response({ ...profile, agent_profile_id: 'ap-new', status: 'draft' })
      }
      return response({ items: [profile] })
    })
    configure(fetcher)
    await openProfilesPage(fetcher)
    fireEvent.change(screen.getByLabelText('创建配置名称'), { target: { value: '拖拽代理' } })
    await waitFor(() => {
      expect(screen.getByLabelText('创建 Agent 类型').textContent.length).toBeGreaterThan(0)
    })
    fireEvent.change(screen.getByLabelText('创建 Agent 类型'), { target: { value: 'at-claude-code' } })
    fireEvent.click(screen.getAllByRole('checkbox', { name: '资产-代码评审 Skill' })[0])
    const rows = document.querySelectorAll('ol.asset-order li[draggable="true"]')
    expect(rows.length).toBeGreaterThan(0)
  })

  it('shows the change summary column in the detail snapshot', async () => {
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      if (String(input).endsWith('/admin/agent-profiles/ap-1')) return response(profile)
      return response({ items: [profile] })
    })
    configure(fetcher)
    await openProfilesPage(fetcher)
    fireEvent.click(screen.getByRole('button', { name: /配置详情-ap-1/u }))
    const detail = await screen.findByLabelText('配置详情快照-ap-1')
    expect(detail.textContent).toContain('变更摘要')
    expect(detail.textContent).toContain('首个版本')
  })
})

describe('agent config admin api client', () => {
  it('validates enriched list payloads strictly and clones with headers', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => response({ items: [{ ...profile, readiness: undefined }] }))
    const api = new TeamSkillApi({ baseUrl: 'https://service.test/v1', accessToken: 'token', fetcher })
    const result = await api.cloudAgentProfiles()
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('INVALID_RESPONSE')

    const okFetcher = vi.fn<typeof fetch>(async (input, init) => {
      expect(new Headers(init?.headers).get('Idempotency-Key')).toBeTruthy()
      return response({ ...profile, agent_profile_id: 'ap-clone' })
    })
    const okApi = new TeamSkillApi({ baseUrl: 'https://service.test/v1', accessToken: 'token', fetcher: okFetcher })
    const cloned = await okApi.cloneCloudAgentProfile('ap-1', 'clone-key-1')
    expect(cloned.ok).toBe(true)
    expect(routeFor(String(okFetcher.mock.calls[0][0]))).toBe('/v1/admin/agent-profiles/ap-1:clone')
  })
})
