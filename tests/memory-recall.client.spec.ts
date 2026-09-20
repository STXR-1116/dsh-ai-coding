import { describe, expect, it } from 'vitest'
import {
  memoryRecallRows,
  memoryRecallVerdict,
  memoryTierLabel,
  recallReasonLabel,
} from '../src/client/memory-recall.ts'
import type { TeamSkillMemoryRecallResponse } from '../src/types.ts'

/**
 * 契约探针：续接 goal §3-3「召回显示召回原因/来源运行/更新时间/置信度」。
 *
 * 异常矩阵：
 * - 缺失：四项来源缺一不可；`sourceRunId` 为空时必须显式 `null`，不得用空串。
 * - 类型错误：词表外的 `recallReason` 原样透出，不套通用标签抹平漂移。
 * - 边界：**只有「服务已答复且无匹配」才是「没有记忆」**；`UNAVAILABLE` 必须呈现为失败，
 *   不得读成「没有相关记忆」。
 * - 并发：无（纯函数）。
 * - 下游失败：`UNAVAILABLE`/`PROJECT_REQUIRED`/`PARTIAL` 各自独立呈现。
 * - 审计：无。
 */

function response(
  status: TeamSkillMemoryRecallResponse['status'],
  items: TeamSkillMemoryRecallResponse['items'],
): TeamSkillMemoryRecallResponse {
  return {
    status,
    items,
    contextText: items.map(item => item.content).join('\n'),
    strategy: 'server',
    effectivePolicy: { topK: 8, relevanceThreshold: 0.4, tokenBudget: 1200 },
  }
}

function item(overrides: Partial<TeamSkillMemoryRecallResponse['items'][number]> = {}) {
  return {
    memoryId: 'm-1',
    content: '稳定错误码必须保留',
    score: 0.9,
    layer: 'L1' as const,
    recallReason: 'CONTENT_MATCH',
    sourceRunId: null,
    updatedAt: '2026-09-15T08:00:00.000Z',
    confidence: 0.6,
    ...overrides,
  }
}

describe('§3-3 召回行', () => {
  it('保持服务端顺序并带出四项来源', () => {
    const rows = memoryRecallRows(
      response('READY', [
        item({ memoryId: 'm-1', recallReason: 'PREFIX_MATCH', sourceRunId: 'run-9', confidence: 0.75 }),
        item({ memoryId: 'm-2', recallReason: 'CONTENT_MATCH' }),
      ]),
    )

    expect(rows.map(row => row.memoryId)).toEqual(['m-1', 'm-2'])
    expect(rows[0]?.reasonLabel).toBe('开头匹配')
    expect(rows[0]?.sourceRunId).toBe('run-9')
    expect(rows[0]?.updatedAt).toBe('2026-09-15T08:00:00.000Z')
    expect(rows[0]?.confidence).toBe('0.75')
    // 非运行来源必须是显式 null，而不是被替换成空串。
    expect(rows[1]?.sourceRunId).toBeNull()
  })

  it('词表外的召回原因原样透出', () => {
    expect(recallReasonLabel('FUTURE_REASON')).toBe('FUTURE_REASON')
  })

  it('治理层级给中文标签，词表外原样透出', () => {
    expect(memoryTierLabel('project_candidate')).toBe('候选')
    expect(memoryTierLabel('project_confirmed')).toBe('已确认')
    expect(memoryTierLabel('team')).toBe('团队')
    // 层级不是存储层 layer：`L1` 不是合法 tier，必须原样透出而不是被映射成标签。
    expect(memoryTierLabel('L1')).toBe('L1')
  })
})

describe('§3-3 召回结论', () => {
  it('服务不可用不得呈现为「没有相关记忆」', () => {
    const verdict = memoryRecallVerdict(response('UNAVAILABLE', []))

    expect(verdict.kind).toBe('unavailable')
    expect(verdict.headline).toContain('暂不可用')
    expect(verdict.detail).toContain('不等于')
  })

  it('服务已答复且无匹配才是没有记忆', () => {
    const verdict = memoryRecallVerdict(response('READY', []))

    expect(verdict.kind).toBe('empty')
    expect(verdict.headline).toContain('没有可召回的记忆')
    expect(verdict.detail).toContain('服务已答复')
  })

  it('命中时给出条数', () => {
    const verdict = memoryRecallVerdict(response('READY', [item(), item({ memoryId: 'm-2' })]))

    expect(verdict.kind).toBe('ready')
    expect(verdict.headline).toContain('2')
    expect(verdict.detail).toBe('')
  })

  it('部分可读标为不完整，且零命中也不说成空结果', () => {
    expect(memoryRecallVerdict(response('PARTIAL', [item()])).kind).toBe('degraded')
    const none = memoryRecallVerdict(response('PARTIAL', []))
    expect(none.kind).toBe('degraded')
    expect(none.headline).toContain('无命中')
    expect(none.detail).toContain('可能不完整')
  })

  it('缺项目上下文是独立状态，不是失败', () => {
    const verdict = memoryRecallVerdict(response('PROJECT_REQUIRED', []))

    expect(verdict.kind).toBe('project-required')
    expect(verdict.headline).toContain('选择项目')
  })
})
