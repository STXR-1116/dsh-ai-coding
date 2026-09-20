import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import type { ClientRemote } from '@deepseek-ai/dsh-api-remotes/client'
import type {
  AgentAssetBinding,
  AgentExecutionPolicy,
  AgentProfileSummary,
  AgentTypeSchema,
  TeamSkillProject,
  WorkspaceQueryResult,
} from '../../types.ts'
import { IconRefreshOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import { AgentConfigEditor } from './AgentConfigEditor.tsx'
import css from './AgentConfigView.module.css'

/** Failure codes that mean the Host account session must be refreshed upstream. */
const AUTHORIZATION_FAILURE_CODES = new Set(['AUTH_REQUIRED', 'TOKEN_EXPIRED', 'UNAUTHORIZED', 'FORBIDDEN'])

const READINESS_LABEL: Record<string, string> = {
  ready: '可用',
  degraded: '降级',
  unavailable: '不可用',
}

export interface AgentConfigViewProps {
  /** Typed DSH Remote assembly carrying the Host-owned cloud workspace namespace. */
  readonly remote: ClientRemote
  /** Opaque selected project identity; the page reads only this project's published versions. */
  readonly projectId?: string
  /** Projects the account may explicitly choose. */
  readonly projects: readonly TeamSkillProject[]
  /** Set the explicit project context. */
  readonly onProjectSelect?: (projectId: string) => void
  /**
   * Account the page is signed in as.
   *
   * Every retained selection is scoped by it: signing out (or back in as someone
   * else) must not leave a previous account's card or detail on screen.
   */
  readonly accountId?: string
  /** Refresh the Host account when the service reports an authorization failure. */
  readonly onAuthorizationFailure?: () => void
}

/** One list state; failures never render as an empty list. */
type LoadState =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly profiles: readonly AgentProfileSummary[]; readonly fixtureOnly: boolean }
  | { readonly status: 'empty'; readonly fixtureOnly: boolean }
  | { readonly status: 'signed-out' }
  | { readonly status: 'not-ready'; readonly missing: readonly string[] }
  | { readonly status: 'failed'; readonly code: string; readonly message: string }

/** One detail state; the detail re-reads the version through its own Remote call. */
type DetailState =
  | { readonly status: 'idle' }
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly profile: AgentProfileSummary }
  | { readonly status: 'signed-out' }
  | { readonly status: 'failed'; readonly code: string; readonly message: string }

/**
 * One agent-type schema state.
 *
 * 类型扩展字段的标签只能来自服务端 schema：schema 没到位时既不能编造标签，也不能把
 * 扩展字段当成完整的展示。因此每一种非 ready 结局都要留下来并显式呈现，不得静默降级。
 */
type SchemaState =
  | { readonly status: 'ready'; readonly schema: AgentTypeSchema }
  | { readonly status: 'signed-out' }
  | { readonly status: 'failed'; readonly code: string; readonly message: string }

type RemoteEnvelope<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } }

function unwrap<T>(envelope: RemoteEnvelope<T>): T {
  if (!envelope.ok) throw new Error(`${envelope.error.code}: ${envelope.error.message}`)
  return envelope.value
}

function executionPolicyEntries(policy: AgentExecutionPolicy): readonly (readonly [string, string])[] {
  const entries: (readonly [string, string])[] = []
  if (policy.permission_mode !== undefined) entries.push(['权限模式', policy.permission_mode])
  if (policy.write_mode !== undefined) entries.push(['是否允许写入', policy.write_mode === 'write' ? '允许写入' : '只读'])
  if (policy.tool_allowlist !== undefined) entries.push(['工具白名单', policy.tool_allowlist.join('、')])
  if (policy.max_concurrency !== undefined) entries.push(['最大并发数', String(policy.max_concurrency)])
  if (policy.budget !== undefined) entries.push(['Token 预算', String(policy.budget)])
  if (policy.timeout_ms !== undefined) entries.push(['超时', `${policy.timeout_ms} ms`])
  return entries
}

function bindingRow(binding: AgentAssetBinding): ReactElement {
  return (
    <li key={binding.assetVersionId} className={css.assetRow} data-required={binding.required ? 'true' : 'false'}>
      <span className={css.assetName}>{binding.name}</span>
      <span className={css.assetVersion}>{binding.assetVersionId}</span>
      {binding.required ? <span className={css.assetFlag}>必需</span> : <span className={css.assetFlagOptional}>可选</span>}
      <span className={css[`readiness_${binding.readiness}`]} data-readiness={binding.readiness}>
        {READINESS_LABEL[binding.readiness] ?? binding.readiness}
        {binding.unavailableReason === null ? '' : `：${binding.unavailableReason}`}
      </span>
    </li>
  )
}

/** Any non-ready query outcome; each maps to a distinct detail state. */
type QueryFailure = Exclude<WorkspaceQueryResult<unknown>, { readonly status: 'ready' }>

function failureDetail(result: QueryFailure, notifyAuthorizationFailure: () => void): DetailState {
  if (result.status === 'signed-out') {
    notifyAuthorizationFailure()
    return { status: 'signed-out' }
  }
  if (result.status === 'not-ready') {
    return { status: 'failed', code: 'NOT_READY', message: `服务未就绪：缺少 ${result.missing.join('、')}` }
  }
  if (AUTHORIZATION_FAILURE_CODES.has(result.code)) {
    notifyAuthorizationFailure()
    return { status: 'signed-out' }
  }
  return { status: 'failed', code: result.code, message: result.message }
}

/**
 * 非 ready 的 schema 读结果 → 显式失败码与消息。
 *
 * `signed-out` 不走这里（它要走统一的会话失效处理并停止详情展示），
 * 其余每一种结局都必须带着自己的码与消息到达界面。
 */
function schemaFailure(
  result: Exclude<QueryFailure, { readonly status: 'signed-out' }>,
): { readonly code: string; readonly message: string } {
  if (result.status === 'not-ready') {
    return { code: 'NOT_READY', message: `服务未就绪：缺少 ${result.missing.join('、')}` }
  }
  return { code: result.code, message: result.message }
}

function listFromResult(  result: WorkspaceQueryResult<readonly AgentProfileSummary[]>,
  notifyAuthorizationFailure: () => void,
): LoadState {
  if (result.status === 'ready') {
    return result.value.length === 0
      ? { status: 'empty', fixtureOnly: result.fixtureOnly }
      : { status: 'ready', profiles: result.value, fixtureOnly: result.fixtureOnly }
  }
  if (result.status === 'signed-out') {
    notifyAuthorizationFailure()
    return { status: 'signed-out' }
  }
  if (result.status === 'not-ready') {
    return { status: 'not-ready', missing: result.missing }
  }
  return AUTHORIZATION_FAILURE_CODES.has(result.code)
    ? { status: 'signed-out' }
    : { status: 'failed', code: result.code, message: result.message }
}

/**
 * Plugin-side read-only view of the current project's published Agent Profile
 * Versions. The page owns no governance action: creation, editing, publishing,
 * binding and defaults live in the web admin, and every field comes from the
 * Host's strictly parsed service response.
 */
export function AgentConfigView({
  remote,
  projectId,
  projects,
  onProjectSelect,
  accountId,
  onAuthorizationFailure,
}: AgentConfigViewProps) {
  const [load, setLoad] = useState<LoadState>({ status: 'loading' })
  const [detail, setDetail] = useState<DetailState>({ status: 'idle' })
  const [selectedProfile, setSelectedProfile] = useState<AgentProfileSummary | undefined>()
  const [selectedProjectId, setSelectedProjectId] = useState<string | undefined>()
  const loadGeneration = useRef(0)
  const detailGeneration = useRef(0)
  const authorizationFailureRef = useRef(onAuthorizationFailure)
  authorizationFailureRef.current = onAuthorizationFailure
  const [schemas, setSchemas] = useState<Record<string, SchemaState>>({})

  // The single loader shared by the mount/switch effect and the refresh button.
  const loadProfiles = useCallback(async (): Promise<void> => {
    const generation = loadGeneration.current + 1
    loadGeneration.current = generation
    setLoad({ status: 'loading' })
    if (projectId === undefined) return
    try {
      const result = unwrap(await remote.cloudWorkspaces.agentProfiles(projectId))
      if (loadGeneration.current !== generation) return
      setLoad(listFromResult(result, () => authorizationFailureRef.current?.()))
    } catch (error) {
      if (loadGeneration.current !== generation) return
      const message = error instanceof Error ? error.message : String(error)
      const code = message.split(':')[0] ?? 'HOST_UNREACHABLE'
      setLoad({ status: 'failed', code, message })
    }
  }, [remote, projectId, accountId])

  useEffect(() => {
    // A project or account boundary invalidates the previous view's data: the
    // card list, the detail and the selection all reset before the next read.
    detailGeneration.current += 1
    setDetail({ status: 'idle' })
    setSelectedProfile(undefined)
    setSelectedProjectId(projectId)
    void loadProfiles()
  }, [loadProfiles, projectId])

  const openDetail = useCallback(
    (versionId: string) => {
      const generation = detailGeneration.current + 1
      detailGeneration.current = generation
      setDetail({ status: 'loading' })
      const run = async (): Promise<void> => {
        try {
          const result = unwrap(await remote.cloudWorkspaces.agentProfileVersion(versionId))
          if (detailGeneration.current !== generation) return
          if (result.status === 'ready') {
            setDetail({ status: 'ready', profile: result.value })
            const typeId = result.value.agentTypeId
            if (schemas[typeId] !== undefined) return
            let schemaState: SchemaState
            try {
              const schemaResult = unwrap(await remote.cloudWorkspaces.agentTypeSchema(typeId))
              if (detailGeneration.current !== generation) return
              if (schemaResult.status === 'ready') {
                schemaState = { status: 'ready', schema: schemaResult.value }
              } else if (schemaResult.status === 'signed-out') {
                // schema 读不到身份：走与列表/详情同一条会话失效路径，并停止详情展示。
                setSchemas(previous => ({ ...previous, [typeId]: { status: 'signed-out' } }))
                authorizationFailureRef.current?.()
                setDetail({ status: 'signed-out' })
                return
              } else {
                schemaState = { status: 'failed', ...schemaFailure(schemaResult) }
              }
            } catch (error) {
              if (detailGeneration.current !== generation) return
              const message = error instanceof Error ? error.message : String(error)
              schemaState = { status: 'failed', code: message.split(':')[0] ?? 'HOST_UNREACHABLE', message }
            }
            if (detailGeneration.current !== generation) return
            setSchemas(previous => ({ ...previous, [typeId]: schemaState }))
          } else {
            setDetail(failureDetail(result, () => authorizationFailureRef.current?.()))
          }
        } catch (error) {
          if (detailGeneration.current !== generation) return
          const message = error instanceof Error ? error.message : String(error)
          setDetail({ status: 'failed', code: message.split(':')[0] ?? 'HOST_UNREACHABLE', message })
        }
      }
      void run()
    },
    [remote, schemas],
  )

  const refresh = useCallback(() => {
    void loadProfiles()
  }, [loadProfiles])

  // Default first, then by readiness (ready → degraded → unavailable); the
  // server order is preserved inside each band.
  const orderedProfiles = load.status === 'ready'
    ? [...load.profiles].sort((left, right) => {
      if (left.default !== right.default) return left.default ? -1 : 1
      const band: Record<string, number> = { ready: 0, degraded: 1, unavailable: 2 }
      return (band[left.readiness] ?? 3) - (band[right.readiness] ?? 3)
    })
    : []

  return (
    <section className={css.view} data-state={load.status} aria-label="Agent 配置">
      {selectedProfile !== undefined && (
        <p className={css.selectionConfirmation} role="status" aria-label="已选择 Agent 配置">
          已选择 {selectedProfile.name}：Profile Version {selectedProfile.agentProfileVersionId} · 项目{' '}
          {selectedProjectId ?? '未选择'} · 写入模式 {selectedProfile.executionPolicy.write_mode}。回到当前工作流即可按该配置执行。
        </p>
      )}
      <header className={css.header}>
        <div>
          <h2 className={css.title}>Agent 配置</h2>
          <p className={css.subtitle}>当前项目可用的已发布配置版本（只读；治理操作在 Web 管理后台）</p>
        </div>
        <div className={css.headerControls}>
          <label className={css.projectLabel}>
            项目
            <select
              className={css.projectSelect}
              value={projectId ?? ''}
              onChange={(event) => {
                onProjectSelect?.(event.target.value)
              }}
              aria-label="选择项目"
            >
              <option value="" disabled>
                请选择项目
              </option>
              {projects.map(project => (
                <option key={project.projectId} value={project.projectId}>
                  {project.name}
                </option>
              ))}
            </select>
          </label>
          <button type="button" className={css.refresh} onClick={refresh} disabled={projectId === undefined} aria-label="刷新配置列表">
            <IconRefreshOutline16 />
            刷新
          </button>
        </div>
      </header>

      {projectId === undefined && load.status === 'loading' && (
        <p className={css.stateLine}>请选择项目后读取该项目的 Agent 配置。</p>
      )}
      {projectId !== undefined && load.status === 'loading' && <p className={css.stateLine}>正在读取项目配置…</p>}
      {load.status === 'signed-out' && <p className={css.stateLine} role="alert">账号已登出，配置列表已清空。</p>}
      {load.status === 'not-ready' && (
        <p className={css.stateLine} role="alert">服务未就绪：缺少 {load.missing.join('、')}</p>
      )}
      {load.status === 'failed' && (
        <div className={css.errorBox} role="alert" data-error-code={load.code}>
          <p>读取配置失败：{load.message}</p>
          <p className={css.errorCode}>错误码 {load.code}</p>
        </div>
      )}
      {load.status === 'empty' && (
        <div className={css.emptyBox}>
          <p>当前项目没有可用的 Agent 配置。</p>
          <p className={css.stateHint}>项目管理员可在 Web 管理后台发布并绑定配置。</p>
          {load.fixtureOnly && <span className={css.fixtureBadge}>fixture-only</span>}
        </div>
      )}

      {load.status === 'ready' && (
        <>
          {load.fixtureOnly && (
            <p className={css.fixtureLine}>
              <span className={css.fixtureBadge}>fixture-only</span>
              数据来自本地联调服务，不代表生产配置服务。
            </p>
          )}
          <ul className={css.cardList}>
            {orderedProfiles.map((profile) => {
              const unavailableAssets =
                [...profile.skills, ...profile.knowledgeBases, ...(profile.memory === null ? [] : [profile.memory])]
                  .filter(binding => binding.readiness !== 'ready').length > 0
              return (
                <li key={profile.agentProfileVersionId}>
                  <article
                    className={css.card}
                    data-profile-id={profile.agentProfileId}
                    data-version-id={profile.agentProfileVersionId}
                    data-readiness={profile.readiness}
                    data-default={profile.default ? 'true' : 'false'}
                  >
                    <div className={css.cardHead}>
                      <h3 className={css.cardName}>{profile.name}</h3>
                      {profile.default && <span className={css.defaultBadge}>项目默认</span>}
                      <span className={css[`readiness_${profile.readiness}`]} data-readiness={profile.readiness}>
                        {READINESS_LABEL[profile.readiness] ?? profile.readiness}
                      </span>
                    </div>
                    <p className={css.cardDescription}>{profile.description}</p>
                    <dl className={css.cardFacts}>
                      <div>
                        <dt>Agent 类型</dt>
                        <dd>
                          {profile.agentTypeName}（{profile.agentTypeKey}）
                          <span className={css[`readiness_${profile.agentTypeReadiness}`]}>
                            {READINESS_LABEL[profile.agentTypeReadiness] ?? profile.agentTypeReadiness}
                          </span>
                        </dd>
                      </div>
                      <div>
                        <dt>已发布版本</dt>
                        <dd>
                          {profile.versionLabel} · 更新于 {profile.updatedAt}
                        </dd>
                      </div>
                      <div>
                        <dt>团队资产</dt>
                        <dd>
                          Skill {profile.skills.length} 项
                          {unavailableAssets && <span className={css.unavailableFlag}>（含不可用资产）</span>}
                          · 知识库 {profile.knowledgeBases.length} 项 ·{' '}
                          {profile.memory === null ? '未使用记忆库' : `记忆库 ${profile.memory.name}`}
                        </dd>
                      </div>
                      <div>
                        <dt>执行策略</dt>
                        <dd>
                          写入模式 {profile.executionPolicy.write_mode} · 权限模式{' '}
                          {profile.executionPolicy.permission_mode}
                        </dd>
                      </div>
                      {profile.unavailableReason !== null && (
                        <div>
                          <dt>状态说明</dt>
                          <dd>{profile.unavailableReason}</dd>
                        </div>
                      )}
                    </dl>
                    {profile.readiness === 'ready' && (
                      <button
                        type="button"
                        className={css.cardButton}
                        onClick={() => {
                          setSelectedProfile(profile)
                        }}
                      >
                        选择使用
                      </button>
                    )}
                    <button
                      type="button"
                      className={css.cardButton}
                      onClick={() => {
                        openDetail(profile.agentProfileVersionId)
                      }}
                    >
                      查看只读详情
                    </button>
                  </article>
                </li>
              )
            })}
          </ul>
          <DetailPane
            detail={detail}
            schemaState={detail.status === 'ready' ? schemas[detail.profile.agentTypeId] : undefined}
            onClose={() => { setDetail({ status: 'idle' }) }}
            remote={remote}
            profileId={detail.status === 'ready' ? detail.profile.agentProfileId : ''}
          />
        </>
      )}
    </section>
  )
}

function DetailPane({ detail, schemaState, onClose, remote, profileId }: {
  readonly detail: DetailState
  readonly schemaState: SchemaState | undefined
  readonly onClose: () => void
  readonly remote: ClientRemote
  readonly profileId: string
}): ReactElement | null {
  const panelRef = useRef<HTMLDivElement | null>(null)
  const [editorOpen, setEditorOpen] = useState(false)
  const previousFocusRef = useRef<HTMLElement | null>(null)
  const closeTimerRef = useRef<number | null>(null)
  const [closing, setClosing] = useState(false)
  // 关闭回调经 ref 固定身份：否则父组件每次重渲染都会换掉 onClose，
  // 让打开期间的键盘/焦点副作用反复重挂（并反复抢走焦点）。
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  const open = detail.status !== 'idle'

  const finishClose = useCallback((): void => {
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current)
      closeTimerRef.current = null
    }
    setClosing(false)
    onCloseRef.current()
  }, [])

  // 关闭与进入同向：先把退出动画播完再卸载面板。reduced-motion 下没有动画事件，
  // jsdom 等环境也不派发 animationend，因此始终保留计时器兜底。
  const requestClose = useCallback((): void => {
    if (closeTimerRef.current !== null) return
    setClosing(true)
    closeTimerRef.current = window.setTimeout(finishClose, 260)
  }, [finishClose])

  useEffect(() => () => {
    if (closeTimerRef.current !== null) window.clearTimeout(closeTimerRef.current)
  }, [])

  useEffect(() => {
    if (!open) return undefined
    // 打开：焦点进入面板且不重置文档滚动；Escape 捕获段关闭，避免冒泡关闭整个壳层。
    previousFocusRef.current = document.activeElement as HTMLElement | null
    panelRef.current?.focus({ preventScroll: true })
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        requestClose()
        return
      }
      // 焦点陷阱：Tab 在面板内循环，不把焦点交还给背后的页面。
      if (event.key !== 'Tab') return
      const panel = panelRef.current
      if (panel === null) return
      const focusables = Array.from(panel.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), select:not([disabled]), input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ))
      const first = focusables[0]
      const last = focusables[focusables.length - 1]
      if (first === undefined || last === undefined) {
        event.preventDefault()
        panel.focus({ preventScroll: true })
        return
      }
      const active = document.activeElement
      if (event.shiftKey ? active === first || active === panel : active === last) {
        event.preventDefault()
        ;(event.shiftKey ? last : first).focus()
      }
    }
    // 监听挂在 window 捕获段：详情是层级最高的一层，Escape 必须先被它消费；
    // 挂在 document 上时，事件目标为 window 的按键（键盘自动化、脱离文档焦点的
    // 场景）根本不会到达监听器，Escape 会静默失效。
    window.addEventListener('keydown', onKey, true)
    return () => { window.removeEventListener('keydown', onKey, true) }
  }, [open, requestClose])

  useEffect(() => {
    if (detail.status !== 'idle' || previousFocusRef.current === null) return
    // 关闭：焦点回到触发卡片，且不重置滚动位置。
    previousFocusRef.current.focus({ preventScroll: true })
    previousFocusRef.current = null
  }, [detail.status])

  if (detail.status === 'idle') return null
  return (
    <div className={css.detailOverlay} role="dialog" aria-label="配置只读详情" onClick={requestClose}>
      <div
        ref={panelRef}
        className={css.detailPanel}
        data-state={detail.status}
        data-closing={closing ? 'true' : undefined}
        tabIndex={-1}
        onAnimationEnd={(event) => {
          if (event.animationName.includes('detail-drawer-out')) finishClose()
        }}
        onClick={(event) => { event.stopPropagation() }}
      >
        <div className={css.detailHead}>
          <h3 className={css.detailTitle}>配置详情（只读）</h3>
          <button type="button" className={css.detailClose} onClick={requestClose} aria-label="关闭详情">
            关闭
          </button>
        </div>
        {detail.status === 'loading' && <p className={css.stateLine}>正在读取配置详情…</p>}
        {detail.status === 'signed-out' && <p className={css.stateLine} role="alert">账号已登出，详情已清空。</p>}
        {detail.status === 'failed' && (
          <div className={css.errorBox} role="alert" data-error-code={detail.code}>
            <p>读取详情失败：{detail.message}</p>
            <p className={css.errorCode}>错误码 {detail.code}</p>
          </div>
        )}
        {detail.status === 'ready' && <DetailSections profile={detail.profile} schemaState={schemaState} />}
        {detail.status === 'ready' && editorOpen && (
          <AgentConfigEditor remote={remote} profileId={profileId} onFinished={() => { setEditorOpen(false) }} />
        )}
        {detail.status === 'ready' && !editorOpen && (
          <button type="button" className={css.detailClose} onClick={() => { setEditorOpen(true) }}>编辑配置</button>
        )}
      </div>
    </div>
  )
}

/** 记忆库卡片的一行元信息；`capacity` 标出服务端容量字段的占位行。 */
interface MemoryCardLine {
  readonly text: string
  readonly capacity?: true
}

interface MemoryCardOption {
  readonly key: string
  readonly label: string
  readonly selected: boolean
  readonly lines: readonly MemoryCardLine[]
}

/**
 * 记忆库单选卡片（规格 §6）：服务端绑定结果的只读镜像。
 * 选中态完全由服务端决定、插件不写回，因此组上声明 `aria-readonly`；键盘遵循
 * 标准 radiogroup 模式——组内只留一个 Tab 停靠点，方向键在卡片间移动焦点。
 */
function MemoryRadioCards({ memory }: { readonly memory: AgentAssetBinding | null }): ReactElement {
  const options: readonly MemoryCardOption[] = [
    { key: 'none', label: '未使用记忆库', selected: memory === null, lines: [] },
    ...(memory === null
      ? []
      : [{
        key: memory.assetId,
        label: memory.name,
        selected: true,
        lines: [
          {
            text: `${memory.assetVersionId} · ${READINESS_LABEL[memory.readiness] ?? memory.readiness}`
              + (memory.unavailableReason === null ? '' : `：${memory.unavailableReason}`),
          },
          { text: '容量：服务端契约未提供（BLOCKED）', capacity: true },
          { text: '描述/更新时间：服务端契约未提供（BLOCKED）' },
        ],
      } satisfies MemoryCardOption]),
  ]
  const refs = useRef<Array<HTMLDivElement | null>>([])
  const selectedIndex = options.findIndex(option => option.selected)
  const [activeIndex, setActiveIndex] = useState(selectedIndex < 0 ? 0 : selectedIndex)

  const focusOption = (index: number): void => {
    const next = ((index % options.length) + options.length) % options.length
    setActiveIndex(next)
    refs.current[next]?.focus()
  }

  return (
    <div className={css.memoryCards} role="radiogroup" aria-readonly="true" aria-label="记忆库绑定（只读）">
      {options.map((option, index) => (
        <div
          key={option.key}
          ref={(node) => {
            refs.current[index] = node
          }}
          className={option.selected ? `${css.memoryCard} ${css.memoryCardSelected}` : css.memoryCard}
          role="radio"
          aria-checked={option.selected}
          aria-label={option.key === 'none' ? '未使用记忆库' : `记忆库 ${option.label}`}
          data-selected={option.selected ? 'true' : 'false'}
          tabIndex={index === activeIndex ? 0 : -1}
          onFocus={() => {
            setActiveIndex(index)
          }}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown' || event.key === 'ArrowRight') {
              event.preventDefault()
              focusOption(index + 1)
              return
            }
            if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') {
              event.preventDefault()
              focusOption(index - 1)
            }
          }}
        >
          <strong>{option.label}</strong>
          {option.lines.map(line => (
            <span
              key={line.text}
              className={css.memoryCardMeta}
              {...(line.capacity === true ? { 'data-capacity': 'blocked' } : {})}
            >
              {line.text}
            </span>
          ))}
          <span className={css.memoryCardState}>{option.selected ? '当前选择' : '未选择'}</span>
        </div>
      ))}
    </div>
  )
}

function DetailSections({ profile, schemaState }: {
  readonly profile: AgentProfileSummary
  readonly schemaState: SchemaState | undefined
}): ReactElement {
  const policyEntries = executionPolicyEntries(profile.executionPolicy)
  // 扩展字段的标签只来自服务端 schema：schema 未就绪时不构造任何条目，
  // 也就不会用原始 key 冒充「已解析的字段」。
  const schema = schemaState?.status === 'ready' ? schemaState.schema : undefined
  const labelOf = (key: string): string => schema?.schema.find(field => field.key === key)?.label ?? key
  const extensionEntries: (readonly [string, string])[] = schema === undefined
    ? []
    : [
      ...Object.entries(profile.typeExtension).map(([key, value]) => [labelOf(key), String(value)] as const),
      ...profile.typeExtensionOpaqueKeys.map(key => [labelOf(key), '服务端扩展字段'] as const),
    ]
  return (
    <div className={css.detailBody} data-version-id={profile.agentProfileVersionId}>
      <section className={css.detailSection}>
        <h4>基本信息</h4>
        <dl className={css.factGrid}>
          <div>
            <dt>配置名称</dt>
            <dd>{profile.name}</dd>
          </div>
          <div>
            <dt>描述</dt>
            <dd>{profile.description}</dd>
          </div>
          <div>
            <dt>Agent 类型</dt>
            <dd>
              {profile.agentTypeName}（{profile.agentTypeKey} · {READINESS_LABEL[profile.agentTypeReadiness] ?? profile.agentTypeReadiness}）
            </dd>
          </div>
          <div>
            <dt>已发布版本</dt>
            <dd>{profile.versionLabel}</dd>
          </div>
          <div>
            <dt>创建人</dt>
            <dd>{profile.createdBy}</dd>
          </div>
          <div>
            <dt>发布时间</dt>
            <dd>{profile.publishedAt}</dd>
          </div>
          <div>
            <dt>最近更新</dt>
            <dd>{profile.updatedAt}</dd>
          </div>
          <div>
            <dt>项目默认</dt>
            <dd>{profile.default ? '是' : '否'}</dd>
          </div>
        </dl>
      </section>

      <section className={css.detailSection}>
        <h4>模型参数</h4>
        <dl className={css.factGrid}>
          <div>
            <dt>模型</dt>
            <dd>{profile.model}</dd>
          </div>
          <div>
            <dt>推理级别</dt>
            <dd>{profile.reasoning}</dd>
          </div>
          <div>
            <dt>类型声明的能力</dt>
            <dd>{profile.agentTypeCapabilities.join('、')}</dd>
          </div>
          <div>
            <dt>readiness</dt>
            <dd>
              <span className={css[`readiness_${profile.readiness}`]}>
                {READINESS_LABEL[profile.readiness] ?? profile.readiness}
              </span>
              {profile.unavailableReason === null ? '' : `：${profile.unavailableReason}`}
            </dd>
          </div>
        </dl>
      </section>

      <section className={css.detailSection}>
        <h4>团队资产</h4>
        <h5 className={css.assetGroupTitle}>Skill（按服务端顺序）</h5>
        {profile.skills.length === 0 ? (
          <p className={css.assetEmpty}>未绑定 Skill</p>
        ) : (
          <ul className={css.assetList}>{profile.skills.map(bindingRow)}</ul>
        )}
        <h5 className={css.assetGroupTitle}>知识库</h5>
        {profile.knowledgeBases.length === 0 ? (
          <p className={css.assetEmpty}>未绑定知识库</p>
        ) : (
          <ul className={css.assetList}>{profile.knowledgeBases.map(bindingRow)}</ul>
        )}
        <h5 className={css.assetGroupTitle}>记忆库</h5>
        {/* 单选卡片（规格 §6，AFC-UX-05）：每个版本最多绑定一个记忆库
            （服务端契约 `memory: binding | null`），插件侧只呈现服务端结果。 */}
        <MemoryRadioCards memory={profile.memory} />
      </section>

      <section className={css.detailSection}>
        <h4>执行策略</h4>
        {policyEntries.length === 0 ? (
          <p className={css.assetEmpty}>服务端未声明执行策略</p>
        ) : (
          <dl className={css.factGrid}>
            {policyEntries.map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
        )}
      </section>

      <section className={css.detailSection}>
        <h4>类型扩展</h4>
        {schemaState === undefined && (
          <p className={css.assetEmpty} data-state="schema-loading">正在读取该 Agent 类型的 schema…</p>
        )}
        {schemaState?.status === 'signed-out' && (
          <p className={css.stateLine} role="alert" data-state="schema-signed-out">
            账号已登出，类型扩展字段不可读取。
          </p>
        )}
        {schemaState?.status === 'failed' && (
          <div className={css.errorBox} role="alert" data-state="schema-failed" data-error-code={schemaState.code}>
            <p>读取 Agent 类型 schema 失败：{schemaState.message}</p>
            <p className={css.errorCode}>错误码 {schemaState.code}</p>
          </div>
        )}
        {schema !== undefined && (extensionEntries.length === 0 ? (
          <p className={css.assetEmpty}>无类型扩展字段</p>
        ) : (
          <dl className={css.factGrid}>
            {extensionEntries.map(([key, value]) => (
              <div key={key}>
                <dt>{key}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
        ))}
      </section>
    </div>
  )
}
