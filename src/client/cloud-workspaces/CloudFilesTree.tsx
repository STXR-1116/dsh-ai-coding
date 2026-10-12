/**
 * 云文件 · **目录面板**（官方右侧 Sidebar 的产品页）。
 *
 * ## 为什么把目录与预览拆成两个面板
 *
 * 所有者对照原生后指出：「为什么面板上会一直有文件列表，原生的直接是文件预览」。
 * 官方就是这么分的 —— 它内置的 `files` 与 `text` 是**两个 tab 类型**：目录一个面板、
 * 预览一个面板。把两者塞进同一个面板，等于让预览永远被目录压着一半。
 *
 * ## 点击文件时发生什么
 *
 * 把 `openPath` 写回**视图用的那条持久化记录**（见 `cloud-files-state.ts`），再请宿主打开
 * 预览面板。两个面板因此共享同一份选择，不新增第二份状态。
 *
 * @module dsh-ai-coding/client/cloud-workspaces/CloudFilesTree
 */

import { useCallback, useEffect, useState } from 'react'

import type { PlatformRemote } from '../remote/types.ts'
import type { WorkspaceDirectory, WorkspaceQueryResult } from '../../workspace-types.ts'
import { readSelection, subscribeSelection, writeOpenPath } from './cloud-files-state.ts'
import css from './cloud-files.module.css'

/** 目录面板 props。 */
export interface CloudFilesTreeProps {
  /** 本插件的浏览器侧远程面。 */
  readonly remote: PlatformRemote
  /** 请宿主打开（或聚焦）预览面板；由 `index.ts` 注入。 */
  readonly openPreview?: () => void
}

/** 取远程调用的值，传输层失败时抛出（面板据此显示原因）。 */
function unwrap<T>(result: { ok: true; value: T } | { ok: false; error: { code: string; message: string } }): T {
  if (result.ok) return result.value
  throw new Error(`${result.error.code}: ${result.error.message}`)
}

/**
 * 把非 ready 的领域状态翻译成人能读懂的原因。
 *
 * 每个分支都要有话说：`signed-out` 与 `not-ready` 不是"空目录"，把它们显示成空会让使用者
 * 以为工作空间里真没有文件。
 * @param result - 领域结果（非 ready）。
 * @returns 展示用原因。
 */
function describeNotReady(result: Exclude<WorkspaceQueryResult<unknown>, { status: 'ready' }>): string {
  switch (result.status) {
    case 'signed-out': return '尚未登录：请先在插件里登录平台账号。'
    case 'not-ready': return `服务未就绪，缺少：${result.missing.join('、')}`
    default: return `${result.code}：${result.message}`
  }
}

/**
 * 目录面板：只显示目录树，点击文件交给预览面板。
 * @param props - 远程面与"打开预览"回调。
 * @returns 面板内容。
 */
export function CloudFilesTree({ remote, openPreview }: CloudFilesTreeProps) {
  const [selection, setSelection] = useState(() => readSelection())
  const [path, setPath] = useState('')
  const [directory, setDirectory] = useState<WorkspaceDirectory | undefined>()
  const [error, setError] = useState<string | undefined>()
  const [busy, setBusy] = useState(false)

  // 视图切换工作空间后，面板要跟着换目录。
  useEffect(() => subscribeSelection(() => { setSelection(readSelection()) }), [])

  const workspaceId = selection?.workspaceId

  const loadDirectory = useCallback(async (next: string) => {
    if (workspaceId === undefined) return
    setBusy(true)
    setError(undefined)
    try {
      const result = unwrap(await remote.cloudWorkspaces.workspaceFiles(workspaceId, next))
      if (result.status !== 'ready') {
        setError(describeNotReady(result))
        setDirectory(undefined)
        return
      }
      setDirectory(result.value)
      setPath(next)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
      setDirectory(undefined)
    } finally {
      setBusy(false)
    }
  }, [remote, workspaceId])

  useEffect(() => { void loadDirectory('') }, [loadDirectory])

  if (workspaceId === undefined) {
    return <p className={css.note}>尚未选择云工作空间：先在工作台里选一个。</p>
  }

  const entries = directory?.items ?? []

  return (
    <div className={css.pane}>
      <div className={css.bar}>
        <span className={css.path} title={`${workspaceId}/${path}`}>{path === '' ? '/' : path}</span>
        <button type="button" className={css.action} onClick={() => { void loadDirectory(path) }}>刷新</button>
      </div>
      {error !== undefined && <p className={css.error} role="alert">{error}</p>}
      <ul className={css.tree} aria-label="云文件目录">
        {path !== '' && (
          <li>
            <button type="button" className={css.entry} onClick={() => {
              const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''
              void loadDirectory(parent)
            }}>
              .. 上级
            </button>
          </li>
        )}
        {entries.map(entry => (
          <li key={entry.path}>
            <button
              type="button"
              className={css.entry}
              data-kind={entry.kind}
              onClick={() => {
                if (entry.kind === 'directory') { void loadDirectory(entry.path); return }
                // 文件：写回共享选择，再请宿主打开预览面板（官方模型：目录与预览是两个面板）。
                if (selection !== undefined) writeOpenPath(selection.key, entry.path)
                openPreview?.()
              }}
            >
              {entry.kind === 'directory' ? '📁' : '📄'} {entry.path.split('/').pop() ?? entry.path}
            </button>
          </li>
        ))}
        {entries.length === 0 && error === undefined && <li className={css.note}>{busy ? '读取中…' : '目录为空'}</li>}
      </ul>
    </div>
  )
}
