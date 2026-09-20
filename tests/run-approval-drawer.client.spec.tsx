// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { CloudWorkspacesView } from '../src/client/cloud-workspaces/CloudWorkspacesView'
import type { ClientRemote, TeamSkillProject } from '@deepseek-ai/dsh-api-remotes/client'

// 2-4「审批、暂停、接管、恢复与证据抽屉」插件面验收（§11.10 + 蓝图 §2-4）：
// - 审批卡：影响对象、权限、资产版本、风险、可撤销方式、有效期全部来自服务端
//   审批实体，逐项可见；
// - 证据抽屉：成功、失败（拒绝）都能打开，字段=request ID、HTTP 状态、服务端
//   原因、revision、审计 ID、影响对象、下一步动作；
// - 接管：按钮可见，调用后运行 operator 更新。

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const ready = <T,>(value: T): { status: 'ready'; value: T; fixtureOnly: boolean } => ({ status: 'ready', value, fixtureOnly: true })
const failed = (code: string, message: string, extra: Record<string, unknown> = {}): { status: 'failed'; code: string; message: string } & Record<string, unknown> =>
  ({ status: 'failed', code, message, ...extra })

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

const approvalRun = {
  runId: 'run-appr-1', traceId: 'trace-1', projectId: 'project-alpha', workspaceId: 'ws-alpha-1',
  sessionId: 'sess-1', agentProfileVersionId: 'apv-1', assetVersionIds: ['skill:code-review@1.0.0'],
  executionPolicy: { permission_mode: 'approval' }, workspaceRevision: 7, status: 'awaiting_approval',
  writeMode: 'write', leaseId: null, revision: 3, errorCode: null,
  createdAt: '2026-09-10T00:00:00Z', updatedAt: '2026-09-10T00:00:00Z',
}

const approvalEntity = {
  approvalId: 'appr-1', runId: 'run-appr-1', action: 'apply_workspace_changes',
  summary: '写入运行将修改工作空间文件',
  affected: ['src/app.json', 'README.md'],
  permission: { code: 'workspace.write', allowed: true, reason: '项目成员具备写入授权', policyVersion: 'perm-policy@1' },
  assetVersions: [{ assetVersionId: 'skill:code-review@1.0.0', status: 'bound', detail: '已发布' }],
  risk: { level: 'high', reason: '写入运行将修改工作空间文件' },
  revocable: { revocable: true, how: '在运行完成前取消运行' },
  expiresAt: '2026-09-10T00:15:00Z', createdAt: '2026-09-10T00:00:00Z',
}

const approvedRun = {
  ...approvalRun,
  status: 'running', revision: 4,
  evidence: {
    requestId: 'req-approve-1', outcome: 'succeeded', reason: '审批通过', revision: 4,
    auditId: 'audit-1', affected: ['run-appr-1'], nextAction: '等待运行推进',
  },
}

function fakeRemote(overrides: Record<string, ReturnType<typeof vi.fn>> = {}): {
  readonly remote: ClientRemote
  readonly fns: Record<string, ReturnType<typeof vi.fn>>
} {
  const fns: Record<string, ReturnType<typeof vi.fn>> = {
    workspaces: vi.fn(async () => ready([workspaceSnapshot])),
    workspace: vi.fn(async () => ready(workspaceSnapshot)),
    workspaceChanges: vi.fn(async () => ready({
      workspaceId: 'ws-alpha-1', baselineRevision: 5, revision: 7,
      files: [{ path: 'README.md', change: 'modified', diff: '--- a\n+++ b\n+修改' }],
    })),
    workspaceRuns: vi.fn(async () => ready([approvalRun])),
    agentProfiles: vi.fn(async () => ready([profile])),
    workspacePlans: vi.fn(async () => ready([])),
    workspaceFiles: vi.fn(async () => ready({ path: '', kind: 'directory', items: [] })),
    runApproval: vi.fn(async () => ready(approvalEntity)),
    decideApproval: vi.fn(async () => ready(approvedRun)),
    takeoverRun: vi.fn(async () => ready({ ...approvalRun, status: 'awaiting_approval', revision: 5, operator: '管理员', evidence: { requestId: 'req-1', outcome: 'succeeded', reason: '接管', revision: 5, auditId: 'audit-2', affected: ['run-appr-1'], nextAction: '继续监控' } })),
    preview: vi.fn(async () => ready({ path: 'README.md', revision: 7, etag: 'e', kind: 'text', contentType: 'text/plain', content: 'x' })),
    workspacePreview: vi.fn(async () => ready({ path: 'README.md', revision: 7, etag: 'e', kind: 'text', contentType: 'text/plain', content: 'x' })),
    streamState: vi.fn(async () => ({ status: 'live', lastEventId: 'evt-000001' })),
    startStream: vi.fn(async () => ({ subscriptionId: 'sub-1', state: { status: 'connecting' } })),
    stopStream: vi.fn(async () => ({ status: 'idle' })),
    streamEventsAfter: vi.fn(async () => ({ events: [], truncated: false })),
    codeSources: vi.fn(async () => ready([])),
    createRun: vi.fn(), cancelRun: vi.fn(), retryRun: vi.fn(),
    run: vi.fn(), runCheckpoint: vi.fn(), pauseRun: vi.fn(), resumeRun: vi.fn(),
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

function renderView(remote: ClientRemote): void {
  render(<CloudWorkspacesView remote={remote} useWorkspaces={useWorkspacesStub} projectId="project-alpha" projects={projects} sessionId="sess-1" />)
}

describe('2-4 审批卡、接管与证据抽屉', () => {
  it('审批卡逐项显示影响对象、权限、资产版本、风险、可撤销方式与有效期', async () => {
    const { remote } = fakeRemote()
    renderView(remote)
    await screen.findAllByText('ws-alpha-1')
    fireEvent.click(await screen.findByRole('tab', { name: 'Run' }))

    expect(await screen.findByText(/apply_workspace_changes/u)).toBeTruthy()
    expect(screen.getByText('src/app.json')).toBeTruthy()
    expect(screen.getByText('README.md')).toBeTruthy()
    expect(screen.getByText(/workspace\.write/u)).toBeTruthy()
    expect(screen.getByText(/perm-policy@1/u)).toBeTruthy()
    expect(screen.getByText(/skill:code-review@1\.0\.0/u)).toBeTruthy()
    expect(screen.getByText(/高风险/u)).toBeTruthy()
    expect(screen.getByText(/在运行完成前取消运行/u)).toBeTruthy()
    expect(screen.getByText(/2026-09-10T00:15/u)).toBeTruthy()
    expect(screen.getByRole('button', { name: '批准' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '拒绝' })).toBeTruthy()
  })

  it('批准成功 → 证据抽屉：request ID、审计 ID、影响对象、下一步动作、revision', async () => {
    const { remote, fns } = fakeRemote()
    renderView(remote)
    await screen.findAllByText('ws-alpha-1')
    fireEvent.click(await screen.findByRole('tab', { name: 'Run' }))

    fireEvent.click(await screen.findByRole('button', { name: '批准' }))
    await waitFor(() => {
      expect(fns.decideApproval!).toHaveBeenCalled()
    })
    const drawer = await screen.findByRole('complementary', { name: '操作证据' })
    expect(drawer.textContent).toContain('req-approve-1')
    expect(drawer.textContent).toContain('audit-1')
    expect(drawer.textContent).toContain('run-appr-1')
    expect(drawer.textContent).toContain('等待运行推进')
  })

  it('决策被服务端拒绝（revision 冲突）→ 证据抽屉带 HTTP 状态与 request ID', async () => {
    const { remote } = fakeRemote({
      decideApproval: vi.fn(async () => failed('REVISION_CONFLICT', '运行 revision 已变化', { requestId: 'req-409-1', httpStatus: 409 })),
    })
    renderView(remote)
    await screen.findAllByText('ws-alpha-1')
    fireEvent.click(await screen.findByRole('tab', { name: 'Run' }))

    fireEvent.click(await screen.findByRole('button', { name: '批准' }))
    const drawer = await screen.findByRole('complementary', { name: '操作证据' })
    expect(drawer.textContent).toContain('409')
    expect(drawer.textContent).toContain('req-409-1')
    expect(drawer.textContent).toContain('运行 revision 已变化')
    expect(drawer.textContent).toContain('刷新后重试')
  })

  it('权限拒绝（FORBIDDEN）→ 证据抽屉呈现拒绝语义与下一步动作', async () => {
    const { remote } = fakeRemote({
      decideApproval: vi.fn(async () => failed('FORBIDDEN', '当前账号无权审批该运行', { requestId: 'req-403-1', httpStatus: 403 })),
    })
    renderView(remote)
    await screen.findAllByText('ws-alpha-1')
    fireEvent.click(await screen.findByRole('tab', { name: 'Run' }))

    fireEvent.click(await screen.findByRole('button', { name: '批准' }))
    const drawer = await screen.findByRole('complementary', { name: '操作证据' })
    expect(drawer.textContent).toContain('403')
    expect(drawer.textContent).toContain('当前账号无权审批该运行')
    expect(drawer.textContent).toContain('req-403-1')
  })

  it('接管：按钮调用接管并打开成功证据抽屉', async () => {
    const { remote, fns } = fakeRemote()
    renderView(remote)
    await screen.findAllByText('ws-alpha-1')
    fireEvent.click(await screen.findByRole('tab', { name: 'Run' }))

    fireEvent.click(await screen.findByRole('button', { name: '接管' }))
    await waitFor(() => {
      expect(fns.takeoverRun!).toHaveBeenCalled()
    })
    const drawer = await screen.findByRole('complementary', { name: '操作证据' })
    expect(drawer.textContent).toContain('req-1')
    expect(drawer.textContent).toContain('继续监控')
  })
})
