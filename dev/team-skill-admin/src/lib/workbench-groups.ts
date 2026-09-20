/**
 * 工作台分组模型（蓝图 §6.1）。
 *
 * 工作台不是数字卡片墙：它按「需要处理 → 正在运行 → 资产健康 → 权限异常 →
 * 近期结果」组织，并且**每个数字都必须能回答四个问题**——统计的是哪段时间、
 * 施加了什么过滤、数字来自哪个读取、什么时候读到的。没有这四项的计数只是一个
 * 无法核对的断言。
 *
 * 另一条硬规则：某个数据源这次没读到，对应数字是 `null` 加原因，**不是 0**。
 * 0 是在断言「一个都没有」，而读取失败什么都没断言。
 */

/** 固定分组顺序；顺序本身是产品语义，不随数据变化。 */
export const WORKBENCH_GROUPS = ['需要处理', '正在运行', '资产健康', '权限异常', '近期结果'] as const

/** 工作台分组的取值域。 */
export type WorkbenchGroup = (typeof WORKBENCH_GROUPS)[number]

/** 工作台数字可以跳进的列表页（都是管理后台已有的页面）。 */
export type WorkbenchTargetPage =
  | 'reviews'
  | 'cloud-runs'
  | 'cloud-ops'
  | 'cloud-profiles'
  | 'directory'
  | 'account-audit'
  | 'telemetry-events'

/** 统计时间窗。 */
export interface WorkbenchWindow {
  readonly from: string
  readonly to: string
}

/** 点进列表时要保留的过滤条件（只表达目标页真的支持的键）。 */
export interface WorkbenchFilter {
  readonly from?: string
  readonly to?: string
  readonly status?: string
  readonly readiness?: string
}

/** 一个数字的溯源四要素。 */
export interface MetricProvenance {
  readonly timeRange: string
  readonly filters: string
  readonly source: string
  readonly updatedAt: string
}

/** 工作台上的一个数字。 */
export interface WorkbenchMetric {
  readonly id: string
  readonly group: WorkbenchGroup
  readonly label: string
  /** 读取失败时为 null——不得用 0 冒充「零个」。 */
  readonly value: number | null
  readonly hint?: string
  readonly provenance: MetricProvenance
  readonly targetPage: WorkbenchTargetPage
  readonly targetFilter: WorkbenchFilter
}

/** 模型只读它真正用到的字段，因此这里用结构性类型而不是完整的管理面 DTO。 */
export interface WorkbenchViews {
  readonly reviews?: readonly { readonly status: string }[] | undefined
  readonly skills?: readonly { readonly status: string }[] | undefined
  readonly workspaces?: readonly { readonly status: string }[] | undefined
  readonly runs?: readonly { readonly status: string }[] | undefined
  readonly profiles?: readonly { readonly readiness: string }[] | undefined
  readonly authorizationAudits?: readonly { readonly result: string }[] | undefined
}

/** 构建工作台指标所需的输入。 */
export interface WorkbenchInput {
  readonly window: WorkbenchWindow
  readonly updatedAt: string
  readonly views: WorkbenchViews
}

/** 当前状态类指标的统计范围说明：它不随时间窗变化，必须说出来。 */
const CURRENT_STATE_RANGE = '当前状态（不随时间窗变化）'

/** 读取失败时的说明：说清楚是什么没读到，而不是给一个看起来正常的数字。 */
const READ_UNAVAILABLE = '读取不可用：本次未能读取该数据源，不以 0 代替'

function countWhere<T>(rows: readonly T[] | undefined, predicate: (row: T) => boolean): number | null {
  // 读取失败与「过滤后为空」是两件事：前者没有数字，后者才是 0。
  return rows === undefined ? null : rows.filter(predicate).length
}

/**
 * 按固定五组构建工作台指标。
 * @param input - 时间窗、读取时刻与各数据源的读取结果（`undefined` 表示本次读取不可用）。
 * @returns 指标列表，分组顺序即 `WORKBENCH_GROUPS`。
 */
export function buildWorkbenchMetrics(input: WorkbenchInput): readonly WorkbenchMetric[] {
  const { views, window, updatedAt } = input
  const scoped = (source: string, filters: string): MetricProvenance => ({
    timeRange: `${window.from} ~ ${window.to}`,
    filters,
    source,
    updatedAt,
  })
  const current = (source: string, filters: string): MetricProvenance => ({
    timeRange: CURRENT_STATE_RANGE,
    filters,
    source,
    updatedAt,
  })
  const unavailable = (): { readonly value: null; readonly hint: string } => ({ value: null, hint: READ_UNAVAILABLE })

  const pendingReviews = countWhere(views.reviews, row => row.status === 'pending_review')
  const failedWorkspaces = countWhere(views.workspaces, row => row.status === 'failed')
  const runningRuns = countWhere(views.runs, row => row.status === 'running')
  const unreadyProfiles = countWhere(views.profiles, row => row.readiness === 'unavailable' || row.readiness === 'degraded')
  const withdrawnSkills = countWhere(views.skills, row => row.status === 'withdrawn')
  const deniedAuthorizations = countWhere(views.authorizationAudits, row => row.result === 'failed')
  const succeededRuns = countWhere(views.runs, row => row.status === 'succeeded')
  const failedRuns = countWhere(views.runs, row => row.status === 'failed')

  return [
    {
      id: 'pending-reviews',
      group: '需要处理',
      label: '待审核 Skill 版本',
      value: pendingReviews,
      ...(pendingReviews === null ? unavailable() : { hint: '审核队列里等待决策的版本' }),
      provenance: current('listReviews()', 'status=pending_review'),
      targetPage: 'reviews',
      targetFilter: { status: 'pending_review' },
    },
    {
      id: 'failed-workspaces',
      group: '需要处理',
      label: '失败的工作空间',
      value: failedWorkspaces,
      ...(failedWorkspaces === null ? unavailable() : { hint: '需要重试或回收的环境' }),
      provenance: current('cloudWorkspaces()', 'status=failed'),
      targetPage: 'cloud-ops',
      targetFilter: { status: 'failed' },
    },
    {
      id: 'running-runs',
      group: '正在运行',
      label: '运行中的 Run',
      value: runningRuns,
      ...(runningRuns === null ? unavailable() : { hint: '正在执行、可暂停或接管的运行' }),
      provenance: current('cloudRuns()', 'status=running'),
      targetPage: 'cloud-runs',
      targetFilter: { status: 'running' },
    },
    {
      id: 'unready-profiles',
      group: '资产健康',
      label: '未就绪的 Agent 配置',
      value: unreadyProfiles,
      ...(unreadyProfiles === null ? unavailable() : { hint: '绑定资产不可用或类型降级的配置' }),
      provenance: current('cloudAgentProfiles()', 'readiness=unavailable|degraded'),
      targetPage: 'cloud-profiles',
      targetFilter: { readiness: 'unavailable' },
    },
    {
      id: 'withdrawn-skills',
      group: '资产健康',
      label: '已撤销的 Skill 版本',
      value: withdrawnSkills,
      ...(withdrawnSkills === null ? unavailable() : { hint: '撤销后已安装方需更新' }),
      provenance: current('listSkills()', 'status=withdrawn'),
      targetPage: 'directory',
      targetFilter: { status: 'withdrawn' },
    },
    {
      id: 'denied-authorizations',
      group: '权限异常',
      label: '授权拒绝记录',
      value: deniedAuthorizations,
      ...(deniedAuthorizations === null ? unavailable() : { hint: '被拒绝的授权尝试（含越权与过期会话）' }),
      provenance: current('listAuthorizationAudits()', 'result=failed'),
      targetPage: 'account-audit',
      targetFilter: { status: 'failed' },
    },
    {
      id: 'runs-succeeded',
      group: '近期结果',
      label: '成功的 Run',
      value: succeededRuns,
      ...(succeededRuns === null ? unavailable() : { hint: '所选时间窗内结束且成功' }),
      provenance: scoped('cloudRuns()', 'status=succeeded'),
      targetPage: 'telemetry-events',
      targetFilter: { from: window.from, to: window.to, status: 'succeeded' },
    },
    {
      id: 'runs-failed',
      group: '近期结果',
      label: '失败的 Run',
      value: failedRuns,
      ...(failedRuns === null ? unavailable() : { hint: '所选时间窗内结束且失败' }),
      provenance: scoped('cloudRuns()', 'status=failed'),
      targetPage: 'telemetry-events',
      targetFilter: { from: window.from, to: window.to, status: 'failed' },
    },
  ]
}

/**
 * 把指标按固定分组顺序聚合，空组保留。
 * @param metrics - 指标列表；只要求带 `group` 字段（视图层卡片形状不必等于模型形状）。
 * @returns 分组（顺序即 `WORKBENCH_GROUPS`，`metrics` 里没出现的组值为空数组）。
 */
export function groupWorkbenchMetrics<T extends { readonly group: WorkbenchGroup }>(
  metrics: readonly T[],
): readonly { readonly group: WorkbenchGroup; readonly metrics: readonly T[] }[] {
  return WORKBENCH_GROUPS.map(group => ({ group, metrics: metrics.filter(metric => metric.group === group) }))
}
