// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { CloudWorkspacesView } from '../src/client/cloud-workspaces/CloudWorkspacesView'
import type { ClientRemote, TeamSkillProject } from '@deepseek-ai/dsh-api-remotes/client'

// 1-3「检查点与恢复」插件面验收：活跃运行可暂停；暂停后自动读取检查点并
// 渲染恢复预览（将重用 / 将重新执行）；恢复显式选择 continue | replay。

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

// 视图消费 Host 解析后的 camelCase 快照。
const runBase = {
  projectId: 'project-alpha', workspaceId: 'ws-alpha-1', sessionId: 'sess-1',
  agentProfileVersionId: 'apv-1', assetVersionIds: ['skill:x@1.0.0'],
  executionPolicy: {}, workspaceRevision: 7, writeMode: 'read_only', leaseId: null,
  errorCode: null, createdAt: '2026-09-16T00:00:00Z', updatedAt: '2026-09-16T00:01:00Z',
}

const runningRun = { ...runBase, runId: 'run-live', status: 'running', revision: 2 }
const pausedRun = { ...runBase, runId: 'run-live', status: 'paused', revision: 4 }

// 视图消费的是 Host 严格解析后的快照（camelCase），不是 wire 原始 DTO。
const checkpointDto = {
  createdAt: '2026-09-16T01:00:00Z',
  traceId: 'trace-1',
  sessionSeq: 7,
  toolResults: [{ callId: 'call-1', tool: 'terminal', result: 'tests passed' }],
  pendingApproval: null,
  completedSteps: [0],
  agentConfig: { agentProfileVersionId: 'apv-1', executionPolicy: { permission_mode: 'approval' } },
  assetVersionIds: ['skill:x@1.0.0'],
  workspaceRevision: 7,
  planId: 'plan-1',
  steps: ['步骤一：梳理', '步骤二：实现'],
  consumed: false,
  consumedAt: null,
  resumePreview: {
    reuse: [{ kind: 'plan_step', title: '步骤一：梳理' }, { kind: 'tool_result', call_id: 'call-1', tool: 'terminal' }],
    replay: [{ title: '步骤二：实现' }],
  },
  fixtureOnly: true,
}

function fakeRemote(initialRuns: unknown[]): { readonly remote: ClientRemote; readonly fns: Record<string, ReturnType<typeof vi.fn>> } {
  const fns: Record<string, ReturnType<typeof vi.fn>> = {
    workspaces: vi.fn(async () => ready([workspaceSnapshot])),
    workspace: vi.fn(async () => ready(workspaceSnapshot)),
    workspaceChanges: vi.fn(async () => ready({ workspaceId: 'ws-alpha-1', baselineRevision: 5, revision: 7, files: [] })),
    workspaceRuns: vi.fn(async () => ready(initialRuns)),
    agentProfiles: vi.fn(async () => ready([profile])),
    workspacePlans: vi.fn(async () => ready([])),
    workspaceFiles: vi.fn(async () => ready({ path: '', kind: 'directory', items: [] })),
    pauseRun: vi.fn(async () => ready({ ...pausedRun })),
    resumeRun: vi.fn(async () => ready({ ...runningRun })),
    runCheckpoint: vi.fn(async () => ready(checkpointDto)),
    cancelRun: vi.fn(async () => ready({ ...runningRun, status: 'cancelled' })),
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
    createWorkspace: vi.fn(),
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

describe('1-3 检查点与恢复插件面', () => {
  it('活跃运行可暂停；暂停后渲染恢复预览（将重用 / 将重新执行）', async () => {
    const { remote, fns } = fakeRemote([runningRun])
    render(<CloudWorkspacesView remote={remote} useWorkspaces={useWorkspacesStub} projectId="project-alpha" projects={projects} sessionId="sess-1" />)
    fireEvent.click(await screen.findByRole('tab', { name: /Run/u }))
    await screen.findByText('run-live')

    fireEvent.click(await screen.findByRole('button', { name: '暂停' }))
    await waitFor(() => {
      expect(fns.pauseRun!.mock.calls.length).toBeGreaterThan(0)
    })
    expect(fns.pauseRun!.mock.calls[0]![0]).toEqual({ runId: 'run-live', sessionSeq: 0 })

    // 暂停后自动读取检查点，恢复预览明确列出将重用与将重新执行。
    expect(await screen.findByText('将重用：2 项')).toBeTruthy()
    expect(screen.getByText(/步骤一：梳理/u)).toBeTruthy()
    expect(screen.getByText(/工具结果 call-1（terminal）/u)).toBeTruthy()
    expect(screen.getByText('将重新执行：1 项')).toBeTruthy()
    expect(screen.getByText('步骤：步骤二：实现')).toBeTruthy()

    // 恢复显式选择模式。
    fireEvent.click(screen.getByRole('button', { name: '恢复（继续）' }))
    await waitFor(() => {
      expect(fns.resumeRun!.mock.calls.length).toBeGreaterThan(0)
    })
    expect(fns.resumeRun!.mock.calls[0]![0]).toEqual({ runId: 'run-live', mode: 'continue' })
  })

  it('paused 运行自动展示检查点恢复预览', async () => {
    const { remote, fns } = fakeRemote([pausedRun])
    render(<CloudWorkspacesView remote={remote} useWorkspaces={useWorkspacesStub} projectId="project-alpha" projects={projects} sessionId="sess-1" />)
    fireEvent.click(await screen.findByRole('tab', { name: /Run/u }))
    await screen.findByText('run-live')

    expect(await screen.findByText('将重用：2 项')).toBeTruthy()
    expect(await screen.findByText('将重新执行：1 项')).toBeTruthy()
    expect(fns.runCheckpoint!.mock.calls.length).toBeGreaterThan(0)
    expect(fns.runCheckpoint!.mock.calls[0]![0]).toBe('run-live')

    fireEvent.click(screen.getByRole('button', { name: '恢复（重放）' }))
    await waitFor(() => {
      expect(fns.resumeRun!.mock.calls.length).toBeGreaterThan(0)
    })
    expect(fns.resumeRun!.mock.calls[0]![0]).toEqual({ runId: 'run-live', mode: 'replay' })
  })
})
