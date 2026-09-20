import { afterEach, describe, expect, it } from 'vitest'
import { cleanup } from '@testing-library/react'
import { buildAssetSelectorRows, dryRunChecksView, planProfileEdit } from '../src/client/cloud-workspaces/agent-config-editor.ts'

// 2-6「Agent 配置」编辑流纯模型验收（蓝图 §2-6，§11.12）。
//
// 异常矩阵：
//   编辑规划 —— published → 自动建草稿；draft → 直接编辑；archived → 阻断并
//              给出原因；不出现第四种模式。
//   选择器   —— 统一行含名称/版本/用途/授权/readiness/更新时间/来源；
//              未授权或未就绪不可选且给出原因。
//   试运行   —— checks 逐条呈现；存在 fail → blocked；否则 ready；
//              结果文本映射为中文标签，不得只靠颜色表达。

afterEach(() => {
  cleanup()
})

describe('2-6 编辑流规划', () => {
  it('published → 自动建草稿；draft → 直接编辑；archived → 阻断', () => {
    expect(planProfileEdit('published')).toEqual({ mode: 'new-draft' })
    expect(planProfileEdit('draft')).toEqual({ mode: 'edit-direct' })
    const blocked = planProfileEdit('archived')
    expect(blocked.mode).toBe('blocked')
    expect(String(blocked.reason).length).toBeGreaterThan(0)
  })
})

describe('2-6 资产选择器统一行', () => {
  const candidates = [
    { assetId: 'skill:code-review@1.0.0', assetType: 'skill', version: '1.0.0', name: '代码评审 Skill', authorized: true, readiness: 'ready', invalidReason: null, updatedAt: '2026-09-01T00:00:00Z', purpose: '对变更执行代码评审', source: 'team' },
    { assetId: 'skill:code-review@0.9.0', assetType: 'skill', version: '0.9.0', name: '代码评审 Skill（旧版）', authorized: true, readiness: 'unavailable', invalidReason: '版本已废弃', updatedAt: '2026-08-01T00:00:00Z', purpose: '对变更执行代码评审', source: 'team' },
    { assetId: 'knowledge:k-3', assetType: 'knowledge', version: 'v1', name: '知识库 k-3', authorized: false, readiness: 'unavailable', invalidReason: '资产未授权给该项目', updatedAt: '2026-07-01T00:00:00Z', purpose: '检索旧版文档', source: 'organization' },
  ] as const

  it('每行携带名称/版本/用途/授权/readiness/更新时间/来源七要素', () => {
    const rows = buildAssetSelectorRows(candidates)
    expect(rows.length).toBe(3)
    for (const row of rows) {
      expect(row.name.length).toBeGreaterThan(0)
      expect(row.version.length).toBeGreaterThan(0)
      expect(row.purpose.length).toBeGreaterThan(0)
      expect(typeof row.authorized).toBe('boolean')
      expect(typeof row.updatedAt).toBe('string')
      expect(['builtin', 'team', 'organization']).toContain(row.source)
    }
  })

  it('未授权或未就绪不可选，原因来自服务端', () => {
    const rows = buildAssetSelectorRows(candidates)
    expect(rows[0]?.selectable).toBe(true)
    expect(rows[1]?.selectable).toBe(false)
    expect(rows[1]?.unavailableReason).toBe('版本已废弃')
    expect(rows[2]?.selectable).toBe(false)
    expect(rows[2]?.unavailableReason).toBe('资产未授权给该项目')
  })
})

describe('2-6 配置试运行呈现', () => {
  it('存在 fail → blocked；全过 → ready；结果带中文标签', () => {
    const blocked = dryRunChecksView({
      outcome: 'blocked',
      checks: [
        { check: 'asset_authorized', result: 'fail', detail: '未授权资产：knowledge:k-3' },
        { check: 'version_state', result: 'warn', detail: '草稿版本' },
        { check: 'context_assembly', result: 'pass', detail: 'Skill 1 层' },
      ],
    })
    expect(blocked.outcomeLabel).toBe('阻断')
    expect(blocked.rows.length).toBe(3)
    expect(blocked.rows[0]?.resultLabel).toBe('阻断项')
    expect(blocked.rows[1]?.resultLabel).toBe('警告')

    const ready = dryRunChecksView({
      outcome: 'ready',
      checks: [
        { check: 'asset_authorized', result: 'pass', detail: '全部已授权' },
        { check: 'version_state', result: 'warn', detail: '草稿版本' },
      ],
    })
    expect(ready.outcomeLabel).toBe('就绪')
    expect(ready.rows.every(row => row.resultLabel.length > 0)).toBe(true)
  })

  it('词表外的检查项与结果原样透出并标注未知，不丢弃也不改写成通过', () => {
    const view = dryRunChecksView({
      outcome: 'ready',
      checks: [{ check: 'future_check', result: 'degraded', detail: '未来检查项' }] as never,
    })

    expect(view.rows[0]?.checkLabel).toBe('future_check（未知检查项）')
    expect(view.rows[0]?.resultLabel).toBe('degraded（未知结果）')
    // 原始值保持不变，渲染层才能用稳定属性表达「不认识」。
    expect(view.rows[0]?.check).toBe('future_check')
    expect(view.rows[0]?.result).toBe('degraded')
  })
})
