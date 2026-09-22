// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ClientRemote, WorkspaceId } from '@deepseek-ai/dsh-api-remotes/client'
import type { WorkspaceListState } from './helpers/client-runtime-types.ts'
import type { PlatformSurfaceProps } from '../src/client/PlatformSurface.tsx'
import { PlatformEntry } from '../src/client/PlatformEntry.tsx'
import { PlatformSurface } from '../src/client/PlatformSurface.tsx'
import { PlatformDemoController } from '../src/client/controller.ts'
import { seedBrowserSettings } from './helpers/browser-settings.ts'

afterEach(() => {
  cleanup()
  window.localStorage.clear()
})

// 工作台整体被设置面门控：渲染型用例先种入 fixture 部署设置。
beforeEach(() => {
  seedBrowserSettings()
})

const copy = {
  'platform.name': '编程协作台',
  'platform.shortName': '协作台',
  'platform.open': '打开编程协作台',
  'platform.close': '关闭编程协作台',
  'platform.demo': '演示数据',
  'platform.offline': '服务端未连接',
}

const t = (key: string): string => copy[key as keyof typeof copy] ?? key

const demoCatalog = {
  status: 'ready' as const,
  catalog: {
    items: [
      {
        skillId: 'skill-review',
        displayName: '代码评审',
        runtimeName: 'code-review',
        summary: '按团队规范检查风险、测试和变更边界。',
        version: '2.4.0',
        category: '质量',
        tags: ['质量'],
        publishedAt: '2026-08-29T08:00:00Z',
      },
    ],
  },
}

const demoAccount = {
  status: 'authenticated' as const,
  user: {
    userId: 'member-1',
    username: 'member@example.com',
    email: 'member@example.com',
    displayName: '成员甲',
    status: 'active' as const,
    globalRole: 'member' as const,
    mustChangePassword: false,
    revision: 1,
  },
  memberships: [{ organizationId: 'org-1', organizationName: '星河平台', status: 'active' as const, revision: 1 }],
  mustChangePassword: false,
}

const demoOrganizations = [{ organizationId: 'org-1', name: '星河平台', status: 'active' as const, revision: 1 }]
const demoProject = {
  projectId: 'orbit-ui',
  organizationId: 'org-1',
  organizationName: '星河平台',
  name: 'AI开放平台',
  description: 'AI 开放平台项目',
  status: 'active' as const,
  createdBy: 'manager-1',
  createdAt: '2026-08-29T08:00:00Z',
  updatedAt: '2026-08-29T08:00:00Z',
  memberCount: 1,
  assetCount: 1,
  revision: 1,
}
const demoProjectDetail = {
  project: demoProject,
  assets: [
    {
      projectId: 'orbit-ui',
      assetType: 'skill' as const,
      assetId: 'skill-review',
      name: '代码评审',
      relationKind: 'reference' as const,
      createdAt: '2026-08-29T08:00:00Z',
      updatedAt: '2026-08-29T08:00:00Z',
      revision: 1,
    },
  ],
}
const demoKnowledgeBases = [
  {
    knowledgeBaseId: 'k-1',
    name: 'DSH 会话事件与模型可见性规范',
    description: '会话日志与模型可见性要求。',
    type: 'document' as const,
    state: 'active' as const,
    searchable: true,
    updatedAt: '2026-08-29T08:00:00Z',
    revision: 1,
  },
  {
    knowledgeBaseId: 'k-2',
    name: '远程执行目标接入手册',
    description: '远程执行目标的接入约定。',
    type: 'document' as const,
    state: 'active' as const,
    searchable: true,
    updatedAt: '2026-08-29T08:00:00Z',
    revision: 1,
  },
]
const demoMemories = [
  {
    memoryId: 'm-1',
    teamId: 'team-1',
    projectId: 'orbit-ui',
    content: '服务端记忆：稳定错误码必须保留。',
    layer: 'L1' as const,
    tier: 'project_confirmed' as const,
    sourceEventId: 'seed-event-m-1',
    expiresAt: null,
    scope: 'shared' as const,
    capturedByUserId: 'member-1',
    createdAt: '2026-08-29T08:00:00Z',
    updatedAt: '2026-08-29T08:00:00Z',
    revision: 1,
    status: 'ACTIVE' as const,
    importance: 0.9,
    recallCount: 2,
    lastRecalledAt: null,
    sourceKind: 'agent_turn' as const,
  },
]
const demoAccess = {
  organizations: demoOrganizations,
  projects: [demoProject],
  assets: [
    {
      assetId: 'orbit-ui',
      assetType: 'project' as const,
      name: 'AI开放平台',
      visibility: 'project' as const,
      organizationId: 'org-1',
      projectId: 'orbit-ui',
    },
    {
      assetId: 'skill-review',
      assetType: 'skill' as const,
      name: '代码评审',
      visibility: 'project' as const,
      organizationId: 'org-1',
      projectId: 'orbit-ui',
    },
    { assetId: 'k-1', assetType: 'knowledge' as const, name: 'DSH 规范', visibility: 'organization' as const, organizationId: 'org-1' },
    { assetId: 'k-2', assetType: 'knowledge' as const, name: '接入手册', visibility: 'organization' as const, organizationId: 'org-1' },
    { assetId: 'm-1', assetType: 'memory' as const, name: '稳定错误码', visibility: 'organization' as const, organizationId: 'org-1' },
    { assetId: 'm-4', assetType: 'memory' as const, name: '采集失败不阻塞', visibility: 'organization' as const, organizationId: 'org-1' },
  ],
  management: { organizationIds: [], projectIds: [] },
  revision: 1,
}

const demoWorkspaceState: WorkspaceListState = {
  items: [
    {
      workspaceId: 'ws-1' as WorkspaceId,
      title: 'AI开放平台',
      path: 'hidden',
      sessionIds: [],
      createdAt: '2026-08-29T08:00:00Z',
      updatedAt: '2026-08-29T08:00:00Z',
    },
  ],
  archivedSessionIds: [],
  state: 'idle',
  phase: 'ready',
  error: null,
  baselinesReady: true,
  recentWorkspaceId: 'ws-1' as WorkspaceId,
}

const demoSessionState = {
  ids: ['session-1'],
  current: 'session-1',
  byId: { 'session-1': { blank: false, displayTitle: 'session-1' } },
}

const demoCollectorStatus = {
  mode: 'active' as const,
  projectId: null,
  queueEventCount: 0,
  queueByteCount: 0,
  lastAcceptedAt: null,
  lastFailure: null,
  gapCount: 0,
  authorizationState: 'unknown' as const,
  storageError: null,
}

function demoRemote(): ClientRemote {
  return {
    teamSkills: {
      account: vi.fn(async () => ({ ok: true, value: demoAccount })),
      login: vi.fn(async () => ({ ok: true, value: demoAccount })),
      refreshAccount: vi.fn(async () => ({ ok: true, value: demoAccount })),
      changePassword: vi.fn(async () => ({ ok: true, value: demoAccount })),
      logout: vi.fn(async () => ({ ok: true, value: { status: 'signed-out' as const } })),
      organizations: vi.fn(async () => ({ ok: true, value: demoOrganizations })),
      projects: vi.fn(async () => ({ ok: true, value: [demoProject] })),
      project: vi.fn(async () => ({ ok: true, value: demoProjectDetail })),
      knowledgeBases: vi.fn(async () => ({ ok: true, value: demoKnowledgeBases })),
      knowledgeSearch: vi.fn(async () => ({
        ok: true,
        value: { status: 'ready' as const, response: { requestId: 'req-1', results: [], knowledgeBases: [] } },
      })),
      knowledgePreview: vi.fn(async () => ({
        ok: true,
        value: { knowledgeBaseId: 'k-1', documentId: 'doc-1', title: '预览', previewUrl: 'https://service.test/preview/doc-1' },
      })),
      memoryRecall: vi.fn(async () => ({
        ok: true,
        value: {
          status: 'READY' as const,
          items: [{
            memoryId: 'm-1',
            content: '服务端记忆：稳定错误码必须保留。',
            score: 0.9,
            layer: 'L1' as const,
            recallReason: 'CONTENT_MATCH',
            sourceRunId: 'run-7',
            updatedAt: '2026-09-15T08:00:00.000Z',
            confidence: 0.6,
          }],
          contextText: '服务端记忆：稳定错误码必须保留。',
          strategy: 'fixture',
          effectivePolicy: { topK: 8, relevanceThreshold: 0.4, tokenBudget: 1200 },
        },
      })),
      memoryList: vi.fn(async () => ({ ok: true, value: { items: demoMemories, nextCursor: null, totalEstimate: 1 } })),
      memoryGet: vi.fn(async () => ({ ok: true, value: demoMemories[0] })),
      memoryUpdate: vi.fn(async ({ memoryId, content, expectedRevision }: {
        memoryId: string
        content: string
        expectedRevision: number
      }, _idempotencyKey: string) => ({
        ok: true,
        value: {
          status: 'INDEX_PENDING' as const,
          eventId: 'e-update',
          jobId: 'j-update',
          memory: { ...demoMemories[0], memoryId, content, revision: expectedRevision + 1 },
        },
      })),
      memoryDelete: vi.fn(async () => ({
        ok: true,
        value: { status: 'PENDING' as const, eventId: 'e-delete', jobId: 'j-delete', cleanupStatus: 'PENDING' as const },
      })),
      configureProjectMemory: vi.fn(async () => ({ ok: true as const, value: undefined })),
      clearProjectMemory: vi.fn(async () => ({ ok: true as const, value: undefined })),
      collectorStatus: vi.fn(async () => ({ ok: true as const, value: { status: 'ready' as const, value: demoCollectorStatus } })),
      configureCollectorProject: vi.fn(async () => ({ ok: true as const, value: { projectId: 'orbit-ui' } })),
      clearCollectorProject: vi.fn(async () => ({ ok: true as const, value: { cleared: true as const } })),
      pauseCollector: vi.fn(async () => ({
        ok: true as const,
        value: { status: 'ready' as const, value: { ...demoCollectorStatus, mode: 'paused' as const } },
      })),
      resumeCollector: vi.fn(async () => ({
        ok: true as const,
        value: { status: 'ready' as const, value: { ...demoCollectorStatus, mode: 'active' as const } },
      })),
      flushCollector: vi.fn(async () => ({
        ok: true as const,
        value: { status: 'ready' as const, value: demoCollectorStatus },
      })),
      clearPendingCollectorData: vi.fn(async () => ({
        ok: true as const,
        value: { status: 'ready' as const, value: demoCollectorStatus },
      })),
      configureKnowledgeSelection: vi.fn(async () => ({ ok: true as const, value: undefined })),
      clearKnowledgeSelection: vi.fn(async () => ({ ok: true as const, value: undefined })),
      accessSummary: vi.fn(async () => ({ ok: true, value: demoAccess })),
      catalog: vi.fn(async () => ({ ok: true, value: demoCatalog })),
      installations: vi.fn(async () => ({ ok: true, value: [] })),
      syncReleaseStatus: vi.fn(async () => ({ ok: true, value: [] })),
      uninstallSkill: vi.fn(async () => ({ ok: true, value: [] })),
      installSkill: vi.fn(async () => ({
        ok: true,
        value: {
          status: 'succeeded',
          installation: {
            localInstallationId: 'local-1',
            skillId: 'skill-review',
            projectId: 'orbit-ui',
            scope: 'project',
            workspaceId: 'ws-1',
            runtimeName: 'code-review',
            version: '2.4.0',
            artifactSha256: 'abc',
            state: 'normal',
            installedAt: '2026-08-29T08:00:00Z',
          },
        },
      })),
    },
    cloudWorkspaces: {
      workspacePlans: vi.fn(async () => ({ ok: true as const, value: { status: 'ready' as const, fixtureOnly: true, value: [] } })),
      agentProfiles: vi.fn(async () => ({
        ok: true as const,
        value: {
          status: 'ready' as const,
          fixtureOnly: true,
          value: [{
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
            agentTypeCapabilities: ['terminal'],
            model: 'deepseek-v3.2',
            reasoning: 'medium',
            skills: [],
            knowledgeBases: [],
            memory: null,
            executionPolicy: { permission_mode: 'approval', write_mode: 'write' },
            typeExtension: {},
            typeExtensionOpaqueKeys: [],
            readiness: 'ready',
            unavailableReason: null,
            default: true,
            status: 'published' as const,
            createdBy: '平台管理员',
            publishedAt: '2026-09-01T00:00:00.000Z',
            updatedAt: '2026-09-02T00:00:00.000Z',
          }],
        },
      })),
      agentProfileVersion: vi.fn(async () => ({ ok: true as const, value: { status: 'signed-out' as const } })),
    },
  } as unknown as ClientRemote
}

function signedOutRemote(): ClientRemote {
  const remote = demoRemote()
  remote.teamSkills.account = vi.fn(async () => ({ ok: true as const, value: { status: 'signed-out' as const } }))
  return remote
}

function mountSurface(controller = new PlatformDemoController(), remote = demoRemote()) {
  const props = {
    controller,
    t,
    useSessions: (<S,>(selector: (state: typeof demoSessionState) => S): S => selector(demoSessionState)) as never,
    useWorkspaces: (<S,>(selector: (state: WorkspaceListState) => S): S => selector(demoWorkspaceState)) as never,
    remote,
    layout: { openRightbar: vi.fn(), closeRightbar: vi.fn(), toggleSidebar: () => {}, openDetails: () => {}, closeDetails: () => {} },
  } as unknown as PlatformSurfaceProps
  return { controller, ...render(<PlatformSurface {...props} />) }
}

it('binds selected knowledge bases to the current native DSH session and clears them on project changes', async () => {
  const controller = new PlatformDemoController()
  controller.open()
  const remote = demoRemote()
  mountSurface(controller, remote)

  expect(await screen.findByRole('heading', { name: '从权限范围内的资产开始协作' })).toBeTruthy()
  fireEvent.change(screen.getByLabelText('当前项目'), { target: { value: 'orbit-ui' } })
  await waitFor(() => {
    expect(screen.getByLabelText('当前项目')).toHaveProperty('value', 'orbit-ui')
  })
  fireEvent.click(within(screen.getByRole('navigation', { name: '平台模块' })).getByRole('button', { name: '知识库' }))
  await screen.findByText('DSH 会话事件与模型可见性规范')
  const knowledgeRow = screen.getByText('DSH 会话事件与模型可见性规范').closest('label')
  if (knowledgeRow === null) throw new Error('knowledge row not found')
  const knowledgeInput = knowledgeRow.querySelector('input')
  if (knowledgeInput === null) throw new Error('knowledge input not found')
  fireEvent.click(knowledgeInput)

  await waitFor(() => {
    expect(remote.teamSkills.configureKnowledgeSelection).toHaveBeenCalledWith('session-1', {
      projectId: 'orbit-ui',
      knowledgeBaseIds: ['k-1'],
    })
  })

  fireEvent.change(screen.getByLabelText('当前项目'), { target: { value: '' } })
  await waitFor(() => {
    expect(remote.teamSkills.clearKnowledgeSelection).toHaveBeenCalledWith('session-1')
  })
})

it('shows an explicit empty asset state when the selected project has no assets', async () => {
  const controller = new PlatformDemoController()
  const remote = demoRemote()
  remote.teamSkills.project = vi.fn(async () => ({
    ok: true as const,
    value: {
      project: { ...demoProject, assetCount: 0 },
      assets: [],
    },
  }))
  controller.open()
  mountSurface(controller, remote)

  expect(await screen.findByRole('heading', { name: '从权限范围内的资产开始协作' })).toBeTruthy()
  fireEvent.change(screen.getByLabelText('当前项目'), { target: { value: 'orbit-ui' } })
  await waitFor(() => {
    expect(screen.getByLabelText('当前项目')).toHaveProperty('value', 'orbit-ui')
  })
  fireEvent.click(within(screen.getByRole('navigation', { name: '平台模块' })).getByRole('button', { name: '项目' }))
  const empty = await screen.findByRole('status', { name: '暂无关联资产' })
  expect(empty.getAttribute('data-state')).toBe('empty')
  expect(screen.getByText('当前项目尚未关联 Skill、知识库或记忆库。')).toBeTruthy()
})

it('serializes project-memory binding changes so stale configuration cannot win', async () => {
  const controller = new PlatformDemoController()
  controller.open()
  const remote = demoRemote()
  let releaseFirst: (() => void) | undefined
  const firstConfiguration = new Promise<void>((resolve) => {
    releaseFirst = resolve
  })
  const configureProjectMemory = vi.fn(async (_sessionId: string, selectedProjectId: string) => {
    if (selectedProjectId === 'orbit-ui' && configureProjectMemory.mock.calls.length === 1) await firstConfiguration
    return { ok: true as const, value: undefined }
  })
  remote.teamSkills.configureProjectMemory = configureProjectMemory
  mountSurface(controller, remote)

  expect(await screen.findByRole('heading', { name: '从权限范围内的资产开始协作' })).toBeTruthy()
  fireEvent.change(screen.getByLabelText('当前项目'), { target: { value: 'orbit-ui' } })
  await waitFor(() => {
    expect(remote.teamSkills.configureProjectMemory).toHaveBeenCalledWith('session-1', 'orbit-ui')
  })
  fireEvent.change(screen.getByLabelText('当前项目'), { target: { value: '' } })
  fireEvent.change(screen.getByLabelText('当前项目'), { target: { value: 'orbit-ui' } })
  await Promise.resolve()
  expect(remote.teamSkills.configureProjectMemory).toHaveBeenCalledTimes(1)
  releaseFirst?.()
  await waitFor(() => {
    expect(remote.teamSkills.configureProjectMemory).toHaveBeenCalledTimes(2)
    expect(remote.teamSkills.clearProjectMemory).toHaveBeenCalledWith('session-1')
  })
})

it('shows a configure rejection and does not retain a local knowledge binding', async () => {
  const controller = new PlatformDemoController()
  controller.open()
  const remote = demoRemote()
  remote.teamSkills.configureKnowledgeSelection = vi.fn(async () => ({
    ok: false as const,
    error: { code: 'SESSION_NOT_FOUND', message: '当前 DSH 会话已结束。', details: {} },
  }))
  mountSurface(controller, remote)

  expect(await screen.findByRole('heading', { name: '从权限范围内的资产开始协作' })).toBeTruthy()
  fireEvent.change(screen.getByLabelText('当前项目'), { target: { value: 'orbit-ui' } })
  await waitFor(() => {
    expect(screen.getByLabelText('当前项目')).toHaveProperty('value', 'orbit-ui')
  })
  fireEvent.click(within(screen.getByRole('navigation', { name: '平台模块' })).getByRole('button', { name: '知识库' }))
  const knowledgeRow = (await screen.findByText('DSH 会话事件与模型可见性规范')).closest('label')
  if (knowledgeRow === null) throw new Error('knowledge row not found')
  const knowledgeInput = knowledgeRow.querySelector('input')
  if (knowledgeInput === null) throw new Error('knowledge input not found')
  fireEvent.click(knowledgeInput)

  expect((await screen.findByRole('alert')).textContent).toContain('当前 DSH 会话已结束。')
  fireEvent.change(screen.getByLabelText('当前项目'), { target: { value: '' } })
  await waitFor(() => {
    expect(remote.teamSkills.clearKnowledgeSelection).not.toHaveBeenCalled()
  })
})

it('shows a clear rejection without attempting a new local binding', async () => {
  const controller = new PlatformDemoController()
  controller.open()
  const remote = demoRemote()
  remote.teamSkills.clearKnowledgeSelection = vi.fn(async () => ({
    ok: false as const,
    error: { code: 'SESSION_NOT_FOUND', message: '当前 DSH 会话已结束。', details: {} },
  }))
  mountSurface(controller, remote)

  expect(await screen.findByRole('heading', { name: '从权限范围内的资产开始协作' })).toBeTruthy()
  fireEvent.change(screen.getByLabelText('当前项目'), { target: { value: 'orbit-ui' } })
  await waitFor(() => {
    expect(screen.getByLabelText('当前项目')).toHaveProperty('value', 'orbit-ui')
  })
  fireEvent.click(within(screen.getByRole('navigation', { name: '平台模块' })).getByRole('button', { name: '知识库' }))
  const knowledgeRow = (await screen.findByText('DSH 会话事件与模型可见性规范')).closest('label')
  if (knowledgeRow === null) throw new Error('knowledge row not found')
  const knowledgeInput = knowledgeRow.querySelector('input')
  if (knowledgeInput === null) throw new Error('knowledge input not found')
  fireEvent.click(knowledgeInput)
  await waitFor(() => {
    expect(remote.teamSkills.configureKnowledgeSelection).toHaveBeenCalled()
  })

  fireEvent.change(screen.getByLabelText('当前项目'), { target: { value: '' } })
  expect((await screen.findByRole('alert')).textContent).toContain('当前 DSH 会话已结束。')
  expect(remote.teamSkills.configureKnowledgeSelection).toHaveBeenCalledTimes(1)
})

describe('AI Coding platform demo', () => {
  it('enters the asset overview immediately after Host authentication', async () => {
    const controller = new PlatformDemoController()
    controller.open()
    const props = {
      controller,
      t,
      layout: { openRightbar: vi.fn(), closeRightbar: vi.fn(), toggleSidebar: () => {}, openDetails: () => {}, closeDetails: () => {} },
      useSessions: (() => ({ ids: [], current: undefined, byId: {} })) as never,
      useWorkspaces: (<S,>(selector: (state: WorkspaceListState) => S): S => selector(demoWorkspaceState)) as never,
      remote: signedOutRemote(),
    } as unknown as PlatformSurfaceProps
    render(<PlatformSurface {...props} />)

    expect(await screen.findByRole('heading', { name: '登录你的编程协作台' })).toBeTruthy()
    expect(screen.queryByRole('heading', { name: '从权限范围内的资产开始协作' })).toBeNull()

    fireEvent.change(screen.getByLabelText('用户名或邮箱'), { target: { value: 'member@example.com' } })
    fireEvent.change(screen.getByLabelText('访问密码'), { target: { value: 'secret' } })
    fireEvent.click(screen.getByRole('button', { name: '登录' }))
    expect(await screen.findByRole('heading', { name: '从权限范围内的资产开始协作' })).toBeTruthy()
    expect(screen.queryByRole('heading', { name: '选择项目' })).toBeNull()
    expect(screen.queryByRole('heading', { name: '选择组织' })).toBeNull()
  })

  it('accepts a username as well as an email address at the account gate', async () => {
    const controller = new PlatformDemoController()
    controller.open()
    render(
      <PlatformSurface
        {...({
          controller,
          t,
          layout: { openRightbar: vi.fn(), closeRightbar: vi.fn(), toggleSidebar: () => {}, openDetails: () => {}, closeDetails: () => {} },
          useSessions: (() => ({ ids: [], current: undefined, byId: {} })) as never,
          useWorkspaces: (<S,>(selector: (state: WorkspaceListState) => S): S => selector(demoWorkspaceState)) as never,
          remote: signedOutRemote(),
        } as unknown as PlatformSurfaceProps)}
      />,
    )

    const accountInput = await screen.findByLabelText('用户名或邮箱')
    expect(accountInput).toHaveProperty('type', 'text')
    expect(accountInput).toHaveProperty('inputMode', 'text')
  })

  it('shows an explicit service error when access loading rejects', async () => {
    const remote = demoRemote()
    remote.teamSkills.projects = vi.fn(async () => {
      throw new Error('项目访问接口未装配')
    })
    const controller = new PlatformDemoController()
    controller.open()
    mountSurface(controller, remote)

    expect(await screen.findByRole('heading', { name: '服务暂时不可用' })).toBeTruthy()
    // Substring, not exact: the panel now appends the endpoint it failed against,
    // because `Failed to fetch` alone tells an operator something is unreachable
    // but not *what*.
    expect(screen.getByText(/项目访问接口未装配/u)).toBeTruthy()
    // The address is the actionable half of that message — a wrong or moved
    // endpoint is exactly the case this panel has to make visible.
    expect(screen.getByText(/当前服务地址：/u)).toBeTruthy()
  })

  // 0.1.5 replaced ILayout's pixel-width geometry call `reserveRight(px)` with a
  // presentation report — `openRightbar(track, fullscreen)` / `closeRightbar()` —
  // so the frame owns the track width and the overlay no longer measures itself.
  // The assertion follows the new contract: retract while undocked, report a
  // reserved (non-fullscreen) track while docked, retract on cleanup.
  it('reports the docked right panel to the frame and retracts it on close', async () => {
    const layout = { openRightbar: vi.fn(), closeRightbar: vi.fn(), toggleSidebar: vi.fn(), openDetails: vi.fn(), closeDetails: vi.fn() }
    const controller = new PlatformDemoController()
    controller.open()
    const props = {
      controller,
      t,
      useSessions: (<S,>(selector: (state: typeof demoSessionState) => S): S => selector(demoSessionState)) as never,
      useWorkspaces: (<S,>(selector: (state: WorkspaceListState) => S): S => selector(demoWorkspaceState)) as never,
      remote: demoRemote(),
      layout,
    } as unknown as PlatformSurfaceProps
    const view = render(<PlatformSurface {...props} />)
    // Overview is the full-screen modal: no track is reported, and any stale
    // report is retracted.
    expect(layout.closeRightbar).toHaveBeenCalled()
    expect(layout.openRightbar).not.toHaveBeenCalled()
    const retractsAfterOverview = layout.closeRightbar.mock.calls.length
    fireEvent.click(await screen.findByRole('button', { name: '云工作空间' }))
    // Docked: a reserved grid track, not a fullscreen cover.
    expect(layout.openRightbar).toHaveBeenCalledWith(true, false)
    view.unmount()
    expect(layout.closeRightbar.mock.calls.length).toBeGreaterThan(retractsAfterOverview)
  })

  it('opens from the sidebar entry and closes from the overlay', () => {
    const controller = new PlatformDemoController()
    const onOpen = () => {
      controller.open()
    }
    const entryProps = {
      wide: true,
      onOpen,
      t,
      layout: { openRightbar: vi.fn(), closeRightbar: vi.fn(), toggleSidebar: () => {}, openDetails: () => {}, closeDetails: () => {} },
      useSessions: (() => ({ ids: [], current: undefined, byId: {} })) as never,
      useWorkspaces: (() => ({})) as never,
    } as Parameters<typeof PlatformEntry>[0]
    const entry = render(<PlatformEntry {...entryProps} />)
    fireEvent.click(screen.getByRole('button', { name: '打开编程协作台' }))
    expect(controller.getSnapshot()).toBe(true)
    entry.unmount()

    mountSurface(controller)
    fireEvent.click(screen.getByRole('button', { name: '关闭编程协作台' }))
    expect(controller.getSnapshot()).toBe(false)
  })

  it('leaves the native DSH surface visible until the sidebar entry is clicked', () => {
    const controller = new PlatformDemoController()
    mountSurface(controller)
    expect(screen.queryByRole('dialog', { name: '编程协作台' })).toBeNull()
  })

  it('keeps non-Skill demo modules available while Skill uses the Host Remote', async () => {
    const controller = new PlatformDemoController()
    controller.open()
    mountSurface(controller)

    expect(await screen.findByRole('heading', { name: '从权限范围内的资产开始协作' })).toBeTruthy()
    const nav = screen.getByRole('navigation', { name: '平台模块' })
    fireEvent.click(within(nav).getByRole('button', { name: '团队 Skill' }))
    expect(await screen.findByRole('heading', { name: '选择项目后查看 Skill' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'AI开放平台' }))
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: '把已发布能力安装到本地 DSH' })).toBeTruthy()
    })
    fireEvent.click(screen.getByRole('button', { name: '安装 Skill' }))
    fireEvent.click(screen.getByRole('button', { name: '确认安装到当前项目' }))
    expect(await screen.findByText('已安装到当前项目')).toBeTruthy()

    fireEvent.click(within(nav).getByRole('button', { name: '知识库' }))
    expect(await screen.findByText('远程执行目标接入手册')).toBeTruthy()

    fireEvent.click(within(nav).getByRole('button', { name: '记忆库' }))
    expect((await screen.findAllByText('服务端记忆：稳定错误码必须保留。')).length).toBeGreaterThan(0)

    fireEvent.click(within(nav).getByRole('button', { name: 'AI Coding 可观测' }))
    expect((await screen.findAllByText('采集中')).length).toBeGreaterThan(0)
    fireEvent.click(screen.getByRole('button', { name: '暂停采集' }))
    expect((await screen.findAllByText('已暂停')).length).toBeGreaterThan(0)

    fireEvent.click(within(nav).getByRole('button', { name: 'Agent 配置' }))
    // The page reads the project's published versions through the Host Remote.
    expect(await screen.findByText('默认研发代理')).toBeTruthy()
    expect(screen.getAllByText('fixture-only').length).toBeGreaterThan(0)
    expect(screen.queryByRole('button', { name: '保存配置' })).toBeNull()
    expect(screen.queryByRole('button', { name: '发布' })).toBeNull()

    expect(screen.queryByRole('button', { name: '工作台' })).toBeNull()

    fireEvent.click(within(nav).getByRole('button', { name: '项目' }))
    expect(screen.getByRole('heading', { name: 'AI开放平台', level: 1 })).toBeTruthy()
    expect(screen.getByText('项目级操作由后台管理')).toBeTruthy()
    expect(screen.queryByText('任务列表')).toBeNull()
  })

  it('does not render knowledge or memory outside the selected project access summary', async () => {
    const controller = new PlatformDemoController()
    controller.open()
    mountSurface(controller)

    expect(await screen.findByRole('heading', { name: '从权限范围内的资产开始协作' })).toBeTruthy()
    const nav = screen.getByRole('navigation', { name: '平台模块' })
    fireEvent.change(screen.getByLabelText('当前项目'), { target: { value: 'orbit-ui' } })
    await waitFor(() => {
      expect(screen.getByLabelText('当前项目')).toHaveProperty('value', 'orbit-ui')
    })
    fireEvent.click(within(nav).getByRole('button', { name: '知识库' }))
    expect(screen.getByText('DSH 会话事件与模型可见性规范')).toBeTruthy()
    expect(screen.queryByText('前端组件可访问性基线')).toBeNull()

    fireEvent.click(within(nav).getByRole('button', { name: '记忆库' }))
    expect((await screen.findAllByText('服务端记忆：稳定错误码必须保留。')).length).toBeGreaterThan(0)
  })

  it('renders the server-authorized catalog as returned instead of filtering skills in the browser', async () => {
    const remote = demoRemote()
    remote.teamSkills.catalog = vi.fn(async () => ({
      ok: true as const,
      value: {
        status: 'ready' as const,
        catalog: {
          items: [
            ...demoCatalog.catalog.items,
            {
              skillId: 'restricted-skill',
              displayName: '受限 Skill',
              runtimeName: 'restricted-skill',
              summary: '不应向当前项目显示。',
              version: '1.0.0',
              category: '质量',
              tags: ['受限'],
              publishedAt: '2026-08-30T00:00:00Z',
            },
          ],
        },
      },
    }))
    const controller = new PlatformDemoController()
    controller.open()
    mountSurface(controller, remote)

    expect(await screen.findByRole('heading', { name: '从权限范围内的资产开始协作' })).toBeTruthy()
    const nav = screen.getByRole('navigation', { name: '平台模块' })
    fireEvent.click(within(nav).getByRole('button', { name: '团队 Skill' }))
    fireEvent.click(screen.getByRole('button', { name: 'AI开放平台' }))

    expect(await screen.findByText('代码评审')).toBeTruthy()
    expect(await screen.findByText('受限 Skill')).toBeTruthy()
  })

  it.each(['PROJECT_NOT_MEMBER', 'RESOURCE_NOT_FOUND', 'NO_ORGANIZATION_ACCESS'])(
    'refreshes the service authorization after Team Skill returns %s',
    async (code) => {
      const remote = demoRemote()
      remote.teamSkills.catalog = vi.fn(async () => ({
        ok: false as const,
        error: { code, message: '当前项目授权已变更。', details: {} },
      }))
      remote.teamSkills.accessSummary = vi
        .fn()
        .mockResolvedValueOnce({ ok: true, value: demoAccess })
        .mockResolvedValueOnce({
          ok: true,
          value: { ...demoAccess, projects: [], assets: [] },
        })
        .mockResolvedValue({ ok: true, value: { ...demoAccess, projects: [], assets: [] } })
      remote.teamSkills.projects = vi
        .fn()
        .mockResolvedValueOnce({ ok: true, value: [demoProject] })
        .mockResolvedValue({ ok: true, value: [] })
      const controller = new PlatformDemoController()
      controller.open()
      mountSurface(controller, remote)

      expect(await screen.findByRole('heading', { name: '从权限范围内的资产开始协作' })).toBeTruthy()
      const nav = screen.getByRole('navigation', { name: '平台模块' })
      fireEvent.click(within(nav).getByRole('button', { name: '团队 Skill' }))
      fireEvent.click(screen.getByRole('button', { name: 'AI开放平台' }))

      expect(await screen.findByText('当前账号没有可访问的项目。')).toBeTruthy()
    },
  )

  it('shows the local login state after signing out', async () => {
    const controller = new PlatformDemoController()
    controller.open()
    mountSurface(controller)
    expect(await screen.findByRole('heading', { name: '从权限范围内的资产开始协作' })).toBeTruthy()
    fireEvent.click(await screen.findByRole('button', { name: '账号与权限：成员甲' }))
    fireEvent.click(screen.getByRole('button', { name: '退出登录' }))
    expect(await screen.findByRole('heading', { name: '登录你的编程协作台' })).toBeTruthy()
    fireEvent.change(screen.getByLabelText('用户名或邮箱'), { target: { value: 'member@example.com' } })
    fireEvent.change(screen.getByLabelText('访问密码'), { target: { value: 'secret' } })
    fireEvent.click(screen.getByRole('button', { name: '登录' }))
    expect(await screen.findByRole('heading', { name: '从权限范围内的资产开始协作' })).toBeTruthy()
  })

  it('keeps the selected project while browsing project details without a second selector', async () => {
    const controller = new PlatformDemoController()
    controller.open()
    mountSurface(controller)
    expect(await screen.findByRole('heading', { name: '从权限范围内的资产开始协作' })).toBeTruthy()
    fireEvent.change(screen.getByLabelText('当前项目'), { target: { value: 'orbit-ui' } })
    await waitFor(() => {
      expect(screen.getByLabelText('当前项目')).toHaveProperty('value', 'orbit-ui')
    })
    fireEvent.click(screen.getByRole('button', { name: '项目' }))
    expect(screen.getByRole('heading', { name: 'AI开放平台', level: 1 })).toBeTruthy()
    expect(screen.queryByRole('combobox', { name: '查看项目' })).toBeNull()
    expect(screen.getByLabelText('当前项目')).toHaveProperty('value', 'orbit-ui')
  })
})

it('loads project memories from the service and updates them with the server revision', async () => {
  const controller = new PlatformDemoController()
  controller.open()
  const remote = demoRemote()
  mountSurface(controller, remote)
  expect(await screen.findByRole('heading', { name: '从权限范围内的资产开始协作' })).toBeTruthy()
  fireEvent.change(screen.getByLabelText('当前项目'), { target: { value: 'orbit-ui' } })
  await waitFor(() => {
    expect(screen.getByLabelText('当前项目')).toHaveProperty('value', 'orbit-ui')
  })
  fireEvent.click(within(screen.getByRole('navigation', { name: '平台模块' })).getByRole('button', { name: '记忆库' }))
  expect((await screen.findAllByText('服务端记忆：稳定错误码必须保留。')).length).toBeGreaterThan(0)
  fireEvent.click(screen.getByRole('button', { name: '查看记忆 m-1' }))
  fireEvent.click(screen.getByRole('button', { name: '编辑记忆' }))
  const editor = screen.getByRole('textbox', { name: '记忆正文' })
  fireEvent.change(editor, { target: { value: '服务端记忆已更新。' } })
  fireEvent.click(screen.getByRole('button', { name: '保存记忆' }))
  await waitFor(() => {
    // 0-3：编辑保存必须携带非空幂等键（插件侧 crypto.randomUUID 生成）。
    expect(remote.teamSkills.memoryUpdate).toHaveBeenCalledWith({ memoryId: 'm-1', content: '服务端记忆已更新。', expectedRevision: 1 }, expect.any(String))
  })
  fireEvent.click(screen.getByRole('button', { name: '编辑记忆' }))
  fireEvent.change(screen.getByRole('textbox', { name: '记忆正文' }), { target: { value: '服务端记忆二次更新。' } })
  fireEvent.click(screen.getByRole('button', { name: '保存记忆' }))
  await waitFor(() => {
    expect(remote.teamSkills.memoryUpdate).toHaveBeenLastCalledWith({ memoryId: 'm-1', content: '服务端记忆二次更新。', expectedRevision: 2 }, expect.any(String))
  })
})

it('shows why each memory was recalled, with its run, update time and confidence', async () => {
  const controller = new PlatformDemoController()
  controller.open()
  const remote = demoRemote()
  mountSurface(controller, remote)
  expect(await screen.findByRole('heading', { name: '从权限范围内的资产开始协作' })).toBeTruthy()
  fireEvent.change(screen.getByLabelText('当前项目'), { target: { value: 'orbit-ui' } })
  await waitFor(() => {
    expect(screen.getByLabelText('当前项目')).toHaveProperty('value', 'orbit-ui')
  })
  fireEvent.click(within(screen.getByRole('navigation', { name: '平台模块' })).getByRole('button', { name: '记忆库' }))

  const region = await screen.findByRole('region', { name: '记忆召回' })
  // 召回是按需读取：进入页面不得自动拉取，否则会被当成第二份记忆列表。
  expect(remote.teamSkills.memoryRecall).not.toHaveBeenCalled()
  fireEvent.click(within(region).getByRole('button', { name: '查看召回' }))

  await waitFor(() => {
    expect(within(region).getByText(/命中 1 条记忆/)).toBeTruthy()
  })
  expect(region.querySelector('[data-verdict]')?.getAttribute('data-verdict')).toBe('ready')
  const row = within(region).getByText(/召回原因：正文匹配/)
  expect(row.textContent).toContain('置信度 0.60')
  expect(row.textContent).toContain('来源运行 run-7')
  expect(row.textContent).toContain('2026-09-15T08:00:00.000Z')
})

it('does not let an older memory detail response replace the selected record', async () => {
  const firstMemory = demoMemories[0]!
  const secondMemory = {
    ...firstMemory,
    memoryId: 'm-2',
    content: '第二条服务端记忆。',
  }
  const remote = demoRemote()
  remote.teamSkills.memoryList = vi.fn(async () => ({
    ok: true as const,
    value: { items: [firstMemory, secondMemory], nextCursor: null, totalEstimate: 2 },
  }))
  let releaseFirst: (() => void) | undefined
  const firstDetail = new Promise<void>((resolve) => {
    releaseFirst = resolve
  })
  remote.teamSkills.memoryGet = vi.fn(async (memoryId: string) => {
    if (memoryId === 'm-1') await firstDetail
    return {
      ok: true as const,
      value: memoryId === 'm-1' ? firstMemory : secondMemory,
    }
  })
  const controller = new PlatformDemoController()
  controller.open()
  mountSurface(controller, remote)
  expect(await screen.findByRole('heading', { name: '从权限范围内的资产开始协作' })).toBeTruthy()
  fireEvent.change(screen.getByLabelText('当前项目'), { target: { value: 'orbit-ui' } })
  await waitFor(() => {
    expect(screen.getByLabelText('当前项目')).toHaveProperty('value', 'orbit-ui')
  })
  fireEvent.click(within(screen.getByRole('navigation', { name: '平台模块' })).getByRole('button', { name: '记忆库' }))
  expect((await screen.findAllByText(firstMemory.content)).length).toBeGreaterThan(0)
  fireEvent.click(screen.getByRole('button', { name: `查看记忆 ${firstMemory.memoryId}` }))
  fireEvent.click(screen.getByRole('button', { name: `查看记忆 ${secondMemory.memoryId}` }))
  releaseFirst?.()
  await waitFor(() => {
    expect(screen.getAllByText(secondMemory.content).length).toBeGreaterThan(0)
  })
})

it('searches project memories through the service and appends the next cursor page', async () => {
  const firstMemory = demoMemories[0]!
  const secondMemory = { ...firstMemory, memoryId: 'm-2', content: '游标页记忆：搜索结果必须来自服务端。' }
  const remote = demoRemote()
  remote.teamSkills.memoryList = vi.fn(async ({ keyword, cursor }: { keyword?: string; cursor?: string }) => {
    if (cursor === 'cursor-1') {
      return {
        ok: true as const,
        value: { items: [firstMemory], nextCursor: null, totalEstimate: 2 },
      }
    }
    if (keyword === '游标') {
      return {
        ok: true as const,
        value: { items: [secondMemory], nextCursor: 'cursor-1', totalEstimate: 2 },
      }
    }
    return { ok: true as const, value: { items: demoMemories, nextCursor: null, totalEstimate: 1 } }
  })
  const controller = new PlatformDemoController()
  controller.open()
  mountSurface(controller, remote)
  expect(await screen.findByRole('heading', { name: '从权限范围内的资产开始协作' })).toBeTruthy()
  fireEvent.change(screen.getByLabelText('当前项目'), { target: { value: 'orbit-ui' } })
  await waitFor(() => {
    expect(screen.getByLabelText('当前项目')).toHaveProperty('value', 'orbit-ui')
  })
  fireEvent.click(within(screen.getByRole('navigation', { name: '平台模块' })).getByRole('button', { name: '记忆库' }))
  expect((await screen.findAllByText('服务端记忆：稳定错误码必须保留。')).length).toBeGreaterThan(0)

  fireEvent.change(screen.getByRole('searchbox', { name: '搜索记忆' }), { target: { value: '游标' } })
  fireEvent.click(screen.getByRole('button', { name: '搜索记忆' }))
  await waitFor(() => {
    expect(remote.teamSkills.memoryList).toHaveBeenLastCalledWith({ projectId: 'orbit-ui', keyword: '游标', limit: 50 })
  })
  expect((await screen.findAllByText('游标页记忆：搜索结果必须来自服务端。')).length).toBeGreaterThan(0)

  fireEvent.click(screen.getByRole('button', { name: '加载更多记忆' }))
  await waitFor(() => {
    expect(remote.teamSkills.memoryList).toHaveBeenLastCalledWith({ projectId: 'orbit-ui', keyword: '游标', cursor: 'cursor-1', limit: 50 })
  })
  expect((await screen.findAllByText('游标页记忆：搜索结果必须来自服务端。')).length).toBeGreaterThan(0)
  expect((await screen.findAllByText('服务端记忆：稳定错误码必须保留。')).length).toBeGreaterThan(0)
})
