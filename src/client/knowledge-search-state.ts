import type {
  TeamSkillKnowledgeBaseSummary,
  TeamSkillKnowledgeSearchResponse,
  TeamSkillKnowledgeSearchStatus,
} from '../types.ts'

/** Reasons a selected knowledge base did not take part in one search (§3-2). */
export type KnowledgeSkipReason = NonNullable<TeamSkillKnowledgeSearchStatus['reason']>

/**
 * User-facing label for each reason a knowledge base was skipped.
 *
 * Keyed by `string` on purpose: the lookup must stay able to miss, so an
 * unrecognised reason falls through to the raw value instead of being typed as
 * unreachable and smeared into a generic label.
 */
const SKIP_REASON_LABELS: Readonly<Record<string, string>> = Object.freeze({
  processing: '索引更新中',
  unavailable: '依赖不可用',
  forbidden: '无权访问',
  not_found: '来源已消失',
  timeout: '检索超时',
  external_error: '外部服务错误',
})

/**
 * Label one skip reason for display.
 *
 * An unrecognised reason is shown as-is rather than mapped to a generic
 * "不可用": the operator needs to see vocabulary drift, not a smeared value.
 * @param reason - Skip reason reported by the service, when it supplied one.
 * @returns the Chinese label, the raw reason, or a note that none was given.
 */
export function knowledgeSkipReasonLabel(reason: KnowledgeSkipReason | null | undefined): string {
  if (reason === null || reason === undefined) return '未说明原因'
  return SKIP_REASON_LABELS[reason] ?? reason
}

/** One knowledge base's participation in a search, ready to render. */
export interface KnowledgeBaseSearchState {
  /** Opaque knowledge-base identity. */
  readonly knowledgeBaseId: string
  /** Chinese state label. */
  readonly label: string
  /** Stable outcome for rendering and assertions. */
  readonly outcome: 'used' | 'no_hits' | 'skipped'
  /** Skip reason label, empty when the base was used. */
  readonly reason: string
}

/**
 * Project every selected knowledge base's participation into a display row.
 *
 * Every base in the response appears exactly once: a base that was skipped is
 * never dropped from the list, because a missing row would read as "not
 * selected" rather than "did not run".
 * @param search - Service search response.
 * @returns one row per selected knowledge base, in the service's order.
 */
export function knowledgeBaseSearchStates(
  search: TeamSkillKnowledgeSearchResponse,
): readonly KnowledgeBaseSearchState[] {
  return Object.freeze(
    search.knowledgeBases.map(item => ({
      knowledgeBaseId: item.knowledgeBaseId,
      label: item.status === 'used' ? '已参与检索' : item.status === 'no_hits' ? '无命中' : '未参与检索',
      outcome: item.status,
      reason: item.status === 'skipped' ? knowledgeSkipReasonLabel(item.reason) : '',
    })),
  )
}

/** Overall reading of one search, kept distinct from "no results". */
export type KnowledgeSearchVerdictKind = 'ok' | 'no_hits' | 'degraded' | 'failed'

/** Headline and explanation for one search. */
export interface KnowledgeSearchVerdict {
  /** Stable verdict for rendering and assertions. */
  readonly kind: KnowledgeSearchVerdictKind
  /** One-line headline. */
  readonly headline: string
  /** Explanation, empty when nothing needs explaining. */
  readonly detail: string
}

/**
 * Summarise one search without ever reporting a failure as an empty result.
 *
 * The four outcomes are distinct on purpose: `no_hits` means every selected base
 * answered and found nothing, while `failed` means no base could answer at all
 * and `degraded` means some answered and some did not. Only `no_hits` may be
 * presented as "no results"; the other two must say what went wrong (§3-2).
 * @param search - Service search response.
 * @returns the verdict for this search.
 */
export function knowledgeSearchVerdict(search: TeamSkillKnowledgeSearchResponse): KnowledgeSearchVerdict {
  const skipped = search.knowledgeBases.filter(item => item.status === 'skipped')
  const answered = search.knowledgeBases.filter(item => item.status !== 'skipped')
  const hits = search.results.length
  const reasons = [...new Set(skipped.map(item => knowledgeSkipReasonLabel(item.reason)))].join('、')

  if (skipped.length > 0 && answered.length === 0) {
    return {
      kind: 'failed',
      headline: '本轮没有知识库可用，未产生引用',
      // 每个跳过项都带一个非空原因标签（词表外的取值原样透出，缺原因时为「未说明原因」），
      // 所以走到这里时 reasons 一定非空。
      detail: `原因：${reasons}。`,
    }
  }
  if (hits === 0 && skipped.length > 0) {
    return {
      kind: 'degraded',
      headline: `已检索的知识库无命中，另有 ${skipped.length} 个未能参与`,
      detail: `原因：${reasons}。未参与的来源无法证明其内容不存在。`,
    }
  }
  if (hits === 0) {
    return {
      kind: 'no_hits',
      headline: '已检索的知识库均无命中',
      detail: '所有选中的知识库都已检索，本轮确实没有可引用的片段。',
    }
  }
  if (skipped.length > 0) {
    return {
      kind: 'degraded',
      headline: `命中 ${hits} 条，但有 ${skipped.length} 个知识库未能参与`,
      detail: `原因：${reasons}。结果可能不完整。`,
    }
  }
  return { kind: 'ok', headline: `命中 ${hits} 条引用`, detail: '' }
}

/** Chinese labels for the lifecycle state of one knowledge base. */
const INDEX_STATE_LABELS: Readonly<Record<string, string>> = Object.freeze({
  active: '已就绪',
  unavailable: '不可用',
  deleting: '删除中',
})

/** Chinese labels for the knowledge-base grouping, in display order. */
const TYPE_LABELS: Readonly<Record<string, string>> = Object.freeze({
  document: '文档',
  faq: 'FAQ',
  wiki: 'Wiki',
})

/** One knowledge base as the grouped selector presents it (§3-2). */
export interface KnowledgeSelectorRow {
  /** Opaque knowledge-base identity. */
  readonly knowledgeBaseId: string
  /** Human-facing name. */
  readonly name: string
  /** Server-provided description. */
  readonly description: string
  /** Chinese document/FAQ/Wiki label. */
  readonly typeLabel: string
  /** Chinese lifecycle label; the raw value when unrecognised. */
  readonly indexState: string
  /** Raw lifecycle state, for stable rendering attributes. */
  readonly indexStateRaw: string
  /** Server-reported update time. */
  readonly updatedAt: string
  /** Whether the server permits searching this base. */
  readonly searchable: boolean
  /** Whether the user currently has it selected. */
  readonly selected: boolean
  /** Selected and searchable; only this counts toward the enabled count. */
  readonly enabled: boolean
  /** Why it cannot be enabled; empty when it can. */
  readonly disabledReason: string
}

/** One document/FAQ/Wiki group in the selector. */
export interface KnowledgeSelectorGroup {
  /** Group key (the knowledge-base type). */
  readonly key: string
  /** Chinese group label. */
  readonly label: string
  /** Rows in the group, in service order. */
  readonly rows: readonly KnowledgeSelectorRow[]
  /** Rows that count as enabled. */
  readonly enabledCount: number
  /** Rows that cannot be enabled. */
  readonly unavailableCount: number
}

/** Totals across every selector group. */
export interface KnowledgeSelectorTotals {
  /** Every listed base. */
  readonly total: number
  /** Bases that are selected and searchable. */
  readonly enabled: number
  /** Bases the server marks unsearchable. */
  readonly unavailable: number
  /**
   * Bases that are selected but not searchable. A non-zero value means the
   * selection no longer matches what the service permits and must be surfaced,
   * never silently pruned.
   */
  readonly staleSelection: number
}

/**
 * Group the project's knowledge bases for the selector.
 *
 * Only `document`, `faq` and `wiki` groups appear, in that fixed order, and
 * empty groups are omitted. A base the server marks unsearchable stays in its
 * group with a reason rather than being hidden: dropping it would make the
 * project look smaller than it is, and the user could not tell why a base they
 * used before is gone.
 * @param bases - Authorized knowledge-base summaries for the current project.
 * @param selectedIds - Opaque ids the user has selected.
 * @returns groups in fixed order.
 */
export function knowledgeSelectorGroups(
  bases: readonly TeamSkillKnowledgeBaseSummary[],
  selectedIds: ReadonlySet<string>,
): readonly KnowledgeSelectorGroup[] {
  return Object.freeze(
    Object.entries(TYPE_LABELS)
      .map(([type, typeLabel]) => {
        const rows = bases
          .filter(base => base.type === type)
          .map((base) => {
            const selected = selectedIds.has(base.knowledgeBaseId)
            const enabled = selected && base.searchable
            return {
              knowledgeBaseId: base.knowledgeBaseId,
              name: base.name,
              description: base.description,
              // 分组键来自词表本身，所以组内每行的 type 必然命中同一个标签。
              typeLabel,
              indexState: INDEX_STATE_LABELS[base.state] ?? base.state,
              indexStateRaw: base.state,
              updatedAt: base.updatedAt,
              searchable: base.searchable,
              selected,
              enabled,
              disabledReason: base.searchable ? '' : '服务端标记为不可检索',
            } satisfies KnowledgeSelectorRow
          })
        return {
          key: type,
          label: typeLabel,
          rows: Object.freeze(rows),
          enabledCount: rows.filter(row => row.enabled).length,
          unavailableCount: rows.filter(row => !row.searchable).length,
        } satisfies KnowledgeSelectorGroup
      })
      .filter(group => group.rows.length > 0),
  )
}

/**
 * Count the selector's enabled, unavailable and stale selections.
 *
 * `staleSelection` exists so a selection the service no longer permits is
 * reported instead of quietly disappearing from the enabled count.
 * @param groups - Groups produced by {@link knowledgeSelectorGroups}.
 * @returns totals across all groups.
 */
export function knowledgeSelectorTotals(
  groups: readonly KnowledgeSelectorGroup[],
): KnowledgeSelectorTotals {
  const rows = groups.flatMap(group => group.rows)
  return Object.freeze({
    total: rows.length,
    enabled: rows.filter(row => row.enabled).length,
    unavailable: rows.filter(row => !row.searchable).length,
    staleSelection: rows.filter(row => row.selected && !row.searchable).length,
  })
}
