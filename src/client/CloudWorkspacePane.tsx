import { useEffect, useState } from 'react'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import type { PlatformRemote } from './remote/types.ts'
import type { TeamSkillProject } from '../types.ts'
import { CloudWorkspacesView } from './cloud-workspaces/CloudWorkspacesView.tsx'
import css from './CloudWorkspacePane.module.css'

/**
 * 右栏的「云工作空间」面板（方案 A 的产品面落点）。
 *
 * 所有者选定 A：**中央列永远是外壳的原生会话区**，插件的产品面进右栏的 pane ——
 * 与「云文件」「预览」并列。
 *
 * 这里**复用** `CloudWorkspacesView`（`presentation='management'` 只渲染管理列）而不是重写：
 * 生命周期那些动作的并发/幂等/错误语义都在那个组件里，复制一份必然漂移。
 *
 * 为什么这里不负责登录/配置面：`PlatformSurfaceEntry` 是**浮层席位的占用者**，需要那个席位的
 * runtime props（`renderSlot` 等），不能当普通组件在别的席位里渲染 —— 实测类型就不通过。
 * 因此登录/配置仍由**浮层面**承担，这个 pane 只做已就绪之后的管理面。
 */

/** 视图要求的 hook 形状；它自己不使用（`useWorkspaces: _useWorkspaces`），所以给一个空快照桩。 */
const NO_WORKSPACES = ((selector: (state: { items: readonly never[] }) => unknown) =>
  selector({ items: [] })) as unknown as SnapshotSelectorHook<never>

/**
 * 面板正文。
 * @param props - 注册时注入的远程面。
 * @returns 管理面（工作空间列表 / 生命周期 / 运行与审批 / 会话记录）。
 */
export function CloudWorkspacePane({ remote }: { readonly remote: PlatformRemote }) {
  const [projects, setProjects] = useState<readonly TeamSkillProject[]>([])
  const [accountId, setAccountId] = useState<string | undefined>(undefined)

  useEffect(() => {
    let cancelled = false
    // 账号身份供会话映射（A1）用，项目列表给管理面提供项目维度。
    // 任一读取失败都只是"少一块上下文"，不让面板整体失败 —— 与视图既有的取向一致。
    void remote.teamSkills.account()
      .then((result) => {
        if (cancelled || !result.ok) return
        // `RemoteResult.value` 就是账号本身（与 PlatformSurface 的 consumeAccount(result.value) 一致）。
        const userId = (result.value as { user?: { userId?: string } }).user?.userId
        if (typeof userId === 'string') setAccountId(userId)
      })
      .catch(() => { /* 读不到就没有账号维度 */ })
    void remote.teamSkills.projects()
      .then((result) => {
        if (cancelled || !result.ok) return
        // 同样：`value` 就是项目列表（PlatformSurface 里 projectsResult.value.filter(...)）。
        const list = result.value as readonly TeamSkillProject[]
        setProjects(list.filter(item => item.status === 'active'))
      })
      .catch(() => { /* 读不到就没有项目维度 */ })
    return () => { cancelled = true }
  }, [remote])

  return (
    <div className={css.pane}>
      <CloudWorkspacesView
        remote={remote}
        useWorkspaces={NO_WORKSPACES as never}
        projects={projects}
        presentation="management"
        {...(accountId === undefined ? {} : { accountId })}
      />
    </div>
  )
}
