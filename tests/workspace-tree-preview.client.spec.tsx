// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { CloudWorkspacesView } from '../src/client/cloud-workspaces/CloudWorkspacesView'
import { PREVIEW_CSP_FLOOR } from '../src/client/cloud-workspaces/preview-security.ts'
import type { ClientRemote, TeamSkillProject } from '@deepseek-ai/dsh-api-remotes/client'

// 2-2「工程树、会话与预览」插件面验收：
// - 工程树：变更集中的文件带 Agent 修改·未同步标记；测试路径带测试关联标记；
// - 预览按内容类型选择查看器：Markdown/终端输出/diff 各归其位（data-viewer 显式
//   标注，不用颜色单独表达）。

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

const treeItems = [
  { path: 'README.md', kind: 'file', size: 24, etag: 'md-1' },
  { path: 'src/app.json', kind: 'file', size: 10, etag: 'json-1' },
  { path: 'tests/app.spec.ts', kind: 'file', size: 40, etag: 'spec-1' },
  { path: 'terminal/output.txt', kind: 'file', size: 20, etag: 'term-1' },
  { path: 'changes.diff', kind: 'file', size: 30, etag: 'diff-1' },
]

function fakeRemote(overrides: Record<string, ReturnType<typeof vi.fn>> = {}): {
  readonly remote: ClientRemote
  readonly fns: Record<string, ReturnType<typeof vi.fn>>
} {
  const fns: Record<string, ReturnType<typeof vi.fn>> = {
    workspaces: vi.fn(async () => ready([workspaceSnapshot])),
    workspace: vi.fn(async () => ready(workspaceSnapshot)),
    workspaceChanges: vi.fn(async () => ready({
      workspaceId: 'ws-alpha-1', baselineRevision: 5, revision: 7,
      files: [
        { path: 'README.md', change: 'modified', diff: '--- a\n+++ b\n+修改' },
        { path: 'src/app.json', change: 'modified', diff: '--- a\n+++ b\n+配置' },
      ],
    })),
    workspaceRuns: vi.fn(async () => ready([])),
    agentProfiles: vi.fn(async () => ready([profile])),
    workspacePlans: vi.fn(async () => ready([])),
    workspaceFiles: vi.fn(async () => ready({ path: '', kind: 'directory', items: treeItems })),
    workspacePreview: vi.fn(async (_workspaceId: string, path: string) => {
      if (path === 'README.md') {
        return ready({ path, revision: 7, etag: 'md-1', kind: 'markdown', contentType: 'text/markdown', content: '# 标题\n\n正文说明' })
      }
      if (path === 'terminal/output.txt') {
        return ready({ path, revision: 7, etag: 't-1', kind: 'text', contentType: 'text/x-terminal', content: '$ pnpm test\nall green' })
      }
      if (path === 'changes.diff') {
        return ready({ path, revision: 7, etag: 'd-1', kind: 'diff', contentType: 'text/x-diff', diff: '--- a\n+++ b\n+added line' })
      }
      return ready({ path, revision: 7, etag: 'e', kind: 'text', contentType: 'text/plain', content: 'plain' })
    }),
    streamState: vi.fn(async () => ({ status: 'live', lastEventId: 'evt-000001' })),
    startStream: vi.fn(async () => ({ subscriptionId: 'sub-1', state: { status: 'connecting' } })),
    stopStream: vi.fn(async () => ({ status: 'idle' })),
    streamEventsAfter: vi.fn(async () => ({ events: [], truncated: false })),
    codeSources: vi.fn(async () => ready([])),
    createRun: vi.fn(), createWorkspace: vi.fn(), cancelRun: vi.fn(), retryRun: vi.fn(),
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

async function treeRow(text: string): Promise<HTMLElement> {
  const node = await screen.findByText(text)
  return node.closest('button') as HTMLElement
}

describe('2-2 工程树、会话与预览', () => {
  it('工程树显示 Agent 修改/未同步标记与测试关联标记', async () => {
    const { remote } = fakeRemote()
    render(<CloudWorkspacesView remote={remote} useWorkspaces={useWorkspacesStub} projectId="project-alpha" projects={projects} sessionId="sess-1" />)
    await screen.findAllByText('ws-alpha-1')

    const readmeRow = await treeRow('README.md')
    expect(readmeRow.textContent).toContain('README.md')
    expect(readmeRow.textContent).toContain('Agent 修改·未同步')
    expect(readmeRow.textContent).not.toContain('测试')

    const specRow = await treeRow('tests/app.spec.ts')
    expect(specRow.textContent).toContain('测试')
    expect(specRow.textContent).not.toContain('Agent 修改')
    const jsonRow = await treeRow('src/app.json')
    expect(jsonRow.textContent).toContain('Agent 修改·未同步')
  })

  it('预览按内容类型选择查看器：Markdown', async () => {
    const { remote, fns } = fakeRemote()
    render(<CloudWorkspacesView remote={remote} useWorkspaces={useWorkspacesStub} projectId="project-alpha" projects={projects} sessionId="sess-1" />)
    await screen.findAllByText('ws-alpha-1')

    fireEvent.click(await treeRow('README.md'))
    const markdownViewer = await screen.findByText('正文说明')
    expect(markdownViewer.closest('[data-viewer="markdown"]')).toBeTruthy()
    expect(fns.workspacePreview!.mock.calls.some(([id, path]) => id === 'ws-alpha-1' && path === 'README.md')).toBe(true)
  })

  it('终端输出查看器以 data-viewer 显式标注', async () => {
    const { remote } = fakeRemote()
    render(<CloudWorkspacesView remote={remote} useWorkspaces={useWorkspacesStub} projectId="project-alpha" projects={projects} sessionId="sess-1" />)
    await screen.findAllByText('ws-alpha-1')

    fireEvent.click(await treeRow('terminal/output.txt'))
    const terminal = await screen.findByText(/\$ pnpm test/u)
    expect(terminal.closest('[data-viewer="terminal"]')).toBeTruthy()
  })

  it('diff 查看器以 data-viewer 显式标注', async () => {
    const { remote } = fakeRemote()
    render(<CloudWorkspacesView remote={remote} useWorkspaces={useWorkspacesStub} projectId="project-alpha" projects={projects} sessionId="sess-1" />)
    await screen.findAllByText('ws-alpha-1')

    fireEvent.click(await treeRow('changes.diff'))
    const diffViewer = await screen.findByText(/\+added line/u)
    expect(diffViewer.closest('[data-viewer="diff"]')).toBeTruthy()
  })

  it('workspaceChanges 提供的变更数据驱动树标记（服务端确认，非客户端推断全部）', async () => {
    const { remote, fns } = fakeRemote()
    render(<CloudWorkspacesView remote={remote} useWorkspaces={useWorkspacesStub} projectId="project-alpha" projects={projects} sessionId="sess-1" />)
    await screen.findAllByText('ws-alpha-1')
    await waitFor(() => {
      expect(fns.workspaceChanges!.mock.calls.length).toBeGreaterThan(0)
    })
    const readmeRow = await treeRow('README.md')
    expect(readmeRow.textContent).toContain('Agent 修改·未同步')
  })
})

describe('2-3 HTML 预览安全', () => {
  it('静态 HTML 预览应用工作台安全地板：不透明 origin、词表外 token 丢弃、CSP 地板先于声明安装', async () => {
    const { remote } = fakeRemote({
      workspacePreview: vi.fn(async (_workspaceId: string, path: string) => {
        if (path === 'index.html') {
          return ready({
            path, revision: 7, etag: 'h-1', kind: 'static_html', contentType: 'text/html',
            content: '<!doctype html><html><body>安全预览</body></html>',
            csp: 'default-src *',
            sandbox: ['allow-scripts', 'allow-same-origin', 'allow-top-navigation', 'allow-popups'],
          })
        }
        return ready({ path, revision: 7, etag: 'e', kind: 'text', contentType: 'text/plain', content: 'plain' })
      }),
      workspaceFiles: vi.fn(async () => ready({
        path: '', kind: 'directory',
        items: [...treeItems, { path: 'index.html', kind: 'file', size: 64, etag: 'h-1' }],
      })),
    })
    render(<CloudWorkspacesView remote={remote} useWorkspaces={useWorkspacesStub} projectId="project-alpha" projects={projects} sessionId="sess-1" />)
    await screen.findAllByText('ws-alpha-1')

    fireEvent.click(await treeRow('index.html'))
    const frame = await screen.findByTitle('preview-iframe')
    // 服务端声明的 allow-same-origin/allow-top-navigation/allow-popups 全部不存活；
    // 未声明的 allow-forms 也不被发明。不透明 origin 保持。
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts')
    // CSP 地板先于服务端声明安装：声明只能收窄、不能放宽。
    const srcdoc = frame.getAttribute('srcdoc') ?? ''
    expect(srcdoc).toContain(PREVIEW_CSP_FLOOR)
    expect(srcdoc.indexOf(PREVIEW_CSP_FLOOR)).toBeLessThan(srcdoc.indexOf('default-src *'))
  })
})
