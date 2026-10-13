/**
 * 工程目录 —— **VS Code 风格的文件树**（所有者要求：`文件列表做成像 vscode 一样的文件树`）。
 *
 * ## 与旧实现的区别
 *
 * 旧版是**逐级下钻**（`.. 上级` + 一次只显示一层）。VS Code 是**可展开的树**：所有层级都留在
 * 视图里，目录行带折叠箭头、子项按深度缩进。差异不只是好看 —— 树形让"文件在哪一层"始终可见，
 * 下钻式每进一层就丢失上下文。
 *
 * ## 复用官方资源
 *
 * 图标不是自己画的：`FileTypeIcon`（按路径给出官方配色字形）、`IconChevronDownOutline14` /
 * `IconChevronRightOutline14` / `IconRefreshOutline16` / `IconChevronUpOutline14` 都来自
 * `@deepseek-ai/dsh-client-ui-primitives` —— 与原生预览同一套。**图标名带尺寸后缀**，
 * 且从包根导出（第一次写成不带后缀的名字，typecheck 当场拦下）。
 *
 * ## 保持的对外契约（既有 spec 依赖，别改）
 *
 * - 每一行是一个 `<button>`，其**可访问名就是文件名/目录名本身**（不是完整路径）——
 *   spec 用 `getByRole('button', { name: 'src' })` / `{ name: 'README.md' }` 找它；
 * - 工作空间未就绪时行 **`disabled`**；
 * - 点目录只 **加载并展开**（调用 `workspaceFiles(workspaceId, dir)`），点文件才打开预览；
 * - **变更标记文案**是契约（「Agent 修改·未同步」等）：曾被我压成单字母而打红三条断言，已恢复。
 *
 * ## 根目录为什么由视图加载（`rootItems`）
 *
 * 根读取失败必须走**视图自己的错误通道**（错误横幅 + 重试），那是 isolation spec 断言的可观察
 * 契约；树内部读会绕过它。分工：视图负责根与错误，树负责展开子目录。
 *
 * @module dsh-ai-coding/client/cloud-workspaces/FileTreeView
 */

import { useCallback, useEffect, useState } from 'react'
import {
  FileTypeIcon,
  IconChevronDownOutline14,
  IconChevronRightOutline14,
  IconChevronUpOutline14,
  IconRefreshOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'

import type { PlatformRemote } from '../remote/types.ts'
import type { WorkspaceFileEntry, WorkspaceQueryResult } from '../../workspace-types.ts'
import { treeEntryMarkers } from './workspace-markers.ts'
import css from './FileTreeView.module.css'

/** 变更集里我们用于标记的字段。 */
export interface TreeChangeEntry {
  readonly path: string
  readonly change: string
}

/** 文件树 props。 */
export interface FileTreeViewProps {
  /** 本插件的浏览器侧远程面。 */
  readonly remote: PlatformRemote
  /** 当前工作空间 id。 */
  readonly workspaceId: string
  /**
   * 根目录条目，**由视图加载**（不在这里读）。
   *
   * 为什么：根读取失败必须走视图自己的错误通道（错误横幅 + 重试），那是既有 spec 断言的
   * 可观察契约；树只管展开子目录。
   */
  readonly rootItems: readonly WorkspaceFileEntry[]
  /** 标题里显示的分支名。 */
  readonly branch?: string
  /** 工作空间未就绪时整棵树的行动作禁用（沿用既有契约）。 */
  readonly disabled: boolean
  /** 当前打开的文件（高亮该行）。 */
  readonly selectedPath?: string
  /** 变更集：用于"Agent 修改·未同步"等标记（展示层推断，源自服务端变更集）。 */
  readonly changes?: readonly TreeChangeEntry[]
  /** 点开一个文件。 */
  readonly onOpenFile: (path: string, kind: string) => void
  /** 刷新根目录（由视图执行真正的读取，错误因此仍走视图的通道）。 */
  readonly onRefresh?: () => void
}

/** 取远程调用的值，传输层失败时抛出。 */
function unwrap<T>(result: { ok: true; value: T } | { ok: false; error: { code: string; message: string } }): T {
  if (result.ok) return result.value
  throw new Error(`${result.error.code}: ${result.error.message}`)
}

/** 把非 ready 的领域状态翻译成人能读懂的原因。 */
function describeNotReady(result: Exclude<WorkspaceQueryResult<unknown>, { status: 'ready' }>): string {
  switch (result.status) {
    case 'signed-out': return '尚未登录：请先在插件里登录平台账号。'
    case 'not-ready': return `服务未就绪，缺少：${result.missing.join('、')}`
    default: return `${result.code}：${result.message}`
  }
}

/** 取路径的最后一段（行的可访问名用它，契约见文件头）。 */
function baseName(path: string): string {
  const index = path.lastIndexOf('/')
  return index < 0 ? path : path.slice(index + 1)
}

/**
 * 排序：**目录在前、文件在后**，同类按名字（VS Code 的分组顺序）。
 * @param items - 一层条目。
 * @returns 排好序的新数组。
 */
function orderForDisplay(items: readonly WorkspaceFileEntry[]): readonly WorkspaceFileEntry[] {
  return [...items].sort((left, right) => {
    if (left.kind !== right.kind) return left.kind === 'directory' ? -1 : 1
    return baseName(left.path).localeCompare(baseName(right.path), 'zh-Hans-CN')
  })
}

/**
 * 渲染一棵文件树。
 * @param props - 远程面、工作空间、根条目与回调。
 * @returns 标题栏 + 树。
 */
export function FileTreeView({
  remote, workspaceId, rootItems, branch, disabled, selectedPath, changes = [], onOpenFile, onRefresh,
}: FileTreeViewProps) {
  const [children, setChildren] = useState<ReadonlyMap<string, readonly WorkspaceFileEntry[]>>(new Map())
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  const [error, setError] = useState<string | undefined>()

  const load = useCallback(async (path: string) => {
    try {
      const result = unwrap(await remote.cloudWorkspaces.workspaceFiles(workspaceId, path))
      if (result.status !== 'ready') {
        setError(describeNotReady(result))
        return
      }
      setChildren(previous => new Map(previous).set(path, result.value.items))
      setError(undefined)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    }
  }, [remote, workspaceId])

  // 换工作空间就收起所有展开项并丢弃缓存的子目录（否则会看到上一个工作空间的子项）。
  useEffect(() => {
    setChildren(new Map())
    setExpanded(new Set())
  }, [workspaceId])

  const toggle = useCallback((path: string) => {
    setExpanded(previous => {
      const next = new Set(previous)
      if (next.has(path)) { next.delete(path); return next }
      next.add(path)
      return next
    })
    // 展开时按需加载；已加载过就直接复用。
    if (!children.has(path)) void load(path)
  }, [children, load])

  const changeEntries = changes.map(file => ({ path: file.path, change: file.change }))

  /** 渲染一层条目（递归）。 */
  const renderItems = (parent: string, depth: number) => {
    // 根层用视图给的数据；其余层用展开时按需加载并缓存的。
    const items = parent === '' ? rootItems : children.get(parent)
    if (items === undefined) return null
    return (
      <ul className={css.list} role="group">
        {orderForDisplay(items).map(item => {
          const name = baseName(item.path)
          const isDirectory = item.kind === 'directory'
          const isOpen = expanded.has(item.path)
          const markers = treeEntryMarkers(item.path, changeEntries)
          return (
            <li key={item.path}>
              <button
                type="button"
                className={item.path === selectedPath ? css.rowActive : css.row}
                // 缩进按深度；箭头占位保证同级文件名左边缘对齐。
                style={{ paddingLeft: `${6 + depth * 14}px` }}
                disabled={disabled}
                title={disabled ? '工作空间未就绪' : item.path}
                aria-current={item.path === selectedPath ? 'true' : undefined}
                aria-expanded={isDirectory ? isOpen : undefined}
                onClick={() => {
                  if (isDirectory) { toggle(item.path); return }
                  onOpenFile(item.path, item.kind)
                }}
              >
                <span className={css.chevron} aria-hidden="true">
                  {isDirectory
                    ? (isOpen ? <IconChevronDownOutline14 size={14} /> : <IconChevronRightOutline14 size={14} />)
                    : null}
                </span>
                <span className={css.icon} aria-hidden="true">
                  <FileTypeIcon path={name} size={14} />
                </span>
                {/* 可访问名 = 文件名本身（契约）：图标与标记都不参与命名。 */}
                <span className={css.name}>{name}</span>
                {markers.change === 'modified' && <span className={css.marker}>Agent 修改·未同步</span>}
                {markers.change === 'added' && <span className={css.marker}>新增·未同步</span>}
                {markers.change === 'deleted' && <span className={css.marker}>已删除·未同步</span>}
                {markers.testAssociated && <span className={css.marker}>测试</span>}
              </button>
              {isDirectory && isOpen && renderItems(item.path, depth + 1)}
            </li>
          )
        })}
      </ul>
    )
  }

  return (
    <div className={css.tree}>
      {/* 标题栏（VS Code 的根节点行）：分支名 + 刷新 + 全部折叠。
          换树时我漏掉了原来的「工程目录 <分支>」标题 —— 这里补回来并加上控件。 */}
      <div className={css.header}>
        <span className={css.headerTitle}>{branch === undefined ? '工程目录' : `工程目录 ${branch}`}</span>
        {onRefresh !== undefined && (
          // 标签**刻意不含「刷新」二字**：视图里已有一个「刷新」（冲突横幅那几个），
          // 而既有 spec 用 `/刷新/u` 做宽松匹配 —— 撞名会让它变成歧义匹配（实测打红一条）。
          <button type="button" className={css.headerAction} aria-label="重新读取工程目录" title="重新读取" onClick={onRefresh}>
            <IconRefreshOutline16 size={16} />
          </button>
        )}
        <button
          type="button"
          className={css.headerAction}
          aria-label="全部折叠"
          title="全部折叠"
          onClick={() => { setExpanded(new Set()) }}
        >
          <IconChevronUpOutline14 size={14} />
        </button>
      </div>
      {error !== undefined && <p className={css.error} role="alert">{error}</p>}
      {renderItems('', 0)}
      {rootItems.length === 0 && <p className={css.empty}>目录为空</p>}
    </div>
  )
}
