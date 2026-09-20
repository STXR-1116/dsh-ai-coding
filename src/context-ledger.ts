import { randomUUID } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'

/**
 * 上下文账本的固定八层来源优先级（蓝图 §4.3）：safety > org-policy >
 * project-policy > agent-config > skill > knowledge > memory > user。顺序即
 * 优先级——账本条目按此排序输出，与候选收集顺序无关。
 */
export const CONTEXT_LEDGER_SOURCES = [
  'safety',
  'org-policy',
  'project-policy',
  'agent-config',
  'skill',
  'knowledge',
  'memory',
  'user',
] as const

/** 账本条目来源：八层固定词表之一。 */
export type ContextLedgerSource = (typeof CONTEXT_LEDGER_SOURCES)[number]

/** 权限过滤结果：allowed 进入注入评估；suppressed 必须携带原因且不得注入。 */
export type ContextLedgerPermission = 'allowed' | 'suppressed'

/** 一次模型请求的单条账目输入。 */
export interface ContextLedgerEntryInput {
  readonly source: ContextLedgerSource
  readonly title: string
  readonly permission: ContextLedgerPermission
  /** 权限过滤原因；permission 为 suppressed 时必填。 */
  readonly permissionReason?: string
  /** 选择原因：为什么这条（或为什么不）进入最终注入。 */
  readonly selectionReason: string
  /** 是否最终注入模型请求。 */
  readonly injected: boolean
}

/** 一次模型请求的完整账本。 */
export interface ContextLedger {
  readonly turn: number
  readonly step: number
  readonly requestId: string
  readonly entries: ReadonlyArray<{
    readonly source: ContextLedgerSource
    readonly title: string
    readonly permission: ContextLedgerPermission
    readonly permissionReason: string | null
    readonly selectionReason: string
    readonly injected: boolean
  }>
  readonly injectedCount: number
}

const SOURCE_RANK = new Map<ContextLedgerSource, number>(CONTEXT_LEDGER_SOURCES.map((source, index) => [source, index]))

/**
 * 构建一次模型请求的上下文账本：按固定八层优先级排序条目，并强制
 * 「记录 → 权限过滤 → 选择原因 → 最终注入」的先后约束——被过滤的条目不得注入。
 * @param input - 回合、步骤、请求标识与候选条目。
 * @returns 排序后的不可变账本。
 * @throws Error 当来源不在八层词表、suppressed 条目缺过滤原因、suppressed 却
 *   声明注入、或 selectionReason 缺失时——这些是调用方的协议违例，不允许用
 *   默认值吞掉。
 */
export function buildContextLedger(input: {
  readonly turn: number
  readonly step: number
  readonly requestId: string
  readonly entries: readonly ContextLedgerEntryInput[]
}): ContextLedger {
  // 校验与归一化一趟做完：排序需要的层级序号、以及 suppressed 条目的原因，
  // 都在这里一次性算出来，后面的排序与投影就不必再处理「查不到 / 可能为空」。
  const ranked = input.entries.map((entry) => {
    const rank = SOURCE_RANK.get(entry.source)
    if (rank === undefined) {
      throw new Error(`context-ledger: 未知来源 ${JSON.stringify(entry.source)}，不在八层固定词表中`)
    }
    let permissionReason: string | null = null
    if (entry.permission === 'suppressed') {
      if (entry.injected) {
        throw new Error(`context-ledger: 条目「${entry.title}」已被权限过滤，不得注入`)
      }
      const reason = entry.permissionReason
      if (reason === undefined || reason.trim().length === 0) {
        throw new Error(`context-ledger: 条目「${entry.title}」被过滤但缺少过滤原因`)
      }
      permissionReason = reason
    }
    if (entry.selectionReason.trim().length === 0) {
      throw new Error(`context-ledger: 条目「${entry.title}」缺少选择原因`)
    }
    return { entry, rank, permissionReason }
  })
  const entries = ranked
    .sort((left, right) => left.rank - right.rank)
    .map(({ entry, permissionReason }) => Object.freeze({
      source: entry.source,
      title: entry.title,
      permission: entry.permission,
      permissionReason,
      selectionReason: entry.selectionReason,
      injected: entry.injected,
    }))
  return Object.freeze({
    turn: input.turn,
    step: input.step,
    requestId: input.requestId,
    entries,
    injectedCount: entries.filter(entry => entry.injected).length,
  })
}

/**
 * 从会话日志重建全部上下文账本（完成判定：账本可从会话日志重建）。
 * @param session - 已加载的会话。
 * @returns 按记录顺序排列的 context-ledger 事件。
 */
export function contextLedgerEvents(session: Session): readonly SessionEvent<'context-ledger'>[] {
  return session.events.filter((event): event is SessionEvent<'context-ledger'> => event.type === 'context-ledger')
}

/**
 * 上下文账本记录回路（仅记录，不强制拦截——蓝图 §4.3）：每次模型请求前收集
 * 候选条目，构建账本并追加为 `context-ledger` 会话事件。空候选同样落事件。
 */
export class ContextLedgerLoop {
  private readonly disposeListener: () => void
  private collector: (agent: Agent, session: Session) => readonly ContextLedgerEntryInput[]

  constructor(
    ctx: Context,
    options: {
      /** 返回本次模型请求的候选条目；空数组表示无候选（仍落事件）。 */
      readonly collect: (agent: Agent, session: Session) => readonly ContextLedgerEntryInput[]
    },
  ) {
    this.collector = options.collect
    this.disposeListener = ctx.on('agent/pre-step', async ({ agent, turn, step }, next) => {
      const requestId = `ledger-${randomUUID()}`
      const ledger = buildContextLedger({
        turn,
        step,
        requestId,
        entries: this.collector(agent, agent.session),
      })
      agent.session.append('context-ledger', {
        turn: ledger.turn,
        step: ledger.step,
        requestId: ledger.requestId,
        entries: ledger.entries.map(entry => ({ ...entry })),
        injectedCount: ledger.injectedCount,
      })
      return next()
    })
  }

  /** 替换候选收集函数（测试与运行时热更新用）。 */
  /**
   * 替换候选收集函数（测试与运行时热更新用）。
   * @param collect - 新的候选收集函数。
   */
  setCollector(collect: (agent: Agent, session: Session) => readonly ContextLedgerEntryInput[]): void {
    this.collector = collect
  }

  /** 卸载监听。 */
  dispose(): void {
    this.disposeListener()
  }
}
