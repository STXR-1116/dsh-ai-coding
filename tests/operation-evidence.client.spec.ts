/* 覆盖补齐：操作证据抽屉纯模型（§11.10）。
 *
 * `nextActionFor` 是一张**冻结的展示契约**——稳定错误码 → 下一步动作，源码注释
 * 明说「出现新码时在此登记，不允许用默认文案吞掉未知码之外的语义」。此前只有
 * 少数几个码被走到，其余码的语义（以及「未知码落到默认文案」这条边界）没有防线。
 */
import { describe, expect, it } from 'vitest'
import { evidenceFromFailure, evidenceFromRun, nextActionFor } from '../src/client/cloud-workspaces/operation-evidence.ts'
import type { RunOperationEvidence, WorkspaceFailure } from '../src/types.ts'

describe('nextActionFor', () => {
  it('maps every registered code to its own next action', () => {
    expect(nextActionFor('FORBIDDEN')).toBe('检查权限或联系管理员')
    expect(nextActionFor('AUTH_REQUIRED')).toBe('检查权限或联系管理员')
    expect(nextActionFor('TOKEN_EXPIRED')).toBe('检查权限或联系管理员')
    expect(nextActionFor('PERMISSION_DENIED')).toBe('检查权限或联系管理员')
    expect(nextActionFor('REVISION_CONFLICT')).toBe('刷新后重试')
    expect(nextActionFor('IDEMPOTENCY_CONFLICT')).toBe('更换幂等键后重试')
    expect(nextActionFor('IDEMPOTENCY_KEY_REQUIRED')).toBe('更换幂等键后重试')
    expect(nextActionFor('WORKSPACE_BUSY')).toBe('等待当前写入运行结束后重试')
    expect(nextActionFor('INVALID_STATUS')).toBe('刷新运行状态后重试')
    expect(nextActionFor('APPROVAL_EXPIRED')).toBe('重新发起运行后再审批')
    expect(nextActionFor('OPERATION_CANCELED')).toBe('重新发起操作')
  })

  it('falls back to a generic retry only for codes that are not registered', () => {
    expect(nextActionFor('SOMETHING_NEW')).toBe('重试或取消运行')
  })
})

describe('evidenceFromRun', () => {
  it('carries the server evidence block through without inventing an HTTP status', () => {
    const evidence: RunOperationEvidence = {
      requestId: 'req-1',
      outcome: 'partial_success',
      reason: '部分资产版本已剔除',
      revision: 9,
      auditId: 'audit-9',
      affected: ['run-1', 'skill:x@1.0.0'],
      nextAction: '检查被剔除的资产版本，运行继续推进',
    }
    expect(evidenceFromRun(evidence)).toEqual({
      outcome: 'partial_success',
      requestId: 'req-1',
      httpStatus: undefined,
      reason: '部分资产版本已剔除',
      revision: 9,
      auditId: 'audit-9',
      affected: ['run-1', 'skill:x@1.0.0'],
      nextAction: '检查被剔除的资产版本，运行继续推进',
    })
  })
})

describe('evidenceFromFailure', () => {
  const failure = (overrides: Partial<WorkspaceFailure> & { code: string }): Omit<WorkspaceFailure, 'status'> =>
    ({ message: '失败', requestId: 'req-1', data: null, ...overrides }) as Omit<WorkspaceFailure, 'status'>

  it('classifies authorization failures as denied — by code or by HTTP status', () => {
    expect(evidenceFromFailure(failure({ code: 'FORBIDDEN' })).outcome).toBe('denied')
    expect(evidenceFromFailure({ ...failure({ code: 'SOMETHING_NEW' }), httpStatus: 401 }).outcome).toBe('denied')
    expect(evidenceFromFailure({ ...failure({ code: 'SOMETHING_NEW' }), httpStatus: 403 }).outcome).toBe('denied')
  })

  it('keeps every other failure as failed and never fabricates audit or affected ids', () => {
    const view = evidenceFromFailure({ ...failure({ code: 'REVISION_CONFLICT', message: '运行 revision 已变化' }), httpStatus: 409 })
    expect(view.outcome).toBe('failed')
    expect(view.httpStatus).toBe(409)
    expect(view.reason).toBe('运行 revision 已变化')
    expect(view.auditId).toBeUndefined()
    expect(view.revision).toBeUndefined()
    expect(view.affected).toEqual([])
    expect(view.nextAction).toBe('刷新后重试')
  })
})
