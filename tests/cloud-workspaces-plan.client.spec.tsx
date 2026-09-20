// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { CloudWorkspacesView } from '../src/client/cloud-workspaces/CloudWorkspacesView'
import type { ClientRemote, TeamSkillProject } from '@deepseek-ai/dsh-api-remotes/client'

// 1-1「Plan 实体」插件面验收：用户可编辑计划（创建/编辑/确认），编辑形成事件
// （变更摘要进入编辑历史并在界面可见），draft 归属明确（确认后冻结、运行只从
// confirmed 计划创建）。判定对象是视图对 Remote 的真实调用与渲染结果。

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

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

const ready = <T,>(value: T): { status: 'ready'; value: T; fixtureOnly: boolean } => ({ status: 'ready', value, fixtureOnly: true })

const workspaceSnapshot = {
  workspaceId: 'ws-alpha-1',
  projectId: 'project-alpha',
  ownerUserId: 'member-1',
  repositoryId: 'repo-1',
  branch: 'main',
  displayName: '云工作台主空间',
  defaultAgentProfileVersionId: 'apv-1',
  status: 'ready',
  revision: 7,
  lastError: null,
  createdAt: '2026-09-01T00:00:00Z',
  updatedAt: '2026-09-09T00:00:00Z',
}

const profile = {
  agentProfileId: 'ap-1',
  agentProfileVersionId: 'apv-1',
  name: '默认研发代理',
  agentTypeId: 'at-1',
  agentTypeName: 'Claude Code',
  agentTypeKey: 'claude_code',
  agentTypeReadiness: 'ready',
  agentTypeCapabilities: [],
  model: 'deepseek-v3.2',
  reasoning: 'medium',
  skills: [],
  knowledgeBases: [],
  memory: null,
  executionPolicy: {},
  typeExtension: {},
  typeExtensionOpaqueKeys: [],
  readiness: 'ready',
  unavailableReason: null,
  default: true,
  status: 'published' as const,
  createdBy: '平台管理员',
  publishedAt: '2026-09-01T00:00:00Z',
  updatedAt: '2026-09-01T00:00:00Z',
}

const planEdit = {
  editId: 'edit-1',
  editor: '平台管理员',
  editedAt: '2026-09-16T00:01:00Z',
  changeSummary: '补充边界步骤',
  revisionBefore: 1,
  revisionAfter: 2,
  before: {
    goal: '初始目标',
    steps: [{ title: '梳理现有用例', dependsOn: [] }],
    agentProfileVersionId: 'apv-1',
    assetVersionIds: ['skill:code-review@1.0.0'],
  },
}

const draftPlan = {
  planId: 'plan-1',
  projectId: 'project-alpha',
  workspaceId: 'ws-alpha-1',
  goal: '为发布流水线补齐回归测试',
  steps: [{ title: '梳理现有用例', dependsOn: [] }, { title: '补充边界用例', dependsOn: [0] }],
  agentProfileVersionId: 'apv-1',
  assetVersionIds: ['skill:code-review@1.0.0'],
  status: 'draft',
  revision: 2,
  createdBy: 'admin-1',
  createdAt: '2026-09-16T00:00:00Z',
  updatedAt: '2026-09-16T00:01:00Z',
  edits: [planEdit],
}

const confirmedPlan = {
  ...draftPlan,
  planId: 'plan-2',
  goal: '已确认的上线计划',
  status: 'confirmed',
  confirmedBy: 'admin-1',
  confirmedAt: '2026-09-16T00:05:00Z',
  revision: 3,
  edits: [],
}

function fakeRemote(
  planOverrides: { readonly plans?: readonly typeof draftPlan[] } = {},
): { readonly remote: ClientRemote; readonly fns: Record<string, ReturnType<typeof vi.fn>> } {
  const plans = planOverrides.plans ?? [draftPlan, confirmedPlan]
  const cloudWorkspaces = {
    workspaces: vi.fn().mockResolvedValue(ready([workspaceSnapshot])),
    workspace: vi.fn().mockResolvedValue(ready(workspaceSnapshot)),
    workspaceChanges: vi.fn().mockResolvedValue(ready({ workspaceId: 'ws-alpha-1', baselineRevision: 5, revision: 7, files: [] })),
    workspaceRuns: vi.fn().mockResolvedValue(ready([])),
    agentProfiles: vi.fn().mockResolvedValue(ready([profile])),
    workspacePlans: vi.fn().mockResolvedValue(ready(plans)),
    plan: vi.fn().mockResolvedValue(ready(draftPlan)),
    createPlan: vi.fn().mockImplementation(async (input: { goal: string }) =>
      ready({ ...draftPlan, planId: 'plan-new', goal: input.goal, status: 'draft', revision: 1, edits: [] })),
    updatePlan: vi.fn().mockResolvedValue(ready({ ...draftPlan, revision: 3, edits: [planEdit, { ...planEdit, editId: 'edit-2' }] })),
    confirmPlan: vi.fn().mockResolvedValue(ready({ ...draftPlan, status: 'confirmed', confirmedBy: 'admin-1', confirmedAt: '2026-09-16T00:06:00Z' })),
    createRun: vi.fn().mockResolvedValue(ready({
      runId: 'run-plan-1',
      projectId: 'project-alpha',
      workspaceId: 'ws-alpha-1',
      sessionId: 'sess-1',
      agentProfileVersionId: 'apv-1',
      assetVersionIds: ['skill:code-review@1.0.0'],
      executionPolicy: {},
      workspaceRevision: 7,
      status: 'preparing',
      writeMode: 'read_only',
      leaseId: null,
      revision: 1,
      planId: 'plan-2',
      errorCode: null,
      createdAt: '2026-09-16T00:06:00Z',
      updatedAt: '2026-09-16T00:06:00Z',
    })),
    streamState: vi.fn().mockResolvedValue({ status: 'live', lastEventId: 'evt-000009' }),
    startStream: vi.fn().mockResolvedValue({ subscriptionId: 'sub-1', state: { status: 'connecting' } }),
    stopStream: vi.fn().mockResolvedValue({ status: 'idle' }),
    streamEventsAfter: vi.fn().mockResolvedValue({ events: [], truncated: false }),
    workspacePreview: vi.fn().mockResolvedValue(ready({ path: 'README.md', revision: 7, etag: 'md-1', kind: 'markdown', contentType: 'text/markdown', content: '# 云工作空间' })),
    workspaceFiles: vi.fn().mockResolvedValue(ready({ path: '', kind: 'directory', items: [{ path: 'README.md', kind: 'file', size: 24, etag: 'md-1' }] })),
    workspaceFileContent: vi.fn().mockResolvedValue(ready({ path: 'README.md', contentType: 'text/markdown', size: 24, etag: 'md-1', revision: 7, content: '# 云工作空间' })),
    workspacePreviewUrl: vi.fn().mockResolvedValue(ready({ url: 'https://workspace-app.fixture.internal/ws-alpha-1/p/abc', expiresAt: '2099-01-01T00:00:00Z', workspaceId: 'ws-alpha-1' })),
    workspaceAction: vi.fn().mockResolvedValue(ready(workspaceSnapshot)),
    deleteWorkspace: vi.fn().mockResolvedValue(ready({ ...workspaceSnapshot, status: 'deleting' })),
    discardChanges: vi.fn().mockResolvedValue(ready({ revision: 8 })),
    gitCommit: vi.fn().mockResolvedValue(ready({ revision: 8 })),
    createPullRequest: vi.fn().mockResolvedValue(ready({ pullRequestId: 'pr-1' })),
    codeSources: vi.fn().mockResolvedValue(ready([])),
  }
  const wrap = (fn: unknown): unknown =>
    async (...args: unknown[]) => ({ ok: true as const, value: await (fn as (...a: unknown[]) => Promise<unknown>)(...args) })
  const remote = {
    cloudWorkspaces: Object.fromEntries(Object.entries(cloudWorkspaces).map(([name, fn]) => [name, wrap(fn)])),
  } as unknown as ClientRemote
  return { remote, fns: cloudWorkspaces }
}

const useWorkspacesStub = ((selector: (state: { items: unknown[] }) => unknown) => selector({ items: [] })) as never

function renderView(remote: ClientRemote): ReturnType<typeof render> {
  return render(<CloudWorkspacesView remote={remote} useWorkspaces={useWorkspacesStub} projectId="project-alpha" projects={projects} sessionId="sess-1" />)
}

type Fns = Record<string, ReturnType<typeof vi.fn>>

async function waitForCall(fns: Fns, name: string): Promise<unknown> {
  await waitFor(() => {
    expect(fns[name]!.mock.calls.length).toBeGreaterThan(0)
  })
  return (fns[name]!.mock.calls[0] as unknown[])[0]
}

async function openRunPane(): Promise<void> {
  await screen.findAllByText('ws-alpha-1')
  fireEvent.click(screen.getByRole('tab', { name: 'Run' }))
  await screen.findByText('新建计划')
}

describe('1-1 计划实体插件面（用户可编辑）', () => {
  it('计划列表渲染状态、编辑次数与编辑历史（事件可见）', async () => {
    const { remote } = fakeRemote()
    renderView(remote)
    await openRunPane()

    const draftRow = screen.getByText('为发布流水线补齐回归测试').closest('li') as HTMLElement
    expect(within(draftRow).getByText(/草稿 · rev 2 · 编辑 1 次/u)).toBeTruthy()
    expect(within(draftRow).getByText(/补充边界步骤/u)).toBeTruthy()

    const confirmedRow = screen.getByText('已确认的上线计划').closest('li') as HTMLElement
    expect(within(confirmedRow).getByText(/已确认 · rev 3 · 编辑 0 次/u)).toBeTruthy()
  })

  it('编辑草稿计划：保存调用 updatePlan 并携带 revision 与变更摘要', async () => {
    const { remote, fns } = fakeRemote()
    renderView(remote)
    await openRunPane()

    const draftRow = screen.getByText('为发布流水线补齐回归测试').closest('li') as HTMLElement
    fireEvent.click(within(draftRow).getByRole('button', { name: '编辑' }))
    const goal = await screen.findByLabelText('计划目标')
    fireEvent.change(goal, { target: { value: '为发布流水线补齐回归测试与告警' } })
    fireEvent.change(screen.getByLabelText('计划变更摘要'), { target: { value: '补充告警事项' } })
    fireEvent.click(screen.getByRole('button', { name: '保存计划' }))

    const call = await waitForCall(fns, 'updatePlan') as Record<string, unknown>
    expect(call['planId']).toBe('plan-1')
    expect(call['expectedRevision']).toBe(2)
    expect(call['changeSummary']).toBe('补充告警事项')
    expect(call['goal']).toBe('为发布流水线补齐回归测试与告警')
  })

  it('新建计划：保存调用 createPlan，步骤按行拆分且不带默认值', async () => {
    const { remote, fns } = fakeRemote({ plans: [] })
    renderView(remote)
    await openRunPane()

    fireEvent.click(screen.getByRole('button', { name: '新建计划' }))
    fireEvent.change(await screen.findByLabelText('计划目标'), { target: { value: '新目标' } })
    fireEvent.change(screen.getByLabelText('计划步骤'), { target: { value: '步骤一\n步骤二' } })
    fireEvent.change(screen.getByLabelText('计划 Agent 配置版本'), { target: { value: 'apv-1' } })
    fireEvent.click(screen.getByRole('button', { name: '保存计划' }))

    const call = await waitForCall(fns, 'createPlan') as Record<string, unknown>
    expect(call['goal']).toBe('新目标')
    expect(call['agentProfileVersionId']).toBe('apv-1')
    expect(call['steps']).toEqual([{ title: '步骤一' }, { title: '步骤二' }])
  })

  it('draft 归属明确：确认调用 confirmPlan；运行按钮只挂在已确认计划上', async () => {
    const { remote, fns } = fakeRemote()
    renderView(remote)
    await openRunPane()

    const draftRow = screen.getByText('为发布流水线补齐回归测试').closest('li') as HTMLElement
    expect(within(draftRow).queryByRole('button', { name: '从计划创建运行' })).toBeNull()
    fireEvent.click(within(draftRow).getByRole('button', { name: '确认计划' }))
    expect(await waitForCall(fns, 'confirmPlan')).toEqual({ workspaceId: 'ws-alpha-1', planId: 'plan-1' })

    const confirmedRow = screen.getByText('已确认的上线计划').closest('li') as HTMLElement
    expect(within(confirmedRow).queryByRole('button', { name: '编辑' })).toBeNull()
    fireEvent.click(within(confirmedRow).getByRole('button', { name: '从计划创建运行' }))
    const runInput = await waitForCall(fns, 'createRun') as Record<string, unknown>
    expect(runInput['planId']).toBe('plan-2')
    expect(runInput['writeMode']).toBe('read_only')
  })
})
