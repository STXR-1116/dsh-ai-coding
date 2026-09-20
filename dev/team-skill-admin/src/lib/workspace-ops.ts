/**
 * 云工作空间运维的异常分类（蓝图 §6.6）：只呈现数据源里可观察的事实——
 * 长时间 preparing、事件流 stale、非活跃状态下的检查点不可恢复。每个异常行
 * 携带证据（状态、时长或原因），不推断服务端内部状态。
 */

/** 一条异常工作空间行。 */
export interface AbnormalWorkspaceRow {
  readonly workspaceId: string
  readonly displayName: string
  readonly category: '长时间 preparing' | '事件流 stale' | '检查点不可恢复'
  readonly detail: string
}

/** 异常分类的输入：只读工作空间快照与运行聚合。 */
export interface AbnormalWorkspaceInput {
  readonly workspaceId: string
  readonly displayName: string
  readonly status: string
  /** preparing 状态持续毫秒数（由 updated_at 与当前时间差计算，调用方传入）。 */
  readonly preparingMs?: number | undefined
  readonly lastEventId?: string | undefined
  readonly eventStale?: boolean | undefined
  readonly hasCheckpoint?: boolean | undefined
  readonly checkpointConsumed?: boolean | undefined
}

/** preparing 的异常阈值（毫秒）；可观测阈值，不是部署调优项。 */
export const LONG_PREPARING_MS = 10 * 60 * 1000

/**
 * 分类异常工作空间。
 * @param inputs - 工作空间快照与可观察状态。
 * @returns 异常行（每个工作空间最多一条，优先级：preparing > stale > checkpoint）。
 */
export function classifyAbnormalWorkspaces(inputs: readonly AbnormalWorkspaceInput[]): readonly AbnormalWorkspaceRow[] {
  return inputs.flatMap((input): AbnormalWorkspaceRow[] => {
    const rows: AbnormalWorkspaceRow[] = []
    if (input.status === 'preparing' && (input.preparingMs ?? 0) > LONG_PREPARING_MS) {
      const minutes = Math.round((input.preparingMs ?? 0) / 60000)
      rows.push({
        workspaceId: input.workspaceId,
        displayName: input.displayName,
        category: '长时间 preparing',
        detail: `已持续 ${minutes} 分钟未完成准备`,
      })
    }
    if (input.eventStale === true) {
      rows.push({
        workspaceId: input.workspaceId,
        displayName: input.displayName,
        category: '事件流 stale',
        detail: `事件流进入 stale（最后事件 ${input.lastEventId ?? '—'}）`,
      })
    }
    if (input.status !== 'preparing' && input.hasCheckpoint === true && input.checkpointConsumed === false && input.status !== 'paused') {
      rows.push({
        workspaceId: input.workspaceId,
        displayName: input.displayName,
        category: '检查点不可恢复',
        detail: `状态 ${input.status} 下存在未消费检查点，无法恢复`,
      })
    }
    return rows
  })
}
