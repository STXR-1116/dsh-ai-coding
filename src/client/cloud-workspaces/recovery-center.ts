import type { AgentRunSnapshot, WorkspaceChanges, WorkspaceStreamState } from '@deepseek-ai/dsh-ai-coding-platform/types'

/**
 * 恢复中心（蓝图 §5.2/§8.3，仅记录与呈现）：把失败运行、挂起审批（paused）、
 * 事件流 stale、索引延迟与未同步变更集中为可操作的恢复条目。每条目归入四类
 * 动作之一：安全重试 / 需要决策 / 需要管理员 / 不可恢复，并携带证据明细。
 */
/** 恢复动作四分类：安全重试 / 需要决策 / 需要管理员 / 不可恢复。 */
export type RecoveryAction = 'safe-retry' | 'needs-decision' | 'needs-admin' | 'unrecoverable'

/** 恢复条目来源类别：失败运行 / 挂起审批 / 事件流 stale / 索引延迟 / 未同步变更。 */
export type RecoveryItemKind =
  | 'failed_run'
  | 'pending_approval'
  | 'stream_stale'
  | 'index_delay'
  | 'unsynced_changes'

/** 一条恢复条目：分类动作 + 原因 + 证据明细 + 关联运行。 */
export interface RecoveryItem {
  readonly kind: RecoveryItemKind
  readonly action: RecoveryAction
  readonly title: string
  /** 原因：为什么进入恢复中心。 */
  readonly reason: string
  /** 证据明细：错误码 / revision / 文件数等可核对内容。 */
  readonly evidence: string
  /** 关联运行（failed_run / pending_approval 时存在），供跳转时间线等明细。 */
  readonly runId?: string
}

/** 权限/授权类错误：需要管理员处理，不是调用方可以安全重试的失败。 */
const ADMIN_ERROR_CODES: readonly string[] = ['AUTH_REQUIRED', 'UNAUTHORIZED', 'FORBIDDEN', 'TOKEN_EXPIRED', 'PERMISSION_DENIED']

/**
 * 从运行、未同步变更、事件流状态与索引延迟标记构建恢复条目。
 * @param input - Host 已解析的运行快照、变更集、事件流状态与索引延迟标记。
 * @returns 按来源类别固定顺序排列的恢复条目（无条目为空数组，不伪造内容）。
 */
export function buildRecoveryCenter(input: {
  readonly runs: readonly AgentRunSnapshot[]
  readonly changes?: WorkspaceChanges | undefined
  readonly streamState?: WorkspaceStreamState | undefined
  readonly indexDelay?: boolean | undefined
}): readonly RecoveryItem[] {
  const items: RecoveryItem[] = []

  // 失败运行：授权类 → 需要管理员；其余（含超时/无码瞬态）→ 安全重试。
  for (const run of input.runs) {
    if (run.status !== 'failed') continue
    const code = run.errorCode ?? ''
    if (ADMIN_ERROR_CODES.includes(code)) {
      items.push({
        kind: 'failed_run',
        action: 'needs-admin',
        title: `失败运行 ${run.runId}`,
        reason: `授权/权限类失败（${code}），需要管理员核查凭据与授权`,
        evidence: `error_code=${code} · rev ${run.revision}`,
        runId: run.runId,
      })
      continue
    }
    items.push({
      kind: 'failed_run',
      action: 'safe-retry',
      title: `失败运行 ${run.runId}`,
      reason: code.length > 0 ? `运行失败（${code}），可安全重试` : '运行失败，可安全重试',
      evidence: `error_code=${code || '无'} · rev ${run.revision}`,
      runId: run.runId,
    })
  }

  // 挂起审批（paused）：恢复方式是显式的用户决策（继续或重放）。
  for (const run of input.runs) {
    if (run.status !== 'paused') continue
    items.push({
      kind: 'pending_approval',
      action: 'needs-decision',
      title: `已暂停运行 ${run.runId}`,
      reason: '运行已暂停并保存检查点，需要用户选择继续或重放',
      evidence: `rev ${run.revision}`,
      runId: run.runId,
    })
  }

  // 事件流 stale：快照不可信，重连/重同步是安全操作。
  if (input.streamState?.status === 'stale') {
    items.push({
      kind: 'stream_stale',
      action: 'safe-retry',
      title: '事件流已 stale',
      reason: '重放窗口失效，需要重新读取授权快照并重同步',
      evidence: 'stream=stale',
    })
  }

  // 索引延迟：知识/记忆任务的异步索引尚未完成（数据源在对应模块接入）。
  if (input.indexDelay === true) {
    items.push({
      kind: 'index_delay',
      action: 'safe-retry',
      title: '索引延迟',
      reason: '知识/记忆索引任务尚未完成，可安全重试索引任务',
      evidence: 'index=pending',
    })
  }

  // 未同步变更：提交或丢弃是用户的决策，不是可自动重试的操作。
  const files = input.changes?.files ?? []
  if (files.length > 0) {
    items.push({
      kind: 'unsynced_changes',
      action: 'needs-decision',
      title: `未同步变更 ${files.length} 个文件`,
      reason: '工作区存在未提交变更，需要用户决定提交或丢弃',
      evidence: `baseline ${String(input.changes?.baselineRevision)} → rev ${String(input.changes?.revision)} · ${files.length} 个文件`,
    })
  }
  return items
}
