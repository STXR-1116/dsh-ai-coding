/**
 * 云文件面板 —— 注册进官方右侧 Sidebar 的**产品页**（page type）。
 *
 * ## 为什么是"页面类型"
 *
 * 官方 tab 类型有两种：给 `patterns` 的是**资源类型**（按 `dsh-resource://` 地址打开），
 * 省略 `patterns` 的是**页面类型**（只按 kind 打开、不认地址，见随包
 * `tab-registry.d.ts`：「omit for a page type, which is opened by kind and recognizes no address」）。
 * 云文件是**远端资源**、地址体系是我们的（平台的 workspace/path），所以走页面类型最直接：
 * 面板自己管"当前打开哪个文件"。
 *
 * ## 它怎么知道当前是哪个云工作空间
 *
 * 读视图持久化的选中态（`cloud-workspace-ui:<账号>:<项目>` 里的 `selectedId`）—— 只按前缀扫，
 * 因此不耦合键的其余格式。**不新增一份状态**：视图与面板因此始终指向同一个工作空间。
 *
 * @module dsh-ai-coding/client/cloud-workspaces/CloudFilesPane
 */

import { useCallback, useEffect, useState } from 'react'

import type { PlatformRemote } from '../remote/types.ts'
import css from './CloudFilesPane.module.css'

/** 视图持久化选中态用的键前缀（与 `CloudWorkspacesView` 保持一致）。 */
const UI_STATE_PREFIX = 'cloud-workspace-ui:'

/** 面板 props：只依赖我们自己的远程面。 */
export interface CloudFilesPaneProps {
  /** 本插件的浏览器侧远程面（云工作空间命名空间）。 */
  readonly remote: PlatformRemote
}

/** 目录条目（服务端返回形状里我们用到的那几个字段）。 */
interface Entry {
  readonly path: string
  readonly kind: string
}

/** 从持久化选中态里取当前云工作空间 id。 */
function selectedWorkspaceId(): string | undefined {
  try {
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index)
      if (key === null || !key.startsWith(UI_STATE_PREFIX)) continue
      const raw = localStorage.getItem(key)
      if (raw === null) continue
      const parsed = JSON.parse(raw) as { selectedId?: unknown }
      if (typeof parsed.selectedId === 'string' && parsed.selectedId.length > 0) return parsed.selectedId
    }
  } catch { /* 读不到就当作未选择 */ }
  return undefined
}

/** 读一个 envelope 的值，失败时抛出带 code 的错误（面板据此显示原因）。 */
function unwrap<T>(result: { ok: true; value: T } | { ok: false; error: { code: string; message: string } }): T {
  if (result.ok) return result.value
  throw new Error(`${result.error.code}: ${result.error.message}`)
}

/**
 * 云文件面板：上方目录、下方预览。
 * @param props - 本插件的远程面。
 * @returns 面板内容。
 */
export function CloudFilesPane({ remote }: CloudFilesPaneProps) {
  const [workspaceId] = useState(() => selectedWorkspaceId())
  const [path, setPath] = useState('')
  const [entries, setEntries] = useState<readonly Entry[]>([])
  const [file, setFile] = useState<{ path: string; text: string } | undefined>()
  const [error, setError] = useState<string | undefined>()
  const [busy, setBusy] = useState(false)

  const loadDirectory = useCallback(async (next: string) => {
    if (workspaceId === undefined) return
    setBusy(true)
    setError(undefined)
    try {
      const payload = unwrap(await remote.cloudWorkspaces.workspaceFiles(workspaceId, next))
      // 服务端返回的形状含 `items`；只取我们渲染需要的两个字段，其余原样忽略。
      const items = (payload as { items?: readonly { path?: unknown; kind?: unknown }[] }).items ?? []
      setEntries(items
        .filter(item => typeof item.path === 'string' && typeof item.kind === 'string')
        .map(item => ({ path: item.path as string, kind: item.kind as string })))
      setPath(next)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
      setEntries([])
    } finally {
      setBusy(false)
    }
  }, [remote, workspaceId])

  useEffect(() => { void loadDirectory('') }, [loadDirectory])

  const openFile = useCallback(async (next: string) => {
    if (workspaceId === undefined) return
    setBusy(true)
    setError(undefined)
    try {
      const payload = unwrap(await remote.cloudWorkspaces.workspaceFileContent(workspaceId, next))
      const content = (payload as { content?: unknown }).content
      setFile({ path: next, text: typeof content === 'string' ? content : '（非文本内容，暂不预览）' })
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setBusy(false)
    }
  }, [remote, workspaceId])

  if (workspaceId === undefined) {
    return <p className={css.note}>尚未选择云工作空间：先在工作台里选一个。</p>
  }

  return (
    <div className={css.pane}>
      <div className={css.bar}>
        <span className={css.path} title={workspaceId}>{path === '' ? '/' : path}</span>
        <button type="button" className={css.action} onClick={() => { void loadDirectory('') }}>刷新</button>
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
              onClick={() => { void (entry.kind === 'directory' ? loadDirectory(entry.path) : openFile(entry.path)) }}
            >
              {entry.kind === 'directory' ? '📁' : '📄'} {entry.path.split('/').pop() ?? entry.path}
            </button>
          </li>
        ))}
        {entries.length === 0 && <li className={css.note}>{busy ? '读取中…' : '目录为空'}</li>}
      </ul>
      <div className={css.preview}>
        {file === undefined
          ? <p className={css.note}>选一个文件以预览</p>
          : <pre className={css.content} aria-label="云文件预览">{file.text}</pre>}
      </div>
    </div>
  )
}
