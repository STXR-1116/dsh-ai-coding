// 2-5「运行脉搏与时间旅行」模型层验收（蓝图 §2-5，§11.11）。
//
// 异常矩阵：
//   合成   —— 服务端脉搏条目 + 客户端观测的事件流重联合并为一条时间线，
//             按 at 升序稳定排序；reconnect 条目携带 attempt。
//   未知   —— 未知 kind 显式呈现为 unknown 条目，不得丢弃、不得吞成其他类型。
//   降级   —— 单次渲染条目有上限（RUN_PULSE_RENDER_LIMIT）：超出部分计入
//             hiddenCount，按需加载，不静默截断。
//   点击   —— checkpoint 条目携带 checkpointId 供「当时视图」打开；其余条目
//             不携带打开目标。
import { describe, expect, it } from 'vitest'
import { RUN_PULSE_RENDER_LIMIT, buildRunPulse } from '../src/client/cloud-workspaces/run-pulse.ts'

const serverEntry = (overrides: Record<string, unknown>): Record<string, unknown> => ({
  kind: 'status', at: '2026-09-16T00:00:00Z', revision: 1, trace_id: 't1',
  summary: 'running：开始执行', status: 'running', reason: '开始执行', operator: 'system', policy_version: 'apv-1',
  ...overrides,
})

describe('2-5 运行脉搏合成', () => {
  it('服务端条目与客户端重联合并、按 at 升序稳定排序', () => {
    const { items, hiddenCount } = buildRunPulse({
      entries: [
        serverEntry({ at: '2026-09-16T00:02:00Z' }),
        { kind: 'checkpoint', at: '2026-09-16T00:01:00Z', revision: 2, traceId: 't1', summary: 'cp-1', checkpointId: 'cp-1', consumed: false },
      ] as never,
      reconnects: [{ at: '2026-09-16T00:03:00Z', attempt: 1 }],
    })
    expect(hiddenCount).toBe(0)
    expect(items.map(item => item.at)).toEqual(['2026-09-16T00:01:00Z', '2026-09-16T00:02:00Z', '2026-09-16T00:03:00Z'])
    const reconnect = items[2]
    expect(reconnect?.kind).toBe('reconnect')
    expect(reconnect?.summary).toContain('1')
  })

  it('未知 kind 显式呈现为 unknown，不丢弃', () => {
    const { items } = buildRunPulse({
      entries: [{ kind: 'mystery', at: '2026-09-16T00:00:00Z', revision: 1, trace_id: 't1', summary: '未知事件' } as never],
      reconnects: [],
    })
    expect(items.length).toBe(1)
    expect(items[0]?.kind).toBe('unknown')
    expect(items[0]?.summary).toBe('未知事件')
  })

  it('checkpoint 条目携带 checkpointId，其余条目无打开目标', () => {
    const { items } = buildRunPulse({
      entries: [
        serverEntry({}),
        { kind: 'checkpoint', at: '2026-09-16T00:05:00Z', revision: 3, traceId: 't1', summary: 'cp-2', checkpointId: 'cp-2', consumed: true },
      ] as never,
      reconnects: [],
    })
    const checkpoint = items.find(item => item.kind === 'checkpoint')
    expect(checkpoint?.checkpointId).toBe('cp-2')
    expect(checkpoint?.consumed).toBe(true)
    const status = items.find(item => item.kind === 'status')
    expect(status?.checkpointId).toBeUndefined()
    expect(status?.kind).toBe('status')
  })

  it('超过渲染上限时截断并计数，按需加载', () => {
    const entries = Array.from({ length: RUN_PULSE_RENDER_LIMIT + 7 }, (_, index) => (
      serverEntry({ at: new Date(Date.UTC(2026, 8, 16, 0, index)).toISOString(), summary: `e${index}` })
    ))
    const { items, hiddenCount } = buildRunPulse({ entries: entries as never, reconnects: [] })
    expect(items.length).toBe(RUN_PULSE_RENDER_LIMIT)
    expect(hiddenCount).toBe(7)
  })

  it('approval 与 test 条目各带专属 detail：操作者与失败计数不得省略', () => {
    const { items } = buildRunPulse({
      entries: [
        { kind: 'approval', at: '2026-09-16T00:00:00Z', revision: 1, traceId: 't1', summary: '已批准', operator: '管理员' },
        { kind: 'test', at: '2026-09-16T00:01:00Z', revision: 2, traceId: 't1', summary: '测试完成', passed: 3, total: 4, failed: 1 },
        { kind: 'test', at: '2026-09-16T00:02:00Z', revision: 3, traceId: 't1', summary: '全部通过', passed: 4, total: 4, failed: 0 },
      ] as never,
      reconnects: [],
    })

    expect(items.find(item => item.kind === 'approval')?.detail).toBe('管理员')
    const tests = items.filter(item => item.kind === 'test')
    // 有失败必须写出失败数；没有失败时不得补一个「失败 0」的噪声。
    expect(tests[0]?.detail).toBe('3/4 通过，失败 1')
    expect(tests[1]?.detail).toBe('4/4 通过')
  })

  it('未知条目的字段类型不符时以空值呈现，不抛错也不推断语义', () => {
    const { items } = buildRunPulse({
      entries: [{ kind: 'mystery', at: 7, revision: 'r1', summary: null } as never],
      reconnects: [],
    })

    expect(items).toHaveLength(1)
    expect(items[0]?.kind).toBe('unknown')
    // 类型不符一律回落空值：summary 不得被 String() 强转成 "null"。
    expect(items[0]?.at).toBe('')
    expect(items[0]?.revision).toBeUndefined()
    expect(items[0]?.summary).toBe('')
  })
})
