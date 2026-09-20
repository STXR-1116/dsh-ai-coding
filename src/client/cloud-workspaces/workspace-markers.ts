/**
 * 工程树标记与预览查看器选择（蓝图 §5.2，2-2）。
 * 树条目标记：Agent 修改标记、未同步状态与测试关联（测试关联是客户端的
 * 展示层推断，不作为服务端契约）；查看器按内容类型选择。
 */

/** 工程树单个条目的标记。 */
export interface TreeEntryMarkers {
  /** 变更集里的同步状态：modified | added | deleted；未在变更集中为 undefined。 */
  readonly change: 'modified' | 'added' | 'deleted' | undefined
  /** 未同步状态：在变更集中即未同步（服务端确认基线之后的修改）。 */
  readonly unsynced: boolean
  /** 测试关联：路径呈测试目录/测试文件命名特征。 */
  readonly testAssociated: boolean
}

const TEST_PATH_PATTERN = /(^|\/)(tests?|__tests__)(\/|$)|\.(test|spec)\.[a-z]+$/u

/**
 * 判断路径是否呈测试文件/测试目录特征。
 * @param path - 文件路径。
 * @returns 命中测试目录（tests?/__tests__）或测试文件命名（.test. 或 .spec. 中缀）时为 true。
 */
export function isTestAssociatedPath(path: string): boolean {
  return TEST_PATH_PATTERN.test(path)
}

/**
 * 计算一个树条目的标记。
 * @param path - 文件路径。
 * @param changedFiles - 服务端变更集条目（path + change）。
 * @returns 标记集合；不在变更集中时 change 为 undefined、unsynced 为 false。
 */
export function treeEntryMarkers(
  path: string,
  changedFiles: ReadonlyArray<{ readonly path: string; readonly change: string }>,
): TreeEntryMarkers {
  const matched = changedFiles.find(file => file.path === path)
  const change = matched === undefined
    ? undefined
    : (['modified', 'added', 'deleted'] as const).includes(matched.change as 'modified' | 'added' | 'deleted')
      ? matched.change as 'modified' | 'added' | 'deleted'
      : undefined
  return {
    change,
    unsynced: matched !== undefined,
    testAssociated: isTestAssociatedPath(path),
  }
}

/** 预览查看器类型（按内容类型选择）。 */
export type PreviewViewer = 'sandbox' | 'image' | 'markdown' | 'diff' | 'terminal' | 'json' | 'text'

/**
 * 按预览类型与内容类型选择查看器。
 * @param kind - 服务端声明的预览类型。
 * @param contentType - 服务端声明的 Content-Type。
 * @param path - 预览路径（终端输出的路径特征参与判断）。
 * @returns 查看器类型。
 */
export function selectPreviewViewer(kind: string, contentType: string, path: string): PreviewViewer {
  if (kind === 'static_html') return 'sandbox'
  if (kind === 'image') return 'image'
  if (kind === 'markdown') return 'markdown'
  if (kind === 'diff') return 'diff'
  if (/x-terminal|text\/x-terminal|terminal\//u.test(contentType) || path.includes('terminal/')) return 'terminal'
  if (contentType.includes('json') || kind === 'json') return 'json'
  return 'text'
}
