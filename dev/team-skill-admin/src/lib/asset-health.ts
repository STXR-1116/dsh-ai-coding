/**
 * 资产健康表（蓝图 §6.5）：把 Skill / 知识库 / 记忆库三类异构来源归一成
 * 同一套健康行——名称、类型、版本、授权状态、readiness、原因——供治理页
 * 复用；无授权或未就绪即 unhealthy，原因保留服务端原文。
 */

/** 三类资产的统一健康行。 */
export interface AssetHealthRow {
  readonly assetId: string
  readonly assetType: 'skill' | 'knowledge' | 'memory'
  readonly name: string
  readonly version: string
  readonly authorized: boolean
  readonly readiness: 'ready' | 'unavailable'
  readonly reason: string | null
  readonly healthy: boolean
}

/** 共享健康表的类别固定顺序。 */
const TYPE_ORDER: Record<AssetHealthRow['assetType'], number> = { skill: 0, knowledge: 1, memory: 2 }

function healthyOf(authorized: boolean, readiness: 'ready' | 'unavailable'): boolean {
  return authorized && readiness === 'ready'
}

/** 归一前的行输入（三类来源同形）。 */
export interface AssetHealthInput {
  readonly assetId: string
  readonly name: string
  readonly version: string
  readonly authorized: boolean
  readonly readiness: 'ready' | 'unavailable'
  readonly reason: string | null
}

/**
 * 把一类资产的行归一为健康行。
 * @param assetType - 资产类别（Skill/知识/记忆）。
 * @param rows - 服务端行。
 * @returns 健康行。
 */
export function assetHealthRows(assetType: AssetHealthRow['assetType'], rows: readonly AssetHealthInput[]): readonly AssetHealthRow[] {
  return rows.map(row => ({
    ...row,
    assetType,
    healthy: healthyOf(row.authorized, row.readiness),
  }))
}

/**
 * 合并三类健康行并按固定类别顺序（Skill → 知识 → 记忆）与名称排序。
 * @param sections - 三类健康行。
 * @returns 合并后的统一健康表。
 */
export function mergeAssetHealth(sections: {
  readonly skills: readonly AssetHealthRow[]
  readonly knowledge: readonly AssetHealthRow[]
  readonly memory: readonly AssetHealthRow[]
}): readonly AssetHealthRow[] {
  return [...sections.skills, ...sections.knowledge, ...sections.memory].sort((left, right) => {
    const byType = TYPE_ORDER[left.assetType] - TYPE_ORDER[right.assetType]
    return byType !== 0 ? byType : left.name.localeCompare(right.name)
  })
}
