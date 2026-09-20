// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { CloudWorkspacesView } from '../src/client/cloud-workspaces/CloudWorkspacesView'
import type { ClientRemote, TeamSkillProject } from '@deepseek-ai/dsh-api-remotes/client'

// 1-6「恢复中心」插件面验收：失败运行、挂起审批、事件流 stale 与未同步变更
// 集中呈现，每项归入四类动作并携带证据；每项可跳到带证据的明细
// （时间线 / 变更面板）。

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

const failedTimeout = { ...runBase, runId: 'run-timeout', status: 'failed', errorCode: 'RUN_TIMEOUT' }
const failedAuth = { ...runBase, runId: 'run-auth', status: 'failed', errorCode: 'FORBIDDEN' }
const pausedRun = { ...runBase, runId: 'run-paused', status: 'paused', revision: 4 }

const checkpointDto = {
  createdAt: '2026-09-16T01:00:00Z', traceId: 'trace-1', sessionSeq: 3,
  toolResults: [], pendingApproval: null, completedSteps: [0],
  agentConfig: { agentProfileVersionId: 'apv-1', executionPolicy: { permission_mode: 'approval' } },
  assetVersionIds: ['skill:x@1.0.0'], workspaceRevision: 7, planId: null,
  consumed: false, consumedAt: null,
  resumePreview: { reuse: [], replay: [] },
  fixtureOnly: true,
}

function fakeRemote(initialRuns: unknown[]): { readonly remote: ClientRemote; readonly fns: Record<string, ReturnType<typeof vi.fn>> } {
  const fns: Record<string, ReturnType<typeof vi.fn>> = {
    workspaces: vi.fn(async () => ready([workspaceSnapshot])),
    workspace: vi.fn(async () => ready(workspaceSnapshot)),
    workspaceChanges: vi.fn(async () => ready({ workspaceId: 'ws-alpha-1', baselineRevision: 5, revision: 7, files: [{ path: 'src/app.json', change: 'modified', diff: '--- a\n+++ b' }] })),
    workspaceRuns: vi.fn(async () => ready(initialRuns)),
    agentProfiles: vi.fn(async () => ready([profile])),
    workspacePlans: vi.fn(async () => ready([])),
    workspaceFiles: vi.fn(async () => ready({ path: '', kind: 'directory', items: [] })),
    runCheckpoint: vi.fn(async () => ready(checkpointDto)),
    run: vi.fn(async () => ready({ ...failedAuth, timeline: [{ status: 'failed', at: '2026-09-16T00:01:00Z', reason: '超时', operator: 'system', policyVersion: 'apv-1', revision: 2, traceId: 'trace-1' }] })),
    retryRun: vi.fn(async () => ready({ ...failedTimeout, runId: 'run-retry', status: 'preparing', revision: 1 })),
    resumeRun: vi.fn(async () => ready({ ...pausedRun, status: 'preparing', revision: 5 })),
    cancelRun: vi.fn(async () => ready({ ...failedTimeout, status: 'cancelled' })),
    streamState: vi.fn(async () => ({ status: 'live', lastEventId: 'evt-000001' })),
    startStream: vi.fn(async () => ({ subscriptionId: 'sub-1', state: { status: 'connecting' } })),
    stopStream: vi.fn(async () => ({ status: 'idle' })),
    streamEventsAfter: vi.fn(async () => ({ events: [], truncated: false })),
    codeSources: vi.fn(async () => ready([])),
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

describe('1-6 恢复中心插件面', () => {
  it('集中呈现失败运行、挂起审批、stale 与未同步变更，并按四类动作呈现', async () => {
    const { remote, fns } = fakeRemote([failedTimeout, failedAuth, pausedRun])
    render(<CloudWorkspacesView remote={remote} useWorkspaces={useWorkspacesStub} projectId="project-alpha" projects={projects} sessionId="sess-1" />)
    fireEvent.click(await screen.findByRole('tab', { name: /Run/u }))

    expect(await screen.findByText('恢复中心')).toBeTruthy()
    // 失败运行（超时）→ 安全重试。
    const timeoutItem = (await screen.findByText('失败运行 run-timeout')).closest('li') as HTMLElement
    expect(timeoutItem.getAttribute('data-recovery-action')).toBe('safe-retry')
    expect(timeoutItem.textContent).toContain('RUN_TIMEOUT')
    // 失败运行（授权）→ 需要管理员。
    const authItem = screen.getByText('失败运行 run-auth').closest('li') as HTMLElement
    expect(authItem.getAttribute('data-recovery-action')).toBe('needs-admin')
    // 挂起审批 → 需要决策（恢复按钮）。
    const pausedItem = screen.getByText('已暂停运行 run-paused').closest('li') as HTMLElement
    expect(pausedItem.getAttribute('data-recovery-action')).toBe('needs-decision')
    expect(within(pausedItem).getByRole('button', { name: '恢复（继续）' })).toBeTruthy()
    // 未同步变更 → 需要决策。
    const changesItem = screen.getByText(/未同步变更 1 个文件/u).closest('li') as HTMLElement
    expect(changesItem.getAttribute('data-recovery-action')).toBe('needs-decision')
    expect(fns.retryRun!.mock.calls.length).toBe(0)
  })

  it('安全重试可执行（重试运行）且每项可跳到带证据的明细', async () => {
    const { remote, fns } = fakeRemote([failedTimeout, failedAuth, pausedRun])
    render(<CloudWorkspacesView remote={remote} useWorkspaces={useWorkspacesStub} projectId="project-alpha" projects={projects} sessionId="sess-1" />)
    fireEvent.click(await screen.findByRole('tab', { name: /Run/u }))

    const timeoutItem = (await screen.findByText('失败运行 run-timeout')).closest('li') as HTMLElement
    fireEvent.click(within(timeoutItem).getByRole('button', { name: '重试运行' }))
    await waitFor(() => {
      expect(fns.retryRun!.mock.calls.length).toBeGreaterThan(0)
    })
    expect(fns.retryRun!.mock.calls[0]).toEqual(['run-timeout', 7])

    // 明细跳转：查看时间线调用 run 详情。
    const authItem = screen.getByText('失败运行 run-auth').closest('li') as HTMLElement
    fireEvent.click(within(authItem).getByRole('button', { name: '查看时间线' }))
    await waitFor(() => {
      expect(fns.runCheckpoint).toBeDefined()
      expect(fns.run!.mock.calls.length).toBeGreaterThan(0)
    })
    expect(fns.run!.mock.calls[0]).toEqual(['run-auth'])

    // 未同步变更跳转变更面板（证据：基线与文件列表）。
    fireEvent.click(screen.getByRole('button', { name: '查看变更' }))
    expect(await screen.findByText(/基线 5/u)).toBeTruthy()
  })
})
