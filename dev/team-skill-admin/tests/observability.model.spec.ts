import { describe, expect, it } from 'vitest'
import { buildObservabilityLayers, generateChangeProposals } from '../src/lib/observability.ts'

// 4-8「可观测」模型层验收（蓝图 §6.8）。
//
// 异常矩阵：
//   四层   —— 运行健康/交付质量/资产质量/权限安全固定顺序，各层状态由
//             数据源派生（healthy/degraded/critical）。
//   变更草案 —— 层状态为 degraded 或 critical 时生成变更草案；healthy 时
//             不生成。每条草案包含证据窗口/置信度/影响范围/建议动作/撤销方式。
//   只读   —— 变更草案不能自动修改生产配置（requiresApproval 恒为 true）。

const healthyInput = {
  runs: [{ status: 'succeeded' }, { status: 'succeeded' }],
  telemetryDelivery: { accepted: 100, retryable: 0, rejected: 0, gaps: 0 },
  assetHealth: [{ assetType: 'skill', healthy: true, reason: null }],
  authorizationDenied: 0,
}

describe('4-8 可观测四层', () => {
  it('健康输入：四层全 healthy，无变更草案', () => {
    const layers = buildObservabilityLayers(healthyInput)
    expect(layers.length).toBe(4)
    expect(layers.map(l => l.layer)).toEqual(['运行健康', '交付质量', '资产质量', '权限安全'])
    expect(layers.every(l => l.status === 'healthy')).toBe(true)
    expect(generateChangeProposals(layers)).toEqual([])
  })

  it('运行失败超阈值 → 运行健康 degraded + 变更草案', () => {
    const input = {
      ...healthyInput,
      runs: Array.from({ length: 5 }, (_, i) => ({ status: i === 0 ? 'failed' : 'succeeded' })),
    }
    const layers = buildObservabilityLayers(input)
    const runHealth = layers.find(l => l.layer === '运行健康')
    expect(runHealth?.status).toBe('degraded')
    expect(runHealth?.issues.length).toBeGreaterThan(0)
    const proposals = generateChangeProposals(layers)
    expect(proposals.some(p => p.title.includes('运行健康'))).toBe(true)
    for (const p of proposals) {
      expect(p.requiresApproval).toBe(true)
      expect(p.suggestedAction.length).toBeGreaterThan(0)
      expect(p.undoMethod.length).toBeGreaterThan(0)
    }
  })

  it('资产不健康 → 资产质量 degraded + 变更草案', () => {
    const input = {
      ...healthyInput,
      assetHealth: [
        { assetType: 'skill', healthy: false, reason: '版本已废弃' },
        { assetType: 'knowledge', healthy: true, reason: null },
      ],
    }
    const layers = buildObservabilityLayers(input)
    const assetQuality = layers.find(l => l.layer === '资产质量')
    expect(assetQuality?.status).toBe('degraded')
    expect(assetQuality?.issues.length).toBeGreaterThan(0)
  })

  it('授权拒绝 > 5 → 权限安全 critical', () => {
    const input = { ...healthyInput, authorizationDenied: 8 }
    const layers = buildObservabilityLayers(input)
    const perm = layers.find(l => l.layer === '权限安全')
    expect(perm?.status).toBe('critical')
  })
})
