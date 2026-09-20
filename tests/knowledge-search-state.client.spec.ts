import { describe, expect, it } from 'vitest'
import {
  knowledgeBaseSearchStates,
  knowledgeSearchVerdict,
  knowledgeSelectorGroups,
  knowledgeSelectorTotals,
  knowledgeSkipReasonLabel,
  type KnowledgeSkipReason,
} from '../src/client/knowledge-search-state.ts'
import type {
  TeamSkillKnowledgeBaseSummary,
  TeamSkillKnowledgeSearchResponse,
  TeamSkillKnowledgeSearchStatus,
} from '../src/types.ts'

/**
 * 契约探针：续接 goal §3-2（知识库）。
 *
 * 异常矩阵：
 * - 缺失：被跳过的知识库必须仍然出现在参与列表里；缺失会让读者以为「没有选中」。
 * - 类型错误：`reason` 词表外的取值原样透出，不得套用通用「不可用」把漂移抹平。
 * - 边界：**只有「全部参与且全部无命中」才允许呈现为无结果**；「全部跳过」必须呈现为
 *   失败，「部分跳过」必须呈现为不完整——这正是「不得把失败转成暂无结果」的判据。
 * - 并发：无（纯函数）。
 * - 下游失败：processing/unavailable/forbidden/not_found/timeout/external_error 六种
 *   跳过原因必须各自可读。
 * - 审计：无。
 */

function status(
  knowledgeBaseId: string,
  state: TeamSkillKnowledgeSearchStatus['status'],
  reason?: KnowledgeSkipReason | null,
): TeamSkillKnowledgeSearchStatus {
  return { knowledgeBaseId, status: state, reason: reason ?? null }
}

function search(
  knowledgeBases: readonly TeamSkillKnowledgeSearchStatus[],
  hits: number,
): TeamSkillKnowledgeSearchResponse {
  return {
    requestId: 'req-1',
    results: Array.from({ length: hits }, (_, index) => ({
      knowledgeBaseId: 'kb-1',
      knowledgeId: `k-${String(index)}`,
      title: `标题 ${String(index)}`,
      snippet: '片段',
      score: 0.9,
      sourceUrl: 'https://docs.example.test/a',
      version: 'v1',
      updatedAt: '2026-09-15T08:00:00.000Z',
    })),
    knowledgeBases,
  }
}

describe('§3-2 检索结论', () => {
  it('全部知识库都被跳过时是失败，不是无结果', () => {
    const verdict = knowledgeSearchVerdict(search([status('kb-1', 'skipped', 'forbidden')], 0))

    expect(verdict.kind).toBe('failed')
    expect(verdict.headline).toContain('没有知识库可用')
    expect(verdict.headline).not.toContain('无命中')
    expect(verdict.detail).toContain('无权访问')
  })

  it('部分跳过且零命中是不完整，并说明未参与的来源无法证明内容不存在', () => {
    const verdict = knowledgeSearchVerdict(
      search([status('kb-1', 'no_hits'), status('kb-2', 'skipped', 'processing')], 0),
    )

    expect(verdict.kind).toBe('degraded')
    expect(verdict.detail).toContain('索引更新中')
    expect(verdict.detail).toContain('无法证明其内容不存在')
  })

  it('全部参与且全部无命中才是无结果', () => {
    const verdict = knowledgeSearchVerdict(search([status('kb-1', 'no_hits'), status('kb-2', 'no_hits')], 0))

    expect(verdict.kind).toBe('no_hits')
    expect(verdict.headline).toContain('均无命中')
    expect(verdict.detail).toContain('确实没有')
  })

  it('有命中且全部参与是正常结果', () => {
    const verdict = knowledgeSearchVerdict(search([status('kb-1', 'used')], 3))

    expect(verdict.kind).toBe('ok')
    expect(verdict.headline).toContain('3')
    expect(verdict.detail).toBe('')
  })

  it('有命中但有知识库未参与时标注结果可能不完整', () => {
    const verdict = knowledgeSearchVerdict(search([status('kb-1', 'used'), status('kb-2', 'skipped', 'timeout')], 2))

    expect(verdict.kind).toBe('degraded')
    expect(verdict.detail).toContain('检索超时')
    expect(verdict.detail).toContain('可能不完整')
  })

  it('同因多库只列一次原因', () => {
    const verdict = knowledgeSearchVerdict(
      search([status('kb-1', 'skipped', 'not_found'), status('kb-2', 'skipped', 'not_found')], 0),
    )

    expect(verdict.detail).toBe('原因：来源已消失。')
  })
})

describe('§3-2 跳过原因与参与列表', () => {
  it('六种原因各自可读', () => {
    expect(knowledgeSkipReasonLabel('processing')).toBe('索引更新中')
    expect(knowledgeSkipReasonLabel('unavailable')).toBe('依赖不可用')
    expect(knowledgeSkipReasonLabel('forbidden')).toBe('无权访问')
    expect(knowledgeSkipReasonLabel('not_found')).toBe('来源已消失')
    expect(knowledgeSkipReasonLabel('timeout')).toBe('检索超时')
    expect(knowledgeSkipReasonLabel('external_error')).toBe('外部服务错误')
  })

  it('词表外的原因原样透出，缺原因时明说未说明', () => {
    expect(knowledgeSkipReasonLabel('future_reason' as never)).toBe('future_reason')
    expect(knowledgeSkipReasonLabel(null)).toBe('未说明原因')
    expect(knowledgeSkipReasonLabel(undefined)).toBe('未说明原因')
  })

  it('每个知识库恰好一行且顺序保持，跳过项带原因标签', () => {
    const rows = knowledgeBaseSearchStates(
      search([status('kb-2', 'used'), status('kb-1', 'skipped', 'forbidden'), status('kb-3', 'no_hits')], 1),
    )

    expect(rows.map(row => row.knowledgeBaseId)).toEqual(['kb-2', 'kb-1', 'kb-3'])
    expect(rows.map(row => row.outcome)).toEqual(['used', 'skipped', 'no_hits'])
    expect(rows[0]?.reason).toBe('')
    expect(rows[1]?.reason).toBe('无权访问')
    expect(rows[1]?.label).toBe('未参与检索')
    expect(rows[2]?.label).toBe('无命中')
  })
})

describe('§3-2 分组选择器', () => {
  function base(
    knowledgeBaseId: string,
    type: TeamSkillKnowledgeBaseSummary['type'],
    overrides: Partial<TeamSkillKnowledgeBaseSummary> = {},
  ): TeamSkillKnowledgeBaseSummary {
    return {
      knowledgeBaseId,
      name: `库 ${knowledgeBaseId}`,
      description: '说明',
      type,
      state: 'active',
      searchable: true,
      updatedAt: '2026-09-16T00:00:00.000Z',
      revision: 3,
      ...overrides,
    }
  }

  it('按文档/FAQ/Wiki 固定顺序分组，空组省略', () => {
    const groups = knowledgeSelectorGroups(
      [base('kb-w', 'wiki'), base('kb-d', 'document'), base('kb-d2', 'document')],
      new Set(),
    )

    expect(groups.map(group => group.key)).toEqual(['document', 'wiki'])
    expect(groups.map(group => group.label)).toEqual(['文档', 'Wiki'])
    expect(groups[0]?.rows.map(row => row.knowledgeBaseId)).toEqual(['kb-d', 'kb-d2'])
  })

  it('不可检索的条目仍留在组内并带原因，且不计入启用数', () => {
    const groups = knowledgeSelectorGroups(
      [base('kb-1', 'document', { searchable: false }), base('kb-2', 'document')],
      new Set(['kb-1', 'kb-2']),
    )

    const rows = groups[0]?.rows ?? []
    expect(rows).toHaveLength(2)
    expect(rows[0]?.searchable).toBe(false)
    expect(rows[0]?.disabledReason).toBe('服务端标记为不可检索')
    expect(rows[0]?.enabled).toBe(false)
    expect(rows[1]?.enabled).toBe(true)
    expect(groups[0]?.enabledCount).toBe(1)
    expect(groups[0]?.unavailableCount).toBe(1)
  })

  it('已选但不可检索计入 staleSelection，不被静默剔除', () => {
    const groups = knowledgeSelectorGroups(
      [base('kb-1', 'document', { searchable: false }), base('kb-2', 'faq')],
      new Set(['kb-1', 'kb-2']),
    )

    const totals = knowledgeSelectorTotals(groups)
    expect(totals.total).toBe(2)
    expect(totals.enabled).toBe(1)
    expect(totals.unavailable).toBe(1)
    expect(totals.staleSelection).toBe(1)
  })

  it('索引状态给中文标签并保留原值；更新时间随行带出', () => {
    const groups = knowledgeSelectorGroups(
      [
        base('kb-1', 'document', { state: 'deleting', updatedAt: '2026-09-15T12:00:00.000Z' }),
        base('kb-2', 'document', { state: 'unavailable' }),
      ],
      new Set(),
    )

    const rows = groups[0]?.rows ?? []
    expect(rows[0]?.indexState).toBe('删除中')
    expect(rows[0]?.indexStateRaw).toBe('deleting')
    expect(rows[0]?.updatedAt).toBe('2026-09-15T12:00:00.000Z')
    expect(rows[1]?.indexState).toBe('不可用')
  })

  it('无知识库时返回空分组', () => {
    expect(knowledgeSelectorGroups([], new Set())).toEqual([])
    expect(knowledgeSelectorTotals([])).toEqual({ total: 0, enabled: 0, unavailable: 0, staleSelection: 0 })
  })

  it('索引状态词表外的取值原样透出并保留原始值，不套用通用标签', () => {
    const groups = knowledgeSelectorGroups(
      [base('kb-1', 'document', { state: 'reindexing' as never })],
      new Set(),
    )

    const rows = groups[0]?.rows ?? []
    expect(rows[0]?.indexState).toBe('reindexing')
    expect(rows[0]?.indexStateRaw).toBe('reindexing')
  })
})
