// @vitest-environment jsdom
/**
 * A1 回归测试：外壳**不接受**切换时，不得每次渲染都再切一次。
 *
 * 事实背景：我们映射出的会话是**归档**的（平台测试注释写明 "archived immediately so it stays
 * out of the shell's session list"），而 `ISessions.open` 的契约是 "unknown ids fail loud"。
 * 若外壳因此不把 `current` 改成目标值，`sessionId` 就**永不等于**目标 ⇒ 每次父渲染都再切一次，
 * 而每次都引发父渲染 ⇒ 死循环。所有者实测的"卡死"正是这个形状。
 *
 * 这个用例把外壳的行为浓缩成一句："重渲染，但不接受切换"。
 */
import { describe, expect, it, vi } from 'vitest'
import { useState } from 'react'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { CloudWorkspacesView } from '../src/client/cloud-workspaces/CloudWorkspacesView.tsx'
import type { ClientRemote } from '../src/client/remote/types.ts'

const ready = <T,>(value: T): { status: 'ready'; value: T; fixtureOnly: boolean } =>
  ({ status: 'ready', value, fixtureOnly: true })

const workspaceSnapshot = {
  workspaceId: 'ws-alpha-1', projectId: 'project-alpha', ownerUserId: 'member-1',
  repositoryId: 'repo-1', branch: 'main', displayName: '云工作台主空间',
  defaultAgentProfileVersionId: 'apv-1', status: 'ready', revision: 7, lastError: null,
  createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-09T00:00:00Z',
}
const projects = [{
  projectId: 'project-alpha', organizationId: 'org-alpha', organizationName: '星河 AI 平台',
  name: '协作台前端', description: '', status: 'active', createdBy: 'admin-1',
  createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z',
  memberCount: 2, assetCount: 3, revision: 1,
}]
const useWorkspacesStub = ((selector: (state: { items: unknown[] }) => unknown) => selector({ items: [] })) as never

function fakeRemote(): ClientRemote {
  const fns: Record<string, ReturnType<typeof vi.fn>> = {
    workspaces: vi.fn(async () => ready([workspaceSnapshot])),
    workspace: vi.fn(async () => ready(workspaceSnapshot)),
    workspaceChanges: vi.fn(async () => ready({ workspaceId: 'ws-alpha-1', baselineRevision: 5, revision: 7, files: [] })),
    workspaceRuns: vi.fn(async () => ready([])),
    agentProfiles: vi.fn(async () => ready([])),
    workspacePlans: vi.fn(async () => ready([])),
    workspaceSessionRecords: vi.fn(async () => ready([])),
    workspaceFiles: vi.fn(async () => ready({
      path: '', kind: 'directory',
      items: [{ path: 'README.md', kind: 'file', size: 12, etag: 'e1' }],
    })),
    streamState: vi.fn(async () => ({ status: 'live', lastEventId: 'evt-000001' })),
    startStream: vi.fn(async () => ({ subscriptionId: 'sub-1', state: { status: 'connecting' } })),
    stopStream: vi.fn(async () => ({ status: 'idle' })),
    streamEventsAfter: vi.fn(async () => ({ events: [], truncated: false })),
    codeSources: vi.fn(async () => ready([])),
    workspacePreview: vi.fn(async () => ready({
      path: 'README.md', revision: 7, etag: 'e1', kind: 'markdown', contentType: 'text/markdown', content: '# x',
    })),
    workspacePreviewUrl: vi.fn(async () => ready({ url: 'https://x/y', expiresAt: '2099-01-01T00:00:00Z', workspaceId: 'ws-alpha-1' })),
    workspaceAction: vi.fn(async () => ready(workspaceSnapshot)),
    deleteWorkspace: vi.fn(async () => ready(workspaceSnapshot)),
    discardChanges: vi.fn(async () => ready({ revision: 8 })),
    gitCommit: vi.fn(async () => ready({ revision: 8 })),
    createPullRequest: vi.fn(async () => ready({ pullRequestId: 'pr-1' })),
    createRun: vi.fn(), createWorkspace: vi.fn(), run: vi.fn(), cancelRun: vi.fn(), retryRun: vi.fn(),
    runCheckpoint: vi.fn(), pauseRun: vi.fn(), resumeRun: vi.fn(),
    createPlan: vi.fn(), updatePlan: vi.fn(), confirmPlan: vi.fn(), plan: vi.fn(),
  }
  return {
    cloudWorkspaces: Object.fromEntries(Object.entries(fns).map(([name, fn]) => [
      name, async (...args: unknown[]) => ({ ok: true as const, value: await (fn as (...a: unknown[]) => Promise<unknown>)(...args) }),
    ])),
  } as unknown as ClientRemote
}

describe('A1 回归：外壳不接受切换时不得进入死循环', () => {
  it('同一目标只尝试一次（外壳重渲染但不改 current）', async () => {
    const remote = fakeRemote()
    ;(remote as { workspaceSessions?: unknown }).workspaceSessions = {
      ensure: async () => ({ ok: true as const, sessionId: 'sess-mapped' }),
      conversation: () => ({ ok: false as const, message: '测试：不渲染会话内容' }),
    }
    const opened: string[] = []
    let renders = 0

    function Host() {
      renders += 1
      // 渲染次数失控就是死循环的判据：正常应在个位数。
      if (renders > 40) throw new Error(`疑似死循环：Host 渲染 ${renders} 次`)
      const [, force] = useState(0)
      return (
        <CloudWorkspacesView
          remote={remote}
          useWorkspaces={useWorkspacesStub}
          projectId="project-alpha"
          projects={projects}
          sessionId="sess-shell"
          accountId="member-1"
          openSession={(sessionId) => {
            opened.push(sessionId)
            // 外壳"重渲染但不接受切换"：current 仍是 sess-shell。
            force(count => count + 1)
          }}
        />
      )
    }

    render(<Host />)
    await screen.findAllByText('ws-alpha-1')
    // 给循环足够的机会发生。
    await waitFor(() => { expect(opened.length).toBeGreaterThan(0) })
    await new Promise(resolve => { setTimeout(resolve, 80) })

    expect(opened.filter(id => id === 'sess-mapped')).toHaveLength(1)
    expect(renders).toBeLessThan(40)
  })

  it('离开时恢复进入前的会话（只在卸载时发生一次）', async () => {
    const remote = fakeRemote()
    ;(remote as { workspaceSessions?: unknown }).workspaceSessions = {
      ensure: async () => ({ ok: true as const, sessionId: 'sess-mapped' }),
      conversation: () => ({ ok: false as const, message: '测试：不渲染会话内容' }),
    }
    const opened: string[] = []
    const view = render(
      <CloudWorkspacesView
        remote={remote}
        useWorkspaces={useWorkspacesStub}
        projectId="project-alpha"
        projects={projects}
        sessionId="sess-shell"
        accountId="member-1"
        openSession={(sessionId) => { opened.push(sessionId) }}
      />,
    )
    await screen.findAllByText('ws-alpha-1')
    await waitFor(() => { expect(opened).toContain('sess-mapped') })

    view.unmount()
    // 恢复的是**进入前**的会话，而且只发生一次（多来几次就又是那个死循环）。
    expect(opened.filter(id => id === 'sess-shell')).toHaveLength(1)
  })
})
