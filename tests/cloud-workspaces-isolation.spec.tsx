// @vitest-environment jsdom
/**
 * R2-03:  account, project, workspace and file context must be isolated —
 * a late response for the context that was left must never land in the one that
 * replaced it, and a failed read must show as a failure rather than as empty data.
 *
 * Every assertion describes REQUIRED behaviour.
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
  {
    projectId: 'project-b',
    organizationId: 'org',
    organizationName: 'org',
    name: 'B',
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
const failure = (code: string, message: string): { status: 'failed'; code: string; message: string } => ({ status: 'failed', code, message })

function snapshot(workspaceId: string, projectId: string, branch: string, revision: number): Record<string, unknown> {
  return {
    workspaceId,
    projectId,
    ownerUserId: 'member-1',
    repositoryId: 'repo-1',
    branch,
    displayName: workspaceId,
    defaultAgentProfileVersionId: 'apv-1',
    status: 'ready',
    revision,
    lastError: null,
    createdAt: '2026-09-01T00:00:00Z',
    updatedAt: '2026-09-09T00:00:00Z',
  }
}

const profile = {
  agentProfileId: 'ap-1',
  agentProfileVersionId: 'apv-1',
  name: 'p',
  agentTypeId: 'at-1',
  model: 'm',
  reasoning: 'r',
  assetBindings: [],
  executionPolicy: {},
  default: true,
  status: 'published',
}

const codeSources = [{ repositoryId: 'repo-1', name: 'web', provider: 'gitlab', defaultBranch: 'main', branches: ['main'] }]

/** One deferred promise the test settles by hand, to model a late response. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolveFn: (value: T) => void = () => {}
  const promise = new Promise<T>((resolve) => { resolveFn = resolve })
  return { promise, resolve: resolveFn }
}

interface Overrides {
  workspaces?: ((projectId: string) => Promise<unknown>) | undefined
  workspaceFiles?: ((workspaceId: string, path: string) => Promise<unknown>) | undefined
  workspace?: ((workspaceId: string) => Promise<unknown>) | undefined
  agentProfiles?: (() => Promise<unknown>) | undefined
  workspaceRuns?: (() => Promise<unknown>) | undefined
  workspacePreview?: ((workspaceId: string, path: string) => Promise<unknown>) | undefined
  workspaceChanges?: (() => Promise<unknown>) | undefined
}

function fakeRemote(overrides: Overrides = {}): ClientRemote {
  const wrap = (run: Promise<unknown>): Promise<{ ok: true; value: unknown }> => run.then(value => ({ ok: true, value }))
  const call = (name: keyof Overrides, ...args: string[]): Promise<unknown> => {
    const override = overrides[name]
    if (override === undefined) {
      return (defaults[name])(...args)
    }
    return override(...(args as [string, string]))
  }
  const defaults: Record<keyof Overrides, (...args: string[]) => Promise<unknown>> = {
    workspaces: () => Promise.resolve(ready([snapshot('ws-a1', 'project-a', 'main', 7)])),
    workspace: () => Promise.resolve(ready(snapshot('ws-a1', 'project-a', 'main', 7))),
    workspaceFiles: () => Promise.resolve(ready({ path: '', revision: 7, items: [] })),
    agentProfiles: () => Promise.resolve(ready([profile])),
    workspaceRuns: () => Promise.resolve(ready([])),
    workspaceChanges: () => Promise.resolve(ready({ workspaceId: 'w', baselineRevision: 0, revision: 1, files: [] })),
    workspacePreview: () => Promise.resolve(ready({ path: 'a', revision: 1, etag: 'e', kind: 'text', contentType: 'text/plain', content: '' })),
  }
  return {
    cloudWorkspaces: {
      workspacePlans: vi.fn().mockResolvedValue({ ok: true as const, value: { status: 'ready' as const, value: [], fixtureOnly: true } }),
      plan: vi.fn(),
      createPlan: vi.fn(),
      updatePlan: vi.fn(),
      confirmPlan: vi.fn(),
      workspaces: (projectId: string) => wrap(call('workspaces', projectId)),
      workspace: (workspaceId: string) => wrap(call('workspace', workspaceId)),
      workspaceFiles: (workspaceId: string, path: string) => wrap(call('workspaceFiles', workspaceId, path)),
      workspaceChanges: () => wrap(call('workspaceChanges')),
      workspaceRuns: () => wrap(call('workspaceRuns')),
      agentProfiles: () => wrap(call('agentProfiles')),
      codeSources: () => wrap(Promise.resolve(ready(codeSources))),
      workspacePreview: (workspaceId: string, path: string) => wrap(call('workspacePreview', workspaceId, path)),
      workspacePreviewUrl: () => wrap(Promise.resolve(failure('PREVIEW_DENIED', 'no'))),
      workspaceFileContent: () => wrap(Promise.resolve(ready({}))),
      createWorkspace: () => wrap(Promise.resolve(ready(snapshot('ws-new', 'project-a', 'main', 1)))),
      createRun: () => wrap(Promise.resolve(failure('NOPE', 'no'))),
      cancelRun: () => wrap(Promise.resolve(failure('NOPE', 'no'))),
      run: () => wrap(Promise.resolve(failure('NOPE', 'no'))),
      workspaceAction: () => wrap(Promise.resolve(ready(snapshot('w', 'project-a', 'main', 1)))),
      deleteWorkspace: () => wrap(Promise.resolve(ready(snapshot('w', 'project-a', 'main', 1)))),
      discardChanges: () => wrap(Promise.resolve(ready({ revision: 1 }))),
      gitCommit: () => wrap(Promise.resolve(ready({ revision: 1 }))),
      createPullRequest: () => wrap(Promise.resolve(ready({ pullRequestId: 'pr' }))),
      streamState: () => Promise.resolve({ ok: true as const, value: { status: 'idle' } }),
      startStream: () => Promise.resolve({ ok: true as const, value: { subscriptionId: 'sub', state: { status: 'idle' } } }),
      stopStream: () => Promise.resolve({ ok: true as const, value: { status: 'idle' } }),
      streamEventsAfter: () => Promise.resolve({ ok: true as const, value: { events: [], truncated: false } }),
    },
  } as unknown as ClientRemote
}

const useWorkspacesStub = ((selector: (state: { items: unknown[] }) => unknown) => selector({ items: [] })) as never

function renderView(
  remote: ClientRemote,
  projectId = 'project-a',
  onAuthorizationFailure?: () => void,
): ReturnType<typeof render> {
  return render(
    <CloudWorkspacesView
      remote={remote}
      useWorkspaces={useWorkspacesStub}
      projectId={projectId}
      projects={projects}
      sessionId="sess-1"
      {...(onAuthorizationFailure === undefined ? {} : { onAuthorizationFailure })}
    />,
  )
}

afterEach(() => {
  cleanup()
  window.localStorage.clear()
  vi.restoreAllMocks()
})

describe('R2-03 context isolation', () => {
  it('drops a slow response that belongs to the workspace the user left', async () => {
    const slow = deferred<unknown>()
    const remote = fakeRemote({
      workspaces: () => Promise.resolve(ready([
        snapshot('ws-a1', 'project-a', 'main', 7),
        snapshot('ws-a2', 'project-a', 'release', 3),
      ])),
      workspace: (workspaceId: string) => (workspaceId === 'ws-a1'
        ? slow.promise
        : Promise.resolve(ready(snapshot('ws-a2', 'project-a', 'release', 3)))),
      workspaceFiles: () => Promise.resolve(ready({ path: '', revision: 3, items: [] })),
    })
    renderView(remote)
    await screen.findAllByText('ws-a1')
    // Select the second workspace while the first one's detail is still open.
    fireEvent.click(screen.getByRole('button', { name: /ws-a2/u }))
    await waitFor(() => {
      expect(screen.getAllByText(/release ·/u).length).toBeGreaterThan(0)
    })
    slow.resolve(ready(snapshot('ws-a1', 'project-a', 'main', 7)))
    await new Promise(resolve => setTimeout(resolve, 50))
    // The late answer for ws-a1 must not become the current session facts.
    await waitFor(() => {
      expect(screen.getAllByText(/release ·/u).length).toBeGreaterThan(0)
    })
  })

  it('cancels a workspace the new project list no longer authorizes', async () => {
    const remote = fakeRemote({
      workspaces: (projectId: string) => Promise.resolve(ready(projectId === 'project-a'
        ? [snapshot('ws-a1', 'project-a', 'main', 7)]
        : [snapshot('ws-b1', 'project-b', 'trunk', 2)])),
      workspace: (workspaceId: string) => Promise.resolve(ready(snapshot(workspaceId, workspaceId.startsWith('ws-b') ? 'project-b' : 'project-a', 'trunk', 2))),
      workspaceFiles: () => Promise.resolve(ready({ path: '', revision: 2, items: [] })),
    })
    const view = renderView(remote, 'project-a')
    await screen.findAllByText('ws-a1')
    view.rerender(
      <CloudWorkspacesView remote={remote} useWorkspaces={useWorkspacesStub} projectId="project-b" projects={projects} sessionId="sess-1" />,
    )
    await screen.findAllByText('ws-b1')
    // The old project's workspace is gone from the list and from the selection.
    await waitFor(() => {
      expect(screen.queryByText('ws-a1')).toBeNull()
    })
  })

  it('reports a rejected directory read instead of showing an empty tree', async () => {
    const remote = fakeRemote({
      workspaces: () => Promise.resolve(ready([snapshot('ws-a1', 'project-a', 'main', 7)])),
      workspace: () => Promise.resolve(ready(snapshot('ws-a1', 'project-a', 'main', 7))),
      workspaceFiles: (_workspaceId: string, path: string) => Promise.resolve(path === ''
        ? ready({ path: '', revision: 7, items: [{ path: 'src', kind: 'directory', size: 0, etag: 'd' }] })
        : failure('FORBIDDEN', '目录不可读')),
    })
    renderView(remote)
    fireEvent.click(await screen.findByRole('button', { name: 'src' }))
    await waitFor(() => {
      expect(screen.getByText(/FORBIDDEN/u)).toBeTruthy()
    })
  })
})

describe('R2-03 per-status read results', () => {
  type Domain = 'directory' | 'profiles' | 'runs' | 'preview'
  const CODES = ['AUTH_REQUIRED', 'TOKEN_EXPIRED', 'UNAUTHORIZED', 'FORBIDDEN', 'RESOURCE_NOT_FOUND', 'SERVICE_UNAVAILABLE'] as const
  const LOGOUT_CODES = new Set(['AUTH_REQUIRED', 'TOKEN_EXPIRED', 'UNAUTHORIZED'])

  /**
   * Break exactly one read domain with the given error code. `directory`,
   * `profiles` and `runs` fail on first render; `preview` fails when the user
   * opens the one seeded file.
   */
  function remoteWithFailingDomain(domain: Domain, code: string): ClientRemote {
    return fakeRemote({
      workspaceFiles: (_workspaceId: string, path: string) => {
        if (domain === 'directory') return Promise.resolve(failure(code, '读取失败'))
        return Promise.resolve(path === ''
          ? ready({ path: '', revision: 7, items: [{ path: 'a.txt', kind: 'file', size: 1, etag: 'f' }] })
          : ready({ path: '', revision: 7, items: [] }))
      },
      agentProfiles: domain === 'profiles'
        ? () => Promise.resolve(failure(code, '读取失败'))
        : undefined,
      workspaceRuns: domain === 'runs'
        ? () => Promise.resolve(failure(code, '读取失败'))
        : undefined,
      workspacePreview: domain === 'preview'
        ? () => Promise.resolve(failure(code, '预览失败'))
        : undefined,
    })
  }

  it.each(CODES)('%s on a read shows the real result instead of empty data', async (code) => {
    for (const domain of ['directory', 'profiles', 'runs', 'preview'] as const) {
      const onAuthorizationFailure = vi.fn()
      const remote = remoteWithFailingDomain(domain, code)
      const view = renderView(remote, 'project-a', onAuthorizationFailure)
      if (domain === 'preview') {
        fireEvent.click(await screen.findByRole('button', { name: 'a.txt' }))
      }
      await waitFor(() => {
        expect(screen.getByText(new RegExp(code, 'u'))).toBeTruthy()
      }, { timeout: 3_000 })
      if (LOGOUT_CODES.has(code)) {
        expect(onAuthorizationFailure).toHaveBeenCalled()
      }
      view.unmount()
      cleanup()
      window.localStorage.clear()
    }
  })

  it('legal empty reads stay empty without an error banner', async () => {
    const remote = fakeRemote({
      agentProfiles: () => Promise.resolve(ready([])),
      workspaceRuns: () => Promise.resolve(ready([])),
      workspaceFiles: () => Promise.resolve(ready({ path: '', revision: 7, items: [] })),
    })
    renderView(remote)
    await screen.findAllByText('ws-a1')
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(screen.queryByRole('alert')).toBeNull()
  })
})

describe('R2-03 transition-period requests and side effects', () => {
  it('records the read sequence across a project switch and the late A landing', async () => {
    const calls: string[] = []
    const slowA = deferred<unknown>()
    const remote = fakeRemote({
      workspaces: (projectId: string) => {
        calls.push(`workspaces:${projectId}`)
        if (projectId === 'project-a') return slowA.promise
        return Promise.resolve(ready([snapshot('ws-b1', 'project-b', 'trunk', 2)]))
      },
      workspace: () => Promise.resolve(ready(snapshot('ws-b1', 'project-b', 'trunk', 2))),
      workspaceFiles: (_workspaceId: string, path: string) => {
        calls.push(`files:${path}`)
        return Promise.resolve(ready({ path: '', revision: 2, items: [] }))
      },
    })
    const view = renderView(remote, 'project-a')
    await new Promise(resolve => setTimeout(resolve, 30))
    view.rerender(
      <CloudWorkspacesView remote={remote} useWorkspaces={useWorkspacesStub} projectId="project-b" projects={projects} sessionId="sess-1" />,
    )
    await screen.findAllByText('ws-b1')
    // Transition-period side effect: B's list renders while A is still open.
    expect(calls.indexOf('workspaces:project-a')).toBeLessThan(calls.indexOf('workspaces:project-b'))
    // The late A answer lands and must not replace B's list.
    slowA.resolve(ready([snapshot('ws-a1', 'project-a', 'main', 7)]))
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(screen.queryByText('ws-a1')).toBeNull()
    expect(screen.getAllByText('ws-b1').length).toBeGreaterThan(0)
  })

  it('keeps the newer file in the preview when the older read lands last', async () => {
    const calls: string[] = []
    const slowA = deferred<unknown>()
    const remote = fakeRemote({
      workspaceFiles: (_workspaceId: string, path: string) => Promise.resolve(path === ''
        ? ready({
          path: '', revision: 7, items: [
            { path: 'a.txt', kind: 'file', size: 1, etag: 'a' },
            { path: 'b.txt', kind: 'file', size: 1, etag: 'b' },
          ],
        })
        : ready({ path: '', revision: 7, items: [] })),
      workspacePreview: (_workspaceId: string, path: string) => {
        calls.push(`preview:${path}`)
        return path === 'a.txt' ? slowA.promise : Promise.resolve(ready({ path: 'b.txt', revision: 7, etag: 'b', kind: 'text', contentType: 'text/plain', content: 'B-content' }))
      },
    })
    renderView(remote)
    fireEvent.click(await screen.findByRole('button', { name: 'a.txt' }))
    // Transition-period side effect: the preview request for a.txt was issued
    // and the pane still shows no content for it.
    expect(calls).toEqual(['preview:a.txt'])
    fireEvent.click(screen.getByRole('button', { name: 'b.txt' }))
    await screen.findByText('B-content')
    expect(calls).toEqual(['preview:a.txt', 'preview:b.txt'])
    slowA.resolve(ready({ path: 'a.txt', revision: 7, etag: 'a', kind: 'text', contentType: 'text/plain', content: 'A-content' }))
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(screen.queryByText('A-content')).toBeNull()
    expect(screen.getByText('B-content')).toBeTruthy()
  })

  it('stops reading a workspace once a refresh removes it from the list', async () => {
    const calls: string[] = []
    let listing: unknown[] = [snapshot('ws-a1', 'project-a', 'main', 7)]
    const remote = fakeRemote({
      workspaces: () => {
        calls.push('workspaces')
        return Promise.resolve(ready(listing))
      },
      workspaceFiles: () => {
        calls.push('files:ws-a1')
        return Promise.resolve(ready({ path: '', revision: 7, items: [] }))
      },
    })
    renderView(remote)
    await screen.findAllByText('ws-a1')
    const readsBefore = calls.filter(entry => entry === 'files:ws-a1').length
    listing = []
    fireEvent.click(screen.getByRole('button', { name: 'refresh-workspaces' }))
    await waitFor(() => {
      expect(screen.queryByText('ws-a1')).toBeNull()
    })
    // Side effect: the removed workspace is deselected and its file reads stop.
    expect(screen.getByText('选择一个 Workspace 作为当前 Session 的运行上下文。')).toBeTruthy()
    const readsAfter = calls.filter(entry => entry === 'files:ws-a1').length
    expect(readsAfter).toBe(readsBefore)
  })

  it('rebinds the session facts when the native session switches', async () => {
    const remote = fakeRemote()
    const view = renderView(remote, 'project-a')
    await screen.findAllByText('sess-1')
    view.rerender(
      <CloudWorkspacesView remote={remote} useWorkspaces={useWorkspacesStub} projectId="project-a" projects={projects} sessionId="sess-2" />,
    )
    await screen.findAllByText('sess-2')
    expect(screen.queryByText('sess-1')).toBeNull()
  })
})
