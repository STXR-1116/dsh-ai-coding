import { useEffect, useState } from 'react'
import type { PlatformRemote } from './remote/types.ts'
import type { WorkspaceFileEntry, WorkspaceSessionRecord } from '../types.ts'
import { readSelection, subscribeSelection } from './cloud-workspaces/cloud-files-state.ts'
import { SessionRecords } from './cloud-workspaces/SessionRecords.tsx'
import { FileTreeView } from './cloud-workspaces/FileTreeView.tsx'
import { SlotBoundary } from './slot-boundary.tsx'
import css from './CloudSidebar.module.css'

/**
 * **接管模式下的左栏**：官方 `sidebar.workspaces` 单席位的临时占用者。
 *
 * 形态（所有者标注图）：上 = **后端返回的会话记录**，下 = **文件列表**，底部 = 退出接管。
 *
 * 依据：`reference/subsystems/slots` —— 该席位是 `single`，「渲染当前 **priority 胜者**」，
 * 遮蔽只替换渲染者、不改声明；owner props 由官方包声明为 `{ wide, expandSidebar }`
 * （**手册未覆盖，依据随包类型 + 实测**）：`wide` 为假时是 rail，占用者要自己画一个图标。
 *
 * 数据只来自本插件的远程面（真实部署即后端服务），**不读 DSH 本地会话列表**。
 */

/** 官方 owner props 里我们用到的两项。 */
export interface CloudSidebarOwnerProps {
  /** Shell fold-state output: wide renders the full browser, rail the icon column. */
  readonly wide?: boolean
  /** Rail icons request expansion. */
  readonly expandSidebar?: () => void
}

/** 面板 props：注册时注入的远程面 + 退出回调 + 官方 owner props。 */
export interface CloudSidebarProps extends CloudSidebarOwnerProps {
  /** 本插件的浏览器侧远程面。 */
  readonly remote: PlatformRemote
  /** 退出接管（由模式控制器提供）。 */
  readonly onExit?: () => void
  /**
   * 点某条平台会话记录 ⇒ 把中央切到该会话（T3）。
   *
   * 参数带上工作空间 id：面板自己知道当前选的是哪个工作空间，调用方（index）只需要
   * "映射 + 打开"这一件事 —— 免得两处各自读一遍共享通道、各自解读。
   */
  readonly onSelectPlatformSession?: (workspaceId: string, platformSessionId: string) => void
}

/**
 * 左栏正文。
 * @param props - 见 {@link CloudSidebarProps}。
 * @returns 会话记录 + 文件列表 + 退出。
 */
export function CloudSidebar({ remote, onExit, onSelectPlatformSession, wide = true, expandSidebar }: CloudSidebarProps) {
  const [workspaceId, setWorkspaceId] = useState<string | undefined>(() => readSelection()?.workspaceId)
  useEffect(() => subscribeSelection(() => { setWorkspaceId(readSelection()?.workspaceId) }), [])

  const [records, setRecords] = useState<readonly WorkspaceSessionRecord[] | undefined>(undefined)
  const [recordsError, setRecordsError] = useState<string | undefined>(undefined)
  // 当前选中的平台会话：只用于左栏高亮（中央显示哪条由外壳的当前会话决定）。
  const [selectedPlatformSession, setSelectedPlatformSession] = useState<string | undefined>(undefined)
  const [items, setItems] = useState<readonly WorkspaceFileEntry[]>([])
  const [filesError, setFilesError] = useState<string | undefined>(undefined)

  useEffect(() => {
    if (workspaceId === undefined) return
    let cancelled = false
    // 会话记录：平台返回什么就显示什么；每种非 ready 都要说出原因（不是"空列表"）。
    void remote.cloudWorkspaces.workspaceSessionRecords(workspaceId)
      .then((result) => {
        if (cancelled) return
        if (!result.ok) { setRecordsError(`会话记录不可读：${result.error.message}`); return }
        const value = result.value as {
          status?: string
          value?: readonly WorkspaceSessionRecord[]
          code?: string
          message?: string
        }
        if (value.status === 'ready') { setRecords(value.value ?? []); setRecordsError(undefined); return }
        setRecordsError(value.status === 'failed'
          ? `${value.code ?? 'FAILED'}：${value.message ?? '读取失败'}`
          : value.status === 'signed-out' ? '尚未登录：会话记录暂不可读。' : '服务未就绪：会话记录暂不可读。')
      })
      .catch((error: unknown) => { if (!cancelled) setRecordsError(`会话记录不可读：${String(error)}`) })
    // 文件列表：平台目录读。
    void remote.cloudWorkspaces.workspaceFiles(workspaceId, '')
      .then((result) => {
        if (cancelled) return
        if (!result.ok) { setFilesError(`目录不可读：${result.error.message}`); return }
        const value = result.value as {
          status?: string
          value?: { items?: readonly WorkspaceFileEntry[] }
          code?: string
          message?: string
        }
        if (value.status === 'ready') { setItems(value.value?.items ?? []); setFilesError(undefined); return }
        setFilesError(value.status === 'failed'
          ? `${value.code ?? 'FAILED'}：${value.message ?? '读取失败'}`
          : '服务未就绪：目录暂不可读。')
      })
      .catch((error: unknown) => { if (!cancelled) setFilesError(`目录不可读：${String(error)}`) })
    return () => { cancelled = true }
  }, [remote, workspaceId])

  // 收窄成 rail 时只画一个图标：官方契约把窄态的呈现交给占用者。
  if (!wide) {
    return (
      <button type="button" className={css.rail} aria-label="展开云工作空间" onClick={() => { expandSidebar?.() }}>
        <span aria-hidden="true">☁</span>
      </button>
    )
  }

  return (
    <div className={css.sidebar}>
      <SessionRecords
        {...(records === undefined ? {} : { sessions: records })}
        {...(recordsError === undefined ? {} : { error: recordsError })}
        {...(selectedPlatformSession === undefined ? {} : { selectedSessionId: selectedPlatformSession })}
        onSelect={(platformSessionId) => {
          // 先给左栏反馈（高亮立刻变），再请调用方切中央的会话 —— 点击的即时感不依赖异步映射。
          setSelectedPlatformSession(platformSessionId)
          if (workspaceId !== undefined) onSelectPlatformSession?.(workspaceId, platformSessionId)
        }}
      />
      <section className={css.files} aria-label="文件列表">
        <h3 className={css.filesTitle}>文件列表</h3>
        {filesError !== undefined && <p className={css.failed} role="alert">{filesError}</p>}
        {filesError === undefined && workspaceId === undefined && (
          <p className={css.hint}>还没有选中工作空间 —— 在插件里选中一个即可。</p>
        )}
        {filesError === undefined && workspaceId !== undefined && (
          <FileTreeView
            remote={remote}
            workspaceId={workspaceId}
            rootItems={items}
            // 接管期间一律可交互：工作空间是否 ready 的问题由上面的错误段如实报告，
            // 而不是把树灰掉（那看起来像"这棵树坏了"）。
            disabled={false}
            // 打开文件走**原生预览**：那需要会话作用域的文件地址（`dsh-resource://file/…`），
            // 云文件目前还不是 DSH 资源 —— 本段先只做浏览，接线见设计稿 §5/§6。
            onOpenFile={() => { /* 边界：原生预览待资源接线 */ }}
            onRefresh={() => { /* 重新进入接管即刷新 */ }}
          />
        )}
      </section>
      <div className={css.foot}>
        <button type="button" className={css.exit} onClick={() => { onExit?.() }}>退出云工作空间</button>
      </div>
    </div>
  )
}

/**
 * 注册用的占用者：把左栏正文包进**错误边界**。
 *
 * 为什么必须有这一层（实测教训）：左栏正文一旦抛错，会让**整条注册条目弃权** ——
 * 注册表的 `abdicated`（WeakSet）由崩溃上报驱动，条目在本次注册生命期内不再进入
 * `entriesOfSlot` 投影，于是**官方占用者继续渲染**：界面上看不到任何变化、控制台也没有 React 报错
 * （上报走 slot runtime 自己的 logger），排查时极易误判成"遮蔽没生效"。
 * 有边界之后：错误被接住、不上报 ⇒ 不弃权；同时把失败**显示出来**而不是静默。
 * @param props - 与 {@link CloudSidebar} 相同。
 * @returns 带边界的左栏。
 */
export function CloudSidebarSlot(props: CloudSidebarProps) {
  return (
    <SlotBoundary
      slot="sidebar.workspaces"
      fallback={(
        <p className={css.failed} role="alert">
          云工作空间左栏渲染失败 —— 详见控制台里 <code>[dsh-ai-coding]</code> 的错误。
        </p>
      )}
    >
      <CloudSidebar {...props} />
    </SlotBoundary>
  )
}
