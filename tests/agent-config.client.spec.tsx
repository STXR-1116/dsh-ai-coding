// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { AgentConfigView } from '../src/client/agent-config/AgentConfigView'
import type { ClientRemote, TeamSkillProject } from '@deepseek-ai/dsh-api-remotes/client'
import { WorkspaceHost } from '../src/workspace-host.ts'

const projects: readonly TeamSkillProject[] = [
  {
    projectId: 'project-alpha',
    organizationId: 'org-alpha',
    organizationName: '星河 AI 平台',
    name: '协作台前端',
    description: '',
    status: 'active',
    createdBy: 'admin-1',
    createdAt: '2026-09-01T00:00:00Z',
    updatedAt: '2026-09-01T00:00:00Z',
    memberCount: 2,
    assetCount: 3,
    revision: 1,
  },
]

const ready = <T,>(value: T): { status: 'ready'; value: T; fixtureOnly: boolean } => ({ status: 'ready', value, fixtureOnly: false })

type FakeFn = { readonly mock: { calls: unknown[][] } } & ((...args: unknown[]) => Promise<unknown>)

/** The Host's parsed profile model — exactly what the view consumes. */
const profile = {
  agentProfileId: 'ap-code-default',
  agentProfileVersionId: 'apv-1',
  name: '默认研发代理',
  description: '面向研发工作空间的默认执行配置',
  versionLabel: 'v1',
  changeSummary: '首个发布版本',
  agentTypeId: 'at-claude-code',
  agentTypeName: 'Claude Code',
  agentTypeKey: 'claude_code',
  agentTypeReadiness: 'ready',
  agentTypeCapabilities: ['terminal', 'files', 'git'],
  model: 'deepseek-v3.2',
  reasoning: 'medium',
  skills: [
    {
      assetId: 'skill:code-review',
      assetVersionId: 'skill:code-review@1.0.0',
      name: '代码评审 Skill',
      required: true,
      order: 1,
      readiness: 'ready',
      unavailableReason: null,
    },
    {
      assetId: 'skill:legacy',
      assetVersionId: 'skill:legacy@0.9.0',
      name: '废弃 Skill',
      required: false,
      order: 2,
      readiness: 'unavailable',
      unavailableReason: '版本已废弃',
    },
  ],
  knowledgeBases: [
    {
      assetId: 'knowledge:k-1',
      assetVersionId: 'knowledge:k-1',
      name: '知识库 k-1',
      required: true,
      order: 1,
      readiness: 'ready',
      unavailableReason: null,
    },
  ],
  memory: {
    assetId: 'memory:m-1',
    assetVersionId: 'memory:m-1',
    name: '记忆库 m-1',
    required: true,
    order: 1,
    readiness: 'ready',
    unavailableReason: null,
  },
  executionPolicy: {
    permission_mode: 'approval',
    tool_allowlist: ['read', 'write'],
    max_concurrency: 2,
    budget: 200000,
    timeout_ms: 900000,
    write_mode: 'write',
  },
  typeExtension: { permission_mode: 'approval' },
  typeExtensionOpaqueKeys: ['opaque'],
  readiness: 'ready',
  unavailableReason: null,
  default: true,
  status: 'published',
  createdBy: '平台管理员',
  publishedAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-02T00:00:00.000Z',
}

const degradedProfile = {
  ...profile,
  agentProfileId: 'ap-review-lite',
  agentProfileVersionId: 'apv-lite-1',
  name: '轻量评审代理',
  readiness: 'degraded',
  unavailableReason: '可选资产 skill:legacy@0.9.0 不可用：版本已废弃',
  default: false,
  memory: null,
}

const schemaResult = {
  status: 'ready',
  value: {
    agentTypeId: 'at-claude-code',
    key: 'claude_code',
    credentialRequired: true,
    schemaVersion: '1',
    schema: [
      { key: 'permission_mode', label: '权限模式', type: 'enum', required: true, affectsPublish: true, description: null, enum: ['approval', 'auto', 'read_only'] },
    ],
  },
}

function fakeRemote(agentProfilesResult: unknown, agentProfileVersionResult: unknown): ClientRemote {
  const agentProfiles = vi.fn(async () => ({ ok: true, value: agentProfilesResult })) as unknown as FakeFn
  const agentProfileVersion = vi.fn(async () => ({ ok: true, value: agentProfileVersionResult })) as unknown as FakeFn
  const agentTypeSchema = vi.fn(async () => ({ ok: true, value: schemaResult })) as unknown as FakeFn
  return { cloudWorkspaces: { agentProfiles, agentProfileVersion, agentTypeSchema } } as unknown as ClientRemote
}

function lastCall(fn: FakeFn): unknown[] {
  return fn.mock.calls.at(-1) ?? []
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('AgentConfigView reads published project versions through the Host Remote', () => {
  it('renders enriched cards with readiness, default mark and asset counts', async () => {
    const remote = fakeRemote(ready([profile, degradedProfile]), ready(profile))
    const { container } = render(
      <AgentConfigView remote={remote} projectId="project-alpha" projects={projects} />,
    )
    await waitFor(() => {
      expect(screen.getByText('默认研发代理')).toBeTruthy()
    })
    const mainline = container.querySelector('[data-profile-id="ap-code-default"]') as HTMLElement
    expect(mainline.getAttribute('data-readiness')).toBe('ready')
    expect(mainline.getAttribute('data-default')).toBe('true')
    expect(mainline.textContent).toContain('Claude Code（claude_code）')
    expect(mainline.textContent).toContain('v1')
    expect(mainline.textContent).toContain('Skill 2 项')
    expect(mainline.textContent).toContain('含不可用资产')
    expect(mainline.textContent).toContain('知识库 1 项')
    expect(mainline.textContent).toContain('记忆库 m-1')
    const degraded = container.querySelector('[data-profile-id="ap-review-lite"]') as HTMLElement
    expect(degraded.getAttribute('data-readiness')).toBe('degraded')
    expect(degraded.textContent).toContain('可选资产 skill:legacy@0.9.0 不可用')
    // The plugin offers no governance actions.
    expect(screen.queryByText('保存配置')).toBeNull()
    expect(screen.queryByText('发布')).toBeNull()
  })

  it('shows the memory-less card as 未使用记忆库 and opens the read-only detail', async () => {
    const remote = fakeRemote(ready([degradedProfile]), ready(degradedProfile))
    const { container } = render(
      <AgentConfigView remote={remote} projectId="project-alpha" projects={projects} />,
    )
    await waitFor(() => {
      expect(screen.getByText('轻量评审代理')).toBeTruthy()
    })
    expect(container.querySelector('[data-profile-id="ap-review-lite"]')?.textContent).toContain('未使用记忆库')

    fireEvent.click(screen.getByText('查看只读详情'))
    const dialog = await screen.findByRole('dialog', { name: '配置只读详情' })
    await waitFor(() => {
      expect((dialog.querySelector('[data-state]') as HTMLElement).getAttribute('data-state')).toBe('ready')
    })
    expect(lastCall(remote.cloudWorkspaces.agentProfileVersion as FakeFn)).toEqual(['apv-lite-1'])
    // Detail sections carry the design-mandated partitions.
    expect(dialog.textContent).toContain('基本信息')
    expect(dialog.textContent).toContain('模型参数')
    expect(dialog.textContent).toContain('deepseek-v3.2')
    expect(dialog.textContent).toContain('推理级别')
    expect(dialog.textContent).toContain('团队资产')
    // Ordered skills render in wire order with required flags and readiness.
    const skillRows = [...dialog.querySelectorAll('[data-required]')].map(row => row.textContent ?? '')
    expect(skillRows[0]).toContain('代码评审 Skill')
    expect(skillRows[0]).toContain('必需')
    expect(skillRows[1]).toContain('可选')
    expect(skillRows[1]).toContain('版本已废弃')
    expect(dialog.textContent).toContain('未使用记忆库')
    expect(dialog.textContent).toContain('执行策略')
    expect(dialog.textContent).toContain('允许写入')
    expect(dialog.textContent).toContain('类型扩展')
    // Unknown extension values collapse to the server-extension label instead of being dropped.
    expect(dialog.textContent).toContain('服务端扩展字段')
    expect(dialog.textContent).toContain('项目默认')
  })

  it('记忆库卡片不为缺字段编造值：容量/描述/更新时间如实标注服务端契约未提供（§3-4）', async () => {
    const remote = fakeRemote(ready([profile]), ready(profile))
    render(
      <AgentConfigView remote={remote} projectId="project-alpha" projects={projects} />,
    )
    await waitFor(() => { expect(screen.getByText('默认研发代理')).toBeTruthy() })
    fireEvent.click(screen.getByText('查看只读详情'))
    const dialog = await screen.findByRole('dialog', { name: '配置只读详情' })
    await waitFor(() => {
      expect((dialog.querySelector('[data-state]') as HTMLElement).getAttribute('data-state')).toBe('ready')
    })
    expect(dialog.textContent).toContain('记忆库 m-1')
    const capacity = dialog.querySelector('[data-capacity="blocked"]') as HTMLElement
    expect(capacity, '容量行必须显式标注为契约缺口').toBeTruthy()
    expect(capacity.textContent).toContain('服务端契约未提供（BLOCKED）')
    // 服务端没有容量字段：这一行里不允许出现任何数字——0、估算值或哨兵值都算编造。
    expect(capacity.textContent ?? '').not.toMatch(/\d/u)
    expect(dialog.textContent).toContain('描述/更新时间：服务端契约未提供（BLOCKED）')
  })

  it('closes the read-only detail with the Escape key', async () => {
    const remote = fakeRemote(ready([profile]), ready(profile))
    render(
      <AgentConfigView
        remote={remote}
        projectId="project-alpha"
        projects={projects}
      />,
    )
    await waitFor(() => { expect(screen.getByText('默认研发代理')).toBeTruthy() })
    fireEvent.click(screen.getByText('查看只读详情'))
    const dialog = await screen.findByRole('dialog', { name: '配置只读详情' })
    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => { expect(screen.queryByRole('dialog', { name: '配置只读详情' })).toBeNull() })
    expect(dialog).toBeTruthy()
  })

  it('renders signed-out, not-ready, failed and empty states distinctly', async () => {
    const signedOut = fakeRemote({ status: 'signed-out' }, { status: 'signed-out' })
    const onAuthorizationFailure = vi.fn()
    render(
      <AgentConfigView
        remote={signedOut}
        projectId="project-alpha"
        projects={projects}
        onAuthorizationFailure={onAuthorizationFailure}
      />,
    )
    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toContain('账号已登出')
    })
    expect(onAuthorizationFailure).toHaveBeenCalled()
    cleanup()

    const notReady = fakeRemote({ status: 'not-ready', missing: ['apiBaseUrl'] }, { status: 'signed-out' })
    const { container: notReadyView } = render(
      <AgentConfigView remote={notReady} projectId="project-alpha" projects={projects} />,
    )
    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toContain('服务未就绪')
    })
    expect(notReadyView.textContent).toContain('apiBaseUrl')
    cleanup()

    const failed = fakeRemote({ status: 'failed', code: 'INVALID_RESPONSE', message: '协议错误' }, { status: 'signed-out' })
    const { container: failedView } = render(
      <AgentConfigView remote={failed} projectId="project-alpha" projects={projects} />,
    )
    await waitFor(() => {
      const box = failedView.querySelector('[data-error-code]') as HTMLElement
      expect(box.getAttribute('data-error-code')).toBe('INVALID_RESPONSE')
    })
    expect(failedView.textContent).toContain('协议错误')
    cleanup()

    const empty = fakeRemote({ status: 'ready', value: [], fixtureOnly: true }, { status: 'signed-out' })
    const { container: emptyView } = render(
      <AgentConfigView remote={empty} projectId="project-alpha" projects={projects} />,
    )
    await waitFor(() => {
      expect(emptyView.textContent).toContain('当前项目没有可用的 Agent 配置')
    })
    // The empty state is distinct from failures and keeps the fixture provenance.
    expect(emptyView.querySelector('[data-error-code]')).toBeNull()
    expect(emptyView.textContent).toContain('fixture-only')
  })

  it('asks the parent to switch projects from the page selector', async () => {
    const remote = fakeRemote(ready([profile]), ready(profile))
    const onProjectSelect = vi.fn()
    render(
      <AgentConfigView
        remote={remote}
        projects={projects}
        onProjectSelect={onProjectSelect}
      />,
    )
    // The selector is the only project entry point on the page: choosing one must
    // notify the parent instead of reading cross-project data locally.
    fireEvent.change(screen.getByLabelText('选择项目'), { target: { value: 'project-alpha' } })
    expect(onProjectSelect).toHaveBeenCalledWith('project-alpha')
  })

  it('clears the previous project list and detail when the project changes', async () => {
    // The second project's read is held back so the intermediate clearing state is observable.
    let releaseBeta: ((value: unknown) => void) | undefined
    const betaResult = new Promise((resolve) => {
      releaseBeta = resolve
    })
    const agentProfiles = vi.fn(async (projectId: string) => {
      if (projectId === 'project-beta') return { ok: true, value: await betaResult }
      return { ok: true, value: ready([profile]) }
    }) as unknown as FakeFn
    const agentProfileVersion = vi.fn(async () => ({ ok: true, value: ready(profile) })) as unknown as FakeFn
    const remote = { cloudWorkspaces: { agentProfiles, agentProfileVersion } } as unknown as ClientRemote
    const { rerender, container } = render(
      <AgentConfigView remote={remote} projectId="project-alpha" projects={projects} />,
    )
    await waitFor(() => {
      expect(screen.getByText('默认研发代理')).toBeTruthy()
    })
    fireEvent.click(screen.getByText('查看只读详情'))
    await screen.findByRole('dialog', { name: '配置只读详情' })

    rerender(
      <AgentConfigView
        remote={remote}
        projectId="project-beta"
        projects={projects}
      />,
    )
    await waitFor(() => {
      expect(lastCall(agentProfiles)).toEqual(['project-beta'])
    })
    // The stale project's card and detail must not survive the switch.
    await waitFor(() => {
      expect(container.textContent).toContain('正在读取项目配置')
    })
    expect(container.querySelector('[data-profile-id="ap-code-default"]')).toBeNull()
    expect(screen.queryByRole('dialog', { name: '配置只读详情' })).toBeNull()

    releaseBeta?.(ready([{ ...profile, agentProfileId: 'ap-beta', agentProfileVersionId: 'apv-beta' }]))
    await waitFor(() => {
      expect(container.querySelector('[data-profile-id="ap-beta"]')).not.toBeNull()
    })
  })
})

/**
 * 真实 HTTP 通道：in-spec 服务以真实 fixture 的用户面载荷形状应答，经真实
 * WorkspaceHost 严格解析后驱动视图。真实 fixture 服务自身的载荷形状由
 * platform 的 workspace-host.integration.spec 断言（客户端程序不能导入 apps）。
 */
const REAL_PROFILE_DTO = {
  agent_profile_id: 'ap-code-default',
  agent_profile_version_id: 'apv-1',
  name: '默认研发代理',
  description: '面向研发工作空间的默认执行配置',
  version_label: 'v1',
  change_summary: '首个发布版本',
  agent_type_id: 'at-claude-code',
  agent_type_name: 'Claude Code',
  agent_type_key: 'claude_code',
  agent_type_readiness: 'ready',
  agent_type_capabilities: ['terminal', 'files', 'git'],
  model: 'deepseek-v3.2',
  reasoning: 'medium',
  skills: [
    { asset_id: 'skill:code-review', asset_version_id: 'skill:code-review@1.0.0', name: '代码评审 Skill', required: true, order: 1, readiness: 'ready', unavailable_reason: null },
  ],
  knowledge_bases: [
    { asset_id: 'knowledge:k-1', asset_version_id: 'knowledge:k-1', name: '知识库 k-1', required: true, order: 1, readiness: 'ready', unavailable_reason: null },
  ],
  memory: { asset_id: 'memory:m-1', asset_version_id: 'memory:m-1', name: '记忆库 m-1', required: true, order: 1, readiness: 'ready', unavailable_reason: null },
  execution_policy: { permission_mode: 'approval', tool_allowlist: ['read', 'write'], max_concurrency: 2, budget: 200000, timeout_ms: 900000, write_mode: 'write' },
  type_extension_config: { permission_mode: 'approval' },
  readiness: 'ready',
  unavailable_reason: null,
  default: true,
  status: 'published',
  created_by: '平台管理员',
  published_at: '2026-09-01T00:00:00.000Z',
  updated_at: '2026-09-02T00:00:00.000Z',
}

describe('AgentConfigView over the real HTTP fixture shape', () => {
  it('renders cards and detail from the real payload shape through the strict parser', async () => {
    const server = createServer((request: IncomingMessage, response: ServerResponse) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      const requestId = 'req-1'
      const send = (data: unknown): void => {
        response.writeHead(200, { 'content-type': 'application/json', 'x-fixture-only': 'true' })
        response.end(JSON.stringify({ code: 0, message: 'ok', request_id: requestId, data }))
      }
      if (url.pathname === '/v1/me/agent-profiles' && url.searchParams.get('project_id') === 'project-alpha') {
        send({ items: [REAL_PROFILE_DTO] })
        return
      }
      if (url.pathname === '/v1/me/agent-profiles/apv-1') {
        send({ ...REAL_PROFILE_DTO, default: false })
        return
      }
      if (url.pathname === '/v1/me/agent-types/at-claude-code/schema') {
        send({
          agent_type_id: 'at-claude-code',
          key: 'claude_code',
          credential_required: true,
          schema_version: '1',
          schema: [
            { key: 'permission_mode', label: '权限模式', type: 'enum', required: true, affects_publish: true, description: null, enum: ['approval', 'auto', 'read_only'], default: 'approval' },
          ],
        })
        return
      }
      response.writeHead(404, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ code: 'RESOURCE_NOT_FOUND', message: '不存在', request_id: requestId, data: null }))
    })
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
    const port = (server.address() as AddressInfo).port

    try {
      const host = new WorkspaceHost({
        apiBaseUrl: `http://127.0.0.1:${port}`,
        session: {
          read: async () => ({ accessToken: 'demo-token', identity: 'identity:demo-token' }),
          clear: async () => true,
        },
      })
      const remote = {
        cloudWorkspaces: {
          agentProfiles: async (projectId: string) => ({ ok: true as const, value: await host.agentProfiles(projectId) }),
          agentProfileVersion: async (versionId: string) => ({ ok: true as const, value: await host.agentProfileVersion(versionId) }),
        },
      } as unknown as ClientRemote
      const { container } = render(
        <AgentConfigView remote={remote} projectId="project-alpha" projects={projects} />,
      )
      await waitFor(() => { expect(screen.getByText('默认研发代理')).toBeTruthy() })
      expect(container.querySelector('[data-profile-id="ap-code-default"]')?.getAttribute('data-readiness')).toBe('ready')
      expect(screen.getAllByText('fixture-only').length).toBeGreaterThan(0)

      fireEvent.click(screen.getByText('查看只读详情'))
      const dialog = await screen.findByRole('dialog', { name: '配置只读详情' })
      await waitFor(() => {
        expect((dialog.querySelector('[data-state]') as HTMLElement).getAttribute('data-state')).toBe('ready')
      })
      expect(dialog.textContent).toContain('面向研发工作空间的默认执行配置')
      expect(dialog.textContent).toContain('记忆库 m-1')
      expect(dialog.textContent).toContain('允许写入')
    } finally {
      server.closeAllConnections()
      await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
    }
  }, 15_000)
})
