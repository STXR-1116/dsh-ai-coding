/**
 * 上下文镜头的客户端纯模型（蓝图 §2-7，§11.13）：账本条目按 §4.3 八层固定
 * 优先级分组（规则组聚合四层），被抑制条目保留并显式标注原因，未知来源归入
 * 显式 unknown 组；项目文件部分由工作空间变更数据合成。
 */
import type { ContextLensEntry } from '../../types.ts'

/** 八层来源的中文层标签（展示层）。 */
export const LENS_LAYER_LABELS: Record<string, string> = {
  safety: '安全/平台规则',
  'org-policy': '组织策略',
  'project-policy': '项目规则',
  'agent-config': 'Agent 配置',
  skill: 'Skill',
  knowledge: '知识',
  memory: '记忆',
  user: '用户补充',
}

/** 分组顺序即 §4.3 优先级；unknown 组固定在最后。 */
const GROUP_ORDER = ['safety', 'org-policy', 'project-policy', 'agent-config', 'skill', 'knowledge', 'memory', 'user', 'unknown']

/** 一个优先级层的条目组。 */
export interface LensLayerGroup {
  readonly layer: string
  readonly label: string
  readonly entries: readonly ContextLensEntry[]
}

/**
 * 把账本条目按八层优先级分组；组序恒定，未知来源显式归组。
 * @param entries - 服务端账本条目（§11.13）。
 * @returns 按优先级排序的条目组。
 */
export function groupLensLayers(entries: readonly ContextLensEntry[]): readonly LensLayerGroup[] {
  const buckets = new Map<string, ContextLensEntry[]>()
  for (const entry of entries) {
    const key = (LENS_LAYER_LABELS[entry.source] !== undefined ? entry.source : 'unknown') as string
    const bucket = buckets.get(key) ?? []
    bucket.push(entry)
    buckets.set(key, bucket)
  }
  const order = [...GROUP_ORDER, ...[...buckets.keys()].filter(key => !GROUP_ORDER.includes(key))]
  const groups: LensLayerGroup[] = []
  for (const layer of order) {
    const bucket = buckets.get(layer)
    // 固定顺序里的层可能这一轮没有任何条目；空组不出现。
    if (bucket === undefined) continue
    groups.push({ layer, label: LENS_LAYER_LABELS[layer] ?? `${layer}（未知来源）`, entries: bucket })
  }
  return groups
}

/**
 * 单条账目的状态标签：被抑制必须带原因，allowed 未注入呈现选择原因。
 * @param entry - 账本条目。
 * @returns 状态文本。
 */
export function lensEntryStatus(entry: ContextLensEntry): string {
  if (entry.permission === 'suppressed') return `已抑制：${entry.permissionReason ?? ''}`
  if (entry.injected) return '已注入'
  return `未注入：${entry.selectionReason}`
}

/** 关闭一条记忆对当前运行影响的按钮文案（§11.17）。 */
export const LENS_MEMORY_SUPPRESS_LABEL = '关闭本次运行的影响'
/** 把一条被本运行抑制的记忆恢复为注入的按钮文案（§11.17）。 */
export const LENS_MEMORY_RESTORE_LABEL = '恢复本次运行的影响'

/** 一条可以被用户按运行开关的记忆条目（§11.17）。 */
export interface LensMemoryToggle {
  readonly memoryId: string
  readonly title: string
  readonly suppressed: boolean
  readonly label: string
}

/**
 * 抽出所选运行里可以被开关的记忆条目。
 *
 * 判据不解析文案：一条记忆只有在**基线快照**里可注入，才可能被某次运行关掉。
 * 基线本来就抑制的条目（过期、未授权）不属于用户开关——把它们列出来会让人以为
 * 点一下就能恢复，而恢复一个过期记忆不是这个开关的能力。
 * @param runEntries - 该运行作用下的账本条目。
 * @param baselineEntries - 不绑定运行的基线账本条目。
 * @returns 可开关的记忆条目；被抑制状态取自运行快照，可开关性取自基线。
 */
export function lensMemoryToggles(
  runEntries: readonly ContextLensEntry[],
  baselineEntries: readonly ContextLensEntry[],
): readonly LensMemoryToggle[] {
  const toggles: LensMemoryToggle[] = []
  for (const entry of runEntries) {
    if (entry.source !== 'memory' || entry.memoryId === null) continue
    const baseline = baselineEntries.find(candidate => candidate.memoryId === entry.memoryId)
    if (baseline === undefined || baseline.permission !== 'allowed') continue
    const suppressed = entry.permission === 'suppressed'
    toggles.push({
      memoryId: entry.memoryId,
      title: entry.title,
      suppressed,
      label: suppressed ? LENS_MEMORY_RESTORE_LABEL : LENS_MEMORY_SUPPRESS_LABEL,
    })
  }
  return toggles
}

/** 项目文件小节的一行：路径 + 变更标记文本。 */
export interface LensFileRow {
  readonly path: string
  readonly label: string
}

/**
 * 从工作空间变更合成项目文件小节（文件状态是客户端已有的工作空间数据）。
 * @param files - 工作空间变更条目。
 * @returns 文件行。
 */
export function projectFilesSection(files: readonly { readonly path: string; readonly change?: string }[]): readonly LensFileRow[] {
  const labels: Record<string, string> = { modified: 'Agent 修改', added: '新增', deleted: '已删除' }
  return files.map(file => ({
    path: file.path,
    label: `${file.path}（${file.change !== undefined && labels[file.change] !== undefined ? labels[file.change] : '无变更'} · 未同步）`,
  }))
}
