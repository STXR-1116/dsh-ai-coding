// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ClientRemote } from '@deepseek-ai/dsh-api-remotes/client'
import type { WorkspaceListState } from './helpers/client-runtime-types.ts'
import type { PlatformSurfaceProps } from '../src/client/PlatformSurface.tsx'
import { PlatformSurface } from '../src/client/PlatformSurface.tsx'
import { PlatformDemoController } from '../src/client/controller.ts'

afterEach(() => {
  cleanup()
  window.localStorage.clear()
})

const copy = {
  'platform.name': '编程协作台',
  'platform.shortName': '协作台',
  'platform.open': '打开编程协作台',
  'platform.close': '关闭编程协作台',
}

const t = (key: string): string => copy[key as keyof typeof copy] ?? key

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
const demoProjectDetail = { project: demoProject, assets: [] }
const demoAccess = {
  organizations: demoOrganizations,
  projects: [demoProject],
  assets: [
    {
      assetId: 'skill-review',
      assetType: 'skill' as const,
      name: '代码评审',
      visibility: 'project' as const,
      organizationId: 'org-1',
      projectId: 'orbit-ui',
    },
  ],
  management: { organizationIds: ['org-1'], projectIds: ['orbit-ui'] },
  revision: 1,
}

const demoWorkspaceState: WorkspaceListState = {
  items: [],
  archivedSessionIds: [],
  state: 'idle',
  phase: 'ready',
  error: null,
  baselinesReady: true,
  recentWorkspaceId: undefined,
}

const demoSessionState = {
  ids: ['session-1'],
  current: 'session-1',
  byId: { 'session-1': { blank: false, displayTitle: 'session-1' } },
}

const demoCloudWorkspace = {
  workspaceId: 'cws-1',
  projectId: 'orbit-ui',
  ownerUserId: 'member-1',
  repositoryId: 'repo-1',
  branch: 'main',
  displayName: 'AI开放平台/main',
  defaultAgentProfileVersionId: 'apv-1',
  status: 'ready' as const,
  revision: 3,
  lastError: null,
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-02T00:00:00.000Z',
}

const demoRun = {
  runId: 'run-1',
  projectId: 'orbit-ui',
  workspaceId: 'cws-1',
  sessionId: 'session-1',
  agentProfileVersionId: 'apv-1',
  assetVersionIds: [],
  executionPolicy: { permission_mode: 'approval', write_mode: 'write' },
  workspaceRevision: 3,
  status: 'succeeded' as const,
  writeMode: 'write' as const,
  leaseId: null,
  revision: 2,
  errorCode: null,
  createdAt: '2026-09-02T01:00:00.000Z',
  updatedAt: '2026-09-02T01:05:00.000Z',
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

const demoMemory = {
  memoryId: 'm-1',
  teamId: 'team-1',
  projectId: 'orbit-ui',
  content: '服务端记忆：稳定错误码必须保留。',
  layer: 'L1' as const,
  capturedByUserId: 'member-1',
  createdAt: '2026-08-29T08:00:00Z',
  updatedAt: '2026-08-29T09:00:00Z',
  revision: 1,
  status: 'ACTIVE' as const,
  importance: 0.9,
  recallCount: 2,
  lastRecalledAt: null,
  sourceKind: 'agent_turn' as const,
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
        value: {
          status: 'ready' as const,
          response: {
            requestId: 'req-1',
            results: [
              { knowledgeId: 'doc-1', knowledgeBaseId: 'k-1', title: '预览命中', snippet: '规范片段', sourceUrl: 'https://service.test/doc-1', score: 0.9 },
            ],
            knowledgeBases: [],
          },
        },
      })),
      knowledgePreview: vi.fn(async () => ({
        ok: true,
        value: { knowledgeBaseId: 'k-1', documentId: 'doc-1', title: '预览', previewUrl: 'https://service.test/preview/doc-1' },
      })),
      memoryList: vi.fn(async () => ({ ok: true, value: { items: [demoMemory], nextCursor: null, totalEstimate: 1 } })),
      memoryGet: vi.fn(async () => ({ ok: true, value: demoMemory })),
      memoryUpdate: vi.fn(async ({ content, expectedRevision }: { content: string; expectedRevision: number }) => ({
        ok: true,
        value: { status: 'INDEX_PENDING' as const, eventId: 'e-update', jobId: 'j-update', memory: { ...demoMemory, content, revision: expectedRevision + 1 } },
      })),
      memoryDelete: vi.fn(async () => ({
        ok: true,
        value: { status: 'PENDING' as const, eventId: 'e-delete', jobId: 'j-delete', cleanupStatus: 'PENDING' as const },
      })),
      configureProjectMemory: vi.fn(async () => ({ ok: true as const, value: undefined })),
      clearProjectMemory: vi.fn(async () => ({ ok: true as const, value: undefined })),
      collectorStatus: vi.fn(async () => ({
        ok: true as const,
        value: {
          status: 'ready' as const,
          value: {
            mode: 'active' as const,
            projectId: 'orbit-ui',
            queueEventCount: 7,
            queueByteCount: 4096,
            lastAcceptedAt: '2026-09-12T08:00:00Z',
            lastFailure: { stage: 'deliver', code: 'GATEWAY_TIMEOUT', at: '2026-09-12T07:59:00Z', summary: '网关超时' },
            gapCount: 0,
            authorizationState: 'authorized' as const,
            storageError: null,
          },
        },
      })),
      configureCollectorProject: vi.fn(async () => ({ ok: true as const, value: { projectId: 'orbit-ui' } })),
      clearCollectorProject: vi.fn(async () => ({ ok: true as const, value: { cleared: true as const } })),
      pauseCollector: vi.fn(async () => ({ ok: true as const, value: { status: 'ready' as const, value: { mode: 'active' as const, projectId: 'orbit-ui', queueEventCount: 7, queueByteCount: 4096, lastAcceptedAt: '2026-09-12T08:00:00Z', lastFailure: null, gapCount: 0, authorizationState: 'authorized' as const, storageError: null } } })),
      resumeCollector: vi.fn(async () => ({ ok: true as const, value: { status: 'ready' as const, value: { mode: 'active' as const, projectId: 'orbit-ui', queueEventCount: 7, queueByteCount: 4096, lastAcceptedAt: '2026-09-12T08:00:00Z', lastFailure: null, gapCount: 0, authorizationState: 'authorized' as const, storageError: null } } })),
      flushCollector: vi.fn(async () => ({ ok: true as const, value: { status: 'ready' as const, value: { mode: 'active' as const, projectId: 'orbit-ui', queueEventCount: 7, queueByteCount: 4096, lastAcceptedAt: '2026-09-12T08:00:00Z', lastFailure: null, gapCount: 0, authorizationState: 'authorized' as const, storageError: null } } })),
      clearPendingCollectorData: vi.fn(async () => ({ ok: true as const, value: { status: 'ready' as const, value: { mode: 'active' as const, projectId: 'orbit-ui', queueEventCount: 7, queueByteCount: 4096, lastAcceptedAt: '2026-09-12T08:00:00Z', lastFailure: null, gapCount: 0, authorizationState: 'authorized' as const, storageError: null } } })),
      configureKnowledgeSelection: vi.fn(async () => ({ ok: true as const, value: undefined })),
      clearKnowledgeSelection: vi.fn(async () => ({ ok: true as const, value: undefined })),
      accessSummary: vi.fn(async () => ({ ok: true, value: demoAccess })),
      catalog: vi.fn(async () => ({ ok: true, value: { status: 'ready' as const, catalog: { items: [] } } })),
      installations: vi.fn(async () => ({ ok: true, value: [] })),
      syncReleaseStatus: vi.fn(async () => ({ ok: true, value: [] })),
      uninstallSkill: vi.fn(async () => ({ ok: true, value: [] })),
      installSkill: vi.fn(async () => ({ ok: false, error: { code: 'X', message: 'not used' } })),
    },
    cloudWorkspaces: {
      workspacePlans: vi.fn(async () => ({ ok: true as const, value: { status: 'ready' as const, fixtureOnly: true, value: [] } })),
      agentProfiles: vi.fn(async () => ({
        ok: true as const,
        value: {
          status: 'ready' as const,
          fixtureOnly: true,
          value: [
            {
              agentProfileId: 'ap-legacy',
              agentProfileVersionId: 'apv-9',
              name: '退役旧代理',
              description: '类型已退役的示例配置',
              versionLabel: 'v9',
              changeSummary: '旧版本',
              agentTypeId: 'at-legacy',
              agentTypeName: 'Legacy Shell',
              agentTypeKey: 'legacy_shell',
              agentTypeReadiness: 'unavailable',
              agentTypeCapabilities: [],
              model: 'legacy-model',
              reasoning: 'off',
              skills: [],
              knowledgeBases: [],
              memory: null,
              executionPolicy: { permission_mode: 'approval', write_mode: 'read_only' },
              typeExtension: {},
              typeExtensionOpaqueKeys: [],
              readiness: 'unavailable',
              unavailableReason: 'Agent 类型已退役',
              default: false,
              status: 'published' as const,
              createdBy: '平台管理员',
              publishedAt: '2026-08-01T00:00:00.000Z',
              updatedAt: '2026-08-02T00:00:00.000Z',
            },
            {
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
      workspaces: vi.fn(async () => ({ ok: true as const, value: { status: 'ready' as const, value: [demoCloudWorkspace] } })),
      workspaceRuns: vi.fn(async () => ({ ok: true as const, value: { status: 'ready' as const, value: [demoRun] } })),
    },
  } as unknown as ClientRemote
}

function mountSurface(controller = new PlatformDemoController(), remote = demoRemote()) {
  controller.open()
  const props = {
    controller,
    t,
    useSessions: (<S,>(selector: (state: typeof demoSessionState) => S): S => selector(demoSessionState)) as never,
    useWorkspaces: (<S,>(selector: (state: WorkspaceListState) => S): S => selector(demoWorkspaceState)) as never,
    remote,
    layout: { openRightbar: vi.fn(), closeRightbar: vi.fn(), toggleSidebar: () => {}, openDetails: () => {}, closeDetails: () => {} },
  } as unknown as PlatformSurfaceProps
  return { controller, remote, ...render(<PlatformSurface {...props} />) }
}

async function selectCurrentProject(): Promise<void> {
  const select = await screen.findByRole('combobox', { name: '当前项目' })
  fireEvent.change(select, { target: { value: 'orbit-ui' } })
  await waitFor(() => {
    expect(select).toHaveProperty('value', 'orbit-ui')
  })
}

async function gatePanel(title: string): Promise<HTMLElement> {
  const heading = await screen.findByRole('heading', { name: title })
  const panel = heading.closest('section')
  expect(panel).toBeTruthy()
  return panel as HTMLElement
}

describe('UX-01 插件任务导航与上下文', () => {
  it('groups primary navigation into 准备/工作/复盘 sections and keeps the account entry as a drawer trigger', async () => {
    mountSurface()
    await screen.findByRole('group', { name: '准备' })
    const prepare = screen.getByRole('group', { name: '准备' })
    for (const label of ['项目', '团队 Skill', '知识库', '记忆库', 'Agent 配置']) {
      expect(within(prepare).getByRole('button', { name: label })).toBeTruthy()
    }
    const work = screen.getByRole('group', { name: '工作' })
    expect(within(work).getByRole('button', { name: '云工作空间' })).toBeTruthy()
    const review = screen.getByRole('group', { name: '复盘' })
    expect(within(review).getByRole('button', { name: 'AI Coding 可观测' })).toBeTruthy()
    expect(screen.getByRole('button', { name: /账号与权限/ })).toBeTruthy()
  })

  it('renders exactly one global project selector provided by the ContextBar', async () => {
    mountSurface()
    await selectCurrentProject()
    expect(screen.getAllByRole('combobox', { name: '当前项目' })).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: '项目' }))
    await screen.findByText('项目详情由服务端按当前账号权限返回', { exact: false })
    expect(screen.queryByRole('combobox', { name: '查看项目' })).toBeNull()
    expect(screen.getAllByRole('combobox', { name: '当前项目' })).toHaveLength(1)
  })

  it('overview shows the current project summary with Workspace state, default agent and latest run', async () => {
    mountSurface()
    await selectCurrentProject()
    const overview = screen.getByRole('region', { name: '当前项目概览' })
    expect(within(overview).getByText('AI开放平台')).toBeTruthy()
    expect(within(overview).getByText('进行中')).toBeTruthy()
    expect(within(overview).getByText(/就绪/)).toBeTruthy()
    expect(within(overview).getByText('默认研发代理')).toBeTruthy()
    expect(within(overview).getByText(/run-1/)).toBeTruthy()
  })

  it('renders a project-required state panel instead of blank cards when no project is selected', async () => {
    mountSurface()
    await screen.findByRole('group', { name: '准备' })
    const panel = screen.getByRole('region', { name: '当前项目概览' })
    expect(panel.getAttribute('data-state')).toBe('no-project')
    const action = within(panel).getByRole('button', { name: '选择项目' })
    fireEvent.click(action)
    expect(document.activeElement).toBe(await screen.findByRole('combobox', { name: '当前项目' }))
  })
})

describe('UX-02 统一登录、账号和权限状态', () => {
  it('gives not-ready, service-error and forbidden gates distinct states with one recovery action each', async () => {
    const remote = demoRemote()
    remote.teamSkills.account = vi.fn(async () => ({ ok: true as const, value: { status: 'not-ready' as const, missing: ['teamSkillBaseUrl'] } }))
    const view = mountSurface(new PlatformDemoController(), remote)
    const panel = await gatePanel('服务未就绪')
    expect(panel.getAttribute('data-state')).toBe('not-ready')
    expect(within(panel).getByRole('button', { name: '返回' })).toBeTruthy()
    view.unmount()

    const failed = demoRemote()
    failed.teamSkills.account = vi.fn(async () => ({ ok: true as const, value: { status: 'failed' as const, code: 'UPSTREAM_TIMEOUT', message: '服务超时' } }))
    const failedView = mountSurface(new PlatformDemoController(), failed)
    const failedPanel = await gatePanel('服务暂时不可用')
    expect(failedPanel.getAttribute('data-state')).toBe('service-error')
    expect(within(failedPanel).getByRole('button', { name: '重新加载' })).toBeTruthy()
    failedView.unmount()

    const denied = demoRemote()
    denied.teamSkills.accessSummary = vi.fn(async () => ({ ok: true as const, value: { status: 'failed' as const, code: 'ROLE_FORBIDDEN', message: '无权读取访问范围' } }))
    mountSurface(new PlatformDemoController(), denied)
    const deniedPanel = await gatePanel('无权访问')
    expect(deniedPanel.getAttribute('data-state')).toBe('forbidden')
    expect(within(deniedPanel).getByRole('button', { name: '查看权限说明' })).toBeTruthy()

    // 认证类失败（UNAUTHORIZED）不是权限问题：走 service-error「重新加载」，
    // 由 loadAccount 刷新会话，而不是引导用户去看权限说明。
    const unauthorized = demoRemote()
    unauthorized.teamSkills.accessSummary = vi.fn(async () => ({ ok: true as const, value: { status: 'failed' as const, code: 'UNAUTHORIZED', message: '认证已过期' } }))
    const unauthorizedView = mountSurface(new PlatformDemoController(), unauthorized)
    const unauthorizedPanel = await gatePanel('服务暂时不可用')
    expect(unauthorizedPanel.getAttribute('data-state')).toBe('service-error')
    expect(within(unauthorizedPanel).getByRole('button', { name: '重新加载' })).toBeTruthy()
    unauthorizedView.unmount()
  })

  it('returns to login on expired tokens and clears account-scoped selections', async () => {
    const remote = demoRemote()
    remote.teamSkills.accessSummary = vi.fn(async () => ({ ok: true as const, value: { status: 'signed-out' as const } }))
    mountSurface(new PlatformDemoController(), remote)
    await screen.findByRole('button', { name: '登录' })
    expect(screen.queryByText('AI开放平台')).toBeNull()
    expect(screen.queryByRole('combobox', { name: '当前项目' })).toBeNull()
  })

  it('account drawer explains global, organization and project scopes plus the sign-out cleanup scope', async () => {
    mountSurface()
    await selectCurrentProject()
    fireEvent.click(screen.getByRole('button', { name: /账号与权限/ }))
    const drawer = await screen.findByRole('dialog', { name: '账号与访问范围' })
    expect(within(drawer).getByText('成员')).toBeTruthy()
    expect(within(drawer).getAllByText('星河平台').length).toBeGreaterThan(0)
    expect(within(drawer).getByText(/可管理组织/)).toBeTruthy()
    expect(within(drawer).getByText(/可管理项目/)).toBeTruthy()
    expect(within(drawer).getByText(/退出登录将清理/)).toBeTruthy()
  })
})

describe('UX-04 知识库与记忆库', () => {
  it('shows the fixed per-session binding summary with a clear action', async () => {
    mountSurface()
    await selectCurrentProject()
    fireEvent.click(screen.getByRole('button', { name: '知识库' }))
    expect(await screen.findByText('本轮已启用 0 个知识库')).toBeTruthy()
    fireEvent.click(screen.getByRole('checkbox', { name: /DSH 会话事件与模型可见性规范/ }))
    expect(await screen.findByText('本轮已启用 1 个知识库')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '清除本轮选择' }))
    expect(await screen.findByText('本轮已启用 0 个知识库')).toBeTruthy()
    expect(screen.getByRole('checkbox', { name: /DSH 会话事件与模型可见性规范/ })).toHaveProperty('checked', false)
  })

  it('keeps search results visible while the preview drawer opens and closes', async () => {
    mountSurface()
    await selectCurrentProject()
    fireEvent.click(screen.getByRole('button', { name: '知识库' }))
    fireEvent.click(await screen.findByRole('checkbox', { name: /DSH 会话事件与模型可见性规范/ }))
    fireEvent.change(await screen.findByPlaceholderText('搜索知识库'), { target: { value: '规范' } })
    fireEvent.click(screen.getByRole('button', { name: '检索' }))
    await screen.findByText('命中')
    fireEvent.click(screen.getByRole('button', { name: '预览' }))
    expect(await screen.findByRole('dialog', { name: '知识预览' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '关闭预览' }))
    expect(screen.getByText('命中')).toBeTruthy()
  })

  it('points the primary action to 选择知识库 when nothing is enabled', async () => {
    mountSurface()
    await selectCurrentProject()
    fireEvent.click(screen.getByRole('button', { name: '知识库' }))
    const action = await screen.findByRole('button', { name: '选择知识库' })
    fireEvent.click(action)
    expect(document.activeElement?.getAttribute('type')).toBe('checkbox')
  })

  it('gives memory rows explicit 查看/编辑/删除 actions and a scope-aware delete confirm', async () => {
    const { remote } = mountSurface()
    await selectCurrentProject()
    fireEvent.click(screen.getByRole('button', { name: '记忆库' }))
    expect(await screen.findByRole('button', { name: '查看记忆 m-1' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '编辑记忆 m-1' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '删除记忆 m-1' }))
    const dialog = screen.getByRole('dialog', { name: '确认操作' })
    expect(within(dialog).getByText(/orbit-ui/)).toBeTruthy()
    expect(within(dialog).getByText(/异步清理任务/)).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('button', { name: '确认删除' }))
    await waitFor(() => {
      expect(remote.teamSkills.memoryDelete).toHaveBeenCalled()
    })
    expect(await screen.findByText(/清理任务 j-delete/)).toBeTruthy()
  })

  it('edits memory through a save bar that tracks revision, dirty state and keeps input on conflict', async () => {
    const remote = demoRemote()
    remote.teamSkills.memoryUpdate = vi.fn(async () => ({ ok: false as const, error: { code: 'REVISION_CONFLICT', message: '数据已变化', details: {} } }))
    mountSurface(new PlatformDemoController(), remote)
    await selectCurrentProject()
    fireEvent.click(screen.getByRole('button', { name: '记忆库' }))
    fireEvent.click(await screen.findByRole('button', { name: '编辑记忆 m-1' }))
    const editor = await screen.findByRole('textbox', { name: '记忆正文' })
    expect(screen.getByText('修订 r1')).toBeTruthy()
    fireEvent.change(editor, { target: { value: '未保存的修改。' } })
    expect(screen.getByText(/有未保存修改/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '保存记忆' }))
    expect(await screen.findByText(/数据已变化/)).toBeTruthy()
    expect(screen.getByRole('textbox', { name: '记忆正文' })).toHaveProperty('value', '未保存的修改。')
  })
})

describe('UX-05 Agent 选择', () => {
  it('orders cards default → available → degraded → unavailable and offers 选择使用 only on available cards', async () => {
    mountSurface()
    await selectCurrentProject()
    fireEvent.click(screen.getByRole('button', { name: 'Agent 配置' }))
    const defaultCard = await screen.findByText('默认研发代理')
    const unavailableCard = await screen.findByText('退役旧代理')
    // The fixture lists the unavailable profile first; the view must reorder it last.
    expect(defaultCard.compareDocumentPosition(unavailableCard) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    const cards = screen.getAllByRole('article')
    expect(cards).toHaveLength(2)
    expect(cards[0]!.getAttribute('data-default')).toBe('true')
    expect(cards[1]!.getAttribute('data-readiness')).toBe('unavailable')
    const selectButtons = screen.getAllByRole('button', { name: '选择使用' })
    expect(selectButtons).toHaveLength(1)
    expect(within(cards[1] as HTMLElement).queryByRole('button', { name: '选择使用' })).toBeNull()
  })

  it('confirms a selection with Profile Version, project and write mode and keeps it traceable', async () => {
    mountSurface()
    await selectCurrentProject()
    fireEvent.click(screen.getByRole('button', { name: 'Agent 配置' }))
    fireEvent.click(await screen.findByRole('button', { name: '选择使用' }))
    const confirmation = await screen.findByRole('status', { name: '已选择 Agent 配置' })
    expect(within(confirmation).getByText(/apv-1/)).toBeTruthy()
    expect(within(confirmation).getByText(/orbit-ui/)).toBeTruthy()
    expect(within(confirmation).getByText(/write/)).toBeTruthy()
  })
})

describe('UX-08 采集与可观测', () => {
  it('summarizes connection, queue, last failure and freshness before the action bar', async () => {
    mountSurface()
    await selectCurrentProject()
    fireEvent.click(screen.getByRole('button', { name: 'AI Coding 可观测' }))
    expect(await screen.findByRole('heading', { name: 'AI Coding 可观测' })).toBeTruthy()
    const status = await screen.findByRole('region', { name: '采集状态摘要' })
    const labels = ['连接状态', '队列积压', '最近失败', '最后刷新']
    let previous: HTMLElement | null = null
    for (const label of labels) {
      const item = within(status).getByText(label)
      if (previous !== null) {
        expect(previous.compareDocumentPosition(item) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
      }
      previous = item
    }
    expect(within(status).getByText(/GATEWAY_TIMEOUT/)).toBeTruthy()
    expect(within(status).getByText(/7 条/)).toBeTruthy()
    const actions = screen.getByRole('group', { name: '采集操作' })
    expect(actions.compareDocumentPosition(status) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy()
  })

  it('shows the pending clear count before asking for confirmation', async () => {
    mountSurface()
    await selectCurrentProject()
    fireEvent.click(screen.getByRole('button', { name: 'AI Coding 可观测' }))
    await screen.findByRole('region', { name: '采集状态摘要' })
    fireEvent.click(screen.getByRole('button', { name: '清空未上报数据' }))
    const dialog = screen.getByRole('dialog', { name: '确认操作' })
    expect(within(dialog).getByText(/7 条/)).toBeTruthy()
    expect(within(dialog).getByRole('button', { name: '确认清理' })).toBeTruthy()
  })
})


describe('UX-04 二次核对：服务端确认绑定', () => {
  it('marks 本轮已启用 only after the server confirms the binding and gates search on it', async () => {
    const remote = demoRemote()
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    remote.teamSkills.configureKnowledgeSelection = vi.fn(async () => {
      await gate
      return { ok: true as const, value: undefined }
    })
    mountSurface(new PlatformDemoController(), remote)
    await selectCurrentProject()
    fireEvent.click(screen.getByRole('button', { name: '知识库' }))
    fireEvent.click(await screen.findByRole('checkbox', { name: /DSH 会话事件与模型可见性规范/ }))
    // 服务端未确认前：摘要仍为 0，检索不可用
    expect(await screen.findByText('本轮已启用 0 个知识库')).toBeTruthy()
    expect(screen.getByRole('button', { name: '检索' })).toHaveProperty('disabled', true)
    release?.()
    expect(await screen.findByText('本轮已启用 1 个知识库')).toBeTruthy()
    fireEvent.change(screen.getByPlaceholderText('搜索知识库'), { target: { value: '规范' } })
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '检索' })).toHaveProperty('disabled', false)
    })
  })
})
