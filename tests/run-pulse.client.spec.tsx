// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { CloudWorkspacesView } from '../src/client/cloud-workspaces/CloudWorkspacesView'
import type { ClientRemote, TeamSkillProject } from '@deepseek-ai/dsh-api-remotes/client'

// 2-5「运行脉搏与时间旅行」插件面验收（蓝图 §2-5，§11.11）：
// - 脉搏时间线：状态转移/审批/工具调用/测试结果/检查点条目可点击呈现，
//   未知类型显式呈现；
// - 当时视图：点击检查点条目打开该检查点的六类状态与恢复预览（只读），
//   不发起任何运行写调用；
// - 动效合规：脉搏容器带 data-motion="gated"（CSS 仅在
//   prefers-reduced-motion: no-preference 下启用动效，forced-colors 下使用
//   currentColor 描边），状态不得仅用颜色表达（文本标签齐备）。

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

const run = {
  runId: 'run-appr-1', traceId: 'trace-1', projectId: 'project-alpha', workspaceId: 'ws-alpha-1',
  sessionId: 'sess-1', agentProfileVersionId: 'apv-1', assetVersionIds: ['skill:code-review@1.0.0'],
  executionPolicy: { permission_mode: 'approval' }, workspaceRevision: 7, status: 'awaiting_approval',
  writeMode: 'write', leaseId: null, revision: 3, errorCode: null,
  createdAt: '2026-09-10T00:00:00Z', updatedAt: '2026-09-10T00:00:00Z',
}

const pulseEntries = [
  { kind: 'status', at: '2026-09-10T00:00:00Z', revision: 1, traceId: 'trace-1', summary: 'awaiting_approval：写入运行等待审批', status: 'awaiting_approval', reason: '写入运行等待审批', operator: '演示成员', policyVersion: 'apv-1' },
  { kind: 'tool_call', at: '2026-09-10T00:01:00Z', revision: 2, traceId: 'trace-1', summary: 'write_file：c1', callId: 'c1', tool: 'write_file', result: '已写入 README.md' },
  { kind: 'checkpoint', at: '2026-09-10T00:02:00Z', revision: 3, traceId: 'trace-1', summary: '检查点 cp-1', checkpointId: 'cp-1', consumed: false },
  { kind: 'test', at: '2026-09-10T00:03:00Z', revision: 3, traceId: 'trace-1', summary: '工作空间测试全部通过', total: 12, passed: 12, failed: 0 },
  { kind: 'mystery', at: '2026-09-10T00:04:00Z', revision: 3, traceId: 'trace-1', summary: '未知事件' },
]

const checkpointSnapshot = {
  checkpointId: 'cp-1',
  createdAt: '2026-09-10T00:02:00Z',
  traceId: 'trace-1',
  sessionSeq: 5,
  toolResults: [{ callId: 'c1', tool: 'write_file', result: '已写入 README.md' }],
  pendingApproval: null,
  completedSteps: [0, 1],
  agentConfig: { agentProfileVersionId: 'apv-1', executionPolicy: { permission_mode: 'approval' } },
  assetVersionIds: ['skill:code-review@1.0.0'],
  workspaceRevision: 6,
  planId: null,
  steps: ['搭建脚手架', '实现功能', '运行测试'],
  consumed: false,
  resumePreview: {
    reuse: [{ kind: 'plan_step', title: '搭建脚手架' }, { kind: 'tool_result', call_id: 'c1', tool: 'write_file' }],
    replay: [{ title: '运行测试' }],
  },
  fixtureOnly: true,
}

function fakeRemote(overrides: Record<string, ReturnType<typeof vi.fn>> = {}): {
  readonly remote: ClientRemote
  readonly fns: Record<string, ReturnType<typeof vi.fn>>
} {
  const fns: Record<string, ReturnType<typeof vi.fn>> = {
    workspaces: vi.fn(async () => ready([workspaceSnapshot])),
    workspace: vi.fn(async () => ready(workspaceSnapshot)),
    workspaceChanges: vi.fn(async () => ready({ workspaceId: 'ws-alpha-1', baselineRevision: 5, revision: 7, files: [] })),
    workspaceRuns: vi.fn(async () => ready([run])),
    agentProfiles: vi.fn(async () => ready([profile])),
    workspacePlans: vi.fn(async () => ready([])),
    workspaceFiles: vi.fn(async () => ready({ path: '', kind: 'directory', items: [] })),
    runApproval: vi.fn(async () => ready({ approvalId: 'appr-1', runId: 'run-appr-1', action: 'apply_workspace_changes', summary: '写入运行需审批', affected: [], permission: { code: 'workspace.write', allowed: true, reason: '授权', policyVersion: 'perm-policy@1' }, assetVersions: [], risk: { level: 'high', reason: '写入' }, revocable: { revocable: true, how: '取消运行' }, expiresAt: '2026-09-10T00:15:00Z', createdAt: '2026-09-10T00:00:00Z' })),
    runPulse: vi.fn(async () => ready({ runId: 'run-appr-1', items: pulseEntries })),
    runCheckpoint: vi.fn(async () => ready(checkpointSnapshot)),
    streamState: vi.fn(async () => ({ status: 'live', lastEventId: 'evt-000001' })),
    startStream: vi.fn(async () => ({ subscriptionId: 'sub-1', state: { status: 'connecting' } })),
    stopStream: vi.fn(async () => ({ status: 'idle' })),
    streamEventsAfter: vi.fn(async () => ({ events: [], truncated: false })),
    codeSources: vi.fn(async () => ready([])),
    createRun: vi.fn(), cancelRun: vi.fn(), retryRun: vi.fn(),
    run: vi.fn(), pauseRun: vi.fn(), resumeRun: vi.fn(), takeoverRun: vi.fn(), decideApproval: vi.fn(),
    createPlan: vi.fn(), updatePlan: vi.fn(), confirmPlan: vi.fn(),
    workspaceAction: vi.fn(async () => ready(workspaceSnapshot)),
    deleteWorkspace: vi.fn(async () => ready({ ...workspaceSnapshot, status: 'deleting' })),
    discardChanges: vi.fn(async () => ready({ revision: 8 })),
    gitCommit: vi.fn(async () => ready({ revision: 8 })),
    createPullRequest: vi.fn(async () => ready({ pullRequestId: 'pr-1' })),
    ...overrides,
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

describe('2-5 运行脉搏与当时视图', () => {
  it('脉搏条目可点击呈现，未知类型显式呈现，动效容器标注 data-motion="gated"', async () => {
    const { remote, fns } = fakeRemote()
    render(<CloudWorkspacesView remote={remote} useWorkspaces={useWorkspacesStub} projectId="project-alpha" projects={projects} sessionId="sess-1" />)
    await screen.findAllByText('ws-alpha-1')
    fireEvent.click(await screen.findByRole('tab', { name: 'Run' }))
    fireEvent.click(await screen.findByRole('button', { name: '脉搏' }))

    await waitFor(() => {
      expect(fns.runPulse).toHaveBeenCalledWith('run-appr-1')
    })
    const list = await screen.findByRole('list', { name: '运行脉搏' })
    expect(list.getAttribute('data-motion')).toBe('gated')
    expect(list.textContent).toContain('awaiting_approval：写入运行等待审批')
    expect(list.textContent).toContain('write_file')
    expect(list.textContent).toContain('12/12 通过')
    expect(list.textContent).toContain('未知事件')
    expect(screen.getByRole('button', { name: /检查点 cp-1/ })).toBeTruthy()
  })

  it('点击检查点条目打开当时视图：六类状态只读呈现，不发起运行写调用', async () => {
    const { remote, fns } = fakeRemote()
    render(<CloudWorkspacesView remote={remote} useWorkspaces={useWorkspacesStub} projectId="project-alpha" projects={projects} sessionId="sess-1" />)
    await screen.findAllByText('ws-alpha-1')
    fireEvent.click(await screen.findByRole('tab', { name: 'Run' }))
    fireEvent.click(await screen.findByRole('button', { name: '脉搏' }))

    fireEvent.click(await screen.findByRole('button', { name: /检查点 cp-1/ }))
    await waitFor(() => {
      expect(fns.runCheckpoint).toHaveBeenCalledWith('run-appr-1', 'cp-1')
    })
    const drawer = await screen.findByRole('complementary', { name: '当时视图' })
    expect(drawer.getAttribute('data-view')).toBe('point-in-time')
    // 六类状态：Agent 配置快照 / 资产版本 / 会话序号 / 工具结果 / 工作区 revision / 待审批
    expect(drawer.textContent).toContain('apv-1')
    expect(drawer.textContent).toContain('skill:code-review@1.0.0')
    expect(drawer.textContent).toContain('5')
    expect(drawer.textContent).toContain('已写入 README.md')
    expect(drawer.textContent).toContain('6')
    expect(drawer.textContent).toContain('待审批')
    // 恢复预览：将重用与将重新执行
    expect(drawer.textContent).toContain('搭建脚手架')
    expect(drawer.textContent).toContain('运行测试')
    // 只读：未发起任何写调用
    expect(fns.pauseRun).not.toHaveBeenCalled()
    expect(fns.resumeRun).not.toHaveBeenCalled()
    expect(fns.cancelRun).not.toHaveBeenCalled()
  })
})
