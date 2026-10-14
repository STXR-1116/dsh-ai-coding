/**
 * 会话记录区 —— 工作台**左栏上方**那块（所有者规格：左上是会话记录区、左下是文件列表区）。
 *
 * ## 数据来源：平台会话列表（所有者 2026-09-22 选定 B 方案）
 *
 * 这块显示的是**服务端返回的会话列表**（每个云工作空间自己的会话记录），不是 DSH 本地会话。
 * 该接口属于 `docs/backend-api-requirements.md` §3.1（会话与 LLM 输出）——**后端尚未提供**，
 * 所以现在渲染**明确的"待接通"空态**，而不是把自己伪装成"没有记录"：两者是不同的状态，
 * 混淆会让使用者以为工作空间真的没有会话。
 *
 * ## 一个踩过的坑：不要用 `role="status"`
 *
 * 第一版给"待接通"提示加了 `role="status"`，于是页面上出现第二个 status 元素，直接打红了
 * `run-asset-snapshot.client.spec.tsx` 里 `findByRole('status')` 那条断言（"找到多个元素"）。
 * 这条提示是**静态说明**、不是实时更新，本就不需要 live region —— 现在只用普通段落。
 * （诊断代价：一次全量红 + 一次重跑，根因是一行 ARIA 属性。）
 *
 * @module dsh-ai-coding/client/cloud-workspaces/SessionRecords
 */

import css from './SessionRecords.module.css'

/** 一条会话记录（字段按后端接口要求 §3.1 的语义命名，接口落地后按实际形状收敛）。 */
export interface SessionRecord {
  /** 服务端返回的稳定、不透明会话标识。 */
  readonly sessionId: string
  /** 展示用标题（服务端给，不由前端拼）。 */
  readonly title: string
  /** 最近活动时间（服务端时间为准）。 */
  readonly updatedAt?: string
}

/** 会话记录区 props。 */
export interface SessionRecordsProps {
  /**
   * 当前云工作空间的会话记录。
   *
   * `undefined` 表示**接口尚未接通**；空数组表示**确实没有记录** —— 两者显示不同的文案。
   */
  readonly sessions?: readonly SessionRecord[]
  /** 选中一条会话（B 段接上数据后启用）。 */
  readonly onSelect?: (sessionId: string) => void
  /** 当前选中的会话。 */
  readonly selectedSessionId?: string
  /**
   * 读取失败的原因（就地显示）。
   *
   * 该读取是**次要面板**的数据：失败只影响这一块，不该顶成页面级错误横幅 ——
   * 那会盖住页面上真正重要的错误，而且真后端可能尚未实现该端点。
   */
  readonly error?: string
}

/**
 * 渲染会话记录区。
 * @param props - 会话记录与选择回调。
 * @returns 会话记录区。
 */
export function SessionRecords({ sessions, onSelect, selectedSessionId, error }: SessionRecordsProps) {
  return (
    <section className={css.pane} aria-label="会话记录区">
      <p className={css.title}>会话记录</p>
      {error !== undefined && <p className={css.failed} role="alert">{error}</p>}
      {error === undefined && sessions === undefined && (
        <p className={css.pending}>
          等待服务端提供平台会话列表接口（见 <code>docs/backend-api-requirements.md</code> §3.1）。
        </p>
      )}
      {sessions !== undefined && sessions.length === 0 && (
        <p className={css.empty}>这个工作空间还没有会话记录。</p>
      )}
      {sessions !== undefined && sessions.length > 0 && (
        <ul className={css.list}>
          {sessions.map(session => (
            <li key={session.sessionId}>
              <button
                type="button"
                className={session.sessionId === selectedSessionId ? css.itemActive : css.item}
                aria-current={session.sessionId === selectedSessionId ? 'true' : undefined}
                onClick={() => { onSelect?.(session.sessionId) }}
              >
                <span className={css.itemTitle}>{session.title}</span>
                {session.updatedAt !== undefined && <span className={css.itemTime}>{session.updatedAt}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
