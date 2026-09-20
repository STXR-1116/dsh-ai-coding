'use client'

import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from 'react'
import { signIn, signOut } from 'next-auth/react'
import { Activity, BookOpen, Building2, CheckCircle2, ChevronDown, Database, FilePenLine, FolderKanban, KeyRound, Library, Plus, RefreshCw, Rocket, Save, ScrollText, ShieldCheck, TriangleAlert, Upload, Users, UserRound, SlidersHorizontal, ScrollText as AuditIcon , Boxes , Server , PlayCircle , Settings as SettingsIcon , X } from 'lucide-react'
import { CloudAuditsPage, CloudOpsPage, CloudProfilesPage, CloudRunsPage, CloudTypesPage, type CloudRelationFocus, type CloudRelationJump } from './cloud-workspace-pages'
import { buildWorkbenchMetrics, groupWorkbenchMetrics, type WorkbenchFilter, type WorkbenchGroup } from '../lib/workbench-groups'
import { buildPermissionChain, permissionResultFromApi, summarizeBatchGrant, type BatchGrantRow } from '../lib/permission-chain'
import { ARCHIVED_READONLY_REASON, buildDependencySummary, buildSecurityRunSummary } from '../lib/project-governance'
import { buildPaletteResults, paletteActionDisclosure, type PaletteSources } from '../lib/command-palette'
import { Empty, Loading } from './admin-states'
import { loadAdminAppearance, resolveAdminTheme, saveAdminAppearance, DEFAULT_ADMIN_APPEARANCE, type AdminAppearance } from './admin-appearance'
import { TeamSkillApi, type ApiError, type ApiResult } from '../lib/team-skill-api.ts'
import type { AccountRole, AdminKnowledgeBase, CloudAgentProfile, CloudRun, CloudWorkspace, AdminKnowledgeDocument, AdminMemoryAudit, AdminMemoryJob, AdminMemoryPolicy, AdminMemoryRecord, AdminOrganization, AdminProject, AdminProjectAsset, AdminProjectMember, AdminUser, AuthorizationAudit, AuditLogEntry, DirectoryUser, PermissionDefinition, ReviewItem, RoleDefinition, SkillVersion, TeamSkill, TelemetryBucket, TelemetryEventItem, TelemetryEventPage, TelemetryModelUsage, TelemetryOverview, TelemetryProjectSummary, TelemetrySummary, TelemetryToolUsage } from '../lib/team-skill-types.ts'

type PageId = 'directory' | 'drafts' | 'reviews' | 'releases' | 'audit' | 'knowledge-bases' | 'memory-library' | 'projects' | 'account-users' | 'account-organizations' | 'account-roles' | 'account-projects' | 'account-audit' | 'telemetry-overview' | 'telemetry-project' | 'telemetry-events' | 'cloud-types' | 'cloud-profiles' | 'cloud-ops' | 'cloud-runs' | 'cloud-audits' | 'workbench' | 'settings'

// Four task groups (工作台/资产治理/访问控制/运行与审计). Items keep their
// domain PageIds; only the grouping changes.
type Loaded =
  | { readonly page: PageId; readonly state: 'loading' }
  | {
    readonly page: PageId
    readonly state: 'ready'
    readonly value: readonly unknown[]
  }
  | {
    readonly page: PageId
    readonly state: 'error'
    readonly error: ApiError
  }
type NavIcon = typeof Library
type NavItem = {
  readonly id: PageId
  readonly label: string
  readonly hint: string
  readonly icon: NavIcon
}
export interface DashboardSession {
  readonly user: {
    readonly id: string
    readonly name?: string | null
    readonly email?: string | null
  }
  readonly role: AccountRole
  readonly mustChangePassword: boolean
}

const NAV: readonly NavItem[] = [
  { id: 'directory', label: 'Skill 目录', hint: '资产与版本', icon: Library },
  { id: 'drafts', label: '我的草稿', hint: '创建与提交', icon: FilePenLine },
  { id: 'reviews', label: '审核队列', hint: '结构化审核', icon: ShieldCheck },
  { id: 'releases', label: '发布管理', hint: '发布与回滚', icon: Rocket },
  { id: 'audit', label: '审计日志', hint: '管理员可见', icon: ScrollText },
]
const KNOWLEDGE_NAV: readonly NavItem[] = [
  {
    id: 'knowledge-bases',
    label: '知识库',
    hint: '文档、FAQ 与 Wiki',
    icon: BookOpen,
  },
]
const MEMORY_NAV: readonly NavItem[] = [
  {
    id: 'memory-library',
    label: '记忆列表、策略、任务与审计',
    hint: '项目团队记忆治理',
    icon: Database,
  },
]

const PROJECT_NAV: readonly NavItem[] = [
  {
    id: 'projects',
    label: '项目列表',
    hint: '项目资源与生命周期',
    icon: FolderKanban,
  },
]

const PERMISSION_NAV: readonly NavItem[] = [
  {
    id: 'account-users',
    label: '用户与成员',
    hint: '账号与组织关系',
    icon: UserRound,
  },
  {
    id: 'account-organizations',
    label: '组织管理',
    hint: '组织生命周期与经理绑定',
    icon: Building2,
  },
  {
    id: 'account-roles',
    label: '角色与权限',
    hint: '服务端固定矩阵',
    icon: KeyRound,
  },
  {
    id: 'account-projects',
    label: '项目授权',
    hint: '项目成员关系',
    icon: SlidersHorizontal,
  },
  {
    id: 'account-audit',
    label: '授权审计',
    hint: '账号与授权事件',
    icon: AuditIcon,
  },
]

const TELEMETRY_NAV: readonly NavItem[] = [
  {
    id: 'telemetry-overview',
    label: '总览',
    hint: '运行与采集管道聚合',
    icon: Activity,
  },
  {
    id: 'telemetry-project',
    label: '项目详情',
    hint: '单项目运行、Token 与工具',
    icon: FolderKanban,
  },
  {
    id: 'telemetry-events',
    label: '事件诊断',
    hint: '结构化事件与数据缺口',
    icon: ScrollText,
  },
]

const WORKSPACE_NAV: readonly NavItem[] = [
  {
    id: 'cloud-types',
    label: 'Agent 类型',
    hint: '执行器类型与 readiness',
    icon: Boxes,
  },
  {
    id: 'cloud-profiles',
    label: 'Agent 配置',
    hint: '草稿、发布与项目绑定',
    icon: Boxes,
  },
  {
    id: 'cloud-ops',
    label: 'Workspace 运维',
    hint: '生命周期与状态巡检',
    icon: Server,
  },
  {
    id: 'cloud-runs',
    label: 'Agent Run',
    hint: '全局检索与配置快照',
    icon: PlayCircle,
  },
  {
    id: 'cloud-audits',
    label: '审计',
    hint: 'Workspace、Run 与配置审计',
    icon: ScrollText,
  },
]

type AdminModule = {
  readonly id: string
  readonly label: string
  readonly hint: string
  readonly icon: NavIcon
  readonly pages: readonly NavItem[]
}

const SETTINGS_NAV: readonly NavItem[] = [
  { id: 'settings', label: '系统设置', hint: '外观偏好与会话信息', icon: SettingsIcon },
]
const WORKBENCH_PAGE_NAV: readonly NavItem[] = [
  { id: 'workbench', label: '工作台', hint: '运行指标与待处理事项', icon: Activity },
]

/** Fixed top-level navigation (design spec §4): exactly these ten modules. */
const ADMIN_MODULES: readonly AdminModule[] = [
  {
    id: 'module-workbench',
    label: '工作台',
    hint: '运行指标与待处理事项',
    icon: Activity,
    pages: WORKBENCH_PAGE_NAV,
  },
  {
    id: 'module-access',
    label: '账号与权限',
    hint: '用户、组织、角色与项目授权',
    icon: KeyRound,
    pages: PERMISSION_NAV.filter(item => item.id !== 'account-audit'),
  },
  {
    id: 'module-projects',
    label: '项目管理',
    hint: '项目资源与成员授权',
    icon: FolderKanban,
    pages: PROJECT_NAV,
  },
  {
    id: 'module-agent',
    label: 'Agent 配置',
    hint: 'Agent 类型与配置版本',
    icon: Boxes,
    pages: WORKSPACE_NAV.filter(item => item.id === 'cloud-types' || item.id === 'cloud-profiles'),
  },
  {
    id: 'module-skills',
    label: '团队 Skill',
    hint: '目录、草稿、审核与发布',
    icon: Library,
    pages: NAV.filter(item => item.id !== 'audit'),
  },
  {
    id: 'module-knowledge',
    label: '知识库',
    hint: '文档、FAQ 与 Wiki',
    icon: BookOpen,
    pages: KNOWLEDGE_NAV,
  },
  {
    id: 'module-memory',
    label: '记忆库',
    hint: '记忆列表、策略、任务与审计',
    icon: Database,
    pages: MEMORY_NAV,
  },
  {
    id: 'module-cloud-ops',
    label: '云工作空间运维',
    hint: '生命周期与状态巡检',
    icon: Server,
    pages: WORKSPACE_NAV.filter(item => item.id === 'cloud-ops' || item.id === 'cloud-runs'),
  },
  {
    id: 'module-runs-audit',
    label: '运行与审计',
    hint: '可观测、授权与治理审计',
    icon: ScrollText,
    pages: [
      ...TELEMETRY_NAV,
      ...PERMISSION_NAV.filter(item => item.id === 'account-audit'),
      ...NAV.filter(item => item.id === 'audit'),
      ...WORKSPACE_NAV.filter(item => item.id === 'cloud-audits'),
    ],
  },
  {
    id: 'module-settings',
    label: '系统设置',
    hint: '外观偏好与会话信息',
    icon: SettingsIcon,
    pages: SETTINGS_NAV,
  },
]


// Pages a signed-in member may see; the other items need staff rights.
// 系统设置 stays reachable for members so the permission-denied state itself
// is observable instead of the entry silently disappearing.
const MEMBER_VISIBLE_PAGES = new Set<PageId>(['directory', 'drafts', 'reviews', 'releases', 'audit', 'settings'])

function adminModuleOfPage(page: PageId): AdminModule | undefined {
  return ADMIN_MODULES.find(module => module.pages.some(item => item.id === page))
}

/** Module entries visible for the current viewer: staff pages need an
 * authenticated staff session; unauthenticated shells only see member pages. */
function visibleModules(role: AccountRole, authenticated: boolean): readonly AdminModule[] {
  return ADMIN_MODULES.map(module => ({
    ...module,
    pages: role === 'member' || !authenticated
      ? module.pages.filter(item => MEMBER_VISIBLE_PAGES.has(item.id) && (authenticated || item.id !== 'settings'))
      : module.pages,
  })).filter(module => module.pages.length > 0)
}


/** Login form used by the server-rendered authentication gate. */
export function AdminLoginPage({ clearStaleSession = false }: { readonly clearStaleSession?: boolean } = {}) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>()
  useEffect(() => {
    if (!clearStaleSession) return
    // A failed cleanup leaves the page safe; submitting credentials still replaces the cookie.
    void Promise.resolve(signOut({ redirect: false })).catch(() => undefined)
  }, [clearStaleSession])
  const submit = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    setBusy(true)
    setError(undefined)
    const result = await signIn('credentials', {
      username,
      password,
      redirect: false,
    })
    setBusy(false)
    if (result.error !== undefined) {
      setError('用户名或密码错误')
      return
    }
    window.location.reload()
  }
  return <AuthPage title="登录团队 Skill 管理后台" description="使用服务端账号登录后才能查看组织、账号和 Skill 数据。" onSubmit={submit} error={error} busy={busy} username={username} password={password} onUsername={setUsername} onPassword={setPassword} submitLabel="登录" />
}

/** First-login password change gate; the service never exposes the new password again. */
export function AdminPasswordChangePage({ username }: { readonly username: string }) {
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>()
  const submit = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    if (newPassword !== confirmation) {
      setError('两次输入的新密码不一致')
      return
    }
    setBusy(true)
    setError(undefined)
    try {
      const response = await fetch('/api/team-skill/auth/change-password', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'Idempotency-Key': crypto.randomUUID(),
        },
        body: JSON.stringify({
          current_password: currentPassword,
          new_password: newPassword,
        }),
      })
      if (!response.ok) {
        setError('密码修改失败，请检查当前密码和新密码')
        setBusy(false)
        return
      }
      const result = await signIn('credentials', {
        username,
        password: newPassword,
        redirect: false,
      })
      if (result.error !== undefined) {
        setError('密码已修改，但重新登录失败')
        setBusy(false)
        return
      }
      window.location.reload()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '无法连接账号服务')
      setBusy(false)
    }
  }
  return (
    <AuthPage
      title="首次登录，请修改密码"
      description="初始密码只能使用一次。修改成功后才能进入管理后台。"
      onSubmit={submit}
      error={error}
      busy={busy}
      username={username}
      password={currentPassword}
      onUsername={() => undefined}
      onPassword={setCurrentPassword}
      submitLabel="修改密码"
      extra={
        <>
          <label>
            新密码
            <input
              type="password"
              autoComplete="new-password"
              value={newPassword}
              onChange={(event) => {
                setNewPassword(event.target.value)
              }}
              minLength={8}
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
              minLength={8}
              required
            />
          </label>
        </>
      }
    />
  )
}

function AuthPage({
  title,
  description,
  onSubmit,
  error,
  busy,
  username,
  password,
  onUsername,
  onPassword,
  submitLabel,
  extra,
}: {
  readonly title: string
  readonly description: string
  readonly onSubmit: (event: React.FormEvent<HTMLFormElement>) => void | Promise<void>
  readonly error?: string
  readonly busy: boolean
  readonly username: string
  readonly password: string
  readonly onUsername: (value: string) => void
  readonly onPassword: (value: string) => void
  readonly submitLabel: string
  readonly extra?: React.ReactNode
}) {
  return (
    <main className="auth-shell">
      <section className="auth-panel">
        <span className="eyebrow">AI 开放平台 / 账号安全</span>
        <h1>{title}</h1>
        <p>{description}</p>
        <form className="auth-form" onSubmit={event => void onSubmit(event)}>
          <label>
            用户名或邮箱
            <input
              autoComplete="username"
              value={username}
              onChange={(event) => {
                onUsername(event.target.value)
              }}
              disabled={busy}
              required
            />
          </label>
          <label>
            密码
            <input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => {
                onPassword(event.target.value)
              }}
              disabled={busy}
              required
            />
          </label>
          {extra}
          {error !== undefined && (
            <div className="auth-error" role="alert">
              {error}
            </div>
          )}
          <button className="button primary" disabled={busy}>
            {busy ? '正在处理…' : submitLabel}
          </button>
        </form>
      </section>
    </main>
  )
}

/** Skill governance console backed by the Skill REST API with mutually exclusive primary navigation groups. */
export function AdminDashboard({ session }: { readonly session?: DashboardSession } = {}) {
  const effectiveRole: AccountRole = session?.role ?? 'admin'
  const [page, setPage] = useState<PageId>('directory')
  const [routeRevision, setRouteRevision] = useState(0)
  const appearanceState = useState<AdminAppearance>(() => {
    if (typeof window === 'undefined') return DEFAULT_ADMIN_APPEARANCE
    return loadAdminAppearance()
  })
  const [appearance, setAppearanceState] = appearanceState
  const [prefersDark, setPrefersDark] = useState(false)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [capsuleOpen, setCapsuleOpen] = useState(false)
  const [appearanceOpen, setAppearanceOpen] = useState(false)
  const [connState, setConnState] = useState<'connected' | 'busy' | 'error'>('connected')
  const resolvedTheme = resolveAdminTheme(appearance.theme, prefersDark)
  useEffect(() => {
    // jsdom and older hosts lack matchMedia: system theme falls back to light.
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
  useEffect(() => {
    const root = document.documentElement
    root.setAttribute('data-theme', resolvedTheme)
    root.setAttribute('data-density', appearance.density)
  }, [resolvedTheme, appearance.density])
  const setAppearance = (next: AdminAppearance): void => {
    setAppearanceState(next)
    saveAdminAppearance(next)
  }
  useEffect(() => {
    if (!capsuleOpen && !appearanceOpen) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      setCapsuleOpen(false)
      setAppearanceOpen(false)
      event.stopPropagation()
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.removeEventListener('keydown', onKeyDown, true)
    }
  }, [capsuleOpen, appearanceOpen])
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setPaletteOpen(previous => !previous)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => { window.removeEventListener('keydown', onKeyDown) }
  }, [])
  const [navOpen, setNavOpen] = useState(false)
  const navToggleRef = useRef<HTMLButtonElement | null>(null)
  const sidebarRef = useRef<HTMLElement | null>(null)
  /** 当前云工作空间页面的关系链上下文；导航到其他页面即清空。 */
  const [cloudFocus, setCloudFocus] = useState<CloudRelationFocus | undefined>()
  /** 工作台指标跳转保留的过滤条件（§6.1）；导航到其他页面即清空。 */
  const [workbenchFilter, setWorkbenchFilter] = useState<WorkbenchFilter | undefined>()
  /** 命令面板（§6.2）：Ctrl/Cmd+K 或头部按钮打开。 */
  const [paletteOpen, setPaletteOpen] = useState(false)
  // 命令面板是 role="dialog"：Escape 必须能关闭（键盘可用性，蓝图 §11.3）。
  useEffect(() => {
    if (!paletteOpen) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      setPaletteOpen(false)
      event.stopPropagation()
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.removeEventListener('keydown', onKeyDown, true)
    }
  }, [paletteOpen])
  const [loaded, setLoaded] = useState<Loaded>({
    page: 'directory',
    state: 'loading',
  })
  const [selectedSkill, setSelectedSkill] = useState<TeamSkill | undefined>()
  const [actionMessage, setActionMessage] = useState<string | undefined>()
  const requestSequence = useRef(0)
  const api = useMemo(
    () =>
      new TeamSkillApi({
        baseUrl: session === undefined ? process.env.NEXT_PUBLIC_TEAM_SKILL_API_URL : '/api/team-skill',
        sessionAuth: true,
      }),
    [session],
  )

  const reload = async (showLoading = true): Promise<void> => {
    const sequence = ++requestSequence.current
    const requestedPage = page
    if (showLoading) setLoaded({ page, state: 'loading' })
    if (page === 'settings') {
      // 系统设置读取的是本地偏好与会话信息，不需要服务端请求。
      setConnState('connected')
      setLoaded({ page, state: 'ready', value: [] })
      return
    }
    setConnState('busy')
    const result = await loadPage(api, page, effectiveRole, workbenchFilter)
    if (sequence !== requestSequence.current || requestedPage !== page) return
    if (result.ok) {
      setConnState('connected')
      setLoaded({ page, state: 'ready', value: result.value })
    } else if (result.error.kind === 'unauthorized' && session !== undefined) {
      await signOut({ redirect: true, redirectTo: '/' })
    } else {
      setConnState('error')
      setLoaded({ page, state: 'error', error: result.error })
    }
  }

  useEffect(() => {
    void reload()
  }, [page, workbenchFilter])
  useEffect(() => {
    const route = readAdminRoute()
    setPage(route.page)
    setCloudFocus(route.focus)
    setWorkbenchFilter(route.workbenchFilter)
    setRouteRevision(value => value + 1)
  }, [])
  useEffect(() => {
    const onPopState = (): void => {
      const route = readAdminRoute()
      setPage(route.page)
      setCloudFocus(route.focus)
      setWorkbenchFilter(route.workbenchFilter)
      setRouteRevision(value => value + 1)
    }
    window.addEventListener('popstate', onPopState)
    return () => {
      window.removeEventListener('popstate', onPopState)
    }
  }, [])

  const selectPage = (next: PageId, focus?: CloudRelationFocus): void => {
    if (next === page && focus === undefined) {
      // Re-selecting the active module page must not invalidate the in-flight
      // or completed load: the sequence bump would drop its result.
      return
    }
    requestSequence.current += 1
    setActionMessage(undefined)
    if (next === 'projects') navigateProjectRoute()
    setCloudFocus(focus)
    if (focus !== undefined) navigateCloudRoute(next, focus)
    setPage(next)
  }
  /** 关系链跳转：目标页 + 对象上下文一起交给路由，供刷新与后退恢复。 */
  const jumpAlongRelationChain = (jump: CloudRelationJump): void => {
    selectPage(jump.target, jump.focus)
  }
  /** 工作台指标跳转：目标页 + 保留的过滤一起交给路由（§6.1）。 */
  const openWorkbenchTarget = (target: PageId, filter: WorkbenchFilter): void => {
    requestSequence.current += 1
    setActionMessage(undefined)
    setWorkbenchFilter(filter)
    navigateWorkbenchRoute(target, filter)
    setPage(target)
  }
  const showAction = (result: ApiResult<unknown>, success: string): void => {
    if (result.ok) {
      setActionMessage(success)
      if (page !== 'memory-library') void reload(false)
    } else if (result.error.kind === 'unauthorized' && session !== undefined) {
      void signOut({ redirect: true, redirectTo: '/' })
    } else setActionMessage(errorMessage(result.error))
  }

  useEffect(() => {
    if (!navOpen) return
    sidebarRef.current?.querySelector<HTMLButtonElement>('.module-link, .module-tab')?.focus()
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setNavOpen(false)
        navToggleRef.current?.focus()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [navOpen])

  const activeModule = adminModuleOfPage(page)
  const modules = visibleModules(effectiveRole, session !== undefined)
  return (
    <div
      className={navOpen ? 'admin-shell nav-open' : 'admin-shell'}
      data-app-shell=""
      data-sidebar-collapsed={sidebarCollapsed ? 'true' : 'false'}
    >
      {navOpen && (
        <div
          className="nav-scrim"
          onClick={() => {
            setNavOpen(false)
          }}
        />
      )}
      <aside className="admin-sidebar" data-app-sidebar="" ref={sidebarRef}>
        <div className="admin-brand">
          <span className="brand-mark">AO</span>
          <div>
            <strong>AI 开放平台</strong>
            <small>团队 Skill 管理</small>
          </div>
          <button
            type="button"
            className="rail-toggle"
            aria-label={sidebarCollapsed ? '展开侧栏' : '折叠侧栏'}
            title={sidebarCollapsed ? '展开侧栏' : '折叠侧栏'}
            onClick={() => {
              setSidebarCollapsed(value => !value)
            }}
          >
            <ChevronDown className={sidebarCollapsed ? 'rail-toggle-chevron flipped' : 'rail-toggle-chevron'} size={16} aria-hidden="true" />
          </button>
        </div>
        <div className="admin-role">
          <span className="role-dot" />
          管理员视角
        </div>
        <nav aria-label="管理后台导航" className="module-nav">
          {modules.map((module) => {
            const active = module.pages.some(item => item.id === page)
            const Icon = module.icon
            return (
              <button
                type="button"
                key={module.id}
                className={active ? 'module-link active' : 'module-link'}
                aria-current={active ? 'page' : undefined}
                onClick={() => {
                  selectPage(module.pages[0].id)
                  setNavOpen(false)
                }}
              >
                <Icon size={16} aria-hidden="true" />
                <span>
                  <strong>{module.label}</strong>
                  <small>{module.hint}</small>
                </span>
              </button>
            )
          })}
        </nav>
        <div className="sidebar-foot">
          <span>服务端权威状态</span>
          <strong>Auth.js Session</strong>
        </div>
      </aside>
      <main className="admin-main">
        <header className="admin-header" data-topbar="">
          <button
            type="button"
            ref={navToggleRef}
            className="nav-toggle"
            aria-label="切换导航"
            title={navOpen ? '关闭导航' : '打开导航'}
            aria-expanded={navOpen}
            onClick={() => {
              setNavOpen(open => !open)
            }}
          >
            ☰
          </button>
          <div>
            <span className="crumb">团队治理 / {page === 'projects' ? '项目管理' : page === 'knowledge-bases' ? '知识库管理' : page === 'memory-library' ? '记忆库管理' : page.startsWith('telemetry-') ? 'AI Coding 可观测' : page.startsWith('account-') ? '权限管理' : page.startsWith('cloud-') ? '云工作空间' : 'Skill 管理'}</span>
            {/* 顶栏承载模块标题（spec §4）；页面自身标题留在内容区。 */}
            <h1>{activeModule?.label ?? pageLabel(page)}</h1>
          </div>
          <div className="header-actions">
            <button type="button" className="button secondary" aria-label="打开命令面板" aria-keyshortcuts="Control+K" onClick={() => { setPaletteOpen(true) }}>
              命令面板
            </button>
            <button
              type="button"
              className="status-capsule"
              data-status-capsule=""
              aria-label="系统状态胶囊"
              aria-haspopup="dialog"
              aria-expanded={capsuleOpen}
              onClick={() => {
                setCapsuleOpen(value => !value)
              }}
            >
              <span className={`capsule-dot ${connState}`} aria-hidden="true" />
              {connState === 'connected' ? '已连接' : connState === 'busy' ? '同步中' : '需要处理'}
            </button>
            {capsuleOpen && (
              <div className="topbar-popover" role="dialog" aria-label="系统状态">
                <dl>
                  <div>
                    <dt>连接</dt>
                    <dd>{connState === 'connected' ? '治理服务已连接' : connState === 'busy' ? '正在同步治理数据' : '最近一次治理读取失败，可重试'}</dd>
                  </div>
                  <div>
                    <dt>账号</dt>
                    <dd>{session?.user.name ?? session?.user.email ?? '未登录'} · {roleLabel(effectiveRole)}</dd>
                  </div>
                  <div>
                    <dt>模块</dt>
                    <dd>{activeModule?.label ?? '—'}</dd>
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
              className="icon-button"
              aria-label="外观设置"
              aria-haspopup="dialog"
              aria-expanded={appearanceOpen}
              onClick={() => {
                setAppearanceOpen(value => !value)
              }}
            >
              <SettingsIcon size={18} />
            </button>
            {appearanceOpen && (
              <div className="topbar-popover" role="dialog" aria-label="外观设置">
                <fieldset>
                  <legend>主题</legend>
                  <label>
                    <input type="radio" name="admin-theme" checked={appearance.theme === 'light'} onChange={() =>{  setAppearance({ ...appearance, theme: 'light' }) }} />
                    浅色
                  </label>
                  <label>
                    <input type="radio" name="admin-theme" checked={appearance.theme === 'dark'} onChange={() =>{  setAppearance({ ...appearance, theme: 'dark' }) }} />
                    深色
                  </label>
                  <label>
                    <input type="radio" name="admin-theme" checked={appearance.theme === 'system'} onChange={() =>{  setAppearance({ ...appearance, theme: 'system' }) }} />
                    跟随系统
                  </label>
                </fieldset>
                <fieldset>
                  <legend>密度</legend>
                  <label>
                    <input type="radio" name="admin-density" checked={appearance.density === 'comfortable'} onChange={() =>{  setAppearance({ ...appearance, density: 'comfortable' }) }} />
                    舒适
                  </label>
                  <label>
                    <input type="radio" name="admin-density" checked={appearance.density === 'compact'} onChange={() =>{  setAppearance({ ...appearance, density: 'compact' }) }} />
                    紧凑
                  </label>
                </fieldset>
              </div>
            )}
            <span className="identity">
              {session?.user.name ?? session?.user.email ?? '管理员'} · {roleLabel(effectiveRole)}
            </span>
            <button className="icon-button" aria-label="刷新当前页面" title="刷新当前页面" onClick={() => void reload()}>
              <RefreshCw size={18} />
            </button>
          </div>
        </header>
        {paletteOpen && (
          <CommandPalette
            api={api}
            onClose={() => { setPaletteOpen(false) }}
            onSelectPage={(target) => {
              selectPage(target)
              // 面板跳转同样写入路由：刷新与后退都能恢复目标页（无对象上下文）。
              navigateCloudRoute(target, {})
            }}
          />
        )}
        {activeModule !== undefined && activeModule.pages.length > 1 && (
          <nav className="module-tabs" aria-label={`${activeModule.label}子导航`}>
            {activeModule.pages.map(item => (
              <button
                type="button"
                key={item.id}
                className={item.id === page ? 'module-tab active' : 'module-tab'}
                aria-current={item.id === page ? 'page' : undefined}
                onClick={() => {
                  selectPage(item.id)
                }}
              >
                {item.label}
              </button>
            ))}
          </nav>
        )}
        {actionMessage !== undefined && (
          <div className="action-message" role="status">
            {actionMessage}
          </div>
        )}
        {(loaded.page !== page || loaded.state === 'loading') && <Loading />}
        {loaded.page === page && loaded.state === 'ready' && page === 'workbench' && <WorkbenchPage api={api} role={effectiveRole} onOpenMetric={openWorkbenchTarget} onNavigate={selectPage} />}
        {loaded.page === page && loaded.state === 'ready' && page === 'settings' && session !== undefined && (
          <SettingsPage role={effectiveRole} session={session} appearance={appearance} onAppearance={setAppearance} />
        )}
        {loaded.page === page && loaded.state === 'error' && <ErrorState error={loaded.error} onRetry={() => void reload()} />}
        {loaded.page === page && loaded.state === 'ready' && page === 'directory' && <DirectoryPage items={loaded.value as TeamSkill[]} selected={selectedSkill} onSelect={setSelectedSkill} workbenchFilter={workbenchFilter} />}
        {loaded.page === page && loaded.state === 'ready' && page === 'drafts' && <DraftsPage items={loaded.value as TeamSkill[]} api={api} onAction={showAction} />}
        {loaded.page === page && loaded.state === 'ready' && page === 'reviews' && <ReviewsPage items={loaded.value as ReviewItem[]} api={api} onAction={showAction} workbenchFilter={workbenchFilter} />}
        {loaded.page === page && loaded.state === 'ready' && page === 'releases' && <ReleasesPage items={loaded.value as TeamSkill[]} api={api} onAction={showAction} />}
        {loaded.page === page && loaded.state === 'ready' && page === 'audit' && <AuditPage items={loaded.value as AuditLogEntry[]} />}
        {loaded.page === page && loaded.state === 'ready' && page === 'knowledge-bases' && <KnowledgeBasesPage items={loaded.value as AdminKnowledgeBase[]} api={api} role={effectiveRole} onAction={showAction} />}
        {loaded.page === page && loaded.state === 'ready' && page === 'memory-library' && <MemoryLibraryPage items={loaded.value as AdminMemoryRecord[]} api={api} role={effectiveRole} userId={session?.user.id} onAction={showAction} />}
        {loaded.page === page && loaded.state === 'ready' && page === 'account-users' && <UsersPage items={loaded.value as AdminUser[]} api={api} role={effectiveRole} onAction={showAction} />}
        {loaded.page === page && loaded.state === 'ready' && page === 'account-organizations' && <OrganizationManagementPage items={loaded.value as AdminOrganization[]} api={api} role={effectiveRole} onAction={showAction} />}
        {loaded.page === page && loaded.state === 'ready' && page === 'account-roles' && <RolesPage api={api} role={effectiveRole} />}
        {loaded.page === page && loaded.state === 'ready' && page === 'account-projects' && <ProjectsPage items={loaded.value as AdminProject[]} api={api} role={effectiveRole} onAction={showAction} />}
        {loaded.page === page && loaded.state === 'ready' && page === 'projects' && <ProjectManagementPage key={routeRevision} items={loaded.value as AdminProject[]} api={api} role={effectiveRole} onAction={showAction} route={readAdminRoute()} />}
        {loaded.page === page && loaded.state === 'ready' && page === 'account-audit' && <AuthorizationAuditPage items={loaded.value as AuthorizationAudit[]} api={api} role={effectiveRole} workbenchFilter={workbenchFilter} />}
        {loaded.page === page && loaded.state === 'ready' && page === 'telemetry-overview' && <TelemetryOverviewPage api={api} />}
        {loaded.page === page && loaded.state === 'ready' && page === 'telemetry-project' && <TelemetryProjectPage api={api} />}
        {loaded.page === page && loaded.state === 'ready' && page === 'telemetry-events' && <TelemetryEventsPage api={api} workbenchFilter={workbenchFilter} />}
        {loaded.page === page && loaded.state === 'ready' && page === 'cloud-profiles' && <CloudProfilesPage api={api} onAction={showAction} focus={cloudFocus} />}
        {loaded.page === page && loaded.state === 'ready' && page === 'cloud-types' && <CloudTypesPage api={api} onAction={showAction} />}
        {loaded.page === page && loaded.state === 'ready' && page === 'cloud-ops' && <CloudOpsPage api={api} onAction={showAction} onNavigate={jumpAlongRelationChain} focus={cloudFocus} />}
        {loaded.page === page && loaded.state === 'ready' && page === 'cloud-runs' && <CloudRunsPage api={api} onAction={showAction} onNavigate={jumpAlongRelationChain} focus={cloudFocus} />}
        {loaded.page === page && loaded.state === 'ready' && page === 'cloud-audits' && <CloudAuditsPage api={api} onAction={showAction} focus={cloudFocus} />}
      </main>
    </div>
  )
}

type ProjectTab = 'overview' | 'members' | 'assets' | 'agents' | 'workspaces' | 'audit'
type AdminRoute = {
  readonly page: PageId
  readonly projectId?: string
  readonly tab?: ProjectTab
  /** 关系链跳转恢复的对象上下文（仅云工作空间目标页使用）。 */
  readonly focus?: CloudRelationFocus
  /** 工作台指标跳转保留的过滤条件（§6.1：点击后进入的就是这个视图）。 */
  readonly workbenchFilter?: WorkbenchFilter
}

/** 工作台指标可跳转的目标页。 */
const WORKBENCH_TARGET_PAGES: readonly PageId[] = ['reviews', 'cloud-runs', 'cloud-ops', 'cloud-profiles', 'directory', 'account-audit', 'telemetry-events']

function parseWorkbenchTarget(value: string | null): PageId | undefined {
  return WORKBENCH_TARGET_PAGES.find(page => page === value)
}

/** 读取 URL 中的工作台保留过滤；四个键全空时没有过滤。 */
function readWorkbenchFilter(search: URLSearchParams): WorkbenchFilter | undefined {
  const status = search.get('status')
  const readiness = search.get('readiness')
  const from = search.get('from')
  const to = search.get('to')
  const filter: WorkbenchFilter = {
    ...(status === null || status === '' ? {} : { status }),
    ...(readiness === null || readiness === '' ? {} : { readiness }),
    ...(from === null || from === '' ? {} : { from }),
    ...(to === null || to === '' ? {} : { to }),
  }
  return Object.keys(filter).length === 0 ? undefined : filter
}

/** 工作台跳转写入 URL：刷新与浏览器后退都能恢复目标页与保留的过滤。 */
function navigateWorkbenchRoute(page: PageId, filter: WorkbenchFilter): void {
  if (typeof window === 'undefined') return
  const params = new URLSearchParams()
  params.set('page', page)
  if (filter.status !== undefined) params.set('status', filter.status)
  if (filter.readiness !== undefined) params.set('readiness', filter.readiness)
  if (filter.from !== undefined) params.set('from', filter.from)
  if (filter.to !== undefined) params.set('to', filter.to)
  const next = `/?${params.toString()}`
  if (`${window.location.pathname}${window.location.search}` !== next) window.history.pushState({}, '', next)
}

/** 可携带关系链上下文的云工作空间页面。 */
function parseCloudPage(value: string | null): PageId | undefined {
  switch (value) {
    case 'cloud-types':
    case 'cloud-profiles':
    case 'cloud-ops':
    case 'cloud-runs':
    case 'cloud-audits':
      return value
    default:
      return undefined
  }
}

/** 读取 URL 中的关系链上下文；四个键全空时没有上下文。 */
function readRelationFocus(search: URLSearchParams): CloudRelationFocus | undefined {
  const workspaceId = search.get('workspaceId')
  const runId = search.get('runId')
  const agentProfileVersionId = search.get('agentProfileVersionId')
  const requestId = search.get('requestId')
  const focus: CloudRelationFocus = {
    ...(workspaceId === null || workspaceId === '' ? {} : { workspaceId }),
    ...(runId === null || runId === '' ? {} : { runId }),
    ...(agentProfileVersionId === null || agentProfileVersionId === '' ? {} : { agentProfileVersionId }),
    ...(requestId === null || requestId === '' ? {} : { requestId }),
  }
  return Object.keys(focus).length === 0 ? undefined : focus
}

function readAdminRoute(): AdminRoute {
  if (typeof window === 'undefined') return { page: 'directory' }
  const search = new URLSearchParams(window.location.search)
  const pathname = window.location.pathname.replace(/\/$/u, '') || '/'
  if (pathname === '/projects') return { page: 'projects' }
  if (pathname.startsWith('/projects/')) {
    const projectId = decodeURIComponent(pathname.slice('/projects/'.length))
    const tab = parseProjectTab(search.get('tab'))
    return projectId.length === 0 ? { page: 'projects' } : { page: 'projects', projectId, ...(tab === undefined ? {} : { tab }) }
  }
  if (pathname === '/knowledge-bases' || pathname.startsWith('/knowledge-bases/')) return { page: 'knowledge-bases' }
  // 关系链目标页由查询参数承载：刷新与浏览器后退都能恢复到同一页面与对象。
  const workbenchFilter = readWorkbenchFilter(search)
  const workbenchTarget = parseWorkbenchTarget(search.get('page'))
  if (workbenchTarget !== undefined && workbenchFilter !== undefined) {
    return { page: workbenchTarget, workbenchFilter }
  }
  const focusPage = parseCloudPage(search.get('page'))
  if (focusPage !== undefined) {
    const focus = readRelationFocus(search)
    return { page: focusPage, ...(focus === undefined ? {} : { focus }) }
  }
  return { page: 'directory' }
}

function parseProjectTab(value: string | null): ProjectTab | undefined {
  return value === 'overview' || value === 'members' || value === 'assets' || value === 'agents' || value === 'workspaces' || value === 'audit'
    ? value
    : undefined
}
function navigateProjectRoute(projectId?: string, tab: ProjectTab = 'overview'): void {
  if (typeof window === 'undefined') return
  const path = projectId === undefined ? '/projects' : `/projects/${encodeURIComponent(projectId)}`
  const query = projectId !== undefined && tab !== 'overview' ? `?tab=${encodeURIComponent(tab)}` : ''
  const next = `${path}${query}`
  if (`${window.location.pathname}${window.location.search}` !== next) window.history.pushState({}, '', next)
}

/** 关系链跳转写入 URL：刷新与浏览器后退都能恢复目标页与对象上下文。 */
function navigateCloudRoute(page: PageId, focus: CloudRelationFocus): void {
  if (typeof window === 'undefined') return
  const params = new URLSearchParams()
  params.set('page', page)
  for (const key of ['workspaceId', 'runId', 'agentProfileVersionId', 'requestId'] as const) {
    const value = focus[key]
    if (value !== undefined && value !== '') params.set(key, value)
  }
  const next = `/?${params.toString()}`
  if (`${window.location.pathname}${window.location.search}` !== next) window.history.pushState({}, '', next)
}

async function loadPage(
  api: TeamSkillApi,
  page: PageId,
  role: AccountRole,
  workbenchFilter?: WorkbenchFilter,
): Promise<ApiResult<readonly unknown[]>> {
  if (page === 'workbench') {
    const to = new Date()
    const from = new Date(to.getTime() - 7 * 24 * 3600 * 1000)
    const range = { from: from.toISOString(), to: to.toISOString() }
    const [overview, reviews, skills, projects] = await Promise.all([
      api.getTelemetryOverview(range),
      api.listReviews(),
      api.listSkills(),
      api.listProjects(),
    ])
    if (!overview.ok) return { ok: false, error: overview.error }
    if (!reviews.ok) return { ok: false, error: reviews.error }
    if (!skills.ok) return { ok: false, error: skills.error }
    if (!projects.ok) return { ok: false, error: projects.error }
    return { ok: true, value: [overview.value, reviews.value, skills.value, projects.value] }
  }
  if (page === 'directory' || page === 'drafts' || page === 'releases') return api.listSkills()
  if (page === 'reviews') return api.listReviews()
  if (page === 'audit') return api.listAuditLogs()
  if (page === 'knowledge-bases') return api.listKnowledgeBases()
  if (page === 'memory-library' && role === 'member')
    return Promise.resolve({
      ok: false,
      error: {
        kind: 'forbidden',
        code: 'MEMORY_ADMIN_FORBIDDEN',
        message: '成员不能访问后台记忆库治理',
      },
    })
  if (page === 'memory-library') {
    // 渲染门由真实治理读取决定：先解析项目上下文，再读取该项目的记忆列表。
    // 读取失败返回错误（框架呈现失败态）；空 items 是服务端确认的真实空数据。
    const projects = role === 'member' ? await api.listMemoryProjects() : await api.listProjects()
    if (!projects.ok) return { ok: false, error: projects.error }
    if (projects.value.length === 0) return { ok: true, value: [] }
    const records = await api.listMemoryRecords({ projectId: projects.value[0].project_id })
    if (!records.ok) return { ok: false, error: records.error }
    return { ok: true, value: records.value.items }
  }
  if (page.startsWith('telemetry-') && role === 'member')
    return Promise.resolve({
      ok: false,
      error: {
        kind: 'forbidden',
        code: 'ROLE_FORBIDDEN',
        message: '成员角色不开放团队可观测页面',
      },
    })
  if (page.startsWith('telemetry-')) {
    // 渲染门读取与页面自身主读取同源：总览读聚合；项目详情与事件诊断先解析
    // 项目上下文再读各自端点。没有授权项目时是真实读取后的空，不是伪造 ready。
    if (page === 'telemetry-overview') {
      const overview = await api.getTelemetryOverview(telemetryWindowDefaults())
      if (!overview.ok) return { ok: false, error: overview.error }
      return { ok: true, value: [overview.value] }
    }
    const projects = await api.listProjects()
    if (!projects.ok) return { ok: false, error: projects.error }
    if (projects.value.length === 0) return { ok: true, value: [] }
    const projectId = projects.value[0].project_id
    if (page === 'telemetry-project') {
      const summary = await api.getProjectTelemetrySummary(projectId, telemetryWindowDefaults())
      if (!summary.ok) return { ok: false, error: summary.error }
      return { ok: true, value: [summary.value] }
    }
    const events = await api.listProjectTelemetryEvents(projectId, telemetryWindowDefaults())
    if (!events.ok) return { ok: false, error: events.error }
    return { ok: true, value: events.value.items }
  }
  if (page === 'account-users') return api.listUsers()
  if (page === 'account-organizations') return api.listOrganizations()
  if (page === 'account-projects') {
    return Promise.all([api.listProjects(), api.listProjects({ status: 'archived' })]).then(([active, archived]) => {
      if (!active.ok) return active
      if (!archived.ok) return archived
      const rows = new Map(active.value.map(item => [item.project_id, item]))
      for (const item of archived.value) rows.set(item.project_id, item)
      return { ok: true, value: [...rows.values()] }
    })
  }
  if (page === 'projects') return api.listProjects()
  if (page === 'account-audit') return api.listAuthorizationAudits()
  // 云工作空间五页的渲染门读取各自的治理列表端点；返回值同时是页面的初始数据。
  if (page === 'cloud-types') return api.cloudAgentTypes()
  if (page === 'cloud-profiles') {
    return api.cloudAgentProfiles(workbenchFilter === undefined ? {} : {
      ...(workbenchFilter.readiness === undefined ? {} : { readiness: workbenchFilter.readiness }),
      ...(workbenchFilter.status === undefined ? {} : { status: workbenchFilter.status }),
    })
  }
  if (page === 'cloud-ops') {
    return api.cloudWorkspaces(workbenchFilter?.status === undefined ? {} : { status: workbenchFilter.status })
  }
  if (page === 'cloud-runs') {
    return api.cloudRuns(workbenchFilter === undefined ? {} : {
      ...(workbenchFilter.status === undefined ? {} : { status: workbenchFilter.status }),
      ...(workbenchFilter.from === undefined ? {} : { from: workbenchFilter.from }),
      ...(workbenchFilter.to === undefined ? {} : { to: workbenchFilter.to }),
    })
  }
  if (page === 'cloud-audits') return api.cloudAudits()
  return api.listRoles()
}

function pageLabel(page: PageId): string {
  return [...NAV, ...KNOWLEDGE_NAV, ...MEMORY_NAV, ...PROJECT_NAV, ...PERMISSION_NAV, ...TELEMETRY_NAV, ...WORKSPACE_NAV, ...SETTINGS_NAV, ...WORKBENCH_PAGE_NAV].find(item => item.id === page)?.label ?? (page === 'memory-library' ? '记忆列表、策略、任务与审计' : '管理后台')
}
function roleLabel(role: AccountRole): string {
  return role === 'admin' ? '平台管理员' : role === 'manager' ? '组织经理' : '成员'
}

function roleScopeLabel(scope: string): string {
  return scope === 'platform' ? '平台' : scope === 'organization' ? '组织' : scope === 'assigned' ? '已分配资源' : scope
}

function roleDescription(role: AccountRole, description: string): string {
  if (description.trim().length > 0) return description
  return role === 'admin' ? '管理平台全部组织、账号和项目' : role === 'manager' ? '管理自己组织内的账号和项目' : '使用被分配的组织、项目和资源'
}

function projectStatusLabel(status: AdminProject['status']): string {
  return status === 'draft' ? '草稿' : status === 'active' ? '正常' : '已归档'
}

function permissionKeyLabel(key: string): string {
  return key === 'organization.read'
    ? '组织查看'
    : key === 'user.manage'
      ? '账号与成员管理'
      : key === 'project.manage'
        ? '项目管理'
        : key === 'authorization_audit.read'
          ? '授权审计查看'
          : key
}

/** 权限模拟器 + 继承链抽屉（§6.3/§11.19）：只读评估，不产生写操作。 */
function UserPermissionDrawer({ api, user, projects, onClose }: {
  readonly api: TeamSkillApi
  readonly user: AdminUser
  readonly projects: readonly AdminProject[]
  readonly onClose: () => void
}): ReactElement {
  const [projectId, setProjectId] = useState(projects[0]?.project_id ?? '')
  const [action, setAction] = useState('workspace.read')
  const [chain, setChain] = useState<ReturnType<typeof buildPermissionChain> | undefined>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>()

  const run = async (): Promise<void> => {
    if (projectId.length === 0) return
    setBusy(true)
    setError(undefined)
    const result = await api.permissionCheck({ action, project_id: projectId, simulate_user_id: user.user_id })
    const mapped = permissionResultFromApi(result)
    setBusy(false)
    if (mapped === undefined) {
      setError('服务端未返回有效的权限判定')
      return
    }
    setChain(buildPermissionChain(mapped, projects.find(project => project.project_id === projectId)?.name ?? projectId))
  }

  return (
    <div className="detail-overlay" role="dialog" aria-label="权限详情" onClick={onClose}>
      <div className="detail-panel" onClick={(event) => { event.stopPropagation() }}>
        <div className="detail-head">
          <h3 className="detail-title">{`权限详情：${user.display_name}`}</h3>
          <button type="button" className="detail-close" onClick={onClose} aria-label="关闭权限详情">关闭</button>
        </div>
        <dl className="workbench-facts">
          <div><dt>账号</dt><dd>{user.username}</dd></div>
          <div><dt>全局角色</dt><dd>{user.global_role}</dd></div>
          <div><dt>状态</dt><dd>{user.status}</dd></div>
        </dl>
        <p className="state-line">权限模拟器：以被选用户身份做只读评估（§11.19），不产生写操作。</p>
        <div className="account-toolbar">
          <label>
            项目
            <select value={projectId} onChange={(event) => { setProjectId(event.target.value) }}>
              {projects.map(project => (
                <option key={project.project_id} value={project.project_id}>{project.name}</option>
              ))}
            </select>
          </label>
          <label>
            动作
            <select value={action} onChange={(event) => { setAction(event.target.value) }}>
              <option value="workspace.read">workspace.read</option>
              <option value="workspace.write">workspace.write</option>
              <option value="admin.skill.publish">admin.skill.publish</option>
            </select>
          </label>
          <button type="button" className="button primary" disabled={busy || projectId.length === 0} onClick={() => { void run() }}>
            {busy ? '评估中…' : '运行权限模拟'}
          </button>
        </div>
        {error !== undefined && <p className="state-line" role="alert">{error}</p>}
        {chain !== undefined && (
          <ol className="workbench-list" aria-label="权限继承链">
            {chain.map(row => (
              <li key={row.layer}>
                <strong>{row.layer}</strong> · {row.verdict}
                <small>{row.detail}</small>
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  )
}

function UsersPage({
  items,
  api,
  role,
  onAction,
}: {
  readonly items: readonly AdminUser[]
  readonly api: TeamSkillApi
  readonly role: AccountRole
  readonly onAction: (result: ApiResult<unknown>, success: string) => void
}) {
  const [organizations, setOrganizations] = useState<readonly AdminOrganization[]>([])
  const [organizationId, setOrganizationId] = useState('')
  const [username, setUsername] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [newRole, setNewRole] = useState<'manager' | 'member'>('member')
  const [busyId, setBusyId] = useState<string | undefined>()
  const [initialPassword, setInitialPassword] = useState<string | undefined>()
  const [membershipTargets, setMembershipTargets] = useState<Record<string, string | undefined>>({})
  const [askConfirmation, confirmationDialog] = useConfirmDialog()
  // 批量操作（规格 §5）：仅选中行后出现，未选中不占工具栏空间。
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(new Set())
  const [batchBusy, setBatchBusy] = useState(false)
  /** §6.3 批量结果：受影响对象逐行 + 失败行稳定码。 */
  const [batchSummary, setBatchSummary] = useState<{
    readonly operation: string
    readonly summary: ReturnType<typeof summarizeBatchGrant>
  } | undefined>()
  /** §6.3 详情抽屉：当前查看的用户 id。 */
  const [drawerUserId, setDrawerUserId] = useState<string | undefined>()

  useEffect(() => {
    void api.listOrganizations().then((result) => {
      if (result.ok) {
        setOrganizations(result.value)
        if (organizationId.length === 0 && result.value.length > 0) setOrganizationId(result.value[0].organization_id)
      } else onAction(result, '读取组织失败')
    })
  }, [api, onAction, organizationId.length])
  const [projects, setProjects] = useState<readonly AdminProject[]>([])
  useEffect(() => {
    void api.listProjects().then((result) => {
      if (result.ok) setProjects(result.value)
    })
  }, [api])
  const visible =
    organizationId.length === 0
      ? items
      : items.filter(item => item.memberships?.some(membership => membership.organization_id === organizationId))
  const selectedUsers = visible.filter(user => selectedIds.has(user.user_id))
  const toggleSelected = (userId: string): void => {
    setSelectedIds((previous) => {
      const next = new Set(previous)
      if (next.has(userId)) next.delete(userId)
      else next.add(userId)
      return next
    })
  }
  const toggleAllSelected = (): void => {
    const activeIds = visible.filter(user => user.status === 'active').map(user => user.user_id)
    const allSelected = activeIds.length > 0 && activeIds.every(userId => selectedIds.has(userId))
    setSelectedIds(allSelected ? new Set() : new Set(activeIds))
  }
  const runBatchStatus = async (next: 'suspended' | 'active'): Promise<void> => {
    const targets = selectedUsers.filter(user => user.status !== next)
    if (targets.length === 0) return
    if (
      !(await askConfirmation({
        title: '确认批量操作',
        message: `${next === 'suspended' ? '停用' : '恢复'} ${targets.length} 个账号？停用后其原生会话与待确认操作全部失效。`,
        confirmLabel: next === 'suspended' ? '确认批量停用' : '确认批量恢复',
      }))
    )
      return
    setBatchBusy(true)
    // §6.3：批量结果逐行保留（受影响对象、失败行 + 稳定码），不合并计数。
    const rows: BatchGrantRow[] = []
    for (const user of targets) {
      const result = await api.updateUser(user.user_id, { status: next }, user.revision, crypto.randomUUID())
      rows.push(
        result.ok
          ? { userId: user.user_id, ok: true, code: null }
          : { userId: user.user_id, ok: false, code: 'code' in result.error ? result.error.code : result.error.kind },
      )
    }
    const summary = summarizeBatchGrant(rows)
    setBatchSummary({ operation: next === 'suspended' ? '批量停用' : '批量恢复', summary })
    setBatchBusy(false)
    setSelectedIds(new Set())
    onAction(
      summary.failures.length === 0
        ? { ok: true, value: undefined as never }
        : { ok: false, error: { kind: 'service', code: 'BATCH_PARTIAL', message: `${summary.failures.length} 个账号操作失败，其余已完成` } },
      `批量${next === 'suspended' ? '停用' : '恢复'}完成：成功 ${summary.succeeded}，失败 ${summary.failures.length}`,
    )
    // onAction 成功后由父级统一重读服务端状态。
  }
  const create = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    if (organizationId.length === 0) return
    setBusyId('create')
    setInitialPassword(undefined)
    const result = await api.createUser(
      {
        username: username.trim(),
        displayName: displayName.trim(),
        organizationIds: [organizationId],
        globalRole: newRole,
      },
      crypto.randomUUID(),
    )
    setBusyId(undefined)
    if (result.ok) {
      setUsername('')
      setDisplayName('')
      setInitialPassword(result.value.initial_password)
    }
    onAction(result, '账号已创建')
  }
  const updateStatus = async (user: AdminUser): Promise<void> => {
    const next = user.status === 'active' ? 'suspended' : 'active'
    if (
      !(await askConfirmation({
        title: '确认账号操作',
        message: `${next === 'suspended' ? '停用' : '恢复'}账号 ${user.display_name}？该账号是 ${user.memberships?.length ?? 0} 个组织的成员；停用后其原生会话与待确认操作全部失效。`,
        confirmLabel: next === 'suspended' ? '确认停用' : '确认恢复',
      }))
    )
      return
    setBusyId(user.user_id)
    const result = await api.updateUser(user.user_id, { status: next }, user.revision, crypto.randomUUID())
    setBusyId(undefined)
    onAction(result, next === 'suspended' ? '账号已停用' : '账号已恢复')
  }
  const removeMembership = async (user: AdminUser, membership: NonNullable<AdminUser['memberships']>[number]): Promise<void> => {
    if (
      !(await askConfirmation({
        title: '确认成员操作',
        message: `从 ${membership.organization_name} 移除 ${user.display_name}？`,
      }))
    )
      return
    setBusyId(`${user.user_id}-${membership.organization_id}`)
    const result = await api.removeMembership(membership.organization_id, user.user_id, membership.revision, crypto.randomUUID())
    setBusyId(undefined)
    onAction(result, '成员关系已移除')
  }
  const renameUser = async (user: AdminUser): Promise<void> => {
    const next = window.prompt('新的显示名称', user.display_name)
    if (next === null || next.trim().length === 0 || next.trim() === user.display_name) return
    setBusyId(`${user.user_id}-rename`)
    const result = await api.updateUser(user.user_id, { displayName: next.trim() }, user.revision, crypto.randomUUID())
    setBusyId(undefined)
    onAction(result, '显示名已更新')
  }
  const addMembership = async (user: AdminUser): Promise<void> => {
    const target = membershipTargets[user.user_id]
    if (target === undefined || target.length === 0) return
    setBusyId(`${user.user_id}-join`)
    const result = await api.setMembership(target, user.user_id, undefined, crypto.randomUUID())
    setBusyId(undefined)
    onAction(result, '成员关系已新增')
  }
  return (
    <>
      <section className="page-body">
        <div className="page-intro">
          <div>
            <span className="eyebrow">权限管理 / 账号</span>
            <h2>用户与成员</h2>
            <p>账号只有一个全局角色，组织成员关系只记录归属和状态。</p>
          </div>
          <span className="count-badge">{visible.length} 个账号</span>
        </div>
        <div className="account-toolbar">
          <label>
            组织
            <select
              value={organizationId}
              onChange={(event) => {
                setOrganizationId(event.target.value)
              }}
            >
              <option value="">全部可见组织</option>
              {organizations.map(item => (
                <option key={item.organization_id} value={item.organization_id}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
          <form className="inline-create" onSubmit={event => void create(event)}>
            <input
              aria-label="新账号用户名"
              placeholder="新账号邮箱"
              value={username}
              onChange={(event) => {
                setUsername(event.target.value)
              }}
              required
            />
            <input
              aria-label="新账号显示名"
              placeholder="显示名称"
              value={displayName}
              onChange={(event) => {
                setDisplayName(event.target.value)
              }}
              required
            />
            <select
              aria-label="新账号角色"
              value={newRole}
              onChange={(event) => {
                setNewRole(event.target.value as 'manager' | 'member')
              }}
            >
              <option value="member">member</option>
              {role === 'admin' && <option value="manager">manager</option>}
            </select>
            <button className="button primary" disabled={busyId === 'create' || organizationId.length === 0}>
              <Plus size={16} />
              创建账号
            </button>
          </form>
        </div>
        {initialPassword !== undefined && (
          <div className="one-time-secret" role="status">
            <strong>一次性初始密码</strong>
            <code>{initialPassword}</code>
            <span>只显示这一次，请通过安全渠道交付。</span>
            <button
              type="button"
              className="button"
              onClick={() => {
                // Hide first: the password must disappear even if the
                // clipboard write is unavailable or rejected.
                const text = initialPassword
                setInitialPassword(undefined)
                try {
                  // jsdom 与部分宿主不提供 clipboard：复制失败不影响隐藏。
                  void navigator.clipboard.writeText(text).catch(() => undefined)
                } catch {
                  // clipboard 不可用时仅隐藏，不阻塞账号创建流程。
                }
              }}
            >
              复制并隐藏
            </button>
          </div>
        )}
        {selectedIds.size > 0 && (
          <div className="batch-bar" role="toolbar" aria-label="批量操作" data-batch-busy={batchBusy || undefined}>
            <span>已选 {selectedIds.size} 项</span>
            <button type="button" className="button danger" disabled={batchBusy} onClick={() => void runBatchStatus('suspended')}>批量停用</button>
            <button type="button" className="button secondary" disabled={batchBusy} onClick={() => void runBatchStatus('active')}>批量恢复</button>
            <button type="button" className="button secondary" disabled={batchBusy} onClick={() => { setSelectedIds(new Set()) }}>清除选择</button>
          </div>
        )}
        {batchSummary !== undefined && (
          <div className="permission-denied" role="status" aria-label="批量操作结果">
            <strong>{`${batchSummary.operation}结果：受影响 ${batchSummary.summary.affected} 个，成功 ${batchSummary.summary.succeeded} 个`}</strong>
            {batchSummary.summary.failures.length > 0 ? (
              <ul>
                {batchSummary.summary.failures.map(row => (
                  <li key={row.userId}>{`失败：用户 ${row.userId}（${row.code ?? '未知错误'}）`}</li>
                ))}
              </ul>
            ) : (
              <p>没有失败项。</p>
            )}
            <small>每行操作的审计结果可在「账号审计」页按操作者与时间核对。</small>
          </div>
        )}
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th className="batch-cell">
                  <input
                    type="checkbox"
                    aria-label="全选可批量操作的账号"
                    checked={visible.some(user => user.status === 'active') && visible.filter(user => user.status === 'active').every(user => selectedIds.has(user.user_id))}
                    onChange={toggleAllSelected}
                  />
                </th>
                <th>账号</th>
                <th>全局角色 / 组织</th>
                <th>状态</th>
                <th>修订</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {visible.map(user => (
                <tr key={user.user_id} className={selectedIds.has(user.user_id) ? 'batch-selected' : undefined}>
                  <td className="batch-cell">
                    <input
                      type="checkbox"
                      aria-label={`选择 ${user.display_name}`}
                      checked={selectedIds.has(user.user_id)}
                      onChange={() => { toggleSelected(user.user_id) }}
                    />
                  </td>
                  <td>
                    <strong>{user.display_name}</strong>
                    <small>{user.username}</small>
                  </td>
                  <td>
                    <strong>{user.global_role}</strong>
                    {user.memberships?.map(membership => (
                      <div className="membership-row" key={membership.organization_id}>
                        <span>
                          {membership.organization_name} · {membership.status === 'active' ? '正常' : '已停用'}
                        </span>
                        <button type="button" className="text-danger" onClick={() => void removeMembership(user, membership)}>
                          移除
                        </button>
                      </div>
                    )) ?? '未加入组织'}
                  </td>
                  <td>
                    <span className={`status status-${user.status}`}>{user.status === 'active' ? '正常' : '已停用'}</span>
                    {user.must_change_password && <small>待首次改密</small>}
                  </td>
                  <td className="revision">r{user.revision}</td>
                  <td>
                    <div className="membership-row">
                      <button type="button" className="button secondary" disabled={busyId === user.user_id} onClick={() => void updateStatus(user)}>
                        {user.status === 'active' ? '停用' : '恢复'}
                      </button>
                      <button type="button" className="button secondary" onClick={() => { setDrawerUserId(user.user_id) }}>权限详情</button>
                      <button type="button" className="button secondary" disabled={busyId === `${user.user_id}-rename`} onClick={() => void renameUser(user)}>
                        编辑显示名
                      </button>
                    </div>
                    <div className="membership-row">
                      <select
                        aria-label={`为 ${user.display_name} 新增组织`}
                        value={membershipTargets[user.user_id] ?? ''}
                        onChange={(event) => {
                          setMembershipTargets(current => ({
                            ...current,
                            [user.user_id]: event.target.value,
                          }))
                        }}
                      >
                        <option value="">选择组织</option>
                        {organizations
                          .filter(organization => !user.memberships?.some(item => item.organization_id === organization.organization_id))
                          .map(organization => (
                            <option key={organization.organization_id} value={organization.organization_id}>
                              {organization.name}
                            </option>
                          ))}
                      </select>
                      <button type="button" className="button secondary" disabled={(membershipTargets[user.user_id] ?? '').length === 0 || busyId === `${user.user_id}-join`} onClick={() => void addMembership(user)}>
                        新增组织成员
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {visible.length === 0 && <Empty text="当前范围没有可见账号" />}
        </div>
        {drawerUserId !== undefined && (() => {
          const drawerUser = visible.find(user => user.user_id === drawerUserId)
          return drawerUser === undefined ? null : (
            <UserPermissionDrawer
              api={api}
              user={drawerUser}
              projects={projects}
              onClose={() => { setDrawerUserId(undefined) }}
            />
          )
        })()}
      </section>
      {confirmationDialog}
    </>
  )
}

/** Organization lifecycle, rename, archive and manager binding for platform administrators. */
function OrganizationManagementPage({
  items,
  api,
  role,
  onAction,
}: {
  readonly items: readonly AdminOrganization[]
  readonly api: TeamSkillApi
  readonly role: AccountRole
  readonly onAction: (result: ApiResult<unknown>, success: string) => void
}) {
  const [name, setName] = useState('')
  const [managerUserId, setManagerUserId] = useState('')
  const [busyId, setBusyId] = useState<string | undefined>()
  const [managerTargets, setManagerTargets] = useState<Record<string, string | undefined>>({})
  const [managers, setManagers] = useState<readonly AdminUser[]>([])
  const [askConfirmation, confirmationDialog] = useConfirmDialog()
  const canManage = role === 'admin'

  useEffect(() => {
    void api.listUsers().then((result) => {
      if (result.ok) setManagers(result.value.filter(user => user.global_role === 'manager'))
      else onAction(result, '读取经理列表失败')
    })
  }, [api, onAction])

  const create = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    if (name.trim().length === 0) return
    setBusyId('create')
    const result = await api.createOrganization(name.trim(), managerUserId.length === 0 ? undefined : managerUserId, crypto.randomUUID())
    setBusyId(undefined)
    if (result.ok) {
      setName('')
      setManagerUserId('')
    }
    onAction(result, '组织已创建')
  }
  const rename = async (organization: AdminOrganization): Promise<void> => {
    const next = window.prompt('新的组织名称', organization.name)
    if (next === null || next.trim().length === 0 || next.trim() === organization.name) return
    setBusyId(organization.organization_id + '-rename')
    const result = await api.updateOrganization(
      organization.organization_id,
      { name: next.trim() },
      organization.revision,
      crypto.randomUUID(),
    )
    setBusyId(undefined)
    onAction(result, '组织名称已更新')
  }
  const setStatus = async (organization: AdminOrganization, status: 'active' | 'archived'): Promise<void> => {
    if (
      !(await askConfirmation({
        title: '确认组织操作',
        message: (status === 'archived' ? '归档组织 ' + organization.name + '？归档后组织内项目与成员关系转为只读；受影响项目、Workspace、Profile 与运行的汇总数量服务未提供。' : '恢复组织 ' + organization.name + '？'),
        confirmLabel: status === 'archived' ? '确认归档' : '确认恢复',
      }))
    )
      return
    setBusyId(organization.organization_id + '-status')
    const result = await api.updateOrganization(organization.organization_id, { status }, organization.revision, crypto.randomUUID())
    setBusyId(undefined)
    onAction(result, status === 'archived' ? '组织已归档' : '组织已恢复')
  }
  const bindManager = async (organization: AdminOrganization): Promise<void> => {
    const managerId = managerTargets[organization.organization_id]
    if (managerId === undefined || managerId.length === 0) return
    setBusyId(organization.organization_id + '-manager')
    const result = await api.setMembership(organization.organization_id, managerId, undefined, crypto.randomUUID())
    setBusyId(undefined)
    onAction(result, '经理已绑定到组织')
  }

  return (
    <>
      <section className="page-body">
        <div className="page-intro">
          <div>
            <span className="eyebrow">权限管理 / 组织</span>
            <h2>组织管理</h2>
            <p>组织生命周期与经理绑定由服务端 revision 和幂等键保护。</p>
          </div>
          <span className="count-badge">{items.length} 个组织</span>
        </div>
        {canManage ? (
          <form
            className="account-toolbar"
            onSubmit={(event) => {
              void create(event)
            }}
          >
            <input
              aria-label="新组织名称"
              placeholder="组织名称"
              value={name}
              onChange={(event) => {
                setName(event.target.value)
              }}
              required
            />
            <select
              aria-label="新组织经理"
              value={managerUserId}
              onChange={(event) => {
                setManagerUserId(event.target.value)
              }}
            >
              <option value="">暂不绑定经理</option>
              {managers.map(manager => (
                <option key={manager.user_id} value={manager.user_id}>
                  {manager.display_name}
                </option>
              ))}
            </select>
            <button className="button primary" disabled={busyId === 'create' || name.trim().length === 0}>
              <Plus size={16} />
              创建组织
            </button>
          </form>
        ) : (
          <p className="page-hint">组织生命周期操作仅平台管理员可用。</p>
        )}
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>组织</th>
                <th>状态</th>
                <th>修订</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {items.map(organization => (
                <tr key={organization.organization_id}>
                  <td>
                    <strong>{organization.name}</strong>
                    <small>{organization.organization_id}</small>
                  </td>
                  <td>
                    <span className={'status status-' + (organization.status === 'active' ? 'active' : 'archived')}>{organization.status === 'active' ? '正常' : '已归档'}</span>
                  </td>
                  <td className="revision">r{organization.revision}</td>
                  <td>
                    {canManage && (
                      <div className="membership-row">
                        <button type="button" className="button secondary" disabled={busyId === organization.organization_id + '-rename'} onClick={() => void rename(organization)}>
                          重命名
                        </button>
                        <button type="button" className="button secondary" disabled={busyId === organization.organization_id + '-status'} onClick={() => void setStatus(organization, organization.status === 'active' ? 'archived' : 'active')}>
                          {organization.status === 'active' ? '归档' : '恢复'}
                        </button>
                      </div>
                    )}
                    {canManage && (
                      <div className="membership-row">
                        <select
                          aria-label={'为 ' + organization.name + ' 绑定经理'}
                          value={managerTargets[organization.organization_id] ?? ''}
                          onChange={(event) => {
                            setManagerTargets(current => ({
                              ...current,
                              [organization.organization_id]: event.target.value,
                            }))
                          }}
                        >
                          <option value="">选择经理账号</option>
                          {managers
                            .filter(manager => !manager.memberships?.some(item => item.organization_id === organization.organization_id && item.status === 'active'))
                            .map(manager => (
                              <option key={manager.user_id} value={manager.user_id}>
                                {manager.display_name}
                              </option>
                            ))}
                        </select>
                        <button type="button" className="button secondary" disabled={(managerTargets[organization.organization_id] ?? '').length === 0 || busyId === organization.organization_id + '-manager'} onClick={() => void bindManager(organization)}>
                          绑定经理
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {items.length === 0 && <Empty text="当前没有可见组织" />}
        </div>
      </section>
      {confirmationDialog}
    </>
  )
}

function RolesPage({ api, role }: { readonly api: TeamSkillApi; readonly role: AccountRole }) {
  const [roles, setRoles] = useState<readonly RoleDefinition[]>([])
  const [permissions, setPermissions] = useState<readonly PermissionDefinition[]>([])
  const [error, setError] = useState<string | undefined>()
  useEffect(() => {
    void Promise.all([api.listRoles(), api.listPermissions()]).then(([roleResult, permissionResult]) => {
      if (!roleResult.ok || !permissionResult.ok) {
        setError('无法读取服务端角色字典')
        return
      }
      setRoles(roleResult.value)
      setPermissions(permissionResult.value)
    })
  }, [api])
  return (
    <section className="page-body">
      <div className="page-intro">
        <div>
          <span className="eyebrow">权限管理 / 角色</span>
          <h2>角色与权限</h2>
          <p>角色和权限矩阵只读展示服务端配置，当前登录角色：{roleLabel(role)}。</p>
        </div>
      </div>
      {error !== undefined ? (
        <section className="state-panel error">
          <TriangleAlert size={20} />
          <h2>{error}</h2>
        </section>
      ) : (
        <div className="role-layout">
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>角色</th>
                  <th>作用域</th>
                  <th>说明</th>
                </tr>
              </thead>
              <tbody>
                {roles.map(item => (
                  <tr key={item.role}>
                    <td>
                      <strong>{roleLabel(item.role)}</strong>
                    </td>
                    <td>{roleScopeLabel(item.scope)}</td>
                    <td>{roleDescription(item.role, item.description)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>权限键</th>
                  <th>admin</th>
                  <th>manager</th>
                  <th>member</th>
                </tr>
              </thead>
              <tbody>
                {permissions.map(item => (
                  <tr key={item.key}>
                    <td>
                      <code>{item.key}</code>
                      <small>{permissionKeyLabel(item.key)}</small>
                    </td>
                    <td>{permissionLabel(item.admin)}</td>
                    <td>{permissionLabel(item.manager)}</td>
                    <td>{permissionLabel(item.member)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </section>
  )
}

function permissionLabel(value: boolean | 'organization'): string {
  return value === true ? '平台' : value === 'organization' ? '组织' : '无'
}

function ProjectManagementPage({
  items,
  api,
  role,
  onAction,
  route,
}: {
  readonly items: readonly AdminProject[]
  readonly api: TeamSkillApi
  readonly role: AccountRole
  readonly onAction: (result: ApiResult<unknown>, success: string) => void
  readonly route: AdminRoute
}) {
  const [organizations, setOrganizations] = useState<readonly AdminOrganization[]>([])
  const [organizationId, setOrganizationId] = useState('')
  const [filterOrganizationId, setFilterOrganizationId] = useState('')
  const [status, setStatus] = useState<'' | AdminProject['status']>('')
  const [query, setQuery] = useState('')
  const [selectedId, setSelectedId] = useState<string | undefined>(route.projectId)
  const [detail, setDetail] = useState<AdminProject | undefined>()
  const [tab, setTab] = useState<ProjectTab>(route.tab ?? 'overview')
  const [loadingDetail, setLoadingDetail] = useState(false)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [creating, setCreating] = useState(false)
  const [transitionAction, setTransitionAction] = useState<'activate' | 'archive'>()
  const [transitionBusy, setTransitionBusy] = useState(false)
  const [rows, setRows] = useState<readonly AdminProject[]>(items)
  const listGeneration = useRef(0)
  const detailGeneration = useRef(0)

  useEffect(() => {
    void api.listOrganizations().then((result) => {
      if (result.ok) {
        setOrganizations(result.value)
        if (organizationId.length === 0 && result.value.length > 0) setOrganizationId(result.value[0].organization_id)
      } else onAction(result, '读取组织失败')
    })
  }, [api, onAction, organizationId.length])
  useEffect(() => {
    setRows(items)
  }, [items])
  useEffect(() => {
    const generation = ++listGeneration.current
    const timer = window.setTimeout(() => {
      void api
        .listProjects({
          ...(filterOrganizationId.length === 0 ? {} : { organizationId: filterOrganizationId }),
          ...(status === '' ? {} : { status }),
          ...(query.trim().length === 0 ? {} : { name: query.trim() }),
        })
        .then((result) => {
          if (result.ok && generation === listGeneration.current) setRows(result.value)
        })
    }, 0)
    return () => {
      window.clearTimeout(timer)
    }
  }, [api, filterOrganizationId, query, status])
  useEffect(() => {
    const generation = ++detailGeneration.current
    if (selectedId === undefined) {
      setDetail(undefined)
      return
    }
    setLoadingDetail(true)
    void api.getProject(selectedId).then((result) => {
      if (generation !== detailGeneration.current) return
      setLoadingDetail(false)
      if (result.ok) {
        setDetail(result.value)
        setName(result.value.name)
        setDescription(result.value.description ?? '')
      } else onAction(result, '读取项目详情失败')
    })
  }, [api, items, onAction, selectedId])
  const create = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    if (organizationId.length === 0 || name.trim().length === 0) return
    setCreating(true)
    const result = await api.createProject({ organizationId, name: name.trim(), description: description.trim() }, crypto.randomUUID())
    setCreating(false)
    onAction(result, '项目草稿已创建')
    if (result.ok) {
      setSelectedId(result.value.project_id)
      setTab('overview')
      navigateProjectRoute(result.value.project_id)
    }
  }
  const filtered = rows
  const save = async (): Promise<void> => {
    if (detail === undefined) return
    const result = await api.updateProject(
      detail.project_id,
      { name: name.trim(), description: description.trim() },
      detail.revision,
      crypto.randomUUID(),
    )
    onAction(result, '项目已保存')
    if (result.ok) setDetail(result.value)
  }
  /** 归档前依赖摘要（§6.4）：点归档时读取四类依赖，摘要进确认对话框。 */
  const [archiveDependencyMessage, setArchiveDependencyMessage] = useState<string | undefined>()
  const transition = (action: 'activate' | 'archive'): void => {
    if (detail === undefined) return
    if (action === 'archive') {
      setArchiveDependencyMessage('正在读取依赖…')
      void (async (): Promise<void> => {
        const degraded = async <T,>(promise: Promise<ApiResult<readonly T[]>>): Promise<readonly T[] | undefined> => {
          const result = await promise
          return result.ok ? result.value : undefined
        }
        const [workspaces, profiles, members, assets] = await Promise.all([
          degraded(api.cloudWorkspaces({ projectId: detail.project_id })),
          degraded(api.cloudAgentProfiles({ projectId: detail.project_id })),
          degraded(api.listProjectMembers(detail.project_id)),
          degraded(api.listProjectAssets(detail.project_id)),
        ])
        setArchiveDependencyMessage(buildDependencySummary({ workspaces, profiles, members, assets }).message)
        setTransitionAction('archive')
      })()
      return
    }
    setArchiveDependencyMessage(undefined)
    setTransitionAction(action)
  }
  const confirmTransition = async (): Promise<void> => {
    if (detail === undefined || transitionAction === undefined) return
    setTransitionBusy(true)
    const result = transitionAction === 'activate' ? await api.activateProject(detail.project_id, detail.revision, crypto.randomUUID()) : await api.archiveProject(detail.project_id, detail.revision, crypto.randomUUID())
    setTransitionBusy(false)
    setTransitionAction(undefined)
    onAction(result, transitionAction === 'activate' ? '项目已激活' : '项目已归档')
    if (result.ok) setDetail(result.value)
  }
  const selectProject = (projectId: string): void => {
    setSelectedId(projectId)
    setTab('overview')
    navigateProjectRoute(projectId)
  }
  const selectTab = (next: ProjectTab): void => {
    setTab(next)
    if (selectedId !== undefined) navigateProjectRoute(selectedId, next)
  }
  return (
    <>
      <section className="page-body">
        <div className="page-intro">
          <div>
            <span className="eyebrow">项目管理</span>
            <h2>项目列表</h2>
            <p>{roleLabel(role)}可在服务端授权范围内管理项目资源和生命周期。</p>
          </div>
          <span className="count-badge">{filtered.length} 个项目</span>
        </div>
        <div className="account-toolbar">
          <label>
            组织
            <select
              aria-label="项目组织筛选"
              value={filterOrganizationId}
              onChange={(event) => {
                setFilterOrganizationId(event.target.value)
              }}
            >
              <option value="">全部可见组织</option>
              {organizations.map(item => (
                <option key={item.organization_id} value={item.organization_id}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            状态
            <select
              aria-label="项目状态筛选"
              value={status}
              onChange={(event) => {
                setStatus(event.target.value as '' | AdminProject['status'])
              }}
            >
              <option value="">默认：草稿和正常</option>
              <option value="draft">草稿</option>
              <option value="active">正常</option>
              <option value="archived">已归档</option>
            </select>
          </label>
          <label>
            名称
            <input
              aria-label="项目名称筛选"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value)
              }}
              placeholder="搜索项目名称"
            />
          </label>
          <form className="inline-create" onSubmit={event => void create(event)}>
            <select
              aria-label="创建项目所属组织"
              value={organizationId}
              onChange={(event) => {
                setOrganizationId(event.target.value)
              }}
            >
              {organizations.map(item => (
                <option key={item.organization_id} value={item.organization_id}>
                  {item.name}
                </option>
              ))}
            </select>
            <input
              aria-label="项目名称"
              value={name}
              onChange={(event) => {
                setName(event.target.value)
              }}
              placeholder="新项目名称"
              required
            />
            <input
              aria-label="项目描述"
              value={description}
              onChange={(event) => {
                setDescription(event.target.value)
              }}
              placeholder="项目描述（可选）"
            />
            <button className="button primary" disabled={creating || organizationId.length === 0}>
              <Plus size={16} />
              创建项目
            </button>
          </form>
        </div>
        <div className="project-layout">
          <div className="project-list">
            {filtered.map(project => (
              <button
                type="button"
                key={project.project_id}
                className={project.project_id === selectedId ? 'project-row selected-project' : 'project-row'}
                onClick={() => {
                  selectProject(project.project_id)
                }}
              >
                <strong>{project.name}</strong>
                <small>
                  {project.organization_name ?? project.organization_id} · r{project.revision} · {project.updated_at === undefined ? '' : formatDate(project.updated_at)}
                </small>
                <span className={`status status-${project.status}`}>{projectStatusLabel(project.status)}</span>
              </button>
            ))}
            {filtered.length === 0 && <Empty text="当前筛选没有可见项目" />}
          </div>
          {selectedId !== undefined && (
            <DetailDrawer label="项目详情" onClose={() =>{  setSelectedId(undefined) }}>
              <div className="detail-panel project-detail-panel drawer-body">
                {loadingDetail || detail === undefined ? (
                  <Loading />
                ) : (
                  <ProjectDetail
                    detail={detail}
                    tab={tab}
                    setTab={selectTab}
                    name={name}
                    description={description}
                    onName={setName}
                    onDescription={setDescription}
                    onSave={() => void save()}
                    onTransition={(action) => {
                      transition(action)
                    }}
                    api={api}
                    onAction={onAction}
                  />
                )}
              </div>
            </DetailDrawer>
          )}
        </div>
      </section>
      {transitionAction !== undefined && (
        <ConfirmDialog
          title="确认项目操作"
          message={transitionAction === 'activate'
            ? '确认激活该项目？'
            : (archiveDependencyMessage === undefined ? '正在读取依赖…' : `${archiveDependencyMessage} 确认归档？`)}
          busy={transitionBusy}
          confirmLabel={transitionAction === 'activate' ? '确认激活' : '确认归档'}
          onCancel={() => {
            if (!transitionBusy) setTransitionAction(undefined)
          }}
          onConfirm={() => void confirmTransition()}
        />
      )}
    </>
  )
}

function ProjectDetail({
  detail,
  tab,
  setTab,
  name,
  description,
  onName,
  onDescription,
  onSave,
  onTransition,
  api,
  onAction,
}: {
  readonly detail: AdminProject
  readonly tab: 'overview' | 'members' | 'assets' | 'agents' | 'workspaces' | 'audit'
  readonly setTab: (tab: 'overview' | 'members' | 'assets' | 'agents' | 'workspaces' | 'audit') => void
  readonly name: string
  readonly description: string
  readonly onName: (value: string) => void
  readonly onDescription: (value: string) => void
  readonly onSave: () => void
  readonly onTransition: (action: 'activate' | 'archive') => void
  readonly api: TeamSkillApi
  readonly onAction: (result: ApiResult<unknown>, success: string) => void
}) {
  return (
    <>
      <div className="editor-heading">
        <div>
          <span className="eyebrow">项目详情</span>
          <h3>{detail.name}</h3>
        </div>
        <span className={`status status-${detail.status}`}>{detail.status}</span>
      </div>
      <div className="detail-tabs" role="tablist" aria-label="项目详情页签">
        {(['overview', 'members', 'assets', 'agents', 'workspaces', 'audit'] as const).map(value => (
          <button
            type="button"
            role="tab"
            aria-selected={tab === value}
            className={tab === value ? 'tab active' : 'tab'}
            key={value}
            onClick={() => {
              setTab(value)
            }}
          >
            {value === 'overview' ? '概览' : value === 'members' ? '成员' : value === 'assets' ? '资产关联' : value === 'agents' ? 'Agent' : value === 'workspaces' ? '工作空间' : '审计'}
          </button>
        ))}
      </div>
      {detail.status === 'archived' && (
        <p className="permission-denied" role="note" aria-label="归档只读说明">
          {ARCHIVED_READONLY_REASON}
        </p>
      )}
      {tab === 'overview' && <ProjectOverview detail={detail} name={name} description={description} onName={onName} onDescription={onDescription} onSave={onSave} onTransition={onTransition} api={api} />}
      {tab === 'members' && <ProjectMembersTab detail={detail} api={api} onAction={onAction} />}
      {tab === 'assets' && <ProjectAssetsTab detail={detail} api={api} onAction={onAction} />}
      {tab === 'agents' && <ProjectAgentsTab detail={detail} api={api} />}
      {tab === 'workspaces' && <ProjectWorkspacesTab detail={detail} api={api} />}
      {tab === 'audit' && <ProjectAuditTab detail={detail} api={api} />}
    </>
  )
}

function ProjectOverview({
  detail,
  name,
  description,
  onName,
  onDescription,
  onSave,
  onTransition,
  api,
}: {
  readonly detail: AdminProject
  readonly name: string
  readonly description: string
  readonly onName: (value: string) => void
  readonly onDescription: (value: string) => void
  readonly onSave: () => void
  readonly onTransition: (action: 'activate' | 'archive') => void
  readonly api: TeamSkillApi
}) {
  const archived = detail.status === 'archived'
  // §6.4 安全与运行摘要：运行计数 + 授权拒绝数（单源失败降级 null + 读取不可用）。
  const [summary, setSummary] = useState<ReturnType<typeof buildSecurityRunSummary> | undefined>()
  useEffect(() => {
    let disposed = false
    const degraded = async <T,>(promise: Promise<ApiResult<readonly T[]>>): Promise<readonly T[] | undefined> => {
      const result = await promise
      return result.ok ? result.value : undefined
    }
    void Promise.all([
      degraded(api.cloudRuns({ projectId: detail.project_id })),
      degraded(api.listAuthorizationAudits(detail.organization_id, undefined, detail.project_id)),
    ]).then(([runs, audits]) => {
      if (disposed) return
      setSummary(buildSecurityRunSummary({ runs, authorizationAudits: audits }))
    })
    return () => { disposed = true }
  }, [api, detail.organization_id, detail.project_id])
  return (
    <div className="project-overview">
      <label>
        当前项目名称
        <input
          aria-label="项目名称详情"
          value={name}
          disabled={archived}
          onChange={(event) => {
            onName(event.target.value)
          }}
        />
      </label>
      <label>
        项目描述
        <textarea
          value={description}
          disabled={archived}
          onChange={(event) => {
            onDescription(event.target.value)
          }}
        />
      </label>
      <dl>
        <div>
          <dt>所属组织</dt>
          <dd>{detail.organization_name ?? detail.organization_id}</dd>
        </div>
        <div>
          <dt>创建人</dt>
          <dd>{detail.created_by ?? '-'}</dd>
        </div>
        <div>
          <dt>创建时间</dt>
          <dd>{detail.created_at === undefined ? '-' : formatDate(detail.created_at)}</dd>
        </div>
        <div>
          <dt>更新时间</dt>
          <dd>{detail.updated_at === undefined ? '-' : formatDate(detail.updated_at)}</dd>
        </div>
        <div>
          <dt>修订号</dt>
          <dd>r{detail.revision}</dd>
        </div>
        <div>
          <dt>成员 / 资产</dt>
          <dd>
            {detail.member_count ?? 0} / {detail.asset_count ?? 0}
          </dd>
        </div>
      </dl>
      {!archived && (name !== detail.name || description !== detail.description) && (
        <p className="change-preview" data-change-kind="edit" role="note">
          变更摘要：
          {name !== detail.name && <span>名称「{detail.name}」→「{name}」</span>}
          {description !== detail.description && <span>简介「{detail.description}」→「{description}」</span>}
        </p>
      )}
      {summary !== undefined && (
        <div role="region" aria-label="安全与运行摘要" className="workbench-card">
          <div className="workbench-card-head">
            <strong>安全与运行摘要</strong>
            {summary.unavailable.length > 0 && (
              <span className="count-badge">{`${summary.unavailable.join('、')}读取不可用`}</span>
            )}
          </div>
          <dl className="workbench-facts">
            <div><dt>运行总数</dt><dd>{summary.runsTotal === null ? '读取不可用' : summary.runsTotal}</dd></div>
            <div><dt>运行中</dt><dd>{summary.runsRunning === null ? '读取不可用' : summary.runsRunning}</dd></div>
            <div><dt>成功 / 失败</dt><dd>{summary.runsSucceeded === null || summary.runsFailed === null ? '读取不可用' : `${summary.runsSucceeded} / ${summary.runsFailed}`}</dd></div>
            <div><dt>授权拒绝</dt><dd>{summary.authorizationDenied === null ? '读取不可用' : summary.authorizationDenied}</dd></div>
          </dl>
        </div>
      )}
      <div className="review-actions">
        <button type="button" className="button secondary" disabled={archived} title={archived ? ARCHIVED_READONLY_REASON : undefined} onClick={onSave}>
          保存项目
        </button>
        {detail.status === 'draft' ? (
          <button
            type="button"
            className="button primary"
            disabled={archived}
            title={archived ? ARCHIVED_READONLY_REASON : undefined}
            onClick={() => {
              onTransition('activate')
            }}
          >
            激活项目
          </button>
        ) : (
          <button
            type="button"
            className="button danger"
            disabled={archived}
            title={archived ? ARCHIVED_READONLY_REASON : undefined}
            onClick={() => {
              onTransition('archive')
            }}
          >
            归档项目
          </button>
        )}
      </div>
      {archived && (
        <p className="state-line" role="note">{ARCHIVED_READONLY_REASON}</p>
      )}
    </div>
  )
}

/** Agent 页签（§6.4）：项目绑定的 Agent 配置（服务端过滤 project_id）。 */
function ProjectAgentsTab({ detail, api }: {
  readonly detail: AdminProject
  readonly api: TeamSkillApi
}): ReactElement {
  const [profiles, setProfiles] = useState<readonly CloudAgentProfile[] | undefined>()
  useEffect(() => {
    let disposed = false
    void api.cloudAgentProfiles({ projectId: detail.project_id }).then((result) => {
      if (!disposed) setProfiles(result.ok ? result.value : [])
    })
    return () => { disposed = true }
  }, [api, detail.project_id])
  return (
    <div className="table-wrap">
      <table aria-label="项目 Agent 配置">
        <thead>
          <tr><th>名称</th><th>状态</th><th>readiness</th><th>更新时间</th></tr>
        </thead>
        <tbody>
          {(profiles ?? []).map(profile => (
            <tr key={profile.agent_profile_id}>
              <td>{profile.name}</td>
              <td>{profile.status}</td>
              <td>{profile.readiness}</td>
              <td>{profile.updated_at}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {profiles !== undefined && profiles.length === 0 && <Empty text="项目尚未绑定 Agent 配置" />}
    </div>
  )
}

/** 工作空间页签（§6.4）：项目下的云工作空间（服务端过滤 project_id）。 */
function ProjectWorkspacesTab({ detail, api }: {
  readonly detail: AdminProject
  readonly api: TeamSkillApi
}): ReactElement {
  const [workspaces, setWorkspaces] = useState<readonly CloudWorkspace[] | undefined>()
  useEffect(() => {
    let disposed = false
    void api.cloudWorkspaces({ projectId: detail.project_id }).then((result) => {
      if (!disposed) setWorkspaces(result.ok ? result.value : [])
    })
    return () => { disposed = true }
  }, [api, detail.project_id])
  return (
    <div className="table-wrap">
      <table aria-label="项目工作空间">
        <thead>
          <tr><th>显示名</th><th>分支</th><th>状态</th><th>更新时间</th></tr>
        </thead>
        <tbody>
          {(workspaces ?? []).map(workspace => (
            <tr key={workspace.workspace_id}>
              <td>{workspace.display_name}</td>
              <td>{workspace.branch}</td>
              <td>{workspace.status}</td>
              <td>{workspace.updated_at}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {workspaces !== undefined && workspaces.length === 0 && <Empty text="项目尚无工作空间" />}
    </div>
  )
}

function ProjectMembersTab({
  detail,
  api,
  onAction,
}: {
  readonly detail: AdminProject
  readonly api: TeamSkillApi
  readonly onAction: (result: ApiResult<unknown>, success: string) => void
}) {
  const [members, setMembers] = useState<readonly AdminProjectMember[]>([])
  const [users, setUsers] = useState<readonly AdminUser[]>([])
  const [userId, setUserId] = useState('')
  const [askConfirmation, confirmationDialog] = useConfirmDialog()
  const loadGeneration = useRef(0)
  const load = async (): Promise<void> => {
    const generation = ++loadGeneration.current
    const [memberResult, userResult] = await Promise.all([api.listProjectMembers(detail.project_id), api.listUsers(detail.organization_id)])
    if (generation !== loadGeneration.current) return
    if (memberResult.ok) setMembers(memberResult.value)
    else onAction(memberResult, '读取项目成员失败')
    if (userResult.ok) setUsers(userResult.value)
    else onAction(userResult, '读取组织成员失败')
  }
  useEffect(() => {
    void load()
  }, [detail.project_id])
  const archived = detail.status === 'archived'
  const add = async (): Promise<void> => {
    if (userId.length === 0) return
    const existing = members.find(item => item.user_id === userId)
    const result = await api.setProjectMember(detail.project_id, userId, existing?.revision ?? detail.revision, crypto.randomUUID())
    onAction(result, '项目成员已授权')
    if (result.ok) {
      setUserId('')
      await load()
    }
  }
  const remove = async (member: AdminProjectMember): Promise<void> => {
    if (archived) return
    if (
      !(await askConfirmation({
        title: '确认项目成员操作',
        message: `移除 ${member.display_name}？`,
      }))
    )
      return
    const result = await api.removeProjectMember(detail.project_id, member.user_id, member.revision, crypto.randomUUID())
    onAction(result, '项目成员已移除')
    if (result.ok) await load()
  }
  return (
    <>
      <div className="project-tab">
        <h4>项目成员</h4>
        {!archived && (
          <div className="inline-create">
            <select
              aria-label="项目成员"
              value={userId}
              onChange={(event) => {
                setUserId(event.target.value)
              }}
            >
              <option value="">选择组织 member</option>
              {users
                .filter(user => user.global_role === 'member' && user.memberships?.some(item => item.organization_id === detail.organization_id) && !members.some(member => member.user_id === user.user_id && member.status === 'active'))
                .map(user => (
                  <option key={user.user_id} value={user.user_id}>
                    {user.display_name} · {user.username}
                  </option>
                ))}
            </select>
            <button type="button" className="button primary" disabled={userId.length === 0} onClick={() => void add()}>
              <Users size={16} />
              添加成员
            </button>
          </div>
        )}
        {!archived && userId.length > 0 && (
          <p className="change-preview" data-change-kind="add" role="note">
            变更摘要：将 {users.find(user => user.user_id === userId)?.display_name ?? userId} 加入项目成员
          </p>
        )}
        <div className="member-list">
          {members
            .filter(member => member.status === 'active')
            .map(member => (
              <div className="member-row" key={member.user_id}>
                <span>
                  <strong>{member.display_name}</strong>
                  <small>
                    {member.joined_at === undefined ? '' : formatDate(member.joined_at)} · r{member.revision}
                  </small>
                </span>
                {!archived && (
                  <button type="button" className="text-danger" onClick={() => void remove(member)}>
                    移除
                  </button>
                )}
              </div>
            ))}
          {members.filter(member => member.status === 'active').length === 0 && <Empty text="暂无项目成员" />}
        </div>
      </div>
      {confirmationDialog}
    </>
  )
}

function ProjectAssetsTab({
  detail,
  api,
  onAction,
}: {
  readonly detail: AdminProject
  readonly api: TeamSkillApi
  readonly onAction: (result: ApiResult<unknown>, success: string) => void
}) {
  const [assets, setAssets] = useState<readonly AdminProjectAsset[]>([])
  const [assetType, setAssetType] = useState<AdminProjectAsset['asset_type']>('skill')
  const [assetId, setAssetId] = useState('')
  const [relation, setRelation] = useState<AdminProjectAsset['relation_kind']>('reference')
  const loadGeneration = useRef(0)
  const load = async (): Promise<void> => {
    const generation = ++loadGeneration.current
    const result = await api.listProjectAssets(detail.project_id)
    if (generation !== loadGeneration.current) return
    if (result.ok) setAssets(result.value)
    else onAction(result, '读取项目资产失败')
  }
  useEffect(() => {
    void load()
  }, [detail.project_id])
  const archived = detail.status === 'archived'
  const add = async (): Promise<void> => {
    if (assetId.trim().length === 0) return
    const result = await api.addProjectAsset(
      detail.project_id,
      {
        assetType,
        assetId: assetId.trim(),
        relationKind: relation,
        revision: detail.revision,
      },
      crypto.randomUUID(),
    )
    onAction(result, '资产关联已添加')
    if (result.ok) {
      setAssetId('')
      await load()
    }
  }
  const update = async (asset: AdminProjectAsset): Promise<void> => {
    const result = await api.updateProjectAsset(detail.project_id, asset.asset_type, asset.asset_id, asset.relation_kind === 'reference' ? 'context' : 'reference', asset.revision, crypto.randomUUID())
    onAction(result, '资产关系已更新')
    if (result.ok) await load()
  }
  const remove = async (asset: AdminProjectAsset): Promise<void> => {
    const result = await api.removeProjectAsset(detail.project_id, asset.asset_type, asset.asset_id, asset.revision, crypto.randomUUID())
    onAction(result, '资产关联已移除')
    if (result.ok) await load()
  }
  return (
    <div className="project-tab">
      <h4>资产关联</h4>
      {!archived && (
        <div className="inline-create">
          <select
            aria-label="资产类型"
            value={assetType}
            onChange={(event) => {
              setAssetType(event.target.value as AdminProjectAsset['asset_type'])
            }}
          >
            <option value="skill">Skill</option>
            <option value="knowledge">知识库</option>
            <option value="memory">记忆</option>
          </select>
          <input
            aria-label="资产 ID"
            value={assetId}
            onChange={(event) => {
              setAssetId(event.target.value)
            }}
            placeholder="输入资产 ID"
          />
          <select
            aria-label="关系类型"
            value={relation}
            onChange={(event) => {
              setRelation(event.target.value as AdminProjectAsset['relation_kind'])
            }}
          >
            <option value="reference">reference</option>
            <option value="context">context</option>
          </select>
          <button type="button" className="button primary" disabled={assetId.trim().length === 0} onClick={() => void add()}>
            <Plus size={16} />
            关联资产
          </button>
        </div>
      )}
      {!archived && assetId.trim().length > 0 && (
        <p className="change-preview" data-change-kind="add" role="note">
          变更摘要：新增{assetType === 'skill' ? ' Skill' : assetType === 'knowledge' ? '知识库' : '记忆'}资产 {assetId}（关系 {relation}）
        </p>
      )}
      <div className="member-list">
        {assets.map(asset => (
          <div className="member-row" key={`${asset.asset_type}:${asset.asset_id}`}>
            <span>
              <strong>{asset.name}</strong>
              <small>
                {asset.asset_type} · {asset.relation_kind} · r{asset.revision}
              </small>
            </span>
            {!archived && (
              <span className="review-actions">
                <button
                  type="button"
                  className="button secondary"
                  title={`变更关系：${asset.relation_kind} → ${asset.relation_kind === 'reference' ? 'context' : 'reference'}`}
                  onClick={() => void update(asset)}
                >
                  切换关系
                </button>
                <button type="button" className="text-danger" onClick={() => void remove(asset)}>
                  解除
                </button>
              </span>
            )}
          </div>
        ))}
        {assets.length === 0 && <Empty text="暂无资产关联" />}
      </div>
    </div>
  )
}

function ProjectAuditTab({ detail, api }: { readonly detail: AdminProject; readonly api: TeamSkillApi }) {
  const [items, setItems] = useState<readonly AuthorizationAudit[]>([])
  useEffect(() => {
    void api.listAuthorizationAudits(undefined, undefined, detail.project_id).then((result) => {
      if (result.ok) setItems(result.value)
    })
  }, [api, detail.project_id])
  return (
    <div className="project-tab">
      <h4>项目审计</h4>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>时间</th>
              <th>操作者</th>
              <th>动作</th>
              <th>结果</th>
              <th>请求编号</th>
            </tr>
          </thead>
          <tbody>
            {items.map(item => (
              <tr key={item.id}>
                <td>{formatDate(item.occurred_at)}</td>
                <td>{item.actor_name}</td>
                <td>{item.action}</td>
                <td>{item.result}</td>
                <td className="request-id">{item.request_id}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {items.length === 0 && <Empty text="暂无项目审计记录" />}
      </div>
    </div>
  )
}

function ProjectsPage({
  items,
  api,
  role,
  onAction,
}: {
  readonly items: readonly AdminProject[]
  readonly api: TeamSkillApi
  readonly role: AccountRole
  readonly onAction: (result: ApiResult<unknown>, success: string) => void
}) {
  // 详情抽屉只在显式点击行后打开；不做默认选中（否则进页即弹抽屉）。
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined)
  const [members, setMembers] = useState<readonly AdminProjectMember[]>([])
  const [users, setUsers] = useState<readonly AdminUser[]>([])
  const [memberId, setMemberId] = useState('')
  const [askConfirmation, confirmationDialog] = useConfirmDialog()
  const selected = items.find(item => item.project_id === selectedId)
  const selectedArchived = selected?.status === 'archived'
  const refreshMembers = async (project: AdminProject | undefined): Promise<void> => {
    if (project === undefined) {
      setMembers([])
      return
    }
    const [memberResult, userResult] = await Promise.all([
      api.listProjectMembers(project.project_id),
      api.listUsers(project.organization_id),
    ])
    if (memberResult.ok) setMembers(memberResult.value)
    else onAction(memberResult, '读取项目成员失败')
    if (userResult.ok) setUsers(userResult.value)
    else onAction(userResult, '读取组织用户失败')
  }
  useEffect(() => {
    void refreshMembers(selected)
  }, [selectedId, items])
  const add = async (): Promise<void> => {
    if (selected === undefined || selectedArchived || memberId.length === 0) return
    const existing = members.find(member => member.user_id === memberId)
    const result = await api.setProjectMember(selected.project_id, memberId, existing?.revision ?? selected.revision, crypto.randomUUID())
    onAction(result, '项目成员已授权')
    if (result.ok) {
      setMemberId('')
      await refreshMembers(selected)
    }
  }
  const remove = async (member: AdminProjectMember): Promise<void> => {
    if (
      selected === undefined ||
      selectedArchived ||
      !(await askConfirmation({
        title: '确认项目成员操作',
        message: `从项目移除 ${member.display_name}？`,
      }))
    )
      return
    const result = await api.removeProjectMember(selected.project_id, member.user_id, member.revision, crypto.randomUUID())
    onAction(result, '项目成员已移除')
    if (result.ok) await refreshMembers(selected)
  }
  return (
    <>
      <section className="page-body">
        <div className="page-intro">
          <div>
            <span className="eyebrow">权限管理 / 项目</span>
            <h2>项目授权</h2>
            <p>{roleLabel(role)}只能在服务端允许的组织范围内调整项目成员关系。</p>
          </div>
          <span className="count-badge">{items.length} 个项目</span>
        </div>
        <div className="project-layout">
          <div className="project-list">
            {items.map(project => (
              <button
                type="button"
                key={project.project_id}
                className={project.project_id === selectedId ? 'project-row selected-project' : 'project-row'}
                onClick={() => {
                  setSelectedId(project.project_id)
                }}
              >
                <strong>{project.name}</strong>
                <small>
                  {project.organization_id} · r{project.revision}
                </small>
                <span className={`status status-${project.status}`}>{projectStatusLabel(project.status)}</span>
              </button>
            ))}
            {items.length === 0 && <Empty text="当前范围没有可见项目" />}
          </div>
          {selected !== undefined && (
            <DetailDrawer label="项目成员详情" onClose={() =>{  setSelectedId(undefined) }}>
              <div className="detail-panel drawer-body">
                <span className="eyebrow">项目成员</span>
                <h3>{selected.name}</h3>
                {selectedArchived && <p className="page-hint">归档项目只读，不能调整成员授权。</p>}
                <div className="inline-create">
                  <select
                    aria-label="选择组织成员"
                    value={memberId}
                    onChange={(event) => {
                      setMemberId(event.target.value)
                    }}
                  >
                    <option value="">选择要授权的 member</option>
                    {users
                      .filter(user => user.global_role === 'member' && user.memberships?.some(membership => membership.organization_id === selected.organization_id))
                      .filter(user => !members.some(member => member.user_id === user.user_id && member.status === 'active'))
                      .map(user => (
                        <option key={user.user_id} value={user.user_id}>
                          {user.display_name} · {user.username}
                        </option>
                      ))}
                  </select>
                  <button type="button" className="button primary" disabled={selectedArchived || memberId.length === 0} onClick={() => void add()}>
                    <Users size={16} />
                    授权
                  </button>
                </div>
                <div className="member-list">
                  {members
                    .filter(member => member.status === 'active')
                    .map(member => (
                      <div className="member-row" key={member.user_id}>
                        <span>
                          <strong>{member.display_name}</strong>
                          <small>r{member.revision}</small>
                        </span>
                        {!selectedArchived && (
                          <button type="button" className="text-danger" onClick={() => void remove(member)}>
                            移除
                          </button>
                        )}
                      </div>
                    ))}
                  {members.filter(member => member.status === 'active').length === 0 && <Empty text="暂无项目成员" />}
                </div>
              </div>
            </DetailDrawer>
          )}
        </div>
      </section>
      {confirmationDialog}
    </>
  )
}

function AuthorizationAuditPage({
  items,
  api,
  role,
  workbenchFilter,
}: {
  readonly items: readonly AuthorizationAudit[]
  readonly api: TeamSkillApi
  readonly role: AccountRole
  readonly workbenchFilter?: WorkbenchFilter
}) {
  const [action, setAction] = useState('')
  // 工作台跳转的 status=failed 映射为审计行的 result 过滤（4-1，客户端落实）。
  const applyWorkbenchFilter = (rows: readonly AuthorizationAudit[]): readonly AuthorizationAudit[] =>
    workbenchFilter?.status === undefined ? rows : rows.filter(row => row.result === workbenchFilter.status)
  const [rows, setRows] = useState<readonly AuthorizationAudit[]>(() => applyWorkbenchFilter(items))
  const [loading, setLoading] = useState(false)
  const filter = async (): Promise<void> => {
    setLoading(true)
    const result = await api.listAuthorizationAudits(undefined, action)
    setLoading(false)
    if (result.ok) setRows(applyWorkbenchFilter(result.value))
  }
  useEffect(() => {
    setRows(items)
  }, [items])
  return (
    <section className="page-body">
      <div className="page-intro">
        <div>
          <span className="eyebrow">权限管理 / 审计</span>
          <h2>授权审计</h2>
          <p>{roleLabel(role)}可查看服务端按组织过滤的账号、会话和项目授权事件。</p>
        </div>
      </div>
      <div className="audit-filters">
        <label>
          动作筛选
          <input
            value={action}
            onChange={(event) => {
              setAction(event.target.value)
            }}
            placeholder="例如：账号创建"
          />
        </label>
        <button type="button" className="button secondary" disabled={loading} onClick={() => void filter()}>
          <RefreshCw size={16} />
          筛选
        </button>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>时间</th>
              <th>操作者</th>
              <th>动作</th>
              <th>组织</th>
              <th>目标用户 / 项目</th>
              <th>结果</th>
              <th>请求编号</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(item => (
              <tr key={item.id}>
                <td>{formatDate(item.occurred_at)}</td>
                <td>{item.actor_name}</td>
                <td>{item.action}</td>
                <td>{item.organization_id ?? '平台'}</td>
                <td>{item.target_user_id ?? item.project_id ?? '-'}</td>
                <td>
                  <span className={`status status-${item.result}`}>{item.result === 'succeeded' ? '成功' : '失败'}</span>
                </td>
                <td className="request-id">{item.request_id}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length === 0 && <Empty text="暂无授权审计记录" />}
      </div>
    </section>
  )
}

/** Right-side detail drawer (design spec §5): 420–520px on desktop, focus
 * moves in on open, Escape closes, and focus returns to the trigger
 * when the drawer closes. */
function DetailDrawer({ label, onClose, children }: {
  readonly label: string
  readonly onClose: () => void
  readonly children: ReactNode
}) {
  const drawerRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    // preventScroll: 聚焦 fixed 抽屉不得重置文档滚动，否则关闭后用户丢失位置。
    drawerRef.current?.focus({ preventScroll: true })
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        onClose()
      }
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.removeEventListener('keydown', onKeyDown, true)
      previous?.focus({ preventScroll: true })
    }
  }, [onClose])
  return (
    <div
      className="drawer-scrim"
      onClick={() => {
        onClose()
      }}
    >
      <div
        ref={drawerRef}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
        className="detail-drawer"
        data-style-drawer=""
        onClick={(event) => {
          event.stopPropagation()
        }}
      >
        <button type="button" className="drawer-close" aria-label="关闭详情" onClick={onClose}>
          <X size={16} aria-hidden="true" />
        </button>
        {children}
      </div>
    </div>
  )
}

function ErrorState({ error, onRetry }: { error: ApiError; onRetry: () => void }) {
  return (
    <section className="state-panel error" data-state={error.kind} role="alert">
      <TriangleAlert size={20} />
      <h2>{error.kind === 'not-ready' ? 'Skill 服务尚未配置' : error.kind === 'unauthorized' ? '登录已失效' : error.kind === 'unavailable' ? '服务不可达' : '服务请求失败'}</h2>
      {error.kind === 'unavailable' && <p>后端服务未启动或当前不可达</p>}
      <p>{errorMessage(error)}</p>
      <button className="button secondary" onClick={onRetry}>
        <RefreshCw size={16} />
        重新读取
      </button>
    </section>
  )
}
function errorMessage(error: ApiError): string {
  if (error.kind === 'not-ready') return `缺少配置：${error.missing.join('、')}`
  return `${error.code}：${error.message}`
}

function DirectoryPage({
  items: allItems,
  selected,
  onSelect,
  workbenchFilter,
}: {
  items: readonly TeamSkill[]
  selected: TeamSkill | undefined
  onSelect: (item: TeamSkill | undefined) => void
  workbenchFilter?: WorkbenchFilter
}) {
  // 工作台跳转带来的过滤条件在本页客户端生效（4-1：目录页不走服务端过滤）。
  const items = workbenchFilter?.status === undefined ? allItems : allItems.filter(item => item.status === workbenchFilter.status)
  return (
    <section className="page-body">
      <div className="page-intro">
        <div>
          <span className="eyebrow">资产查询</span>
          <h2>已登记的团队 Skill</h2>
          <p>仅显示当前管理员权限范围内的服务端资源，制品内容由平台托管。</p>
        </div>
        <span className="count-badge">{items.length} 项</span>
      </div>
      <div className="content-grid">
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Skill</th>
                <th>版本</th>
                <th>可见范围</th>
                <th>状态</th>
                <th>修订</th>
              </tr>
            </thead>
            <tbody>
              {items.map(item => (
                <tr
                  key={`${item.skillId}-${item.status}-${item.revision}`}
                  onClick={() => {
                    onSelect(item)
                  }}
                  className={selected?.skillId === item.skillId ? 'selected-row' : undefined}
                >
                  <td>
                    <strong>{item.displayName}</strong>
                    <small>
                      {item.runtimeName} · {item.authorName ?? '平台作者'}
                    </small>
                    <button
                      type="button"
                      className="row-action"
                      aria-label={`查看 ${item.displayName}`}
                      onClick={() => {
                        onSelect(item)
                      }}
                    >
                      查看
                    </button>
                  </td>
                  <td>{item.currentVersion ? `v${item.currentVersion}` : '未发布'}</td>
                  <td>{visibilityLabel(item.visibility)}</td>
                  <td>
                    <Status status={item.status} />
                  </td>
                  <td>r{item.revision}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {items.length === 0 && <Empty text="当前没有可见的 Skill 资产" />}
        </div>
        {selected !== undefined && <SkillSummary skill={selected} onClear={() =>{  onSelect(undefined) }} />}
      </div>
    </section>
  )
}

// 生命周期步骤条：草稿 → 审核 → 发布 → 绑定，当前阻塞项直接可见。
const SKILL_LIFECYCLE_STEPS: readonly { readonly key: 'draft' | 'pending_review' | 'approved' | 'published' | 'withdrawn' | 'bound'; readonly label: string; readonly blocker: string }[] = [
  { key: 'draft', label: '草稿', blocker: '完善后提交审核' },
  { key: 'pending_review', label: '审核', blocker: '等待审核' },
  { key: 'approved', label: '发布', blocker: '已批准，可发布' },
  { key: 'published', label: '发布', blocker: '' },
  { key: 'bound', label: '绑定', blocker: '' },
]

function SkillLifecycleSteps({ skill }: { skill: TeamSkill }) {
  const bound = (skill.projectIds?.length ?? 0) > 0
  const withdrawn = skill.status === 'withdrawn'
  const currentKey: 'draft' | 'pending_review' | 'approved' | 'published' | 'withdrawn' | 'bound' =
    skill.status === 'published' ? (bound ? 'bound' : 'published') : skill.status === 'withdrawn' ? 'draft' : skill.status
  const currentIndex = Math.max(
    0,
    SKILL_LIFECYCLE_STEPS.findIndex(step => step.key === currentKey),
  )
  return (
    <ol className="lifecycle-steps" aria-label="Skill 生命周期">
      {SKILL_LIFECYCLE_STEPS.map((step, index) => (
        <li
          key={`${step.key}-${index}`}
          aria-current={index === currentIndex ? 'step' : undefined}
          className={index === currentIndex ? 'lifecycle-step current' : index < currentIndex ? 'lifecycle-step done' : 'lifecycle-step'}
        >
          <strong>{step.label}</strong>
          {index === currentIndex && withdrawn && <small>阻塞：已下线，需重新走目录、审核、发布</small>}
          {index === currentIndex && !withdrawn && step.blocker.length > 0 && <small>阻塞：{step.blocker}</small>}
          {step.key === 'bound' && index === currentIndex && <small>阻塞：未绑定任何项目</small>}
        </li>
      ))}
    </ol>
  )
}

function SkillSummary({ skill, onClear }: { skill: TeamSkill; onClear: () => void }) {
  return (
    <DetailDrawer label="Skill 详情" onClose={onClear}>
      <aside className="detail-panel drawer-body">
        <span className="eyebrow">Skill 详情</span>
        <h2>{skill.displayName}</h2>
        <p>{skill.summary}</p>
        <SkillLifecycleSteps skill={skill} />
        <dl>
          <div>
            <dt>运行时名称</dt>
            <dd>{skill.runtimeName}</dd>
          </div>
          <div>
            <dt>所属组织</dt>
            <dd>{skill.organizationId ?? '未标注'}</dd>
          </div>
          <div>
            <dt>项目绑定</dt>
            <dd>{skill.projectIds === undefined || skill.projectIds.length === 0 ? '未绑定任何项目：发布后还需在项目资产中绑定，插件目录才会发现该 Skill' : skill.projectIds.join('、')}</dd>
          </div>
          <div>
            <dt>分类 / 标签</dt>
            <dd>
              {skill.category} · {skill.tags.join('、') || '未设置'}
            </dd>
          </div>
          <div>
            <dt>可见范围</dt>
            <dd>{visibilityLabel(skill.visibility)}</dd>
          </div>
          <div>
            <dt>当前修订</dt>
            <dd>r{skill.revision}</dd>
          </div>
        </dl>
        <div className="callout">已发布版本不可编辑。修改内容、依赖或权限时，请创建新的版本草稿。</div>
      </aside>
    </DetailDrawer>
  )
}

function KnowledgeBasesPage({
  items,
  api,
  role,
  onAction,
}: {
  readonly items: readonly AdminKnowledgeBase[]
  readonly api: TeamSkillApi
  readonly role: AccountRole
  readonly onAction: (result: ApiResult<unknown>, success: string) => void
}) {
  const [organizations, setOrganizations] = useState<readonly AdminOrganization[]>([])
  const [organizationId, setOrganizationId] = useState('')
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined)
  const [selected, setSelected] = useState<AdminKnowledgeBase | undefined>()
  const [documents, setDocuments] = useState<readonly AdminKnowledgeDocument[]>([])
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [type, setType] = useState<AdminKnowledgeBase['type']>('document')
  const [title, setTitle] = useState('')
  const [markdown, setMarkdown] = useState('')
  const [url, setUrl] = useState('')
  const [fileName, setFileName] = useState('')
  const [tab, setTab] = useState<'overview' | 'documents' | 'faq' | 'wiki' | 'graph' | 'settings' | 'projects' | 'audit'>('overview')
  const [operationStatus, setOperationStatus] = useState<string | undefined>()
  const [operationId, setOperationId] = useState<string | undefined>()
  const [impact, setImpact] = useState<
    | {
      readonly revision: number
      readonly affected_projects: readonly {
        readonly project_id: string
        readonly name: string
        readonly status: string
      }[]
    }
    | undefined
  >()
  const loadGeneration = useRef(0)
  useEffect(() => {
    void api.listOrganizations().then((result) => {
      if (result.ok) {
        setOrganizations(result.value)
        if (organizationId.length === 0 && result.value.length > 0) setOrganizationId(result.value[0].organization_id)
      }
    })
  }, [api, organizationId.length])
  const load = async (id: string): Promise<void> => {
    const generation = ++loadGeneration.current
    const [detail, docs] = await Promise.all([api.getKnowledgeBase(id), api.listKnowledgeDocuments(id)])
    if (generation !== loadGeneration.current) return
    if (detail.ok) {
      setSelected(detail.value)
      setName(detail.value.name)
      setDescription(detail.value.description)
    } else onAction(detail, '读取知识库失败')
    if (docs.ok) setDocuments(docs.value)
    else onAction(docs, '读取文档失败')
  }
  useEffect(() => {
    if (selectedId !== undefined) void load(selectedId)
  }, [selectedId])
  useEffect(() => {
    if (operationId === undefined || operationStatus === undefined || operationStatus === 'succeeded' || operationStatus === 'failed' || operationStatus === 'cancelled') return
    const timer = window.setTimeout(() => {
      void api.getKnowledgeOperation(operationId).then((result) => {
        if (result.ok) setOperationStatus(result.value.status)
        else onAction(result, '读取操作状态失败')
      })
    }, 500)
    return () => {
      window.clearTimeout(timer)
    }
  }, [api, onAction, operationId, operationStatus])
  const create = async (): Promise<void> => {
    if (organizationId.length === 0 || name.trim().length === 0) return
    const result = await api.createKnowledgeBase(
      organizationId,
      { name: name.trim(), description: description.trim(), type },
      crypto.randomUUID(),
    )
    onAction(result, '知识库创建操作已提交')
    if (result.ok) {
      setOperationId(result.value.operation_id)
      setOperationStatus(result.value.status)
      if (result.value.knowledge_base !== undefined) setSelectedId(result.value.knowledge_base.knowledge_base_id)
    }
  }
  const save = async (): Promise<void> => {
    if (selected === undefined) return
    const result = await api.updateKnowledgeBase(
      selected.knowledge_base_id,
      { name: name.trim(), description: description.trim() },
      selected.revision,
      crypto.randomUUID(),
    )
    onAction(result, '知识库配置已保存')
    if (result.ok) setSelected(result.value)
  }
  const importMarkdown = async (): Promise<void> => {
    if (selected === undefined || markdown.trim().length === 0) return
    const result = await api.importKnowledgeMarkdown(selected.knowledge_base_id, { title: title.trim() || '未命名文档', markdown }, selected.revision, crypto.randomUUID())
    onAction(result, 'Markdown 导入操作已提交')
    if (result.ok) {
      setOperationId(result.value.operation_id)
      setOperationStatus(result.value.status)
      setMarkdown('')
      await load(selected.knowledge_base_id)
    }
  }
  const importUrl = async (): Promise<void> => {
    if (selected === undefined || url.trim().length === 0) return
    const result = await api.importKnowledgeUrl(
      selected.knowledge_base_id,
      { title: title.trim() || undefined, url: url.trim() },
      selected.revision,
      crypto.randomUUID(),
    )
    onAction(result, 'URL 导入操作已提交')
    if (result.ok) {
      setOperationId(result.value.operation_id)
      setOperationStatus(result.value.status)
      setUrl('')
      await load(selected.knowledge_base_id)
    }
  }
  const importFile = async (): Promise<void> => {
    if (selected === undefined || fileName.trim().length === 0) return
    const result = await api.importKnowledgeFile(
      selected.knowledge_base_id,
      { title: title.trim() || fileName.trim(), file_name: fileName.trim() },
      selected.revision,
      crypto.randomUUID(),
    )
    onAction(result, '文件导入操作已提交')
    if (result.ok) {
      setOperationId(result.value.operation_id)
      setOperationStatus(result.value.status)
      setFileName('')
      await load(selected.knowledge_base_id)
    }
  }
  const loadImpact = async (): Promise<void> => {
    if (selected === undefined) return
    const generation = loadGeneration.current
    const result = await api.getKnowledgeDeleteImpact(selected.knowledge_base_id)
    if (result.ok && generation === loadGeneration.current) setImpact(result.value)
    else onAction(result, '读取删除影响失败')
  }
  const deleteKnowledge = async (): Promise<void> => {
    if (selected === undefined || impact === undefined) return
    const result = await api.deleteKnowledgeBase(
      selected.knowledge_base_id,
      impact.revision,
      impact.affected_projects.length,
      crypto.randomUUID(),
    )
    onAction(result, '知识库删除操作已提交')
    if (result.ok) {
      setOperationId(result.value.operation_id)
      setOperationStatus(result.value.status)
    }
  }
  const tabs: Array<{
    readonly id: typeof tab
    readonly label: string
    readonly visible: boolean
  }> = [
    { id: 'overview', label: '概览', visible: true },
    { id: 'documents', label: '文档', visible: true },
    { id: 'faq', label: 'FAQ', visible: selected?.type === 'faq' },
    { id: 'wiki', label: 'Wiki', visible: selected?.type === 'wiki' },
    { id: 'graph', label: '图谱', visible: selected?.type === 'wiki' },
    { id: 'settings', label: '设置', visible: true },
    { id: 'projects', label: '项目', visible: true },
    { id: 'audit', label: '审计', visible: true },
  ]
  return (
    <section className="page-body">
      <div className="page-intro">
        <div>
          <span className="eyebrow">知识库管理</span>
          <h2>知识库</h2>
          <p>{roleLabel(role)}按组织范围管理 WeKnora 代理资源，正文和处理状态由服务端返回。</p>
        </div>
        <span className="count-badge">{items.length} 个知识库</span>
      </div>
      <div className="account-toolbar">
        <label>
          组织
          <select
            aria-label="知识库组织"
            value={organizationId}
            onChange={(event) => {
              setOrganizationId(event.target.value)
            }}
          >
            {organizations.map(item => (
              <option key={item.organization_id} value={item.organization_id}>
                {item.name}
              </option>
            ))}
          </select>
        </label>
        <form
          className="inline-create"
          onSubmit={(event) => {
            event.preventDefault()
            void create()
          }}
        >
          <input
            aria-label="知识库名称"
            placeholder="新知识库名称"
            value={name}
            onChange={(event) => {
              setName(event.target.value)
            }}
            required
          />
          <select
            aria-label="知识库类型"
            value={type}
            onChange={(event) => {
              setType(event.target.value as AdminKnowledgeBase['type'])
            }}
          >
            <option value="document">document</option>
            <option value="faq">faq</option>
            <option value="wiki">wiki</option>
          </select>
          <input
            aria-label="知识库描述"
            placeholder="描述"
            value={description}
            onChange={(event) => {
              setDescription(event.target.value)
            }}
          />
          <button className="button primary">
            <Plus size={16} />
            创建
          </button>
        </form>
      </div>
      <div className="project-layout">
        <div className="project-list">
          {items.map(item => (
            <button
              type="button"
              key={item.knowledge_base_id}
              className={item.knowledge_base_id === selectedId ? 'project-row selected-project' : 'project-row'}
              onClick={() => {
                setSelectedId(item.knowledge_base_id)
                setTab('overview')
                setImpact(undefined)
              }}
            >
              <strong>{item.name}</strong>
              <small>
                {item.type} · {item.organization_id} · r{item.revision}
              </small>
              <span className={`status status-${item.state}`}>{item.state}</span>
            </button>
          ))}
          {items.length === 0 && <Empty text="当前范围没有可见知识库" />}
        </div>
        {selected !== undefined && (
          <DetailDrawer label="知识库详情" onClose={() =>{  setSelected(undefined) }}>
            <div className="detail-panel project-detail-panel drawer-body">
              <div className="editor-heading">
                <div>
                  <span className="eyebrow">知识库详情</span>
                  <h3>{selected.name}</h3>
                </div>
                <span className={`status status-${selected.state}`}>{selected.state}</span>
              </div>
              <div className="detail-tabs" role="tablist" aria-label="知识库详情页签">
                {tabs
                  .filter(item => item.visible)
                  .map(item => (
                    <button
                      key={item.id}
                      type="button"
                      role="tab"
                      aria-selected={tab === item.id}
                      className={tab === item.id ? 'tab active' : 'tab'}
                      onClick={() => {
                        setTab(item.id)
                      }}
                    >
                      {item.label}
                    </button>
                  ))}
              </div>
              {tab === 'overview' && (
                <div className="project-overview">
                  <label>
                    名称
                    <input
                      value={name}
                      onChange={(event) => {
                        setName(event.target.value)
                      }}
                    />
                  </label>
                  <label>
                    描述
                    <textarea
                      value={description}
                      onChange={(event) => {
                        setDescription(event.target.value)
                      }}
                    />
                  </label>
                  <dl>
                    <div>
                      <dt>类型</dt>
                      <dd>{selected.type}</dd>
                    </div>
                    <div>
                      <dt>文档</dt>
                      <dd>{selected.document_count ?? documents.length}</dd>
                    </div>
                    <div>
                      <dt>修订</dt>
                      <dd>r{selected.revision}</dd>
                    </div>
                  </dl>
                  <button type="button" className="button secondary" onClick={() => void save()}>
                    <Save size={16} />
                    保存配置
                  </button>
                  <button type="button" className="button secondary" onClick={() => void loadImpact()}>
                    读取删除影响
                  </button>
                  {impact !== undefined && (
                    <div className="callout">
                      <strong>外部删除影响</strong>
                      <p>
                        {impact.affected_projects.length} 个项目将解除映射：
                        {impact.affected_projects.map(item => item.name).join('、') || '无'}
                      </p>
                      <button type="button" className="text-danger" onClick={() => void deleteKnowledge()}>
                        确认删除知识库
                      </button>
                    </div>
                  )}
                </div>
              )}
              {tab === 'documents' && (
                <div className="project-tab">
                  <h4>文档与导入</h4>
                  <div className="inline-create">
                    <input
                      aria-label="文档标题"
                      placeholder="文档标题"
                      value={title}
                      onChange={(event) => {
                        setTitle(event.target.value)
                      }}
                    />
                    <textarea
                      aria-label="Markdown 内容"
                      placeholder="Markdown 内容"
                      value={markdown}
                      onChange={(event) => {
                        setMarkdown(event.target.value)
                      }}
                    />
                    <button type="button" className="button primary" onClick={() => void importMarkdown()} disabled={markdown.trim().length === 0}>
                      <Upload size={16} />
                      导入 Markdown
                    </button>
                  </div>
                  <div className="inline-create">
                    <input
                      aria-label="文档 URL"
                      placeholder="https://..."
                      value={url}
                      onChange={(event) => {
                        setUrl(event.target.value)
                      }}
                    />
                    <button type="button" className="button primary" onClick={() => void importUrl()} disabled={url.trim().length === 0}>
                      <Upload size={16} />
                      导入 URL
                    </button>
                  </div>
                  <div className="inline-create">
                    <input
                      aria-label="文件名"
                      placeholder="文件名"
                      value={fileName}
                      onChange={(event) => {
                        setFileName(event.target.value)
                      }}
                    />
                    <button type="button" className="button primary" onClick={() => void importFile()} disabled={fileName.trim().length === 0}>
                      <Upload size={16} />
                      导入文件
                    </button>
                  </div>
                  {operationStatus !== undefined && <p role="status">操作状态：{operationStatus}</p>}
                  <div className="member-list">
                    {documents.map(document => (
                      <div className="member-row" key={document.document_id}>
                        <span>
                          <strong>{document.title}</strong>
                          <small>
                            {document.source} · {document.status}
                          </small>
                        </span>
                        <span className="review-actions">
                          <button
                            type="button"
                            className="button secondary"
                            onClick={() =>
                              void api
                                .reparseKnowledgeDocument(
                                  selected.knowledge_base_id,
                                  document.document_id,
                                  selected.revision,
                                  crypto.randomUUID(),
                                )
                                .then((result) => {
                                  onAction(result, '重解析操作已提交')
                                })
                            }
                          >
                            重解析
                          </button>
                          <button
                            type="button"
                            className="text-danger"
                            onClick={() =>
                              void api
                                .deleteKnowledgeDocument(
                                  selected.knowledge_base_id,
                                  document.document_id,
                                  selected.revision,
                                  crypto.randomUUID(),
                                )
                                .then((result) => {
                                  onAction(result, '文档删除操作已提交')
                                })
                            }
                          >
                            删除
                          </button>
                        </span>
                      </div>
                    ))}
                    {documents.length === 0 && <Empty text="暂无文档" />}
                  </div>
                </div>
              )}
              {tab === 'faq' && (
                <div className="project-tab">
                  <h4>FAQ 条目</h4>
                  <p>FAQ 条目由 WeKnora 服务端管理，平台仅展示授权状态。</p>
                </div>
              )}
              {tab === 'wiki' && (
                <div className="project-tab">
                  <h4>Wiki 页面</h4>
                  <p>Wiki 页面由 WeKnora 服务端管理，平台仅展示授权状态。</p>
                </div>
              )}
              {tab === 'graph' && (
                <div className="project-tab">
                  <h4>知识图谱</h4>
                  <p>图谱节点和关系由 WeKnora 服务端返回。</p>
                  <button
                    type="button"
                    className="button secondary"
                    onClick={() =>
                      void api.getKnowledgeGraph(selected.knowledge_base_id).then((result) => {
                        onAction(result, '图谱已刷新')
                      })
                    }
                  >
                    刷新图谱
                  </button>
                </div>
              )}
              {tab === 'settings' && (
                <div className="project-tab">
                  <h4>基础设置</h4>
                  <p>类型创建后不可变；复杂模型与存储选项由外部服务管理。</p>
                </div>
              )}
              {tab === 'projects' && (
                <div className="project-tab">
                  <h4>项目关联</h4>
                  <p>项目映射由平台服务端校验组织和项目状态。</p>
                </div>
              )}
              {tab === 'audit' && (
                <div className="project-tab">
                  <h4>知识库审计</h4>
                  <p>审计字段和错误摘要由平台服务端返回。</p>
                </div>
              )}
            </div>
          </DetailDrawer>
        )}
      </div>
    </section>
  )
}

function MemoryLibraryPage({
  items,
  api,
  role,
  userId,
  onAction,
}: {
  readonly items: readonly AdminMemoryRecord[]
  readonly api: TeamSkillApi
  readonly role: AccountRole
  readonly userId?: string
  readonly onAction: (result: ApiResult<unknown>, success: string) => void
}) {
  const [projects, setProjects] = useState<readonly AdminProject[]>([])
  const [projectId, setProjectId] = useState('')
  const [keyword, setKeyword] = useState('')
  const [query, setQuery] = useState('')
  const [records, setRecords] = useState<readonly AdminMemoryRecord[]>(items)
  const [cursor, setCursor] = useState<string | undefined>()
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [selected, setSelected] = useState<AdminMemoryRecord | undefined>()
  const [content, setContent] = useState('')
  const [editing, setEditing] = useState(false)
  const [tab, setTab] = useState<'list' | 'policy' | 'jobs' | 'audit'>('list')
  const [policy, setPolicy] = useState<AdminMemoryPolicy | undefined>()
  const [jobs, setJobs] = useState<readonly AdminMemoryJob[]>([])
  const [audits, setAudits] = useState<readonly AdminMemoryAudit[]>([])
  const [askConfirmation, confirmationDialog] = useConfirmDialog()
  const [busy, setBusy] = useState(false)
  const [listError, setListError] = useState<string | undefined>()
  // The project context is itself a server read: until it settles the page has
  // no project to list records for, and that wait is a loading state, not an
  // empty list.
  const [projectsLoading, setProjectsLoading] = useState(true)
  const listRequest = useRef(0)
  const detailRequest = useRef(0)
  const governanceRequest = useRef(0)
  const mutationRequest = useRef(0)
  const canWrite = role !== 'member'
  const canEdit = (record: AdminMemoryRecord): boolean => canWrite || record.captured_by_user_id === userId

  useEffect(() => {
    void (role === 'member' ? api.listMemoryProjects() : api.listProjects()).then((result) => {
      setProjectsLoading(false)
      if (result.ok) {
        setProjects(result.value)
        // 空列表时 value[0] 不存在：保持页面自身的「未选择项目」表示（与同文件的
        // organizationId 引导一致，那里已有 result.value.length > 0 守卫），否则整页抛 TypeError。
        setProjectId(current => (current.length === 0 ? (result.value[0]?.project_id ?? '') : current))
      } else onAction(result, '读取项目失败')
    })
  }, [api, onAction, projectId.length, role])
  const loadRecords = async (next?: string, search = query): Promise<void> => {
    const requestId = ++listRequest.current
    const requestedProjectId = projectId
    setBusy(true)
    setListError(undefined)
    const result = await api.listMemoryRecords({
      projectId: requestedProjectId || undefined,
      keyword: search || undefined,
      cursor: next,
    })
    if (requestId !== listRequest.current || requestedProjectId !== projectId) return
    setBusy(false)
    if (!result.ok) {
      setListError(errorMessage(result.error))
      return
    }
    setRecords(result.value.items)
    setListError(undefined)
    setNextCursor(result.value.next_cursor)
    setCursor(next)
  }
  useEffect(() => {
    listRequest.current += 1
    detailRequest.current += 1
    governanceRequest.current += 1
    mutationRequest.current += 1
    setRecords([])
    setSelected(undefined)
    setContent('')
    setEditing(false)
    setKeyword('')
    setQuery('')
    setCursor(undefined)
    setNextCursor(null)
    setPolicy(undefined)
    setJobs([])
    setAudits([])
    if (projectId.length > 0) void loadRecords(undefined, '')
  }, [projectId])
  // First read for the current project context: the table has nothing to show
  // yet, so the wait renders as loading instead of an empty list.
  const recordsPending = (projectsLoading || (busy && records.length === 0)) && listError === undefined
  useEffect(() => {
    setRecords(items)
    setListError(undefined)
  }, [items])
  const select = async (record: AdminMemoryRecord): Promise<void> => {
    const requestId = ++detailRequest.current
    setSelected(record)
    setContent(record.content)
    setEditing(false)
    const result = await api.getMemoryRecord(record.memory_id)
    if (requestId !== detailRequest.current) return
    if (result.ok) {
      setSelected(result.value)
      setContent(result.value.content)
    } else onAction(result, '读取记忆详情失败')
  }
  const save = async (): Promise<void> => {
    if (selected === undefined || !canEdit(selected)) return
    const requestId = ++mutationRequest.current
    const requestedProjectId = projectId
    setBusy(true)
    const result = await api.updateMemoryRecord(selected.memory_id, content, selected.revision, crypto.randomUUID())
    setBusy(false)
    if (requestId !== mutationRequest.current || requestedProjectId !== projectId) return
    if (result.ok) {
      setSelected(result.value)
      setContent(result.value.content)
      setEditing(false)
      await loadRecords(cursor)
    }
    onAction(result, '记忆正文已保存')
  }
  const remove = async (): Promise<void> => {
    if (
      selected === undefined ||
      !canEdit(selected) ||
      !(await askConfirmation({
        title: '确认删除记忆',
        message: '删除后该记忆将立即不可召回，确认继续？',
        confirmLabel: '确认删除',
      }))
    )
      return
    const requestId = ++mutationRequest.current
    const requestedProjectId = projectId
    setBusy(true)
    const result = await api.deleteMemoryRecord(selected.memory_id, selected.revision, crypto.randomUUID())
    setBusy(false)
    if (requestId !== mutationRequest.current || requestedProjectId !== projectId) return
    if (result.ok) {
      setSelected(undefined)
      setEditing(false)
      await loadRecords(cursor)
    }
    onAction(result, '记忆删除任务已提交')
  }
  const loadGovernance = async (nextTab: typeof tab): Promise<void> => {
    setTab(nextTab)
    const requestId = ++governanceRequest.current
    const requestedProjectId = projectId
    if (nextTab === 'policy' && projectId) {
      const result = await api.getMemoryPolicy(projectId)
      if (requestId !== governanceRequest.current || requestedProjectId !== projectId) return
      if (result.ok) setPolicy(result.value)
      else onAction(result, '读取记忆策略失败')
    }
    if (nextTab === 'jobs') {
      const result = await api.listMemoryJobs(projectId || undefined)
      if (requestId !== governanceRequest.current || requestedProjectId !== projectId) return
      if (result.ok) setJobs(result.value.items)
      else onAction(result, '读取记忆任务失败')
    }
    if (nextTab === 'audit') {
      const result = await api.listMemoryAudit(projectId || undefined)
      if (requestId !== governanceRequest.current || requestedProjectId !== projectId) return
      if (result.ok) setAudits(result.value.items)
      else onAction(result, '读取记忆审计失败')
    }
  }
  const savePolicy = async (): Promise<void> => {
    if (policy === undefined || !projectId) return
    const requestId = ++governanceRequest.current
    const requestedProjectId = projectId
    const result = await api.updateMemoryPolicy(projectId, policy.values, policy.revision, crypto.randomUUID())
    if (requestId !== governanceRequest.current || requestedProjectId !== projectId) return
    if (result.ok) setPolicy(result.value)
    onAction(result, '记忆策略已保存')
  }
  const retry = async (job: AdminMemoryJob): Promise<void> => {
    const requestId = ++governanceRequest.current
    const requestedProjectId = projectId
    const result = await api.retryMemoryJob(job.job_id, job.revision, crypto.randomUUID())
    if (requestId !== governanceRequest.current || requestedProjectId !== projectId) return
    if (result.ok) setJobs(previous => previous.map(item => (item.job_id === job.job_id ? result.value : item)))
    onAction(result, '记忆任务已重试')
  }
  return (
    <>
      <section className="page-body">
        <div className="page-intro">
          <div>
            <span className="eyebrow">记忆库管理 / team + project</span>
            <h2>项目团队记忆库</h2>
            <p>服务端是唯一事实源；记忆捕获、召回和治理都按项目授权范围执行。</p>
          </div>
          <span className="count-badge">{records.length} 条</span>
        </div>
        <div className="detail-tabs" role="tablist" aria-label="记忆库页签">
          {(
            [
              ['list', '记忆列表'],
              ['policy', '策略'],
              ['jobs', '任务'],
              ['audit', '审计'],
            ] as const
          ).map(([id, label]) => (
            <button type="button" aria-selected={tab === id} className={tab === id ? 'tab active' : 'tab'} onClick={() => void loadGovernance(id)} key={id}>
              {label}
            </button>
          ))}
        </div>
        {tab === 'list' && (
          <>
            <div className="account-toolbar">
              <label>
                项目
                <select
                  aria-label="记忆项目"
                  value={projectId}
                  onChange={(event) => {
                    setProjectId(event.target.value)
                    setCursor(undefined)
                  }}
                >
                  {projects.map(project => (
                    <option key={project.project_id} value={project.project_id}>
                      {project.name}
                    </option>
                  ))}
                </select>
              </label>
              <form
                className="inline-create"
                onSubmit={(event) => {
                  event.preventDefault()
                  const nextQuery = keyword.trim()
                  setQuery(nextQuery)
                  setCursor(undefined)
                  void loadRecords(undefined, nextQuery)
                }}
              >
                <input
                  aria-label="记忆关键词"
                  placeholder="关键词"
                  value={keyword}
                  onChange={(event) => {
                    setKeyword(event.target.value)
                  }}
                />
                <button type="submit" className="button secondary" disabled={busy}>
                  <RefreshCw size={16} />
                  筛选
                </button>
              </form>
            </div>
            <div className="content-grid">
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>正文</th>
                      <th>项目</th>
                      <th>来源</th>
                      <th>修订</th>
                      <th>状态</th>
                    </tr>
                  </thead>
                  <tbody>
                    {records.map(record => (
                      <tr key={record.memory_id} className={selected?.memory_id === record.memory_id ? 'selected-row' : undefined} onClick={() => void select(record)}>
                        <td>
                          <button type="button" className="table-link" aria-label={record.content}>
                            {record.content}
                          </button>
                        </td>
                        <td>{record.project_id}</td>
                        <td>{record.captured_by_user_id}</td>
                        <td>r{record.revision}</td>
                        <td>
                          <Status status={record.status.toLowerCase()} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {listError !== undefined ? (
                  <div className="auth-error" role="alert">
                    {listError}
                  </div>
                ) : recordsPending ? (
                  <Loading />
                ) : (
                  records.length === 0 && <Empty text="当前项目没有可见记忆" />
                )}
                <div className="pagination">
                  <button type="button" className="button secondary" disabled={!cursor || busy} onClick={() => void loadRecords()}>
                    上一页
                  </button>
                  <button type="button" className="button secondary" disabled={!nextCursor || busy} onClick={() => void loadRecords(nextCursor ?? undefined)}>
                    下一页
                  </button>
                </div>
              </div>
              {selected !== undefined && (
                <DetailDrawer label="记忆详情" onClose={() =>{  setSelected(undefined) }}>
                  <aside className="detail-panel drawer-body">
                    <div className="editor-heading">
                      <div>
                        <span className="eyebrow">记忆详情</span>
                        <h3>{selected.memory_id}</h3>
                      </div>
                      <span className="revision">r{selected.revision}</span>
                    </div>
                    <dl>
                      <div>
                        <dt>项目</dt>
                        <dd>{selected.project_id}</dd>
                      </div>
                      <div>
                        <dt>捕获者</dt>
                        <dd>{selected.captured_by_user_id}</dd>
                      </div>
                      <div>
                        <dt>召回次数</dt>
                        <dd>{selected.recall_count}</dd>
                      </div>
                    </dl>
                    <label>
                      记忆正文
                      <textarea
                        aria-label="记忆正文"
                        value={content}
                        disabled={!editing || !canEdit(selected) || busy}
                        onChange={(event) => {
                          setContent(event.target.value)
                        }}
                      />
                    </label>
                    <div className="review-actions">
                      {editing ? (
                        <button type="button" className="button secondary" disabled={!canEdit(selected) || busy || content.trim().length === 0} onClick={() => void save()}>
                          <Save size={16} />
                          保存记忆
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="button secondary"
                          disabled={!canEdit(selected) || busy}
                          onClick={() => {
                            setEditing(true)
                          }}
                        >
                          <FilePenLine size={16} />
                          编辑记忆
                        </button>
                      )}
                      <button type="button" className="button danger" disabled={!canEdit(selected) || busy} onClick={() => void remove()}>
                        删除记忆
                      </button>
                    </div>
                  </aside>
                </DetailDrawer>
              )}
            </div>
          </>
        )}
        {tab === 'policy' && (
          <section className="editor-panel">
            <div className="section-title">
              <strong>记忆召回策略</strong>
              {policy !== undefined && <span className="revision">r{policy.revision}</span>}
            </div>
            {policy === undefined ? (
              <Loading />
            ) : (
              <>
                <div className="form-columns">
                  <label>
                    top_k
                    <input
                      type="number"
                      min="1"
                      max="8"
                      value={policy.values.top_k}
                      onChange={(event) => {
                        setPolicy({
                          ...policy,
                          values: {
                            ...policy.values,
                            top_k: Number(event.target.value),
                          },
                        })
                      }}
                    />
                  </label>
                  <label>
                    relevance_threshold
                    <input
                      type="number"
                      min="0"
                      max="1"
                      step="0.05"
                      value={policy.values.relevance_threshold}
                      onChange={(event) => {
                        setPolicy({
                          ...policy,
                          values: {
                            ...policy.values,
                            relevance_threshold: Number(event.target.value),
                          },
                        })
                      }}
                    />
                  </label>
                  <label>
                    token_budget
                    <input
                      type="number"
                      min="1"
                      value={policy.values.token_budget}
                      onChange={(event) => {
                        setPolicy({
                          ...policy,
                          values: {
                            ...policy.values,
                            token_budget: Number(event.target.value),
                          },
                        })
                      }}
                    />
                  </label>
                </div>
                <p>继承来源：{policy.inherited_from ?? '无'}</p>
                <button type="button" className="button primary" disabled={!canWrite} onClick={() => void savePolicy()}>
                  <Save size={16} />
                  保存策略
                </button>
              </>
            )}
          </section>
        )}
        {tab === 'jobs' && (
          <section className="table-wrap">
            <h3>记忆处理任务</h3>
            <table>
              <thead>
                <tr>
                  <th>任务</th>
                  <th>类型</th>
                  <th>状态</th>
                  <th>错误</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {jobs.map(job => (
                  <tr key={job.job_id}>
                    <td>{job.job_id}</td>
                    <td>{job.kind}</td>
                    <td>{job.status}</td>
                    <td>{job.error_code ?? '-'}</td>
                    <td>
                      {job.retryable && (
                        <button type="button" className="button secondary" disabled={!canWrite} onClick={() => void retry(job)}>
                          重试
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {jobs.length === 0 && <Empty text="暂无记忆处理任务" />}
          </section>
        )}
        {tab === 'audit' && (
          <section className="table-wrap">
            <h3>记忆治理审计</h3>
            <table>
              <thead>
                <tr>
                  <th>操作</th>
                  <th>记忆</th>
                  <th>项目</th>
                  <th>操作者</th>
                  <th>结果</th>
                </tr>
              </thead>
              <tbody>
                {audits.map(audit => (
                  <tr key={audit.audit_id}>
                    <td>{audit.operation}</td>
                    <td>{audit.memory_id ?? '-'}</td>
                    <td>{audit.project_id}</td>
                    <td>{audit.operated_by_user_id}</td>
                    <td>{audit.result}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {audits.length === 0 && <Empty text="暂无记忆治理审计" />}
          </section>
        )}
      </section>
      {confirmationDialog}
    </>
  )
}

function DraftsPage({
  items,
  api,
  onAction,
}: {
  items: readonly TeamSkill[]
  api: TeamSkillApi
  onAction: (result: ApiResult<unknown>, message: string) => void
}) {
  const editable = items.filter(item => item.status === 'draft' || item.status === 'published' || item.status === 'withdrawn')
  const [selectedId, setSelectedId] = useState<string | undefined>()
  const [detail, setDetail] = useState<{ readonly skill: TeamSkill; readonly versions: readonly SkillVersion[] } | undefined>()
  const [detailLoading, setDetailLoading] = useState(false)
  const [name, setName] = useState('')
  const [summary, setSummary] = useState('')
  const [category, setCategory] = useState('工程效率')
  const [tags, setTags] = useState('团队')
  const [visibility, setVisibility] = useState<TeamSkill['visibility']>('organization')
  const [groupId, setGroupId] = useState('platform')
  const [peopleIds, setPeopleIds] = useState<readonly string[]>([])
  const [directoryUsers, setDirectoryUsers] = useState<readonly DirectoryUser[]>([])
  const [directoryLoading, setDirectoryLoading] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (visibility !== 'people') return
    setDirectoryLoading(true)
    void api.listDirectoryUsers().then((result) => {
      setDirectoryLoading(false)
      if (result.ok) setDirectoryUsers(result.value)
      else onAction(result, '读取组织目录失败')
    })
  }, [api, onAction, visibility])

  const loadDetail = async (skillId: string): Promise<void> => {
    setSelectedId(skillId)
    setDetailLoading(true)
    const result = await api.getSkill(skillId)
    setDetailLoading(false)
    if (result.ok) setDetail(result.value)
    else onAction(result, '读取草稿详情失败')
  }

  const create = async (): Promise<void> => {
    setBusy(true)
    const result = await api.createSkill({
      displayName: name.trim(),
      summary: summary.trim(),
      category: category.trim(),
      tags: splitList(tags),
      visibility,
      ...(visibility === 'group' ? { groupId } : {}),
      ...(visibility === 'people' && peopleIds.length > 0 ? { peopleIds } : {}),
    })
    setBusy(false)
    onAction(result, '草稿已创建')
  }

  return (
    <section className="page-body">
      <div className="page-intro">
        <div>
          <span className="eyebrow">作者工作区</span>
          <h2>我的草稿</h2>
          <p>作者只能编辑草稿；服务端会校验制品、依赖、权限和可见范围后再允许提交审核。</p>
        </div>
        <span className="count-badge">{editable.length} 项</span>
      </div>
      <div className="draft-layout">
        <div className="draft-list">
          <div className="list-title">
            我的 Skill <span>{editable.length}</span>
          </div>
          {editable.map(item => (
            <button type="button" className={selectedId === item.skillId ? 'draft-row selected-draft' : 'draft-row'} key={item.skillId} onClick={() => void loadDetail(item.skillId)}>
              <span>
                <strong>{item.displayName}</strong>
                <small>
                  r{item.revision} · {visibilityLabel(item.visibility)}
                </small>
              </span>
              <Status status={item.status} />
            </button>
          ))}
          {editable.length === 0 && <Empty text="没有待编辑草稿" />}
        </div>
        <CreateSkillForm
          name={name}
          summary={summary}
          category={category}
          tags={tags}
          visibility={visibility}
          groupId={groupId}
          peopleIds={peopleIds}
          directoryUsers={directoryUsers}
          directoryLoading={directoryLoading}
          busy={busy}
          onName={setName}
          onSummary={setSummary}
          onCategory={setCategory}
          onTags={setTags}
          onVisibility={setVisibility}
          onGroupId={setGroupId}
          onPeopleIds={setPeopleIds}
          onSubmit={() => void create()}
        />
      </div>
      {selectedId !== undefined && <div className="draft-editor-wrap">{detailLoading || detail === undefined ? <Loading /> : <DraftEditor detail={detail} api={api} onAction={onAction} onRefresh={() => loadDetail(selectedId)} />}</div>}
    </section>
  )
}

function CreateSkillForm({
  name,
  summary,
  category,
  tags,
  visibility,
  groupId,
  peopleIds,
  directoryUsers,
  directoryLoading,
  busy,
  onName,
  onSummary,
  onCategory,
  onTags,
  onVisibility,
  onGroupId,
  onPeopleIds,
  onSubmit,
}: {
  name: string
  summary: string
  category: string
  tags: string
  visibility: TeamSkill['visibility']
  groupId: string
  peopleIds: readonly string[]
  directoryUsers: readonly DirectoryUser[]
  directoryLoading: boolean
  busy: boolean
  onName: (value: string) => void
  onSummary: (value: string) => void
  onCategory: (value: string) => void
  onTags: (value: string) => void
  onVisibility: (value: TeamSkill['visibility']) => void
  onGroupId: (value: string) => void
  onPeopleIds: (value: readonly string[]) => void
  onSubmit: () => void
}) {
  return (
    <form
      className="form-panel"
      onSubmit={(event) => {
        event.preventDefault()
        onSubmit()
      }}
    >
      <span className="eyebrow">新建 Skill</span>
      <h3>创建草稿版本</h3>
      <label>
        中文名称
        <input
          value={name}
          onChange={(event) => {
            onName(event.target.value)
          }}
          required
          placeholder="例如：代码评审"
        />
      </label>
      <label>
        简介
        <textarea
          value={summary}
          onChange={(event) => {
            onSummary(event.target.value)
          }}
          required
          placeholder="说明 Skill 的适用场景和边界"
        />
      </label>
      <div className="form-columns">
        <label>
          分类
          <input
            aria-label="分类"
            value={category}
            onChange={(event) => {
              onCategory(event.target.value)
            }}
            required
          />
        </label>
        <label>
          标签
          <input
            aria-label="标签"
            value={tags}
            onChange={(event) => {
              onTags(event.target.value)
            }}
            placeholder="用逗号分隔"
          />
        </label>
      </div>
      <label>
        可见范围
        <select
          value={visibility}
          onChange={(event) => {
            onVisibility(event.target.value as TeamSkill['visibility'])
          }}
        >
          <option value="organization">所有人可见</option>
          <option value="group">本组内可见</option>
          <option value="people">特定人员可见</option>
        </select>
      </label>
      {visibility === 'group' && (
        <label>
          可见组
          <select
            aria-label="可见组"
            value={groupId}
            onChange={(event) => {
              onGroupId(event.target.value)
            }}
          >
            <option value="platform">平台组</option>
          </select>
        </label>
      )}
      {visibility === 'people' && <PeopleSelector users={directoryUsers} selected={peopleIds} loading={directoryLoading} onChange={onPeopleIds} />}
      <div className="form-note">版本说明、依赖、权限和 ZIP 制品将在创建后编辑；特定人员只能从服务端组织目录加入。</div>
      <button className="button primary" disabled={busy || name.trim().length === 0 || summary.trim().length === 0}>
        <Plus size={16} />
        {busy ? '正在创建…' : '创建草稿'}
      </button>
    </form>
  )
}

function DraftEditor({
  detail,
  api,
  onAction,
  onRefresh,
}: {
  detail: {
    readonly skill: TeamSkill
    readonly versions: readonly SkillVersion[]
  }
  api: TeamSkillApi
  onAction: (result: ApiResult<unknown>, message: string) => void
  onRefresh: () => Promise<void>
}) {
  const { skill, versions } = detail
  const draftVersion = versions.find(version => version.status === 'draft')
  const [name, setName] = useState(skill.displayName)
  const [summary, setSummary] = useState(skill.summary)
  const [category, setCategory] = useState(skill.category)
  const [tags, setTags] = useState(skill.tags.join(', '))
  const [visibility, setVisibility] = useState<TeamSkill['visibility']>(skill.visibility)
  const [groupId, setGroupId] = useState(skill.groupId ?? 'platform')
  const [peopleIds, setPeopleIds] = useState<readonly string[]>(skill.peopleIds ?? [])
  const [directoryUsers, setDirectoryUsers] = useState<readonly DirectoryUser[]>([])
  const [directoryLoading, setDirectoryLoading] = useState(false)
  const [releaseNotes, setReleaseNotes] = useState(draftVersion?.releaseNotes ?? '')
  const [dependencies, setDependencies] = useState(draftVersion?.dependencies.join('\n') ?? '')
  const [permissions, setPermissions] = useState(draftVersion?.permissions.join('\n') ?? '')
  const [newVersion, setNewVersion] = useState('')
  const [newReleaseNotes, setNewReleaseNotes] = useState('')
  const [file, setFile] = useState<File | undefined>()
  const [uploaded, setUploaded] = useState(false)
  const [busy, setBusy] = useState<string | undefined>()

  useEffect(() => {
    setName(skill.displayName)
    setSummary(skill.summary)
    setCategory(skill.category)
    setTags(skill.tags.join(', '))
    setVisibility(skill.visibility)
    setGroupId(skill.groupId ?? 'platform')
    setPeopleIds(skill.peopleIds ?? [])
    setReleaseNotes(draftVersion?.releaseNotes ?? '')
    setDependencies(draftVersion?.dependencies.join('\n') ?? '')
    setPermissions(draftVersion?.permissions.join('\n') ?? '')
    setFile(undefined)
    setUploaded(draftVersion?.artifactSizeBytes !== undefined && draftVersion.artifactSizeBytes > 0)
  }, [
    draftVersion?.artifactSizeBytes,
    draftVersion?.releaseNotes,
    draftVersion?.revision,
    skill.category,
    skill.displayName,
    skill.groupId,
    skill.peopleIds,
    skill.revision,
    skill.summary,
    skill.tags,
    skill.visibility,
  ])

  useEffect(() => {
    if (visibility !== 'people') return
    setDirectoryLoading(true)
    void api.listDirectoryUsers().then((result) => {
      setDirectoryLoading(false)
      if (result.ok) setDirectoryUsers(result.value)
      else onAction(result, '读取组织目录失败')
    })
  }, [api, onAction, visibility])

  const run = async (key: string, resultPromise: Promise<ApiResult<unknown>>, message: string): Promise<void> => {
    setBusy(key)
    const result = await resultPromise
    setBusy(undefined)
    onAction(result, message)
    if (result.ok) await onRefresh()
  }
  const saveSkill = (): Promise<void> =>
    run(
      'skill',
      api.updateSkill(
        skill.skillId,
        {
          displayName: name.trim(),
          summary: summary.trim(),
          category: category.trim(),
          tags: splitList(tags),
          visibility,
          ...(visibility === 'group' ? { groupId } : {}),
          ...(visibility === 'people' ? { peopleIds } : {}),
        },
        skill.revision,
        crypto.randomUUID(),
      ),
      'Skill 信息已保存',
    )
  const saveVersion = (): Promise<void> =>
    draftVersion === undefined
      ? Promise.resolve()
      : run(
        'version',
        api.updateVersion(
          skill.skillId,
          draftVersion.version,
          {
            releaseNotes,
            dependencies: splitLines(dependencies),
            permissions: splitLines(permissions),
          },
          draftVersion.revision,
          crypto.randomUUID(),
        ),
        '版本信息已保存',
      )
  const upload = async (): Promise<void> => {
    if (draftVersion === undefined || file === undefined) return
    const bytes = new Uint8Array(await file.arrayBuffer())
    await run('upload', api.uploadArtifact(skill.skillId, draftVersion.version, bytes, draftVersion.revision, crypto.randomUUID()), 'ZIP 已上传并完成服务端校验')
    setUploaded(true)
  }
  const submit = (): Promise<void> => (draftVersion === undefined || !uploaded ? Promise.resolve() : run('submit', api.submitReview(skill.skillId, draftVersion.version, draftVersion.revision, skill.revision, crypto.randomUUID()), '版本已提交审核'))
  const createVersion = (): Promise<void> =>
    newVersion.trim().length === 0
      ? Promise.resolve()
      : run(
        'new-version',
        api.createVersion(
          skill.skillId,
          {
            version: newVersion.trim(),
            releaseNotes: newReleaseNotes.trim(),
          },
          skill.revision,
          crypto.randomUUID(),
        ),
        '新版本草稿已创建',
      )
  const editable = skill.status === 'draft'
  return (
    <section className="editor-panel">
      <div className="editor-heading">
        <div>
          <span className="eyebrow">草稿编辑器</span>
          <h3>{skill.displayName}</h3>
        </div>
        <Status status={skill.status} />
      </div>
      <div className="editor-section">
        <div className="section-title">
          <strong>基本信息与可见范围</strong>
          <span className="revision">Skill r{skill.revision}</span>
        </div>
        <div className="form-columns">
          <label>
            中文名称
            <input
              value={name}
              disabled={!editable}
              onChange={(event) => {
                setName(event.target.value)
              }}
            />
          </label>
          <label>
            分类
            <input
              aria-label="分类"
              value={category}
              disabled={!editable}
              onChange={(event) => {
                setCategory(event.target.value)
              }}
            />
          </label>
        </div>
        <label>
          简介
          <textarea
            value={summary}
            disabled={!editable}
            onChange={(event) => {
              setSummary(event.target.value)
            }}
          />
        </label>
        <label>
          标签
          <input
            aria-label="标签"
            value={tags}
            disabled={!editable}
            onChange={(event) => {
              setTags(event.target.value)
            }}
          />
        </label>
        <label>
          可见范围
          <select
            value={visibility}
            disabled={!editable}
            onChange={(event) => {
              setVisibility(event.target.value as TeamSkill['visibility'])
            }}
          >
            <option value="organization">所有人可见</option>
            <option value="group">本组内可见</option>
            <option value="people">特定人员可见</option>
          </select>
        </label>
        {editable && visibility === 'group' && (
          <label>
            可见组
            <select
              aria-label="可见组"
              value={groupId}
              onChange={(event) => {
                setGroupId(event.target.value)
              }}
            >
              <option value="platform">平台组</option>
            </select>
          </label>
        )}
        {editable && visibility === 'people' && <PeopleSelector users={directoryUsers} selected={peopleIds} loading={directoryLoading} onChange={setPeopleIds} />}
        <button type="button" className="button secondary" disabled={!editable || busy !== undefined} onClick={() => void saveSkill()}>
          <Save size={16} />
          保存 Skill 信息
        </button>
      </div>
      {draftVersion === undefined ? (
        <div className="editor-section">
          <div className="section-title">
            <strong>创建新版本</strong>
            <span className="callout-inline">已发布内容不可编辑</span>
          </div>
          <div className="form-columns">
            <label>
              语义化版本
              <input
                aria-label="新版本号"
                value={newVersion}
                placeholder="例如：1.1.0"
                onChange={(event) => {
                  setNewVersion(event.target.value)
                }}
              />
            </label>
            <label>
              版本说明
              <input
                aria-label="新版本说明"
                value={newReleaseNotes}
                onChange={(event) => {
                  setNewReleaseNotes(event.target.value)
                }}
              />
            </label>
          </div>
          <button type="button" className="button primary" disabled={busy !== undefined || newVersion.trim().length === 0} onClick={() => void createVersion()}>
            <Plus size={16} />
            创建版本草稿
          </button>
        </div>
      ) : (
        <>
          <div className="editor-section">
            <div className="section-title">
              <strong>版本信息</strong>
              <span className="revision">
                v{draftVersion.version} · r{draftVersion.revision}
              </span>
            </div>
            <label>
              版本说明
              <textarea
                aria-label="版本说明"
                value={releaseNotes}
                onChange={(event) => {
                  setReleaseNotes(event.target.value)
                }}
              />
            </label>
            <div className="form-columns">
              <label>
                依赖
                <textarea
                  aria-label="依赖"
                  value={dependencies}
                  onChange={(event) => {
                    setDependencies(event.target.value)
                  }}
                  placeholder="每行一个依赖"
                />
              </label>
              <label>
                权限
                <textarea
                  aria-label="权限"
                  value={permissions}
                  onChange={(event) => {
                    setPermissions(event.target.value)
                  }}
                  placeholder="每行一个权限"
                />
              </label>
            </div>
            <button type="button" className="button secondary" disabled={busy !== undefined} onClick={() => void saveVersion()}>
              <Save size={16} />
              保存版本信息
            </button>
          </div>
          <div className="editor-section">
            <div className="section-title">
              <strong>平台托管制品</strong>
              <span className="revision">{draftVersion.artifactSizeBytes === undefined || draftVersion.artifactSizeBytes === 0 ? '尚未上传' : `${draftVersion.artifactSizeBytes} bytes`}</span>
            </div>
            <label>
              Skill ZIP
              <input
                aria-label="Skill ZIP"
                type="file"
                accept=".zip,application/zip"
                onChange={(event) => {
                  setFile(event.target.files?.[0])
                  setUploaded(false)
                }}
              />
            </label>
            <div className="validation-list">
              {draftVersion.validation.map(item => (
                <span key={item.name} className={item.status === 'passed' ? 'validation passed' : 'validation failed'}>
                  {item.status === 'passed' ? <CheckCircle2 size={16} /> : <TriangleAlert size={16} />}
                  {item.name}
                </span>
              ))}
            </div>
            <button type="button" className="button secondary" disabled={busy !== undefined || file === undefined} onClick={() => void upload()}>
              <Upload size={16} />
              上传 ZIP
            </button>
          </div>
          <div className="editor-section submit-section">
            <div>
              <strong>提交审核</strong>
              <p>只有平台制品的自动校验全部通过后，服务端才会接受提交。</p>
            </div>
            <button type="button" className="button primary" disabled={busy !== undefined || !uploaded} onClick={() => void submit()}>
              <ShieldCheck size={16} />
              提交审核
            </button>
          </div>
        </>
      )}
    </section>
  )
}

function PeopleSelector({
  users,
  selected,
  loading,
  onChange,
}: {
  users: readonly DirectoryUser[]
  selected: readonly string[]
  loading: boolean
  onChange: (value: readonly string[]) => void
}) {
  const toggle = (userId: string): void => {
    onChange(selected.includes(userId) ? selected.filter(value => value !== userId) : [...selected, userId])
  }
  return (
    <fieldset className="people-selector">
      <legend>
        <Users size={16} />
        可见人员
      </legend>
      {loading ? (
        <span className="field-hint">正在读取组织目录…</span>
      ) : users.length === 0 ? (
        <span className="field-hint">组织目录没有可选人员</span>
      ) : (
        users.map(user => (
          <label key={user.userId}>
            <input
              type="checkbox"
              checked={selected.includes(user.userId)}
              onChange={() => {
                toggle(user.userId)
              }}
            />
            {user.displayName}
            <small>{user.email}</small>
          </label>
        ))
      )}
    </fieldset>
  )
}

function splitList(value: string): readonly string[] {
  return value
    .split(',')
    .map(item => item.trim())
    .filter(item => item.length > 0)
}
function splitLines(value: string): readonly string[] {
  return value
    .split(/\r?\n/u)
    .map(item => item.trim())
    .filter(item => item.length > 0)
}

function ReviewsPage({
  items: allItems,
  api,
  onAction,
  workbenchFilter,
}: {
  items: readonly ReviewItem[]
  api: TeamSkillApi
  onAction: (result: ApiResult<unknown>, message: string) => void
  workbenchFilter?: WorkbenchFilter
}) {
  // 审核队列同样客户端落实工作台跳转的过滤（4-1）。
  const items = workbenchFilter?.status === undefined ? allItems : allItems.filter(item => item.version.status === workbenchFilter.status)
  const [selectedKey, setSelectedKey] = useState<string | undefined>()
  const [checks, setChecks] = useState<Record<string, 'pass' | 'fail' | 'na'>>({})
  const [busy, setBusy] = useState(false)
  const [rejectOpen, setRejectOpen] = useState(false)
  const [rejectReason, setRejectReason] = useState('')
  const current = useMemo(() => items.find(item => reviewKey(item) === selectedKey) ?? items.at(0), [items, selectedKey])
  const currentKey = current === undefined ? undefined : reviewKey(current)

  useEffect(() => {
    setChecks({})
    setRejectOpen(false)
    setRejectReason('')
  }, [currentKey])

  const approve = async (): Promise<void> => {
    if (current === undefined) return
    setBusy(true)
    const result = await api.approve(
      current.skill.skillId,
      current.version.version,
      checks,
      current.version.revision,
      current.skill.revision,
      crypto.randomUUID(),
    )
    setBusy(false)
    onAction(result, '版本已批准')
  }

  const reject = async (): Promise<void> => {
    if (current === undefined || rejectReason.trim().length === 0) return
    setBusy(true)
    const result = await api.reject(
      current.skill.skillId,
      current.version.version,
      rejectReason.trim(),
      current.version.revision,
      current.skill.revision,
      crypto.randomUUID(),
    )
    setBusy(false)
    if (result.ok) {
      setRejectOpen(false)
      setRejectReason('')
    }
    onAction(result, '版本已驳回')
  }

  return (
    <section className="page-body">
      <div className="page-intro">
        <div>
          <span className="eyebrow">管理员工作区</span>
          <h2>审核队列</h2>
          <p>未完成结构化审核项不能批准。驳回原因必须由服务端记录。</p>
        </div>
        <span className="count-badge warning">{items.length} 待处理</span>
      </div>
      {current === undefined ? (
        <Empty text="当前没有待审核版本" />
      ) : (
        <div className="review-layout">
          <div className="review-list">
            {items.map(item => (
              <button
                type="button"
                className={reviewKey(item) === currentKey ? 'review-item selected-review' : 'review-item'}
                key={reviewKey(item)}
                onClick={() => {
                  setSelectedKey(reviewKey(item))
                }}
              >
                <strong>{item.skill.displayName}</strong>
                <small>
                  v{item.version.version} · {item.skill.authorName ?? '作者未提供'}
                </small>
                <Status status={item.version.status} />
              </button>
            ))}
          </div>
          <div className="review-panel">
            <div className="review-title">
              <div>
                <span className="eyebrow">待审版本</span>
                <h3>
                  {current.skill.displayName} v{current.version.version}
                </h3>
              </div>
              <span className="revision">r{current.version.revision}</span>
            </div>
            <ReviewBlock title="内容与文件" value={current.version.releaseNotes} />
            <ReviewBlock title="依赖与权限" value={[...current.version.dependencies, ...current.version.permissions].join('、') || '未声明'} />
            <fieldset className="checks">
              <legend>人工审核清单</legend>
              {current.reviewChecks.map(check => (
                <label key={check.id}>
                  <input
                    type="checkbox"
                    checked={checks[check.id] === 'pass'}
                    onChange={(event) => {
                      setChecks(previous => ({
                        ...previous,
                        [check.id]: event.target.checked ? 'pass' : 'fail',
                      }))
                    }}
                  />
                  {check.label}
                </label>
              ))}
            </fieldset>
            <div className="review-actions">
              <button type="button" className="button primary" disabled={busy || current.reviewChecks.some(check => checks[check.id] !== 'pass')} onClick={() => void approve()}>
                <ShieldCheck size={16} />
                批准版本
              </button>
              <button
                type="button"
                className="button danger"
                disabled={busy}
                onClick={() => {
                  setRejectOpen(true)
                }}
              >
                驳回版本
              </button>
            </div>
          </div>
        </div>
      )}
      {rejectOpen && current !== undefined && (
        <ReasonDialog
          title="驳回版本"
          label="驳回原因"
          value={rejectReason}
          busy={busy}
          confirmLabel="确认驳回"
          onChange={setRejectReason}
          onCancel={() => {
            setRejectOpen(false)
          }}
          onConfirm={() => void reject()}
        />
      )}
    </section>
  )
}

function reviewKey(item: ReviewItem): string {
  return `${item.skill.skillId}-${item.version.version}`
}
function ReviewBlock({ title, value }: { title: string; value: string }) {
  return (
    <div className="review-block">
      <strong>{title}</strong>
      <p>{value}</p>
    </div>
  )
}

/**
 * 对话框打开期间：壳层其余部分带 `inert` 离开 Tab 顺序（遮罩后的内容不可达），
 * 焦点进入对话框首个控件并在关闭后归还触发控件。从对话框自身向上逐层屏蔽兄弟
 * 节点，所以对话框不需要被传送到 body。
 */
function useModalFocus(ref: React.RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const dialog = ref.current
    if (dialog === null) return
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : undefined
    const masked: HTMLElement[] = []
    const maskSiblings = (element: HTMLElement): void => {
      const parent = element.parentElement
      if (parent === null) return
      for (const sibling of Array.from(parent.children)) {
        if (sibling === element || !(sibling instanceof HTMLElement) || sibling.inert) continue
        sibling.inert = true
        masked.push(sibling)
      }
      if (!parent.classList.contains('admin-shell')) maskSiblings(parent)
    }
    maskSiblings(dialog)
    dialog.querySelector<HTMLElement>('button:not([disabled]), textarea, select, input, [href]')?.focus()
    return () => {
      for (const element of masked) element.inert = false
      // 触发器可能已被重新渲染移除；只有在它仍然可聚焦时才归还焦点。
      if (trigger !== undefined && trigger.isConnected && !trigger.inert) trigger.focus()
    }
  }, [ref])
}

function ReasonDialog({
  title,
  label,
  value,
  busy,
  confirmLabel,
  onChange,
  onCancel,
  onConfirm,
}: {
  title: string
  label: string
  value: string
  busy: boolean
  confirmLabel: string
  onChange: (value: string) => void
  onCancel: () => void
  onConfirm: () => void
}) {
  const dialogRef = useRef<HTMLElement | null>(null)
  useModalFocus(dialogRef)
  return (
    <div className="dialog-backdrop">
      <section ref={dialogRef} className="dialog" role="dialog" aria-modal="true" aria-labelledby="reason-dialog-title">
        <h2 id="reason-dialog-title">{title}</h2>
        <label>
          {label}
          <textarea
            aria-label={label}
            value={value}
            onChange={(event) => {
              onChange(event.target.value)
            }}
            autoFocus
          />
        </label>
        <div className="dialog-actions">
          <button type="button" className="button secondary" onClick={onCancel}>
            取消
          </button>
          <button type="button" className="button danger" disabled={busy || value.trim().length === 0} onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </section>
    </div>
  )
}

function ConfirmDialog({
  title,
  message,
  busy,
  confirmLabel,
  onCancel,
  onConfirm,
}: {
  title: string
  message: string
  busy: boolean
  confirmLabel: string
  onCancel: () => void
  onConfirm: () => void
}) {
  const dialogRef = useRef<HTMLElement | null>(null)
  useModalFocus(dialogRef)
  return (
    <div className="dialog-backdrop">
      <section ref={dialogRef} className="dialog" role="dialog" aria-modal="true" aria-labelledby="confirm-dialog-title">
        <h2 id="confirm-dialog-title">{title}</h2>
        <p>{message}</p>
        <div className="dialog-actions">
          <button type="button" className="button secondary" onClick={onCancel}>
            取消
          </button>
          <button type="button" className="button primary" disabled={busy} onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </section>
    </div>
  )
}

type ConfirmationRequest = {
  readonly title: string
  readonly message: string
  readonly confirmLabel?: string
}

function useConfirmDialog(): readonly [(request: ConfirmationRequest) => Promise<boolean>, React.ReactNode] {
  const [request, setRequest] = useState<(ConfirmationRequest & { readonly resolve: (value: boolean) => void }) | undefined>()
  const ask = useCallback(
    (next: ConfirmationRequest): Promise<boolean> =>
      new Promise((resolve) => {
        setRequest({ ...next, resolve })
      }),
    [],
  )
  const dialog =
    request === undefined ? null : (
      <ConfirmDialog
        title={request.title}
        message={request.message}
        busy={false}
        confirmLabel={request.confirmLabel ?? '确认'}
        onCancel={() => {
          const current = request
          setRequest(undefined)
          current.resolve(false)
        }}
        onConfirm={() => {
          const current = request
          setRequest(undefined)
          current.resolve(true)
        }}
      />
    )
  return [ask, dialog]
}

function RollbackDialog({
  versions,
  current,
  value,
  busy,
  onChange,
  onCancel,
  onConfirm,
}: {
  versions: readonly string[]
  current: string | undefined
  value: string
  busy: boolean
  onChange: (value: string) => void
  onCancel: () => void
  onConfirm: () => void
}) {
  const options = versions.filter(version => version !== current)
  const dialogRef = useRef<HTMLElement | null>(null)
  useModalFocus(dialogRef)
  return (
    <div className="dialog-backdrop">
      <section ref={dialogRef} className="dialog" role="dialog" aria-modal="true" aria-labelledby="rollback-dialog-title">
        <h2 id="rollback-dialog-title">回滚版本</h2>
        <p>选择一个历史已发布版本作为当前推荐版本。</p>
        <label>
          目标版本
          <select
            aria-label="回滚目标版本"
            value={value}
            onChange={(event) => {
              onChange(event.target.value)
            }}
          >
            <option value="">请选择版本</option>
            {options.map(version => (
              <option key={version} value={version}>
                v{version}
              </option>
            ))}
          </select>
        </label>
        <div className="dialog-actions">
          <button type="button" className="button secondary" onClick={onCancel}>
            取消
          </button>
          <button type="button" className="button primary" disabled={busy || value.length === 0} onClick={onConfirm}>
            确认回滚
          </button>
        </div>
      </section>
    </div>
  )
}

function ReleasesPage({
  items,
  api,
  onAction,
}: {
  items: readonly TeamSkill[]
  api: TeamSkillApi
  onAction: (result: ApiResult<unknown>, message: string) => void
}) {
  const governed = items.filter(item => item.status === 'approved' || item.status === 'published' || item.status === 'withdrawn')
  const [busyKey, setBusyKey] = useState<string | undefined>()
  const [dialog, setDialog] = useState<
    | {
      readonly kind: 'publish' | 'withdraw' | 'rollback'
      readonly item: TeamSkill
    }
    | undefined
  >()
  const [reason, setReason] = useState('')
  const [rollbackVersion, setRollbackVersion] = useState('')

  const closeDialog = (): void => {
    setDialog(undefined)
    setReason('')
    setRollbackVersion('')
  }
  const confirm = async (): Promise<void> => {
    if (dialog === undefined) return
    const { item } = dialog
    const version = item.currentVersion ?? item.latestVersion
    if (version === undefined) return
    if (dialog.kind === 'withdraw' && reason.trim().length === 0) return
    if (dialog.kind === 'rollback' && rollbackVersion.length === 0) return
    setBusyKey(item.skillId)
    const result = dialog.kind === 'publish' ? await api.publish(item.skillId, version, item.latestVersionRevision ?? item.revision, item.revision, crypto.randomUUID()) : dialog.kind === 'withdraw' ? await api.withdraw(item.skillId, version, reason.trim(), item.latestVersionRevision ?? item.revision, item.revision, crypto.randomUUID()) : await api.rollback(item.skillId, rollbackVersion, item.revision, crypto.randomUUID())
    setBusyKey(undefined)
    if (result.ok) closeDialog()
    onAction(result, dialog.kind === 'publish' ? '版本已发布' : dialog.kind === 'withdraw' ? '版本已下线' : '已回滚到指定版本')
  }

  return (
    <section className="page-body">
      <div className="page-intro">
        <div>
          <span className="eyebrow">版本治理</span>
          <h2>发布管理</h2>
          <p>发布、下线和回滚均要求当前修订号，历史制品不可变。</p>
        </div>
      </div>
      <div className="release-list">
        {governed.map((item) => {
          const versions = item.publishedVersions ?? []
          const canRollback = item.status === 'published' && versions.some(version => version !== item.currentVersion)
          return (
            <article className="release-row" key={`${item.skillId}-${item.status}-${item.currentVersion ?? 'none'}-${item.revision}`}>
              <div className="release-name">
                <strong>{item.displayName}</strong>
                <small>
                  {item.runtimeName} · {item.authorName ?? '平台作者'}
                </small>
              </div>
              <span>{item.currentVersion ? `v${item.currentVersion}` : '无推荐版本'}</span>
              <Status status={item.status} />
              <span className="revision">r{item.revision}</span>
              <div className="release-actions">
                <button
                  type="button"
                  className="button secondary"
                  disabled={busyKey !== undefined || item.status !== 'approved'}
                  onClick={() => {
                    setDialog({ kind: 'publish', item })
                  }}
                >
                  <Rocket size={16} />
                  发布
                </button>
                <button
                  type="button"
                  className="button secondary"
                  disabled={busyKey !== undefined || item.status !== 'published'}
                  onClick={() => {
                    setDialog({ kind: 'withdraw', item })
                  }}
                >
                  下线
                </button>
                <button
                  type="button"
                  className="button secondary"
                  disabled={busyKey !== undefined || !canRollback}
                  onClick={() => {
                    setRollbackVersion(versions.find(version => version !== item.currentVersion) ?? '')
                    setDialog({ kind: 'rollback', item })
                  }}
                >
                  回滚
                </button>
              </div>
            </article>
          )
        })}
        {governed.length === 0 && <Empty text="没有可治理的已批准或已发布版本" />}
      </div>
      {dialog !== undefined && dialog.kind === 'withdraw' && <ReasonDialog title="下线版本" label="下线原因" value={reason} busy={busyKey !== undefined} confirmLabel="确认下线" onChange={setReason} onCancel={closeDialog} onConfirm={() => void confirm()} />}
      {dialog !== undefined && dialog.kind === 'publish' && <ConfirmDialog title="发布版本" message={`确认发布 ${dialog.item.displayName} v${dialog.item.currentVersion ?? ''}？`} busy={busyKey !== undefined} confirmLabel="确认发布" onCancel={closeDialog} onConfirm={() => void confirm()} />}
      {dialog !== undefined && dialog.kind === 'rollback' && <RollbackDialog versions={dialog.item.publishedVersions ?? []} current={dialog.item.currentVersion} value={rollbackVersion} busy={busyKey !== undefined} onChange={setRollbackVersion} onCancel={closeDialog} onConfirm={() => void confirm()} />}
    </section>
  )
}

function AuditPage({ items }: { items: readonly AuditLogEntry[] }) {
  return (
    <section className="page-body">
      <div className="page-intro">
        <div>
          <span className="eyebrow">管理员专属</span>
          <h2>审计日志</h2>
          <p>只展示服务端记录的治理和本地安装生命周期，不包含本地目录、Prompt 或代码正文。</p>
        </div>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>时间</th>
              <th>操作者</th>
              <th>动作</th>
              <th>Skill / 版本</th>
              <th>作用域</th>
              <th>结果</th>
              <th>请求编号</th>
            </tr>
          </thead>
          <tbody>
            {items.map(item => (
              <tr key={item.id}>
                <td>{formatDate(item.occurredAt)}</td>
                <td>{item.actor_name}</td>
                <td>{item.action}</td>
                <td>
                  {item.skillName} · v{item.version}
                </td>
                <td>{item.scope === undefined ? '治理操作' : item.scope === 'project' ? '项目' : '全局'}</td>
                <td>
                  <Status status={item.result === 'succeeded' ? 'published' : item.result === 'cancelled' ? 'withdrawn' : 'draft'} />
                </td>
                <td className="request-id">{item.requestId}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {items.length === 0 && <Empty text="暂无审计记录" />}
      </div>
    </section>
  )
}

function Status({ status }: { status: string }) {
  const labels: Record<string, string> = {
    draft: '草稿',
    pending_review: '待审核',
    approved: '已批准',
    published: '已发布',
    withdrawn: '已下线',
    succeeded: '成功',
  }
  return <span className={`status status-${status}`}>{labels[status] ?? status}</span>
}
function visibilityLabel(value: TeamSkill['visibility']): string {
  return value === 'organization' ? '所有人可见' : value === 'group' ? '本组内可见' : '特定人员可见'
}
function formatDate(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', {
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(new Date(value))
}

type TelemetryWindowState = { readonly state: 'loading' } | { readonly state: 'ready' } | { readonly state: 'empty' } | { readonly state: 'error'; readonly error: ApiError }

function errorCode(error: ApiError): string {
  return error.kind === 'not-ready' ? 'NOT_READY' : error.code
}

function telemetryWindowDefaults(): {
  readonly from: string
  readonly to: string
} {
  const to = new Date()
  const from = new Date(to.getTime() - 24 * 60 * 60 * 1000)
  return { from: from.toISOString(), to: to.toISOString() }
}

function formatTelemetryTime(value: string | null): string {
  return value === null ? '—' : new Date(value).toLocaleString()
}

function formatDuration(value: number | null): string {
  return value === null ? '—' : `${value} ms`
}

function formatTokens(value: number | null): string {
  return value === null ? '缺失' : String(value)
}

/** Shared time-window filter row; requests always carry explicit UTC ISO bounds. */
function TelemetryWindowBar({
  from,
  to,
  onFrom,
  onTo,
  onRefresh,
  busy,
  children,
}: {
  readonly from: string
  readonly to: string
  readonly onFrom: (value: string) => void
  readonly onTo: (value: string) => void
  readonly onRefresh: () => void
  readonly busy: boolean
  readonly children?: React.ReactNode
}) {
  const localValue = (iso: string): string => {
    const date = new Date(iso)
    const pad = (input: number): string => String(input).padStart(2, '0')
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
  }
  return (
    <div className="account-toolbar" role="search" aria-label="可观测筛选">
      <label>
        开始 (UTC)
        <input
          type="datetime-local"
          value={localValue(from)}
          onChange={(event) => {
            const next = event.target.value
            if (next.length > 0) onFrom(new Date(next).toISOString())
          }}
        />
      </label>
      <label>
        结束 (UTC)
        <input
          type="datetime-local"
          value={localValue(to)}
          onChange={(event) => {
            const next = event.target.value
            if (next.length > 0) onTo(new Date(next).toISOString())
          }}
        />
      </label>
      {children}
      <button className="button secondary" disabled={busy} onClick={onRefresh}>
        <RefreshCw size={16} />
        {busy ? '读取中…' : '刷新'}
      </button>
    </div>
  )
}

function TelemetrySummaryCards({ summary }: { readonly summary: TelemetrySummary }) {
  return (
    <div className="form-columns" aria-label="运行摘要">
      <section className="editor-section">
        <h3 className="section-title">Session</h3>
        <p>
          总数 {summary.sessions.total} · 完成 {summary.sessions.completed} · 错误 {summary.sessions.errors} · 中断 {summary.sessions.interrupted} ·{' '}
          取消 {summary.sessions.cancelled}
        </p>
      </section>
      <section className="editor-section">
        <h3 className="section-title">Turn</h3>
        <p>
          总数 {summary.turns.total} · 完成 {summary.turns.completed} · 错误 {summary.turns.errors} · 阻断 {summary.turns.blocked} · Token 上限 {summary.turns.max_tokens} · p50 {formatDuration(summary.turns.p50_duration_ms)} ·{' '}
          p95 {formatDuration(summary.turns.p95_duration_ms)}
        </p>
      </section>
      <section className="editor-section">
        <h3 className="section-title">Step</h3>
        <p>
          开始 {summary.steps.started} · 结束 {summary.steps.finished} · p50 {formatDuration(summary.steps.p50_duration_ms)} ·{' '}
          p95 {formatDuration(summary.steps.p95_duration_ms)}
        </p>
      </section>
      <section className="editor-section">
        <h3 className="section-title">模型与 Token</h3>
        <p>
          请求 {summary.llm.requests} · 重试 {summary.llm.retries} · 输入 {summary.llm.input_tokens} · 输出 {summary.llm.output_tokens} · 总 Token {formatTokens(summary.llm.total_tokens)} ·{' '}
          Token 样本 {summary.llm.token_sample_size}
        </p>
      </section>
      <section className="editor-section">
        <h3 className="section-title">工具</h3>
        <p>
          调用 {summary.tools.calls} · 错误 {summary.tools.errors} · p50 {formatDuration(summary.tools.p50_duration_ms)} ·{' '}
          p95 {formatDuration(summary.tools.p95_duration_ms)}
        </p>
      </section>
      <section className="editor-section">
        <h3 className="section-title">审批与压缩</h3>
        <p>
          审批 {summary.approvals.requested}（允许 {summary.approvals.allowed_once} · 拒绝 {summary.approvals.rejected} · 取消 {summary.approvals.cancelled} · 不可用{' '}
          {summary.approvals.unavailable}）· 压缩 {summary.compactions}
        </p>
      </section>
      <section className="editor-section">
        <h3 className="section-title">采集管道</h3>
        <p>
          accepted {summary.delivery.accepted} · duplicate {summary.delivery.duplicate} · retryable {summary.delivery.retryable} · rejected {summary.delivery.rejected} ·{' '}
          queued（fixture 恒为 0） {summary.delivery.queued} · 缺口 {summary.delivery.gaps}
          {summary.delivery.gaps > 0 || summary.delivery.rejected > 0 ? '（存在丢弃、拒收或未上报数据）' : ''}
        </p>
      </section>
      <section className="editor-section">
        <h3 className="section-title">Token 说明</h3>
        <p>仅统计服务端真实 Token 数量；缺失保持缺失，不计算成本或金额。</p>
      </section>
    </div>
  )
}

function TelemetryWindowFilterError({ message }: { readonly message: string | undefined }) {
  if (message === undefined) return null
  return (
    <div className="action-message" role="alert">
      {message}
    </div>
  )
}

/** Overview page: role-visible aggregation and pipeline health for one window. */
export function TelemetryOverviewPage({ api }: { readonly api: TeamSkillApi }) {
  const initial = telemetryWindowDefaults()
  const [from, setFrom] = useState(initial.from)
  const [to, setTo] = useState(initial.to)
  const [organizationId, setOrganizationId] = useState<string | undefined>()
  const [projectId, setProjectId] = useState<string | undefined>()
  const [projects, setProjects] = useState<readonly AdminProject[]>([])
  const [state, setState] = useState<TelemetryWindowState>({
    state: 'loading',
  })
  const [overview, setOverview] = useState<TelemetryOverview | undefined>()
  const [busy, setBusy] = useState(false)
  const [filterError, setFilterError] = useState<string | undefined>()
  const [lastLoadedAt, setLastLoadedAt] = useState<string | undefined>()
  const requestSequence = useRef(0)

  const load = async (): Promise<void> => {
    const sequence = ++requestSequence.current
    setBusy(true)
    setFilterError(undefined)
    const result = await api.getTelemetryOverview({
      from,
      to,
      ...(organizationId === undefined ? {} : { organizationId }),
      ...(projectId === undefined ? {} : { projectId }),
    })
    if (sequence !== requestSequence.current) return
    setBusy(false)
    if (!result.ok) {
      if (errorCode(result.error) === 'INVALID_TIME_RANGE' || errorCode(result.error) === 'PROJECT_CONTEXT_MISMATCH') {
        setFilterError(errorMessage(result.error))
        return
      }
      setState({ state: 'error', error: result.error })
      return
    }
    setLastLoadedAt(new Date().toLocaleString())
    setOverview(result.value)
    setState(result.value.has_data ? { state: 'ready' } : { state: 'empty' })
  }

  useEffect(() => {
    void api.listProjects().then((result) => {
      if (result.ok) setProjects(result.value)
    })
  }, [api])

  useEffect(() => {
    void load()
  }, [from, to, organizationId, projectId])

  return (
    <div className="page-body">
      <div className="page-intro">
        <div>
          <span className="eyebrow">AI CODING 可观测</span>
          <h2>总览</h2>
          <p>服务端按当前角色授权范围返回聚合；不合并未授权项目，不在浏览器计算 Token 或成本。</p>
        </div>
      </div>
      <TelemetryWindowBar from={from} to={to} onFrom={setFrom} onTo={setTo} onRefresh={() => void load()} busy={busy}>
        <label>
          组织
          <select
            value={organizationId ?? ''}
            onChange={(event) => {
              setOrganizationId(event.target.value === '' ? undefined : event.target.value)
              setProjectId(undefined)
            }}
          >
            <option value="">全部授权组织</option>
            {[...new Set(projects.map(project => `${project.organization_id}\u0000${project.organization_name}`))].map((pair) => {
              const parts = pair.split('\u0000')
              const id = parts[0] ?? ''
              const name = parts[1] ?? id
              return (
                <option key={id} value={id}>
                  {name}
                </option>
              )
            })}
          </select>
        </label>
        <label>
          项目
          <select
            value={projectId ?? ''}
            onChange={(event) => {
              setProjectId(event.target.value === '' ? undefined : event.target.value)
            }}
          >
            <option value="">全部授权项目</option>
            {projects
              .filter(project => organizationId === undefined || project.organization_id === organizationId)
              .map(project => (
                <option key={project.project_id} value={project.project_id}>
                  {project.name}
                </option>
              ))}
          </select>
        </label>
      </TelemetryWindowBar>
      <TelemetryWindowFilterError message={filterError} />
      {state.state === 'loading' && <Loading />}
      {state.state === 'error' && <ErrorState error={state.error} onRetry={() => void load()} />}
      {state.state === 'empty' && (
        <section className="state-panel" data-state="empty" role="status">
          <h2>当前窗口没有数据</h2>
          <p>
            服务端确认空结果（has_data=false）
            {lastLoadedAt === undefined ? '' : ` · 最近成功读取 ${lastLoadedAt}`}。
          </p>
        </section>
      )}
      {state.state === 'ready' && overview !== undefined && (
        <>
          <TelemetrySummaryCards summary={overview.summary} />
          <section className="editor-section">
            <h3 className="section-title">时间桶</h3>
            {overview.buckets.length === 0 ? (
              <p>当前窗口没有时间桶数据。</p>
            ) : (
              <div className="table-wrap">
                <table>
                  <caption>按天聚合（保留 {overview.retention_days} 天原始事件；Token 缺失保持缺失，不计算成本）</caption>
                  <thead>
                    <tr>
                      <th>桶起点 (UTC)</th>
                      <th>Session</th>
                      <th>Turn</th>
                      <th>LLM 请求</th>
                      <th>输入 Token</th>
                      <th>输出 Token</th>
                      <th>总 Token</th>
                      <th>工具调用</th>
                      <th>缺口</th>
                    </tr>
                  </thead>
                  <tbody>
                    {overview.buckets.map((bucket: TelemetryBucket) => (
                      <tr key={bucket.bucket_start}>
                        <td>{bucket.bucket_start}</td>
                        <td>{bucket.sessions.total}</td>
                        <td>{bucket.turns.total}</td>
                        <td>{bucket.llm.requests}</td>
                        <td>{bucket.llm.input_tokens}</td>
                        <td>{bucket.llm.output_tokens}</td>
                        <td>{formatTokens(bucket.llm.total_tokens)}</td>
                        <td>{bucket.tools.calls}</td>
                        <td>{bucket.delivery.gaps}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}
    </div>
  )
}

/** Project page: one authorized project's runtime, token, tool, approval and pipeline summary. */
export function TelemetryProjectPage({ api }: { readonly api: TeamSkillApi }) {
  const initial = telemetryWindowDefaults()
  const [from, setFrom] = useState(initial.from)
  const [to, setTo] = useState(initial.to)
  const [projects, setProjects] = useState<readonly AdminProject[]>([])
  const [projectId, setProjectId] = useState<string | undefined>()
  const [state, setState] = useState<TelemetryWindowState>({
    state: 'loading',
  })
  const [summary, setSummary] = useState<TelemetryProjectSummary | undefined>()
  const [busy, setBusy] = useState(false)
  const [filterError, setFilterError] = useState<string | undefined>()
  const [lastLoadedAt, setLastLoadedAt] = useState<string | undefined>()
  const requestSequence = useRef(0)

  useEffect(() => {
    void api.listProjects().then((result) => {
      if (result.ok) setProjects(result.value)
    })
  }, [api])

  const load = async (): Promise<void> => {
    if (projectId === undefined) {
      setState({ state: 'empty' })
      return
    }
    const sequence = ++requestSequence.current
    setBusy(true)
    setFilterError(undefined)
    const result = await api.getProjectTelemetrySummary(projectId, {
      from,
      to,
    })
    if (sequence !== requestSequence.current) return
    setBusy(false)
    if (!result.ok) {
      if (errorCode(result.error) === 'INVALID_TIME_RANGE' || errorCode(result.error) === 'PROJECT_CONTEXT_MISMATCH') {
        setFilterError(errorMessage(result.error))
        return
      }
      setState({ state: 'error', error: result.error })
      return
    }
    setLastLoadedAt(new Date().toLocaleString())
    setSummary(result.value)
    setState(result.value.has_data ? { state: 'ready' } : { state: 'empty' })
  }

  useEffect(() => {
    void load()
  }, [from, to, projectId])

  return (
    <div className="page-body">
      <div className="page-intro">
        <div>
          <span className="eyebrow">AI CODING 可观测</span>
          <h2>项目详情</h2>
          <p>必须选择服务端授权的项目；项目失权后服务端返回 403/404，页面不会用旧数据替代。</p>
        </div>
      </div>
      <TelemetryWindowBar from={from} to={to} onFrom={setFrom} onTo={setTo} onRefresh={() => void load()} busy={busy}>
        <label>
          项目
          <select
            value={projectId ?? ''}
            aria-label="可观测项目"
            onChange={(event) => {
              setProjectId(event.target.value === '' ? undefined : event.target.value)
            }}
          >
            <option value="">请选择授权项目</option>
            {projects.map(project => (
              <option key={project.project_id} value={project.project_id}>
                {project.name}
              </option>
            ))}
          </select>
        </label>
      </TelemetryWindowBar>
      <TelemetryWindowFilterError message={filterError} />
      {projectId === undefined && (
        <section className="state-panel" data-state="empty" role="status">
          <h2>请先选择项目</h2>
          <p>项目列表来自服务端授权；未授权项目不在候选中。</p>
        </section>
      )}
      {projectId !== undefined && state.state === 'loading' && <Loading />}
      {projectId !== undefined && state.state === 'error' && <ErrorState error={state.error} onRetry={() => void load()} />}
      {projectId !== undefined && state.state === 'empty' && (
        <section className="state-panel" data-state="empty" role="status">
          <h2>当前窗口没有数据</h2>
          <p>
            服务端确认空结果
            {lastLoadedAt === undefined ? '' : ` · 最近成功读取 ${lastLoadedAt}`}。
          </p>
        </section>
      )}
      {projectId !== undefined && state.state === 'ready' && summary !== undefined && (
        <>
          <TelemetrySummaryCards summary={summary.summary} />
          <section className="editor-section">
            <h3 className="section-title">模型与 Token 分布</h3>
            <div className="table-wrap">
              <table>
                <caption>未知 provider/model 显示为 unknown；缺失总 Token 保持缺失，不计算成本。</caption>
                <thead>
                  <tr>
                    <th>Provider</th>
                    <th>Model</th>
                    <th>请求数</th>
                    <th>输入 Token</th>
                    <th>输出 Token</th>
                    <th>总 Token</th>
                  </tr>
                </thead>
                <tbody>
                  {summary.models.map((model: TelemetryModelUsage) => (
                    <tr key={`${model.provider}:${model.model}`}>
                      <td>{model.provider}</td>
                      <td>{model.model}</td>
                      <td>{model.requests}</td>
                      <td>{model.input_tokens}</td>
                      <td>{model.output_tokens}</td>
                      <td>{formatTokens(model.total_tokens)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
          <section className="editor-section">
            <h3 className="section-title">工具分布</h3>
            <div className="table-wrap">
              <table>
                <caption>只展示工具名与聚合；不显示工具参数或结果正文。</caption>
                <thead>
                  <tr>
                    <th>工具</th>
                    <th>调用量</th>
                    <th>错误率</th>
                    <th>p50</th>
                    <th>p95</th>
                  </tr>
                </thead>
                <tbody>
                  {summary.tools.map((tool: TelemetryToolUsage) => (
                    <tr key={tool.tool_name}>
                      <td>{tool.tool_name}</td>
                      <td>{tool.calls}</td>
                      <td>{tool.calls === 0 ? '—' : `${Math.round((tool.errors / tool.calls) * 100)}%`}</td>
                      <td>{formatDuration(tool.p50_duration_ms)}</td>
                      <td>{formatDuration(tool.p95_duration_ms)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </div>
  )
}

const TELEMETRY_KINDS: readonly string[] = ['session.started', 'session.finished', 'turn.started', 'turn.finished', 'step.started', 'step.finished', 'llm.request', 'llm.response', 'tool.call', 'tool.result', 'approval.requested', 'approval.resolved', 'compaction.completed', 'agent.error', 'delivery.gap']

const TELEMETRY_OUTCOMES: readonly string[] = ['success', 'error', 'interrupted', 'cancelled', 'blocked', 'max_tokens']

/** Events page: structured event diagnostics with opaque-cursor pagination. */
export function TelemetryEventsPage({ api, workbenchFilter }: { readonly api: TeamSkillApi; readonly workbenchFilter?: WorkbenchFilter }) {
  const initial = telemetryWindowDefaults()
  const [from, setFrom] = useState(workbenchFilter?.from ?? initial.from)
  const [to, setTo] = useState(workbenchFilter?.to ?? initial.to)
  const [projects, setProjects] = useState<readonly AdminProject[]>([])
  const [projectId, setProjectId] = useState<string | undefined>()
  const [kind, setKind] = useState<string | undefined>()
  // 工作台「近期结果」的 status 落到遥测事件的 outcome 过滤（4-1）。
  const [outcome, setOutcome] = useState<string | undefined>(workbenchFilter?.status)
  const [page, setPage] = useState<TelemetryEventPage | undefined>()
  const [state, setState] = useState<TelemetryWindowState>({
    state: 'loading',
  })
  const [busy, setBusy] = useState(false)
  const [filterError, setFilterError] = useState<string | undefined>()
  const [lastLoadedAt, setLastLoadedAt] = useState<string | undefined>()
  const cursorStack = useRef<readonly string[]>([])
  const requestSequence = useRef(0)

  useEffect(() => {
    void api.listProjects().then((result) => {
      if (result.ok) setProjects(result.value)
    })
  }, [api])

  const load = async (cursor?: string): Promise<void> => {
    if (projectId === undefined) {
      setState({ state: 'empty' })
      return
    }
    const sequence = ++requestSequence.current
    setBusy(true)
    setFilterError(undefined)
    const result = await api.listProjectTelemetryEvents(projectId, {
      from,
      to,
      ...(kind === undefined ? {} : { kind }),
      ...(outcome === undefined ? {} : { outcome }),
      ...(cursor === undefined ? {} : { cursor }),
      limit: 50,
    })
    if (sequence !== requestSequence.current) return
    setBusy(false)
    if (!result.ok) {
      if (errorCode(result.error) === 'INVALID_CURSOR') {
        // A stale or mismatched cursor resets to the first page instead of surfacing an error.
        cursorStack.current = []
        await load()
        return
      }
      if (errorCode(result.error) === 'INVALID_TIME_RANGE' || errorCode(result.error) === 'PROJECT_CONTEXT_MISMATCH') {
        setFilterError(errorMessage(result.error))
        return
      }
      setState({ state: 'error', error: result.error })
      return
    }
    setLastLoadedAt(new Date().toLocaleString())
    setPage(result.value)
    setState(result.value.items.length === 0 ? { state: 'empty' } : { state: 'ready' })
  }

  useEffect(() => {
    cursorStack.current = []
    void load()
  }, [from, to, projectId, kind, outcome])

  return (
    <div className="page-body">
      <div className="page-intro">
        <div>
          <span className="eyebrow">AI CODING 可观测</span>
          <h2>事件诊断</h2>
          <p>结构化事件查看器，不是会话记录浏览器；只显示服务端白名单字段和清洗后的错误摘要。</p>
        </div>
      </div>
      <TelemetryWindowBar
        from={from}
        to={to}
        onFrom={setFrom}
        onTo={setTo}
        onRefresh={() => {
          cursorStack.current = []
          void load()
        }}
        busy={busy}
      >
        <label>
          项目
          <select
            value={projectId ?? ''}
            aria-label="诊断项目"
            onChange={(event) => {
              setProjectId(event.target.value === '' ? undefined : event.target.value)
            }}
          >
            <option value="">请选择授权项目</option>
            {projects.map(project => (
              <option key={project.project_id} value={project.project_id}>
                {project.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          kind
          <select
            value={kind ?? ''}
            onChange={(event) => {
              setKind(event.target.value === '' ? undefined : event.target.value)
            }}
          >
            <option value="">全部 kind</option>
            {TELEMETRY_KINDS.map(option => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </label>
        <label>
          outcome
          <select
            value={outcome ?? ''}
            onChange={(event) => {
              setOutcome(event.target.value === '' ? undefined : event.target.value)
            }}
          >
            <option value="">全部 outcome</option>
            {TELEMETRY_OUTCOMES.map(option => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </label>
      </TelemetryWindowBar>
      <TelemetryWindowFilterError message={filterError} />
      {projectId === undefined && (
        <section className="state-panel" data-state="empty" role="status">
          <h2>请先选择项目</h2>
          <p>项目列表来自服务端授权；筛选变化会清空游标并从第一页读取。</p>
        </section>
      )}
      {projectId !== undefined && state.state === 'loading' && <Loading />}
      {projectId !== undefined && state.state === 'error' && <ErrorState error={state.error} onRetry={() => void load()} />}
      {projectId !== undefined && state.state === 'empty' && (
        <section className="state-panel" data-state="empty" role="status">
          <h2>没有匹配的结构化事件</h2>
          <p>
            服务端确认空结果
            {lastLoadedAt === undefined ? '' : ` · 最近成功读取 ${lastLoadedAt}`}。
          </p>
        </section>
      )}
      {projectId !== undefined && page !== undefined && page.items.length > 0 && (
        <section className="editor-section">
          <h3 className="section-title">结构化事件（原始事件保留 {page.retention_days} 天；缺口事件用于解释不连续数据）</h3>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>发生时间</th>
                  <th>接收时间</th>
                  <th>kind</th>
                  <th>session</th>
                  <th>seq</th>
                  <th>turn/step</th>
                  <th>model</th>
                  <th>工具</th>
                  <th>耗时</th>
                  <th>outcome</th>
                  <th>Token (入/出/总)</th>
                  <th>错误</th>
                  <th>缺口</th>
                </tr>
              </thead>
              <tbody>
                {page.items.map((item: TelemetryEventItem) => (
                  <tr key={item.event_id}>
                    <td>{formatTelemetryTime(item.occurred_at)}</td>
                    <td>{formatTelemetryTime(item.received_at)}</td>
                    <td>{item.kind}</td>
                    <td>{item.session_id ?? '—'}</td>
                    <td>{item.source_seq ?? '—'}</td>
                    <td>
                      {item.turn ?? '—'}/{item.step ?? '—'}
                    </td>
                    <td>{item.model ?? '—'}</td>
                    <td>{item.tool_name ?? '—'}</td>
                    <td>{formatDuration(item.duration_ms)}</td>
                    <td>{item.outcome ?? '—'}</td>
                    <td>{item.token_usage === null ? '—' : `${formatTokens(item.token_usage.input_tokens)} / ${formatTokens(item.token_usage.output_tokens)} / ${formatTokens(item.token_usage.total_tokens)}`}</td>
                    <td>{item.error === null ? '—' : `${item.error.name}${item.error.code === null ? '' : `/${item.error.code}`}${item.error.summary === null ? '' : ` · ${item.error.summary}`}`}</td>
                    <td>{item.gap === null ? '—' : `${item.gap.reason} × ${item.gap.count}`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="dialog-actions">
            <button
              className="button secondary"
              disabled={busy || cursorStack.current.length === 0}
              onClick={() => {
                const stack = [...cursorStack.current]
                const previous = stack.pop()
                cursorStack.current = stack
                if (previous !== undefined) void load(previous)
              }}
            >
              上一页
            </button>
            <button
              className="button secondary"
              disabled={busy || !page.has_more || page.next_cursor === null}
              onClick={() => {
                if (page.next_cursor === null) return
                cursorStack.current = [...cursorStack.current, page.next_cursor]
                void load(page.next_cursor)
              }}
            >
              下一页
            </button>
            <span className="request-id">opaque cursor 分页：浏览器不解析、排序或拼接游标。</span>
          </div>
        </section>
      )}
    </div>
  )
}


/** 五组指标区：分组顺序即产品语义；每个数字带四要素溯源与跳转。 */
/** 指标卡的呈现形状：模型输出的字段 + 跳转目标。 */
interface WorkbenchMetricCard {
  readonly id: string
  readonly group: WorkbenchGroup
  readonly label: string
  readonly value: number | null
  readonly hint?: string
  readonly provenance: {
    readonly timeRange: string
    readonly filters: string
    readonly source: string
    readonly updatedAt: string
  }
  readonly targetPage: PageId
  readonly targetFilter: WorkbenchFilter
}

function WorkbenchMetricGroups({ metrics, onOpenMetric }: {
  readonly metrics: readonly WorkbenchMetricCard[]
  readonly onOpenMetric: (page: PageId, filter: WorkbenchFilter) => void
}) {
  const groups = groupWorkbenchMetrics(metrics)
  return (
    <div className="workbench-groups" aria-label="工作台指标分组">
      {groups.map(({ group, metrics: groupMetrics }) => (
        <section key={group} className="workbench-card" aria-label={`工作台分组：${group}`}>
          <div className="workbench-card-head">
            <strong>{group}</strong>
            <span className="count-badge">{groupMetrics.length} 项</span>
          </div>
          {groupMetrics.length === 0 ? (
            <Empty text="本组没有事项" />
          ) : (
            <ul className="workbench-list">
              {groupMetrics.map(metric => (
                <li key={metric.id} className="workbench-metric" data-unavailable={metric.value === null ? 'true' : undefined}>
                  <div className="workbench-metric-head">
                    <strong>{metric.label}</strong>
                    <strong className="metric-value">{metric.value === null ? '—' : metric.value}</strong>
                  </div>
                  <small className="workbench-metric-provenance">
                    {`${metric.provenance.timeRange} · 过滤 ${metric.provenance.filters} · 来源 ${metric.provenance.source} · 更新于 ${metric.provenance.updatedAt}`}
                  </small>
                  {metric.hint !== undefined && <small>{metric.hint}</small>}
                  <button
                    type="button"
                    className="button secondary"
                    aria-label={`打开 ${metric.label}`}
                    onClick={() => { onOpenMetric(metric.targetPage, metric.targetFilter) }}
                  >
                    查看列表
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      ))}
    </div>
  )
}

/** 工作台聚合页（蓝图 §6.1 + spec §5.2）：固定五组指标（四要素溯源 + 保留
 *  过滤跳转）+ 可观测摘要。单一数据源读取失败降级为该指标「读取不可用」，
 *  不让整个页面失败，也不用 0 冒充零个。 */
function WorkbenchPage({ api, role, onOpenMetric, onNavigate }: {
  readonly api: TeamSkillApi
  readonly role: AccountRole
  readonly onOpenMetric: (page: PageId, filter: WorkbenchFilter) => void
  readonly onNavigate: (page: PageId) => void
}) {
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading')
  const [failure, setFailure] = useState<ApiError | undefined>()
  const [data, setData] = useState<{
    readonly overview: TelemetryOverview
    readonly reviews: readonly ReviewItem[]
    readonly skills: readonly TeamSkill[]
    readonly projects: readonly AdminProject[]
    readonly workspaces: readonly { readonly status: string }[] | undefined
    readonly runs: readonly { readonly status: string }[] | undefined
    readonly profiles: readonly { readonly readiness: string }[] | undefined
    readonly authorizationAudits: readonly { readonly result: string }[] | undefined
    readonly updatedAt: string
  } | undefined>()
  const load = useCallback(async () => {
    setState('loading')
    const to = new Date()
    const from = new Date(to.getTime() - 7 * 24 * 3600 * 1000)
    const range = { from: from.toISOString(), to: to.toISOString() }
    // 单源降级：读取失败记为 undefined（模型呈现「读取不可用」），不拖垮整页。
    const degraded = async <T,>(promise: Promise<ApiResult<readonly T[]>>): Promise<readonly T[] | undefined> => {
      const result = await promise
      return result.ok ? result.value : undefined
    }
    const [overview, reviews, skills, projects, workspaces, runs, profiles, authorizationAudits] = await Promise.all([
      api.getTelemetryOverview(range),
      api.listReviews(),
      api.listSkills(),
      api.listProjects(),
      degraded(api.cloudWorkspaces()),
      degraded(api.cloudRuns()),
      degraded(api.cloudAgentProfiles()),
      degraded(api.listAuthorizationAudits()),
    ])
    if (!overview.ok) {
      setFailure(overview.error)
      setState('failed')
      return
    }
    if (!reviews.ok) {
      setFailure(reviews.error)
      setState('failed')
      return
    }
    if (!skills.ok) {
      setFailure(skills.error)
      setState('failed')
      return
    }
    if (!projects.ok) {
      setFailure(projects.error)
      setState('failed')
      return
    }
    setData({
      overview: overview.value,
      reviews: reviews.value,
      skills: skills.value,
      projects: projects.value,
      workspaces,
      runs,
      profiles,
      authorizationAudits,
      updatedAt: new Date().toISOString(),
    })
    setState('ready')
  }, [api])
  useEffect(() => {
    void load()
  }, [load])
  if (state === 'loading') {
    return (
      <section className="page-body workbench" aria-label="工作台" aria-busy="true" data-density-probe="">
        <div className="metric-grid">
          {[0, 1, 2, 3].map(index => (
            <div key={index} className="metric-card metric-skeleton" />
          ))}
        </div>
      </section>
    )
  }
  if (state === 'failed' || data === undefined) {
    return (
      <section className="page-body workbench" aria-label="工作台">
        <ErrorState error={failure ?? { kind: 'service', code: 'WORKBENCH_UNAVAILABLE', message: '工作台聚合读取失败' }} onRetry={() => void load()} />
      </section>
    )
  }
  const pendingReviews = data.reviews.filter(item => item.skill.status === 'pending_review')
  const empty = !data.overview.has_data && data.reviews.length === 0 && data.skills.length === 0
  if (empty && role === 'member') {
    return (
      <section className="page-body workbench" aria-label="工作台" data-density-probe="">
        <Empty text="当前账号范围内没有运行与治理数据" />
      </section>
    )
  }
  return (
    <section className="page-body workbench" aria-label="工作台" data-density-probe="">
      <div className="page-intro">
        <div>
          <span className="eyebrow">工作台</span>
          <h2>近 7 天运行与治理摘要</h2>
          <p>聚合自治理服务的只读数据；数据来自本地联调服务（fixture-only），不代表生产环境。</p>
        </div>
      </div>
      <WorkbenchMetricGroups
        metrics={buildWorkbenchMetrics({
          window: { from: data.overview.from, to: data.overview.to },
          updatedAt: data.updatedAt,
          views: {
            reviews: data.reviews.map(item => ({ status: item.skill.status })),
            skills: data.skills,
            workspaces: data.workspaces,
            runs: data.runs,
            profiles: data.profiles,
            authorizationAudits: data.authorizationAudits,
          },
        })}
        onOpenMetric={onOpenMetric}
      />
      <div className="metric-grid">
        <div className="metric-card">
          <span className="metric-label">会话（近 7 天）</span>
          <strong className="metric-value">{data.overview.summary.sessions.total}</strong>
          <span className="metric-hint">错误 {data.overview.summary.sessions.errors} · 已取消 {data.overview.summary.sessions.cancelled}</span>
        </div>
        <div className="metric-card">
          <span className="metric-label">回合</span>
          <strong className="metric-value">{data.overview.summary.turns.total}</strong>
          <span className="metric-hint">错误 {data.overview.summary.turns.errors} · 被拦截 {data.overview.summary.turns.blocked}</span>
        </div>
        <div className="metric-card">
          <span className="metric-label">团队 Skill</span>
          <strong className="metric-value">{data.skills.length}</strong>
          <span className="metric-hint">已发布 {data.skills.filter(item => item.status === 'published').length}</span>
        </div>
        <div className="metric-card">
          <span className="metric-label">项目</span>
          <strong className="metric-value">{data.projects.length}</strong>
          <span className="metric-hint">正常 {data.projects.filter(item => item.status === 'active').length}</span>
        </div>
      </div>
      <div className="workbench-columns">
        <div className="workbench-card">
          <div className="workbench-card-head">
            <strong>待处理事项</strong>
            <span className="count-badge">{pendingReviews.length} 项待审核</span>
          </div>
          {pendingReviews.length === 0 ? (
            <Empty text="没有等待审核的 Skill 版本" />
          ) : (
            <ul className="workbench-list">
              {pendingReviews.slice(0, 5).map(item => (
                <li key={item.skill.skillId}>
                  <strong>{item.skill.displayName}</strong>
                  <small>v{item.version.version} · 等待审核</small>
                </li>
              ))}
            </ul>
          )}
          <button type="button" className="button secondary" onClick={() =>{  onNavigate('reviews') }}>前往审核队列</button>
        </div>
        <div className="workbench-card">
          <div className="workbench-card-head">
            <strong>运行概览</strong>
            <span className="count-badge">{data.overview.retention_days} 天保留</span>
          </div>
          {data.overview.has_data ? (
            <dl className="workbench-facts">
              <div><dt>回合完成</dt><dd>{data.overview.summary.turns.completed}</dd></div>
              <div><dt>回合中断</dt><dd>{data.overview.summary.turns.interrupted}</dd></div>
              <div><dt>步骤开始</dt><dd>{data.overview.summary.steps.started}</dd></div>
              <div><dt>P95 回合耗时</dt><dd>{data.overview.summary.turns.p95_duration_ms === null ? '无样本' : `${Math.round(data.overview.summary.turns.p95_duration_ms / 100) / 10}s`}</dd></div>
            </dl>
          ) : (
            <Empty text="所选时间窗内没有可观测数据" />
          )}
          <button type="button" className="button secondary" onClick={() =>{  onNavigate('telemetry-overview') }}>查看可观测总览</button>
        </div>
      </div>
    </section>
  )
}

/** 面板结果行：类别 + 标签 + 执行前披露。 */
function PaletteRow({ id, category, label, onSelect }: {
  readonly id: string
  readonly category: '组织' | '项目' | 'Agent' | '运行' | '资产' | '操作者' | 'request ID'
  readonly label: string
  readonly onSelect: (id: string) => void
}): ReactElement {
  const disclosure = paletteActionDisclosure({ id, category, label })
  return (
    <li>
      <button type="button" className="button secondary" aria-label={`${category} ${label}`} onClick={() => { onSelect(id) }}>
        <strong>{`[${category}] ${label}`}</strong>
        <small>{`${disclosure.permission} · ${disclosure.impact}`}</small>
      </button>
    </li>
  )
}

/** 命令面板（蓝图 §6.2）：跨七类来源搜索；执行前披露权限与只读影响。 */
function CommandPalette({ api, onClose, onSelectPage }: {
  readonly api: TeamSkillApi
  readonly onClose: () => void
  readonly onSelectPage: (page: PageId) => void
}): ReactElement {
  const [query, setQuery] = useState('')
  const [sources, setSources] = useState<PaletteSources>({
    organizations: [], projects: [], agents: [], runs: [], assets: [], operators: [], requestIds: [],
  })
  useEffect(() => {
    let disposed = false
    const degraded = async <T,>(promise: Promise<ApiResult<readonly T[]>>): Promise<readonly T[]> => {
      const result = await promise
      return result.ok ? result.value : []
    }
    void Promise.all([
      degraded<AdminOrganization>(api.listOrganizations()),
      degraded<AdminProject>(api.listProjects()),
      degraded<CloudAgentProfile>(api.cloudAgentProfiles()),
      degraded<CloudRun>(api.cloudRuns()),
      degraded<TeamSkill>(api.listSkills()),
      degraded<AuthorizationAudit>(api.listAuthorizationAudits()),
    ]).then(([organizations, projects, agents, runs, assets, audits]) => {
      if (disposed) return
      setSources({
        organizations: organizations.map(row => ({ id: row.organization_id, label: row.name })),
        projects: projects.map(row => ({ id: row.project_id, label: row.name })),
        agents: agents.map(row => ({ id: row.agent_profile_id, label: row.name })),
        runs: runs.map(row => ({ id: row.run_id, label: row.run_id })),
        assets: assets.map(row => ({ id: row.skillId, label: row.displayName })),
        operators: audits.map(row => ({ id: row.actor_name, label: row.actor_name })),
        requestIds: audits.map(row => ({ id: row.request_id, label: row.request_id })),
      })
    })
    return () => { disposed = true }
  }, [api])
  const results = buildPaletteResults({
    query,
    sources,
  })
  const categoryPage: Record<string, PageId> = {
    '组织': 'account-organizations',
    '项目': 'projects',
    'Agent': 'cloud-profiles',
    '运行': 'cloud-runs',
    '资产': 'directory',
    '操作者': 'account-audit',
    'request ID': 'account-audit',
  }
  return (
    <div className="detail-overlay" role="dialog" aria-label="命令面板" onClick={onClose}>
      <div className="detail-panel" onClick={(event) => { event.stopPropagation() }}>
        <div className="detail-head">
          <h3 className="detail-title">命令面板</h3>
          <button type="button" className="detail-close" onClick={onClose} aria-label="关闭命令面板">关闭</button>
        </div>
        <input
          aria-label="命令面板搜索"
          value={query}
          placeholder="搜索组织、项目、Agent、运行、资产、操作者、request ID"
          onChange={(event) => { setQuery(event.target.value) }}
          autoFocus
        />
        {results.length === 0 && <p className="state-line">{query.trim().length === 0 ? '输入关键词开始搜索。' : '没有匹配的结果。'}</p>}
        <ul className="workbench-list">
          {results.map(row => (
            <PaletteRow
              key={`${row.category}-${row.id}`}
              id={row.id}
              category={row.category}
              label={row.label}
              onSelect={() => {
                onClose()
                const page = Object.hasOwn(categoryPage, row.category) ? categoryPage[row.category] : undefined
                if (page !== undefined) onSelectPage(page)
              }}
            />
          ))}
        </ul>
      </div>
    </div>
  )
}

/** 系统设置（spec §5.2）：外观偏好真实保存到本地存储；会话信息来自
 *  Auth.js session 只读展示；治理配置未接入生产服务，如实标注 BLOCKED。 */
function SettingsPage({ role, session, appearance, onAppearance }: {
  readonly role: AccountRole
  readonly session: DashboardSession
  readonly appearance: AdminAppearance
  readonly onAppearance: (next: AdminAppearance) => void
}) {
  const [draft, setDraft] = useState<AdminAppearance>(appearance)
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'failed'>('idle')
  if (role === 'member') {
    return (
      <section className="page-body" aria-label="系统设置">
        <div className="permission-denied" role="alert">
          <strong>无权访问系统设置</strong>
          <p>系统设置仅对平台管理员和组织经理开放；当前账号角色为成员。请联系管理员调整角色。</p>
        </div>
      </section>
    )
  }
  const dirty = draft.theme !== appearance.theme || draft.density !== appearance.density
  const save = (): void => {
    setSaveState('saving')
    // 写入后立即读回校验：校验失败（如浏览器拒绝存储）如实报告，不伪造成功。
    const failure = saveAdminAppearance(draft)
    if (failure) {
      setSaveState('failed')
      return
    }
    const readBack = loadAdminAppearance()
    if (readBack.theme !== draft.theme || readBack.density !== draft.density) {
      setSaveState('failed')
      return
    }
    onAppearance(draft)
    setSaveState('saved')
  }
  return (
    <section className="page-body" aria-label="系统设置">
      <div className="page-intro">
        <div>
          <span className="eyebrow">系统设置</span>
          <h2>外观与会话</h2>
          <p>外观偏好保存在本浏览器；治理配置由生产服务管理，本地环境未接入。</p>
        </div>
      </div>
      <div className="settings-layout">
        <form
          className="settings-group"
          onSubmit={(event) => {
            event.preventDefault()
            save()
          }}
        >
          <h3>外观偏好</h3>
          <fieldset>
            <legend>主题</legend>
            <label>
              <input type="radio" name="settings-theme" checked={draft.theme === 'light'} onChange={() => { setDraft({ ...draft, theme: 'light' }); setSaveState('idle') }} />
              浅色
            </label>
            <label>
              <input type="radio" name="settings-theme" checked={draft.theme === 'dark'} onChange={() => { setDraft({ ...draft, theme: 'dark' }); setSaveState('idle') }} />
              深色
            </label>
            <label>
              <input type="radio" name="settings-theme" checked={draft.theme === 'system'} onChange={() => { setDraft({ ...draft, theme: 'system' }); setSaveState('idle') }} />
              跟随系统
            </label>
          </fieldset>
          <fieldset>
            <legend>密度</legend>
            <label>
              <input type="radio" name="settings-density" checked={draft.density === 'comfortable'} onChange={() => { setDraft({ ...draft, density: 'comfortable' }); setSaveState('idle') }} />
              舒适
            </label>
            <label>
              <input type="radio" name="settings-density" checked={draft.density === 'compact'} onChange={() => { setDraft({ ...draft, density: 'compact' }); setSaveState('idle') }} />
              紧凑
            </label>
          </fieldset>
          <div className="save-bar" role="status" data-save-state={saveState !== 'idle' ? saveState : dirty ? 'dirty' : 'idle'}>
            <span className="save-state-text">
              {saveState === 'failed'
                ? '保存失败：浏览器存储写入校验未通过，请重试'
                : saveState === 'saved'
                  ? '外观偏好已保存'
                  : dirty
                    ? '有未保存的外观偏好'
                    : saveState === 'saving'
                      ? '正在保存…'
                      : '外观偏好已是最新'}
            </span>
            <button type="submit" className="button primary" disabled={!dirty || saveState === 'saving'}>保存外观偏好</button>
          </div>
        </form>
        <div className="settings-group">
          <h3>会话与安全</h3>
          <dl className="settings-facts">
            <div><dt>账号</dt><dd>{session.user.name ?? session.user.email}</dd></div>
            <div><dt>邮箱</dt><dd>{session.user.email ?? '未绑定'}</dd></div>
            <div><dt>角色</dt><dd>{roleLabel(role)}</dd></div>
            <div><dt>需要修改密码</dt><dd>{session.mustChangePassword ? '是' : '否'}</dd></div>
          </dl>
        </div>
        <div className="settings-group">
          <h3>治理配置</h3>
          <p className="settings-note">以下配置由生产治理服务管理；当前环境为本地联调（BLOCKED），不提供写入。</p>
          <dl className="settings-facts">
            <div><dt>Skill 审核策略</dt><dd>生产治理服务管理（BLOCKED）</dd></div>
            <div><dt>角色权限矩阵</dt><dd>服务端固定矩阵，仅可在「账号与权限」查看</dd></div>
            <div><dt>遥测保留天数</dt><dd>由可观测服务返回，详见「运行与审计」</dd></div>
          </dl>
        </div>
      </div>
    </section>
  )
}
