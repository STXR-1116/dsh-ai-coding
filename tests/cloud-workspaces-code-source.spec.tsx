// @vitest-environment jsdom
/**
 * R2-02 (input half): creating a cloud workspace must offer exactly the code
 * sources the service authorizes — a repository id is never hardcoded, a branch
 * always belongs to its repository, and a project with no authorized repository
 * says so instead of submitting a placeholder.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { CloudWorkspacesView } from '../src/client/cloud-workspaces/CloudWorkspacesView'
import type { ClientRemote, TeamSkillProject } from '@deepseek-ai/dsh-api-remotes/client'

const projects: readonly TeamSkillProject[] = [
  {
    projectId: 'project-a',
    organizationId: 'org',
    organizationName: 'org',
    name: 'A',
    description: '',
    status: 'active',
    createdBy: 'u',
    createdAt: '2026-09-01T00:00:00Z',
    updatedAt: '2026-09-01T00:00:00Z',
    memberCount: 1,
    assetCount: 0,
    revision: 1,
  },
]

const ready = <T,>(value: T): { status: 'ready'; value: T; fixtureOnly: boolean } => ({ status: 'ready', value, fixtureOnly: false })

const workspaceA = {
  workspaceId: 'ws-a1',
  projectId: 'project-a',
  ownerUserId: 'member-1',
  repositoryId: 'repo-1',
  branch: 'main',
  displayName: 'ws-a1',
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
  name: '默认代理',
  agentTypeId: 'at-1',
  model: 'm',
  reasoning: 'r',
  assetBindings: [],
  executionPolicy: {},
  default: true,
  status: 'published',
}

const sourceA = { repositoryId: 'repo-1', name: 'harness-web', provider: 'gitlab', defaultBranch: 'main', branches: ['main', 'release'] }
const sourceB = { repositoryId: 'repo-2', name: 'data-service', provider: 'github', defaultBranch: 'trunk', branches: ['trunk'] }

type CreateCall = Record<string, unknown>

interface FakeRemote {
  readonly remote: ClientRemote
  readonly calls: CreateCall[]
}

function fakeRemote(codeSources: readonly unknown[], onCreate: (input: CreateCall) => Promise<unknown>): FakeRemote {
  const calls: CreateCall[] = []
  const wrap = (run: Promise<unknown>): Promise<{ ok: true; value: unknown }> => run.then(value => ({ ok: true, value }))
  const remote = {
    cloudWorkspaces: {
      workspaces: () => wrap(Promise.resolve(ready([workspaceA]))),
      workspace: () => wrap(Promise.resolve(ready(workspaceA))),
      workspaceFiles: () => wrap(Promise.resolve(ready({ path: '', revision: 7, items: [] }))),
      workspaceChanges: () => wrap(Promise.resolve(ready({ workspaceId: 'ws-a1', baselineRevision: 0, revision: 7, files: [] }))),
      workspaceRuns: () => wrap(Promise.resolve(ready([]))),
      workspacePlans: () => wrap(Promise.resolve(ready([]))),
      agentProfiles: () => wrap(Promise.resolve(ready([profile]))),
      codeSources: () => wrap(Promise.resolve(ready(codeSources))),
      workspacePreview: () => wrap(Promise.resolve(ready({ path: 'a', revision: 1, etag: 'e', kind: 'text', contentType: 'text/plain', content: '' }))),
      workspacePreviewUrl: () => wrap(Promise.resolve({ status: 'failed', code: 'PREVIEW_DENIED', message: 'no' })),
      workspaceFileContent: () => wrap(Promise.resolve(ready({}))),
      createWorkspace: (input: CreateCall) => {
        calls.push(input)
        return wrap(onCreate(input))
      },
      createRun: () => wrap(Promise.resolve({ status: 'failed', code: 'NOPE', message: 'no' })),
      cancelRun: () => wrap(Promise.resolve({ status: 'failed', code: 'NOPE', message: 'no' })),
      run: () => wrap(Promise.resolve({ status: 'failed', code: 'NOPE', message: 'no' })),
      workspaceAction: () => wrap(Promise.resolve(ready(workspaceA))),
      deleteWorkspace: () => wrap(Promise.resolve(ready(workspaceA))),
      discardChanges: () => wrap(Promise.resolve(ready({ revision: 1 }))),
      gitCommit: () => wrap(Promise.resolve(ready({ revision: 1 }))),
      createPullRequest: () => wrap(Promise.resolve(ready({ pullRequestId: 'pr' }))),
      streamState: () => Promise.resolve({ ok: true as const, value: { status: 'idle' } }),
      startStream: () => Promise.resolve({ ok: true as const, value: { subscriptionId: 'sub', state: { status: 'idle' } } }),
      stopStream: () => Promise.resolve({ ok: true as const, value: { status: 'idle' } }),
      streamEventsAfter: () => Promise.resolve({ ok: true as const, value: { events: [], truncated: false } }),
    },
  } as unknown as ClientRemote
  return { remote, calls }
}

const useWorkspacesStub = ((selector: (state: { items: unknown[] }) => unknown) => selector({ items: [] })) as never

function renderView(remote: ClientRemote): ReturnType<typeof render> {
  return render(
    <CloudWorkspacesView remote={remote} useWorkspaces={useWorkspacesStub} projectId="project-a" projects={projects} sessionId="sess-1" />,
  )
}

afterEach(() => {
  cleanup()
  window.localStorage.clear()
  vi.restoreAllMocks()
})

describe('R2-02 code source selection', () => {
  it('offers exactly the repositories the service authorized', async () => {
    const { remote } = fakeRemote([sourceA, sourceB], () => Promise.resolve(ready(workspaceA)))
    renderView(remote)
    await screen.findAllByText('ws-a1')
    const select = await screen.findByLabelText('创建代码源') as HTMLSelectElement
    await waitFor(() => {
      expect([...select.options].map(option => option.value)).toEqual(['repo-1', 'repo-2'])
    })
    expect(select.value).toBe('repo-1')
  })

  it('submits the selected repository with a branch that repository publishes', async () => {
    const { remote, calls } = fakeRemote([sourceA, sourceB], () => Promise.resolve(ready({ ...workspaceA, workspaceId: 'ws-new' })))
    renderView(remote)
    await screen.findAllByText('ws-a1')
    fireEvent.change(await screen.findByLabelText('创建代码源'), { target: { value: 'repo-2' } })
    // The branch list belongs to the repository, so it follows the selection.
    fireEvent.click(screen.getByRole('button', { name: '下一步：选择分支' }))
    await waitFor(() => {
      const branch = screen.getByLabelText('创建分支') as HTMLSelectElement
      expect(branch.value).toBe('trunk')
    })
    fireEvent.click(screen.getByRole('button', { name: '下一步：选择 Agent 配置' }))
    fireEvent.click(screen.getByRole('button', { name: '下一步：确认创建' }))
    fireEvent.click(screen.getByRole('button', { name: /创建 Workspace/u }))
    await waitFor(() => {
      expect(calls).toHaveLength(1)
    })
    expect(calls[0]).toMatchObject({ projectId: 'project-a', repositoryId: 'repo-2', branch: 'trunk', agentProfileVersionId: 'apv-1' })
  })

  it('states that a project has no code source instead of inventing one', async () => {
    const { remote, calls } = fakeRemote([], () => Promise.resolve(ready(workspaceA)))
    renderView(remote)
    await screen.findAllByText('ws-a1')
    expect(await screen.findByText(/没有可用的代码源/u)).toBeTruthy()
    // With no code source the wizard never reaches a creatable state, and the
    // wizard's only visible step offers no create entry at all.
    expect(screen.queryByRole('button', { name: /创建 Workspace/u })).toBeNull()
    expect(calls).toHaveLength(0)
  })
})
