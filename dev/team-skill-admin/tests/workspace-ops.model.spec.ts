import { describe, expect, it } from 'vitest'
import { LONG_PREPARING_MS, classifyAbnormalWorkspaces } from '../src/lib/workspace-ops.ts'

// 4-6「云工作空间运维」异常分类模型层验收（蓝图 §6.6）。
//
// 异常矩阵：
//   长时间 preparing —— status=preparing 且持续毫秒 > 阈值 → 异常；阈值内 → 正常。
//   事件流 stale     —— eventStale=true → 异常，携带最后事件 id。
//   检查点不可恢复   —— 非 preparing/paused 状态下有未消费检查点 → 异常。
//   正常             —— ready 无异常 → 空行。
//   优先级           —— 同一工作空间最多一条（ preparing > stale > checkpoint）。

describe('4-6 异常工作空间分类', () => {
  it('长时间 preparing 超阈值 → 异常；阈值内 → 正常', () => {
    const abnormal = classifyAbnormalWorkspaces([
      { workspaceId: 'ws-1', displayName: '慢', status: 'preparing', preparingMs: LONG_PREPARING_MS + 1 },
    ])
    expect(abnormal.length).toBe(1)
    expect(abnormal[0]?.category).toBe('长时间 preparing')
    const normal = classifyAbnormalWorkspaces([
      { workspaceId: 'ws-2', displayName: '快', status: 'preparing', preparingMs: 1000 },
    ])
    expect(normal.length).toBe(0)
  })

  it('事件流 stale → 异常且携带最后事件 id', () => {
    const rows = classifyAbnormalWorkspaces([
      { workspaceId: 'ws-3', displayName: '断流', status: 'running', eventStale: true, lastEventId: 'evt-42' },
    ])
    expect(rows.length).toBe(1)
    expect(rows[0]?.category).toBe('事件流 stale')
    expect(rows[0]?.detail).toContain('evt-42')
  })

  it('检查点不可恢复：非 preparing/paused 状态下未消费检查点 → 异常', () => {
    const rows = classifyAbnormalWorkspaces([
      { workspaceId: 'ws-4', displayName: '孤儿检查点', status: 'running', hasCheckpoint: true, checkpointConsumed: false },
    ])
    expect(rows.length).toBe(1)
    expect(rows[0]?.category).toBe('检查点不可恢复')
    // paused 是合法的持有检查点状态，不算异常
    const paused = classifyAbnormalWorkspaces([
      { workspaceId: 'ws-5', displayName: '已暂停', status: 'paused', hasCheckpoint: true, checkpointConsumed: false },
    ])
    expect(paused.length).toBe(0)
  })

  it('ready 且无 stale 无孤儿检查点 → 空', () => {
    const rows = classifyAbnormalWorkspaces([
      { workspaceId: 'ws-6', displayName: '健康', status: 'ready' },
    ])
    expect(rows.length).toBe(0)
  })
})
