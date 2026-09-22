/** Full-screen, browser-local demo surface for the first-party platform. */
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ComponentType, type ReactNode } from 'react'
import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import type { PlatformRemote } from './remote/types.ts'
import type {
  CollectorSnapshot,
  CollectorStatus,
  TeamSkillAccessSummary,
  TeamSkillAccountResult,
  TeamSkillAccountRole,
  TeamSkillAccountState,
  TeamSkillAsset,
  TeamSkillChangePasswordRequest,
  TeamSkillEnvironment,
  TeamSkillKnowledgeBaseSummary,
  TeamSkillKnowledgePreview,
  TeamSkillKnowledgeSearchResponse,
  TeamSkillLoginRequest,
  TeamSkillMemory,
  TeamSkillMemoryMutation,
  TeamSkillMemoryPage,
  TeamSkillMemoryRecallResponse,
  TeamSkillOrganization,
  TeamSkillProject,
  TeamSkillProjectAsset,
} from '../types.ts'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ILayout } from '@deepseek-ai/dsh-client-ui-layout/client'
import { IconArchiveOutline20, IconAgentPresetOutline16, IconChevronLeftOutline14, IconChevronRightOutline14, IconCloseOutline16, IconDataOutline16, IconFolderOpenOutline16, IconGoalOutline16, IconInspectOutline12, IconPauseOutline16, IconPlayOutline16, IconQueueOutline14, IconRefreshOutline16, IconSearchOutline16, IconSettingsOutline14, IconSkillOutline16, IconSparkle16, IconUserOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import { DEFAULT_APPEARANCE, loadAppearance, resolveTheme, saveAppearance, type Appearance } from './appearance.ts'
import { NS } from './locales.ts'
import type { PlatformDemoController } from './controller.ts'
import { TeamSkillsView } from './team-skills/TeamSkillsView.tsx'
import {
  knowledgeBaseSearchStates,
  knowledgeSearchVerdict,
  knowledgeSelectorGroups,
  knowledgeSelectorTotals,
} from './knowledge-search-state.ts'
import { memoryRecallRows, memoryRecallVerdict, memoryTierLabel } from './memory-recall.ts'
import { CloudWorkspacesView } from './cloud-workspaces/CloudWorkspacesView.tsx'
import { AgentConfigView } from './agent-config/AgentConfigView.tsx'
import { RemoteSettingsView } from './RemoteSettingsView.tsx'
import { resolveBrowserSettings, subscribeBrowserSettings } from './remote/settings.ts'
import css from './PlatformSurface.module.css'

/** Full props for the root-scoped overlay slot. */
export type PlatformSurfaceProps = PropsRuntime<'shell.overlay'> &
  PropsLocale<typeof NS> & {
    controller: PlatformDemoController
    /**
     * The two remote namespaces this plugin provides in the browser. The
     * assembled shell's `ctx.remote` only projects upstream typert namespaces,
     * so the fragment self-hosts both faces instead of waiting on services
     * nobody provides.
     */
    remote: PlatformRemote
    /** Frame layout face: the docked workbench reserves its own width. */
    layout: ILayout
    /** Select the current native session (the workbench switcher). */
    openSession: (sessionId: SessionId) => void
    /** The native New Session flow (creates/reuses a blank session). */
    startSession: () => void
  }

type ViewId = 'overview' | 'projects' | 'skills' | 'cloud-workspaces' | 'knowledge' | 'memory' | 'collector' | 'agent-config'
type IconComponent = ComponentType<{ size?: number; className?: string }>

interface NavItem {
  id: ViewId
  label: string
  hint: string
  icon: IconComponent
}

interface NavGroup {
  id: string
  label: string
  items: readonly NavItem[]
}

interface Project {
  id: string
  organizationId: string
  organizationName: string
  name: string
  description: string
  status: TeamSkillProject['status']
  createdBy: string
  createdAt: string
  updatedAt: string
  memberCount: number
  assetCount: number
  revision: number
}

const OVERVIEW_NAV_ITEM: NavItem = {
  id: 'overview',
  label: '总览',
  hint: '当前项目摘要',
  icon: IconSparkle16,
}

// Task-grouped navigation: prepare assets, work in the workspace, review
// telemetry. The account group is the rail-bottom drawer trigger.
const NAV_GROUPS: readonly NavGroup[] = [
  {
    id: 'prepare',
    label: '准备',
    items: [
      { id: 'projects', label: '项目', hint: '权限范围内的项目', icon: IconFolderOpenOutline16 },
      { id: 'skills', label: '团队 Skill', hint: '团队能力目录', icon: IconSkillOutline16 },
      { id: 'knowledge', label: '知识库', hint: '项目资料与规范', icon: IconArchiveOutline20 },
      { id: 'memory', label: '记忆库', hint: '可复用的团队经验', icon: IconGoalOutline16 },
      { id: 'agent-config', label: 'Agent 配置', hint: '云端 Agent 参数', icon: IconAgentPresetOutline16 },
    ],
  },
  {
    id: 'work',
    label: '工作',
    items: [
      { id: 'cloud-workspaces', label: '云工作空间', hint: '云端工程工作台', icon: IconQueueOutline14 },
    ],
  },
  {
    id: 'review',
    label: '复盘',
    items: [
      { id: 'collector', label: 'AI Coding 可观测', hint: '采集状态与使用指标', icon: IconDataOutline16 },
    ],
  },
]

function roleLabel(role: TeamSkillAccountRole): string {
  return role === 'admin' ? '管理员' : role === 'manager' ? '经理' : '成员'
}

const LOCAL_ENVIRONMENT: TeamSkillEnvironment = {
  dshVersion: '0.1.1-rc.2',
  availableTools: [],
  availableMcpServers: [],
  presentEnvironmentVariableNames: [],
}

/** Root overlay: listens to the local controller and mounts the demo shell. */
export function PlatformSurface(props: PlatformSurfaceProps) {
  const { controller, t, remote, layout, useSessions, useWorkspaces, openSession, startSession } = props
  const open = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot)

  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') controller.close()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [controller, open])

  if (!open) return null
  return (
    <PlatformShell
      controller={controller}
      t={t}
      remote={remote}
      layout={layout}
      useSessions={useSessions}
      useWorkspaces={useWorkspaces}
      openSession={openSession}
      startSession={startSession}
    />
  )
}

function PlatformShell({ controller, t, remote, layout, useSessions, useWorkspaces, openSession, startSession }: Pick<PlatformSurfaceProps, 'controller' | 't' | 'remote' | 'layout' | 'useSessions' | 'useWorkspaces' | 'openSession' | 'startSession'>) {
  const [view, setView] = useState<ViewId>('overview')
  // Appearance (theme/density), rail collapse, and focus mode are visual-only
  // state: none of them reorder content or touch business requests (spec §8).
  const [appearance, setAppearanceState] = useState<Appearance>(() => DEFAULT_APPEARANCE)
  const [railCollapsed, setRailCollapsed] = useState(false)
  const [focusMode, setFocusMode] = useState<'off' | 'on'>('off')
  const [capsuleOpen, setCapsuleOpen] = useState(false)
  const [appearanceOpen, setAppearanceOpen] = useState(false)
  const [mobileNavOpen, setMobileNavOpen] = useState(false)
  const [prefersDark, setPrefersDark] = useState(true)
  const mobileNavToggleRef = useRef<HTMLButtonElement | null>(null)
  const railRef2 = useRef<HTMLElement | null>(null)
  useEffect(() => {
    setAppearanceState(loadAppearance())
    // jsdom and older hosts lack matchMedia: system theme just stays dark.
    const media = typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-color-scheme: dark)') : undefined
    if (media === undefined) return
    setPrefersDark(media.matches)
    const onChange = (event: MediaQueryListEvent): void => {
      setPrefersDark(event.matches)
    }
    media.addEventListener('change', onChange)
    return () => {
      media.removeEventListener('change', onChange)
    }
  }, [])
  const resolvedTheme = resolveTheme(appearance.theme, prefersDark)
  const setAppearance = (next: Appearance): void => {
    setAppearanceState(next)
    saveAppearance(next)
  }
  // Popovers sit above the surface, so their Escape handling must win over
  // the surface-level close: capture phase closes the layer actually open.
  // The mobile nav drawer joins the same layering order (rail first).
  useEffect(() => {
    if (!capsuleOpen && !appearanceOpen && !mobileNavOpen) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      if (mobileNavOpen) {
        setMobileNavOpen(false)
        mobileNavToggleRef.current?.focus()
      }
      setCapsuleOpen(false)
      setAppearanceOpen(false)
      event.stopPropagation()
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.removeEventListener('keydown', onKeyDown, true)
    }
  }, [capsuleOpen, appearanceOpen, mobileNavOpen])
  // 打开移动导航：焦点进入导航第一项；关闭：焦点回到触发按钮。
  useEffect(() => {
    if (!mobileNavOpen) return
    const previous = document.activeElement as HTMLElement | null
    railRef2.current?.querySelector<HTMLButtonElement>('button')?.focus()
    return () => {
      previous?.focus({ preventScroll: true })
    }
  }, [mobileNavOpen])
  const [gate, setGate] = useState<AccountGate>('loading')
  // The browser deployment settings gate the whole workbench: without them the
  // remote faces have nowhere to answer from, and the settings form is the
  // only screen that can change that.
  const [settingsReady, setSettingsReady] = useState<boolean>(() => resolveBrowserSettings() !== undefined)
  // The form is also the override editor, so it stays reachable once configured —
  // otherwise a wrong or moved endpoint could never be corrected from the browser
  // that is hitting it.
  const [settingsOpen, setSettingsOpen] = useState(false)
  // Rendered only while the settings form is NOT standing in for the workbench:
  // an open override editor replaces the panel rather than stacking under it.
  const chromeVisible = settingsReady && !settingsOpen
  useEffect(() => subscribeBrowserSettings(() => {
    setSettingsReady(resolveBrowserSettings() !== undefined)
    if (resolveBrowserSettings() !== undefined) {
      setGate('signed-out')
      setSettingsOpen(false)
    }
  }), [])
  const [account, setAccount] = useState<AuthenticatedAccount | undefined>()
  const [organizations, setOrganizations] = useState<readonly TeamSkillOrganization[]>([])
  const [access, setAccess] = useState<TeamSkillAccessSummary | undefined>()
  const [organizationFilterId, setOrganizationFilterId] = useState<string | undefined>()
  const [projectId, setProjectId] = useState<string | undefined>()
  const [serviceProjects, setServiceProjects] = useState<readonly TeamSkillProject[]>([])
  const [projectAssets, setProjectAssets] = useState<readonly TeamSkillProjectAsset[] | undefined>()
  const [knowledgeBases, setKnowledgeBases] = useState<readonly TeamSkillKnowledgeBaseSummary[]>([])
  const [selectedKnowledgeBaseIds, setSelectedKnowledgeBaseIds] = useState<Set<string>>(() => new Set())
  // 服务端确认的本轮绑定数量：列表选择是待提交状态，绑定成功后才计入「已启用」。
  const [knowledgeBoundCount, setKnowledgeBoundCount] = useState(0)
  const [knowledgeSearch, setKnowledgeSearch] = useState<TeamSkillKnowledgeSearchResponse | undefined>()
  const [knowledgePreview, setKnowledgePreview] = useState<TeamSkillKnowledgePreview | undefined>()
  // The knowledge list has its own read lifecycle inside loadProjectDetail; the
  // page must show that lifecycle instead of masquerading a stale or failed read
  // as an empty list.
  const [knowledgePhase, setKnowledgePhase] = useState<KnowledgePhase>('idle')
  const [knowledgeIssue, setKnowledgeIssue] = useState<SurfaceIssue | undefined>()
  const [projectDetailPhase, setProjectDetailPhase] = useState<DetailPhase>('idle')
  const [projectDetailIssue, setProjectDetailIssue] = useState<SurfaceIssue | undefined>()
  const [detailProject, setDetailProject] = useState<Project | undefined>()
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | undefined>()
  const [accountDrawerOpen, setAccountDrawerOpen] = useState(false)
  const [memories, setMemories] = useState<readonly TeamSkillMemory[]>([])
  const [memoryPage, setMemoryPage] = useState<TeamSkillMemoryPage | undefined>()
  const [memoryLoading, setMemoryLoading] = useState(false)
  const [memoryRefresh, setMemoryRefresh] = useState(0)
  const [memoryKeyword, setMemoryKeyword] = useState<string | undefined>()
  const [memoryError, setMemoryError] = useState<string | undefined>()
  const [collectorSnapshot, setCollectorSnapshot] = useState<CollectorSnapshot | undefined>()
  const [collectorLoading, setCollectorLoading] = useState(false)
  const [collectorError, setCollectorError] = useState<string | undefined>()
  const [collectorBusy, setCollectorBusy] = useState(false)
  const [collectorTick, setCollectorTick] = useState(0)
  const [collectorRefreshedAt, setCollectorRefreshedAt] = useState<string | undefined>()
  const [confirmation, setConfirmation] = useState<{
    readonly message: string
    readonly confirmLabel: string
    readonly resolve: (value: boolean) => void
  }>()
  const [permissionHintOpen, setPermissionHintOpen] = useState(false)
  // Close the innermost overlay first: confirmation dialog above the account
  // drawer above the surface. Each Escape press consumes exactly one layer.
  useEffect(() => {
    // Capture phase: this handler must observe Escape before the surface-level
    // bubble listener regardless of listener registration order (this effect
    // re-registers whenever an overlay opens or closes).
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      if (confirmation !== undefined) {
        // Only the innermost overlay reacts; the surface-level close-on-Escape
        // listener must not also fire for the same keypress.
        event.stopPropagation()
        const current = confirmation
        setConfirmation(undefined)
        current.resolve(false)
        return
      }
      if (accountDrawerOpen) {
        event.stopPropagation()
        setAccountDrawerOpen(false)
      }
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.removeEventListener('keydown', onKeyDown, true)
    }
  }, [confirmation, accountDrawerOpen])
  const railRef = useRef<HTMLElement | null>(null)
  const mainRef = useRef<HTMLElement | null>(null)
  const overlayTrigger = useRef<HTMLElement | null>(null)
  const overlayOpen = confirmation !== undefined || accountDrawerOpen
  // While an overlay is open its backdrop masks the shell: the rail and the main
  // column leave the accessibility tree and the tab order together, so focus
  // cannot reach masked content. Closing hands focus back to the control that
  // opened the overlay, once the shell is interactive again (a programmatic
  // focus is dropped while `inert` is still set).
  useEffect(() => {
    for (const element of [railRef.current, mainRef.current]) {
      if (element === null) continue
      element.inert = overlayOpen
      if (overlayOpen) element.setAttribute('aria-hidden', 'true')
      else element.removeAttribute('aria-hidden')
    }
    if (overlayOpen) {
      const active = document.activeElement
      overlayTrigger.current = active instanceof HTMLElement && active !== document.body ? active : null
      return
    }
    const trigger = overlayTrigger.current
    overlayTrigger.current = null
    trigger?.focus()
  }, [overlayOpen])
  // Focus enters the overlay that just opened: the confirmation dialog's first
  // control, or the account drawer's close button.
  useEffect(() => {
    if (confirmation !== undefined) document.querySelector<HTMLButtonElement>('[aria-label="确认操作"] button')?.focus()
    else if (accountDrawerOpen) document.querySelector<HTMLButtonElement>('[aria-label="关闭账号抽屉"]')?.focus()
  }, [confirmation, accountDrawerOpen])
  const currentSessionId = useSessions(s => s.current)
  const sessionSnapshot = useSessions(s => s)
  // Native-session rows for the workbench switcher: plain strings plus the
  // human-facing label, derived from the same snapshot the sidebar reads.
  const nativeSessions = useMemo(() => ({
    ids: sessionSnapshot.ids.map(String),
    current: sessionSnapshot.current === undefined ? undefined : String(sessionSnapshot.current),
    titleOf: (sessionId: string): string => sessionSnapshot.byId[sessionId as SessionId]?.displayTitle ?? sessionId,
  }), [sessionSnapshot])
  const knowledgeBinding = useRef<
    | {
      readonly sessionId: string
      readonly projectId: string
      readonly knowledgeBaseIds: readonly string[]
    }
    | undefined
  >()
  const knowledgeSync = useRef(Promise.resolve())
  const memoryBinding = useRef<{ readonly sessionId: string; readonly projectId: string } | undefined>()
  const memorySync = useRef(Promise.resolve())
  const memoryBindingGeneration = useRef(0)
  const memoryRequest = useRef(0)
  const collectorBinding = useRef<{ readonly sessionId: string; readonly projectId: string } | undefined>()
  const collectorSync = useRef(Promise.resolve())
  const collectorBindingGeneration = useRef(0)
  const collectorRequest = useRef(0)
  const selectedKnowledgeKey = [...selectedKnowledgeBaseIds].sort().join('\u0000')

  useEffect(() => {
    const previous = knowledgeBinding.current
    const sessionId = currentSessionId === undefined ? undefined : String(currentSessionId)
    const sessionChanged = previous !== undefined && previous.sessionId !== sessionId
    const next =
      sessionChanged || sessionId === undefined || projectId === undefined || selectedKnowledgeBaseIds.size === 0
        ? undefined
        : {
          sessionId,
          projectId,
          knowledgeBaseIds: [...selectedKnowledgeBaseIds],
        }
    knowledgeBinding.current = next
    if (sessionChanged) {
      setSelectedKnowledgeBaseIds(new Set())
      setKnowledgeSearch(undefined)
      setKnowledgeBoundCount(0)
    }
    knowledgeSync.current = knowledgeSync.current
      .then(async () => {
        if (previous !== undefined) {
          const cleared = await remote.teamSkills.clearKnowledgeSelection(previous.sessionId)
          if (!cleared.ok) throw new Error(cleared.error.message)
        }
        if (next === undefined || knowledgeBinding.current !== next) {
          if (next === undefined && knowledgeBinding.current === undefined) setKnowledgeBoundCount(0)
          return
        }
        const configured = await remote.teamSkills.configureKnowledgeSelection(next.sessionId, {
          projectId: next.projectId,
          knowledgeBaseIds: next.knowledgeBaseIds,
        })
        if (!configured.ok) throw new Error(configured.error.message)
        if (knowledgeBinding.current === next) {
          setMessage(undefined)
          setKnowledgeBoundCount(next.knowledgeBaseIds.length)
        }
      })
      .catch((error: unknown) => {
        if (knowledgeBinding.current === next) {
          knowledgeBinding.current = undefined
          setSelectedKnowledgeBaseIds(new Set())
          setKnowledgeSearch(undefined)
          setKnowledgeBoundCount(0)
          setMessage(remoteFailureMessage(error))
        }
      })
  }, [currentSessionId, projectId, remote, selectedKnowledgeKey])

  useEffect(() => {
    const generation = ++memoryBindingGeneration.current
    const previous = memoryBinding.current
    const sessionId = currentSessionId === undefined ? undefined : String(currentSessionId)
    const next = sessionId === undefined || projectId === undefined ? undefined : { sessionId, projectId }
    memoryBinding.current = next
    memorySync.current = memorySync.current
      .then(async () => {
        if (previous !== undefined) {
          const cleared = await remote.teamSkills.clearProjectMemory(previous.sessionId)
          if (!cleared.ok) throw new Error(cleared.error.message)
        }
        if (generation !== memoryBindingGeneration.current || memoryBinding.current !== next || next === undefined) return
        const configured = await remote.teamSkills.configureProjectMemory(next.sessionId, next.projectId)
        if (!configured.ok) throw new Error(configured.error.message)
        if (generation === memoryBindingGeneration.current && memoryBinding.current === next) setMessage(undefined)
      })
      .catch((error: unknown) => {
        if (generation !== memoryBindingGeneration.current || memoryBinding.current !== next) return
        memoryBinding.current = undefined
        setMessage(remoteFailureMessage(error))
      })
  }, [currentSessionId, projectId, remote])

  useEffect(() => {
    const generation = ++collectorBindingGeneration.current
    const previous = collectorBinding.current
    const sessionId = currentSessionId === undefined ? undefined : String(currentSessionId)
    const next = sessionId === undefined || projectId === undefined ? undefined : { sessionId, projectId }
    collectorBinding.current = next
    collectorSync.current = collectorSync.current
      .then(async () => {
        if (previous !== undefined) {
          const cleared = await remote.teamSkills.clearCollectorProject(previous.sessionId)
          if (!cleared.ok) throw new Error(cleared.error.message)
        }
        if (generation !== collectorBindingGeneration.current || collectorBinding.current !== next || next === undefined) return
        const configured = await remote.teamSkills.configureCollectorProject(next.sessionId, next.projectId)
        if (!configured.ok) throw new Error(configured.error.message)
      })
      .catch((error: unknown) => {
        if (generation !== collectorBindingGeneration.current || collectorBinding.current !== next) return
        collectorBinding.current = undefined
        setMessage(remoteFailureMessage(error))
      })
  }, [currentSessionId, projectId, remote])

  useEffect(() => {
    setMemoryKeyword(undefined)
  }, [projectId])

  useEffect(() => {
    if (view !== 'memory' || projectId === undefined) return
    setMemories([])
    setMemoryPage(undefined)
  }, [projectId, view])

  useEffect(() => {
    if (view !== 'memory' || projectId === undefined) {
      setMemories([])
      setMemoryPage(undefined)
      setMemoryError(undefined)
      return
    }
    const requestId = ++memoryRequest.current
    setMemoryLoading(true)
    setMemoryError(undefined)
    void remote.teamSkills
      .memoryList({
        projectId,
        ...(memoryKeyword === undefined ? {} : { keyword: memoryKeyword }),
        limit: 50,
      })
      .then((result) => {
        if (requestId !== memoryRequest.current) return
        setMemoryLoading(false)
        if (!result.ok) {
          setMemoryError(result.error.message)
          setMemories([])
          setMemoryPage(undefined)
          return
        }
        if (isHostFailure(result.value) || isSignedOut(result.value)) {
          setMemoryError(isSignedOut(result.value) ? '账号已退出，请重新登录。' : hostFailureMessage(result.value))
          setMemories([])
          setMemoryPage(undefined)
          return
        }
        setMemoryPage(result.value)
        setMemories(result.value.items)
      })
      .catch((error: unknown) => {
        if (requestId !== memoryRequest.current) return
        setMemoryLoading(false)
        setMemoryError(remoteFailureMessage(error))
        setMemories([])
        setMemoryPage(undefined)
      })
  }, [memoryKeyword, memoryRefresh, projectId, remote, view])

  const loadMoreMemories = async (): Promise<void> => {
    const cursor = memoryPage?.nextCursor
    if (view !== 'memory' || projectId === undefined || cursor === undefined || cursor === null || memoryLoading) return
    const requestId = memoryRequest.current
    setMemoryLoading(true)
    try {
      const result = await remote.teamSkills.memoryList({
        projectId,
        ...(memoryKeyword === undefined ? {} : { keyword: memoryKeyword }),
        cursor,
        limit: 50,
      })
      if (requestId !== memoryRequest.current) return
      if (!result.ok) {
        setMemoryError(result.error.message)
        return
      }
      if (isHostFailure(result.value) || isSignedOut(result.value)) {
        setMemoryError(isSignedOut(result.value) ? '账号已退出，请重新登录。' : hostFailureMessage(result.value))
        return
      }
      const page = result.value
      setMemoryPage(page)
      setMemories(current => [...current, ...page.items])
    } catch (error: unknown) {
      if (requestId === memoryRequest.current) setMemoryError(remoteFailureMessage(error))
    } finally {
      if (requestId === memoryRequest.current) setMemoryLoading(false)
    }
  }

  useEffect(() => {
    if (view !== 'collector') return
    const requestId = ++collectorRequest.current
    setCollectorLoading(true)
    setCollectorError(undefined)
    void remote.teamSkills
      .collectorStatus()
      .then((result) => {
        if (requestId !== collectorRequest.current) return
        setCollectorLoading(false)
        if (!result.ok) {
          setCollectorError(result.error.message)
          setCollectorSnapshot(undefined)
          return
        }
        setCollectorSnapshot(result.value)
        setCollectorRefreshedAt(new Date().toISOString())
      })
      .catch((error: unknown) => {
        if (requestId !== collectorRequest.current) return
        setCollectorLoading(false)
        setCollectorError(remoteFailureMessage(error))
        setCollectorSnapshot(undefined)
      })
  }, [collectorTick, remote, view])

  useEffect(() => {
    if (view !== 'collector') return
    const timer = setInterval(() => {
      setCollectorTick(tick => tick + 1)
    }, 5000)
    return () => {
      clearInterval(timer)
    }
  }, [view])

  const collectorAction = async (action: 'pause' | 'resume' | 'flush' | 'clear'): Promise<void> => {
    if (collectorBusy) return
    if (action === 'clear') {
      const pending = collectorSnapshot !== undefined && collectorSnapshot.status === 'ready'
        ? collectorSnapshot.value.queueEventCount
        : undefined
      const accepted = await new Promise<boolean>((resolve) => {
        setConfirmation({
          message: `将丢弃 ${pending === undefined ? '未知条数（请先刷新状态）' : `${pending} 条`}未上报事件，并记录 manual_clear 数据缺口。`,
          confirmLabel: '确认清理',
          resolve,
        })
      })
      if (!accepted) return
    }
    setCollectorBusy(true)
    const requestId = ++collectorRequest.current
    try {
      const result = action === 'pause' ? await remote.teamSkills.pauseCollector() : action === 'resume' ? await remote.teamSkills.resumeCollector() : action === 'flush' ? await remote.teamSkills.flushCollector() : await remote.teamSkills.clearPendingCollectorData()
      if (requestId !== collectorRequest.current) return
      if (!result.ok) {
        setCollectorError(result.error.message)
        return
      }
      setCollectorSnapshot(result.value)
      setCollectorError(undefined)
    } catch (error: unknown) {
      if (requestId === collectorRequest.current) setCollectorError(remoteFailureMessage(error))
    } finally {
      if (requestId === collectorRequest.current) setCollectorBusy(false)
    }
  }

  const visibleServiceProjects = useMemo(() => {
    const projects = serviceProjects
    return projects.filter(item => organizationFilterId === undefined || item.organizationId === organizationFilterId)
  }, [serviceProjects, organizationFilterId])
  const availableProjects = useMemo(() => {
    const projects = serviceProjects
    return projects.filter(item => organizationFilterId === undefined || item.organizationId === organizationFilterId).map(projectModel)
  }, [serviceProjects, organizationFilterId])
  const project = projectId === undefined ? undefined : availableProjects.find(item => item.id === projectId)
  const visibleAssets = useMemo(() => {
    const assets = access?.assets ?? []
    const projectAssetViews = (projectAssets ?? []).map((item) => {
      const owner = serviceProjects.find(project => project.projectId === item.projectId)
      return {
        assetId: item.assetId,
        assetType: item.assetType,
        name: item.name,
        visibility: 'project' as const,
        projectId: item.projectId,
        ...(owner === undefined ? {} : { organizationId: owner.organizationId }),
      }
    })
    const unique = new Map<string, TeamSkillAsset>()
    for (const item of [...assets, ...projectAssetViews]) unique.set(`${item.assetType}:${item.assetId}:${item.projectId ?? ''}`, item)
    return [...unique.values()]
      .filter(item => item.projectId === undefined || item.projectId === projectId)
      .filter(
        item =>
          organizationFilterId === undefined ||
          item.organizationId === undefined ||
          item.organizationId === organizationFilterId,
      )
  }, [access, organizationFilterId, projectAssets, projectId])
  const showError = (next: string): void => {
    setMessage(next)
    setGate('service-error')
  }
  const showFailure = (value: HostFailure): void => {
    if (value.status === 'not-ready') {
      setMessage(`服务端未就绪：缺少 ${value.missing.join('、')}`)
      setGate('not-ready')
      return
    }
    setMessage(value.message.length > 0 ? `${value.message}（${value.code}）` : value.code)
    setGate(isForbiddenCode(value.code) ? 'forbidden' : 'service-error')
  }

  // Clears everything scoped to the signed-in account: project selection and
  // detail, knowledge binding and search, memory and collector bindings. The
  // signed-out gate must never leave account-scoped data on screen.
  const resetAccountScope = (): void => {
    projectRequest.current += 1
    knowledgeRequest.current += 1
    memoryBindingGeneration.current += 1
    memoryBinding.current = undefined
    memoryRequest.current += 1
    setMemories([])
    setMemoryPage(undefined)
    setMemoryError(undefined)
    setMemoryKeyword(undefined)
    collectorBindingGeneration.current += 1
    collectorBinding.current = undefined
    collectorRequest.current += 1
    setCollectorSnapshot(undefined)
    setCollectorError(undefined)
    setProjectAssets(undefined)
    setDetailProject(undefined)
    setKnowledgeBases([])
    setSelectedKnowledgeBaseIds(new Set())
    setKnowledgeSearch(undefined)
    setKnowledgePreview(undefined)
    setKnowledgePhase('idle')
    setKnowledgeIssue(undefined)
    setProjectDetailPhase('idle')
    setProjectDetailIssue(undefined)
  }

  const consumeAccount = async (value: TeamSkillAccountResult<TeamSkillAccountState>): Promise<void> => {
    if (isHostFailure(value)) {
      showFailure(value)
      return
    }
    if (value.status === 'signed-out') {
      resetAccountScope()
      setAccount(undefined)
      setOrganizations([])
      setAccess(undefined)
      setOrganizationFilterId(undefined)
      setProjectId(undefined)
      setGate('signed-out')
      return
    }
    setAccount(value)
    setMessage(undefined)
    if (value.mustChangePassword || value.user.mustChangePassword) {
      setGate('change-password')
      return
    }
    await loadAccessSummary(value.user.userId)
  }

  const loadAccount = async (): Promise<void> => {
    setGate('loading')
    setMessage(undefined)
    try {
      const result = await remote.teamSkills.account()
      if (!result.ok) {
        showError(result.error.message)
        return
      }
      await consumeAccount(result.value)
    } catch (error: unknown) {
      showError(remoteFailureMessage(error))
    }
  }

  const loadAccessSummary = async (userId = account?.user.userId): Promise<void> => {
    setGate('loading')
    setProjectId(undefined)
    setProjectAssets(undefined)
    setDetailProject(undefined)
    setKnowledgeBases([])
    setSelectedKnowledgeBaseIds(new Set())
    setKnowledgeSearch(undefined)
    // 项目上下文被清除后，页面级读取状态必须一并回到 idle：否则残留的 failed
    // 面板会把「无项目」伪装成「读取失败」。
    setProjectDetailPhase('idle')
    setProjectDetailIssue(undefined)
    setKnowledgePhase('idle')
    setKnowledgeIssue(undefined)
    try {
      const [projectsResult, accessResult] = await Promise.all([remote.teamSkills.projects(), remote.teamSkills.accessSummary()])
      if (!projectsResult.ok) {
        showError(projectsResult.error.message)
        return
      }
      if (isHostFailure(projectsResult.value)) {
        showFailure(projectsResult.value)
        return
      }
      if (isSignedOut(projectsResult.value)) {
        resetAccountScope()
        setGate('signed-out')
        return
      }
      if (!accessResult.ok) {
        showError(accessResult.error.message)
        return
      }
      const accessValue = accessResult.value
      if (isHostFailure(accessValue)) {
        showFailure(accessValue)
        return
      }
      if (isSignedOut(accessValue) || !isAccessSummary(accessValue)) {
        resetAccountScope()
        setGate('signed-out')
        return
      }
      const projects = projectsResult.value.filter(item => item.status === 'active')
      const nextAccess = { ...accessValue, projects }
      setAccess(nextAccess)
      setServiceProjects(projects)
      setOrganizations(accessValue.organizations)
      setOrganizationFilterId(undefined)
      setGate('ready')
      const stored = readStoredProjectId(currentStorageKey(userId))
      if (stored !== undefined && projects.some(item => item.projectId === stored)) await loadProjectDetail(stored, true, userId)
      else if (stored !== undefined) clearStoredProjectId(currentStorageKey(userId))
    } catch (error: unknown) {
      showError(remoteFailureMessage(error))
    }
  }

  const projectRequest = useRef(0)
  const knowledgeRequest = useRef(0)
  const loadProjectDetail = async (nextProjectId: string, activate: boolean, userId = account?.user.userId): Promise<void> => {
    const requestId = ++projectRequest.current
    setProjectDetailPhase('loading')
    setProjectDetailIssue(undefined)
    setKnowledgePhase('loading')
    setKnowledgeIssue(undefined)
    if (activate) {
      setProjectId(nextProjectId)
      setProjectAssets(undefined)
      setDetailProject(undefined)
      setKnowledgeBases([])
      setSelectedKnowledgeBaseIds(new Set())
      setKnowledgeSearch(undefined)
      setKnowledgePreview(undefined)
      knowledgeRequest.current += 1
    }
    // 传输层异常会以 rejection 形式逃逸（同文件 loadAccount 的既有守卫同理）：
    // 不接住的话 loading 态会永久卡住并抛未处理 rejection。
    let result: Awaited<ReturnType<typeof remote.teamSkills.project>>
    try {
      result = await remote.teamSkills.project(nextProjectId)
    } catch (error: unknown) {
      if (requestId !== projectRequest.current) return
      setProjectDetailPhase('failed')
      setProjectDetailIssue({ kind: 'service', message: remoteFailureMessage(error) })
      setKnowledgePhase('failed')
      setKnowledgeIssue({ kind: 'service', message: remoteFailureMessage(error) })
      return
    }
    if (requestId !== projectRequest.current) return
    if (!result.ok) {
      setProjectAssets(undefined)
      setKnowledgeBases([])
      setSelectedKnowledgeBaseIds(new Set())
      setKnowledgeSearch(undefined)
      setProjectDetailPhase('failed')
      setProjectDetailIssue(surfaceIssueFromCode(result.error.code, result.error.message))
      setKnowledgePhase('failed')
      setKnowledgeIssue(surfaceIssueFromCode(result.error.code, result.error.message))
      // 0.1.5 narrows `RemoteResult.error.code` to the merged `RemoteErrorCode`
      // vocabulary, which a plugin widens only by claiming its own throwing
      // codes. These two are emitted by the Team Skill service rather than
      // declared here, so the membership test is taken over the wire string:
      // the comparison is unchanged, only its static domain is widened.
      const failureCode: string = result.error.code
      if (failureCode === 'PROJECT_NOT_MEMBER' || failureCode === 'RESOURCE_NOT_FOUND') {
        clearStoredProjectId(currentStorageKey(userId))
        await loadAccessSummary(userId)
      }
      // 页面级失败只落在页面 StatePanel；showError 会翻转全局 gate 并把整个工作区
      // 视图卸载掉（RED/矩阵实测），页面状态反而无从展示。
      return
    }
    const value = result.value
    if (isHostFailure(value) || isSignedOut(value)) {
      setProjectAssets(undefined)
      if (isSignedOut(value)) {
        resetAccountScope()
        setGate('signed-out')
      } else {
        setProjectDetailPhase('failed')
        setProjectDetailIssue(surfaceIssueFromFailure(value))
        setKnowledgePhase('failed')
        setKnowledgeIssue(surfaceIssueFromFailure(value))
      }
      return
    }
    setDetailProject(projectModel(value.project))
    setProjectDetailPhase('ready')
    setProjectDetailIssue(undefined)
    if (activate) {
      setProjectAssets(value.assets)
      let knowledge: Awaited<ReturnType<typeof remote.teamSkills.knowledgeBases>>
      try {
        knowledge = await remote.teamSkills.knowledgeBases(nextProjectId)
      } catch (error: unknown) {
        if (requestId !== projectRequest.current) return
        setKnowledgePhase('failed')
        setKnowledgeIssue({ kind: 'service', message: remoteFailureMessage(error) })
        return
      }
      if (requestId !== projectRequest.current) return
      if (!knowledge.ok) {
        setKnowledgeBases([])
        setSelectedKnowledgeBaseIds(new Set())
        setKnowledgePhase('failed')
        setKnowledgeIssue(surfaceIssueFromCode(knowledge.error.code, knowledge.error.message))
        return
      }
      if (isHostFailure(knowledge.value) || isSignedOut(knowledge.value)) {
        setKnowledgeBases([])
        setSelectedKnowledgeBaseIds(new Set())
        if (isSignedOut(knowledge.value)) {
          resetAccountScope()
          setGate('signed-out')
          return
        }
        setKnowledgePhase('failed')
        setKnowledgeIssue(surfaceIssueFromFailure(knowledge.value))
        return
      }
      setKnowledgeBases(knowledge.value.filter(item => item.state === 'active' && item.searchable))
      setSelectedKnowledgeBaseIds(new Set())
      setKnowledgeSearch(undefined)
      setKnowledgePreview(undefined)
      setKnowledgePhase('ready')
      setKnowledgeIssue(undefined)
      writeStoredProjectId(currentStorageKey(userId), nextProjectId)
    }
  }

  const login = async (request: TeamSkillLoginRequest): Promise<void> => {
    if (busy) return
    setBusy(true)
    setMessage(undefined)
    setGate('loading')
    try {
      const result = await remote.teamSkills.login(request)
      if (!result.ok) {
        showError(result.error.message)
        return
      }
      await consumeAccount(result.value)
    } finally {
      setBusy(false)
    }
  }

  const changePassword = async (request: TeamSkillChangePasswordRequest): Promise<void> => {
    if (busy) return
    setBusy(true)
    setMessage(undefined)
    try {
      const result = await remote.teamSkills.changePassword(request)
      if (!result.ok) {
        setMessage(result.error.message)
        return
      }
      await consumeAccount(result.value)
    } finally {
      setBusy(false)
    }
  }

  const logout = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      await remote.teamSkills.logout()
    } finally {
      memoryBindingGeneration.current += 1
      const previousMemoryBinding = memoryBinding.current
      memoryBinding.current = undefined
      if (previousMemoryBinding !== undefined) {
        memorySync.current = memorySync.current
          .then(async () => {
            const cleared = await remote.teamSkills.clearProjectMemory(previousMemoryBinding.sessionId)
            if (!cleared.ok) throw new Error(cleared.error.message)
          })
          .catch((error: unknown) => {
            setMessage(remoteFailureMessage(error))
          })
      }
      resetAccountScope()
      clearStoredProjectId(currentStorageKey(account?.user.userId))
      setBusy(false)
      setAccount(undefined)
      setOrganizations([])
      setAccess(undefined)
      setOrganizationFilterId(undefined)
      setProjectId(undefined)
      setAccountDrawerOpen(false)
      setGate('signed-out')
      setMessage(undefined)
    }
  }

  const refreshAuthorization = async (): Promise<void> => {
    if (gate === 'signed-out' || gate === 'loading' || gate === 'change-password') return
    await loadAccount()
  }

  useEffect(() => {
    void loadAccount()
  }, [remote])
  useEffect(() => {
    const refresh = (): void => {
      if (document.visibilityState === 'visible') void refreshAuthorization()
    }
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', refresh)
    return () => {
      window.removeEventListener('focus', refresh)
      document.removeEventListener('visibilitychange', refresh)
    }
  }, [gate, remote])

  const selectProject = (nextProjectId: string, nextView: ViewId): void => {
    if (nextProjectId.length === 0) {
      projectRequest.current += 1
      knowledgeRequest.current += 1
      setProjectId(undefined)
      setProjectAssets(undefined)
      setDetailProject(undefined)
      setKnowledgeBases([])
      setSelectedKnowledgeBaseIds(new Set())
      setKnowledgeSearch(undefined)
      setKnowledgePreview(undefined)
      setKnowledgePhase('idle')
      setKnowledgeIssue(undefined)
      setProjectDetailPhase('idle')
      setProjectDetailIssue(undefined)
      clearStoredProjectId(currentStorageKey(account?.user.userId))
      setView(nextView)
      return
    }
    if (!availableProjects.some(item => item.id === nextProjectId)) return
    setView(nextView)
    setGate('ready')
    void loadProjectDetail(nextProjectId, true)
  }

  const renderNavItem = (item: NavItem, densityProbe = false): ReactNode => {
    const Icon = item.icon
    const active = view === item.id
    return (
      <button
        key={item.id}
        type="button"
        {...(densityProbe ? { 'data-density-probe': '' } : {})}
        className={active ? `${css.navItem} ${css.navItemActive}` : css.navItem}
        aria-label={item.label}
        aria-current={active ? 'page' : undefined}
        onClick={() => {
          setView(item.id)
          setMobileNavOpen(false)
        }}
      >
        <Icon size={16} />
        <span>{item.label}</span>
        <small>{item.hint}</small>
      </button>
    )
  }

  // The docked workbench borrows the frame's right edge: reserve exactly the
  // rendered surface width so the native conversation column shrinks beside
  // it instead of being covered. The surface width depends on the viewport
  // alone, so measuring it cannot feed back into the layout.
  const surfaceRef = useRef<HTMLDivElement | null>(null)
  const docked = view === 'cloud-workspaces'
  // docked 工作台进入时收窄侧栏（64px 图标栏）；退出时恢复展开。
  useEffect(() => {
    setRailCollapsed(docked)
  }, [docked])
  useEffect(() => {
    if (!docked) {
      layout.closeRightbar()
      return
    }
    // 0.1.5 replaced the pixel-width geometry call `reserveRight(px)` with a
    // presentation report: the frame owns the track width, so the overlay only
    // declares that its right panel is docked — a reserved grid track, not a
    // fullscreen cover. That removes the width measurement the old call needed.
    layout.openRightbar(true, false)
    return () => {
      layout.closeRightbar()
    }
  }, [docked, layout])

  return (
    <div
      ref={surfaceRef}
      className={docked ? `${css.surface} ${css.surfaceDocked}` : css.surface}
      data-style-surface=""
      data-theme={resolvedTheme}
      data-density={appearance.density}
      data-focus-mode={focusMode}
      data-rail-collapsed={railCollapsed ? 'true' : 'false'}
      role="dialog"
      // Docked workbench keeps the resident native session interactive
      // beside it, so the dialog stops being modal for that view.
      aria-modal={docked ? undefined : true}
      aria-label={t('platform.name')}
    >
      <div
        className={css.mobileNavScrim}
        data-mobile-nav-scrim={mobileNavOpen ? 'open' : undefined}
        aria-hidden="true"
        onClick={() => {
          setMobileNavOpen(false)
        }}
      />
      <aside
        ref={(node) => {
          railRef.current = node
          railRef2.current = node
        }}
        className={css.rail}
        aria-label="平台导航"
        data-app-rail=""
        data-mobile-nav={mobileNavOpen ? 'open' : undefined}
      >
        <div className={css.brandBlock}>
          <div className={css.brandMark} aria-hidden="true">
            <IconSparkle16 size={18} />
          </div>
          <div>
            <strong>{t('platform.name')}</strong>
            <span>AI CODING PLATFORM</span>
          </div>
          <button
            type="button"
            className={css.railToggle}
            aria-label={railCollapsed ? '展开侧栏' : '折叠侧栏'}
            title={railCollapsed ? '展开侧栏' : '折叠侧栏'}
            onClick={() => {
              setRailCollapsed(value => !value)
            }}
          >
            {railCollapsed ? <IconChevronRightOutline14 size={16} /> : <IconChevronLeftOutline14 size={16} />}
          </button>
        </div>

        {chromeVisible && gate === 'ready' && (
          <nav className={css.nav} aria-label="平台模块">
            {renderNavItem(OVERVIEW_NAV_ITEM, true)}
            {NAV_GROUPS.map(group => (
              <div key={group.id} role="group" aria-label={group.label} className={css.navGroup}>
                <span className={css.navGroupLabel} aria-hidden="true">
                  {group.label}
                </span>
                {group.items.map(item => renderNavItem(item))}
              </div>
            ))}
          </nav>
        )}

        <div className={css.railBottom}>
          {chromeVisible && gate === 'ready' && (
            <div className={css.demoNotice}>
              <span className={css.statusLive} />
              <div>
                <strong>账号已验证</strong>
                <span>服务端权限生效</span>
              </div>
            </div>
          )}
          {chromeVisible && gate === 'ready' && account !== undefined && (
            <div role="group" aria-label="账户" className={css.accountGroup}>
              <button
                type="button"
                className={css.userButton}
                aria-label={`账号与权限：${account.user.displayName}`}
                onClick={() => {
                  setAccountDrawerOpen(true)
                }}
              >
                <span className={css.avatar}>{account.user.displayName.slice(0, 1)}</span>
                <span>
                  <strong>{account.user.displayName}</strong>
                  <small>{account.user.email}</small>
                </span>
                <IconUserOutline16 size={16} />
              </button>
            </div>
          )}
        </div>
      </aside>

      <main ref={mainRef} className={css.main}>
        <header className={css.topbar} data-page-toolbar="">
          <button
            type="button"
            ref={mobileNavToggleRef}
            className={css.mobileNavToggle}
            aria-label={mobileNavOpen ? '关闭导航' : '打开导航'}
            title={mobileNavOpen ? '关闭导航' : '打开导航'}
            aria-expanded={mobileNavOpen}
            onClick={() => {
              setMobileNavOpen(value => !value)
            }}
          >
            <IconQueueOutline14 size={18} />
          </button>
          <div className={css.contextBar} role="group" aria-label="当前上下文">
            {chromeVisible && gate === 'ready' && account !== undefined && (
              <>
                <span className={css.contextItem}>
                  <small>组织</small>
                  <strong title={organizationFilterId === undefined ? '全部可见组织' : organizations.find(item => item.organizationId === organizationFilterId)?.name ?? '全部可见组织'}>{organizationFilterId === undefined ? '全部可见组织' : organizations.find(item => item.organizationId === organizationFilterId)?.name ?? '全部可见组织'}</strong>
                </span>
                <label className={`${css.contextItem} ${css.contextItemProject}`}>
                  <small>项目</small>
                  <select
                    aria-label="当前项目"
                    value={projectId ?? ''}
                    onChange={(event) => {
                      selectProject(event.target.value, view)
                    }}
                  >
                    <option value="">选择项目</option>
                    {groupProjects(serviceProjects).map(group => (
                      <optgroup key={group.organizationId} label={group.organizationName}>
                        {group.projects.map(item => (
                          <option key={item.projectId} value={item.projectId}>
                            {item.name}
                          </option>
                        ))}
                      </optgroup>
                    ))}
                  </select>
                </label>
                <span className={css.contextItem}>
                  <small>账号</small>
                  <strong>{account.user.displayName}</strong>
                </span>
                <span className={css.contextItem}>
                  <small>角色</small>
                  <strong>{roleLabel(account.user.globalRole)}</strong>
                </span>
                <span className={css.contextItem}>
                  <small>数据来源</small>
                  <strong className={css.provenanceBadge} data-provenance="fixture-only" title="当前数据来自本地联调服务（fixture），不代表生产环境。">
                    fixture-only
                  </strong>
                </span>
              </>
            )}
            {gate !== 'ready' && (
              <span className={css.contextItem}>
                <strong>{gate === 'signed-out' ? '登录' : '账号验证'}</strong>
              </span>
            )}
          </div>
          <div className={css.topbarActions}>
            {docked && (
              <button
                type="button"
                className={css.outlineButton}
                aria-pressed={focusMode === 'on'}
                onClick={() => {
                  setFocusMode(value => (value === 'on' ? 'off' : 'on'))
                }}
              >
                {focusMode === 'on' ? '退出专注模式' : '进入专注模式'}
              </button>
            )}
            <button
              type="button"
              className={css.statusCapsule}
              data-status-capsule=""
              aria-label="系统状态胶囊"
              aria-haspopup="dialog"
              aria-expanded={capsuleOpen}
              onClick={() => {
                setCapsuleOpen(value => !value)
              }}
            >
              <span className={gate === 'ready' ? css.statusLive : css.statusWarn} aria-hidden="true" />
              {gate === 'ready' ? '已连接' : gate === 'loading' ? '同步中' : '需要处理'}
            </button>
            {capsuleOpen && (
              <div className={css.topbarPopover} role="dialog" aria-label="系统状态" data-style-drawer="" data-status-capsule-popover="">
                <dl>
                  <div>
                    <dt>连接</dt>
                    <dd>{gate === 'ready' ? '服务已连接' : gate === 'loading' ? '正在同步账号与访问范围' : '需要处理：账号验证未完成'}</dd>
                  </div>
                  <div>
                    <dt>账号</dt>
                    <dd>{account?.user.displayName ?? '未登录'}</dd>
                  </div>
                  <div>
                    <dt>项目</dt>
                    <dd>{project?.name ?? '未选择'}</dd>
                  </div>
                  <div>
                    <dt>运行</dt>
                    <dd>{view === 'cloud-workspaces' ? '云工作空间会话进行中' : '当前视图无运行任务'}</dd>
                  </div>
                  <div>
                    <dt>数据来源</dt>
                    <dd>本地联调服务（fixture-only），非生产环境</dd>
                  </div>
                </dl>
              </div>
            )}
            <button
              type="button"
              className={css.iconGhost}
              aria-label="外观设置"
              title="外观设置"
              aria-haspopup="dialog"
              aria-expanded={appearanceOpen}
              onClick={() => {
                setAppearanceOpen(value => !value)
              }}
            >
              <IconSettingsOutline14 size={16} />
            </button>
            {appearanceOpen && (
              <div className={css.topbarPopover} role="dialog" aria-label="外观设置">
                <fieldset>
                  <legend>主题</legend>
                  <label>
                    <input type="radio" name="dsh-theme" checked={appearance.theme === 'light'} onChange={() => { setAppearance({ ...appearance, theme: 'light' }) }} />
                    浅色
                  </label>
                  <label>
                    <input type="radio" name="dsh-theme" checked={appearance.theme === 'dark'} onChange={() => { setAppearance({ ...appearance, theme: 'dark' }) }} />
                    深色
                  </label>
                  <label>
                    <input type="radio" name="dsh-theme" checked={appearance.theme === 'system'} onChange={() => { setAppearance({ ...appearance, theme: 'system' }) }} />
                    跟随系统
                  </label>
                </fieldset>
                <fieldset>
                  <legend>密度</legend>
                  <label>
                    <input type="radio" name="dsh-density" checked={appearance.density === 'compact'} onChange={() => { setAppearance({ ...appearance, density: 'compact' }) }} />
                    紧凑
                  </label>
                  <label>
                    <input type="radio" name="dsh-density" checked={appearance.density === 'comfortable'} onChange={() => { setAppearance({ ...appearance, density: 'comfortable' }) }} />
                    舒适
                  </label>
                </fieldset>
              </div>
            )}
            <button type="button" className={css.closeButton} aria-label={t('platform.close')} title={t('platform.close')} onClick={controller.close}>
              <IconCloseOutline16 size={16} />
            </button>
          </div>
        </header>

        {/* Unconfigured: the form is the only screen. Configured but opened from
            the failure state: the form is the override editor, with a way back. */}
        {(!settingsReady || settingsOpen) && (
          <RemoteSettingsView
            {...(settingsReady ? { onCancel: () => { setSettingsOpen(false) } } : {})}
          />
        )}
        {chromeVisible && gate === 'loading' && <StatePanel state="loading" title="正在验证账号" reason="正在从 Host 读取服务端身份和访问范围。" />}
        {chromeVisible && gate === 'signed-out' && <LoginView busy={busy} error={message} onLogin={login} />}
        {chromeVisible && gate === 'not-ready' && (
          <StatePanel
            state="not-ready"
            title="服务未就绪"
            reason={message ?? 'Host 配置缺失，无法读取服务端数据。'}
            impact="就绪之前不会展示任何项目或资产数据。"
            action={
              <button type="button" className={css.primaryButton} onClick={controller.close}>
                返回
              </button>
            }
          />
        )}
        {chromeVisible && gate === 'forbidden' && (
          <StatePanel
            state="forbidden"
            title="无权访问"
            reason={message ?? '服务端拒绝了当前账号的读取请求。'}
            impact="权限由服务端授予；重新发起同一请求不会改变结果。"
            action={
              <button type="button" className={css.outlineButton} onClick={() =>{  setPermissionHintOpen(open => !open) }}>
                查看权限说明
              </button>
            }
          >
            {permissionHintOpen && (
              <p className={css.stateImpact}>
                访问范围由组织成员关系与项目成员关系决定；请联系管理员在后台为你添加对应成员关系。
              </p>
            )}
          </StatePanel>
        )}
        {chromeVisible && gate === 'service-error' && (
          <StatePanel
            state="service-error"
            title="服务暂时不可用"
            // Name the endpoint. `Failed to fetch` alone says something is
            // unreachable but not *what*, which is the difference between a report
            // an operator can act on and one they can only forward.
            reason={`${message ?? '无法读取服务端数据，请稍后重试。'}（当前服务地址：${resolveBrowserSettings()?.apiBaseUrl ?? '未配置'}）`}
            action={
              <>
                <button type="button" className={css.primaryButton} onClick={() => void loadAccount()}>
                  <IconRefreshOutline16 size={16} />
                  重新加载
                </button>
                {/* The escape hatch: a configured-but-unreachable endpoint has to
                    be correctable from the browser that is hitting it. */}
                <button type="button" onClick={() => { setSettingsOpen(true) }}>服务设置</button>
              </>
            }
          />
        )}
        {chromeVisible && gate === 'change-password' && <ChangePasswordView busy={busy} error={message} onSubmit={changePassword} />}
        {chromeVisible && gate === 'ready' && message !== undefined && (
          <div className={css.surfaceNotice} role="alert">
            {message}
          </div>
        )}
        {chromeVisible && gate === 'ready' && access !== undefined && (
          <div className={css.content} data-page-content="">
            {/* Page transition: opacity + 6px rise; the key remount matches the
                existing per-view conditional unmount, so no state survives that
                did not survive before. */}
            <div key={view} className={css.viewEnter}>
              {view === 'overview' && (
                <AssetOverviewView
                  project={project}
                  assets={visibleAssets}
                  remote={remote}
                  onOpenProject={() => {
                    setView('projects')
                  }}
                  onOpenWorkspace={() => {
                    setView('cloud-workspaces')
                  }}
                  onSelectProject={() => {
                    document.querySelector<HTMLSelectElement>('select[aria-label="当前项目"]')?.focus()
                  }}
                  onAuthorizationFailure={() => void refreshAuthorization()}
                />
              )}
              {view === 'projects' && (
                <ProjectsView
                  project={detailProject ?? project}
                  projects={availableProjects}
                  phase={projectDetailPhase}
                  issue={projectDetailIssue}
                  onRetry={() => {
                    if (projectId !== undefined) void loadProjectDetail(projectId, true)
                  }}
                  onProjectChange={(projectId) => {
                    void loadProjectDetail(projectId, false)
                  }}
                />
              )}
              {view === 'skills' && (
                <TeamSkillsView
                  remote={remote}
                  useWorkspaces={useWorkspaces}
                  {...(project === undefined ? {} : { projectId: project.id })}
                  projects={visibleServiceProjects}
                  onProjectSelect={(projectId) => {
                    selectProject(projectId, 'skills')
                  }}
                  environment={LOCAL_ENVIRONMENT}
                  onAuthorizationFailure={() => void refreshAuthorization()}
                />
              )}
              {view === 'cloud-workspaces' && (
                <CloudWorkspacesView
                  remote={remote}
                  useWorkspaces={useWorkspaces}
                  {...(project === undefined ? {} : { projectId: project.id })}
                  projects={visibleServiceProjects}
                  {...(currentSessionId === undefined ? {} : { sessionId: currentSessionId })}
                  nativeSessions={nativeSessions}
                  openSession={(sessionId) => { openSession(sessionId as SessionId) }}
                  startSession={startSession}
                  {...(account === undefined ? {} : { accountId: account.user.userId })}
                  onProjectSelect={(projectId) => {
                    selectProject(projectId, 'cloud-workspaces')
                  }}
                  onAuthorizationFailure={() => void refreshAuthorization()}
                />
              )}
              {view === 'knowledge' && (
                <KnowledgeView
                  projectId={projectId}
                  knowledgeBases={knowledgeBases}
                  phase={knowledgePhase}
                  issue={knowledgeIssue}
                  onRetry={() => {
                    if (projectId !== undefined) void loadProjectDetail(projectId, true)
                  }}
                  selectedIds={selectedKnowledgeBaseIds}
                  boundCount={knowledgeBoundCount}
                  onSelectionChange={setSelectedKnowledgeBaseIds}
                  onClearSelection={() => {
                    setSelectedKnowledgeBaseIds(new Set())
                  }}
                  search={knowledgeSearch}
                  preview={knowledgePreview}
                  onSearch={async (query) => {
                    if (projectId === undefined || selectedKnowledgeBaseIds.size === 0) return
                    const request = ++knowledgeRequest.current
                    const result = await remote.teamSkills.knowledgeSearch({
                      projectId,
                      knowledgeBaseIds: [...selectedKnowledgeBaseIds],
                      query,
                    })
                    if (request !== knowledgeRequest.current) return
                    if (!result.ok) {
                      setMessage(result.error.message)
                      return
                    }
                    if (isHostFailure(result.value) || isSignedOut(result.value)) {
                      setMessage(isSignedOut(result.value) ? '账号已退出，请重新登录。' : hostFailureMessage(result.value))
                      return
                    }
                    setKnowledgeSearch(result.value.response)
                  }}
                  onPreview={async (knowledgeBaseId, documentId) => {
                    const result = await remote.teamSkills.knowledgePreview(knowledgeBaseId, documentId)
                    if (!result.ok) {
                      setMessage(result.error.message)
                      return
                    }
                    if (isHostFailure(result.value) || isSignedOut(result.value)) {
                      setMessage(isSignedOut(result.value) ? '账号已退出，请重新登录。' : hostFailureMessage(result.value))
                      return
                    }
                    setKnowledgePreview(result.value)
                  }}
                />
              )}
              {view === 'memory' && (
                <MemoryView
                  projectId={projectId}
                  memories={memories}
                  page={memoryPage}
                  loading={memoryLoading}
                  error={memoryError}
                  remote={remote}
                  keyword={memoryKeyword}
                  onSearch={(keyword) => {
                    setMemoryKeyword(keyword.length === 0 ? undefined : keyword)
                    setMemoryRefresh(value => value + 1)
                  }}
                  onLoadMore={() => void loadMoreMemories()}
                  onRefresh={() => {
                    setMemoryRefresh(value => value + 1)
                  }}
                  onConfirm={(message, confirmLabel) =>
                    new Promise<boolean>((resolve) => {
                      setConfirmation({ message, confirmLabel: confirmLabel ?? '确认', resolve })
                    })
                  }
                />
              )}
              {view === 'collector' && (
                <CollectorView
                  projectId={projectId}
                  snapshot={collectorSnapshot}
                  loading={collectorLoading}
                  error={collectorError}
                  busy={collectorBusy}
                  refreshedAt={collectorRefreshedAt}
                  onRefresh={() => {
                    setCollectorTick(tick => tick + 1)
                  }}
                  onAction={(action) => {
                    void collectorAction(action)
                  }}
                />
              )}
              {view === 'agent-config' && (
                <AgentConfigView
                  remote={remote}
                  {...(project === undefined ? {} : { projectId: project.id })}
                  projects={visibleServiceProjects}
                  onProjectSelect={(selectedProjectId) => {
                    selectProject(selectedProjectId, 'agent-config')
                  }}
                  {...(account === undefined ? {} : { accountId: account.user.userId })}
                  onAuthorizationFailure={() => void refreshAuthorization()}
                />
              )}
            </div>
          </div>
        )}
      </main>
      {accountDrawerOpen && account !== undefined && (
        <AccountDrawer
          account={account}
          organizations={organizations}
          access={access}
          selectedOrganizationId={organizationFilterId}
          onClose={() => {
            setAccountDrawerOpen(false)
            document.querySelector<HTMLButtonElement>('[aria-label^="账号与权限"]')?.focus()
          }}
          onOrganizationChange={(next) => {
            projectRequest.current += 1
            knowledgeRequest.current += 1
            setOrganizationFilterId(next.length === 0 ? undefined : next)
            setProjectId(undefined)
            setProjectAssets(undefined)
            setDetailProject(undefined)
            setKnowledgeBases([])
            setSelectedKnowledgeBaseIds(new Set())
            setKnowledgeSearch(undefined)
            setKnowledgePreview(undefined)
            setView('overview')
          }}
          onRefresh={() => void refreshAuthorization()}
          onLogout={() => void logout()}
        />
      )}
      {confirmation !== undefined && (
        <div className={css.drawerBackdrop} role="presentation">
          <section className={css.accountDrawer} role="dialog" aria-modal="true" aria-label="确认操作">
            <h2>确认操作</h2>
            <p>{confirmation.message}</p>
            <div className={css.memoryActions}>
              <button
                type="button"
                className={css.outlineButton}
                onClick={() => {
                  const current = confirmation
                  setConfirmation(undefined)
                  current.resolve(false)
                }}
              >
                取消
              </button>
              <button
                type="button"
                className={css.primaryButton}
                onClick={() => {
                  const current = confirmation
                  setConfirmation(undefined)
                  current.resolve(true)
                }}
              >
                {confirmation.confirmLabel}
              </button>
            </div>
          </section>
        </div>
      )}
    </div>
  )
}

type AccountGate = 'loading' | 'signed-out' | 'not-ready' | 'forbidden' | 'service-error' | 'change-password' | 'ready'
type AuthenticatedAccount = Extract<TeamSkillAccountState, { readonly status: 'authenticated' }>
type HostFailure =
  | { readonly status: 'not-ready'; readonly missing: readonly string[] }
  | { readonly status: 'failed'; readonly code: string; readonly message: string }

/** Read lifecycle of one page-scoped server fetch, rendered by StatePanel. */
type DetailPhase = 'idle' | 'loading' | 'ready' | 'failed'
type KnowledgePhase = 'idle' | 'loading' | 'ready' | 'failed'

/** Why a page-scoped read failed; `kind` selects the StatePanel state. */
interface SurfaceIssue {
  readonly kind: 'forbidden' | 'service'
  readonly message: string
}

/** Surface a failed page-scoped read: permission denials get their own state. */
function surfaceIssueFromCode(code: string, message: string): SurfaceIssue {
  return { kind: isForbiddenCode(code) ? 'forbidden' : 'service', message: message.length > 0 ? `${message}（${code}）` : code }
}

function surfaceIssueFromFailure(value: HostFailure): SurfaceIssue {
  if (value.status === 'not-ready') return { kind: 'service', message: `服务端未就绪：缺少 ${value.missing.join('、')}` }
  return surfaceIssueFromCode(value.code, value.message)
}

// Only permission denials are forbidden; UNAUTHORIZED/TOKEN_* are session
// failures recovered by reloading the account, not by reading scope help.
function isForbiddenCode(code: string): boolean {
  return code.includes('FORBIDDEN')
}

function LoginView({
  busy,
  error,
  onLogin,
}: {
  busy: boolean
  error: string | undefined
  onLogin: (request: TeamSkillLoginRequest) => Promise<void>
}) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  return (
    <div className={css.loginPage}>
      <div className={css.loginAccent}>
        <IconSparkle16 size={20} />
      </div>
      <p className={css.kicker}>DSH / AI CODING PLATFORM</p>
      <h1>登录你的编程协作台</h1>
      <p>登录后查看权限范围内的项目与团队资产。</p>
      <form
        className={css.loginForm}
        onSubmit={(event) => {
          event.preventDefault()
          void onLogin({ username: username.trim(), password })
        }}
      >
        <label>
          用户名或邮箱
          <input
            type="text"
            inputMode="text"
            autoComplete="username"
            value={username}
            onChange={(event) => {
              setUsername(event.target.value)
            }}
            required
          />
        </label>
        <label>
          访问密码
          <input
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => {
              setPassword(event.target.value)
            }}
            required
          />
        </label>
        {error !== undefined && (
          <span className={css.formError} role="alert">
            {error}
          </span>
        )}
        <button type="submit" className={css.primaryButton} disabled={busy || username.trim().length === 0 || password.length === 0}>
          <IconSparkle16 size={16} />
          {busy ? '正在登录…' : '登录'}
        </button>
      </form>
      <span className={css.formHint}>凭据由服务端用户服务验证，访问令牌由 DSH Host 管理。</span>
    </div>
  )
}

function ChangePasswordView({
  busy,
  error,
  onSubmit,
}: {
  busy: boolean
  error: string | undefined
  onSubmit: (request: TeamSkillChangePasswordRequest) => Promise<void>
}) {
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const mismatch = confirmation.length > 0 && newPassword !== confirmation
  return (
    <div className={css.loginPage}>
      <div className={css.loginAccent}>
        <IconSettingsOutline14 size={20} />
      </div>
      <p className={css.kicker}>DSH / 首次登录</p>
      <h1>请先修改密码</h1>
      <p>初始密码只能使用一次。修改成功后才能进入协作台。</p>
      <form
        className={css.loginForm}
        onSubmit={(event) => {
          event.preventDefault()
          if (mismatch) return
          void onSubmit({ currentPassword, newPassword })
        }}
      >
        <label>
          当前密码
          <input
            type="password"
            autoComplete="current-password"
            value={currentPassword}
            onChange={(event) => {
              setCurrentPassword(event.target.value)
            }}
            required
          />
        </label>
        <label>
          新密码
          <input
            type="password"
            autoComplete="new-password"
            value={newPassword}
            onChange={(event) => {
              setNewPassword(event.target.value)
            }}
            required
          />
        </label>
        <label>
          确认新密码
          <input
            type="password"
            autoComplete="new-password"
            value={confirmation}
            onChange={(event) => {
              setConfirmation(event.target.value)
            }}
            required
          />
        </label>
        {mismatch && (
          <span className={css.formError} role="alert">
            两次输入的新密码不一致
          </span>
        )}
        {error !== undefined && (
          <span className={css.formError} role="alert">
            {error}
          </span>
        )}
        <button type="submit" className={css.primaryButton} disabled={busy || mismatch || newPassword.length === 0}>
          <IconSettingsOutline14 size={16} />
          {busy ? '正在保存…' : '保存新密码'}
        </button>
      </form>
    </div>
  )
}

const WORKSPACE_STATUS_LABELS: Record<string, string> = {
  creating: '创建中',
  provisioning: '创建中',
  ready: '就绪',
  degraded: '降级',
  busy: '忙',
  stopped: '已停止',
  archived: '已归档',
  failed: '失败',
  deleting: '删除中',
  unknown: '未知',
}

const RUN_STATUS_LABELS: Record<string, string> = {
  queued: '排队中',
  running: '运行中',
  succeeded: '已成功',
  failed: '失败',
  cancelled: '已取消',
  awaiting_approval: '待审批',
}

/** Overview of the current project only: name, status, workspace, default
 * agent, asset readiness and the latest run. Workspace facts come from the
 * cloudWorkspaces Remote; failures render as a state panel, never as fake
 * values. */
function AssetOverviewView({
  project,
  assets,
  remote,
  onOpenProject,
  onOpenWorkspace,
  onSelectProject,
  onAuthorizationFailure,
}: {
  project: Project | undefined
  assets: readonly TeamSkillAsset[]
  remote: PlatformRemote
  onOpenProject: () => void
  onOpenWorkspace: () => void
  onSelectProject: () => void
  onAuthorizationFailure: () => void
}) {
  const [workspaceState, setWorkspaceState] = useState<
    | { readonly stage: 'loading' }
    | { readonly stage: 'ready'; readonly workspaceStatus: string | null; readonly defaultAgent: string | null; readonly latestRun: string | null }
    | { readonly stage: 'failed'; readonly message: string }
  >({ stage: 'loading' })
  const [reloadTick, setReloadTick] = useState(0)
  const requestRef = useRef(0)
  // Keep the callback out of the effect deps: the parent passes a fresh arrow
  // each render, and the query must run once per project, not once per render.
  const authorizationFailureRef = useRef(onAuthorizationFailure)
  authorizationFailureRef.current = onAuthorizationFailure

  useEffect(() => {
    if (project === undefined) return
    const requestId = ++requestRef.current
    setWorkspaceState({ stage: 'loading' })
    void (async () => {
      const workspaces = await remote.cloudWorkspaces.workspaces(project.id)
      if (requestId !== requestRef.current) return
      if (!workspaces.ok) {
        setWorkspaceState({ stage: 'failed', message: workspaces.error.message })
        return
      }
      if (isSignedOut(workspaces.value)) {
        authorizationFailureRef.current()
        return
      }
      if (isHostFailure(workspaces.value)) {
        setWorkspaceState({ stage: 'failed', message: hostFailureMessage(workspaces.value) })
        return
      }
      const value = workspaces.value.value
      const workspace = value[0]
      let workspaceStatus: string | null = null
      let latestRun: string | null = null
      if (workspace !== undefined) {
        workspaceStatus = WORKSPACE_STATUS_LABELS[workspace.status] ?? workspace.status
        const runs = await remote.cloudWorkspaces.workspaceRuns(workspace.workspaceId)
        if (requestId !== requestRef.current) return
        if (runs.ok && runs.value.status === 'ready') {
          const run = runs.value.value[0]
          latestRun = run === undefined ? null : `${run.runId} · ${RUN_STATUS_LABELS[run.status] ?? run.status}`
        }
      }
      const profiles = await remote.cloudWorkspaces.agentProfiles(project.id)
      if (requestId !== requestRef.current) return
      if (!profiles.ok) {
        setWorkspaceState({ stage: 'failed', message: profiles.error.message })
        return
      }
      if (isSignedOut(profiles.value)) {
        authorizationFailureRef.current()
        return
      }
      if (isHostFailure(profiles.value)) {
        setWorkspaceState({ stage: 'failed', message: hostFailureMessage(profiles.value) })
        return
      }
      const defaultProfile = profiles.value.value.find(item => item.default) ?? profiles.value.value[0]
      setWorkspaceState({
        stage: 'ready',
        workspaceStatus,
        defaultAgent: defaultProfile?.name ?? null,
        latestRun,
      })
    })().catch((error: unknown) => {
      if (requestId === requestRef.current) setWorkspaceState({ stage: 'failed', message: remoteFailureMessage(error) })
    })
  }, [project, remote, reloadTick])

  const readiness = new Map<TeamSkillAsset['assetType'], number>()
  for (const asset of assets) {
    if (asset.assetType !== 'project') readiness.set(asset.assetType, (readiness.get(asset.assetType) ?? 0) + 1)
  }
  return (
    <div className={css.page}>
      <PageIntro eyebrow="总览" title="从权限范围内的资产开始协作" description="首屏只显示当前项目摘要；准备、工作与复盘入口按任务分组。" />
      <section
        className={css.panel}
        role="region"
        aria-label="当前项目概览"
        data-state={project === undefined ? 'no-project' : workspaceState.stage === 'failed' ? 'service-error' : 'ready'}
      >
        {project === undefined ? (
          <StatePanel
            state="no-project"
            title="尚未选择项目"
            reason="选择一个项目后才能查看项目摘要并继续协作。"
            action={
              <button type="button" className={css.primaryButton} onClick={onSelectProject}>
                选择项目
              </button>
            }
          />
        ) : workspaceState.stage === 'failed' ? (
          <StatePanel
            state="service-error"
            title="服务暂时不可用"
            reason={workspaceState.message}
            action={
              <button
                type="button"
                className={css.primaryButton}
                onClick={() => {
                  setReloadTick(tick => tick + 1)
                }}
              >
                <IconRefreshOutline16 size={16} />
                重新加载
              </button>
            }
          />
        ) : (
          <>
            <div className={css.projectDetailHead}>
              <div className={css.projectIcon}>
                <IconFolderOpenOutline16 size={20} />
              </div>
              <div>
                <h2>{project.name}</h2>
                <p>{project.organizationName}</p>
              </div>
              <span className={css.stateTag}>
                <span className={css.statusLive} />
                {projectStatusLabel(project.status)}
              </span>
            </div>
            <dl className={css.projectFacts}>
              <div>
                <dt>Workspace 状态</dt>
                <dd>
                  {workspaceState.stage === 'loading'
                    ? '读取中…'
                    : (workspaceState.workspaceStatus ?? '未创建')}
                </dd>
              </div>
              <div>
                <dt>默认 Agent</dt>
                <dd>{workspaceState.stage === 'loading' ? '读取中…' : (workspaceState.defaultAgent ?? '未配置')}</dd>
              </div>
              <div>
                <dt>最近一次 Run</dt>
                <dd>{workspaceState.stage === 'loading' ? '读取中…' : (workspaceState.latestRun ?? '暂无')}</dd>
              </div>
              <div>
                <dt>资产准备度</dt>
                <dd>
                  Skill {readiness.get('skill') ?? 0} · 知识库 {readiness.get('knowledge') ?? 0} · 记忆 {readiness.get('memory') ?? 0}
                </dd>
              </div>
            </dl>
            <div className={css.overviewCards}>
              <button type="button" className={css.overviewCard} onClick={onOpenProject}>
                <strong>进入项目</strong>
                <small>查看项目详情与授权资产</small>
              </button>
              <button type="button" className={css.overviewCard} onClick={onOpenWorkspace}>
                <strong>打开工作空间</strong>
                <small>在云工作空间中继续工程任务</small>
              </button>
            </div>
          </>
        )}
      </section>
    </div>
  )
}

function StatePanel({
  state,
  title,
  reason,
  impact,
  action,
  children,
}: {
  state: string
  title: string
  reason: string
  impact?: string
  action?: ReactNode
  children?: ReactNode
}) {
  return (
    <section className={css.statePanel} data-state={state} role="status">
      <IconInspectOutline12 size={20} />
      <h1>{title}</h1>
      <p>{reason}</p>
      {impact !== undefined && <p className={css.stateImpact}>{impact}</p>}
      {children}
      {action}
    </section>
  )
}

function AccountDrawer({
  account,
  organizations,
  access,
  selectedOrganizationId,
  onClose,
  onOrganizationChange,
  onRefresh,
  onLogout,
}: {
  account: AuthenticatedAccount
  organizations: readonly TeamSkillOrganization[]
  access: TeamSkillAccessSummary | undefined
  selectedOrganizationId: string | undefined
  onClose: () => void
  onOrganizationChange: (organizationId: string) => void
  onRefresh: () => void
  onLogout: () => void
}) {
  const manageableProjects = (access?.projects ?? []).filter(item => access?.management.projectIds.includes(item.projectId))
  return (
    <div className={css.drawerBackdrop} role="presentation">
      <aside className={css.accountDrawer} role="dialog" aria-modal="true" aria-label="账号与访问范围">
        <div className={css.drawerHeader}>
          <div>
            <span className={css.eyebrow}>账号与访问范围</span>
            <h2>{account.user.displayName}</h2>
          </div>
          <button type="button" className={css.closeButton} aria-label="关闭账号抽屉" onClick={onClose}>
            <IconCloseOutline16 size={16} />
          </button>
        </div>
        <p className={css.drawerEmail}>{account.user.email}</p>
        <dl className={css.accountFacts}>
          <div>
            <dt>账号状态</dt>
            <dd>{account.user.status === 'active' ? '正常' : '已停用'}</dd>
          </div>
          <div>
            <dt>全局角色</dt>
            <dd>{roleLabel(account.user.globalRole)}</dd>
          </div>
        </dl>
        <section aria-label="组织作用域" className={css.drawerScope}>
          <h3>组织作用域</h3>
          <ul className={css.scopeList}>
            {account.memberships.map(item => (
              <li key={item.organizationId}>
                <strong>{item.organizationName}</strong>
                <small>
                  {item.status === 'active' ? '成员' : '已停用'}
                  {access?.management.organizationIds.includes(item.organizationId) ? ' · 可管理' : ''}
                </small>
              </li>
            ))}
            {account.memberships.length === 0 && <li>服务未提供组织成员关系。</li>}
          </ul>
        </section>
        <dl className={css.accountFacts}>
          <div>
            <dt>可管理组织</dt>
            <dd>{access === undefined ? '服务未提供' : `${access.management.organizationIds.length} 个`}</dd>
          </div>
          <div>
            <dt>可管理项目</dt>
            <dd>{access === undefined ? '服务未提供' : `${access.management.projectIds.length} 个`}</dd>
          </div>
        </dl>
        <section aria-label="项目作用域" className={css.drawerScope}>
          <h3>项目作用域</h3>
          <ul className={css.scopeList}>
            {manageableProjects.map(item => (
              <li key={item.projectId}>
                <strong>{item.name}</strong>
                <small>可管理 · {item.organizationName}</small>
              </li>
            ))}
            {manageableProjects.length === 0 && <li>当前账号没有可管理项目；可见项目以顶栏项目选择器为准。</li>}
          </ul>
        </section>
        <p className={css.drawerCleanupNote}>退出登录将清理当前账号上下文：原生会话绑定、知识库与记忆选择、采集项目绑定和待确认操作全部失效。</p>
        <label className={css.drawerField}>
          组织筛选
          <select
            aria-label="组织筛选"
            value={selectedOrganizationId ?? ''}
            onChange={(event) => {
              onOrganizationChange(event.target.value)
            }}
          >
            <option value="">全部可见组织</option>
            {organizations.map(item => (
              <option key={item.organizationId} value={item.organizationId}>
                {item.name}
              </option>
            ))}
          </select>
        </label>
        <div className={css.drawerActions}>
          <button type="button" className={css.outlineButton} onClick={onRefresh}>
            <IconRefreshOutline16 size={16} />
            刷新访问范围
          </button>
          <button type="button" className={css.primaryButton} onClick={onLogout}>
            <IconCloseOutline16 size={16} />
            退出登录
          </button>
        </div>
      </aside>
    </div>
  )
}

function ProjectsView({
  project,
  projects,
  phase,
  issue,
  onRetry,
  onProjectChange,
}: {
  project: Project | undefined
  projects: readonly Project[]
  phase: DetailPhase
  issue: SurfaceIssue | undefined
  onRetry: () => void
  onProjectChange: (id: string) => void
}) {
  if (project === undefined)
    return (
      <div className={css.page}>
        <PageIntro eyebrow="项目" title="选择要查看的项目" description="项目是与 Skill、知识库和记忆同级的资产；详情页只读取服务端返回的项目摘要。" />
        <section className={css.panel}>
          <SectionHeading title="权限内项目" action={<span className={css.mutedLabel}>{projects.length} 个项目</span>} />
          <div className={css.projectList}>
            {projects.map(item => (
              <button
                type="button"
                key={item.id}
                className={css.projectRow}
                onClick={() => {
                  onProjectChange(item.id)
                }}
              >
                <strong>{item.name}</strong>
                <small>
                  {item.organizationName} · {projectStatusLabel(item.status)}
                </small>
                <span>打开详情</span>
              </button>
            ))}
          </div>
          {projects.length === 0 && (
            <div className={css.empty}>
              <h2>暂无可见项目</h2>
              <p>服务端没有返回当前账号可访问的项目。</p>
            </div>
          )}
        </section>
      </div>
    )
  return (
    <div className={css.page}>
      <PageIntro eyebrow="项目" title={project.name} description="项目详情由服务端按当前账号权限返回；切换项目请使用顶栏当前项目选择器。" />
      <div className={css.projectToolbar}>
        <span className={css.toolbarMeta}>{project.organizationName}</span>
        <button type="button" className={css.outlineButton} onClick={onRetry}>
          <IconRefreshOutline16 size={16} />
          刷新
        </button>
      </div>
      {phase === 'loading' && (
        <section className={css.panel}>
          <StatePanel
            state="loading"
            title="正在读取项目详情"
            reason="项目详情、修订与成员数由服务端按当前账号权限返回，读取完成前本页不显示摘要数值。"
          />
        </section>
      )}
      {phase === 'failed' && (
        <section className={css.panel}>
          <StatePanel
            state={issue?.kind === 'forbidden' ? 'forbidden' : 'service-error'}
            title={issue?.kind === 'forbidden' ? '当前账号无权读取该项目详情' : '项目详情暂时不可用'}
            reason={issue?.message ?? ''}
            action={
              <button type="button" className={css.primaryButton} onClick={onRetry}>
                <IconRefreshOutline16 size={16} />
                重新加载
              </button>
            }
          />
        </section>
      )}
      {phase === 'ready' && (
        <section className={css.panel}>
          <div className={css.projectDetailHead}>
            <div className={css.projectIcon}>
              <IconFolderOpenOutline16 size={20} />
            </div>
            <div>
              <h2>{project.name}</h2>
              <p>{project.organizationName}</p>
            </div>
            <span className={css.stateTag}>
              <span className={css.statusLive} />
              {projectStatusLabel(project.status)}
            </span>
          </div>
          <p className={css.panelLead}>{project.description || '暂无项目描述。'}</p>
          <dl className={css.projectFacts}>
            <div>
              <dt>项目 ID</dt>
              <dd>{project.id}</dd>
            </div>
            <div>
              <dt>项目修订</dt>
              <dd>{project.revision}</dd>
            </div>
            <div>
              <dt>成员</dt>
              <dd>{project.memberCount}</dd>
            </div>
            <div>
              <dt>关联资产</dt>
              <dd>{project.assetCount}</dd>
            </div>
            <div>
              <dt>创建时间</dt>
              <dd>{formatProjectDate(project.createdAt)}</dd>
            </div>
            <div>
              <dt>更新时间</dt>
              <dd>{formatProjectDate(project.updatedAt)}</dd>
            </div>
          </dl>
          {project.assetCount === 0 && (
            <section className={css.empty} data-state="empty" role="status" aria-label="暂无关联资产">
              <IconArchiveOutline20 size={20} />
              <h2>暂无关联资产</h2>
              <p>当前项目尚未关联 Skill、知识库或记忆库。</p>
            </section>
          )}
          <div className={css.empty}>
            <IconInspectOutline12 size={20} />
            <h2>项目级操作由后台管理</h2>
            <p>插件只提供项目选择和授权资产入口，不提供创建、编辑、成员或资产关联写入。</p>
          </div>
        </section>
      )}
    </div>
  )
}

/**
 * Verdict and per-knowledge-base participation for one search.
 *
 * The verdict is rendered before the hit count so a reader never takes
 * "命中 0" for "no results" when the real story is that no base could answer.
 */
function KnowledgeSearchSummary({
  search,
}: {
  readonly search: TeamSkillKnowledgeSearchResponse
}) {
  const verdict = knowledgeSearchVerdict(search)
  return (
    <>
      <p data-verdict={verdict.kind}>
        <strong>{verdict.headline}</strong>
        {verdict.detail === '' ? '' : ` ${verdict.detail}`}
      </p>
      <ul data-knowledge-participation="">
        {knowledgeBaseSearchStates(search).map(row => (
          <li key={row.knowledgeBaseId} data-outcome={row.outcome}>
            {row.label}
            {row.reason === '' ? '' : `：${row.reason}`}
          </li>
        ))}
      </ul>
    </>
  )
}

/**
 * Grouped knowledge-base selector (§3-2).
 *
 * Groups keep the fixed 文档/FAQ/Wiki order and each row carries its index
 * state, update time and permission. A base the server marks unsearchable stays
 * visible with its reason and a disabled checkbox, and a selection the service
 * no longer permits is reported above the list rather than dropped from it.
 */
function KnowledgeSelectorGroups({
  knowledgeBases,
  selectedIds,
  onToggle,
}: {
  readonly knowledgeBases: readonly TeamSkillKnowledgeBaseSummary[]
  readonly selectedIds: Set<string>
  readonly onToggle: (id: string) => void
}) {
  const groups = knowledgeSelectorGroups(knowledgeBases, selectedIds)
  const totals = knowledgeSelectorTotals(groups)
  return (
    <>
      {totals.staleSelection > 0 && (
        <p role="alert" data-stale-selection={String(totals.staleSelection)}>
          有 {totals.staleSelection} 个已选知识库当前不可检索，本轮不会参与；请取消选择或联系管理员。
        </p>
      )}
      {groups.map(group => (
        <div key={group.key} role="group" aria-label={`${group.label}知识库`} data-group={group.key}>
          <div className={css.knowledgeGroupLabel}>
            {group.label}（已启用 {group.enabledCount}/{group.rows.length}）
          </div>
          {group.rows.map(row => (
            <label key={row.knowledgeBaseId} className={css.knowledgeRow} data-searchable={row.searchable ? 'true' : 'false'}>
              <input
                type="checkbox"
                checked={row.selected}
                disabled={!row.searchable}
                onChange={() => {
                  onToggle(row.knowledgeBaseId)
                }}
              />
              <span className={css.knowledgeCopy}>
                <strong>{row.name}</strong>
                <small>{row.description}</small>
                <em>
                  {row.knowledgeBaseId} · 更新 {row.updatedAt}
                </em>
              </span>
              <span className={row.searchable ? css.indexed : css.indexing}>
                {row.searchable ? row.indexState : row.disabledReason}
              </span>
            </label>
          ))}
        </div>
      ))}
    </>
  )
}

function KnowledgeView({
  projectId,
  knowledgeBases,
  phase,
  issue,
  onRetry,
  selectedIds,
  boundCount,
  onSelectionChange,
  onClearSelection,
  search,
  preview,
  onSearch,
  onPreview,
}: {
  projectId: string | undefined
  knowledgeBases: readonly TeamSkillKnowledgeBaseSummary[]
  phase: KnowledgePhase
  issue: SurfaceIssue | undefined
  onRetry: () => void
  selectedIds: Set<string>
  /** 服务端确认的本轮绑定数量；列表选择只是待提交状态。 */
  boundCount: number
  onSelectionChange: (value: Set<string>) => void
  onClearSelection: () => void
  search: TeamSkillKnowledgeSearchResponse | undefined
  preview: TeamSkillKnowledgePreview | undefined
  onSearch: (query: string) => Promise<void>
  onPreview: (knowledgeBaseId: string, documentId: string) => Promise<void>
}) {
  const [query, setQuery] = useState('')
  const [previewOpen, setPreviewOpen] = useState(false)
  const toggle = (id: string): void => {
    const next = new Set(selectedIds)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    onSelectionChange(next)
  }
  if (phase === 'loading') {
    return (
      <div className={css.page}>
        <PageIntro
          eyebrow="知识库"
          title="让规范在对话开始前就到位"
          description={projectId === undefined ? '请先选择 active 项目。' : '选择只绑定当前 DSH 会话；切换会话或项目会清空本轮选择。'}
        />
        <section className={css.panel}>
          <StatePanel
            state="loading"
            title="正在读取知识库"
            reason="知识库列表由服务端按当前项目与账号权限返回，读取完成前不显示列表，也不显示启用计数。"
          />
        </section>
      </div>
    )
  }
  if (phase === 'failed') {
    return (
      <div className={css.page}>
        <PageIntro
          eyebrow="知识库"
          title="让规范在对话开始前就到位"
          description={projectId === undefined ? '请先选择 active 项目。' : '选择只绑定当前 DSH 会话；切换会话或项目会清空本轮选择。'}
        />
        <section className={css.panel}>
          <StatePanel
            state={issue?.kind === 'forbidden' ? 'forbidden' : 'service-error'}
            title={issue?.kind === 'forbidden' ? '当前账号无权读取该项目知识库' : '知识库暂时不可用'}
            reason={issue?.message ?? ''}
            impact="读取失败时本页不提供任何候选，也不把列表当作空数据处理。"
            action={
              <button type="button" className={css.primaryButton} onClick={onRetry}>
                <IconRefreshOutline16 size={16} />
                重新加载
              </button>
            }
          />
        </section>
      </div>
    )
  }
  if (phase === 'idle') {
    return (
      <div className={css.page}>
        <PageIntro
          eyebrow="知识库"
          title="让规范在对话开始前就到位"
          description="请先选择 active 项目。"
        />
        <section className={css.panel}>
          <StatePanel
            state="no-project"
            title="尚未选择项目"
            reason="知识库按项目组织；选择项目后才会读取该项目的知识库列表。"
          />
        </section>
      </div>
    )
  }
  return (
    <div className={css.page}>
      <PageIntro
        eyebrow="知识库"
        title="让规范在对话开始前就到位"
        description={projectId === undefined ? '请先选择 active 项目。' : '选择只绑定当前 DSH 会话；切换会话或项目会清空本轮选择。'}
        action={
          <form
            className={css.searchBox}
            onSubmit={(event) => {
              event.preventDefault()
              void onSearch(query.trim())
            }}
          >
            <IconSearchOutline16 size={16} />
            <input
              value={query}
              onChange={(event) => {
                setQuery(event.target.value)
              }}
              placeholder="搜索知识库"
            />
            <button type="submit" aria-label="检索" disabled={projectId === undefined || boundCount === 0 || query.trim().length === 0}>
              <IconSearchOutline16 size={16} />
            </button>
          </form>
        }
      />
      <div className={css.bindingSummary} role="status" data-state={boundCount === 0 ? 'empty' : 'ready'}>
        <strong>本轮已启用 {boundCount} 个知识库</strong>
        <span>绑定只对当前原生会话生效；列表勾选是待提交选择，服务端确认后才计入已启用。</span>
        {selectedIds.size > 0 && (
          <button type="button" className={css.outlineButton} onClick={onClearSelection}>
            清除本轮选择
          </button>
        )}
        <button type="button" className={css.outlineButton} onClick={onRetry}>
          <IconRefreshOutline16 size={16} />
          刷新
        </button>
      </div>
      <div className={css.knowledgeLayout}>
        <section className={css.panel}>
          <div className={css.listHeader}>
            <span>项目知识库</span>
            <span>待提交选择 {selectedIds.size} 个</span>
          </div>
          <div className={css.knowledgeList} data-knowledge-list="">
            {/* 可搜索分组选择器（规格 §6）：按知识库类型分组，组内条目带索引状态、
                更新时间与权限；不可检索的条目保持可见并禁用勾选。 */}
            <KnowledgeSelectorGroups
              knowledgeBases={knowledgeBases}
              selectedIds={selectedIds}
              onToggle={toggle}
            />
          </div>
          {knowledgeBases.length === 0 && (
            <div className={css.empty}>
              <h2>当前项目没有可用知识库</h2>
              <p>项目映射、成员权限和外部处理状态由服务端实时确认。</p>
            </div>
          )}
        </section>
        <aside className={css.knowledgeAside} aria-label="知识库检索结果">
          <div className={css.knowledgeAsideMark}>
            <IconArchiveOutline20 size={20} />
          </div>
          <h2>检索结果</h2>
          {boundCount === 0 ? (
            <>
              <p>检索前需要至少一个已启用知识库。</p>
              <button
                type="button"
                className={css.primaryButton}
                onClick={() => {
                  document.querySelector<HTMLInputElement>('[data-knowledge-list] input[type="checkbox"]')?.focus()
                }}
              >
                选择知识库
              </button>
            </>
          ) : search === undefined ? (
            <p>已启用 {boundCount} 个知识库；提交查询后在这里查看命中结果。</p>
          ) : (
            <>
              <KnowledgeSearchSummary search={search} />
              <div className={css.contextStat}>
                <span>
                  命中<strong>{search.results.length}</strong>
                </span>
                <span>
                  知识库<strong>{search.knowledgeBases.length}</strong>
                </span>
              </div>
              <div className={css.knowledgeList}>
                {search.results.map(item => (
                  <div key={item.knowledgeId} className={css.knowledgeRow}>
                    <span className={css.knowledgeType}>引用</span>
                    <span className={css.knowledgeCopy}>
                      <strong>{item.title}</strong>
                      <small>{item.snippet}</small>
                      {/* §11.15：来源、版本与更新时间必须同时可见——只给来源无法
                          判断这条引用有多新、来自哪个版本。 */}
                      <em>
                        {item.sourceUrl} · {item.version} · 更新 {item.updatedAt}
                      </em>
                    </span>
                    <button
                      type="button"
                      className={css.outlineButton}
                      onClick={() => {
                        setPreviewOpen(true)
                        void onPreview(item.knowledgeBaseId, item.knowledgeId)
                      }}
                    >
                      预览
                    </button>
                    <span className={css.indexed}>{item.score.toFixed(2)}</span>
                  </div>
                ))}
              </div>
            </>
          )}
        </aside>
      </div>
      {previewOpen && (
        <div className={css.drawerBackdrop} role="presentation">
          <section className={css.accountDrawer} role="dialog" aria-modal="true" aria-label="知识预览">
            <div className={css.drawerHeader}>
              <div>
                <span className={css.eyebrow}>知识预览</span>
                <h2>{preview?.title ?? '正在读取预览'}</h2>
              </div>
              <button
                type="button"
                className={css.closeButton}
                aria-label="关闭预览"
                onClick={() => {
                  setPreviewOpen(false)
                }}
              >
                <IconCloseOutline16 size={16} />
              </button>
            </div>
            {preview === undefined ? (
              <p className={css.drawerEmail}>预览内容由服务端授权生成，正在读取…</p>
            ) : (
              <p className={css.drawerEmail}>预览地址由服务端短期授权；关闭抽屉不会清空检索结果。</p>
            )}
            {preview !== undefined && (
              <div className={css.drawerActions}>
                <a className={css.outlineButton} href={preview.previewUrl} target="_blank" rel="noreferrer">
                  打开受权预览
                </a>
                <button
                  type="button"
                  className={css.primaryButton}
                  onClick={() => {
                    setPreviewOpen(false)
                  }}
                >
                  关闭
                </button>
              </div>
            )}
          </section>
        </div>
      )}
    </div>
  )
}

/**
 * Verdict and rows for one on-demand recall (§3-3).
 *
 * The verdict renders before the rows so a service failure is never read as an
 * empty recall: only the `empty` verdict means the service answered and nothing
 * matched.
 */
function MemoryRecallSummary({ recall }: { readonly recall: TeamSkillMemoryRecallResponse }) {
  const verdict = memoryRecallVerdict(recall)
  return (
    <>
      <span data-verdict={verdict.kind}>
        <strong>{verdict.headline}</strong>
        {verdict.detail === '' ? '' : ` ${verdict.detail}`}
      </span>
      <ul>
        {memoryRecallRows(recall).map(row => (
          <li key={row.memoryId} data-memory-recall={row.memoryId}>
            <strong>{row.content}</strong>
            <span>
              召回原因：{row.reasonLabel} · 置信度 {row.confidence} · 更新 {row.updatedAt}
              {row.sourceRunId === null ? '' : ` · 来源运行 ${row.sourceRunId}`}
            </span>
          </li>
        ))}
      </ul>
    </>
  )
}

function MemoryView({
  projectId,
  memories,
  page,
  loading,
  error,
  remote,
  keyword,
  onSearch,
  onLoadMore,
  onRefresh,
  onConfirm,
}: {
  projectId: string | undefined
  memories: readonly TeamSkillMemory[]
  page: TeamSkillMemoryPage | undefined
  loading: boolean
  error: string | undefined
  remote: PlatformRemote
  keyword: string | undefined
  onSearch: (keyword: string) => void
  onLoadMore: () => void
  onRefresh: () => void
  onConfirm: (message: string, confirmLabel?: string) => Promise<boolean>
}) {
  const [selectedId, setSelectedId] = useState<string | undefined>()
  const [selectedRecord, setSelectedRecord] = useState<TeamSkillMemory | undefined>()
  const [editing, setEditing] = useState(false)
  const [content, setContent] = useState('')
  const [busy, setBusy] = useState(false)
  const [actionMessage, setActionMessage] = useState<string | undefined>()
  const [query, setQuery] = useState(keyword ?? '')
  const [statusFilter, setStatusFilter] = useState<'all' | 'ACTIVE'>('all')
  const detailRequest = useRef(0)
  const mutationGeneration = useRef(0)
  const selectedRecordRef = useRef<TeamSkillMemory | undefined>()
  // Recall is read on demand: it is the evidence view of what the service would
  // inject, not a second memory list, so it never loads by itself.
  const [recall, setRecall] = useState<TeamSkillMemoryRecallResponse | undefined>()
  const [recallError, setRecallError] = useState<string | undefined>()

  const runRecall = async (): Promise<void> => {
    if (projectId === undefined) return
    setRecallError(undefined)
    const result = await remote.teamSkills.memoryRecall({ projectId, query: query.trim() })
    if (!result.ok) {
      setRecallError(`${result.error.message}（${result.error.code}）`)
      return
    }
    const value = result.value
    // The recall response is the only variant carrying `items`; the rest are the
    // account-layer failure states, and each one says so rather than rendering an
    // empty recall list.
    if ('items' in value && 'contextText' in value) {
      setRecall(value)
      return
    }
    setRecallError(
      value.status === 'signed-out'
        ? '登录状态已失效，请重新登录'
        : value.status === 'not-ready'
          ? `服务端未就绪，缺少配置：${value.missing.join('、')}`
          : `${value.message}（${value.code}）`,
    )
  }

  useEffect(() => {
    mutationGeneration.current += 1
    setSelectedId(undefined)
    setSelectedRecord(undefined)
    selectedRecordRef.current = undefined
    setEditing(false)
    setContent('')
    setActionMessage(undefined)
    setQuery('')
    detailRequest.current += 1
  }, [projectId])

  const selected = selectedRecord?.memoryId === selectedId ? selectedRecord : memories.find(item => item.memoryId === selectedId)
  const open = async (memory: TeamSkillMemory): Promise<void> => {
    const requestId = ++detailRequest.current
    setSelectedId(memory.memoryId)
    setSelectedRecord(memory)
    selectedRecordRef.current = memory
    setContent(memory.content)
    setEditing(false)
    const result = await remote.teamSkills.memoryGet(memory.memoryId)
    if (requestId !== detailRequest.current) return
    if (!result.ok) {
      setActionMessage(result.error.message)
      return
    }
    if (isHostFailure(result.value) || isSignedOut(result.value)) {
      setActionMessage(isSignedOut(result.value) ? '账号已退出，请重新登录。' : hostFailureMessage(result.value))
      return
    }
    selectedRecordRef.current = result.value
    setSelectedRecord(result.value)
    setContent(result.value.content)
  }
  /** §11.16 候选确认：确认后记忆离开候选层、开始参与召回；失败如实呈现。 */
  const confirmCandidate = async (memory: TeamSkillMemory): Promise<void> => {
    if (busy) return
    setBusy(true)
    setActionMessage(undefined)
    try {
      await remote.teamSkills.memoryCandidatesConfirm(
        { memoryId: memory.memoryId, expectedRevision: memory.revision },
        crypto.randomUUID(),
      )
      setActionMessage(`已确认候选 ${memory.memoryId}，该记忆已进入项目确认层并参与召回`)
      onRefresh()
    } catch (error) {
      setActionMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  const save = async (): Promise<void> => {
    const current = selectedRecordRef.current ?? selected
    if (current === undefined || content.trim().length === 0 || busy) return
    const generation = mutationGeneration.current
    const requestedProjectId = projectId
    setBusy(true)
    setActionMessage(undefined)
    try {
      const result = await remote.teamSkills.memoryUpdate(
        {
          memoryId: current.memoryId,
          content: content.trim(),
          expectedRevision: current.revision,
        },
        crypto.randomUUID(),
      )
      if (generation !== mutationGeneration.current || requestedProjectId !== projectId) return
      const value = memoryMutationValue(result, setActionMessage)
      if (value === undefined) return
      if (value.memory !== undefined) {
        selectedRecordRef.current = value.memory
        setSelectedRecord(value.memory)
        setContent(value.memory.content)
        setSelectedId(value.memory.memoryId)
      }
      setEditing(false)
      setActionMessage(`记忆已提交，任务 ${value.jobId} 处理中。`)
      onRefresh()
    } finally {
      setBusy(false)
    }
  }
  const remove = async (record?: TeamSkillMemory): Promise<void> => {
    const current = record ?? selectedRecordRef.current ?? selected
    if (current === undefined || busy) return
    const confirmed = await onConfirm(
      `删除后该记忆将立即不再参与召回。受影响项目：${current.projectId}；服务端将提交异步清理任务，删除结果以任务状态为准。`,
      '确认删除',
    )
    if (!confirmed) return
    const generation = mutationGeneration.current
    const requestedProjectId = projectId
    setBusy(true)
    setActionMessage(undefined)
    try {
      const result = await remote.teamSkills.memoryDelete(
        { memoryId: current.memoryId, expectedRevision: current.revision },
        crypto.randomUUID(),
      )
      if (generation !== mutationGeneration.current || requestedProjectId !== projectId) return
      const value = memoryMutationValue(result, setActionMessage)
      if (value === undefined) return
      setSelectedId(undefined)
      setSelectedRecord(undefined)
      selectedRecordRef.current = undefined
      setContent('')
      setActionMessage(`记忆已删除，清理任务 ${value.jobId} 已提交。`)
      onRefresh()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={css.page}>
      <PageIntro
        eyebrow="记忆库"
        title="保留项目经验，也保留服务端边界"
        description={projectId === undefined ? '请先选择 active 项目。' : '记忆只来自当前项目的服务端列表；自动捕获始终开启，服务不可用不会阻塞编码。'}
        action={
          <div className={css.memoryActions}>
            <form
              className={css.searchBox}
              onSubmit={(event) => {
                event.preventDefault()
                onSearch(query.trim())
              }}
            >
              <IconSearchOutline16 size={16} />
              <input
                aria-label="搜索记忆"
                type="search"
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value)
                }}
                placeholder="搜索当前项目记忆"
              />
              <button type="submit" aria-label="搜索记忆">
                <IconSearchOutline16 size={16} />
              </button>
            </form>
            <label className={css.selectBox}>
              <span>状态</span>
              <select
                aria-label="记忆状态筛选"
                value={statusFilter}
                onChange={(event) => {
                  setStatusFilter(event.target.value as typeof statusFilter)
                }}
              >
                <option value="all">全部</option>
                <option value="ACTIVE">启用中</option>
              </select>
            </label>
            <button type="button" className={css.outlineButton} onClick={onRefresh} disabled={loading}>
              <IconRefreshOutline16 size={16} />
              刷新
            </button>
          </div>
        }
      />
      {actionMessage !== undefined && !editing && (
        <div className={css.surfaceNotice} role="status">
          {actionMessage}
        </div>
      )}
      {projectId === undefined && (
        <div className={css.empty}>
          <h2>需要项目上下文</h2>
          <p>选择项目后才能读取项目记忆。</p>
        </div>
      )}
      {projectId !== undefined && error !== undefined && (
        <div className={css.empty} role="alert">
          <h2>记忆服务不可用</h2>
          <p>{error}</p>
          <button type="button" className={css.primaryButton} onClick={onRefresh}>
            <IconRefreshOutline16 size={16} />
            重试
          </button>
        </div>
      )}
      {projectId !== undefined && error === undefined && (
        <div className={css.memoryLayout}>
          <section data-role="memory-recall" aria-label="记忆召回">
            <div className={css.memoryActions}>
              <button
                type="button"
                className={css.outlineButton}
                onClick={() => void runRecall()}
              >
                查看召回
              </button>
            </div>
            {recallError !== undefined && <p role="alert">无法读取召回：{recallError}</p>}
            {recall !== undefined && <MemoryRecallSummary recall={recall} />}
          </section>
          <section className={css.memoryPanel}>
            <div className={css.listHeader}>
              <span>当前项目记忆</span>
              <span>{loading ? '读取中…' : `${page?.totalEstimate ?? memories.length} 条`}</span>
            </div>
            <div className={css.memoryList}>
              {memories
                .filter(memory => statusFilter === 'all' || memory.status === statusFilter)
                .map(memory => (
                  <div key={memory.memoryId} className={selectedId === memory.memoryId ? `${css.memoryRow} ${css.memoryRowActive}` : css.memoryRow} data-memory-id={memory.memoryId}>
                    <div className={css.memoryMark}>
                      <IconGoalOutline16 size={16} />
                    </div>
                    <div className={css.memoryCopy}>
                      <div>
                        <h2>
                          {memory.content.slice(0, 60)}
                          {memory.content.length > 60 ? '…' : ''}
                        </h2>
                        <span className={css.scopeTag}>项目记忆</span>
                      </div>
                      <p>{memory.content}</p>
                      <small>
                        r{memory.revision} · 更新于 {formatMemoryDate(memory.updatedAt)}
                      </small>
                    </div>
                    {/* 治理层级，不是存储层 layer：L1 恒为存储标记，对用户没有意义；
                        候选在确认前不会参与召回，这一点必须看得见。 */}
                    <span className={css.scopeTag} data-tier={memory.tier}>{memoryTierLabel(memory.tier)}</span>
                    <div className={css.memoryRowActions}>
                      <button
                        type="button"
                        className={css.outlineButton}
                        aria-label={`查看记忆 ${memory.memoryId}`}
                        onClick={() => void open(memory)}
                      >
                        查看
                      </button>
                      <button
                        type="button"
                        className={css.outlineButton}
                        aria-label={`编辑记忆 ${memory.memoryId}`}
                        onClick={() => {
                          void open(memory).then(() => {
                            setEditing(true)
                          })
                        }}
                      >
                        编辑
                      </button>
                      {memory.tier === 'project_candidate' && (
                        <button
                          type="button"
                          className={css.outlineButton}
                          aria-label={`确认候选 ${memory.memoryId}`}
                          disabled={busy}
                          onClick={() => void confirmCandidate(memory)}
                        >
                          确认候选
                        </button>
                      )}
                      <button
                        type="button"
                        className={css.dangerButton}
                        aria-label={`删除记忆 ${memory.memoryId}`}
                        disabled={busy}
                        onClick={() => void remove(memory)}
                      >
                        删除
                      </button>
                    </div>
                  </div>
                ))}
            </div>
            {!loading && memories.length === 0 && (
              <div className={css.empty}>
                <h2>当前项目暂无记忆</h2>
                <p>完成一次编码回合后，自动捕获会提交可治理的项目经验。</p>
              </div>
            )}
            {page?.nextCursor !== null && page?.nextCursor !== undefined && (
              <button type="button" className={css.memoryFooter} onClick={onLoadMore} disabled={loading}>
                <IconQueueOutline14 size={16} />
                {loading ? '读取中…' : '加载更多记忆'}
              </button>
            )}
          </section>
          <aside className={css.memoryAside}>
            {selected === undefined ? (
              <>
                <div className={css.knowledgeAsideMark}>
                  <IconGoalOutline16 size={20} />
                </div>
                <h2>选择一条记忆</h2>
                <p>查看服务端正文和 revision，再进行受权编辑或删除。</p>
              </>
            ) : (
              <>
                <div className={css.listHeader}>
                  <span>记忆详情</span>
                  <span>{selected.memoryId}</span>
                </div>
                {editing ? (
                  <label className={css.memoryEditor}>
                    记忆正文
                    <textarea
                      aria-label="记忆正文"
                      value={content}
                      onChange={(event) => {
                        setContent(event.target.value)
                      }}
                      rows={8}
                    />
                  </label>
                ) : (
                  <p className={css.memoryDetail}>{content}</p>
                )}
                <dl className={css.projectFacts}>
                  <div>
                    <dt>项目</dt>
                    <dd>{selected.projectId}</dd>
                  </div>
                  <div>
                    <dt>来源</dt>
                    <dd>Agent 回合捕获</dd>
                  </div>
                  <div>
                    <dt>修订</dt>
                    <dd>r{selected.revision}</dd>
                  </div>
                  <div>
                    <dt>更新时间</dt>
                    <dd>{formatMemoryDate(selected.updatedAt)}</dd>
                  </div>
                  <div>
                    <dt>捕获者</dt>
                    <dd>{selected.capturedByUserId}</dd>
                  </div>
                  <div>
                    <dt>召回</dt>
                    <dd>{selected.recallCount}</dd>
                  </div>
                </dl>
                {editing ? (
                  <div
                    className={css.saveBar}
                    role="status"
                    data-state={content !== selected.content ? 'dirty' : 'clean'}
                  >
                    <span className={css.saveBarRevision}>修订 r{selected.revision}</span>
                    <span>{content !== selected.content ? '有未保存修改' : '无修改'}</span>
                    {actionMessage !== undefined && <span className={css.saveBarResult}>{actionMessage}</span>}
                    <div className={css.reviewActions}>
                      <button type="button" className={css.primaryButton} disabled={busy || content.trim().length === 0} onClick={() => void save()}>
                        <IconSettingsOutline14 size={16} />
                        保存记忆
                      </button>
                      <button
                        type="button"
                        className={css.outlineButton}
                        onClick={() => {
                          setEditing(false)
                          setContent(selected.content)
                          setActionMessage(undefined)
                        }}
                      >
                        取消
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className={css.reviewActions}>
                    <button
                      type="button"
                      className={css.outlineButton}
                      onClick={() => {
                        setEditing(true)
                      }}
                    >
                      编辑记忆
                    </button>
                    <button type="button" className={css.dangerButton} onClick={() => void remove()} disabled={busy}>
                      删除记忆
                    </button>
                  </div>
                )}
              </>
            )}
          </aside>
        </div>
      )}
    </div>
  )
}

const COLLECTOR_MODE_LABELS: Record<CollectorStatus['mode'], string> = {
  active: '采集中',
  paused: '已暂停',
  'not-ready': '配置未就绪',
  'signed-out': '账号未登录',
  'authorization-revoked': '项目授权已撤销',
  'storage-error': '本地存储异常',
  failed: '上报失败',
}

function formatQueueBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${bytes} B`
}

function CollectorView({
  projectId,
  snapshot,
  loading,
  error,
  busy,
  refreshedAt,
  onRefresh,
  onAction,
}: {
  projectId: string | undefined
  snapshot: CollectorSnapshot | undefined
  loading: boolean
  error: string | undefined
  busy: boolean
  refreshedAt: string | undefined
  onRefresh: () => void
  onAction: (action: 'pause' | 'resume' | 'flush' | 'clear') => void
}) {
  const status = snapshot !== undefined && snapshot.status === 'ready' ? snapshot.value : undefined
  const modeLabel = status === undefined ? '未知' : COLLECTOR_MODE_LABELS[status.mode]
  return (
    <div className={css.page}>
      <PageIntro
        eyebrow="数据采集"
        title="AI Coding 可观测"
        description="采集设置仅上报白名单结构化事件；提示词、回复、命令与文件路径不进入上报。服务端负责校验、去重和聚合。"
      />
      {error !== undefined && (
        <div className={css.formError} role="alert">
          {error}
        </div>
      )}
      {snapshot !== undefined && snapshot.status === 'not-ready' && (
        <div className={css.panel} role="status">
          采集配置未就绪：缺少 {snapshot.missing.join('、')}。
        </div>
      )}
      {snapshot !== undefined && snapshot.status === 'failed' && (
        <div className={css.panel} role="alert">
          采集操作失败：{snapshot.message}
        </div>
      )}
      {snapshot === undefined && (loading ? <div className={css.panel} data-state="loading">正在读取采集状态…</div> : null)}
      {status !== undefined && (
        <>
          <section
            className={css.panel}
            role="region"
            aria-label="采集状态摘要"
            data-state={loading ? 'loading' : 'ready'}
            aria-busy={loading}
          >
            <div className={css.eventList}>
              <div className={css.eventRow}>
                <span>连接状态</span>
                <strong>{modeLabel}</strong>
                <p>
                  授权状态：
                  {status.authorizationState === 'authorized' ? '已授权' : status.authorizationState === 'revoked' ? '已撤销' : '未知'}
                  {status.projectId === null ? ' · 未绑定项目' : ` · ${status.projectId}`}
                </p>
                <em>{status.mode === 'paused' ? '已暂停' : status.mode === 'active' ? '采集中' : '停发'}</em>
              </div>
              <div className={css.eventRow}>
                <span>队列积压</span>
                <strong>{status.queueEventCount} 条</strong>
                <p>占用 {formatQueueBytes(status.queueByteCount)}；数据缺口 {status.gapCount} 条。</p>
                <em>{status.gapCount > 0 ? '存在缺口' : '无缺口'}</em>
              </div>
              <div className={css.eventRow}>
                <span>最近失败</span>
                <strong>{status.lastFailure === null ? '无' : `${status.lastFailure.stage} / ${status.lastFailure.code}`}</strong>
                <p>{status.lastFailure === null ? '管道未记录失败' : `${new Date(status.lastFailure.at).toLocaleString()} · ${status.lastFailure.summary}`}</p>
                <em>{status.lastFailure === null ? '健康' : '已记录'}</em>
              </div>
              <div className={css.eventRow}>
                <span>最后刷新</span>
                <strong>{refreshedAt === undefined ? '尚未刷新' : new Date(refreshedAt).toLocaleTimeString()}</strong>
                <p>{refreshedAt === undefined ? '进入页面后自动读取' : '页面每 5 秒自动刷新'}</p>
                <em>{refreshedAt === undefined ? '等待' : '自动'}</em>
              </div>
            </div>
          </section>
          <div role="group" aria-label="采集操作" className={css.collectorActions}>
            <button type="button" className={css.outlineButton} disabled={busy || loading} onClick={onRefresh}>
              <IconRefreshOutline16 size={16} />
              刷新状态
            </button>
            {status.mode === 'paused' ? (
              <button
                type="button"
                className={css.outlineButton}
                disabled={busy || loading}
                onClick={() => {
                  onAction('resume')
                }}
              >
                <IconPlayOutline16 size={16} />
                恢复采集
              </button>
            ) : (
              <button
                type="button"
                className={css.outlineButton}
                disabled={busy || loading}
                onClick={() => {
                  onAction('pause')
                }}
              >
                <IconPauseOutline16 size={16} />
                暂停采集
              </button>
            )}
            <button
              type="button"
              className={css.outlineButton}
              disabled={busy || loading}
              onClick={() => {
                onAction('flush')
              }}
            >
              <IconQueueOutline14 size={16} />
              立即发送
            </button>
            <button
              type="button"
              className={css.outlineButton}
              disabled={busy || loading}
              onClick={() => {
                onAction('clear')
              }}
            >
              清空未上报数据
            </button>
          </div>
          <div className={css.metricGrid}>
            <Metric label="采集模式" value={modeLabel} detail={projectId === undefined ? '请先选择 active 项目' : `当前项目 ${projectId}`} icon={<IconDataOutline16 size={16} />} />
            <Metric label="队列事件" value={String(status.queueEventCount)} detail={`占用 ${formatQueueBytes(status.queueByteCount)}`} icon={<IconQueueOutline14 size={16} />} />
            <Metric label="最近确认" value={status.lastAcceptedAt === null ? '暂无' : new Date(status.lastAcceptedAt).toLocaleTimeString()} detail={status.lastAcceptedAt === null ? '尚无 accepted 批次' : '服务端已确认最近批次'} icon={<IconSparkle16 size={16} />} />
            <Metric label="数据缺口" value={String(status.gapCount)} detail={status.gapCount > 0 ? '存在丢弃或未上报数据' : '暂无缺口'} icon={<IconInspectOutline12 size={16} />} />
          </div>
          <section className={css.panel}>
            <SectionHeading title="管道诊断" action={<span className={status.mode === 'paused' ? css.pausedTag : css.collectingTag}>{modeLabel}</span>} />
            <div className={css.eventList}>
              <div className={css.eventRow}>
                <span>项目绑定</span>
                <strong>{status.projectId === null ? '未绑定' : status.projectId}</strong>
                <p>
                  授权状态：
                  {status.authorizationState === 'authorized' ? '已授权' : status.authorizationState === 'revoked' ? '已撤销' : '未知'}
                </p>
                <em>{status.projectId === null ? '等待选择' : '已绑定'}</em>
              </div>
              <div className={css.eventRow}>
                <span>本地存储</span>
                <strong>{status.storageError === null ? '正常' : '异常'}</strong>
                <p>{status.storageError === null ? 'telemetry 队列可读写' : status.storageError}</p>
                <em>{status.storageError === null ? '正常' : '停发'}</em>
              </div>
            </div>
          </section>
          <div className={css.collectionNote}>
            <IconInspectOutline12 size={16} />
            <span>{status.gapCount > 0 ? `当前存在 ${status.gapCount} 条缺口记录：丢弃与未上报数据不会被伪装为健康。` : '未发送事件保存在本地队列；采集失败不会阻塞主对话。'}</span>
          </div>
        </>
      )}
    </div>
  )
}

function PageIntro({ eyebrow, title, description, action }: { eyebrow: string; title: string; description: string; action?: ReactNode }) {
  return (
    <div className={css.pageIntro}>
      <div>
        <span className={css.eyebrow}>{eyebrow}</span>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {action !== undefined && <div className={css.pageAction}>{action}</div>}
    </div>
  )
}

function SectionHeading({ title, action }: { title: string; action?: ReactNode }) {
  return (
    <div className={css.sectionHeading}>
      <h2>{title}</h2>
      {action}
    </div>
  )
}

function Metric({ label, value, detail, icon }: { label: string; value: string; detail: string; icon: ReactNode }) {
  return (
    <div className={css.metric}>
      <span className={css.metricIcon}>{icon}</span>
      <span className={css.metricLabel}>{label}</span>
      <strong>{value}</strong>
      <small>{detail}</small>
    </div>
  )
}

function projectModel(project: TeamSkillProject): Project {
  return {
    id: project.projectId,
    organizationId: project.organizationId,
    organizationName: project.organizationName,
    name: project.name,
    description: project.description,
    status: project.status,
    createdBy: project.createdBy,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    memberCount: project.memberCount,
    assetCount: project.assetCount,
    revision: project.revision,
  }
}

function projectStatusLabel(status: TeamSkillProject['status']): string {
  return status === 'active' ? '进行中' : status === 'draft' ? '草稿' : '已归档'
}

function formatProjectDate(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { dateStyle: 'medium', timeStyle: 'short' })
}

function formatMemoryDate(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { dateStyle: 'medium', timeStyle: 'short' })
}

function currentStorageKey(userId: string | undefined): string {
  return `dsh.ai-coding-platform.project:${window.location.origin}:${userId ?? 'signed-out'}`
}

function readStoredProjectId(key: string): string | undefined {
  try {
    return window.localStorage.getItem(key) ?? undefined
  } catch {
    return undefined
  }
}

function writeStoredProjectId(key: string, projectId: string): void {
  try {
    window.localStorage.setItem(key, projectId)
  } catch {
    /* Storage is optional in embedded clients. */
  }
}

function clearStoredProjectId(key: string): void {
  try {
    window.localStorage.removeItem(key)
  } catch {
    /* Storage is optional in embedded clients. */
  }
}

function groupProjects(projects: readonly TeamSkillProject[]): readonly {
  readonly organizationId: string
  readonly organizationName: string
  readonly projects: readonly TeamSkillProject[]
}[] {
  const groups = new Map<
    string,
    {
      readonly organizationId: string
      readonly organizationName: string
      readonly projects: TeamSkillProject[]
    }
  >()
  for (const project of projects) {
    const group = groups.get(project.organizationId) ?? {
      organizationId: project.organizationId,
      organizationName: project.organizationName,
      projects: [],
    }
    group.projects.push(project)
    groups.set(project.organizationId, group)
  }
  return [...groups.values()]
}

function isHostFailure(value: unknown): value is HostFailure {
  if (typeof value !== 'object' || value === null || !('status' in value)) return false
  const status = value.status
  return status === 'not-ready' || status === 'failed'
}

function isSignedOut(value: unknown): value is { readonly status: 'signed-out' } {
  return typeof value === 'object' && value !== null && 'status' in value && value.status === 'signed-out'
}

function isMemoryMutation(value: unknown): value is TeamSkillMemoryMutation {
  return typeof value === 'object' && value !== null && 'jobId' in value && typeof value.jobId === 'string'
}

type MemoryMutationResult = { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: { readonly message: string } }

function memoryMutationValue(result: MemoryMutationResult, setError: (message: string) => void): TeamSkillMemoryMutation | undefined {
  if (!result.ok) {
    setError(result.error.message)
    return undefined
  }
  if (isHostFailure(result.value) || isSignedOut(result.value)) {
    setError(isSignedOut(result.value) ? '账号已退出，请重新登录。' : hostFailureMessage(result.value))
    return undefined
  }
  if (!isMemoryMutation(result.value)) return undefined
  return result.value
}

function hostFailureMessage(value: HostFailure): string {
  return value.status === 'not-ready' ? `服务端未就绪：${value.missing.join('、')}` : value.message
}

function remoteFailureMessage(error: unknown): string {
  return error instanceof Error && error.message.length > 0 ? error.message : '无法读取服务端授权，请稍后重试。'
}

function isAccessSummary(value: unknown): value is TeamSkillAccessSummary {
  return typeof value === 'object' && value !== null && 'organizations' in value && Array.isArray(value.organizations) && 'projects' in value && Array.isArray(value.projects) && 'assets' in value && Array.isArray(value.assets)
}
