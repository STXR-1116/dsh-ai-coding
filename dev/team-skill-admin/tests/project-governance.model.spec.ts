import { describe, expect, it } from 'vitest'
import {
  ARCHIVED_READONLY_REASON,
  buildDependencySummary,
  buildSecurityRunSummary,
  isArchivedReadonly,
} from '../src/lib/project-governance.ts'

// 4-4「项目管理」模型层验收（蓝图 §6.4）。
//
// 异常矩阵：
//   归档只读 —— archived → 只读成立并携带固定原因；active/draft → 不只读。
//   依赖     —— 四类依赖逐行计数；存在依赖 → 不可逆提示列出「类别 数量」；
//               读取不可用的来源计 null 且在提示中注明未计入；四类全 0 →
//               仍提示「归档不可逆」（不省略警告）。
//   摘要     —— 运行四项计数与授权拒绝数各自来自各自读取；读取不可用 →
//               null + unavailable 列出来源名，绝不用 0 冒充。

describe('4-4 归档只读', () => {
  it('archived 只读并带原因；active 不只读', () => {
    expect(isArchivedReadonly('archived')).toBe(true)
    expect(isArchivedReadonly('active')).toBe(false)
    expect(ARCHIVED_READONLY_REASON).toContain('只读')
    expect(ARCHIVED_READONLY_REASON).toContain('禁用')
  })
})

describe('4-4 归档前依赖摘要', () => {
  it('存在依赖：逐行计数并在不可逆提示中列出类别与数量', () => {
    const summary = buildDependencySummary({
      workspaces: [{}, {}],
      profiles: [{}],
      members: [{}, {}, {}],
      assets: [],
    })
    const valueOf = (label: string): number | null | undefined => summary.rows.find(row => row.label === label)?.count
    expect(valueOf('工作空间')).toBe(2)
    expect(valueOf('Agent 配置绑定')).toBe(1)
    expect(valueOf('成员')).toBe(3)
    expect(valueOf('资产关联')).toBe(0)
    expect(summary.irreversible).toBe(true)
    expect(summary.message).toContain('工作空间 2')
    expect(summary.message).toContain('不可逆')
  })

  it('读取不可用的来源计 null 并注明未计入；四类全 0 仍提示不可逆', () => {
    const summary = buildDependencySummary({
      workspaces: undefined,
      profiles: [],
      members: [],
      assets: [],
    })
    expect(summary.rows.find(row => row.label === '工作空间')?.count).toBeNull()
    expect(summary.message).toContain('工作空间本次读取不可用')
    expect(summary.message).toContain('不可逆')
    const allZero = buildDependencySummary({ workspaces: [], profiles: [], members: [], assets: [] })
    expect(allZero.message).toContain('不可逆')
  })
})

describe('4-4 安全与运行摘要', () => {
  it('运行四项计数与授权拒绝数各自来自各自读取', () => {
    const summary = buildSecurityRunSummary({
      runs: [{ status: 'running' }, { status: 'running' }, { status: 'succeeded' }, { status: 'failed' }],
      authorizationAudits: [{ result: 'succeeded' }, { result: 'failed' }],
    })
    expect(summary.runsTotal).toBe(4)
    expect(summary.runsRunning).toBe(2)
    expect(summary.runsSucceeded).toBe(1)
    expect(summary.runsFailed).toBe(1)
    expect(summary.authorizationDenied).toBe(1)
  })

  it('读取不可用 → null 并列出来源名，不用 0 冒充', () => {
    const summary = buildSecurityRunSummary({ runs: undefined, authorizationAudits: undefined })
    expect(summary.runsTotal).toBeNull()
    expect(summary.authorizationDenied).toBeNull()
    expect(summary.unavailable).toContain('运行列表')
    expect(summary.unavailable).toContain('授权审计')
  })
})
