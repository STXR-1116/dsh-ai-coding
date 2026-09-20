/**
 * 云工作空间四种布局预设（蓝图 §5.2）：标准三栏、专注会话、审阅 diff、
 * 监控运行。布局只控制三栏（左工程树/中会话/右预览）的可见性——切换布局
 * 不得改变运行状态、不得触发重新读取。
 */

/** 布局预设名。 */
export type WorkspaceLayoutPreset = 'standard' | 'focus-session' | 'review-diff' | 'monitor-runs'

/** 每个预设的三栏可见性。 */
export interface LayoutPresetSpec {
  readonly left: boolean
  readonly middle: boolean
  readonly right: boolean
}

/** 预设的定义顺序即界面按钮顺序。 */
export const WORKSPACE_LAYOUT_PRESETS: readonly WorkspaceLayoutPreset[] = [
  'standard',
  'focus-session',
  'review-diff',
  'monitor-runs',
]

/** 预设的中文标签（展示层使用，不作为标识）。 */
export const WORKSPACE_LAYOUT_LABELS: Record<WorkspaceLayoutPreset, string> = {
  standard: '标准三栏',
  'focus-session': '专注会话',
  'review-diff': '审阅 diff',
  'monitor-runs': '监控运行',
}

/** 预设 → 三栏可见性映射（契约冻结，实现不得各自解释）。 */
export const LAYOUT_PRESET_SPECS: Record<WorkspaceLayoutPreset, LayoutPresetSpec> = {
  standard: { left: true, middle: true, right: true },
  'focus-session': { left: false, middle: true, right: false },
  'review-diff': { left: true, middle: false, right: true },
  'monitor-runs': { left: false, middle: false, right: true },
}

/** 冻结映射的字符串键视图：解析入口接受未受信字符串（如持久化恢复）。 */
const LAYOUT_PRESET_SPECS_BY_NAME: Record<string, LayoutPresetSpec | undefined> = LAYOUT_PRESET_SPECS

/**
 * 解析一个布局预设的可见性规格。
 * @param preset - 布局预设名；入参是字符串，词表外取值同样走到失败路径。
 * @returns 三栏可见性。
 * @throws Error 当预设名不在四种词表内——调用方协议违例，不用默认布局吞掉。
 */
export function layoutPresetSpec(preset: string): LayoutPresetSpec {
  const spec = LAYOUT_PRESET_SPECS_BY_NAME[preset]
  if (spec === undefined) {
    throw new Error(`layout-presets: 未知布局预设 ${JSON.stringify(preset)}`)
  }
  return spec
}
