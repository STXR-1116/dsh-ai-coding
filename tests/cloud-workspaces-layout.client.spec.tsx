// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { CloudWorkspacesView } from '../src/client/cloud-workspaces/CloudWorkspacesView'
import type { ClientRemote, TeamSkillProject } from '@deepseek-ai/dsh-api-remotes/client'
import { openCloudPane } from './helpers/open-cloud-pane.ts'

// 2-1「三栏工作空间与四种布局」插件面验收：四种布局预设切换只改变三栏可见性
// （data-layout + CSS 隐藏，不卸载组件），不得触发重新读取、不得改变运行状态
// （运行行与状态文字保持不变）。

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const ready = <T,>(value: T): { status: 'ready'; value: T; fixtureOnly: boolean } => ({ status: 'ready', value, fixtureOnly: true })

const projects: readonly TeamSkillProject[] = [
  {
    projectId: 'project-alpha', organizationId: 'org-alpha', organizationName: '星河 AI 平台',
    name: '协作台前端', description: '', status: 'active', createdBy: 'admin-1',
    createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z',
    memberCount: 2, assetCount: 3, revision: 1,
  },
]

const workspaceSnapshot = {
  workspaceId: 'ws-alpha-1', projectId: 'project-alpha', ownerUserId: 'member-1',
  repositoryId: 'repo-1', branch: 'main', displayName: '云工作台主空间',
  defaultAgentProfileVersionId: 'apv-1', status: 'ready', revision: 7, lastError: null,
  createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-09T00:00:00Z',
}

const profile = {
  agentProfileId: 'ap-1', agentProfileVersionId: 'apv-1', name: '默认研发代理',
  agentTypeId: 'at-1', agentTypeName: 'Claude Code', agentTypeKey: 'claude_code',
  agentTypeReadiness: 'ready', agentTypeCapabilities: [], model: 'deepseek-v3.2', reasoning: 'medium',
  skills: [], knowledgeBases: [], memory: null, executionPolicy: {}, typeExtension: {},
  typeExtensionOpaqueKeys: [], readiness: 'ready', unavailableReason: null, default: true,
  status: 'published' as const, createdBy: '平台管理员', publishedAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z',
}

const runningRun = {
  runId: 'run-live', projectId: 'project-alpha', workspaceId: 'ws-alpha-1', sessionId: 'sess-1',
  agentProfileVersionId: 'apv-1', assetVersionIds: ['skill:x@1.0.0'], executionPolicy: {},
  workspaceRevision: 7, status: 'running', writeMode: 'read_only', leaseId: null, revision: 2,
  errorCode: null, createdAt: '2026-09-16T00:00:00Z', updatedAt: '2026-09-16T00:01:00Z',
}

function fakeRemote(): { readonly remote: ClientRemote; readonly fns: Record<string, ReturnType<typeof vi.fn>> } {
  const fns: Record<string, ReturnType<typeof vi.fn>> = {
    workspaces: vi.fn(async () => ready([workspaceSnapshot])),
    workspace: vi.fn(async () => ready(workspaceSnapshot)),
    workspaceChanges: vi.fn(async () => ready({ workspaceId: 'ws-alpha-1', baselineRevision: 5, revision: 7, files: [] })),
    workspaceRuns: vi.fn(async () => ready([runningRun])),
    agentProfiles: vi.fn(async () => ready([profile])),
    workspacePlans: vi.fn(async () => ready([])),
    workspaceSessionRecords: vi.fn(async () => ready([])),
    workspaceFiles: vi.fn(async () => ready({
      path: '', kind: 'directory',
      // 放一个文件：右栏"打开文件出现 / 关闭"两条路径都要能走。
      items: [{ path: 'README.md', kind: 'file', size: 12, etag: 'e1' }],
    })),
    streamState: vi.fn(async () => ({ status: 'live', lastEventId: 'evt-000001' })),
    startStream: vi.fn(async () => ({ subscriptionId: 'sub-1', state: { status: 'connecting' } })),
    stopStream: vi.fn(async () => ({ status: 'idle' })),
    streamEventsAfter: vi.fn(async () => ({ events: [], truncated: false })),
    codeSources: vi.fn(async () => ready([])),
    workspacePreview: vi.fn(async () => ready({ path: '', revision: 7, etag: 'e', kind: 'text', contentType: 'text/plain', content: '' })),
    workspacePreviewUrl: vi.fn(async () => ready({ url: 'https://fixture.internal/p/x', expiresAt: '2099-01-01T00:00:00Z', workspaceId: 'ws-alpha-1' })),
    workspaceAction: vi.fn(async () => ready(workspaceSnapshot)),
    deleteWorkspace: vi.fn(async () => ready({ ...workspaceSnapshot, status: 'deleting' })),
    discardChanges: vi.fn(async () => ready({ revision: 8 })),
    gitCommit: vi.fn(async () => ready({ revision: 8 })),
    createPullRequest: vi.fn(async () => ready({ pullRequestId: 'pr-1' })),
    createRun: vi.fn(), createWorkspace: vi.fn(), run: vi.fn(), cancelRun: vi.fn(), retryRun: vi.fn(),
    runCheckpoint: vi.fn(), pauseRun: vi.fn(), resumeRun: vi.fn(),
    createPlan: vi.fn(), updatePlan: vi.fn(), confirmPlan: vi.fn(), plan: vi.fn(),
  }
  const remote = {
    cloudWorkspaces: Object.fromEntries(Object.entries(fns).map(([name, fn]) => [
      name,
      async (...args: unknown[]) => ({ ok: true as const, value: await (fn as (...a: unknown[]) => Promise<unknown>)(...args) }),
    ])),
  } as unknown as ClientRemote
  return { remote, fns }
}

const useWorkspacesStub = ((selector: (state: { items: unknown[] }) => unknown) => selector({ items: [] })) as never

describe('2-1 三栏工作空间四种布局预设', () => {
  it('四种预设按钮齐备且默认为标准三栏', async () => {
    const { remote } = fakeRemote()
    render(<CloudWorkspacesView remote={remote} useWorkspaces={useWorkspacesStub} projectId="project-alpha" projects={projects} sessionId="sess-1" />)
    await screen.findAllByText('ws-alpha-1')

    // 布局**不再有预设**（所有者规格：只要会话与预览两种形态，布局由栏位自身决定）。
    // 这条断言拦住"预设又长回来"：工具栏与 data-layout 都不应存在。
    expect(screen.queryByRole('toolbar', { name: '布局预设' })).toBeNull()
    expect(document.querySelector('[data-layout]')).toBeNull()
  })

  it('三栏始终挂载：可见性变化不卸载组件、不触发任何重新读取', async () => {
    const { remote, fns } = fakeRemote()
    render(<CloudWorkspacesView remote={remote} useWorkspaces={useWorkspacesStub} projectId="project-alpha" projects={projects} sessionId="sess-1" />)
    // 右栏默认不可见（契约见设计 §13）：先打开它再操作它里面的页签。
    await openCloudPane()
    await screen.findAllByText('ws-alpha-1')

    const runsBefore = fns.workspaceRuns!.mock.calls.length
    fireEvent.click(screen.getByRole('tab', { name: /Run/u }))
    const runRowBefore = (await screen.findByText('run-live')).textContent

    const columns = document.querySelector('[class*="columns"]')!
    // 三栏（工程树 / 会话 / 面板）都在文档里：布局只切换可见性，从不卸载组件。
    expect(columns.querySelector('[aria-label="workspace-tree"]')).toBeTruthy()
    expect(columns.querySelector('[aria-label="workspace-session"]')).toBeTruthy()
    expect(columns.querySelector('[aria-label="workspace-panels"]')).toBeTruthy()

    // 视图层动作不触发任何治理读取（工作台数据在挂载时读取一次）。
    expect(fns.workspaceRuns!.mock.calls.length).toBe(runsBefore)
    expect(fns.workspaces!.mock.calls.length).toBe(1)

    // 运行状态不受布局影响：同一运行行、同一状态文字。
    expect((await screen.findByText('run-live')).textContent).toBe(runRowBefore)
  })

  it('A1：选择工作空间时把外壳切到该工作空间的会话，离开时恢复', async () => {
    const { remote } = fakeRemote()
    const opened: string[] = []
    // 会话映射：工作空间 → 会话（真实实现由 WorkspaceSessionsRemote 提供，这里只给结果）。
    ;(remote as { workspaceSessions?: unknown }).workspaceSessions = {
      ensure: async () => ({ ok: true as const, sessionId: 'sess-mapped' }),
      conversation: () => ({ ok: false as const, message: '测试：不渲染会话内容' }),
    }
    const view = render(
      <CloudWorkspacesView
        remote={remote}
        useWorkspaces={useWorkspacesStub}
        projectId="project-alpha"
        projects={projects}
        sessionId="sess-shell"
        // 账号必须给：映射效果刻意等到账号就位（否则会落进匿名桶、重复建会话且客户端删不掉）。
        accountId="member-1"
        openSession={(sessionId) => { opened.push(sessionId) }}
      />,
    )
    await screen.findAllByText('ws-alpha-1')

    // 外壳渲染的是"当前会话"，所以选中工作空间必须把映射到的会话告诉外壳。
    await waitFor(() => { expect(opened).toContain('sess-mapped') })
    // 恢复点记的是**进入前**的那个会话，不是映射结果。
    view.unmount()
    await waitFor(() => { expect(opened[opened.length - 1]).toBe('sess-shell') })
  })

  it('会话记录区渲染平台返回的记录，并取代待接通提示', async () => {
    const { remote, fns } = fakeRemote()
    fns.workspaceSessionRecords!.mockResolvedValue(ready([
      { sessionId: 'sess-alpha-1', title: '联调记录：云工作空间状态序列', updatedAt: '2026-09-22T09:10:00Z' },
    ]))
    render(<CloudWorkspacesView remote={remote} useWorkspaces={useWorkspacesStub} projectId="project-alpha" projects={projects} sessionId="sess-1" />)
    await screen.findAllByText('ws-alpha-1')

    // 记录来自服务端：标题原样呈现（不由前端拼），位置在左栏「会话记录区」。
    const pane = await screen.findByLabelText('会话记录区')
    expect(await within(pane).findByText('联调记录：云工作空间状态序列')).toBeTruthy()
    // 拿到数据后，"等待服务端提供…" 这条待接通提示必须消失 —— 两种状态不能同时出现。
    expect(within(pane).queryByText(/等待服务端提供/u)).toBeNull()
  })

  it('右栏可开可关：打开文件或点头部入口都出现，× 关闭（对标原生标签页的关闭）', async () => {
    const { remote, fns } = fakeRemote()
    render(<CloudWorkspacesView remote={remote} useWorkspaces={useWorkspacesStub} projectId="project-alpha" projects={projects} sessionId="sess-1" />)
    await screen.findAllByText('ws-alpha-1')

    const columns = document.querySelector('[class*="columns"]')!
    // 默认没有右栏（所有者规格：右侧是完整的主会话区）。
    expect(columns.getAttribute('data-pane-open')).toBeNull()

    // 路径一：点头部入口。
    fireEvent.click(await screen.findByRole('button', { name: '打开变更与运行面板' }))
    await waitFor(() => { expect(columns.getAttribute('data-pane-open')).not.toBeNull() })
    fireEvent.click(screen.getByRole('button', { name: '关闭面板' }))
    await waitFor(() => { expect(columns.getAttribute('data-pane-open')).toBeNull() })

    // 路径二：**打开文件**（这条是回归点）——有预览时关闭必须也生效。
    // 曾经的判据是 `paneOpen || 有预览`，于是有预览时关闭被抵消、点 × 毫无反应（所有者实测）。
    fireEvent.click(await screen.findByRole('button', { name: 'README.md' }))
    await waitFor(() => { expect(columns.getAttribute('data-pane-open')).not.toBeNull() })
    fireEvent.click(screen.getByRole('button', { name: '关闭面板' }))
    await waitFor(() => { expect(columns.getAttribute('data-pane-open')).toBeNull() })

    // 开关过程不触发任何治理读取。
    expect(fns.workspaces!.mock.calls.length).toBe(1)
  })

  it('会话记录读失败就地显示：不顶成页面横幅，也不拖垮整页', async () => {
    const { remote, fns } = fakeRemote()
    // 传输层失败（信封 ok:false）。以前这次读取走 unwrap，会**抛错** ⇒ 整个工作台加载失败 ——
    // 真后端尚未实现该端点时正是这种情形（所有者实测到页面顶着一整条红横幅）。
    fns.workspaceSessionRecords!.mockRejectedValue(new Error('服务端未实现该端点'))
    render(<CloudWorkspacesView remote={remote} useWorkspaces={useWorkspacesStub} projectId="project-alpha" projects={projects} sessionId="sess-1" />)

    // 页面照常渲染（工作空间与左栏都在）。
    await screen.findAllByText('ws-alpha-1')
    expect(screen.getByLabelText('workspace-tree')).toBeTruthy()

    // 原因**就地**显示在会话记录区里，而不是变成页面级横幅。
    const pane = await screen.findByLabelText('会话记录区')
    const alert = await within(pane).findByRole('alert')
    expect(alert.textContent).toContain('REMOTE_INVOKE_FAILED')
    expect(screen.queryByText(/REMOTE_INVOKE_FAILED.*重试/u)).toBeNull()
  })
})