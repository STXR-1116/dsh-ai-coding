// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { CloudWorkspacesView } from '../src/client/cloud-workspaces/CloudWorkspacesView'
import type { ClientRemote, TeamSkillProject } from '@deepseek-ai/dsh-api-remotes/client'

// 2-7「上下文镜头」插件面验收（蓝图 §2-7，§11.13）：
// - 会话顶部可收起的证据视图：默认收起，点击展开后按优先级呈现规则/Skill/
//   知识/记忆各层条目；
// - 被抑制条目（冲突/过期/未授权）显示「已抑制：原因」，不悄悄消失；
// - 权限判定小节与项目文件小节（由工作空间变更合成）。

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

const lensEntries = [
  { source: 'safety', title: '安全与平台规则基线', memoryId: null, permission: 'allowed', permissionReason: null, selectionReason: '安全层始终注入', injected: true, updatedAt: '2026-09-10T00:00:00Z' },
  { source: 'org-policy', title: '组织策略：旧版外发规则 v1', memoryId: null, permission: 'suppressed', permissionReason: '与现行组织策略冲突，已抑制', selectionReason: '冲突条目不进入注入评估', injected: false, updatedAt: '2026-08-15T00:00:00Z' },
  { source: 'skill', title: 'Skill：代码评审 0.9.0（旧版）', memoryId: null, permission: 'suppressed', permissionReason: '资产版本已过期，已抑制', selectionReason: '过期版本不进入注入评估', injected: false, updatedAt: '2026-08-01T00:00:00Z' },
  { source: 'knowledge', title: '知识库 k-3（旧版文档）', memoryId: null, permission: 'suppressed', permissionReason: '知识来源未授权，已抑制', selectionReason: '未授权来源不进入注入评估', injected: false, updatedAt: '2026-07-01T00:00:00Z' },
  { source: 'memory', title: '记忆：协作偏好（2026-09）', memoryId: 'mem-collab-pref', permission: 'allowed', permissionReason: null, selectionReason: '在有效期内，注入', injected: true, updatedAt: '2026-09-05T00:00:00Z' },
]

const lensSnapshot = {
  workspaceId: 'ws-alpha-1', revision: 7, generatedAt: '2026-09-10T00:10:00Z',
  entries: lensEntries,
  permissionDecisions: [
    { action: 'workspace.write', decision: 'allowed', code: 'OK', reason: '项目成员具备写入授权', policyVersion: 'perm-policy@1', at: '2026-09-10T00:06:00Z' },
    { action: 'admin.audit.read', decision: 'denied', code: 'FORBIDDEN', reason: '成员无管理面权限', policyVersion: 'perm-policy@1', at: '2026-09-10T00:04:00Z' },
  ],
}

/** 服务端在用户关闭该记忆后返回的同一份镜头快照（条目仍在，换成用户的原因）。 */
const suppressedLensSnapshot = {
  ...lensSnapshot,
  entries: lensEntries.map((entry) => {
    if (entry.memoryId !== 'mem-collab-pref') return entry
    return {
      ...entry,
      permission: 'suppressed',
      permissionReason: '用户已在本运行中关闭该记忆的影响',
      selectionReason: '用户在本运行中抑制该记忆，不进入注入评估',
      injected: false,
    }
  }),
}

/** 一次已完成的运行：镜头开关必须挂在一次具体运行上。 */
const runSnapshot = {
  runId: 'run-seed-1', projectId: 'project-alpha', workspaceId: 'ws-alpha-1', sessionId: 'sess-seed-1',
  agentProfileVersionId: 'apv-1', assetVersionIds: ['memory:m-1'], executionPolicy: { write_mode: 'read_only' },
  workspaceRevision: 7, status: 'succeeded' as const, writeMode: 'read_only' as const, leaseId: null,
  revision: 4, errorCode: null, createdAt: '2026-09-09T00:00:00Z', updatedAt: '2026-09-09T00:10:00Z',
}

function fakeRemote(): { readonly remote: ClientRemote; readonly fns: Record<string, ReturnType<typeof vi.fn>> } {
  const fns: Record<string, ReturnType<typeof vi.fn>> = {
    workspaces: vi.fn(async () => ready([workspaceSnapshot])),
    workspace: vi.fn(async () => ready(workspaceSnapshot)),
    workspaceChanges: vi.fn(async () => ready({
      workspaceId: 'ws-alpha-1', baselineRevision: 5, revision: 7,
      files: [{ path: 'README.md', change: 'modified', diff: '--- a\n+++ b' }],
    })),
    workspaceRuns: vi.fn(async () => ready([runSnapshot])),
    agentProfiles: vi.fn(async () => ready([profile])),
    workspacePlans: vi.fn(async () => ready([])),
    workspaceFiles: vi.fn(async () => ready({ path: '', kind: 'directory', items: [] })),
    contextLens: vi.fn(async () => ready(lensSnapshot)),
    suppressContextLensMemory: vi.fn(async () => ready(suppressedLensSnapshot)),
    streamState: vi.fn(async () => ({ status: 'live', lastEventId: 'evt-000001' })),
    startStream: vi.fn(async () => ({ subscriptionId: 'sub-1', state: { status: 'connecting' } })),
    stopStream: vi.fn(async () => ({ status: 'idle' })),
    streamEventsAfter: vi.fn(async () => ({ events: [], truncated: false })),
    codeSources: vi.fn(async () => ready([])),
    createRun: vi.fn(), cancelRun: vi.fn(), retryRun: vi.fn(),
    run: vi.fn(), runCheckpoint: vi.fn(), pauseRun: vi.fn(), resumeRun: vi.fn(),
    takeoverRun: vi.fn(), decideApproval: vi.fn(), runPulse: vi.fn(),
    createPlan: vi.fn(), updatePlan: vi.fn(), confirmPlan: vi.fn(),
    workspaceAction: vi.fn(async () => ready(workspaceSnapshot)),
    deleteWorkspace: vi.fn(async () => ready({ ...workspaceSnapshot, status: 'deleting' })),
    discardChanges: vi.fn(async () => ready({ revision: 8 })),
    gitCommit: vi.fn(async () => ready({ revision: 8 })),
    createPullRequest: vi.fn(async () => ready({ pullRequestId: 'pr-1' })),
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

describe('2-7 上下文镜头', () => {
  it('会话顶部可收起镜头：展开后按优先级呈现条目，抑制条目带原因不消失', async () => {
    const { remote, fns } = fakeRemote()
    render(<CloudWorkspacesView remote={remote} useWorkspaces={useWorkspacesStub} projectId="project-alpha" projects={projects} sessionId="sess-1" />)
    await screen.findAllByText('ws-alpha-1')

    const toggle = screen.getByRole('button', { name: '上下文镜头' })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')

    fireEvent.click(toggle)
    await waitFor(() => {
      expect(fns.contextLens).toHaveBeenCalledWith('ws-alpha-1')
    })
    const panel = await screen.findByRole('region', { name: '上下文镜头' })
    expect(panel.textContent).toContain('安全与平台规则基线')
    expect(panel.textContent).toContain('已抑制：与现行组织策略冲突')
    expect(panel.textContent).toContain('已抑制：资产版本已过期')
    expect(panel.textContent).toContain('已抑制：知识来源未授权')
    expect(panel.textContent).toContain('记忆：协作偏好（2026-09）')
    // 收起后镜头内容不再显示
    fireEvent.click(screen.getByRole('button', { name: '上下文镜头' }))
    expect(screen.queryByRole('region', { name: '上下文镜头' })).toBeNull()
  })

  it('权限判定与项目文件小节由服务端判定与工作空间变更合成', async () => {
    const { remote } = fakeRemote()
    render(<CloudWorkspacesView remote={remote} useWorkspaces={useWorkspacesStub} projectId="project-alpha" projects={projects} sessionId="sess-1" />)
    await screen.findAllByText('ws-alpha-1')

    fireEvent.click(screen.getByRole('button', { name: '上下文镜头' }))
    const panel = await screen.findByRole('region', { name: '上下文镜头' })
    expect(panel.textContent).toContain('workspace.write')
    expect(panel.textContent).toContain('admin.audit.read')
    expect(panel.textContent).toContain('拒绝')
    expect(panel.textContent).toContain('README.md')
    expect(panel.textContent).toContain('Agent 修改')
  })

  it('§11.17 按运行关闭单条记忆：不绑定运行不给开关，选定运行后开关只作用于该运行', async () => {
    const { remote, fns } = fakeRemote()
    render(<CloudWorkspacesView remote={remote} useWorkspaces={useWorkspacesStub} projectId="project-alpha" projects={projects} sessionId="sess-1" />)
    await screen.findAllByText('ws-alpha-1')

    fireEvent.click(screen.getByRole('button', { name: '上下文镜头' }))
    const panel = await screen.findByRole('region', { name: '上下文镜头' })
    // 抑制按运行归键：没有绑定运行就没有「本次运行」可关闭，因而不提供开关。
    expect(within(panel).queryByRole('button', { name: '关闭本次运行的影响' })).toBeNull()

    fireEvent.change(within(panel).getByLabelText('镜头作用运行'), { target: { value: 'run-seed-1' } })
    await waitFor(() => {
      expect(fns.contextLens).toHaveBeenCalledWith('ws-alpha-1', 'run-seed-1')
    })
    const toggle = await within(panel).findByRole('button', { name: '关闭本次运行的影响' })
    expect(toggle.getAttribute('data-memory-id')).toBe('mem-collab-pref')

    fireEvent.click(toggle)
    await waitFor(() => {
      expect(fns.suppressContextLensMemory).toHaveBeenCalledWith('ws-alpha-1', 'run-seed-1', 'mem-collab-pref', true)
    })
    // 服务端返回的就是更新后的快照：条目仍在、原因写明是本运行的抑制、按钮变成恢复。
    expect(await within(panel).findByText(/用户已在本运行中关闭该记忆的影响/u)).toBeTruthy()
    expect(within(panel).getByRole('button', { name: '恢复本次运行的影响' })).toBeTruthy()
  })
})
