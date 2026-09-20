import type { TeamSkillMemoryRecallResponse } from '@deepseek-ai/dsh-ai-coding-platform/types'

/** Chinese labels for the recall reasons the service reports. */
const RECALL_REASON_LABELS: Readonly<Record<string, string>> = Object.freeze({
  PROJECT_SCOPE: '项目范围匹配',
  PREFIX_MATCH: '开头匹配',
  CONTENT_MATCH: '正文匹配',
})

/**
 * Label one recall reason for display.
 *
 * An unrecognised reason is shown as-is: a recall reason is evidence, and
 * flattening it into a generic label would hide vocabulary drift rather than
 * surface it.
 * @param reason - reason reported by the service.
 * @returns the Chinese label, or the raw reason when unrecognised.
 */
export function recallReasonLabel(reason: string): string {
  return RECALL_REASON_LABELS[reason] ?? reason
}

/** Chinese labels for the memory governance tiers (§11.16). */
const MEMORY_TIER_LABELS: Readonly<Record<string, string>> = Object.freeze({
  project_candidate: '候选',
  project_confirmed: '已确认',
  team: '团队',
})

/**
 * Label one memory governance tier for display.
 *
 * The tier is not the storage `layer`: `layer` is always `L1` and says nothing to
 * a user, while the tier is the governance state that decides whether the memory
 * may be recalled at all.
 * @param tier - tier reported by the service.
 * @returns the Chinese label, or the raw tier when unrecognised.
 */
export function memoryTierLabel(tier: string): string {
  return MEMORY_TIER_LABELS[tier] ?? tier
}

/** One recalled memory, ready to render. */
export interface MemoryRecallRow {
  /** Opaque memory identity. */
  readonly memoryId: string
  /** Memory body. */
  readonly content: string
  /** Why this memory was recalled. */
  readonly reasonLabel: string
  /** Run that produced it, or `null` for a non-run source. */
  readonly sourceRunId: string | null
  /** Last content update of the memory. */
  readonly updatedAt: string
  /** Server-computed confidence, shown to two decimals. */
  readonly confidence: string
}

/**
 * Project one recall response's items into display rows.
 *
 * The order is the service's order — this never re-ranks, because the score is
 * the server's judgement and re-sorting locally would silently disagree with it.
 * @param response - recall response.
 * @returns one row per recalled memory.
 */
export function memoryRecallRows(response: TeamSkillMemoryRecallResponse): readonly MemoryRecallRow[] {
  return Object.freeze(
    response.items.map(item => ({
      memoryId: item.memoryId,
      content: item.content,
      reasonLabel: recallReasonLabel(item.recallReason),
      sourceRunId: item.sourceRunId,
      updatedAt: item.updatedAt,
      confidence: item.confidence.toFixed(2),
    })),
  )
}

/** Overall reading of one recall, kept distinct from "nothing matched". */
export type MemoryRecallVerdictKind = 'ready' | 'empty' | 'degraded' | 'unavailable' | 'project-required'

/** Headline and explanation for one recall. */
export interface MemoryRecallVerdict {
  /** Stable verdict for rendering and assertions. */
  readonly kind: MemoryRecallVerdictKind
  /** One-line headline. */
  readonly headline: string
  /** Explanation, empty when nothing needs explaining. */
  readonly detail: string
}

/**
 * Summarise one recall without reporting a service failure as an empty result.
 *
 * `empty` means the service answered and nothing matched; `unavailable` means it
 * could not answer at all. Only `empty` may be shown as "no memories"; the other
 * states must say what happened, or a user reads a broken service as a clean
 * result — the same distinction §3-2 requires for knowledge.
 * @param response - recall response.
 * @returns the verdict for this recall.
 */
export function memoryRecallVerdict(response: TeamSkillMemoryRecallResponse): MemoryRecallVerdict {
  const hits = response.items.length
  switch (response.status) {
    case 'UNAVAILABLE':
      return {
        kind: 'unavailable',
        headline: '记忆服务暂不可用，未产生召回',
        detail: '这不等于「没有相关记忆」——本轮没有读到任何记忆。',
      }
    case 'PROJECT_REQUIRED':
      return {
        kind: 'project-required',
        headline: '需要先选择项目才能召回记忆',
        detail: '项目级记忆按项目授权读取。',
      }
    case 'PARTIAL':
      return {
        kind: 'degraded',
        headline: hits === 0 ? '只读到部分记忆，且其中无命中' : `命中 ${hits} 条，但只读到部分记忆`,
        detail: '结果可能不完整。',
      }
    default:
      return hits === 0
        ? { kind: 'empty', headline: '没有可召回的记忆', detail: '服务已答复，本轮确实没有匹配项。' }
        : { kind: 'ready', headline: `命中 ${hits} 条记忆`, detail: '' }
  }
}
