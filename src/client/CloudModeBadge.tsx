import css from './CloudModeBadge.module.css'

/**
 * 会话标题栏右侧的**接管标志**（官方 `conversation.session.header.actions` 席位的占用者）。
 *
 * 所有者标注图：「接管后这里会出现一个已连接的标志，说明当前界面被云工作空间接管」。
 *
 * 为什么只显示一个静态事实：这个标志的作用是**让用户知道界面被接管了**，不是数据面板 ——
 * 它不读任何业务数据，因此不会因为某次读取失败而消失或闪烁（那会让"接管中"变得不可信）。
 * 数据状态由左栏的两段自己如实报告。
 * @returns 标志元素。
 */
export function CloudModeBadge() {
  return (
    <span className={css.badge} role="status" aria-label="当前界面由云工作空间接管">
      <span className={css.dot} aria-hidden="true" />
      云工作空间 · 已连接
    </span>
  )
}
