/**
 * 云文件 · **预览面板**（官方右侧 Sidebar 的产品页）。
 *
 * 与目录面板分开，是为了对齐官方模型（内置 `files` 与 `text` 就是两个 tab 类型）：
 * 这里**只有预览**，头部是文件路径，正文交给共享的 `FilePreview`。
 *
 * 打开哪个文件来自共享选择（`cloud-files-state.ts`，即视图那条持久化记录）——
 * 目录面板写、这里订阅着读，因此不会出现"两个面板各记一份、越看越不一致"。
 *
 * @module dsh-ai-coding/client/cloud-workspaces/CloudPreviewPane
 */

import { useCallback, useEffect, useState } from 'react'

import type { PlatformRemote } from '../remote/types.ts'
import type { WorkspacePreview, WorkspaceQueryResult } from '../../workspace-types.ts'
import { readSelection, subscribeSelection } from './cloud-files-state.ts'
import { FilePreview } from './FilePreview.tsx'
import css from './cloud-files.module.css'

/** 预览面板 props。 */
export interface CloudPreviewPaneProps {
  /** 本插件的浏览器侧远程面。 */
  readonly remote: PlatformRemote
}

/** 取远程调用的值，传输层失败时抛出（面板据此显示原因）。 */
function unwrap<T>(result: { ok: true; value: T } | { ok: false; error: { code: string; message: string } }): T {
  if (result.ok) return result.value
  throw new Error(`${result.error.code}: ${result.error.message}`)
}

/**
 * 把非 ready 的领域状态翻译成人能读懂的原因。
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
 * 预览面板：只渲染当前打开的文件。
 * @param props - 本插件的远程面。
 * @returns 面板内容。
 */
export function CloudPreviewPane({ remote }: CloudPreviewPaneProps) {
  const [selection, setSelection] = useState(() => readSelection())
  const [preview, setPreview] = useState<WorkspacePreview | undefined>()
  const [error, setError] = useState<string | undefined>()
  const [busy, setBusy] = useState(false)

  useEffect(() => subscribeSelection(() => { setSelection(readSelection()) }), [])

  const workspaceId = selection?.workspaceId
  const openPath = selection?.openPath

  const load = useCallback(async () => {
    if (workspaceId === undefined || openPath === undefined) return
    setBusy(true)
    setError(undefined)
    try {
      const result = unwrap(await remote.cloudWorkspaces.workspacePreview(workspaceId, openPath))
      if (result.status !== 'ready') {
        setError(describeNotReady(result))
        return
      }
      setPreview(result.value)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setBusy(false)
    }
  }, [remote, workspaceId, openPath])

  useEffect(() => { void load() }, [load])

  if (openPath === undefined) {
    return <p className={css.note}>在「云文件」目录里选一个文件。</p>
  }

  return (
    <div className={css.pane}>
      <div className={css.bar}>
        {/* 头部是**文件路径**：与原生预览的定位方式一致（它顶部也显示完整路径）。 */}
        <span className={css.path} title={openPath}>{openPath}</span>
        <button type="button" className={css.action} onClick={() => { void load() }}>刷新</button>
      </div>
      {error !== undefined && <p className={css.error} role="alert">{error}</p>}
      <div className={css.preview}>
        {preview === undefined
          ? busy ? <p className={css.note}>读取中…</p> : null
          : <FilePreview preview={preview} />}
      </div>
    </div>
  )
}
