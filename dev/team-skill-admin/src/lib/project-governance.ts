/**
 * 项目治理的纯模型（蓝图 §6.4 项目管理）：
 * - 归档项目只读：写按钮禁用并给出固定原因；
 * - 归档前依赖摘要：工作空间 / Agent 配置绑定 / 成员 / 资产关联四类依赖，
 *   任一依赖存在即构成不可逆影响提示；数据源读取失败以 null 呈现（不用 0）；
 * - 安全与运行摘要：运行计数（total/running/succeeded/failed）与授权拒绝数，
 *   数据源读取失败以 null + 「读取不可用」呈现。
 */

export interface DependencyCountRows {
  readonly workspaces?: readonly unknown[] | undefined
  readonly profiles?: readonly unknown[] | undefined
  readonly members?: readonly unknown[] | undefined
  readonly assets?: readonly unknown[] | undefined
}

/** 归档只读的固定原因文案。 */
export const ARCHIVED_READONLY_REASON = '项目已归档：详情只读，保存与生命周期写操作已禁用；如需变更请先恢复项目。'

/** 归档是否只读。 */
export function isArchivedReadonly(status: string): boolean {
  return status === 'archived'
}

/** 依赖摘要的一行。 */
export interface DependencyRow {
  readonly label: string
  readonly count: number | null
}

/** 归档前的依赖摘要。 */
export interface DependencySummary {
  readonly rows: readonly DependencyRow[]
  readonly irreversible: boolean
  readonly message: string
}

/**
 * 组装归档前的依赖摘要：四类依赖逐行计数；读取不可用的来源计 null 并说明。
 * @param rows - 四类依赖的读取结果（undefined = 本次读取不可用）。
 * @returns 依赖摘要与不可逆影响提示。
 */
export function buildDependencySummary(rows: DependencyCountRows): DependencySummary {
  const entries: readonly { readonly label: string; readonly rows: readonly unknown[] | undefined }[] = [
    { label: '工作空间', rows: rows.workspaces },
    { label: 'Agent 配置绑定', rows: rows.profiles },
    { label: '成员', rows: rows.members },
    { label: '资产关联', rows: rows.assets },
  ]
  const summaryRows = entries.map(({ label, rows: source }) => ({
    label,
    count: source === undefined ? null : source.length,
  }))
  const known = summaryRows.filter(row => row.count !== null)
  const hasDependencies = known.some(row => (row.count ?? 0) > 0)
  const unavailable = summaryRows.filter(row => row.count === null).map(row => row.label)
  const message = hasDependencies
    ? `存在依赖（${known.filter(row => (row.count ?? 0) > 0).map(row => `${row.label} ${row.count}`).join('、')}），归档后这些关联转为只读且不可逆。`
    : `已确认的四类依赖均为 0${unavailable.length > 0 ? `（${unavailable.join('、')}本次读取不可用，未计入）` : ''}。归档后项目转为只读，该操作不可逆。`
  return { rows: summaryRows, irreversible: true, message }
}

/** 安全与运行摘要。 */
export interface SecurityRunSummary {
  readonly runsTotal: number | null
  readonly runsRunning: number | null
  readonly runsSucceeded: number | null
  readonly runsFailed: number | null
  readonly authorizationDenied: number | null
  readonly unavailable: readonly string[]
}

/**
 * 组装安全与运行摘要：运行四项计数 + 授权拒绝数；读取不可用为 null 并列出来源名。
 * @param input - 运行列表与授权审计列表（undefined = 读取不可用）。
 * @returns 摘要。
 */
export function buildSecurityRunSummary(input: {
  readonly runs?: readonly { readonly status: string }[] | undefined
  readonly authorizationAudits?: readonly { readonly result: string }[] | undefined
}): SecurityRunSummary {
  const runs = input.runs
  const audits = input.authorizationAudits
  return {
    runsTotal: runs === undefined ? null : runs.length,
    runsRunning: runs === undefined ? null : runs.filter(row => row.status === 'running').length,
    runsSucceeded: runs === undefined ? null : runs.filter(row => row.status === 'succeeded').length,
    runsFailed: runs === undefined ? null : runs.filter(row => row.status === 'failed').length,
    authorizationDenied: audits === undefined ? null : audits.filter(row => row.result === 'failed').length,
    unavailable: [
      ...(runs === undefined ? ['运行列表'] : []),
      ...(audits === undefined ? ['授权审计'] : []),
    ],
  }
}
