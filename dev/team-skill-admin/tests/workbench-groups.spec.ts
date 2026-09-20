// 4-1「工作台」模型层验收（蓝图 §6.1）。
//
// 异常矩阵：
//   分组   —— 固定五组顺序：需要处理 → 正在运行 → 资产健康 → 权限异常 → 近期结果；
//             空组保留（「本组没有事项」本身是要传达的信息，不是可以删掉的行）。
//   溯源   —— 每个数字必须自带时间范围、过滤条件、数据来源、更新时间，四项都非空。
//   不可用 —— 读取失败的数据源给出 value=null 与原因，**绝不用 0 冒充「零个」**。
//   跳转   —— 每个数字都带目标页面与保留的过滤条件，点击后进入的就是这个视图。
import { describe, expect, it } from 'vitest'
import { WORKBENCH_GROUPS, buildWorkbenchMetrics } from '../src/lib/workbench-groups.ts'

const window = { from: '2026-09-09T00:00:00.000Z', to: '2026-09-16T00:00:00.000Z' }
const updatedAt = '2026-09-16T00:00:05.000Z'

const fullViews = {
  reviews: [{ status: 'pending_review' }, { status: 'approved' }, { status: 'pending_review' }],
  skills: [{ status: 'published' }, { status: 'published' }, { status: 'withdrawn' }],
  workspaces: [{ status: 'ready' }, { status: 'failed' }, { status: 'archived' }],
  runs: [{ status: 'running' }, { status: 'running' }, { status: 'succeeded' }, { status: 'failed' }, { status: 'succeeded' }],
  profiles: [{ readiness: 'ready' }, { readiness: 'unavailable' }],
  authorizationAudits: [{ result: 'succeeded' }, { result: 'failed' }, { result: 'failed' }],
}

describe('4-1 工作台分组与计数', () => {
  it('固定五组顺序，空组保留', () => {
    const metrics = buildWorkbenchMetrics({ window, updatedAt, views: fullViews })
    const groups = [...new Set(metrics.map(metric => metric.group))]
    expect(groups).toEqual([...WORKBENCH_GROUPS].filter(group => groups.includes(group)))
    expect(WORKBENCH_GROUPS).toEqual(['需要处理', '正在运行', '资产健康', '权限异常', '近期结果'])

    const emptyRecovery = buildWorkbenchMetrics({ window, updatedAt, views: { ...fullViews, authorizationAudits: [] } })
    expect(emptyRecovery.filter(metric => metric.group === '权限异常').length).toBeGreaterThan(0)
    expect(emptyRecovery.find(metric => metric.id === 'denied-authorizations')?.value).toBe(0)
  })

  it('计数来自各自的读取，互不串台', () => {
    const metrics = buildWorkbenchMetrics({ window, updatedAt, views: fullViews })
    const valueOf = (id: string): number | null | undefined => metrics.find(metric => metric.id === id)?.value
    expect(valueOf('pending-reviews')).toBe(2)
    expect(valueOf('running-runs')).toBe(2)
    expect(valueOf('unready-profiles')).toBe(1)
    expect(valueOf('withdrawn-skills')).toBe(1)
    expect(valueOf('failed-workspaces')).toBe(1)
    expect(valueOf('denied-authorizations')).toBe(2)
    expect(valueOf('runs-succeeded')).toBe(2)
    expect(valueOf('runs-failed')).toBe(1)
  })

  it('读取不可用时给出 null 与原因，不用 0 冒充零个', () => {
    const metrics = buildWorkbenchMetrics({
      window,
      updatedAt,
      views: { ...fullViews, runs: undefined, authorizationAudits: undefined },
    })
    for (const id of ['running-runs', 'runs-succeeded', 'runs-failed', 'denied-authorizations']) {
      const metric = metrics.find(candidate => candidate.id === id)
      expect(metric?.value, `${id} 读取不可用时不得给出数字`).toBeNull()
      expect(String(metric?.hint)).toContain('读取不可用')
      // 文案要明说拒绝用 0 顶替：读者才不会把「没读到」读成「一个都没有」。
      expect(String(metric?.hint)).toContain('不以 0 代替')
    }
    // 其余数据源照常出数：一次读取失败不污染别的分组。
    expect(metrics.find(metric => metric.id === 'pending-reviews')?.value).toBe(2)
  })

  it('每个数字都带四项溯源，时间范围与过滤条件可核对', () => {
    const metrics = buildWorkbenchMetrics({ window, updatedAt, views: fullViews })
    expect(metrics.length).toBeGreaterThan(0)
    for (const metric of metrics) {
      for (const [field, text] of [
        ['timeRange', metric.provenance.timeRange],
        ['filters', metric.provenance.filters],
        ['source', metric.provenance.source],
        ['updatedAt', metric.provenance.updatedAt],
      ] as const) {
        expect(text.length, `${metric.id} 的 ${field} 不能为空`).toBeGreaterThan(0)
      }
      expect(metric.provenance.updatedAt).toBe(updatedAt)
    }
    // 时间窗指标写明窗口；当前状态指标写明「不随时间窗变化」，不假装自己有时间范围。
    expect(metrics.find(metric => metric.id === 'runs-succeeded')?.provenance.timeRange).toBe(`${window.from} ~ ${window.to}`)
    expect(metrics.find(metric => metric.id === 'pending-reviews')?.provenance.timeRange).toContain('不随时间窗变化')
    expect(metrics.find(metric => metric.id === 'pending-reviews')?.provenance.source).toBe('listReviews()')
    expect(metrics.find(metric => metric.id === 'denied-authorizations')?.provenance.filters).toContain('result=failed')
  })

  it('每个数字都带跳转目标与保留的过滤条件', () => {
    const metrics = buildWorkbenchMetrics({ window, updatedAt, views: fullViews })
    for (const metric of metrics) {
      expect(metric.targetPage, `${metric.id} 必须能进入对应列表`).toBeTruthy()
    }
    expect(metrics.find(metric => metric.id === 'running-runs')?.targetFilter).toMatchObject({ status: 'running' })
    expect(metrics.find(metric => metric.id === 'runs-succeeded')?.targetFilter).toMatchObject({ from: window.from, to: window.to })
    expect(metrics.find(metric => metric.id === 'unready-profiles')?.targetFilter).toMatchObject({ readiness: 'unavailable' })
    expect(metrics.find(metric => metric.id === 'denied-authorizations')?.targetFilter).toMatchObject({ status: 'failed' })
  })
})
