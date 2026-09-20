// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { CloudWorkspacesView } from '../src/client/cloud-workspaces/CloudWorkspacesView'
import type { ClientRemote, TeamSkillProject } from '@deepseek-ai/dsh-api-remotes/client'

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
    workspaceFiles: vi.fn(async () => ready({ path: '', kind: 'directory', items: [] })),
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

    const toolbar = screen.getByRole('toolbar', { name: '布局预设' })
    for (const label of ['标准三栏', '专注会话', '审阅 diff', '监控运行']) {
      expect(toolbar.textContent).toContain(label)
    }
    const standard = within(toolbar).getByRole('button', { name: '标准三栏' })
    expect(standard.getAttribute('aria-pressed')).toBe('true')
  })

  it('切换布局只改 data-layout 可见性：不重新读取、运行行与状态保持不变', async () => {
    const { remote, fns } = fakeRemote()
    render(<CloudWorkspacesView remote={remote} useWorkspaces={useWorkspacesStub} projectId="project-alpha" projects={projects} sessionId="sess-1" />)
    await screen.findAllByText('ws-alpha-1')

    const runsBefore = fns.workspaceRuns!.mock.calls.length
    fireEvent.click(screen.getByRole('tab', { name: /Run/u }))
    const runRowBefore = (await screen.findByText('run-live')).textContent

    const toolbar = screen.getByRole('toolbar', { name: '布局预设' })
    for (const [label, expectedLayout] of [
      ['专注会话', 'focus-session'],
      ['审阅 diff', 'review-diff'],
      ['监控运行', 'monitor-runs'],
      ['标准三栏', 'standard'],
    ] as const) {
      fireEvent.click(within(toolbar).getByRole('button', { name: label }))
      await waitFor(() => {
        const columns = document.querySelector('[data-layout]')!
        expect(columns.getAttribute('data-layout')).toBe(expectedLayout)
        // 三栏始终挂载（不卸载组件）：布局只切换可见性。
        expect(columns.querySelector('[aria-label="workspace-tree"]')).toBeTruthy()
        expect(columns.querySelector('[aria-label="原生会话"]')).toBeTruthy()
        expect(columns.querySelector('[aria-label="workspace-panels"]')).toBeTruthy()
      })
    }

    // 布局切换不触发任何治理读取（工作台数据在挂载时读取一次）。
    expect(fns.workspaceRuns!.mock.calls.length).toBe(runsBefore)
    expect(fns.workspaces!.mock.calls.length).toBe(1)

    // 运行状态不受布局影响：同一运行行、同一状态文字。
    expect((await screen.findByText('run-live')).textContent).toBe(runRowBefore)
  })
})
