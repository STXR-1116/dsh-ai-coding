// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { CloudWorkspacesView } from '../src/client/cloud-workspaces/CloudWorkspacesView'
import type { ClientRemote, TeamSkillProject } from '@deepseek-ai/dsh-api-remotes/client'

// 3-5「运行资产版本快照」插件面验收（§11.18 A）：
// - 资产快照按需读取（不进入运行面板不取数）；
// - 绑定时事实与读取时刻状态分别呈现，「读取时已撤回、绑定时就绪」不许被合并；
// - 绑定后发生变化的资产明说「本运行不受影响」，并给出资产治理审计行。

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
  agentProfileVersionId: 'apv-1', assetVersionIds: ['skill:code-review@1.0.0'],
  executionPolicy: {}, workspaceRevision: 7, status: 'running', writeMode: 'read_only', leaseId: null,
  revision: 2, errorCode: null, createdAt: '2026-09-16T00:00:00Z', updatedAt: '2026-09-16T00:01:00Z',
}

// 视图消费 Host 严格解析后的 camelCase 快照。
const assetSnapshotDto = {
  runId: 'run-live',
  capturedAt: '2026-09-16T00:00:00Z',
  runRevision: 2,
  assets: [
    {
      assetType: 'skill', assetId: 'skill:code-review', assetVersionId: 'skill:code-review@1.0.0',
      name: '代码评审 Skill', required: true, order: 1,
      readinessAtBinding: 'ready', unavailableReasonAtBinding: null,
      currentState: 'withdrawn', withdrawnAt: '2026-09-16T02:00:00Z', withdrawalAuditId: 'audit-1',
    },
    {
      assetType: 'knowledge', assetId: 'knowledge:k-1', assetVersionId: 'knowledge:k-1',
      name: '知识库 k-1', required: true, order: 2,
      readinessAtBinding: 'ready', unavailableReasonAtBinding: null,
      currentState: 'bound', withdrawnAt: null, withdrawalAuditId: null,
    },
  ],
  governance: [
    { auditId: 'audit-1', action: 'asset.version.withdraw', actorName: '平台管理员', at: '2026-09-16T02:00:00Z', assetVersionId: 'skill:code-review@1.0.0' },
  ],
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
    runAssetSnapshot: vi.fn(async () => ready(assetSnapshotDto)),
    streamState: vi.fn(async () => ({ status: 'live', lastEventId: 'evt-000001' })),
    startStream: vi.fn(async () => ({ subscriptionId: 'sub-1', state: { status: 'connecting' } })),
    stopStream: vi.fn(async () => ({ status: 'idle' })),
    streamEventsAfter: vi.fn(async () => ({ events: [], truncated: false })),
    codeSources: vi.fn(async () => ready([])),
    pauseRun: vi.fn(), resumeRun: vi.fn(), runCheckpoint: vi.fn(), runPulse: vi.fn(), cancelRun: vi.fn(),
    createRun: vi.fn(), startRun: vi.fn(), workspaceAction: vi.fn(async () => ready(workspaceSnapshot)),
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

describe('3-5 运行资产版本快照插件面', () => {
  it('按需读取：绑定时刻事实与读取时刻状态分别呈现，变化项说明本运行不受影响', async () => {
    const { remote, fns } = fakeRemote()
    render(<CloudWorkspacesView remote={remote} useWorkspaces={useWorkspacesStub} projectId="project-alpha" projects={projects} sessionId="sess-1" />)
    fireEvent.click(await screen.findByRole('tab', { name: /Run/u }))
    await screen.findByText('run-live')

    // 按需：打开运行面板不自动取资产快照。
    expect(fns.runAssetSnapshot).not.toHaveBeenCalled()

    fireEvent.click(await screen.findByRole('button', { name: '资产快照-run-live' }))
    await waitFor(() => {
      expect(fns.runAssetSnapshot).toHaveBeenCalledWith('run-live')
    })
    const section = await screen.findByRole('group', { name: '运行资产快照' })
    expect(section.textContent).toContain('绑定时刻的事实已冻结')

    const withdrawn = section.querySelector('[data-asset-version="skill:code-review@1.0.0"]')
    expect(withdrawn?.textContent).toContain('绑定时就绪')
    expect(withdrawn?.textContent).toContain('当前已撤回')
    expect(withdrawn?.textContent).toContain('本运行不受影响')

    // 未变化的资产不出现变化说明：不加噪声。
    const stable = section.querySelector('[data-asset-version="knowledge:k-1"]')
    expect(stable?.textContent).toContain('当前可用')
    expect(stable?.textContent).not.toContain('本运行不受影响')

    // 快照里存在变化项时给出显式提示（不只靠颜色或单个字段表达）。
    expect(await screen.findByRole('status')).toBeTruthy()
    // 跨模块审计：从运行能追到资产治理行。
    expect(section.textContent).toContain('平台管理员')
    expect(section.textContent).toContain('asset.version.withdraw')
  })
})
