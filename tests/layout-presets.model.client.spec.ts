// 2-1「三栏工作空间与四种布局」模型层验收（蓝图 §5.2）。
//
// 异常矩阵：
//   四种预设 —— standard/focus-session/review-diff/monitor-runs 的三栏可见性
//               映射冻结：标准三栏全见；专注会话仅中栏；审阅 diff = 左树+右栏；
//               监控运行仅右栏。
//   布局切换 —— 只改变可见性：模型层无副作用（纯函数）；未知预设直接拒绝，
//               不用默认布局吞掉。
//   词表顺序 —— 四种预设的定义顺序固定（界面按钮顺序一致）。
import { describe, expect, it } from 'vitest'
import {
  WORKSPACE_LAYOUT_LABELS,
  WORKSPACE_LAYOUT_PRESETS,
  layoutPresetSpec,
} from '../src/client/cloud-workspaces/layout-presets.ts'

describe('2-1 布局预设模型', () => {
  it('预设词表顺序冻结，标签齐备', () => {
    expect([...WORKSPACE_LAYOUT_PRESETS]).toEqual([
      'standard', 'focus-session', 'review-diff', 'monitor-runs',
    ])
    for (const preset of WORKSPACE_LAYOUT_PRESETS) {
      expect(WORKSPACE_LAYOUT_LABELS[preset].length).toBeGreaterThan(0)
    }
  })

  it('四种预设的三栏可见性映射冻结', () => {
    expect(layoutPresetSpec('standard')).toEqual({ left: true, middle: true, right: true })
    expect(layoutPresetSpec('focus-session')).toEqual({ left: false, middle: true, right: false })
    expect(layoutPresetSpec('review-diff')).toEqual({ left: true, middle: false, right: true })
    expect(layoutPresetSpec('monitor-runs')).toEqual({ left: false, middle: false, right: true })
  })

  it('未知预设直接拒绝，不用默认布局吞掉', () => {
    expect(() => layoutPresetSpec('timeline')).toThrow(/未知布局预设/u)
  })
})
