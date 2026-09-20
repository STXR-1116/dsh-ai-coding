// 2-7「上下文镜头」模型层验收（蓝图 §2-7，§11.13）。
//
// 异常矩阵：
//   分组   —— 条目按八层固定优先级分组输出（规则=safety/org-policy/
//             project-policy/agent-config 聚合为规则组），组序不因条目顺序改变。
//   抑制   —— suppressed 条目必须保留并呈现「已抑制：原因」，不得丢弃；
//             injected=false 且 allowed 的条目呈现选择原因。
//   未知   —— 未知 source 归入显式 unknown 组，不丢弃。
//   合成   —— 项目文件部分从工作空间变更合成（路径+Agent 修改标记）。
//
// 3-3「按运行开关单条记忆」追加验收（§11.17）：
//   开关集 —— 只有基线里可注入的记忆才可开关；基线本来就抑制的（过期/未授权）
//             不属于用户开关——列出来会让人以为点一下就能恢复。
//   身份   —— 没有记忆身份的条目不可开关：抑制端点只认身份。
//   状态   —— 是否已抑制取自运行快照，不解析 permission_reason 文案。
import { describe, expect, it } from 'vitest'
import {
  LENS_LAYER_LABELS,
  LENS_MEMORY_RESTORE_LABEL,
  LENS_MEMORY_SUPPRESS_LABEL,
  groupLensLayers,
  lensEntryStatus,
  lensMemoryToggles,
  projectFilesSection,
} from '../src/client/cloud-workspaces/context-lens.ts'

const entry = (source: string, title: string, overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  source, title, memoryId: null, permission: 'allowed', permission_reason: null, selection_reason: '注入', injected: true, updated_at: '2026-09-10T00:00:00Z', ...overrides,
})

describe('2-7 上下文镜头分组', () => {
  it('按八层固定优先级分组，规则组聚合四层，组序恒定', () => {
    const groups = groupLensLayers([
      entry('user', '用户补充'),
      entry('memory', '记忆 A'),
      entry('safety', '安全基线'),
      entry('knowledge', '知识 K1'),
    ] as never)
    expect(groups.map(group => group.layer)).toEqual(['safety', 'knowledge', 'memory', 'user'])
    expect(LENS_LAYER_LABELS['safety']).toBe('安全/平台规则')
    expect(LENS_LAYER_LABELS['agent-config']).toBe('Agent 配置')
  })

  it('suppressed 条目保留并携带抑制原因标签；allowed 未注入呈现选择原因', () => {
    const groups = groupLensLayers([
      entry('skill', '旧版 Skill', { permission: 'suppressed', permissionReason: '资产版本已过期，已抑制', injected: false }),
      entry('agent-config', '策略 X', { injected: false }),
    ] as never)
    const skillGroup = groups.find(group => group.layer === 'skill')
    expect(skillGroup?.entries.length).toBe(1)
    expect(lensEntryStatus(skillGroup?.entries[0] as never)).toBe('已抑制：资产版本已过期，已抑制')
    const agentGroup = groups.find(group => group.layer === 'agent-config')
    expect(lensEntryStatus(agentGroup?.entries[0] as never)).toContain('注入')
  })

  it('未知 source 归入显式 unknown 组', () => {
    const groups = groupLensLayers([
      entry('mystery', '未知条目'),
    ] as never)
    const unknown = groups.find(group => group.layer === 'unknown')
    expect(unknown?.entries.length).toBe(1)
    expect(unknown?.entries[0]?.title).toBe('未知条目')
  })

  it('项目文件部分从工作空间变更合成，带 Agent 修改标记与未同步状态', () => {
    const section = projectFilesSection([
      { path: 'README.md', change: 'modified' },
      { path: 'src/new.ts', change: 'added' },
    ] as never)
    expect(section.length).toBe(2)
    expect(section[0]?.label).toContain('README.md')
    expect(section[0]?.label).toContain('修改')
    expect(section[1]?.label).toContain('新增')
  })

  it('抑制原因缺失时不得把 undefined 印到界面上', () => {
    const groups = groupLensLayers([
      entry('memory', '无原因抑制', { permission: 'suppressed', permissionReason: null, injected: false }),
    ] as never)

    expect(lensEntryStatus(groups[0]?.entries[0] as never)).toBe('已抑制：')
  })

  it('没有变更标记或词表外的变更值都呈现为「无变更」，不猜语义', () => {
    const section = projectFilesSection([
      { path: 'untracked.md' },
      { path: 'renamed.md', change: 'renamed' },
    ] as never)

    expect(section[0]?.label).toContain('untracked.md')
    expect(section[0]?.label).toContain('无变更')
    expect(section[1]?.label).toContain('无变更')
    // 文件行一律标注未同步：工作空间变更不代表已同步到运行。
    expect(section.every(row => row.label.includes('未同步'))).toBe(true)
  })
})

describe('3-3 按运行开关单条记忆（§11.17）', () => {
  const baseline = [
    entry('memory', '记忆：协作偏好', { memoryId: 'mem-collab-pref' }),
    entry('memory', '记忆：历史数据口径', { memoryId: 'mem-metrics-2025', permission: 'suppressed', injected: false }),
    entry('safety', '安全与平台规则基线'),
  ]

  it('只有基线里可注入的记忆才可开关，被抑制状态取自运行快照', () => {
    const run = [
      entry('memory', '记忆：协作偏好', {
        memoryId: 'mem-collab-pref', permission: 'suppressed', injected: false,
      }),
      entry('memory', '记忆：历史数据口径', { memoryId: 'mem-metrics-2025', permission: 'suppressed', injected: false }),
      entry('safety', '安全与平台规则基线'),
    ]
    const toggles = lensMemoryToggles(run as never, baseline as never)
    expect(toggles).toHaveLength(1)
    expect(toggles[0]).toMatchObject({ memoryId: 'mem-collab-pref', title: '记忆：协作偏好', suppressed: true, label: LENS_MEMORY_RESTORE_LABEL })
  })

  it('未被抑制时给出「关闭」标签；恢复只是同一个开关的另一面', () => {
    const toggles = lensMemoryToggles(baseline as never, baseline as never)
    expect(toggles).toHaveLength(1)
    expect(toggles[0]).toMatchObject({ memoryId: 'mem-collab-pref', suppressed: false, label: LENS_MEMORY_SUPPRESS_LABEL })
  })

  it('没有记忆身份的条目与未知基线都不进开关列表（不猜、不造假身份）', () => {
    const anonymous = [entry('memory', '无身份的记忆')]
    expect(lensMemoryToggles(anonymous as never, baseline as never)).toEqual([])
    // 基线未知时不可开关：无从判断这条抑制是不是用户做的，猜错会把过期记忆说成可恢复。
    expect(lensMemoryToggles(baseline as never, [] as never)).toEqual([])
  })
})
