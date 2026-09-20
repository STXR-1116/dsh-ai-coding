// @vitest-environment jsdom
// UX-12 fact source: state naming, overlay layering, focus ownership and live
// announcements. Every case here asserts a user-visible contract that the
// pre-UX-12 implementation did not satisfy, so the same file is both the RED
// (old snapshot) and GREEN (current) evidence for UX-12.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ClientRemote } from '@deepseek-ai/dsh-api-remotes/client'
import type { WorkspaceListState } from './helpers/client-runtime-types.ts'
import type { PlatformSurfaceProps } from '../src/client/PlatformSurface.tsx'
import { PlatformSurface } from '../src/client/PlatformSurface.tsx'
import { PlatformDemoController } from '../src/client/controller.ts'

afterEach(() => {
  cleanup()
  window.localStorage.clear()
})

const copy = {
  'platform.name': '编程协作台',
  'platform.shortName': '协作台',
  'platform.open': '打开编程协作台',
  'platform.close': '关闭编程协作台',
}

const t = (key: string): string => copy[key as keyof typeof copy] ?? key

const demoAccount = {
  status: 'authenticated' as const,
  user: {
    userId: 'member-1',
    username: 'member@example.com',
    email: 'member@example.com',
    displayName: '成员甲',
    status: 'active' as const,
    globalRole: 'member' as const,
    mustChangePassword: false,
    revision: 1,
  },
  memberships: [{ organizationId: 'org-1', organizationName: '星河平台', status: 'active' as const, revision: 1 }],
  mustChangePassword: false,
}

const demoOrganizations = [{ organizationId: 'org-1', name: '星河平台', status: 'active' as const, revision: 1 }]
const demoProject = {
  projectId: 'orbit-ui',
  organizationId: 'org-1',
  organizationName: '星河平台',
  name: 'AI开放平台',
  description: 'AI 开放平台项目',
  status: 'active' as const,
  createdBy: 'manager-1',
  createdAt: '2026-08-29T08:00:00Z',
  updatedAt: '2026-08-29T08:00:00Z',
  memberCount: 1,
  assetCount: 1,
  revision: 1,
}
const demoAccess = {
  organizations: demoOrganizations,
  projects: [demoProject],
  assets: [],
  management: { organizationIds: ['org-1'], projectIds: ['orbit-ui'] },
  revision: 1,
}

const demoWorkspaceState: WorkspaceListState = {
  items: [],
  archivedSessionIds: [],
  state: 'idle',
  phase: 'ready',
  error: null,
  baselinesReady: true,
  recentWorkspaceId: undefined,
}

const demoSessionState = {
  ids: ['session-1'],
  current: 'session-1',
  byId: { 'session-1': { blank: false, displayTitle: 'session-1' } },
}

const demoKnowledgeBases = [
  {
    knowledgeBaseId: 'k-1',
    name: 'DSH 会话事件与模型可见性规范',
    description: '会话日志与模型可见性要求。',
    type: 'document' as const,
    state: 'active' as const,
    searchable: true,
    updatedAt: '2026-08-29T08:00:00Z',
    revision: 1,
  },
]

const demoMemory = {
  memoryId: 'm-1',
  teamId: 'team-1',
  projectId: 'orbit-ui',
  content: '服务端记忆：稳定错误码必须保留。',
  layer: 'L1' as const,
  capturedByUserId: 'member-1',
  createdAt: '2026-08-29T08:00:00Z',
  updatedAt: '2026-08-29T09:00:00Z',
  revision: 1,
  status: 'ACTIVE' as const,
  importance: 0.9,
  recallCount: 2,
  lastRecalledAt: null,
  sourceKind: 'agent_turn' as const,
}

function demoRemote(): ClientRemote {
  return {
    teamSkills: {
      account: vi.fn(async () => ({ ok: true, value: demoAccount })),
      login: vi.fn(async () => ({ ok: true, value: demoAccount })),
      refreshAccount: vi.fn(async () => ({ ok: true, value: demoAccount })),
      changePassword: vi.fn(async () => ({ ok: true, value: demoAccount })),
      logout: vi.fn(async () => ({ ok: true, value: { status: 'signed-out' as const } })),
      organizations: vi.fn(async () => ({ ok: true, value: demoOrganizations })),
      projects: vi.fn(async () => ({ ok: true, value: [demoProject] })),
      project: vi.fn(async () => ({ ok: true, value: { project: demoProject, assets: [] } })),
      knowledgeBases: vi.fn(async () => ({ ok: true, value: demoKnowledgeBases })),
      configureKnowledgeSelection: vi.fn(async () => ({ ok: true as const, value: undefined })),
      clearKnowledgeSelection: vi.fn(async () => ({ ok: true as const, value: undefined })),
      knowledgeSearch: vi.fn(async () => ({ ok: true, value: { status: 'ready' as const, response: { requestId: 'req-1', results: [], knowledgeBases: [] } } })),
      memoryList: vi.fn(async () => ({ ok: true, value: { items: [demoMemory], nextCursor: null, totalEstimate: 1 } })),
      memoryGet: vi.fn(async () => ({ ok: true, value: demoMemory })),
      memoryUpdate: vi.fn(async () => ({ ok: true, value: { status: 'INDEX_PENDING' as const, eventId: 'e-1', jobId: 'j-1', memory: demoMemory } })),
      memoryDelete: vi.fn(async () => ({ ok: true, value: { status: 'PENDING' as const, eventId: 'e-delete', jobId: 'j-delete', cleanupStatus: 'PENDING' as const } })),
      configureProjectMemory: vi.fn(async () => ({ ok: true as const, value: undefined })),
      clearProjectMemory: vi.fn(async () => ({ ok: true as const, value: undefined })),
      accessSummary: vi.fn(async () => ({ ok: true, value: demoAccess })),
    },
  } as unknown as ClientRemote
}

function mountSurface(controller = new PlatformDemoController(), remote = demoRemote()) {
  controller.open()
  const props = {
    controller,
    t,
    useSessions: (<S,>(selector: (state: typeof demoSessionState) => S): S => selector(demoSessionState)) as never,
    useWorkspaces: (<S,>(selector: (state: WorkspaceListState) => S): S => selector(demoWorkspaceState)) as never,
    remote,
    layout: { openRightbar: vi.fn(), closeRightbar: vi.fn(), toggleSidebar: () => {}, openDetails: () => {}, closeDetails: () => {} },
  } as unknown as PlatformSurfaceProps
  return { controller, remote, ...render(<PlatformSurface {...props} />) }
}

async function selectCurrentProject(): Promise<void> {
  const select = await screen.findByRole('combobox', { name: '当前项目' })
  fireEvent.change(select, { target: { value: 'orbit-ui' } })
  await waitFor(() => {
    expect(select).toHaveProperty('value', 'orbit-ui')
  })
}

async function openAccountDrawer(): Promise<HTMLButtonElement> {
  const trigger = await screen.findByRole('button', { name: /账号与权限/ })
  trigger.focus()
  fireEvent.click(trigger)
  await screen.findByRole('dialog', { name: '账号与访问范围' })
  return trigger as HTMLButtonElement
}

async function openMemoryDeleteConfirmation(): Promise<HTMLButtonElement> {
  fireEvent.click(screen.getByRole('button', { name: '记忆库' }))
  const trigger = await screen.findByRole('button', { name: '删除记忆 m-1' })
  trigger.focus()
  fireEvent.click(trigger)
  await screen.findByRole('dialog', { name: '确认操作' })
  return trigger as HTMLButtonElement
}

function pressEscape(): void {
  fireEvent.keyDown(document.body, { key: 'Escape' })
}

/** The shell's rail and main column, the two regions an open overlay masks. */
function shellRegion(tag: 'aside' | 'main'): HTMLElement {
  const shell = screen.getByRole('dialog', { name: '编程协作台' })
  const region = shell.querySelector(`:scope > ${tag}`)
  expect(region).toBeTruthy()
  return region as HTMLElement
}

describe('UX-12 状态、响应式和无障碍', () => {
  it('Escape closes only the innermost confirmation layer and leaves the surface open', async () => {
    const { remote } = mountSurface()
    await selectCurrentProject()
    await openMemoryDeleteConfirmation()

    pressEscape()

    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: '确认操作' })).toBeNull()
    })
    // The surface and its navigation survive: only one layer was consumed.
    expect(screen.getByRole('dialog', { name: '编程协作台' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '记忆库' })).toBeTruthy()
    // Escape resolves the confirmation as "cancel": the delete never dispatches.
    expect(remote.teamSkills.memoryDelete).not.toHaveBeenCalled()
  })

  it('returns focus to the memory row after Escape dismisses the confirmation dialog', async () => {
    mountSurface()
    await selectCurrentProject()
    const trigger = await openMemoryDeleteConfirmation()

    pressEscape()

    await waitFor(() => {
      expect(document.activeElement).toBe(trigger)
    })
  })

  it('moves focus into the confirmation dialog when it opens', async () => {
    mountSurface()
    await selectCurrentProject()
    await openMemoryDeleteConfirmation()

    const dialog = screen.getByRole('dialog', { name: '确认操作' })
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: '取消' }))
  })

  it('Escape closes the account drawer, keeps the surface open and returns focus to its trigger', async () => {
    mountSurface()
    await selectCurrentProject()
    const trigger = await openAccountDrawer()

    pressEscape()

    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: '账号与访问范围' })).toBeNull()
    })
    expect(screen.getByRole('dialog', { name: '编程协作台' })).toBeTruthy()
    expect(document.activeElement).toBe(trigger)
  })

  it('Escape with no overlay open closes the whole surface', async () => {
    const { controller } = mountSurface()
    await selectCurrentProject()

    pressEscape()

    await waitFor(() => {
      expect(controller.getSnapshot()).toBe(false)
    })
    expect(screen.queryByRole('dialog', { name: '编程协作台' })).toBeNull()
  })

  it('hides the masked shell from assistive tech and the tab order while the account drawer is open', async () => {
    mountSurface()
    await selectCurrentProject()
    const trigger = await openAccountDrawer()
    const rail = shellRegion('aside')
    const main = shellRegion('main')

    expect(rail.getAttribute('aria-hidden')).toBe('true')
    expect(main.getAttribute('aria-hidden')).toBe('true')
    expect(rail.inert).toBe(true)
    expect(main.inert).toBe(true)

    fireEvent.click(screen.getByRole('button', { name: '关闭账号抽屉' }))

    await waitFor(() => {
      expect(rail.getAttribute('aria-hidden')).toBeNull()
    })
    expect(main.getAttribute('aria-hidden')).toBeNull()
    expect(rail.inert).toBe(false)
    expect(main.inert).toBe(false)
    expect(document.activeElement).toBe(trigger)
  })

  it('hides the masked shell from assistive tech while the confirmation dialog is open', async () => {
    mountSurface()
    await selectCurrentProject()
    await openMemoryDeleteConfirmation()

    expect(shellRegion('aside').getAttribute('aria-hidden')).toBe('true')
    expect(shellRegion('main').getAttribute('aria-hidden')).toBe('true')

    fireEvent.click(within(screen.getByRole('dialog', { name: '确认操作' })).getByRole('button', { name: '取消' }))

    await waitFor(() => {
      expect(shellRegion('main').getAttribute('aria-hidden')).toBeNull()
    })
  })

  it('exposes the loading, empty and error states through data-state and role=status', async () => {
    mountSurface()
    await screen.findByRole('group', { name: '准备' })
    const overview = await screen.findByRole('region', { name: '当前项目概览' })
    expect(overview.getAttribute('data-state')).toBe('no-project')
    const panel = within(overview).getByRole('status')
    expect(panel.getAttribute('data-state')).toBe('no-project')
    expect(within(panel).getByRole('heading', { name: '尚未选择项目' })).toBeTruthy()
    expect(within(panel).getByRole('button', { name: '选择项目' })).toBeTruthy()

    const failed = demoRemote()
    failed.teamSkills.accessSummary = vi.fn(async () => ({
      ok: true as const,
      value: { status: 'failed' as const, code: 'ROLE_FORBIDDEN', message: '无权读取访问范围' },
    }))
    cleanup()
    mountSurface(new PlatformDemoController(), failed)
    const deniedHeading = await screen.findByRole('heading', { name: '无权访问' })
    const denied = deniedHeading.closest('[role="status"]')
    expect(denied).toBeTruthy()
    expect(denied?.getAttribute('data-state')).toBe('forbidden')
  })

  it('announces the knowledge binding count through a live status region', async () => {
    mountSurface()
    await selectCurrentProject()
    fireEvent.click(screen.getByRole('button', { name: '知识库' }))

    const summary = (await screen.findByText('本轮已启用 0 个知识库')).closest('[role="status"]')
    expect(summary).toBeTruthy()
    expect((summary as HTMLElement).getAttribute('data-state')).toBe('empty')

    fireEvent.click(screen.getByRole('checkbox', { name: /DSH 会话事件与模型可见性规范/ }))

    expect(await screen.findByText('本轮已启用 1 个知识库')).toBeTruthy()
    expect((summary as HTMLElement).getAttribute('data-state')).toBe('ready')
  })

  it('gives the global project selector and the account drawer readable names', async () => {
    mountSurface()
    await selectCurrentProject()
    expect(screen.getAllByRole('combobox', { name: '当前项目' })).toHaveLength(1)
    await openAccountDrawer()
    const drawer = screen.getByRole('dialog', { name: '账号与访问范围' })
    expect(within(drawer).getByRole('button', { name: '关闭账号抽屉' })).toBeTruthy()
    expect(within(drawer).getByRole('region', { name: '组织作用域' })).toBeTruthy()
    expect(within(drawer).getByRole('region', { name: '项目作用域' })).toBeTruthy()
  })
})
