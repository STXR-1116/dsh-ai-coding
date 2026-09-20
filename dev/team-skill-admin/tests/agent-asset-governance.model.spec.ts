import { describe, expect, it } from 'vitest'
import { assetHealthRows, mergeAssetHealth } from '../src/lib/asset-health.ts'
import { diffProfileVersions } from '../src/lib/profile-version-diff.ts'
import type { CloudAgentProfileVersion } from '../src/lib/team-skill-types.ts'

// 4-5「Agent 与资产治理」模型层验收（蓝图 §6.5）。
//
// 异常矩阵：
//   版本 diff —— 五维度（模型/提示规则/工具/权限策略/资产版本）逐维比较；
//               相同维度不产生行；资产增删单独成行；权限策略按键拆分。
//   健康表    —— 三类异构来源归一为统一行（名称/类型/版本/授权/readiness/
//               原因/healthy）；类别固定顺序 Skill→知识→记忆；healthy 由
//               授权 && readiness 派生。

const version = (overrides: Partial<CloudAgentProfileVersion>): CloudAgentProfileVersion => ({
  agent_profile_version_id: 'v', version: 'v1', status: 'draft',
  model: 'deepseek-v3.2', reasoning: 'medium',
  asset_bindings: { skills: [], knowledge_bases: [], memory: null },
  asset_version_ids: [],
  execution_policy: { permission_mode: 'approval', write_mode: 'write', tool_allowlist: ['read', 'write'] },
  type_extension_config: {},
  credential_ref: null,
  change_summary: '',
  ...overrides,
})

describe('4-5 版本 diff', () => {
  it('五维度一致 → 空差异', () => {
    const a = version({})
    const b = version({ version: 'v2' })
    expect(diffProfileVersions(a, b)).toEqual([])
  })

  it('模型/提示规则/权限策略/工具差异逐行呈现', () => {
    const a = version({})
    const b = version({
      version: 'v2',
      model: 'deepseek-v4',
      reasoning: 'high',
      execution_policy: { permission_mode: 'auto', write_mode: 'read_only', tool_allowlist: ['read'] },
    })
    const rows = diffProfileVersions(a, b)
    const dimensions = rows.map(row => row.dimension)
    expect(dimensions).toContain('模型')
    expect(dimensions).toContain('提示规则')
    expect(dimensions).toContain('权限策略 · permission_mode')
    expect(dimensions).toContain('权限策略 · write_mode')
    expect(dimensions).toContain('工具')
    const tools = rows.find(row => row.dimension === '工具')
    expect(tools?.baseValue).toContain('write')
    expect(tools?.targetValue).toBe('read')
  })

  it('资产版本差异：新增与移除单独成行', () => {
    const a = version({
      asset_bindings: { skills: [{ asset_version_id: 'sv-1', required: true }], knowledge_bases: [], memory: null },
      asset_version_ids: ['sv-1'],
    })
    const b = version({
      asset_bindings: { skills: [], knowledge_bases: [{ asset_version_id: 'k-1', required: true }], memory: null },
    })
    const rows = diffProfileVersions(a, b)
    const dimensions = rows.map(row => row.dimension)
    expect(dimensions).toContain('资产版本 · 新增')
    expect(dimensions).toContain('资产版本 · 移除')
    const added = rows.find(row => row.dimension === '资产版本 · 新增')
    expect(added?.targetValue).toContain('k-1')
  })
})

describe('4-5 资产健康表', () => {
  it('三类来源归一为统一行，healthy = 授权 && ready', () => {
    const rows = mergeAssetHealth({
      skills: assetHealthRows('skill', [
        { assetId: 'sk-1', name: '代码评审', version: '1.0.0', authorized: true, readiness: 'ready', reason: null },
        { assetId: 'sk-2', name: '旧版评审', version: '0.9.0', authorized: true, readiness: 'unavailable', reason: '版本已废弃' },
      ]),
      knowledge: assetHealthRows('knowledge', [
        { assetId: 'k-1', name: '平台架构', version: 'v1', authorized: false, readiness: 'unavailable', reason: '未授权' },
      ]),
      memory: assetHealthRows('memory', [
        { assetId: 'm-1', name: '协作偏好', version: 'v1', authorized: true, readiness: 'ready', reason: null },
      ]),
    })
    expect(rows.length).toBe(4)
    // 类别固定顺序：skill → knowledge → memory
    expect(rows[0]?.assetType).toBe('skill')
    expect(rows[2]?.assetType).toBe('knowledge')
    expect(rows[3]?.assetType).toBe('memory')
    const oldSkill = rows.find(row => row.assetId === 'sk-2')
    expect(oldSkill?.healthy).toBe(false)
    expect(oldSkill?.reason).toBe('版本已废弃')
    const healthyRow = rows.find(row => row.assetId === 'sk-1')
    expect(healthyRow?.healthy).toBe(true)
  })
})
