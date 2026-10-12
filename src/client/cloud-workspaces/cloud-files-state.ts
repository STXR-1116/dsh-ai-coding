/**
 * 云文件面板与视图之间的**状态通道**。
 *
 * 视图把界面选择持久化在 `cloud-workspace-ui:<账号>:<项目>` 里（`{ selectedId, openPath, pane }`）。
 * 右栏的「云文件」面板不新增第二份状态，而是**读写同一条记录**：
 *
 * - 目录面板负责展示目录树；
 * - 点文件时把 `openPath` 写回**同一个键**（读-改-写，绝不覆盖 `selectedId` / `pane`），
 *   然后请宿主打开预览面板；
 * - 预览面板订阅本模块的变更通知，读到新的 `openPath` 就重新取预览。
 *
 * ## 为什么用自定义事件而不是 `storage` 事件
 *
 * `storage` 事件**只跨标签页**、同页内不触发；而"点目录 → 同一页里的预览面板刷新"正是同页内的事。
 * 另外也没有走官方的 `openTab(kind, { params })`：声明该 kind 的 params 需要给
 * `SidebarRightTabParamsMap` 做声明合并，而声明它的包（`dsh-client-ui-sidebar-right`）本机装不上。
 * 这条通道只用浏览器标准 API，不依赖任何装不上的类型。
 *
 * @module dsh-ai-coding/client/cloud-workspaces/cloud-files-state
 */

/** 视图持久化选中态用的键前缀（与 `CloudWorkspacesView` 保持一致）。 */
export const UI_STATE_PREFIX = 'cloud-workspace-ui:'

/** 同页内广播"选择变了"的事件名。 */
const CHANGE_EVENT = 'dsh-ai-coding:cloud-files-selection'

/** 当前选择：视图写入的**那个键**、它指向的云工作空间、以及打开的文件。 */
export interface CloudFilesSelection {
  /** 视图用的持久化键（写回时必须用同一个，才能与视图共享状态）。 */
  readonly key: string
  /** 当前云工作空间 id。 */
  readonly workspaceId: string
  /** 当前打开的文件（工作空间相对路径）。 */
  readonly openPath?: string
  /** 视图当前的面板页签（写回时原样保留）。 */
  readonly pane?: string
}

/**
 * 读出视图当前的选择。
 * @returns 选择；视图还没选过工作空间时为 `undefined`。
 */
export function readSelection(): CloudFilesSelection | undefined {
  try {
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index)
      if (key === null || !key.startsWith(UI_STATE_PREFIX)) continue
      const raw = localStorage.getItem(key)
      if (raw === null) continue
      const parsed = JSON.parse(raw) as { selectedId?: unknown; openPath?: unknown; pane?: unknown }
      if (typeof parsed.selectedId !== 'string' || parsed.selectedId.length === 0) continue
      return {
        key,
        workspaceId: parsed.selectedId,
        ...(typeof parsed.openPath === 'string' && parsed.openPath.length > 0 ? { openPath: parsed.openPath } : {}),
        ...(typeof parsed.pane === 'string' ? { pane: parsed.pane } : {}),
      }
    }
  } catch { /* 读不到就当作未选择 */ }
  return undefined
}

/**
 * 把"打开的文件"写回视图的记录，并广播变更。
 *
 * **读-改-写**：先把现有字段读出来再合并，避免把 `selectedId` / `pane` 抹掉 ——
 * 那会让视图在下次加载时丢掉工作空间选择。
 * @param key - 视图用的持久化键（来自 {@link readSelection}）。
 * @param openPath - 要打开的文件路径。
 */
export function writeOpenPath(key: string, openPath: string): void {
  try {
    const raw = localStorage.getItem(key)
    const current = raw === null ? {} : JSON.parse(raw) as Record<string, unknown>
    localStorage.setItem(key, JSON.stringify({ ...current, openPath }))
  } catch { /* 存储不可用时静默：面板仍可通过事件刷新 */ }
  try {
    window.dispatchEvent(new CustomEvent(CHANGE_EVENT))
  } catch { /* 无 window（测试环境）时忽略 */ }
}

/**
 * 订阅选择变化。
 * @param listener - 变更回调。
 * @returns 取消订阅。
 */
export function subscribeSelection(listener: () => void): () => void {
  try {
    window.addEventListener(CHANGE_EVENT, listener)
    return () => { window.removeEventListener(CHANGE_EVENT, listener) }
  } catch {
    return () => { /* 无 window 时无可取消 */ }
  }
}
