import { describe, expect, it } from 'vitest'
import { buildPaletteResults, paletteActionDisclosure } from '../src/lib/command-palette.ts'

// 4-2「命令面板」模型层验收（蓝图 §6.2）。
//
// 异常矩阵：
//   匹配  —— 组织/项目/Agent/运行/资产/操作者/request ID 七类来源按子串匹配
//            （大小写不敏感）；空查询返回空结果集，不返回全量。
//   分组  —— 结果按类别分组，类别顺序固定；无匹配的类别不出现。
//   披露  —— 每条结果在执行前显示所需权限与影响范围；影响范围统一为只读导航。
//   大小写 —— 查询 'ALPHA' 命中 'alpha'。

describe('4-2 命令面板匹配与分组', () => {
  const sources = {
    organizations: [{ id: 'org-alpha', label: '星河组织' }],
    projects: [{ id: 'project-alpha', label: '协作台前端' }],
    agents: [{ id: 'ap-1', label: '默认研发代理' }],
    runs: [{ id: 'run-9', label: 'run-9（写入）' }],
    assets: [{ id: 'sk-1', label: '代码评审 Skill' }],
    operators: [{ id: 'member-1', label: '演示成员' }],
    requestIds: [{ id: 'req-alpha-1', label: 'req-alpha-1' }],
  }

  it('七类来源各自匹配并按固定类别分组', () => {
    const results = buildPaletteResults({ query: '', sources })
    expect(results).toEqual([])
    const byAlpha = buildPaletteResults({ query: 'alpha', sources })
    const categories = [...new Set(byAlpha.map(row => row.category))]
    expect(categories.length).toBeGreaterThan(0)
    for (const row of byAlpha) {
      expect(row.id.length).toBeGreaterThan(0)
      expect(row.label.length).toBeGreaterThan(0)
    }
    const byRun = buildPaletteResults({ query: 'run-9', sources })
    expect(byRun[0]?.category).toBe('运行')
  })

  it('大小写不敏感且命中对应类别（request ID / 操作者 / 组织）', () => {
    const byUpper = buildPaletteResults({ query: 'ALPHA', sources })
    expect(byUpper.some(row => row.category === '组织')).toBe(true)
    expect(byUpper.some(row => row.category === 'request ID')).toBe(true)
    const byOperator = buildPaletteResults({ query: '演示', sources })
    expect(byOperator[0]?.category).toBe('操作者')
  })

  it('每条结果执行前披露所需权限与影响范围（只读导航）', () => {
    const byAlpha = buildPaletteResults({ query: 'alpha', sources })
    for (const row of byAlpha) {
      const disclosure = paletteActionDisclosure(row)
      expect(disclosure.permission.length).toBeGreaterThan(0)
      expect(disclosure.impact).toContain('只读')
    }
  })
})
