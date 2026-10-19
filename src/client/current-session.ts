/**
 * 插件自己拥有的"当前会话"通道。
 *
 * ## 为什么需要它（0.2.1 迁移的后果）
 *
 * 0.1.5 时代我们可以从外壳的服务状态里读"当前会话"（`SessionListState.current`）。
 * 0.2.1 去掉了它 —— 官方 `ISessions` 的原话是
 * 「Host catalog and local reference-source counts; **navigation belongs to view owners**」，
 * 也就是说"当前显示哪个会话"归**视图自己**持有，插件读不到（`currentSession` 在 0.2.1 里
 * 只剩内部类的私有字段）。
 *
 * 所有者选定的语义（方案 A）：**知识库绑定跟着"插件自己打开的那个会话"走** ——
 * 也就是接管模式里 `openWorkspaceSession()` 切过去的那个云工作空间会话。
 * 好处是它不再依赖外壳的内部状态，而且正好是使用者的真实意图
 * （"在这个工作空间的会话里用这个知识库"）。
 *
 * ## 边界
 *
 * - 只存**插件自己打开过**的会话 id；插件没打开过就是 `undefined`（绑定不生效，而不是绑错）；
 * - 不持久化：刷新后由接管流程（T2）重新解析并写入；
 * - 退出接管时清空，避免把绑定算到已经离开的会话上。
 *
 * @module dsh-ai-coding/client/current-session
 */

/** 同页内广播"插件会话变了"的事件名。 */
const CHANGE_EVENT = 'dsh-ai-coding:current-session'

/** 当前插件会话 id（模块级单例：整页共用一份）。 */
let currentSessionId: string | undefined

/**
 * 读出插件当前拥有的会话 id。
 * @returns 会话 id；插件还没打开过任何会话时为 `undefined`。
 */
export function readCurrentSession(): string | undefined {
  return currentSessionId
}

/**
 * 写入插件当前拥有的会话 id（`undefined` 表示清空）。
 *
 * 只在**真的变化**时广播 —— 否则每次接管流程重算都会惊动所有订阅者，
 * 而订阅者是 React effect，多余的通知会把绑定流程反复唤醒。
 * @param sessionId - 新的会话 id，或 `undefined` 清空。
 */
export function setCurrentSession(sessionId: string | undefined): void {
  if (currentSessionId === sessionId) return
  currentSessionId = sessionId
  try {
    window.dispatchEvent(new Event(CHANGE_EVENT))
  } catch {
    // 非浏览器环境（单测的 node 项目）没有 window：值已经写进去了，通知失败不影响正确性。
  }
}

/**
 * 订阅插件会话变化。
 * @param listener - 变化时调用。
 * @returns 取消订阅。
 */
export function subscribeCurrentSession(listener: () => void): () => void {
  try {
    window.addEventListener(CHANGE_EVENT, listener)
    return () => { window.removeEventListener(CHANGE_EVENT, listener) }
  } catch {
    return () => {}
  }
}
