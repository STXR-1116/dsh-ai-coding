// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ClientRemote } from '@deepseek-ai/dsh-api-remotes/client'
import type { PlatformSurfaceProps } from '../src/client/PlatformSurface.tsx'
import { PlatformDemoController } from '../src/client/controller.ts'
import { PlatformSurface } from '../src/client/PlatformSurface.tsx'
import { seedBrowserSettings } from './helpers/browser-settings.ts'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

// 工作台整体被设置面门控：渲染型用例先种入 fixture 部署设置。
beforeEach(() => {
  seedBrowserSettings()
})

const demoAccount = {
  status: 'authenticated' as const,
  user: {
    userId: 'u-1', username: 'u', email: 'u@example.com', displayName: '用户',
    status: 'active' as const, globalRole: 'admin' as const, mustChangePassword: false, revision: 1,
  },
  memberships: [],
  mustChangePassword: false,
}

function collectorStatus(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    mode: 'active', projectId: 'project-alpha', queueEventCount: 4, queueByteCount: 512,
    lastAcceptedAt: '2026-09-05T00:00:00.000Z', lastFailure: null, gapCount: 0,
    authorizationState: 'authorized', storageError: null, ...overrides,
  }
}

function remoteWithStatus(status: Record<string, unknown>): ClientRemote {
  return {
    teamSkills: {
      account: vi.fn(async () => ({ ok: true as const, value: demoAccount })),
      projects: vi.fn(async () => ({ ok: true as const, value: [] })),
      accessSummary: vi.fn(async () => ({
        ok: true as const,
        value: { organizations: [], projects: [], assets: [], management: { organizationIds: [], projectIds: [] }, revision: 1 },
      })),
      configureProjectMemory: vi.fn(async () => ({ ok: true as const, value: undefined })),
      clearProjectMemory: vi.fn(async () => ({ ok: true as const, value: undefined })),
      configureCollectorProject: vi.fn(async () => ({ ok: true as const, value: { projectId: 'project-alpha' } })),
      clearCollectorProject: vi.fn(async () => ({ ok: true as const, value: { cleared: true as const } })),
      collectorStatus: vi.fn(async () => ({ ok: true as const, value: { status: 'ready' as const, value: status } })),
      pauseCollector: vi.fn(async () => ({ ok: true as const, value: { status: 'ready' as const, value: status } })),
      resumeCollector: vi.fn(async () => ({ ok: true as const, value: { status: 'ready' as const, value: status } })),
      flushCollector: vi.fn(async () => ({ ok: true as const, value: { status: 'ready' as const, value: status } })),
      clearPendingCollectorData: vi.fn(async () => ({ ok: true as const, value: { status: 'ready' as const, value: status } })),
    },
  } as unknown as ClientRemote
}

const emptySessions = { ids: [] as string[], current: undefined, byId: {} }
type EmptySessions = typeof emptySessions

async function openCollector(status: Record<string, unknown>): Promise<void> {
  const controller = new PlatformDemoController()
  controller.open()
  const props = {
    controller,
    t: ((key: string) => key) as never,
    useSessions: ((selector: (state: EmptySessions) => unknown) => selector(emptySessions)) as never,
    useWorkspaces: ((selector: (state: object) => unknown) => selector({})) as never,
    remote: remoteWithStatus(status),
    layout: {
      openRightbar: vi.fn(), closeRightbar: vi.fn(),
      toggleSidebar: () => {},
      openDetails: () => {},
      closeDetails: () => {},
    },
  } as unknown as PlatformSurfaceProps
  render(<PlatformSurface {...props} />)
  const nav = await screen.findByRole('navigation', { name: '平台模块' })
  fireEvent.click(within(nav).getByRole('button', { name: 'AI Coding 可观测' }))
  await waitFor(() => {
    expect(screen.getByRole('heading', { name: 'AI Coding 可观测' })).toBeTruthy()
  })
}

describe('CollectorView pipeline states', () => {
  it('shows queue totals, gap warnings, and last failure for an active pipeline', async () => {
    await openCollector(collectorStatus({
      lastFailure: { stage: 'send', code: 'TELEMETRY_UNAVAILABLE', at: '2026-09-05T00:01:00.000Z', summary: '503 unavailable' },
      gapCount: 3,
    }))
    expect((await screen.findAllByText('采集中')).length).toBeGreaterThan(0)
    expect(screen.getByText('4')).toBeTruthy()
    expect(screen.getByText(/3 条缺口记录/)).toBeTruthy()
    expect(screen.getByText(/TELEMETRY_UNAVAILABLE/)).toBeTruthy()
    expect(screen.getByText('立即发送')).toBeTruthy()
    expect(screen.getByText('清空未上报数据')).toBeTruthy()
  })

  it('shows the paused mode and storage-error warning', async () => {
    await openCollector(collectorStatus({
      mode: 'paused',
      storageError: 'telemetry queue schema version 99 is not recognized; sending stopped',
    }))
    expect(await screen.findAllByText('已暂停').then(found => found.length)).toBeGreaterThan(0)
    expect(screen.getByText(/telemetry queue schema version 99/)).toBeTruthy()
    expect(screen.getByRole('button', { name: /恢复采集/ })).toBeTruthy()
  })

  it('shows the signed-out and authorization-revoked modes', async () => {
    await openCollector(collectorStatus({ mode: 'signed-out' }))
    expect((await screen.findAllByText('账号未登录')).length).toBeGreaterThan(0)

    cleanup()
    await openCollector(collectorStatus({ mode: 'authorization-revoked', authorizationState: 'revoked' }))
    expect((await screen.findAllByText('项目授权已撤销')).length).toBeGreaterThan(0)
    // The authorization state is visible in the diagnostics row.
    expect(screen.getAllByText(/授权状态：已撤销/).length).toBeGreaterThan(0)
  })

  it('surfaces a not-ready snapshot from the Host', async () => {
    const controller = new PlatformDemoController()
    controller.open()
    const remote = remoteWithStatus(collectorStatus())
    ;(remote.teamSkills.collectorStatus as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true as const,
      value: { status: 'not-ready' as const, missing: ['telemetryStorage'] },
    })
    const props = {
      controller,
      t: ((key: string) => key) as never,
      useSessions: ((selector: (state: EmptySessions) => unknown) => selector(emptySessions)) as never,
      useWorkspaces: ((selector: (state: object) => unknown) => selector({})) as never,
      remote,
      layout: { openRightbar: vi.fn(), closeRightbar: vi.fn(), toggleSidebar: () => {}, openDetails: () => {}, closeDetails: () => {} },
    } as unknown as PlatformSurfaceProps
    render(<PlatformSurface {...props} />)
    const nav = await screen.findByRole('navigation', { name: '平台模块' })
    fireEvent.click(within(nav).getByRole('button', { name: 'AI Coding 可观测' }))
    expect(await screen.findByText(/采集配置未就绪：缺少 telemetryStorage/)).toBeTruthy()
  })
})
