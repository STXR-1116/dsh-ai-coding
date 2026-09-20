// 3-5「运行资产版本快照」模型层验收（蓝图 §4.5，§11.18 A）。
//
// 异常矩阵：
//   两组状态 —— 绑定时刻就绪度与读取时刻状态分别呈现，绝不互相推导：
//               「读取时已撤回、绑定时就绪」必须显示成两件事，并明说本运行不受影响。
//   必需/可选 —— 可选资产绑定时不可用是降级，不阻断运行；必需资产在绑定时不可用
//               是异常，如实指出而不是粉饰成正常。
//   词表外   —— 未识别的就绪度/状态原样透出，不映射成默认值。
//   治理     —— 治理行给出时间、操作者、动作与资产版本（跨模块可追）。
import { describe, expect, it } from 'vitest'
import {
  ASSET_CURRENT_STATE_LABELS,
  BINDING_READINESS_LABELS,
  assetDriftLabel,
  assetGovernanceLabel,
  runAssetRows,
  runAssetSnapshotDrifted,
} from '../src/client/cloud-workspaces/run-asset-snapshot.ts'

const entry = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  assetType: 'skill',
  assetId: 'skill:code-review',
  assetVersionId: 'skill:code-review@1.0.0',
  name: '代码评审 Skill',
  required: true,
  order: 1,
  readinessAtBinding: 'ready',
  unavailableReasonAtBinding: null,
  currentState: 'bound',
  withdrawnAt: null,
  withdrawalAuditId: null,
  ...overrides,
})

const snapshot = (assets: readonly Record<string, unknown>[], governance: readonly Record<string, unknown>[] = []): never => ({
  runId: 'run-1',
  capturedAt: '2026-09-10T00:00:00.000Z',
  runRevision: 4,
  assets,
  governance,
}) as never

describe('3-5 运行资产快照的两组状态互不推导（§11.18 A）', () => {
  it('读取时已撤回、绑定时仍就绪：两个事实分别呈现，并说明本运行不受影响', () => {
    const rows = runAssetRows(snapshot([entry({
      currentState: 'withdrawn',
      withdrawnAt: '2026-09-11T00:00:00.000Z',
      withdrawalAuditId: 'audit-1',
    })]))
    expect(rows).toHaveLength(1)
    expect(rows[0]?.bindingLabel).toBe('绑定时就绪')
    expect(rows[0]?.currentLabel).toBe('当前已撤回')
    expect(String(rows[0]?.driftLabel)).toContain('本运行不受影响')
  })

  it('绑定之后从目录消失同样说明后果，而不是把绑定事实改写成「不可用」', () => {
    const rows = runAssetRows(snapshot([entry({ currentState: 'missing' })]))
    expect(rows[0]?.bindingLabel).toBe('绑定时就绪')
    expect(rows[0]?.currentLabel).toBe('当前不在服务目录')
    expect(String(rows[0]?.driftLabel)).toContain('本运行不受影响')
  })

  it('两组状态一致时没有 drift：不给稳定状态加噪声', () => {
    const rows = runAssetRows(snapshot([entry()]))
    expect(rows[0]?.driftLabel).toBeUndefined()
    expect(runAssetSnapshotDrifted(snapshot([entry()]))).toBe(false)
    expect(runAssetSnapshotDrifted(snapshot([entry({ currentState: 'withdrawn' })]))).toBe(true)
  })

  it('可选资产绑定即不可用是降级（带服务端原因）；必需资产绑定即不可用是异常', () => {
    expect(assetDriftLabel(entry({ readinessAtBinding: 'unavailable', required: false, unavailableReasonAtBinding: '版本已废弃' }) as never))
      .toBe('绑定时即不可用（可选资产，不阻断运行）：版本已废弃')
    expect(assetDriftLabel(entry({ readinessAtBinding: 'unavailable', required: true }) as never))
      .toContain('不应启动')
  })

  it('词表外的就绪度/状态原样透出，不映射成默认值', () => {
    const rows = runAssetRows(snapshot([entry({ readinessAtBinding: 'quarantined', currentState: 'frozen' })]))
    expect(rows[0]?.bindingLabel).toBe('绑定时：quarantined')
    expect(rows[0]?.currentLabel).toBe('当前：frozen')
    // 已知词表仍然有中文标签（防止把整张表写坏）。
    expect(BINDING_READINESS_LABELS['ready']).toBe('绑定时就绪')
    expect(ASSET_CURRENT_STATE_LABELS['bound']).toBe('当前可用')
  })

  it('治理行带时间、操作者、动作与资产版本：跨模块可追', () => {
    const rows = runAssetRows(snapshot([entry()], []))
    expect(rows[0]?.requiredLabel).toBe('必需')
    expect(assetGovernanceLabel({
      auditId: 'audit-1',
      action: 'asset.version.withdraw',
      actorName: '平台管理员',
      at: '2026-09-11T00:00:00.000Z',
      assetVersionId: 'skill:code-review@1.0.0',
    })).toBe('2026-09-11T00:00:00.000Z · 平台管理员 · asset.version.withdraw · skill:code-review@1.0.0')
  })
})
