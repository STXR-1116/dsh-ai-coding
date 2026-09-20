/**
 * Agent 配置版本历史比较的纯模型（蓝图 §6.5 Agent 与资产治理，§11.4）。
 * 版本 diff 同时比较五个维度：模型、工具（tool_allowlist）、资产版本
 * （Skill/知识/记忆绑定引用）、权限策略（permission_mode/write_mode）与
 * 提示规则（reasoning）。维度差异逐行保留，相同维度不产生行。
 */
import type { CloudAgentProfileVersion } from './team-skill-types'

/** 一个维度上的差异行。 */
export interface ProfileVersionDiffRow {
  readonly dimension: string
  readonly baseVersion: string
  readonly targetVersion: string
  readonly baseValue: string
  readonly targetValue: string
}

const SUMMARY_DIMENSIONS: readonly { readonly dimension: string; readonly pick: (version: CloudAgentProfileVersion) => string }[] = [
  { dimension: '模型', pick: version => version.model },
  { dimension: '提示规则', pick: version => version.reasoning },
]

const POLICY_KEYS: readonly { readonly dimension: string; readonly key: string }[] = [
  { dimension: '权限策略 · permission_mode', key: 'permission_mode' },
  { dimension: '权限策略 · write_mode', key: 'write_mode' },
]

function assetReferenceList(version: CloudAgentProfileVersion): string[] {
  return [
    ...version.asset_bindings.skills.map(entry => `skill:${entry.asset_version_id}`),
    ...version.asset_bindings.knowledge_bases.map(entry => `knowledge:${entry.asset_version_id}`),
    ...(version.asset_bindings.memory === null ? [] : [`memory:${version.asset_bindings.memory.asset_version_id}`]),
  ]
}

function toolAllowlist(version: CloudAgentProfileVersion): string[] {
  const raw = version.execution_policy['tool_allowlist']
  return Array.isArray(raw) ? raw.map(entry => String(entry)) : []
}

function stringify(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value)
}

/**
 * 比较两个版本的五个维度；差异行按维度固定顺序输出，相同维度不产生行。
 * @param base - 基线版本。
 * @param target - 目标版本。
 * @returns 差异行列表（空数组 = 两版本在这些维度上一致）。
 */
export function diffProfileVersions(base: CloudAgentProfileVersion, target: CloudAgentProfileVersion): readonly ProfileVersionDiffRow[] {
  const rows: ProfileVersionDiffRow[] = []
  for (const { dimension, pick } of SUMMARY_DIMENSIONS) {
    if (pick(base) !== pick(target)) {
      rows.push({ dimension, baseVersion: base.version, targetVersion: target.version, baseValue: pick(base), targetValue: pick(target) })
    }
  }
  const baseTools = toolAllowlist(base)
  const targetTools = toolAllowlist(target)
  if (stringify(baseTools) !== stringify(targetTools)) {
    rows.push({
      dimension: '工具',
      baseVersion: base.version,
      targetVersion: target.version,
      baseValue: baseTools.join('、'),
      targetValue: targetTools.join('、'),
    })
  }
  for (const { dimension, key } of POLICY_KEYS) {
    const baseValue = base.execution_policy[key]
    const targetValue = target.execution_policy[key]
    if (stringify(baseValue) !== stringify(targetValue)) {
      rows.push({ dimension, baseVersion: base.version, targetVersion: target.version, baseValue: stringify(baseValue), targetValue: stringify(targetValue) })
    }
  }
  const baseAssets = assetReferenceList(base)
  const targetAssets = assetReferenceList(target)
  if (stringify(baseAssets) !== stringify(targetAssets)) {
    const added = targetAssets.filter(entry => !baseAssets.includes(entry))
    const removed = baseAssets.filter(entry => !targetAssets.includes(entry))
    rows.push({
      dimension: '资产版本',
      baseVersion: base.version,
      targetVersion: target.version,
      baseValue: baseAssets.join('、'),
      targetValue: targetAssets.join('、'),
    })
    if (added.length > 0) {
      rows.push({ dimension: '资产版本 · 新增', baseVersion: base.version, targetVersion: target.version, baseValue: '', targetValue: added.join('、') })
    }
    if (removed.length > 0) {
      rows.push({ dimension: '资产版本 · 移除', baseVersion: base.version, targetVersion: target.version, baseValue: removed.join('、'), targetValue: '' })
    }
  }
  return rows
}
