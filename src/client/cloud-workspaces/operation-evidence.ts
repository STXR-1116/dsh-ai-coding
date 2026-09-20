/**
 * 操作证据抽屉的纯模型（蓝图 §2-4，§11.10）：成功、失败、拒绝、部分成功都
 * 归一到同一证据视图——request ID、HTTP 状态、服务端原因、revision、审计 ID、
 * 影响对象与下一步动作。下一步动作由稳定错误码映射，不由文案解析。
 */
import type { RunOperationEvidence, WorkspaceFailure } from '@deepseek-ai/dsh-ai-coding-platform/types'

/** 一次操作的归一结果语义：denied 只用于权限类拒绝，failed 是其余失败。 */
export type OperationOutcome = 'succeeded' | 'partial_success' | 'denied' | 'failed'

/** 证据抽屉的呈现模型。 */
export interface OperationEvidenceView {
  readonly outcome: OperationOutcome
  readonly requestId: string | undefined
  readonly httpStatus: number | undefined
  readonly reason: string
  readonly revision: number | undefined
  readonly auditId: string | undefined
  readonly affected: readonly string[]
  readonly nextAction: string
}

const DENIED_CODES = new Set(['FORBIDDEN', 'AUTH_REQUIRED', 'TOKEN_EXPIRED', 'PERMISSION_DENIED'])

/**
 * 稳定错误码 → 下一步动作。映射是冻结的展示契约：出现新码时在此登记，
 * 不允许用默认文案吞掉未知码之外的语义。
 * @param code - 服务端稳定错误码。
 * @returns 下一步动作文案。
 */
export function nextActionFor(code: string): string {
  if (DENIED_CODES.has(code)) return '检查权限或联系管理员'
  if (code === 'REVISION_CONFLICT') return '刷新后重试'
  if (code === 'IDEMPOTENCY_CONFLICT' || code === 'IDEMPOTENCY_KEY_REQUIRED') return '更换幂等键后重试'
  if (code === 'WORKSPACE_BUSY') return '等待当前写入运行结束后重试'
  if (code === 'INVALID_STATUS') return '刷新运行状态后重试'
  if (code === 'APPROVAL_EXPIRED') return '重新发起运行后再审批'
  if (code === 'OPERATION_CANCELED') return '重新发起操作'
  return '重试或取消运行'
}

/**
 * 把服务端写操作响应携带的证据块归一为抽屉视图。
 * @param evidence - 服务端证据块（§11.10）。
 * @returns 抽屉呈现模型。
 */
export function evidenceFromRun(evidence: RunOperationEvidence): OperationEvidenceView {
  return {
    outcome: evidence.outcome,
    requestId: evidence.requestId,
    httpStatus: undefined,
    reason: evidence.reason,
    revision: evidence.revision,
    auditId: evidence.auditId,
    affected: evidence.affected,
    nextAction: evidence.nextAction,
  }
}

/**
 * 把域失败结果归一为抽屉视图。失败场景的审计 ID 属管理面（§11.10：错误
 * envelope data 为 null），抽屉显示审计行存在但 ID 需后台按 request ID 关联，
 * 不伪造值。
 * @param failure - Host 归一的失败结果（含服务端 request_id 与 HTTP 状态）。
 * @returns 抽屉呈现模型。
 */
export function evidenceFromFailure(failure: Omit<WorkspaceFailure, 'status'> & { readonly httpStatus?: number }): OperationEvidenceView {
  const denied = DENIED_CODES.has(failure.code) || failure.httpStatus === 401 || failure.httpStatus === 403
  return {
    outcome: denied ? 'denied' : 'failed',
    requestId: failure.requestId,
    httpStatus: failure.httpStatus,
    reason: failure.message,
    revision: undefined,
    auditId: undefined,
    affected: [],
    nextAction: nextActionFor(failure.code),
  }
}
