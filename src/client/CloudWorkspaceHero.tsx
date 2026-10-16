import { useEffect, useState } from 'react'
import { readSelection, subscribeSelection } from './cloud-workspaces/cloud-files-state.ts'
import css from './CloudWorkspaceHero.module.css'

/**
 * 空白会话页里那块**工作区控制**的接管版（官方席位 `conversation.hero.workspace`）。
 *
 * 起因（所有者）：「为什么我在云工作空间里点击会话，跳出来选择的工程还是本地的？整个会话页面的
 * 数据都应该来自于后端。」—— 那块控件是外壳的席位（`kind: 'single'`、`scope: 'root'`），
 * 默认列的是 **DSH 本地工作区**。手册明确「复用已有 cell 表示**有意替换其展示**」，
 * 所以在接管期间用**云工作空间**替换它，退出时随注册一并撤销。
 *
 * 只读而不是再造一个选择器：工作空间的切换入口在**接管后的左栏**（平台会话记录 + 文件列表），
 * 这里的作用是**如实说明"当前会话属于哪个云工作空间"**，而不是再长一个与左栏打架的下拉。
 * @returns 云工作空间标签。
 */
export function CloudWorkspaceHero() {
  const [workspaceId, setWorkspaceId] = useState<string | undefined>(() => readSelection()?.workspaceId)
  useEffect(() => subscribeSelection(() => { setWorkspaceId(readSelection()?.workspaceId) }), [])

  return (
    <span className={css.chip} title="本会话的工程来自云工作空间（后端），不是本地工作区">
      <span className={css.label}>云工作空间</span>
      <span className={css.value}>{workspaceId ?? '未选中'}</span>
    </span>
  )
}
