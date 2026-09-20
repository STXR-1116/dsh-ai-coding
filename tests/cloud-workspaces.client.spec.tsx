// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { CloudWorkspacesView } from '../src/client/cloud-workspaces/CloudWorkspacesView'
import type { ClientRemote, TeamSkillProject } from '@deepseek-ai/dsh-api-remotes/client'
import { WorkspaceHost } from '../src/workspace-host.ts'

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

/** A production (non-fixture) ready outcome: the service declared no fixture provenance. */
const ready = <T,>(value: T): { status: 'ready'; value: T; fixtureOnly: boolean } => ({ status: 'ready', value, fixtureOnly: false })

/** Structural shape of one fake remote method; assertions only inspect `.mock.calls`. */
type FakeFn = { readonly mock: { calls: unknown[][] } } & ((...args: unknown[]) => Promise<unknown>)

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

const codeSource = {
  repositoryId: 'repo-1',
  name: 'harness-web',
  provider: 'gitlab',
  defaultBranch: 'main',
  branches: ['main', 'feature/new'],
}

const secondCodeSource = {
  repositoryId: 'repo-2',
  name: 'data-service',
  provider: 'github',
  defaultBranch: 'main',
  branches: ['main'],
}

const profile = {
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
  agentTypeCapabilities: ['terminal', 'files', 'git'],
  model: 'deepseek-v3.2',
  reasoning: 'medium',
  skills: [
    { assetId: 'skill:code-review', assetVersionId: 'skill:code-review@1.0.0', name: '代码评审 Skill', required: true, order: 1, readiness: 'ready', unavailableReason: null },
  ],
  knowledgeBases: [],
  memory: null,
  executionPolicy: { permission_mode: 'approval', write_mode: 'write' },
  typeExtension: { permission_mode: 'approval' },
  typeExtensionOpaqueKeys: [],
  readiness: 'ready',
  unavailableReason: null,
  default: true,
  status: 'published',
  createdBy: '平台管理员',
  publishedAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-02T00:00:00.000Z',
}

interface RemoteCalls {
  readonly workspaces: FakeFn
  readonly workspace: FakeFn
  readonly workspaceFiles: FakeFn
  readonly workspaceFileContent: FakeFn
  readonly workspacePreview: FakeFn
  readonly run: FakeFn
  readonly createWorkspace: FakeFn
  readonly workspacePreviewUrl: FakeFn
  readonly workspaceChanges: FakeFn
  readonly agentProfiles: FakeFn
  readonly createRun: FakeFn
  readonly cancelRun: FakeFn
  readonly workspaceRuns: FakeFn
  readonly workspacePlans: FakeFn
  readonly plan: FakeFn
  readonly createPlan: FakeFn
  readonly updatePlan: FakeFn
  readonly confirmPlan: FakeFn
  readonly streamState: FakeFn
  readonly startStream: FakeFn
  readonly stopStream: FakeFn
  readonly streamEventsAfter: FakeFn
  readonly codeSources: FakeFn
  readonly workspaceAction: FakeFn
  readonly deleteWorkspace: FakeFn
  readonly discardChanges: FakeFn
  readonly gitCommit: FakeFn
  readonly createPullRequest: FakeFn
}

function fakeRemote(overrides: Partial<RemoteCalls> = {}): { remote: ClientRemote; calls: RemoteCalls } {
  const calls: RemoteCalls = {
    workspaces: vi.fn().mockResolvedValue(ready([workspaceSnapshot])),
    workspace: vi.fn().mockResolvedValue(ready(workspaceSnapshot)),
    workspaceFiles: vi.fn().mockResolvedValue(ready({
      path: '',
      revision: 7,
      items: [
        { path: 'src', kind: 'directory', size: 0, etag: 'dir-src' },
        { path: 'README.md', kind: 'file', size: 24, etag: 'md-1' },
      ],
    })),
    workspaceFileContent: vi.fn().mockResolvedValue(ready({
      path: 'README.md', contentType: 'text/markdown', size: 24, etag: 'md-1', revision: 7, content: '# 云工作空间',
    })),
    workspacePreview: vi.fn().mockResolvedValue(ready({
      path: 'README.md', revision: 7, etag: 'md-1', kind: 'markdown', contentType: 'text/markdown', content: '# 云工作空间',
    })),
    workspaceChanges: vi.fn().mockResolvedValue(ready({
      workspaceId: 'ws-alpha-1',
      baselineRevision: 5,
      revision: 7,
      files: [{ path: 'src/app.json', change: 'modified', diff: '--- a\n+++ b\n@@' }],
    })),
    agentProfiles: vi.fn().mockResolvedValue(ready([profile])),
    codeSources: vi.fn().mockResolvedValue(ready([codeSource, secondCodeSource])),
    createRun: vi.fn().mockResolvedValue(ready({
      runId: 'run-1',
      projectId: 'project-alpha',
      workspaceId: 'ws-alpha-1',
      sessionId: 'sess-1',
      agentProfileVersionId: 'apv-1',
      assetVersionIds: ['skill:code-review@1.0.0'],
      executionPolicy: { permission_mode: 'approval', write_mode: 'write' },
      workspaceRevision: 7,
      status: 'preparing',
      writeMode: 'write',
      leaseId: 'lease-1',
      revision: 1,
      errorCode: null,
      createdAt: '2026-09-09T00:00:00Z',
      updatedAt: '2026-09-09T00:00:00Z',
    })),
    cancelRun: vi.fn().mockResolvedValue(ready({
      ...{ runId: 'run-1' },
      status: 'cancelled',
      writeMode: 'write',
      leaseId: null,
      agentProfileVersionId: 'apv-1',
      assetVersionIds: ['skill:code-review@1.0.0'],
      executionPolicy: { permission_mode: 'approval', write_mode: 'write' },
    })),
    createWorkspace: vi.fn().mockResolvedValue(ready({ ...workspaceSnapshot, workspaceId: 'ws-new', branch: 'feature/new', status: 'provisioning', revision: 1 })),
    run: vi.fn().mockResolvedValue(ready({ runId: 'run-fail', status: 'failed', errorCode: 'RUN_TIMEOUT', agentProfileVersionId: 'apv-1', assetVersionIds: [], executionPolicy: {} })),
    // The grant must still be inside its own deadline when the view renders it.
    workspacePreviewUrl: vi.fn().mockResolvedValue(ready({ url: 'https://workspace-app.fixture.internal/ws-alpha-1/p/abc', expiresAt: '2099-01-01T00:00:00Z', workspaceId: 'ws-alpha-1' })),
    workspaceRuns: vi.fn().mockResolvedValue(ready([])),
    // 1-1 计划面：契约随 §11.6 冻结，fake 必须携带新 Remote 方法。
    workspacePlans: vi.fn().mockResolvedValue(ready([])),
    plan: vi.fn(async () => ready(null)),
    createPlan: vi.fn(async () => ready(null)),
    updatePlan: vi.fn(async () => ready(null)),
    confirmPlan: vi.fn(async () => ready(null)),
    streamState: vi.fn().mockResolvedValue({ status: 'live', lastEventId: 'evt-000009' }),
    // Like `streamState`, the subscription handle is a bare Remote value.
    startStream: vi.fn().mockResolvedValue({ subscriptionId: 'sub-1', state: { status: 'connecting' } }),
    stopStream: vi.fn().mockResolvedValue({ status: 'idle' }),
    // Like `streamState`, this Remote returns its bare value and never a `WorkspaceQueryResult`.
    streamEventsAfter: vi.fn().mockResolvedValue({
      events: [{
        eventId: 'evt-000009',
        resourceType: 'workspace',
        resourceId: 'ws-alpha-1',
        revision: 1,
        eventType: 'workspace.updated',
        occurredAt: '2026-09-09T00:00:00.000Z',
        payloadJson: '{"workspace_id":"ws-alpha-1"}',
      }],
      truncated: false,
    }),
    workspaceAction: vi.fn().mockResolvedValue(ready(workspaceSnapshot)),
    deleteWorkspace: vi.fn().mockResolvedValue(ready({ ...workspaceSnapshot, status: 'deleting' })),
    discardChanges: vi.fn().mockResolvedValue(ready({ revision: 8 })),
    gitCommit: vi.fn().mockResolvedValue(ready({ revision: 8 })),
    createPullRequest: vi.fn().mockResolvedValue(ready({ pullRequestId: 'pr-1' })),
    ...overrides,
  }
  // The generated client wraps every result in the transport envelope; fakes wrap here.
  const wrap = (fn: RemoteCalls['workspaces']): unknown =>
    async (...args: Parameters<RemoteCalls['workspaces']>) => ({ ok: true as const, value: await fn(...args) })
  const remote = {
    cloudWorkspaces: {
      workspaces: wrap(calls.workspaces),
      workspace: wrap(calls.workspace),
      workspaceFiles: wrap(calls.workspaceFiles),
      workspaceFileContent: wrap(calls.workspaceFileContent),
      workspacePreview: wrap(calls.workspacePreview),
      workspacePreviewUrl: wrap(calls.workspacePreviewUrl),
      workspaceChanges: wrap(calls.workspaceChanges),
      agentProfiles: wrap(calls.agentProfiles),
      createRun: wrap(calls.createRun),
      createWorkspace: wrap(calls.createWorkspace),
      run: wrap(calls.run),
      cancelRun: wrap(calls.cancelRun),
      workspaceRuns: wrap(calls.workspaceRuns),
      workspacePlans: wrap(calls.workspacePlans),
      plan: wrap(calls.plan),
      createPlan: wrap(calls.createPlan),
      updatePlan: wrap(calls.updatePlan),
      confirmPlan: wrap(calls.confirmPlan),
      streamState: wrap(calls.streamState),
      startStream: wrap(calls.startStream),
      stopStream: wrap(calls.stopStream),
      streamEventsAfter: wrap(calls.streamEventsAfter),
      codeSources: wrap(calls.codeSources),
      workspaceAction: wrap(calls.workspaceAction),
      deleteWorkspace: wrap(calls.deleteWorkspace),
      discardChanges: wrap(calls.discardChanges),
      gitCommit: wrap(calls.gitCommit),
      createPullRequest: wrap(calls.createPullRequest),
    },
  } as unknown as ClientRemote
  return { remote, calls }
}

const useWorkspacesStub = ((selector: (state: { items: unknown[] }) => unknown) => selector({ items: [] })) as never

function renderView(overrides: Partial<Parameters<typeof CloudWorkspacesView>[0]> = {}): ReturnType<typeof render> {
  const { remote } = fakeRemote()
  return render(<CloudWorkspacesView remote={remote} useWorkspaces={useWorkspacesStub} projectId="project-alpha" projects={projects} sessionId="sess-1" {...overrides} />)
}

describe('CloudWorkspacesView', () => {
  afterEach(() => {
    cleanup()
    window.localStorage.clear()
  })

  it('renders the server workspace snapshot with status, branch and revision', async () => {
    renderView()
    await waitFor(() => {
      expect(screen.getAllByText('ws-alpha-1').length).toBeGreaterThan(0)
    })
    expect(screen.getByText(/main · ready · rev 7/u)).toBeTruthy()
    expect(screen.queryByText('fixture-only')).toBeNull()
  })

  it('consumes the Host SSE event channel instead of only reading the stream state', async () => {
    const { remote, calls } = fakeRemote()
    renderView({ remote })

    await waitFor(() => {
      expect(calls.startStream).toHaveBeenCalled()
      expect(calls.streamEventsAfter).toHaveBeenCalled()
    })
    // The refresh follows the resource each event names, so the workspace snapshot
    // is re-read from the event batch rather than inferred from the stream state.
    await waitFor(() => {
      expect(calls.workspace).toHaveBeenCalled()
    })
  })

  it('loads the remote file tree and shows file previews in the right pane', async () => {
    const { remote, calls } = fakeRemote()
    render(
      <CloudWorkspacesView
        remote={remote}
        useWorkspaces={useWorkspacesStub}
        projectId="project-alpha"
        projects={projects}
        sessionId="sess-1"
      />,
    )
    await waitFor(() => {
      expect(calls.workspaces).toHaveBeenCalledWith('project-alpha')
    })
    const file = await screen.findByText('README.md')
    fireEvent.click(file)
    await waitFor(() => {
      expect(calls.workspacePreview).toHaveBeenCalledWith('ws-alpha-1', 'README.md')
    })
    // README.md renders through the markdown viewer: the heading source becomes an h1.
    expect(await screen.findByText('云工作空间', { selector: '[data-viewer="markdown"] h1' })).toBeTruthy()
  })

  it('renders static HTML previews inside a sandboxed iframe without same-origin', async () => {
    const { remote } = fakeRemote({
      workspaceFiles: vi.fn().mockResolvedValue(ready({
        path: '',
        revision: 7,
        items: [{ path: 'index.html', kind: 'file', size: 64, etag: 'html-1' }],
      })),
      workspacePreview: vi.fn().mockResolvedValue(ready({
        path: 'index.html',
        revision: 7,
        etag: 'html-1',
        kind: 'static_html',
        contentType: 'text/html',
        content: '<!doctype html><html><body>受控预览</body></html>',
        sha256: 'abc',
        csp: "default-src 'none'",
        sandbox: ['allow-scripts'],
      })),
    })
    render(
      <CloudWorkspacesView
        remote={remote}
        useWorkspaces={useWorkspacesStub}
        projectId="project-alpha"
        projects={projects}
        sessionId="sess-1"
      />,
    )
    fireEvent.click(await screen.findByText('index.html'))
    const frame = await screen.findByTitle('preview-iframe')
    expect(frame.getAttribute('sandbox')).toContain('allow-scripts')
    expect(frame.getAttribute('sandbox')).not.toContain('allow-same-origin')
    expect(frame.getAttribute('srcdoc')).toContain('受控预览')
  })

  it('shows the changes diff with baseline and current revision', async () => {
    renderView()
    fireEvent.click(await screen.findByRole('tab', { name: /Changes/u }))
    expect(await screen.findByText(/基线 5/u)).toBeTruthy()
    expect(await screen.findByText(/src\/app\.json/u)).toBeTruthy()
  })

  it('binds the current session when starting a write run and shows busy on conflict', async () => {
    const { remote, calls } = fakeRemote({
      createRun: vi.fn()
        .mockResolvedValueOnce(ready({
          runId: 'run-1',
          projectId: 'project-alpha',
          workspaceId: 'ws-alpha-1',
          sessionId: 'sess-1',
          agentProfileVersionId: 'apv-1',
          assetVersionIds: ['skill:code-review@1.0.0'],
          executionPolicy: { permission_mode: 'approval', write_mode: 'write' },
          workspaceRevision: 7,
          status: 'preparing',
          writeMode: 'write',
          leaseId: 'lease-1',
          revision: 1,
          errorCode: null,
          createdAt: '2026-09-09T00:00:00Z',
          updatedAt: '2026-09-09T00:00:00Z',
        }))
        .mockResolvedValueOnce({
          status: 'failed',
          code: 'WORKSPACE_BUSY',
          message: '同一工作空间已存在写入 Run',
        }),
    })
    render(
      <CloudWorkspacesView
        remote={remote}
        useWorkspaces={useWorkspacesStub}
        projectId="project-alpha"
        projects={projects}
        sessionId="sess-1"
      />,
    )
    fireEvent.click(await screen.findByRole('tab', { name: /Run/u }))
    const start = await screen.findByRole('button', { name: /开始 Run（写入）/u })
    fireEvent.click(start)
    await waitFor(() => {
      expect(calls.createRun).toHaveBeenCalledWith({
        workspaceId: 'ws-alpha-1',
        sessionId: 'sess-1',
        writeMode: 'write',
        expectedWorkspaceRevision: 7,
      })
    })
    expect(await screen.findByText(/run-1/u)).toBeTruthy()
    fireEvent.click(await screen.findByRole('button', { name: /开始 Run（写入）/u }))
    expect(await screen.findByText(/WORKSPACE_BUSY/u)).toBeTruthy()
  })

  it('keeps user content on a revision conflict and offers refresh instead of overwriting', async () => {
    const { remote } = fakeRemote({
      workspaceChanges: vi.fn().mockResolvedValue({
        status: 'failed',
        code: 'REVISION_CONFLICT',
        message: '工作空间已被其他修改更新',
      }),
    })
    render(
      <CloudWorkspacesView
        remote={remote}
        useWorkspaces={useWorkspacesStub}
        projectId="project-alpha"
        projects={projects}
        sessionId="sess-1"
      />,
    )
    fireEvent.click(await screen.findByRole('tab', { name: /Changes/u }))
    expect(await screen.findByText(/REVISION_CONFLICT/u)).toBeTruthy()
    expect(screen.getByRole('button', { name: /刷新/u })).toBeTruthy()
  })

  it('reports signed-out through the authorization failure callback', async () => {
    const onAuthorizationFailure = vi.fn()
    const { remote } = fakeRemote({
      workspaces: vi.fn().mockResolvedValue({ status: 'signed-out' }),
    })
    render(
      <CloudWorkspacesView
        remote={remote}
        useWorkspaces={useWorkspacesStub}
        projectId="project-alpha"
        projects={projects}
        sessionId="sess-1"
        onAuthorizationFailure={onAuthorizationFailure}
      />,
    )
    await waitFor(() => {
      expect(onAuthorizationFailure).toHaveBeenCalled()
    })
    expect(await screen.findByRole('button', { name: '登录' })).toBeTruthy()
  })

  it('issues a controlled web app preview URL from the Preview pane', async () => {
    const { remote, calls } = fakeRemote()
    render(
      <CloudWorkspacesView
        remote={remote}
        useWorkspaces={useWorkspacesStub}
        projectId="project-alpha"
        projects={projects}
        sessionId="sess-1"
      />,
    )
    await screen.findByRole('button', { name: /打开 Web App/u })
    await waitFor(() => {
      const button = screen.getByRole('button', { name: /打开 Web App/u }) as HTMLButtonElement
      expect(button.disabled).toBe(false)
    })
    fireEvent.click(screen.getByRole('button', { name: /打开 Web App/u }))
    await waitFor(() => {
      expect(calls.workspacePreviewUrl).toHaveBeenCalledWith('ws-alpha-1', 3000)
    })
    await new Promise(r => setTimeout(r, 100))
    expect(await screen.findByText(/workspace-app\.fixture\.internal/u)).toBeTruthy()
    expect(screen.getByRole('link', { name: /workspace-app\.fixture\.internal/u }).getAttribute('rel')).toContain('noopener')
  })

  it('creates a workspace from the left pane form with server-authorized inputs', async () => {
    const { remote, calls } = fakeRemote()
    render(
      <CloudWorkspacesView
        remote={remote}
        useWorkspaces={useWorkspacesStub}
        projectId="project-alpha"
        projects={projects}
        sessionId="sess-1"
      />,
    )
    await screen.findAllByText('ws-alpha-1')
    // The repository list is the service's authorization answer, so the wizard
    // offers exactly the repositories it returned.
    await waitFor(() => {
      expect(screen.getByLabelText('创建代码源')).toBeTruthy()
      expect(screen.getByLabelText<HTMLSelectElement>('创建代码源').value).toBe('repo-1')
    })
    expect(screen.queryByRole('option', { name: /repo-9/u })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '下一步：选择分支' }))
    fireEvent.change(screen.getByLabelText('创建分支'), { target: { value: 'feature/new' } })
    fireEvent.click(screen.getByRole('button', { name: '下一步：选择 Agent 配置' }))
    await waitFor(() => {
      expect(screen.getByLabelText('创建 Agent 配置')).toBeTruthy()
    }, { timeout: 5000 })
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '下一步：确认创建' })).toHaveProperty('disabled', false)
    }, { timeout: 5000 })
    fireEvent.click(screen.getByRole('button', { name: '下一步：确认创建' }))
    fireEvent.click(screen.getByRole('button', { name: /创建 Workspace/u }))
    await waitFor(() => {
      expect(calls.createWorkspace).toHaveBeenCalledWith(expect.objectContaining({
        projectId: 'project-alpha',
        repositoryId: 'repo-1',
        branch: 'feature/new',
        agentProfileVersionId: 'apv-1',
      }))
    })
  })

  it('expands directories in the remote file tree', async () => {
    const { remote, calls } = fakeRemote()
    render(
      <CloudWorkspacesView
        remote={remote}
        useWorkspaces={useWorkspacesStub}
        projectId="project-alpha"
        projects={projects}
        sessionId="sess-1"
      />,
    )
    await screen.findByText('src')
    fireEvent.click(screen.getByRole('button', { name: 'src' }))
    await waitFor(() => {
      expect(calls.workspaceFiles).toHaveBeenLastCalledWith('ws-alpha-1', 'src')
    })
  })

  it('disables the file tree while the workspace is not ready', async () => {
    const { remote } = fakeRemote({
      workspace: vi.fn().mockResolvedValue(ready({ ...workspaceSnapshot, status: 'provisioning', revision: 1 })),
    })
    render(
      <CloudWorkspacesView
        remote={remote}
        useWorkspaces={useWorkspacesStub}
        projectId="project-alpha"
        projects={projects}
        sessionId="sess-1"
      />,
    )
    const file = await screen.findByRole('button', { name: 'README.md' })
    expect((file as HTMLButtonElement).disabled).toBe(true)
  })

  it('starts a run with the selected agent profile override', async () => {
    const profile2 = { ...profile, agentProfileId: 'ap-2', agentProfileVersionId: 'apv-2', name: '覆盖代理', default: false }
    const { remote, calls } = fakeRemote({
      agentProfiles: vi.fn().mockResolvedValue(ready([profile, profile2])),
    })
    render(
      <CloudWorkspacesView
        remote={remote}
        useWorkspaces={useWorkspacesStub}
        projectId="project-alpha"
        projects={projects}
        sessionId="sess-1"
      />,
    )
    await screen.findAllByText('ws-alpha-1')
    fireEvent.change(screen.getByLabelText('Agent 配置覆盖'), { target: { value: 'apv-2' } })
    fireEvent.click(screen.getByRole('tab', { name: /Run/u }))
    fireEvent.click(await screen.findByRole('button', { name: /开始 Run（写入）/u }))
    await waitFor(() => {
      expect(calls.createRun).toHaveBeenCalledWith(expect.objectContaining({ agentProfileVersionId: 'apv-2' }))
    })
  })

  it('shows the run error code and stage timeline from the run detail', async () => {
    const { remote, calls } = fakeRemote({
      workspaceRuns: vi.fn().mockResolvedValue(ready([{
        runId: 'run-fail',
        projectId: 'project-alpha',
        workspaceId: 'ws-alpha-1',
        sessionId: 'sess-1',
        agentProfileVersionId: 'apv-1',
        assetVersionIds: ['skill:code-review@1.0.0'],
        executionPolicy: { permission_mode: 'approval', write_mode: 'write' },
        workspaceRevision: 7,
        status: 'failed',
        writeMode: 'write',
        leaseId: null,
        revision: 5,
        errorCode: 'RUN_TIMEOUT',
        createdAt: '2026-09-09T00:00:00Z',
        updatedAt: '2026-09-09T00:01:00Z',
      }])),
      run: vi.fn().mockResolvedValue(ready({
        runId: 'run-fail',
        status: 'failed',
        errorCode: 'RUN_TIMEOUT',
        timeline: [
          {
            status: 'preparing',
            at: '2026-09-09T00:00:00Z',
            reason: 'Run 已创建',
            operator: '平台管理员',
            policyVersion: 'apv-1',
            revision: 1,
            traceId: 'trace-1',
          },
          {
            status: 'failed',
            at: '2026-09-09T00:01:00Z',
            reason: '超时',
            operator: 'system',
            policyVersion: 'apv-1',
            revision: 2,
            traceId: 'trace-1',
          },
        ],
      })),
    })
    render(
      <CloudWorkspacesView
        remote={remote}
        useWorkspaces={useWorkspacesStub}
        projectId="project-alpha"
        projects={projects}
        sessionId="sess-1"
      />,
    )
    fireEvent.click(screen.getByRole('tab', { name: /Run/u }))
    await screen.findByText('run-fail')
    // 恢复中心的证据明细也会显示该错误码：断言至少出现一次即可。
    expect((screen.getAllByText(/RUN_TIMEOUT/u)).length).toBeGreaterThan(0)
    const runRow = screen.getByText('run-fail').closest('li') as HTMLElement
    fireEvent.click(within(runRow).getByRole('button', { name: /时间线/u }))
    await waitFor(() => {
      expect(calls.run).toHaveBeenCalledWith('run-fail')
    })
    expect(await screen.findByText(/超时/u)).toBeTruthy()
  })

  it('persists the last selection per account and project and clears it on sign-out', async () => {
    const key = 'cloud-workspace-ui:member-1:project-alpha'
    function renderFor(accountId: string, remote: ClientRemote): void {
      render(
        <CloudWorkspacesView
          remote={remote}
          useWorkspaces={useWorkspacesStub}
          projectId="project-alpha"
          projects={projects}
          sessionId="sess-1"
          accountId={accountId}
        />,
      )
    }
    const first = fakeRemote()
    renderFor('member-1', first.remote)
    await screen.findAllByText('ws-alpha-1')
    await waitFor(() => {
      expect(window.localStorage.getItem(key)).toBeTruthy()
    })
    // Another account's workbench neither reads nor writes that record.
    expect(window.localStorage.getItem('cloud-workspace-ui:member-2:project-alpha')).toBeNull()
    cleanup()

    const signed = fakeRemote({ workspaces: vi.fn().mockResolvedValue({ status: 'signed-out' }) })
    renderFor('member-1', signed.remote)
    await screen.findByRole('button', { name: '登录' })
    expect(window.localStorage.getItem(key)).toBeNull()
  })

  it('does not restore the previous account’s selection after a switch', async () => {
    const first = fakeRemote({
      workspaces: vi.fn().mockResolvedValue(ready([{ ...workspaceSnapshot, workspaceId: 'ws-other', projectId: 'project-alpha' }])),
    })
    render(
      <CloudWorkspacesView
        remote={first.remote}
        useWorkspaces={useWorkspacesStub}
        projectId="project-alpha"
        projects={projects}
        sessionId="sess-1"
        accountId="member-1"
      />,
    )
    await screen.findAllByText('ws-other')
    await waitFor(() => {
      expect(window.localStorage.getItem('cloud-workspace-ui:member-1:project-alpha')).toBeTruthy()
    })
    // A second account starts from its own (empty) record: the first account's
    // workspace selection is not restored into a context it never authorized.
    const second = fakeRemote()
    render(
      <CloudWorkspacesView
        remote={second.remote}
        useWorkspaces={useWorkspacesStub}
        projectId="project-alpha"
        projects={projects}
        sessionId="sess-1"
        accountId="member-2"
      />,
    )
    await waitFor(() => {
      expect((second.calls.workspace as unknown as { mock: { calls: unknown[][] } }).mock.calls.length).toBeGreaterThan(0)
    })
    expect(window.localStorage.getItem('cloud-workspace-ui:member-2:project-alpha')).toBeTruthy()
  })

  it('requires a project before touching the service', async () => {
    const { remote, calls } = fakeRemote()
    render(
      <CloudWorkspacesView
        remote={remote}
        useWorkspaces={useWorkspacesStub}
        projects={projects}
        sessionId="sess-1"
      />,
    )
    expect(await screen.findByText('选择项目后展示服务端授权的 Workspace。')).toBeTruthy()
    expect(calls.workspaces).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Real-HTTP fixture lane.
//
// Everything below boots an HTTP-level cloud-workspace service on a real port
// and drives the view through a real WorkspaceHost over real sockets. Stream
// state, lifecycle transitions and rejections are produced by the service, never
// injected into the component. The service is a spec-local HTTP fixture rather
// than the Team Skill application: the client compiler program does not list
// apps/**, so importing that host source here would break the client typecheck.
// ---------------------------------------------------------------------------

/** Workspace lifecycle states the fixture models (subset of the service's). */
type FixtureStatus =
  | 'draft'
  | 'provisioning'
  | 'starting'
  | 'ready'
  | 'degraded'
  | 'stopping'
  | 'stopped'
  | 'failed'
  | 'archived'
  | 'deleting'

interface FixtureWorkspace {
  readonly workspaceId: string
  readonly projectId: string
  readonly ownerUserId: string
  readonly repositoryId: string
  readonly branch: string
  readonly displayName: string
  readonly defaultAgentProfileVersionId: string
  status: FixtureStatus
  revision: number
  lastError: string | null
  readonly createdAt: string
  updatedAt: string
  transitionAt?: number | undefined
  transitionTo?: FixtureStatus | undefined
}

interface FixtureEvent {
  readonly eventId: string
  readonly resourceType: 'workspace' | 'run' | 'file' | 'changes'
  readonly resourceId: string
  readonly revision: number
  readonly eventType: string
  readonly occurredAt: string
  readonly payload: Record<string, unknown>
  readonly projectIds: readonly string[]
}

interface FixtureChangeFile {
  readonly path: string
  readonly change: 'added' | 'modified' | 'deleted'
  readonly diff: string
}

/** The service's authorized code sources for `project-alpha`, as wire DTOs. */
const CODE_SOURCE_DTOS = [
  { repository_id: 'repo-1', name: 'harness-web', provider: 'gitlab', default_branch: 'main', branches: ['main', 'feature/new', 'feature/stream'] },
  { repository_id: 'repo-2', name: 'data-service', provider: 'github', default_branch: 'main', branches: ['main'] },
]

const PROFILE_DTO = {
  agent_profile_id: 'ap-code-default',
  agent_profile_version_id: 'apv-1',
  name: '默认研发代理',
  description: '面向研发工作空间的默认执行配置',
  version_label: 'v1',
  change_summary: '首个发布版本',
  agent_type_id: 'at-claude-code',
  agent_type_name: 'Claude Code',
  agent_type_key: 'claude_code',
  agent_type_readiness: 'ready',
  agent_type_capabilities: ['terminal', 'files', 'git'],
  model: 'deepseek-v3.2',
  reasoning: 'medium',
  skills: [
    { asset_id: 'skill:code-review', asset_version_id: 'skill:code-review@1.0.0', name: '代码评审 Skill', required: true, order: 1, readiness: 'ready', unavailable_reason: null },
  ],
  knowledge_bases: [],
  memory: null,
  execution_policy: { permission_mode: 'approval', write_mode: 'write' },
  type_extension_config: { permission_mode: 'approval' },
  readiness: 'ready',
  unavailable_reason: null,
  default: true,
  status: 'published',
  created_by: '平台管理员',
  published_at: '2026-09-01T00:00:00.000Z',
  updated_at: '2026-09-02T00:00:00.000Z',
}

const LIFECYCLE_FROM: Record<'start' | 'stop' | 'retry' | 'archive' | 'delete', readonly FixtureStatus[]> = {
  start: ['draft', 'stopped', 'failed'],
  stop: ['provisioning', 'starting', 'ready', 'degraded'],
  retry: ['failed'],
  archive: ['draft', 'provisioning', 'starting', 'ready', 'degraded', 'stopped', 'failed'],
  delete: ['stopped', 'archived', 'failed', 'draft'],
}

const LIFECYCLE_TO: Record<'start' | 'stop' | 'retry' | 'archive' | 'delete', FixtureStatus> = {
  start: 'starting',
  stop: 'stopped',
  retry: 'provisioning',
  archive: 'archived',
  delete: 'deleting',
}

/**
 * HTTP-level cloud-workspace service used by this spec.
 *
 * Owns the same `/v1` workspace surface as the Team Skill fixture - revision
 * guards, mandatory idempotency keys, lazy lifecycle transitions, provenance
 * headers and an SSE stream with replay watermarks, retention pruning and
 * `resync_required` - so the real Host and the view run end to end over real
 * sockets without the client program importing Host-side application source.
 */
class WorkspaceHttpFixture {
  private readonly server = createServer((request, response) => {
    void this.dispatch(request, response)
  })

  private readonly workspaces = new Map<string, FixtureWorkspace>()
  private readonly changeSets = new Map<string, FixtureChangeFile[]>()
  private readonly baselines = new Map<string, number>()
  private readonly runs = new Map<string, Record<string, unknown>>()
  private readonly events: FixtureEvent[] = []
  private readonly subscribers = new Set<(chunk: string) => void>()
  private readonly replayed = new Map<string, { fingerprint: string; status: number; data: unknown }>()
  private readonly auditRecords: Record<string, unknown>[] = []
  private counter = 0
  private eventCounter = 0
  private pruneEvents = false

  constructor() {
    const now = Date.now()
    const changed: readonly FixtureChangeFile[] = [
      { path: 'src/app.json', change: 'modified', diff: '--- a/src/app.json\n+++ b/src/app.json\n@@ -1 +1 @@' },
    ]
    const seed = (
      workspace: FixtureWorkspace,
      baseline: number,
      files: readonly FixtureChangeFile[],
    ): void => {
      this.workspaces.set(workspace.workspaceId, workspace)
      this.baselines.set(workspace.workspaceId, baseline)
      this.changeSets.set(workspace.workspaceId, [...files])
    }
    seed({
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
      createdAt: new Date(now - 3_600_000).toISOString(),
      updatedAt: new Date(now - 60_000).toISOString(),
    }, 5, changed)
    seed({
      workspaceId: 'ws-alpha-2',
      projectId: 'project-alpha',
      ownerUserId: 'member-1',
      repositoryId: 'repo-1',
      branch: 'develop',
      displayName: '联调预置空间',
      defaultAgentProfileVersionId: 'apv-1',
      status: 'provisioning',
      revision: 1,
      lastError: null,
      createdAt: new Date(now - 1000).toISOString(),
      updatedAt: new Date(now - 1000).toISOString(),
      transitionAt: now + 60_000,
      transitionTo: 'starting',
    }, 1, [])
    seed({
      workspaceId: 'ws-alpha-3',
      projectId: 'project-alpha',
      ownerUserId: 'member-1',
      repositoryId: 'repo-1',
      branch: 'feature/fix',
      displayName: '失败待重试空间',
      defaultAgentProfileVersionId: 'apv-1',
      status: 'failed',
      revision: 3,
      lastError: '初始化失败：磁盘配额不足',
      createdAt: new Date(now - 7_200_000).toISOString(),
      updatedAt: new Date(now - 3_600_000).toISOString(),
    }, 3, [])
    this.append('workspace', 'ws-alpha-1', 1, 'workspace.created', { project_id: 'project-alpha' })
    this.append('workspace', 'ws-alpha-1', 2, 'workspace.provisioning', { project_id: 'project-alpha' })
    this.append('workspace', 'ws-alpha-1', 3, 'workspace.updated', { project_id: 'project-alpha', status: 'starting' })
    this.append('workspace', 'ws-alpha-1', 4, 'workspace.ready', { project_id: 'project-alpha', status: 'ready' })
    this.append('changes', 'ws-alpha-1', 7, 'changes.updated', { project_id: 'project-alpha', files: 1 })
  }

  /** Binds the fixture to an ephemeral loopback port. */
  async listen(): Promise<number> {
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject)
      this.server.listen(0, '127.0.0.1', () => {
        resolve()
      })
    })
    return (this.server.address() as AddressInfo).port
  }

  /** Stops the fixture and drops every keep-alive connection. */
  async close(): Promise<void> {
    for (const subscriber of this.subscribers) subscriber('')
    this.subscribers.clear()
    this.server.closeAllConnections()
    await new Promise<void>((resolve) => {
      this.server.close(() => {
        resolve()
      })
    })
  }

  private async dispatch(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    const requestId = `req-${(this.counter += 1)}`
    const parts = url.pathname.split('/').filter(part => part.length > 0)
    const scenario = request.headers['x-fixture-scenario']
    if (scenario === 'workspace-prune-events') this.pruneEvents = true
    const authorization = request.headers.authorization
    const token = typeof authorization === 'string' && authorization.startsWith('Bearer ')
      ? authorization.slice('Bearer '.length)
      : undefined
    if (parts[0] !== 'v1') {
      this.fail(response, 404, requestId, 'RESOURCE_NOT_FOUND', '资源不存在')
      return
    }
    if (parts[1] === 'admin') {
      if (token !== 'admin-demo') {
        this.fail(response, 403, requestId, 'FORBIDDEN', '当前账号无权访问管理接口')
        return
      }
      this.handleAdmin(parts, url, response, requestId)
      return
    }
    if (token !== 'demo-token') {
      this.fail(response, 401, requestId, 'AUTH_REQUIRED', '未认证的请求')
      return
    }
    if (scenario === 'workspace-expired-token') {
      this.fail(response, 401, requestId, 'TOKEN_EXPIRED', '访问令牌已过期，请重新登录')
      return
    }
    if (scenario === 'workspace-downstream-failure') {
      this.fail(response, 503, requestId, 'SERVICE_UNAVAILABLE', '下游运行时暂不可用，请稍后重试')
      return
    }
    await this.handleUser(parts, request, response, url, requestId)
  }

  private handleAdmin(
    parts: readonly string[],
    url: URL,
    response: ServerResponse,
    requestId: string,
  ): void {
    if (parts[2] === 'audits') {
      const workspaceId = url.searchParams.get('workspace_id')
      const action = url.searchParams.get('action')
      const items = this.auditRecords
        .filter(audit => workspaceId === null || audit.workspace_id === workspaceId)
        .filter(audit => action === null || audit.action === action)
        .reverse()
      this.sendJson(response, 200, requestId, items)
      return
    }
    this.fail(response, 404, requestId, 'RESOURCE_NOT_FOUND', '资源不存在')
  }

  private async handleUser(
    parts: readonly string[],
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
    requestId: string,
  ): Promise<void> {
    const method = request.method ?? 'GET'
    if (method === 'GET' && parts[1] === 'me' && parts[2] === 'code-sources') {
      if (url.searchParams.get('project_id') !== 'project-alpha') {
        this.fail(response, 422, requestId, 'PROJECT_REQUIRED', 'project_id 必填')
        return
      }
      this.sendJson(response, 200, requestId, { items: CODE_SOURCE_DTOS })
      return
    }
    if (method === 'GET' && parts[1] === 'me' && parts[2] === 'agent-profiles') {
      if (url.searchParams.get('project_id') !== 'project-alpha') {
        this.fail(response, 422, requestId, 'PROJECT_REQUIRED', 'project_id 必填')
        return
      }
      this.sendJson(response, 200, requestId, { items: [PROFILE_DTO] })
      return
    }
    if (method === 'GET' && parts[1] === 'projects' && parts[3] === 'workspaces' && parts.length === 4) {
      const projectId = decodeURIComponent(parts[2] ?? '')
      if (projectId !== 'project-alpha') {
        this.fail(response, 404, requestId, 'RESOURCE_NOT_FOUND', '资源不存在')
        return
      }
      const items = [...this.workspaces.values()]
        .filter(workspace => workspace.projectId === projectId)
        .map(workspace => this.dto(this.advance(workspace)))
      this.sendJson(response, 200, requestId, { items })
      return
    }
    if (method === 'POST' && parts[1] === 'projects' && parts[3] === 'workspaces' && parts.length === 4) {
      await this.createWorkspace(request, response, requestId)
      return
    }
    if (method === 'GET' && parts[1] === 'events' && parts[2] === 'stream') {
      this.openEventStream(request, response, url, requestId)
      return
    }
    if (parts[1] === 'workspaces' && parts.length >= 3) {
      await this.handleWorkspace(parts, request, response, url, requestId)
      return
    }
    this.fail(response, 404, requestId, 'RESOURCE_NOT_FOUND', '资源不存在')
  }

  private async handleWorkspace(
    parts: readonly string[],
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
    requestId: string,
  ): Promise<void> {
    const method = request.method ?? 'GET'
    const raw = parts[2] ?? ''
    const colon = raw.indexOf(':')
    const workspaceId = decodeURIComponent(colon === -1 ? raw : raw.slice(0, colon))
    const action: string | undefined = colon === -1 ? parts[3] : raw.slice(colon + 1)
    const workspace = this.workspaces.get(workspaceId)
    if (workspace === undefined) {
      this.fail(response, 404, requestId, 'RESOURCE_NOT_FOUND', '资源不存在')
      return
    }
    if (action === undefined) {
      if (method === 'GET') {
        this.sendJson(response, 200, requestId, this.dto(this.advance(workspace)))
        return
      }
      if (method === 'DELETE') {
        await this.lifecycle(request, response, requestId, workspace, 'delete')
        return
      }
      this.fail(response, 422, requestId, 'VALIDATION_ERROR', '不支持的工作空间请求')
      return
    }
    if (method === 'POST' && (action === 'start' || action === 'stop' || action === 'retry' || action === 'archive')) {
      await this.lifecycle(request, response, requestId, workspace, action)
      return
    }
    const advanced = this.advance(workspace)
    if (method === 'GET' && action === 'files') {
      this.sendJson(response, 200, requestId, {
        path: url.searchParams.get('path') ?? '',
        revision: advanced.revision,
        items: [
          { path: 'src', kind: 'directory', size: 0, etag: 'dir-src' },
          { path: 'README.md', kind: 'file', size: 24, etag: 'md-1' },
        ],
      })
      return
    }
    if (method === 'GET' && action === 'changes') {
      this.sendJson(response, 200, requestId, {
        workspace_id: advanced.workspaceId,
        baseline_revision: this.baselines.get(advanced.workspaceId) ?? advanced.revision,
        revision: advanced.revision,
        files: this.changeSets.get(advanced.workspaceId) ?? [],
      })
      return
    }
    // §11.6 计划契约：服务桩按冻结契约返回空计划列表。
    if (method === 'GET' && action === 'plans') {
      this.sendJson(response, 200, requestId, { items: [] })
      return
    }
    if (method === 'GET' && action === 'runs') {
      const items = [...this.runs.values()].filter(run => run.workspace_id === advanced.workspaceId)
      this.sendJson(response, 200, requestId, { items })
      return
    }
    if (method === 'POST' && action === 'runs') {
      await this.createRun(request, response, requestId, advanced)
      return
    }
    if (method === 'POST' && action === 'changes:discard') {
      await this.discardChanges(request, response, requestId, advanced)
      return
    }
    if (method === 'POST' && action === 'git' && parts[4] === 'commit') {
      await this.gitCommit(request, response, requestId, advanced)
      return
    }
    if (method === 'POST' && action === 'git' && parts[4] === 'pull-request') {
      await this.gitPullRequest(request, response, requestId, advanced)
      return
    }
    this.fail(response, 404, requestId, 'RESOURCE_NOT_FOUND', '资源不存在')
  }

  private async createWorkspace(
    request: IncomingMessage,
    response: ServerResponse,
    requestId: string,
  ): Promise<void> {
    const action = 'workspace.create'
    const body = await this.readJson(request)
    const claim = this.claim(request, response, requestId, action, body)
    if (claim === undefined) return
    const branch = typeof body.branch === 'string' ? body.branch : ''
    const repositoryId = typeof body.repository_id === 'string' ? body.repository_id : ''
    const profileVersionId = typeof body.agent_profile_version_id === 'string' ? body.agent_profile_version_id : ''
    if (branch.length === 0 || repositoryId.length === 0 || profileVersionId.length === 0) {
      this.fail(response, 422, requestId, 'VALIDATION_ERROR', 'repository_id、branch 和 agent_profile_version_id 必填')
      return
    }
    // The service owns which repositories exist for a project: a request naming
    // one it never published is denied rather than quietly created.
    const source = CODE_SOURCE_DTOS.find(candidate => candidate.repository_id === repositoryId)
    if (source === undefined || !(source.branches as readonly string[]).includes(branch)) {
      this.fail(response, 403, requestId, 'FORBIDDEN', '该仓库或分支未授权用于此项目')
      return
    }
    const now = new Date().toISOString()
    const workspace: FixtureWorkspace = {
      workspaceId: `ws-${(this.counter += 1)}-new`,
      projectId: 'project-alpha',
      ownerUserId: 'member-1',
      repositoryId,
      branch,
      displayName: typeof body.display_name === 'string' && body.display_name.length > 0 ? body.display_name : branch,
      defaultAgentProfileVersionId: profileVersionId,
      status: 'provisioning',
      revision: 1,
      lastError: null,
      createdAt: now,
      updatedAt: now,
      transitionAt: Date.now() + 200,
      transitionTo: 'starting',
    }
    this.workspaces.set(workspace.workspaceId, workspace)
    this.baselines.set(workspace.workspaceId, 1)
    this.changeSets.set(workspace.workspaceId, [])
    this.append('workspace', workspace.workspaceId, 1, 'workspace.created', { project_id: workspace.projectId })
    this.append('workspace', workspace.workspaceId, 1, 'workspace.provisioning', { project_id: workspace.projectId })
    this.record(workspace, action, 'succeeded', null)
    const dto = this.dto(workspace)
    this.remember(claim, dto, 202)
    this.sendJson(response, 202, requestId, dto)
  }

  private async lifecycle(
    request: IncomingMessage,
    response: ServerResponse,
    requestId: string,
    workspace: FixtureWorkspace,
    operation: 'start' | 'stop' | 'retry' | 'archive' | 'delete',
  ): Promise<void> {
    const action = `workspace.${operation}`
    const body = await this.readJson(request)
    const claim = this.claim(request, response, requestId, action, body)
    if (claim === undefined) return
    if (operation !== 'start' && operation !== 'retry' && this.expectedRevision(request, body) !== workspace.revision) {
      this.fail(response, 409, requestId, 'REVISION_CONFLICT', '工作空间已被其他修改更新')
      this.record(workspace, action, 'failed', 'REVISION_CONFLICT')
      return
    }
    if (!LIFECYCLE_FROM[operation].includes(workspace.status)) {
      this.fail(response, 409, requestId, 'INVALID_STATUS', `当前状态 ${workspace.status} 不允许 ${operation}`)
      this.record(workspace, action, 'failed', 'INVALID_STATUS')
      return
    }
    this.transition(workspace, LIFECYCLE_TO[operation])
    const dto = this.dto(workspace)
    if (operation === 'delete') this.workspaces.delete(workspace.workspaceId)
    this.record(workspace, action, 'succeeded', null)
    const status = operation === 'start' || operation === 'retry' ? 202 : 200
    this.remember(claim, dto, status)
    this.sendJson(response, status, requestId, dto)
  }

  private async discardChanges(
    request: IncomingMessage,
    response: ServerResponse,
    requestId: string,
    workspace: FixtureWorkspace,
  ): Promise<void> {
    const action = 'changes.discard'
    const body = await this.readJson(request)
    const claim = this.claim(request, response, requestId, action, body)
    if (claim === undefined) return
    if (this.expectedRevision(request, body) !== workspace.revision) {
      this.fail(response, 409, requestId, 'REVISION_CONFLICT', '工作空间已被其他修改更新')
      this.record(workspace, action, 'failed', 'REVISION_CONFLICT')
      return
    }
    this.clearChanges(workspace)
    const dto = { revision: workspace.revision }
    this.record(workspace, action, 'succeeded', null)
    this.remember(claim, dto, 200)
    this.sendJson(response, 200, requestId, dto)
  }

  private async gitCommit(
    request: IncomingMessage,
    response: ServerResponse,
    requestId: string,
    workspace: FixtureWorkspace,
  ): Promise<void> {
    const action = 'git.commit'
    const body = await this.readJson(request)
    const claim = this.claim(request, response, requestId, action, body)
    if (claim === undefined) return
    if (typeof body.message !== 'string' || body.message.length === 0) {
      this.fail(response, 422, requestId, 'VALIDATION_ERROR', 'message 必填')
      return
    }
    if (this.expectedRevision(request, body) !== workspace.revision) {
      this.fail(response, 409, requestId, 'REVISION_CONFLICT', '工作空间已被其他修改更新')
      this.record(workspace, action, 'failed', 'REVISION_CONFLICT')
      return
    }
    this.clearChanges(workspace)
    const dto = { committed: true, revision: workspace.revision }
    this.record(workspace, action, 'succeeded', null)
    this.remember(claim, dto, 200)
    this.sendJson(response, 200, requestId, dto)
  }

  private async gitPullRequest(
    request: IncomingMessage,
    response: ServerResponse,
    requestId: string,
    workspace: FixtureWorkspace,
  ): Promise<void> {
    const action = 'git.pull_request'
    const body = await this.readJson(request)
    const claim = this.claim(request, response, requestId, action, body)
    if (claim === undefined) return
    if (typeof body.title !== 'string' || body.title.length === 0) {
      this.fail(response, 422, requestId, 'VALIDATION_ERROR', 'title 必填')
      return
    }
    if (this.expectedRevision(request, body) !== workspace.revision) {
      this.fail(response, 409, requestId, 'REVISION_CONFLICT', '工作空间已被其他修改更新')
      this.record(workspace, action, 'failed', 'REVISION_CONFLICT')
      return
    }
    const dto = { pull_request_id: `pr-${(this.counter += 1).toString(16).padStart(8, '0')}`, title: body.title }
    this.record(workspace, action, 'succeeded', null)
    this.remember(claim, dto, 200)
    this.sendJson(response, 200, requestId, dto)
  }

  private async createRun(
    request: IncomingMessage,
    response: ServerResponse,
    requestId: string,
    workspace: FixtureWorkspace,
  ): Promise<void> {
    const action = 'run.create'
    const body = await this.readJson(request)
    const claim = this.claim(request, response, requestId, action, body)
    if (claim === undefined) return
    if (workspace.status !== 'ready') {
      this.fail(response, 409, requestId, 'INVALID_STATUS', `工作空间状态 ${workspace.status} 不允许创建 Run`)
      return
    }
    if (this.expectedRevision(request, body) !== workspace.revision) {
      this.fail(response, 409, requestId, 'REVISION_CONFLICT', '工作空间已被其他修改更新')
      return
    }
    const busy = [...this.runs.values()].find(run =>
      run.workspace_id === workspace.workspaceId
      && run.write_mode === 'write'
      && ['preparing', 'awaiting_approval', 'running', 'paused', 'awaiting_user'].includes(String(run.status)))
    if (busy !== undefined) {
      this.failWithPayload(response, 409, requestId, 'WORKSPACE_BUSY', '同一工作空间已存在写入 Run', { current_run: busy })
      return
    }
    const now = new Date().toISOString()
    const run = {
      run_id: `run-${(this.counter += 1)}`,
      project_id: workspace.projectId,
      workspace_id: workspace.workspaceId,
      session_id: typeof body.session_id === 'string' ? body.session_id : '',
      agent_profile_version_id: workspace.defaultAgentProfileVersionId,
      asset_version_ids: ['skill:code-review@1.0.0'],
      execution_policy: { permission_mode: 'approval', write_mode: 'write' },
      workspace_revision: workspace.revision,
      status: 'preparing',
      write_mode: body.write_mode,
      lease_id: `lease-${this.counter}`,
      revision: 1,
      error_code: null,
      created_at: now,
      updated_at: now,
      events: [{
        status: 'preparing',
        at: now,
        reason: 'Run 已创建',
        operator: '平台管理员',
        policyVersion: 'apv-1',
        revision: 1,
        traceId: 'trace-1',
      }],
    }
    this.runs.set(run.run_id, run)
    this.append('run', run.run_id, 1, 'run.created', { project_id: workspace.projectId, workspace_id: workspace.workspaceId })
    this.remember(claim, run, 202)
    this.sendJson(response, 202, requestId, run)
  }

  private openEventStream(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
    requestId: string,
  ): void {
    if (url.searchParams.get('project_id') !== 'project-alpha') {
      this.fail(response, 404, requestId, 'RESOURCE_NOT_FOUND', '资源不存在')
      return
    }
    const workspaceId = url.searchParams.get('workspace_id')
    response.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-fixture-only': 'true',
    })
    const write = (chunk: string): void => {
      response.write(chunk)
    }
    const visible = this.pruneEvents ? this.events.slice(-2) : this.events
    const inScope = (event: FixtureEvent): boolean =>
      workspaceId === null || event.resourceId === workspaceId || event.payload.workspace_id === workspaceId
    const retained = visible.filter(inScope)
    const after = url.searchParams.get('after') ?? ''
    if (after.length > 0) {
      const watermark = visible.find(event => event.eventId === after)
      if (watermark === undefined) {
        write(this.frame('resync_required', { code: 'RESYNC_REQUIRED', message: '事件已超出保留窗口，请重新读取快照' }, 'evt-resync'))
      } else {
        for (const event of retained.filter(candidate => candidate.eventId > watermark.eventId)) {
          write(this.frame(event.eventType, this.eventDto(event), event.eventId))
        }
        write(this.frame('stream.replay-done', { last_event_id: watermark.eventId }, 'evt-replay-done'))
      }
    } else {
      for (const event of retained) write(this.frame(event.eventType, this.eventDto(event), event.eventId))
      write(this.frame('stream.replay-done', { last_event_id: retained.at(-1)?.eventId ?? '' }, 'evt-replay-done'))
    }
    this.subscribers.add(write)
    const heartbeat = setInterval(() => {
      write(': ping\n\n')
    }, 15_000)
    const cleanup = (): void => {
      clearInterval(heartbeat)
      this.subscribers.delete(write)
    }
    response.on('close', cleanup)
    request.on('close', cleanup)
  }

  private frame(eventType: string, data: unknown, eventId: string): string {
    return `event: ${eventType}\ndata: ${JSON.stringify(data)}\nid: ${eventId}\n\n`
  }

  private eventDto(event: FixtureEvent): Record<string, unknown> {
    return {
      event_id: event.eventId,
      resource_type: event.resourceType,
      resource_id: event.resourceId,
      revision: event.revision,
      event_type: event.eventType,
      occurred_at: event.occurredAt,
      payload: event.payload,
    }
  }

  private append(
    resourceType: FixtureEvent['resourceType'],
    resourceId: string,
    revision: number,
    eventType: string,
    payload: Record<string, unknown>,
  ): void {
    this.eventCounter += 1
    const event: FixtureEvent = {
      eventId: `evt-${String(this.eventCounter).padStart(6, '0')}`,
      resourceType,
      resourceId,
      revision,
      eventType,
      occurredAt: new Date().toISOString(),
      payload,
      projectIds: ['project-alpha'],
    }
    this.events.push(event)
    for (const subscriber of this.subscribers) subscriber(this.frame(eventType, this.eventDto(event), event.eventId))
  }

  private advance(workspace: FixtureWorkspace): FixtureWorkspace {
    if (workspace.transitionAt === undefined || workspace.transitionTo === undefined) return workspace
    if (Date.now() < workspace.transitionAt) return workspace
    this.transition(workspace, workspace.transitionTo)
    return workspace
  }

  private transition(workspace: FixtureWorkspace, to: FixtureStatus): void {
    workspace.status = to
    workspace.revision += 1
    workspace.updatedAt = new Date().toISOString()
    const followUp: Partial<Record<FixtureStatus, FixtureStatus>> = { provisioning: 'starting', starting: 'ready' }
    const next = followUp[to]
    if (next === undefined) {
      workspace.transitionAt = undefined
      workspace.transitionTo = undefined
    } else {
      workspace.transitionAt = Date.now() + 200
      workspace.transitionTo = next
    }
    const eventType = to === 'ready' ? 'workspace.ready' : to === 'failed' ? 'workspace.failed' : 'workspace.updated'
    this.append('workspace', workspace.workspaceId, workspace.revision, eventType, {
      project_id: workspace.projectId,
      status: to,
    })
  }

  private clearChanges(workspace: FixtureWorkspace): void {
    this.changeSets.set(workspace.workspaceId, [])
    workspace.revision += 1
    workspace.updatedAt = new Date().toISOString()
    this.append('changes', workspace.workspaceId, workspace.revision, 'changes.updated', {
      project_id: workspace.projectId,
      files: 0,
    })
  }

  private dto(workspace: FixtureWorkspace): Record<string, unknown> {
    return {
      workspace_id: workspace.workspaceId,
      project_id: workspace.projectId,
      owner_user_id: workspace.ownerUserId,
      repository_id: workspace.repositoryId,
      branch: workspace.branch,
      display_name: workspace.displayName,
      default_agent_profile_version_id: workspace.defaultAgentProfileVersionId,
      status: workspace.status,
      revision: workspace.revision,
      last_error: workspace.lastError,
      created_at: workspace.createdAt,
      updated_at: workspace.updatedAt,
    }
  }

  private record(
    workspace: FixtureWorkspace,
    action: string,
    result: 'succeeded' | 'failed',
    errorCode: string | null,
  ): void {
    this.auditRecords.push({
      workspace_id: workspace.workspaceId,
      action,
      result,
      error_code: errorCode,
      revision: workspace.revision,
    })
  }

  private claim(
    request: IncomingMessage,
    response: ServerResponse,
    requestId: string,
    action: string,
    body: Record<string, unknown>,
  ): { readonly key: string; readonly fingerprint: string } | undefined {
    const header = request.headers['idempotency-key']
    const key = typeof header === 'string' ? header : undefined
    if (key === undefined || key.length === 0) {
      this.fail(response, 400, requestId, 'IDEMPOTENCY_KEY_REQUIRED', '危险写操作必须提供 Idempotency-Key')
      return undefined
    }
    const fingerprint = `${request.method ?? 'GET'} ${new URL(request.url ?? '/', 'http://127.0.0.1').pathname} ${action} ${JSON.stringify(body)}`
    const previous = this.replayed.get(key)
    if (previous !== undefined) {
      if (previous.fingerprint !== fingerprint) {
        this.fail(response, 409, requestId, 'IDEMPOTENCY_CONFLICT', '幂等键已用于另一请求')
        return undefined
      }
      this.sendJson(response, previous.status, requestId, previous.data)
      return undefined
    }
    return { key, fingerprint }
  }

  private remember(
    claim: { readonly key: string; readonly fingerprint: string },
    data: unknown,
    status: number,
  ): void {
    this.replayed.set(claim.key, { fingerprint: claim.fingerprint, data, status })
  }

  private expectedRevision(request: IncomingMessage, body: Record<string, unknown>): number | undefined {
    const header = request.headers['if-match']
    if (typeof header === 'string' && header.length > 0) {
      const parsed = Number(header)
      return Number.isFinite(parsed) ? parsed : undefined
    }
    const expected = body.expected_workspace_revision
    return typeof expected === 'number' && Number.isFinite(expected) ? expected : undefined
  }

  private async readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Uint8Array[] = []
    for await (const chunk of request as AsyncIterable<Uint8Array | string>) {
      chunks.push(typeof chunk === 'string' ? new TextEncoder().encode(chunk) : chunk)
    }
    if (chunks.length === 0) return {}
    const merged = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.byteLength, 0))
    let offset = 0
    for (const chunk of chunks) {
      merged.set(chunk, offset)
      offset += chunk.byteLength
    }
    const text = new TextDecoder().decode(merged)
    if (text.length === 0) return {}
    try {
      const parsed: unknown = JSON.parse(text)
      return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
    } catch {
      return {}
    }
  }

  private sendJson(response: ServerResponse, status: number, requestId: string, data: unknown): void {
    response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'x-fixture-only': 'true' })
    response.end(JSON.stringify({ code: 0, message: 'ok', request_id: requestId, data }))
  }

  private fail(response: ServerResponse, status: number, requestId: string, code: string, message: string): void {
    response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'x-fixture-only': 'true' })
    response.end(JSON.stringify({ code, message, request_id: requestId, data: null }))
  }

  private failWithPayload(
    response: ServerResponse,
    status: number,
    requestId: string,
    code: string,
    message: string,
    payload: Record<string, unknown>,
  ): void {
    response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'x-fixture-only': 'true' })
    response.end(JSON.stringify({ code, message, request_id: requestId, ...payload, data: null }))
  }
}

const fixtures: WorkspaceHttpFixture[] = []

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.close()
})

interface RecordedRequest {
  readonly method: string
  readonly path: string
  /** Body as the component emitted it, before any test-side rewrite. */
  readonly body: Record<string, unknown> | undefined
  readonly headers: Readonly<Record<string, string>>
}

interface HarnessHooks {
  /** Rewrites an outgoing JSON body on the wire; the recorded body stays untouched. */
  mutateBody?: (path: string, body: Record<string, unknown>) => Record<string, unknown>
  /** Rewrites a JSON payload on the way back; used to model a stale client view. */
  patchPayload?: (path: string, payload: Record<string, unknown>) => Record<string, unknown>
}

interface Harness {
  readonly remote: ClientRemote
  readonly host: WorkspaceHost
  readonly port: number
  readonly requests: RecordedRequest[]
  readonly hooks: HarnessHooks
  readonly scenario: { current: string | undefined }
  readonly drops: { failNext: number; abortActive: () => void }
}

async function bootHarness(): Promise<Harness> {
  const fixture = new WorkspaceHttpFixture()
  fixtures.push(fixture)
  const port = await fixture.listen()
  const requests: RecordedRequest[] = []
  const hooks: HarnessHooks = {}
  const scenario = { current: undefined as string | undefined }
  const activeStreams: AbortController[] = []
  const drops = {
    failNext: 0,
    abortActive: (): void => {
      for (const controller of activeStreams.splice(0)) controller.abort()
    },
  }
  const realFetch = globalThis.fetch
  const fetcher: typeof globalThis.fetch = async (input, init) => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const parsed = new URL(raw)
    const path = `${parsed.pathname}${parsed.search}`
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
    if (scenario.current !== undefined) headers.set('x-fixture-scenario', scenario.current)
    let wireBody = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : undefined
    requests.push({
      method: init?.method ?? 'GET',
      path,
      body: wireBody,
      headers: Object.fromEntries(headers.entries()),
    })
    if (wireBody !== undefined && hooks.mutateBody !== undefined) wireBody = hooks.mutateBody(path, wireBody)
    const outgoing: RequestInit = {
      ...init,
      headers,
      ...(wireBody === undefined ? {} : { body: JSON.stringify(wireBody) }),
    }
    if (parsed.pathname === '/v1/events/stream') {
      if (drops.failNext > 0) {
        drops.failNext -= 1
        return new Response('', { status: 200, headers: { 'content-type': 'text/event-stream' } })
      }
      const controller = new AbortController()
      activeStreams.push(controller)
      const signal = init?.signal === undefined || init.signal === null
        ? controller.signal
        : AbortSignal.any([init.signal, controller.signal])
      return realFetch(raw, { ...outgoing, signal })
    }
    const response = await realFetch(raw, outgoing)
    const contentType = response.headers.get('content-type') ?? ''
    if (hooks.patchPayload === undefined || !contentType.includes('application/json')) return response
    const text = await response.text()
    let payload: unknown
    try {
      payload = JSON.parse(text)
    } catch {
      return new Response(text, { status: response.status, headers: response.headers })
    }
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
      return new Response(text, { status: response.status, headers: response.headers })
    }
    const patched = hooks.patchPayload(path, payload as Record<string, unknown>)
    return new Response(JSON.stringify(patched), { status: response.status, headers: response.headers })
  }
  let idempotencyCounter = 0
  const host = new WorkspaceHost({
    apiBaseUrl: `http://127.0.0.1:${port}`,
    session: {
      read: async () => ({ accessToken: 'demo-token', identity: 'identity:demo-token' }),
      clear: async () => true,
    },
    fetch: fetcher,
    idempotencyKey: () => `spec-idempotency-${++idempotencyCounter}`,
    reconnectDelayMs: () => 700,
  })
  const envelope = async <T,>(run: Promise<T>): Promise<{ ok: true; value: T }> => ({ ok: true, value: await run })
  const remote = {
    cloudWorkspaces: {
      workspaces: (projectId: string) => envelope(host.workspaces(projectId)),
      workspace: (workspaceId: string) => envelope(host.workspace(workspaceId)),
      workspaceFiles: (workspaceId: string, path: string) => envelope(host.workspaceFiles(workspaceId, path)),
      workspaceFileContent: (workspaceId: string, path: string) => envelope(host.workspaceFileContent(workspaceId, path)),
      workspaceChanges: (workspaceId: string) => envelope(host.workspaceChanges(workspaceId)),
      workspacePreview: (workspaceId: string, path: string) => envelope(host.workspacePreview(workspaceId, path)),
      workspacePreviewUrl: (workspaceId: string, appPort: number) => envelope(host.issuePreviewUrl(workspaceId, appPort)),
      agentProfiles: (projectId: string) => envelope(host.agentProfiles(projectId)),
      codeSources: (projectId: string) => envelope(host.codeSources(projectId)),
      createWorkspace: (input: Parameters<WorkspaceHost['createWorkspace']>[0]) => envelope(host.createWorkspace(input)),
      workspaceAction: (workspaceId: string, action: 'start' | 'stop' | 'retry' | 'archive', expectedRevision?: number) =>
        envelope(host.workspaceAction(workspaceId, action, expectedRevision)),
      deleteWorkspace: (workspaceId: string, expectedRevision: number) => envelope(host.deleteWorkspace(workspaceId, expectedRevision)),
      discardChanges: (workspaceId: string, expectedRevision: number) => envelope(host.discardChanges(workspaceId, expectedRevision)),
      gitCommit: (workspaceId: string, message: string, expectedRevision: number) =>
        envelope(host.gitCommit(workspaceId, message, expectedRevision)),
      createPullRequest: (workspaceId: string, title: string, expectedRevision: number) =>
        envelope(host.createPullRequest(workspaceId, title, expectedRevision)),
      createRun: (input: Parameters<WorkspaceHost['createRun']>[0]) => envelope(host.createRun(input)),
      workspaceRuns: (workspaceId: string) => envelope(host.workspaceRuns(workspaceId)),
      workspacePlans: (workspaceId: string) => envelope(host.workspacePlans(workspaceId)),
      plan: (workspaceId: string, planId: string) => envelope(host.plan(workspaceId, planId)),
      createPlan: (input: Parameters<WorkspaceHost['createPlan']>[0]) => envelope(host.createPlan(input)),
      updatePlan: (input: Parameters<WorkspaceHost['updatePlan']>[0]) => envelope(host.updatePlan(input)),
      confirmPlan: (input: Parameters<WorkspaceHost['confirmPlan']>[0]) => envelope(host.confirmPlan(input)),
      run: (runId: string) => envelope(host.run(runId)),
      cancelRun: (runId: string) => envelope(host.cancelRun(runId)),
      retryRun: (runId: string, expectedWorkspaceRevision: number) => envelope(host.retryRun(runId, expectedWorkspaceRevision)),
      streamState: (subscriptionId: string) => envelope(Promise.resolve(host.streamState(subscriptionId))),
      startStream: (scope: { readonly projectId: string; readonly workspaceId?: string; readonly lastEventId?: string }) =>
        envelope(Promise.resolve(host.startStream(scope))),
      stopStream: (subscriptionId: string) => {
        host.stopStream(subscriptionId)
        return envelope(Promise.resolve(host.streamState(subscriptionId)))
      },
      streamEventsAfter: (subscriptionId: string, afterEventId: string) =>
        envelope(Promise.resolve(host.streamEventsAfter(afterEventId, subscriptionId))),
    },
  } as unknown as ClientRemote
  return { remote, host, port, requests, hooks, scenario, drops }
}

function renderHarness(harness: Harness, overrides: Partial<Parameters<typeof CloudWorkspacesView>[0]> = {}): ReturnType<typeof render> {
  return render(
    <CloudWorkspacesView
      remote={harness.remote}
      useWorkspaces={useWorkspacesStub}
      projectId="project-alpha"
      projects={projects}
      sessionId="sess-1"
      {...overrides}
    />,
  )
}

/** Fixture suites boot a service and poll a live stream, so they get a larger budget. */
const fixtureIt = (name: string, run: () => Promise<void>): void => {
  it(name, run, 25_000)
}

/** Reads the response envelope `data` of a direct (non-fetch-wrapper) service call. */
async function serviceJson(harness: Harness, path: string, token: string, init: RequestInit = {}): Promise<unknown> {
  const headers = new Headers(init.headers)
  headers.set('authorization', `Bearer ${token}`)
  if (init.body !== undefined) headers.set('content-type', 'application/json')
  const response = await globalThis.fetch(`http://127.0.0.1:${harness.port}${path}`, { ...init, headers })
  const body = await response.json() as { data: unknown }
  return body.data
}

/** Audit records the service wrote for one query, most recent first. */
async function audits(harness: Harness, query: string): Promise<readonly Record<string, unknown>[]> {
  const items = await serviceJson(harness, `/v1/admin/audits?${query}`, 'admin-demo')
  return items as readonly Record<string, unknown>[]
}

/** Last recorded write request whose path matches, or undefined when none was sent. */
function lastRequest(harness: Harness, fragment: string): RecordedRequest | undefined {
  return harness.requests.filter(request => request.method !== 'GET' && request.path.includes(fragment)).at(-1)
}

function streamRequests(harness: Harness, workspaceId: string): readonly RecordedRequest[] {
  return harness.requests.filter(request => request.path.includes('/v1/events/stream') && request.path.includes(`workspace_id=${workspaceId}`))
}

/** Waits until the selected workspace shows the given lifecycle status label. */
async function waitForStatus(label: string | RegExp): Promise<void> {
  await waitFor(() => {
    expect(screen.getAllByText(label).length).toBeGreaterThan(0)
  }, { timeout: 8000 })
}

/** Models a stale client view: the reported status of one workspace is pinned. */
function forceStaleStatus(harness: Harness, workspaceId: string, status: string): void {
  const patchDto = (dto: Record<string, unknown>): Record<string, unknown> =>
    dto.workspace_id === workspaceId && typeof dto.branch === 'string' && typeof dto.revision === 'number'
      ? { ...dto, status }
      : dto
  harness.hooks.patchPayload = (path, payload) => {
    if (!path.startsWith('/v1/workspaces/') && !path.startsWith('/v1/projects/')) return payload
    const data = payload.data
    if (data === null || typeof data !== 'object' || Array.isArray(data)) return payload
    const record = data as Record<string, unknown>
    if (Array.isArray(record.items)) {
      return {
        ...payload,
        data: { ...record, items: record.items.map((item: unknown) => (item !== null && typeof item === 'object' ? patchDto(item as Record<string, unknown>) : item)) },
      }
    }
    const patched = patchDto(record)
    return patched === record ? payload : { ...payload, data: patched }
  }
}

describe('CloudWorkspacesView 云工作空间事件流（真实 HTTP fixture）', () => {
  afterEach(() => {
    cleanup()
    window.localStorage.clear()
  })

  fixtureIt('establishes exactly one scoped subscription and releases it on unmount', async () => {
    const harness = await bootHarness()
    const view = renderHarness(harness)
    await screen.findAllByText('ws-alpha-1')
    await waitFor(() => {
      expect(screen.getAllByText('实时已连接').length).toBeGreaterThan(0)
    }, { timeout: 8000 })

    const subscriptions = streamRequests(harness, 'ws-alpha-1')
    expect(subscriptions).toHaveLength(1)
    expect(subscriptions[0]?.path).toContain('project_id=project-alpha')
    expect(subscriptions[0]?.path).toContain('after=')
    expect(harness.host.streamState().status).toBe('live')

    view.unmount()
    await waitFor(() => {
      expect(harness.host.streamState().status).toBe('idle')
    })
    expect(streamRequests(harness, 'ws-alpha-1')).toHaveLength(1)
  })

  fixtureIt('releases the old subscription and opens exactly one for the switched workspace', async () => {
    const harness = await bootHarness()
    renderHarness(harness)
    await screen.findAllByText('ws-alpha-1')
    await waitFor(() => {
      expect(screen.getAllByText('实时已连接').length).toBeGreaterThan(0)
    }, { timeout: 8000 })
    expect(streamRequests(harness, 'ws-alpha-1')).toHaveLength(1)

    fireEvent.click(await screen.findByRole('button', { name: /ws-alpha-3/u }))
    await waitFor(() => {
      expect(streamRequests(harness, 'ws-alpha-3')).toHaveLength(1)
    }, { timeout: 8000 })
    // The single Host stream now carries the new scope: ws-alpha-3 has no
    // events of its own, so the previously live state cannot survive the swap.
    await waitFor(() => {
      expect(harness.host.streamState().status).not.toBe('live')
    }, { timeout: 8000 })
    expect(streamRequests(harness, 'ws-alpha-1')).toHaveLength(1)

    fireEvent.click(await screen.findByRole('button', { name: /ws-alpha-1/u }))
    await waitFor(() => {
      expect(streamRequests(harness, 'ws-alpha-1')).toHaveLength(2)
    }, { timeout: 8000 })
    await waitFor(() => {
      expect(screen.getAllByText('实时已连接').length).toBeGreaterThan(0)
    }, { timeout: 8000 })
  })

  fixtureIt('drives provisioning-to-ready purely from fixture SSE state', async () => {
    const harness = await bootHarness()
    renderHarness(harness)
    await screen.findAllByText('ws-alpha-1')
    // The create form only offers a branch once the authorized code sources
    // have arrived, so the interaction waits for that state.
    await screen.findByLabelText('创建代码源')

    fireEvent.click(screen.getByRole('button', { name: '下一步：选择分支' }))
    fireEvent.change(screen.getByLabelText('创建分支'), { target: { value: 'feature/stream' } })
    fireEvent.click(screen.getByRole('button', { name: '下一步：选择 Agent 配置' }))
    fireEvent.click(screen.getByRole('button', { name: '下一步：确认创建' }))
    await waitFor(() => {
      // The form stays disabled until the published profiles arrive.
      expect(screen.getByRole<HTMLButtonElement>('button', { name: /创建 Workspace/u }).disabled).toBe(false)
    }, { timeout: 8000 })
    fireEvent.click(screen.getByRole('button', { name: /创建 Workspace/u }))
    await waitFor(() => {
      expect(lastRequest(harness, '/workspaces')).toBeTruthy()
    }, { timeout: 8000 })

    // No manual refresh: the polled Host stream state is the only trigger.
    await waitFor(() => {
      expect(screen.getAllByText(/初始化中|启动中/u).length).toBeGreaterThan(0)
    }, { timeout: 8000 })
    // Reaching ready is fixture-side work triggered only by the polled stream state.
    await waitFor(() => {
      expect(screen.getByText(/feature\/stream · ready · rev 3/u)).toBeTruthy()
    }, { timeout: 8000 })
  })

  fixtureIt('shows the disconnected state and recovers to live after reconnects', async () => {
    const harness = await bootHarness()
    renderHarness(harness)
    await screen.findAllByText('ws-alpha-1')
    await waitFor(() => {
      expect(screen.getAllByText('实时已连接').length).toBeGreaterThan(0)
    }, { timeout: 8000 })

    harness.drops.failNext = 2
    harness.drops.abortActive()
    await waitFor(() => {
      expect(screen.getAllByText('已断线，重连中').length).toBeGreaterThan(0)
    }, { timeout: 8000 })
    // The service keeps working through the outage; the resumed watermark
    // subscription replays what the dropped connection missed.
    await serviceJson(harness, '/v1/workspaces/ws-alpha-1:stop', 'demo-token', {
      method: 'POST',
      headers: { 'idempotency-key': 'raw-stop-disconnect' },
      body: JSON.stringify({ expected_workspace_revision: 7 }),
    })
    await waitFor(() => {
      expect(screen.getAllByText('实时已连接').length).toBeGreaterThan(0)
    }, { timeout: 8000 })
    await waitForStatus('已停止')
  })

  fixtureIt('resyncs on the fixture resync_required signal and re-reads the snapshot', async () => {
    const harness = await bootHarness()
    // Pruning keeps only the last two events, so a reconnecting Host whose
    // watermark fell out of the window is told to resync.
    harness.scenario.current = 'workspace-prune-events'
    renderHarness(harness)
    await screen.findAllByText('ws-alpha-1')
    await waitFor(() => {
      expect(screen.getAllByText('实时已连接').length).toBeGreaterThan(0)
    }, { timeout: 8000 })

    harness.drops.failNext = 1
    harness.drops.abortActive()
    await serviceJson(harness, '/v1/workspaces/ws-alpha-1:stop', 'demo-token', {
      method: 'POST',
      headers: { 'idempotency-key': 'raw-stop-1' },
      body: JSON.stringify({ expected_workspace_revision: 7 }),
    })
    await serviceJson(harness, '/v1/workspaces/ws-alpha-1:start', 'demo-token', {
      method: 'POST',
      headers: { 'idempotency-key': 'raw-start-1' },
      body: JSON.stringify({}),
    })

    await waitFor(() => {
      expect(screen.getAllByText('事件重同步中').length).toBeGreaterThan(0)
    }, { timeout: 8000 })
    await waitFor(() => {
      expect(screen.getAllByText('实时已连接').length).toBeGreaterThan(0)
    }, { timeout: 8000 })
    // The post-resync snapshot read surfaces the revisions that were pruned.
    await waitFor(() => {
      expect(screen.getAllByText(/main · ready · rev 10/u).length).toBeGreaterThan(0)
    }, { timeout: 8000 })
  })

  fixtureIt('never moves the UI backwards on a duplicated historical replay', async () => {
    const harness = await bootHarness()
    renderHarness(harness)
    await screen.findAllByText('ws-alpha-1')
    await waitFor(() => {
      expect(screen.getAllByText('实时已连接').length).toBeGreaterThan(0)
    }, { timeout: 8000 })

    fireEvent.click(await screen.findByRole('button', { name: /停止 Workspace/u }))
    await waitForStatus('已停止')

    // Switching away and back reconnects with an empty watermark, so the
    // service replays the whole history - older revisions included.
    fireEvent.click(await screen.findByRole('button', { name: /ws-alpha-3/u }))
    // Switching workspaces re-reads the detail, so the failure notice appears in
    // both the list row and the session facts.
    await screen.findAllByText(/初始化失败：磁盘配额不足/u)
    fireEvent.click(await screen.findByRole('button', { name: /ws-alpha-1/u }))
    await waitForStatus('已停止')
    await waitFor(() => {
      expect(screen.getAllByText(/rev 8/u).length).toBeGreaterThan(0)
    }, { timeout: 8000 })
    expect(screen.queryByText(/main · ready · rev 7/u)).toBeNull()
  })
})

describe('CloudWorkspacesView 生命周期与变更操作（真实 HTTP fixture）', () => {
  afterEach(() => {
    cleanup()
    window.localStorage.clear()
  })

  fixtureIt('labels service-declared fixture provenance instead of production success', async () => {
    const harness = await bootHarness()
    renderHarness(harness)
    await screen.findAllByText('ws-alpha-1')
    await waitForStatus(/main · ready · rev 7/u)

    // The service declares x-fixture-only on its responses; the view must show
    // that provenance rather than presenting the data as production.
    expect((await screen.findAllByText('fixture-only')).length).toBeGreaterThan(0)

    fireEvent.click(await screen.findByRole('button', { name: /停止 Workspace/u }))
    await waitForStatus('已停止')
    const alert = await screen.findByRole('alert')
    expect(alert.getAttribute('data-tone')).toBe('fixture')
    expect(alert.textContent).toContain('fixture-only')
  })

  fixtureIt('stops a ready workspace with the server revision and an idempotency key, then audits it', async () => {
    const harness = await bootHarness()
    renderHarness(harness)
    await screen.findAllByText('ws-alpha-1')
    await waitForStatus(/main · ready · rev 7/u)

    fireEvent.click(await screen.findByRole('button', { name: /停止 Workspace/u }))
    await waitForStatus('已停止')

    const request = lastRequest(harness, '/v1/workspaces/ws-alpha-1:stop')
    expect(request?.method).toBe('POST')
    expect(request?.body).toEqual({ expected_workspace_revision: 7 })
    expect(request?.headers['idempotency-key']).toBeTruthy()
    expect(await serviceJson(harness, '/v1/workspaces/ws-alpha-1', 'demo-token')).toMatchObject({ status: 'stopped', revision: 8 })

    const recorded = await audits(harness, 'workspace_id=ws-alpha-1&action=workspace.stop')
    expect(recorded[0]).toMatchObject({ action: 'workspace.stop', result: 'succeeded', revision: 8 })
  })

  fixtureIt('rejects a stale stop with REVISION_CONFLICT without overwriting server state', async () => {
    const harness = await bootHarness()
    harness.hooks.mutateBody = (path, body) => (path.endsWith(':stop') ? { ...body, expected_workspace_revision: 6 } : body)
    renderHarness(harness)
    await screen.findAllByText('ws-alpha-1')
    await waitForStatus(/main · ready · rev 7/u)

    fireEvent.click(await screen.findByRole('button', { name: /停止 Workspace/u }))
    const alert = await screen.findByRole('alert')
    await waitFor(() => {
      expect(alert.textContent).toContain('REVISION_CONFLICT')
    }, { timeout: 8000 })

    // The component asked with the snapshot revision; the service rejected it.
    expect(lastRequest(harness, '/v1/workspaces/ws-alpha-1:stop')?.body).toEqual({ expected_workspace_revision: 7 })
    expect(await serviceJson(harness, '/v1/workspaces/ws-alpha-1', 'demo-token')).toMatchObject({ status: 'ready', revision: 7 })
  })

  fixtureIt('starts a stopped workspace and lets the fixture reach ready', async () => {
    const harness = await bootHarness()
    renderHarness(harness)
    await screen.findAllByText('ws-alpha-1')
    await waitForStatus(/main · ready · rev 7/u)

    fireEvent.click(await screen.findByRole('button', { name: /停止 Workspace/u }))
    await waitForStatus('已停止')
    // 生命周期按钮的 disabled 由 selected 派生，可能比状态文本晚一次提交收敛：
    // 等按钮到达不动点（对 stopped 必为启用）后再点击，避免点击落在禁用节点上。
    await waitFor(() => {
      expect(screen.getByRole<HTMLButtonElement>('button', { name: /启动 Workspace/u }).disabled).toBe(false)
    })
    fireEvent.click(screen.getByRole('button', { name: /启动 Workspace/u }))
    // 确定性断言：start 请求已发出（不采样 starting 瞬态——夹具 200ms 过渡可能已跳过）
    await waitFor(() => {
      expect(lastRequest(harness, '/v1/workspaces/ws-alpha-1:start')?.body).toEqual({ expected_workspace_revision: 8 })
    })

    // 夹具在读驱动下推进 starting→ready（200ms 后下一次读取即返回 ready）
    await waitForStatus('ready')
    const recorded = await audits(harness, 'workspace_id=ws-alpha-1&action=workspace.start')
    expect(recorded[0]?.result).toBe('succeeded')
  })

  fixtureIt('rejects a start the state machine forbids', async () => {
    const harness = await bootHarness()
    forceStaleStatus(harness, 'ws-alpha-1', 'stopped')
    renderHarness(harness)
    await screen.findAllByText('ws-alpha-1')
    await waitForStatus(/main · 已停止 · rev 7/u)

    fireEvent.click(await screen.findByRole('button', { name: /启动 Workspace/u }))
    const alert = await screen.findByRole('alert')
    await waitFor(() => {
      expect(alert.textContent).toContain('INVALID_STATUS')
    }, { timeout: 8000 })
    expect(await serviceJson(harness, '/v1/workspaces/ws-alpha-1', 'demo-token')).toMatchObject({ status: 'ready', revision: 7 })
  })

  fixtureIt('retries a failed workspace through the service snapshot', async () => {
    const harness = await bootHarness()
    renderHarness(harness)
    await screen.findAllByText('ws-alpha-3')
    fireEvent.click(await screen.findByRole('button', { name: /ws-alpha-3/u }))
    await waitForStatus(/初始化失败：磁盘配额不足/u)

    fireEvent.click(await screen.findByRole('button', { name: /重试 Workspace/u }))
    await waitFor(() => {
      expect(lastRequest(harness, '/v1/workspaces/ws-alpha-3:retry')).toBeTruthy()
    }, { timeout: 8000 })
    await waitForStatus(/feature\/fix · (初始化中|启动中|ready)/u)

    const request = lastRequest(harness, '/v1/workspaces/ws-alpha-3:retry')
    expect(request?.method).toBe('POST')
    expect(request?.headers['idempotency-key']).toBeTruthy()
    const recorded = await audits(harness, 'workspace_id=ws-alpha-3&action=workspace.retry')
    expect(recorded[0]?.result).toBe('succeeded')
  })

  fixtureIt('rejects a retry the state machine forbids', async () => {
    const harness = await bootHarness()
    forceStaleStatus(harness, 'ws-alpha-1', 'failed')
    renderHarness(harness)
    await screen.findAllByText('ws-alpha-1')
    await waitForStatus(/main · 失败 · rev 7/u)

    fireEvent.click(await screen.findByRole('button', { name: /重试 Workspace/u }))
    const alert = await screen.findByRole('alert')
    await waitFor(() => {
      expect(alert.textContent).toContain('INVALID_STATUS')
    }, { timeout: 8000 })
    expect(await serviceJson(harness, '/v1/workspaces/ws-alpha-1', 'demo-token')).toMatchObject({ status: 'ready', revision: 7 })
  })

  fixtureIt('archives only after confirmation and updates from the service snapshot', async () => {
    const harness = await bootHarness()
    renderHarness(harness)
    await screen.findAllByText('ws-alpha-1')
    await waitForStatus(/main · ready · rev 7/u)

    fireEvent.click(await screen.findByRole('button', { name: /归档 Workspace/u }))
    expect(await screen.findByRole('button', { name: '确认归档' })).toBeTruthy()
    expect(lastRequest(harness, ':archive')).toBeUndefined()

    fireEvent.click(screen.getByRole('button', { name: '确认归档' }))
    await waitForStatus('已归档')
    expect(lastRequest(harness, ':archive')?.body).toEqual({ expected_workspace_revision: 7 })
    const recorded = await audits(harness, 'workspace_id=ws-alpha-1&action=workspace.archive')
    expect(recorded[0]).toMatchObject({ action: 'workspace.archive', result: 'succeeded' })
  })

  fixtureIt('rejects a stale archive with REVISION_CONFLICT', async () => {
    const harness = await bootHarness()
    harness.hooks.mutateBody = (path, body) => (path.endsWith(':archive') ? { ...body, expected_workspace_revision: 4 } : body)
    renderHarness(harness)
    await screen.findAllByText('ws-alpha-1')
    await waitForStatus(/main · ready · rev 7/u)

    fireEvent.click(await screen.findByRole('button', { name: /归档 Workspace/u }))
    fireEvent.click(await screen.findByRole('button', { name: '确认归档' }))
    const alert = await screen.findByRole('alert')
    await waitFor(() => {
      expect(alert.textContent).toContain('REVISION_CONFLICT')
    }, { timeout: 8000 })
    expect(await serviceJson(harness, '/v1/workspaces/ws-alpha-1', 'demo-token')).toMatchObject({ status: 'ready', revision: 7 })
  })

  fixtureIt('deletes an archived workspace only after confirmation', async () => {
    const harness = await bootHarness()
    renderHarness(harness)
    await screen.findAllByText('ws-alpha-1')
    await waitForStatus(/main · ready · rev 7/u)

    fireEvent.click(await screen.findByRole('button', { name: /归档 Workspace/u }))
    fireEvent.click(await screen.findByRole('button', { name: '确认归档' }))
    await waitForStatus('已归档')

    // 与 C-1 同理：删除按钮对 archived 才启用，等它真实启用后再点击。
    await waitFor(() => {
      expect(screen.getByRole<HTMLButtonElement>('button', { name: /删除 Workspace/u }).disabled).toBe(false)
    })
    fireEvent.click(screen.getByRole('button', { name: /删除 Workspace/u }))
    expect(await screen.findByRole('button', { name: '确认删除' })).toBeTruthy()
    expect(lastRequest(harness, '/v1/workspaces/ws-alpha-1')?.method).not.toBe('DELETE')

    fireEvent.click(screen.getByRole('button', { name: '确认删除' }))
    await waitFor(() => {
      expect(lastRequest(harness, '/v1/workspaces/ws-alpha-1')?.method).toBe('DELETE')
    }, { timeout: 8000 })
    expect(lastRequest(harness, '/v1/workspaces/ws-alpha-1')?.body).toEqual({ expected_workspace_revision: 8 })
    const recorded = await audits(harness, 'workspace_id=ws-alpha-1&action=workspace.delete')
    expect(recorded[0]?.result).toBe('succeeded')
  })

  fixtureIt('rejects a delete the state machine forbids', async () => {
    const harness = await bootHarness()
    forceStaleStatus(harness, 'ws-alpha-1', 'stopped')
    renderHarness(harness)
    await screen.findAllByText('ws-alpha-1')
    await waitForStatus(/main · 已停止 · rev 7/u)

    fireEvent.click(await screen.findByRole('button', { name: /删除 Workspace/u }))
    fireEvent.click(await screen.findByRole('button', { name: '确认删除' }))
    const alert = await screen.findByRole('alert')
    await waitFor(() => {
      expect(alert.textContent).toContain('INVALID_STATUS')
    }, { timeout: 8000 })
    expect(await serviceJson(harness, '/v1/workspaces/ws-alpha-1', 'demo-token')).toMatchObject({ status: 'ready', revision: 7 })
  })

  fixtureIt('discards changes behind a confirmation and adopts the returned revision', async () => {
    const harness = await bootHarness()
    renderHarness(harness)
    await screen.findAllByText('ws-alpha-1')
    fireEvent.click(await screen.findByRole('tab', { name: /Changes/u }))
    await screen.findByText(/基线 5/u)

    fireEvent.click(await screen.findByRole('button', { name: /丢弃变更/u }))
    expect(await screen.findByRole('button', { name: '确认丢弃' })).toBeTruthy()
    expect(lastRequest(harness, 'changes:discard')).toBeUndefined()

    fireEvent.click(screen.getByRole('button', { name: '确认丢弃' }))
    await waitFor(() => {
      expect(lastRequest(harness, 'changes:discard')?.body).toEqual({ expected_workspace_revision: 7 })
    }, { timeout: 8000 })
    await waitFor(() => {
      expect(screen.getAllByText(/rev 8/u).length).toBeGreaterThan(0)
    }, { timeout: 8000 })
    const recorded = await audits(harness, 'workspace_id=ws-alpha-1&action=changes.discard')
    expect(recorded.map(item => item.result)).toContain('succeeded')
  })

  fixtureIt('rejects a stale discard with REVISION_CONFLICT', async () => {
    const harness = await bootHarness()
    harness.hooks.mutateBody = (path, body) => (path.includes('changes:discard') ? { ...body, expected_workspace_revision: 2 } : body)
    renderHarness(harness)
    await screen.findAllByText('ws-alpha-1')
    fireEvent.click(await screen.findByRole('tab', { name: /Changes/u }))
    await screen.findByText(/基线 5/u)

    fireEvent.click(await screen.findByRole('button', { name: /丢弃变更/u }))
    fireEvent.click(await screen.findByRole('button', { name: '确认丢弃' }))
    const alert = await screen.findByRole('alert')
    await waitFor(() => {
      expect(alert.textContent).toContain('REVISION_CONFLICT')
    }, { timeout: 8000 })
    expect(lastRequest(harness, 'changes:discard')?.body).toEqual({ expected_workspace_revision: 7 })
    expect(await serviceJson(harness, '/v1/workspaces/ws-alpha-1/changes', 'demo-token')).toMatchObject({ revision: 7 })
  })

  fixtureIt('commits the change set with a message at the server revision', async () => {
    const harness = await bootHarness()
    renderHarness(harness)
    await screen.findAllByText('ws-alpha-1')
    fireEvent.click(await screen.findByRole('tab', { name: /Changes/u }))
    await screen.findByText(/基线 5/u)

    fireEvent.change(screen.getByLabelText('提交信息'), { target: { value: '整理目录' } })
    fireEvent.click(screen.getByRole('button', { name: /提交变更/u }))
    await waitFor(() => {
      expect(lastRequest(harness, 'git/commit')?.body).toEqual({ message: '整理目录', expected_workspace_revision: 7 })
    }, { timeout: 8000 })
    await waitFor(() => {
      expect(screen.getAllByText(/rev 8/u).length).toBeGreaterThan(0)
    }, { timeout: 8000 })
    const recorded = await audits(harness, 'workspace_id=ws-alpha-1&action=git.commit')
    expect(recorded[0]?.result).toBe('succeeded')
  })

  fixtureIt('rejects a stale commit with REVISION_CONFLICT', async () => {
    const harness = await bootHarness()
    harness.hooks.mutateBody = (path, body) => (path.includes('git/commit') ? { ...body, expected_workspace_revision: 1 } : body)
    renderHarness(harness)
    await screen.findAllByText('ws-alpha-1')
    fireEvent.click(await screen.findByRole('tab', { name: /Changes/u }))
    await screen.findByText(/基线 5/u)

    fireEvent.change(screen.getByLabelText('提交信息'), { target: { value: '陈旧提交' } })
    fireEvent.click(screen.getByRole('button', { name: /提交变更/u }))
    const alert = await screen.findByRole('alert')
    await waitFor(() => {
      expect(alert.textContent).toContain('REVISION_CONFLICT')
    }, { timeout: 8000 })
    expect(lastRequest(harness, 'git/commit')?.body).toEqual({ message: '陈旧提交', expected_workspace_revision: 7 })
  })

  fixtureIt('creates a pull request from the change set and reports the server id', async () => {
    const harness = await bootHarness()
    renderHarness(harness)
    await screen.findAllByText('ws-alpha-1')
    fireEvent.click(await screen.findByRole('tab', { name: /Changes/u }))
    await screen.findByText(/基线 5/u)

    fireEvent.change(screen.getByLabelText('Pull Request 标题'), { target: { value: '同步目录整理' } })
    fireEvent.click(screen.getByRole('button', { name: /创建 Pull Request/u }))
    await waitFor(() => {
      expect(lastRequest(harness, 'git/pull-request')?.body).toEqual({ title: '同步目录整理', expected_workspace_revision: 7 })
    }, { timeout: 8000 })
    await waitFor(() => {
      expect(screen.getAllByText(/pr-[0-9a-f]{8}/u).length).toBeGreaterThan(0)
    }, { timeout: 8000 })
    const recorded = await audits(harness, 'workspace_id=ws-alpha-1&action=git.pull_request')
    expect(recorded[0]?.result).toBe('succeeded')
  })

  fixtureIt('rejects a stale pull request with REVISION_CONFLICT', async () => {
    const harness = await bootHarness()
    harness.hooks.mutateBody = (path, body) => (path.includes('git/pull-request') ? { ...body, expected_workspace_revision: 3 } : body)
    renderHarness(harness)
    await screen.findAllByText('ws-alpha-1')
    fireEvent.click(await screen.findByRole('tab', { name: /Changes/u }))
    await screen.findByText(/基线 5/u)

    fireEvent.change(screen.getByLabelText('Pull Request 标题'), { target: { value: '陈旧 PR' } })
    fireEvent.click(screen.getByRole('button', { name: /创建 Pull Request/u }))
    const alert = await screen.findByRole('alert')
    await waitFor(() => {
      expect(alert.textContent).toContain('REVISION_CONFLICT')
    }, { timeout: 8000 })
    expect(lastRequest(harness, 'git/pull-request')?.body).toEqual({ title: '陈旧 PR', expected_workspace_revision: 7 })
  })

  fixtureIt('reports WORKSPACE_BUSY from the service when a write run already holds the lease', async () => {
    const harness = await bootHarness()
    renderHarness(harness)
    await screen.findAllByText('ws-alpha-1')
    await waitForStatus('ready')
    fireEvent.click(await screen.findByRole('tab', { name: /Run/u }))

    fireEvent.click(await screen.findByRole('button', { name: /开始 Run（写入）/u }))
    await waitFor(() => {
      expect(lastRequest(harness, '/runs')).toBeTruthy()
    }, { timeout: 8000 })

    fireEvent.click(await screen.findByRole('button', { name: /开始 Run（写入）/u }))
    const alert = await screen.findByRole('alert')
    await waitFor(() => {
      expect(alert.textContent).toContain('WORKSPACE_BUSY')
    }, { timeout: 8000 })
    expect(alert.getAttribute('data-tone')).toBe('busy')
  })

  fixtureIt('reports permission denial when the service rejects the account token', async () => {
    const harness = await bootHarness()
    harness.scenario.current = 'workspace-expired-token'
    renderHarness(harness)
    const alert = await screen.findByRole('alert')
    await waitFor(() => {
      expect(alert.textContent).toContain('SIGNED_OUT')
    }, { timeout: 8000 })
    expect(await screen.findByRole('button', { name: '登录' })).toBeTruthy()
  })

  fixtureIt('reports a downstream failure with its own channel', async () => {
    const harness = await bootHarness()
    renderHarness(harness)
    await screen.findAllByText('ws-alpha-1')
    await waitForStatus(/main · ready · rev 7/u)

    harness.scenario.current = 'workspace-downstream-failure'
    fireEvent.click(await screen.findByRole('button', { name: /停止 Workspace/u }))
    const alert = await screen.findByRole('alert')
    await waitFor(() => {
      expect(alert.textContent).toContain('SERVICE_UNAVAILABLE')
    }, { timeout: 8000 })
    harness.scenario.current = undefined
  })

  fixtureIt('marks an archived workspace read-only with an explicit notice', async () => {
    const harness = await bootHarness()
    renderHarness(harness)
    await screen.findAllByText('ws-alpha-1')
    await waitForStatus(/main · ready · rev 7/u)

    fireEvent.click(await screen.findByRole('button', { name: /归档 Workspace/u }))
    fireEvent.click(await screen.findByRole('button', { name: '确认归档' }))
    await waitForStatus('已归档')

    expect(await screen.findByText(/已归档，不再接受写入或生命周期操作/u)).toBeTruthy()
    // 与 C-1 同理：归档按钮对 archived 必为禁用，等它到达禁用不动点后再断言。
    await waitFor(() => {
      expect(screen.getByRole<HTMLButtonElement>('button', { name: /归档 Workspace/u }).disabled).toBe(true)
    })
    fireEvent.click(screen.getByRole('tab', { name: /Changes/u }))
    expect(screen.getByRole<HTMLButtonElement>('button', { name: /丢弃变更/u }).disabled).toBe(true)
  })
})


describe('UX-06/07 创建向导与预览过期', () => {
  afterEach(() => {
    cleanup()
    window.localStorage.clear()
  })

  it('keeps exactly one wizard step open with visible step titles and a confirm page', async () => {
    const { remote } = fakeRemote()
    render(<CloudWorkspacesView remote={remote} useWorkspaces={useWorkspacesStub} projectId="project-alpha" projects={projects} sessionId="sess-1" />)
    await screen.findAllByText('ws-alpha-1')
    await screen.findByLabelText('创建代码源')
    const steps = screen.getByRole('list', { name: '创建向导步骤' })
    expect(steps).toBeTruthy()
    expect(screen.queryByLabelText('创建分支')).toBeNull()
    expect(screen.queryByRole('button', { name: /创建 Workspace/u })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '下一步：选择分支' }))
    expect(screen.getByLabelText('创建分支')).toBeTruthy()
    expect(screen.queryByLabelText('创建代码源')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '下一步：选择 Agent 配置' }))
    expect(screen.getByLabelText('创建 Agent 配置')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '下一步：确认创建' }))
    expect(screen.getByText('project-alpha')).toBeTruthy()
    expect(screen.getByText('main')).toBeTruthy()
    expect(screen.getAllByText(/apv-1/).length).toBeGreaterThan(0)
  })

  it('shows 重新获取预览 after the short-lived Web App URL expires', async () => {
    const { remote } = fakeRemote({
      workspacePreviewUrl: vi.fn().mockResolvedValue(ready({ url: 'https://workspace-app.fixture.internal/ws-alpha-1/p/abc', expiresAt: '2000-01-01T00:00:00Z', workspaceId: 'ws-alpha-1' })),
    })
    render(<CloudWorkspacesView remote={remote} useWorkspaces={useWorkspacesStub} projectId="project-alpha" projects={projects} sessionId="sess-1" />)
    await screen.findAllByText('ws-alpha-1')
    fireEvent.click(await screen.findByRole('button', { name: '打开 Web App（签发短期 URL）' }))
    const reissue = await screen.findByRole('button', { name: '重新获取预览' })
    fireEvent.click(reissue)
    expect(await screen.findByRole('button', { name: '重新获取预览' })).toBeTruthy()
    expect(await screen.findByText(/受限预览|重新获取/u)).toBeTruthy()
  })
})



describe('UX-06 向导状态复位（二次核对）', () => {
  afterEach(() => {
    cleanup()
    window.localStorage.clear()
  })

  function renderWorkbench(projectId: string, remote = fakeRemote().remote): ReturnType<typeof render> {
    return render(<CloudWorkspacesView remote={remote} useWorkspaces={useWorkspacesStub} projectId={projectId} projects={projects} sessionId="sess-1" />)
  }

  async function walkToStep4(): Promise<void> {
    await screen.findAllByText('ws-alpha-1')
    await screen.findByLabelText('创建代码源')
    fireEvent.click(screen.getByRole('button', { name: '下一步：选择分支' }))
    fireEvent.click(screen.getByRole('button', { name: '下一步：选择 Agent 配置' }))
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '下一步：确认创建' })).toHaveProperty('disabled', false)
    })
    fireEvent.click(screen.getByRole('button', { name: '下一步：确认创建' }))
    await screen.findByText('project-alpha')
  }

  it('D1: resets the wizard to step 1 when the project context changes', async () => {
    const { remote } = fakeRemote()
    const view = renderWorkbench('project-alpha', remote)
    await walkToStep4()
    view.rerender(<CloudWorkspacesView remote={remote} useWorkspaces={useWorkspacesStub} projectId="project-beta" projects={projects} sessionId="sess-1" />)
    await screen.findAllByText('ws-alpha-1')
    // 重置后回到第 1 步：代码源选择可见，确认页汇总不再出现
    expect(screen.getByLabelText('创建代码源')).toBeTruthy()
    expect(screen.queryByText(/数据来源/u)).toBeNull()
  })

  it('D2: returns the wizard to step 1 after a successful create', { timeout: 20_000 }, async () => {
    const { remote, calls } = fakeRemote()
    renderWorkbench('project-alpha', remote)
    await screen.findAllByText('ws-alpha-1')
    await screen.findByLabelText('创建代码源')
    fireEvent.click(screen.getByRole('button', { name: '下一步：选择分支' }))
    fireEvent.change(screen.getByLabelText('创建分支'), { target: { value: 'feature/new' } })
    fireEvent.click(screen.getByRole('button', { name: '下一步：选择 Agent 配置' }))
    await screen.findByLabelText('创建 Agent 配置', undefined, { timeout: 5000 })
    console.log('D2_PROBE step3reached=', document.querySelector('[aria-current]')?.textContent, '确认创建数=', screen.queryAllByRole('button', { name: '下一步：确认创建' }).length)
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '下一步：确认创建' })).toHaveProperty('disabled', false)
    }, { timeout: 5000 })
    fireEvent.click(screen.getByRole('button', { name: '下一步：确认创建' }))
    fireEvent.click(screen.getByRole('button', { name: /创建 Workspace/u }))
    await waitFor(() => {
      expect(calls.createWorkspace).toHaveBeenCalled()
    })
    // 创建成功自动选中新 Workspace，且向导回到第 1 步等待下一次创建
    await screen.findByText('ws-new')
    expect(screen.getByLabelText('创建代码源')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /创建 Workspace/u })).toBeNull()
  })
})
