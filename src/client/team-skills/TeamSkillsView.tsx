import { useEffect, useMemo, useRef, useState } from 'react'
import type {
  TeamSkillCatalogItem,
  TeamSkillEnvironment,
  TeamSkillInstallationView,
  TeamSkillInstallStageEvidence,
  TeamSkillProject,
  TeamSkillTrustCard,
} from '../../types.ts'
import { installStageRows, installedStateLabel, trustCardSections } from './trust-card.ts'
import type { PlatformRemote } from '../remote/types.ts'
// 0.1.1-rc.2 exposed the workspace registry projection as `WorkspaceListState`
// from the withdrawn client-runtime package. On the 0.1.5-rc.2 baseline the
// workspace controller owns it as `WorkspaceSnapshot`, and `ui-workspace`
// declares the global `useWorkspaces` hook as
// `SnapshotSelectorHook<WorkspaceSnapshot>`. The consumed shape is unchanged:
// both expose `items: readonly WorkspaceView[]`.
import type { WorkspaceSnapshot } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import {
  IconCheckOutline14,
  IconCloseOutline16,
  IconPlusOutline16,
  IconRefreshOutline16,
  IconSkillOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import css from './TeamSkillsView.module.css'

export interface TeamSkillsViewProps {
  /** Typed DSH Remote assembly carrying the Host-owned Team Skill namespace. */
  readonly remote: PlatformRemote
  /** DSH workspace projection used only to select an opaque project id. */
  readonly useWorkspaces: SnapshotSelectorHook<WorkspaceSnapshot>
  /** Opaque selected project identity used for server-side authorization. */
  readonly projectId?: string
  /** Projects the account may explicitly choose for project-scoped Skill operations. */
  readonly projects: readonly TeamSkillProject[]
  /** Set the explicit project context for Skill operations. */
  readonly onProjectSelect?: (projectId: string) => void
  /** Local dependency facts sent to the Host without paths or values. */
  readonly environment: TeamSkillEnvironment
  /** Refresh the Host account when the service reports an authorization failure. */
  readonly onAuthorizationFailure?: () => void
}

type LoadState =
  | { readonly status: 'loading' }
  | { readonly status: 'project-required' }
  | {
    readonly status: 'ready'
    readonly items: readonly TeamSkillCatalogItem[]
    readonly installations: readonly TeamSkillInstallationView[]
  }
  | { readonly status: 'error'; readonly title: string; readonly message: string }

type Scope = 'project' | 'global'

/** Render the server-authoritative local Team Skill catalogue and installer. */
export function TeamSkillsView({
  remote,
  useWorkspaces,
  projectId,
  projects,
  onProjectSelect,
  environment,
  onAuthorizationFailure,
}: TeamSkillsViewProps) {
  const workspaces = useWorkspaces(state => state.items)
  const [state, setState] = useState<LoadState>({ status: 'loading' })
  const [query, setQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState<'all' | 'installed' | 'available' | 'quarantined'>('all')
  const [selected, setSelected] = useState<TeamSkillCatalogItem | undefined>()
  const [detail, setDetail] = useState<
    { readonly item: TeamSkillCatalogItem | undefined; readonly installation: TeamSkillInstallationView | undefined } | undefined
  >()
  const [pendingUninstall, setPendingUninstall] = useState<TeamSkillInstallationView | undefined>()
  const [scope, setScope] = useState<Scope>('project')
  const [installing, setInstalling] = useState<string | undefined>()
  const [operationMessage, setOperationMessage] = useState<string | undefined>()
  // Stage evidence for the last install attempt. Undefined means no attempt
  // produced evidence (for example a request that never reached the Host), and
  // the view says so instead of rendering an empty stage list.
  const [stageEvidence, setStageEvidence] = useState<readonly TeamSkillInstallStageEvidence[] | undefined>()
  // Trust card of the release shown in the detail dialog. It is fetched on
  // demand and cleared with the dialog, so a card never describes another Skill.
  const [trustCard, setTrustCard] = useState<TeamSkillTrustCard | undefined>()
  const [trustCardError, setTrustCardError] = useState<string | undefined>()
  const [retryAction, setRetryAction] = useState<(() => void) | undefined>()
  const requestGeneration = useRef(0)
  const activeRequest = useRef<AbortController | undefined>()

  const load = async (): Promise<void> => {
    activeRequest.current?.abort()
    const controller = new AbortController()
    activeRequest.current = controller
    const generation = ++requestGeneration.current
    const current = (): boolean => generation === requestGeneration.current && !controller.signal.aborted
    if (projectId === undefined) {
      if (current()) setState({ status: 'project-required' })
      return
    }
    const selectedProjectId = projectId
    if (current()) setState({ status: 'loading' })
    const [catalogResult, installationsResult] = await Promise.all([
      remote.teamSkills.catalog(selectedProjectId),
      remote.teamSkills.syncReleaseStatus(selectedProjectId),
    ])
    if (!current()) return
    if (!catalogResult.ok) {
      if (isAuthorizationFailure(catalogResult.error.code)) onAuthorizationFailure?.()
      setState({ status: 'error', title: '团队 Skill 暂不可用', message: catalogResult.error.message })
      return
    }
    if (catalogResult.value.status !== 'ready') {
      if (isAuthorizationResult(catalogResult.value)) onAuthorizationFailure?.()
      setState({ status: 'error', title: '团队 Skill 暂不可用', message: catalogMessage(catalogResult.value) })
      return
    }
    if (!installationsResult.ok) {
      if (isAuthorizationFailure(installationsResult.error.code)) onAuthorizationFailure?.()
      setState({ status: 'error', title: '无法读取本地安装状态', message: installationsResult.error.message })
      return
    }
    if (!isInstallationList(installationsResult.value)) {
      if (isAuthorizationResult(installationsResult.value)) onAuthorizationFailure?.()
      setState({ status: 'error', title: '无法读取本地安装状态', message: localInstallationMessage(installationsResult.value) })
      return
    }
    setState({ status: 'ready', items: catalogResult.value.catalog.items, installations: installationsResult.value })
  }

  useEffect(() => {
    void load()
    return () => {
      activeRequest.current?.abort()
    }
  }, [remote, projectId])

  // One merged list: every catalog row carries its installation state, and
  // quarantined local rows stay visible with their reason even when the
  // catalog no longer offers that version.
  const rows = useMemo(() => {
    if (state.status !== 'ready') return []
    const normalized = query.trim().toLocaleLowerCase()
    const matches = (text: string): boolean => normalized.length === 0 || text.toLocaleLowerCase().includes(normalized)
    const installationFor = (item: TeamSkillCatalogItem): TeamSkillInstallationView | undefined => {
      const candidates = state.installations.filter(value => value.skillId === item.skillId && value.state !== 'uninstalled')
      // 同一 Skill 同时存在项目与全局副本时，行内展示并操作与当前项目作用域一致的那一份。
      return candidates.find(value => value.scope === 'project') ?? candidates.find(value => value.scope === 'global')
    }
    const entries: readonly {
      readonly key: string
      readonly item: TeamSkillCatalogItem | undefined
      readonly installation: TeamSkillInstallationView | undefined
    }[] = [
      ...state.items.map(item => ({
        key: `catalog:${item.skillId}`,
        item,
        installation: installationFor(item),
      })),
      ...state.installations
        .filter(value => value.state !== 'uninstalled')
        .filter(value => !state.items.some(item => item.skillId === value.skillId))
        .map(value => ({
          key: `local:${value.localInstallationId}`,
          item: undefined,
          installation: value,
        })),
    ]
    return entries.filter((entry) => {
      const name = entry.item?.displayName ?? entry.installation?.runtimeName ?? ''
      const summary = entry.item?.summary ?? ''
      if (!matches(`${name}${summary}${entry.item?.category ?? ''}${(entry.item?.tags ?? []).join('')}`)) return false
      if (statusFilter === 'all') return true
      if (statusFilter === 'installed') return entry.installation?.state === 'normal'
      if (statusFilter === 'quarantined') return entry.installation?.state === 'withdrawn'
      return entry.installation === undefined
    })
  }, [query, statusFilter, state])

  const install = async (): Promise<void> => {
    if (selected === undefined || installing !== undefined) return
    if (projectId === undefined) return
    const selectedProjectId = projectId
    const generation = requestGeneration.current
    if (scope === 'project' && workspaces[0] === undefined) return
    setInstalling(selected.skillId)
    setOperationMessage(undefined)
    setStageEvidence(undefined)
    const result = await remote.teamSkills.installSkill({
      skillId: selected.skillId,
      version: selected.version,
      projectId: selectedProjectId,
      scope,
      ...(scope === 'project' && workspaces[0] !== undefined ? { workspaceId: workspaces[0].workspaceId } : {}),
      environment,
    })
    if (generation !== requestGeneration.current) return
    setInstalling(undefined)
    if (!result.ok) {
      if (isAuthorizationFailure(result.error.code)) onAuthorizationFailure?.()
      setOperationMessage(`安装失败：${result.error.message}（${result.error.code}）`)
      setRetryAction(() => install)
      return
    }
    if (result.value.status === 'not-ready') {
      setOperationMessage(`安装失败：服务端未就绪，缺少配置：${result.value.missing.join('、')}`)
      return
    }
    if (result.value.status === 'signed-out') {
      onAuthorizationFailure?.()
      setOperationMessage('安装失败：登录状态已失效，请重新登录')
      return
    }
    if (result.value.status === 'failed') {
      setStageEvidence(result.value.stages)
      // 失败必须说清三件事：停在哪一步（阶段证据）、服务端 request id（取证入口）
      // 与能否重试（可重试动作）。缺任一项用户就只能猜。
      const requestId = result.value.requestId
      setOperationMessage(
        `安装失败：${result.value.message}`
        + (requestId === undefined ? '' : `（请求 ${requestId}）`)
        + (result.value.retryable.retryable ? ` · ${result.value.retryable.how}` : ''),
      )
      if (result.value.retryable.retryable) setRetryAction(() => install)
      return
    }
    const installation = result.value.installation
    setStageEvidence(result.value.stages)
    setState(previous =>
      previous.status === 'ready'
        ? {
          ...previous,
          installations: [
            ...previous.installations.filter(item => !(item.skillId === selected.skillId && item.scope === scope)),
            installation,
          ],
        }
        : previous,
    )
    setOperationMessage(scope === 'project' ? '已安装到当前项目' : '已安装到全局 DSH')
    setRetryAction(undefined)
    setSelected(undefined)
  }

  const uninstall = async (installation: TeamSkillInstallationView): Promise<void> => {
    if (installing !== undefined) return
    const generation = requestGeneration.current
    setInstalling(installation.localInstallationId)
    setOperationMessage(undefined)
    const result = await remote.teamSkills.uninstallSkill({ localInstallationId: installation.localInstallationId })
    if (generation !== requestGeneration.current) return
    setInstalling(undefined)
    if (!result.ok) {
      if (isAuthorizationFailure(result.error.code)) onAuthorizationFailure?.()
      setOperationMessage(`卸载失败：${result.error.message}（${result.error.code}）`)
      setRetryAction(() => () => void uninstall(installation))
      return
    }
    if (result.value.status === 'failed') {
      setOperationMessage(`卸载失败：${result.value.message}`)
      return
    }
    if (result.value.status === 'not-ready') {
      setOperationMessage(`卸载失败：本地状态未就绪：${result.value.missing.join('、')}`)
      return
    }
    const updatedInstallation = result.value.installation
    setState(previous =>
      previous.status === 'ready'
        ? {
          ...previous,
          installations: previous.installations.map(item =>
            item.localInstallationId === installation.localInstallationId ? updatedInstallation : item,
          ),
        }
        : previous,
    )
    setOperationMessage('已从 DSH 移除该 Skill')
    setRetryAction(undefined)
  }

  const loadTrustCard = async (): Promise<void> => {
    const item = detail?.item
    if (item === undefined || projectId === undefined) return
    setTrustCardError(undefined)
    const result = await remote.teamSkills.trustCard({ skillId: item.skillId, version: item.version, projectId })
    if (!result.ok) {
      if (isAuthorizationFailure(result.error.code)) onAuthorizationFailure?.()
      setTrustCardError(`${result.error.message}（${result.error.code}）`)
      return
    }
    if ('status' in result.value) {
      if (isAuthorizationResult(result.value)) onAuthorizationFailure?.()
      setTrustCardError(
        result.value.status === 'not-ready'
          ? `服务端未就绪，缺少配置：${result.value.missing.join('、')}`
          : result.value.status === 'signed-out'
            ? '登录状态已失效，请重新登录'
            : result.value.message,
      )
      return
    }
    setTrustCard(result.value)
  }

  if (state.status === 'loading')
    return (
      <section className={css.pageState} aria-live="polite">
        <IconRefreshOutline16 size={18} />
        <h2>正在读取团队 Skill</h2>
        <p>从平台服务获取当前用户可见的已发布版本。</p>
      </section>
    )
  if (state.status === 'project-required')
    return (
      <section className={css.pageState} role="status">
        <IconSkillOutline16 size={18} />
        <h2>选择项目后查看 Skill</h2>
        <p>项目级 Skill 目录和安装操作需要显式项目上下文。</p>
        <div className={css.projectOptions}>
          {projects.map(project => (
            <button
              type="button"
              key={project.projectId}
              className={css.secondaryButton}
              onClick={() => {
                onProjectSelect?.(project.projectId)
              }}
            >
              {project.name}
            </button>
          ))}
        </div>
        {projects.length === 0 && <p>当前账号没有可访问的项目。</p>}
      </section>
    )
  if (state.status === 'error')
    return (
      <section className={css.pageState} role="alert">
        <IconCloseOutline16 size={18} />
        <h2>{state.title}</h2>
        <p>{state.message}</p>
        <button type="button" className={css.secondaryButton} onClick={() => void load()}>
          <IconRefreshOutline16 size={16} />
          重新读取
        </button>
      </section>
    )

  return (
    <section className={css.page} aria-label="团队 Skill">
      <div className={css.header}>
        <div>
          <span className={css.eyebrow}>团队 Skill</span>
          <h1>把已发布能力安装到本地 DSH</h1>
          <p>目录、安装与授权状态合并为可用 Skill 视图；发布、审核与绑定在后台治理完成。</p>
        </div>
        <div className={css.actions}>
          <span className={css.scopeLabel}>项目作用域：{projectId === undefined ? '未选择' : (projects.find(item => item.projectId === projectId)?.name ?? projectId)}</span>
          <label className={css.search}>
            <span className={css.searchIcon}>⌕</span>
            <input
              value={query}
              onChange={(event) => {
                setQuery(event.target.value)
              }}
              placeholder="搜索 Skill"
            />
          </label>
          <label className={css.statusFilter}>
            <span className={css.statusFilterLabel}>状态</span>
            <select
              aria-label="Skill 状态筛选"
              value={statusFilter}
              onChange={(event) => {
                setStatusFilter(event.target.value as typeof statusFilter)
              }}
            >
              <option value="all">全部</option>
              <option value="available">未安装</option>
              <option value="installed">已安装</option>
              <option value="quarantined">已隔离</option>
            </select>
          </label>
          <button type="button" className={css.secondaryButton} onClick={() => void load()} title="刷新目录">
            <IconRefreshOutline16 size={16} />
            刷新
          </button>
        </div>
      </div>
      {stageEvidence !== undefined && stageEvidence.length > 0 && (
        <section data-role="install-stages" aria-label="安装阶段证据">
          <h3>安装阶段</h3>
          <ol>
            {installStageRows(stageEvidence).map(row => (
              <li key={row.stage} data-stage={row.stage} data-outcome={row.rawOutcome}>
                <strong>{row.label}</strong>
                <span>{row.outcome}</span>
                <span>{row.detail}</span>
              </li>
            ))}
          </ol>
        </section>
      )}
      {operationMessage !== undefined && (
        <div className={css.operation} role="status">
          <IconCheckOutline14 size={16} />
          <span>{operationMessage}</span>
          {retryAction !== undefined && (
            <button
              type="button"
              className={css.secondaryButton}
              onClick={() => {
                setOperationMessage(undefined)
                retryAction()
              }}
            >
              重试
            </button>
          )}
        </div>
      )}
      {rows.length === 0 ? (
        <div className={css.empty}>
          <IconSkillOutline16 size={20} />
          <h2>没有匹配的已发布 Skill</h2>
          <p>请调整搜索词或状态筛选，或等待管理员发布新的平台制品。</p>
        </div>
      ) : (
        <div className={css.grid}>
          {rows.map(({ key, item, installation }) => {
            const displayName = item?.displayName ?? installation?.runtimeName ?? ''
            const version = item?.version ?? installation?.version ?? ''
            const withdrawn = installation?.state === 'withdrawn'
            const outdated = item !== undefined && installation !== undefined && installation.version !== item.version
            // 已安装状态只有四种：已安装 / 需要更新 / 已撤销 / 已卸载。目录条目但未安装
            // 时显示「已发布」。撤回的副本必须显示为已撤销，不能停在「已隔离」。
            const stateLabel = installation === undefined
              ? '已发布'
              : installedStateLabel(installation.state, installation.version, item?.version)
            return (
              <article key={key} className={css.card}>
                <div className={css.cardTop}>
                  <span className={css.skillIcon}>
                    <IconSkillOutline16 size={18} />
                  </span>
                  <span
                    className={withdrawn ? css.withdrawn : installation !== undefined ? css.installed : css.published}
                    data-installed-state={stateLabel}
                  >
                    {stateLabel}
                  </span>
                </div>
                <h2>{displayName}</h2>
                <p>{item?.summary ?? '本地已安装的 Team Skill'}</p>
                <div className={css.meta}>
                  <span>{item?.category ?? (installation?.scope === 'project' ? '当前项目' : '全局 DSH')}</span>
                  <span>平台托管版本 v{version}</span>
                  {outdated && <span>本地 v{installation.version}，需要更新</span>}

                </div>
                <div className={css.tags}>
                  {(item?.tags ?? []).map(tag => (
                    <span key={tag}>{tag}</span>
                  ))}
                  {withdrawn && <span>不可用原因：版本已下线，内容保留在隔离区</span>}
                </div>
                <div className={css.cardBottom}>
                  <button
                    type="button"
                    className={css.secondaryButton}
                    aria-label={`查看${displayName}`}
                    onClick={() => {
                      setDetail({ item: item as TeamSkillCatalogItem, installation })
                      setTrustCard(undefined)
                      setTrustCardError(undefined)
                    }}
                  >
                    查看
                  </button>
                  {withdrawn ? null : installation === undefined ? (
                    <button
                      type="button"
                      className={css.installButton}
                      onClick={() => {
                        setSelected(item)
                        setScope(workspaces[0] === undefined ? 'global' : 'project')
                      }}
                    >
                      <IconPlusOutline16 size={16} />
                      安装 Skill
                    </button>
                  ) : outdated ? (
                    <button
                      type="button"
                      className={css.installButton}
                      disabled={installing !== undefined}
                      onClick={() => {
                        setSelected(item)
                        setScope(installation.scope === 'global' ? 'global' : 'project')
                      }}
                    >
                      <IconPlusOutline16 size={16} />
                      更新
                    </button>
                  ) : (
                    <span className={css.installed}>
                      <IconCheckOutline14 size={16} />
                      {installation.scope === 'project' ? '当前项目已安装' : '全局已安装'}
                    </span>
                  )}
                  {installation?.state === 'normal' && (
                    <button
                      type="button"
                      className={css.secondaryButton}
                      disabled={installing !== undefined}
                      onClick={() => {
                        setPendingUninstall(installation)
                      }}
                    >
                      <IconCloseOutline16 size={16} />
                      卸载
                    </button>
                  )}
                </div>
              </article>
            )
          })}
        </div>
      )}

      {detail !== undefined && (
        <div className={css.backdrop} role="presentation">
          <div
            className={css.modal}
            role="dialog"
            aria-modal="true"
            aria-label={`查看${detail.item?.displayName ?? detail.installation?.runtimeName ?? ''}`}
          >
            <div className={css.modalHeader}>
              <div>
                <span className={css.eyebrow}>Skill 详情</span>
                <h2>{detail.item?.displayName ?? detail.installation?.runtimeName}</h2>
              </div>
              <button
                type="button"
                className={css.close}
                aria-label="关闭详情"
                onClick={() => {
                  setDetail(undefined)
                }}
              >
                <IconCloseOutline16 size={16} />
              </button>
            </div>
            <dl className={css.detailFacts}>
              <div>
                <dt>版本</dt>
                <dd>
                  {detail.item === undefined
                    ? `v${detail.installation?.version}`
                    : `目录 v${detail.item.version}${detail.installation === undefined ? '' : ` · 本地 v${detail.installation.version}`}`}
                </dd>
              </div>
              <div>
                <dt>来源</dt>
                <dd>平台托管制品</dd>
              </div>
              <div>
                <dt>作用域</dt>
                <dd>{detail.installation === undefined ? '未安装（可选当前项目或全局）' : detail.installation.scope === 'project' ? '当前项目' : '全局 DSH'}</dd>
              </div>
              <div>
                <dt>状态</dt>
                <dd>
                  {detail.installation === undefined
                    ? '已发布'
                    : installedStateLabel(detail.installation.state, detail.installation.version, detail.item?.version)}
                </dd>
              </div>
              <div>
                <dt>不可用原因</dt>
                <dd>{detail.installation?.state === 'withdrawn' ? '版本已下线，内容保留在隔离区' : '无'}</dd>
              </div>
            </dl>
            {detail.item !== undefined && (
              <section data-role="trust-card" aria-label="Skill 信任卡">
                <h3>信任卡</h3>
                <button
                  type="button"
                  className={css.secondaryButton}
                  disabled={installing !== undefined}
                  onClick={() => void loadTrustCard()}
                >
                  查看信任卡
                </button>
                {trustCardError !== undefined && <p role="alert">无法读取信任卡：{trustCardError}</p>}
                {trustCard !== undefined && trustCardSections(trustCard).map(section => (
                  <div key={section.key} data-section={section.key}>
                    <h4>{section.title}</h4>
                    <dl>
                      {section.rows.map(row => (
                        <div key={row.key}>
                          <dt>{row.label}</dt>
                          <dd>{row.value}</dd>
                        </div>
                      ))}
                    </dl>
                  </div>
                ))}
              </section>
            )}
            <div className={css.modalFooter}>
              <button
                type="button"
                className={css.secondaryButton}
                onClick={() => {
                  setDetail(undefined)
                }}
              >
                关闭
              </button>
            </div>
          </div>
        </div>
      )}

      {pendingUninstall !== undefined && (
        <div className={css.backdrop} role="presentation">
          <div className={css.modal} role="dialog" aria-modal="true" aria-label={`卸载${pendingUninstall.runtimeName}`}>
            <div className={css.modalHeader}>
              <div>
                <span className={css.eyebrow}>卸载确认</span>
                <h2>{pendingUninstall.runtimeName}</h2>
              </div>
              <button
                type="button"
                className={css.close}
                aria-label="关闭卸载确认"
                onClick={() => {
                  setPendingUninstall(undefined)
                }}
              >
                <IconCloseOutline16 size={16} />
              </button>
            </div>
            <p className={css.modalLead}>
              将从 {pendingUninstall.scope === 'project' ? '当前项目' : '全局 DSH'} 移除 v{pendingUninstall.version} 的本地副本；该 Skill 在此作用域内随即不可用。
            </p>
            <div className={css.modalFooter}>
              <button
                type="button"
                className={css.secondaryButton}
                onClick={() => {
                  setPendingUninstall(undefined)
                }}
              >
                取消
              </button>
              <button
                type="button"
                className={css.primaryButton}
                disabled={installing !== undefined}
                onClick={() => {
                  const target = pendingUninstall
                  setPendingUninstall(undefined)
                  void uninstall(target)
                }}
              >
                确认卸载
              </button>
            </div>
          </div>
        </div>
      )}

      {selected !== undefined && (
        <div className={css.backdrop} role="presentation">
          <div className={css.modal} role="dialog" aria-modal="true" aria-label={`安装${selected.displayName}`}>
            <div className={css.modalHeader}>
              <div>
                <span className={css.eyebrow}>安装确认</span>
                <h2>{selected.displayName}</h2>
              </div>
              <button
                type="button"
                className={css.close}
                aria-label="关闭安装确认"
                onClick={() => {
                  setSelected(undefined)
                }}
              >
                <IconCloseOutline16 size={16} />
              </button>
            </div>
            <p className={css.modalLead}>将安装不可变的 v{selected.version} 制品。文件校验和写入由 DSH Host 完成。</p>
            <fieldset className={css.scopeField}>
              <legend>安装作用域</legend>
              <label className={scope === 'project' ? css.scopeOptionActive : css.scopeOption}>
                <input
                  type="radio"
                  name="scope"
                  checked={scope === 'project'}
                  disabled={workspaces[0] === undefined}
                  onChange={() => {
                    setScope('project')
                  }}
                />
                <span>
                  <strong>当前项目</strong>
                  <small>{workspaces[0] === undefined ? '当前没有可用的 DSH 工作区' : '优先于全局副本供当前项目使用'}</small>
                </span>
              </label>
              <label className={scope === 'global' ? css.scopeOptionActive : css.scopeOption}>
                <input
                  type="radio"
                  name="scope"
                  checked={scope === 'global'}
                  onChange={() => {
                    setScope('global')
                  }}
                />
                <span>
                  <strong>全局 DSH</strong>
                  <small>供所有未配置项目使用</small>
                </span>
              </label>
            </fieldset>
            <div className={css.modalFooter}>
              <button
                type="button"
                className={css.secondaryButton}
                onClick={() => {
                  setSelected(undefined)
                }}
              >
                取消
              </button>
              <button
                type="button"
                className={css.primaryButton}
                disabled={installing !== undefined || (scope === 'project' && workspaces[0] === undefined)}
                onClick={() => void install()}
              >
                {installing !== undefined ? '正在安装…' : scope === 'project' ? '确认安装到当前项目' : '确认安装到全局 DSH'}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  )
}

function catalogMessage(
  value:
    | { readonly status: 'not-ready'; readonly missing: readonly string[] }
    | { readonly status: 'failed'; readonly code: string; readonly message: string }
    | { readonly status: 'signed-out' },
): string {
  if (value.status === 'not-ready') return `服务端未就绪，缺少配置：${value.missing.join('、')}`
  if (value.status === 'signed-out') return '登录状态已失效，请重新登录'
  return value.message
}

function localInstallationMessage(
  value:
    | { readonly status: 'not-ready'; readonly missing: readonly string[] }
    | { readonly status: 'failed'; readonly code: string; readonly message: string }
    | { readonly status: 'signed-out' },
): string {
  if (value.status === 'not-ready') return `本地安装状态未就绪：${value.missing.join('、')}`
  if (value.status === 'signed-out') return '登录状态已失效，请重新登录'
  return value.message
}

function isInstallationList(
  value:
    | readonly TeamSkillInstallationView[]
    | { readonly status: 'not-ready'; readonly missing: readonly string[] }
    | { readonly status: 'failed'; readonly code: string; readonly message: string }
    | { readonly status: 'signed-out' },
): value is readonly TeamSkillInstallationView[] {
  return Array.isArray(value)
}

/** Whether the Host result requires the caller to restore the account session. */
function isAuthorizationResult(
  value:
    | { readonly status: 'not-ready'; readonly missing: readonly string[] }
    | { readonly status: 'failed'; readonly code: string; readonly message: string }
    | { readonly status: 'signed-out' },
): boolean {
  return value.status === 'signed-out' || (value.status === 'failed' && isAuthorizationFailure(value.code))
}

function isAuthorizationFailure(code: string): boolean {
  return (
    code === 'UNAUTHORIZED' ||
    code === 'AUTH_REQUIRED' ||
    code === 'TOKEN_EXPIRED' ||
    code === 'TOKEN_REVOKED' ||
    code === 'FORBIDDEN' ||
    code === 'ACCOUNT_SUSPENDED' ||
    code === 'PROJECT_NOT_MEMBER' ||
    code === 'RESOURCE_NOT_FOUND' ||
    code === 'NO_ORGANIZATION_ACCESS'
  )
}
