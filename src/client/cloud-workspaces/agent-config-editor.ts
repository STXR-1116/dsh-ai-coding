/**
 * Agent 配置编辑流的纯模型（蓝图 §2-6，§11.12）：编辑规划（已发布自动建
 * 草稿）、资产选择器统一行与试运行结果呈现。全部由服务端数据派生，不推断。
 */
import type { AssetCandidate, ProfileDryRun } from '@deepseek-ai/dsh-ai-coding-platform/types'

/**
 * 编辑规划：已发布 → 先建草稿再编辑；draft → 直接编辑；archived → 阻断。
 * @param latestStatus - 配置最新版本状态。
 * @returns 编辑模式；阻断时携带原因。
 */
export function planProfileEdit(latestStatus: 'draft' | 'published' | 'archived'): { readonly mode: 'new-draft' | 'edit-direct' | 'blocked'; readonly reason?: string } {
  if (latestStatus === 'published') return { mode: 'new-draft' }
  if (latestStatus === 'draft') return { mode: 'edit-direct' }
  return { mode: 'blocked', reason: '已归档版本不可编辑；请从已发布版本重新发起' }
}

/** 资产选择器的统一行：七要素齐备，未授权/未就绪不可选并保留服务端原因。 */
export interface AssetSelectorRow {
  readonly assetId: string
  readonly name: string
  readonly version: string
  readonly purpose: string
  readonly authorized: boolean
  readonly readiness: 'ready' | 'unavailable'
  readonly updatedAt: string
  readonly source: 'builtin' | 'team' | 'organization'
  readonly selectable: boolean
  readonly unavailableReason: string | null
}

/**
 * 把资产候选映射为选择器行。
 * @param candidates - 服务端资产候选（§11.12 字段集）。
 * @returns 统一行，顺序保持服务端顺序。
 */
export function buildAssetSelectorRows(candidates: readonly AssetCandidate[]): readonly AssetSelectorRow[] {
  return candidates.map(candidate => ({
    assetId: candidate.assetId,
    name: candidate.name,
    version: candidate.version,
    purpose: candidate.purpose,
    authorized: candidate.authorized,
    readiness: candidate.readiness,
    updatedAt: candidate.updatedAt,
    source: candidate.source,
    selectable: candidate.authorized && candidate.readiness === 'ready',
    unavailableReason: candidate.invalidReason,
  }))
}

const CHECK_LABELS: Record<string, string> = {
  asset_authorized: '绑定资产授权',
  asset_ready: '绑定资产就绪',
  version_state: '版本状态',
  context_assembly: '上下文装配',
}

const RESULT_LABELS: Record<string, string> = {
  pass: '通过',
  warn: '警告',
  fail: '阻断项',
}

/** 试运行结果的呈现模型。 */
export interface DryRunChecksView {
  readonly outcomeLabel: string
  readonly rows: readonly {
    readonly check: string
    readonly checkLabel: string
    readonly result: string
    readonly resultLabel: string
    readonly detail: string
  }[]
}

/**
 * 把试运行检查归一为呈现行；未知 check/result 保留原始值并标注，不丢弃。
 * @param result - 服务端试运行结果。
 * @returns 呈现模型。
 */
export function dryRunChecksView(
  result: Pick<ProfileDryRun, 'outcome' | 'checks'>,
): DryRunChecksView {
  return {
    outcomeLabel: result.outcome === 'ready' ? '就绪' : '阻断',
    rows: result.checks.map(check => ({
      check: check.check,
      checkLabel: CHECK_LABELS[check.check] ?? `${check.check}（未知检查项）`,
      result: check.result,
      resultLabel: RESULT_LABELS[check.result] ?? `${check.result}（未知结果）`,
      detail: check.detail,
    })),
  }
}
