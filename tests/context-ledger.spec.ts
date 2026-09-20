import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
// 0.1.5 drift: AgentLoop.inject now also requires sessionProjections, which
// dsh-session-projection provides. On the 0.1.1-rc.2 sources the loop mounted
// without it; on this baseline an unmounted registry leaves the loop's fiber
// waiting on an unmet injection, so ctx.agentLoop never appears and every
// await ctx.agentLoop.create(...) call throws.
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { describe, expect, it } from 'vitest'
import type { Session } from '@deepseek-ai/dsh-session'
import {
  CONTEXT_LEDGER_SOURCES,
  ContextLedgerLoop,
  buildContextLedger,
  contextLedgerEvents,
} from '../src/context-ledger.ts'
import type { ContextLedgerEntryInput } from '../src/context-ledger.ts'
import { MockAdapter, textResponse } from './helpers/mock-adapter.ts'

// 1-4「上下文账本（仅记录部分）」验收（蓝图 §4.3）。
//
// 异常矩阵：
//   优先级     —— 八层来源固定：safety > org-policy > project-policy > agent-config >
//                 skill > knowledge > memory > user；账本条目按此排序，不受输入顺序影响。
//   记录→过滤 → 被权限过滤（suppressed）的条目不得注入（injected=false），
//                 且必须携带过滤原因；违例输入直接拒绝。
//   选择原因   —— 每条目必须携带 selectionReason，缺失即拒绝。
//   未知来源   —— 词表之外来源直接拒绝，不映射默认。
//   重建       —— 每次模型请求落一条 context-ledger 会话事件；从会话日志重建
//                 （contextLedgerEvents）与原始输入逐字一致。
//   空账本     —— 无候选条目的模型请求同样落事件（injectedCount=0），不跳过。

async function harness() {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  // 0.1.5 drift: satisfy AgentLoop's new sessionProjections injection.
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['mock'], new MockAdapter([textResponse('answer')]))
  return ctx
}

function waitForIdle(ctx: Context, agent: Agent): Promise<void> {
  return new Promise((resolve) => {
    const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject === agent && status === 'idle') {
        dispose()
        resolve()
      }
    })
  })
}

const baseEntry: ContextLedgerEntryInput = {
  source: 'knowledge',
  title: '知识条目',
  permission: 'allowed',
  selectionReason: '命中检索',
  injected: true,
}

describe('buildContextLedger 八层优先级', () => {
  it('固定八层排序，与输入顺序无关', () => {
    const ledger = buildContextLedger({
      turn: 1,
      step: 1,
      requestId: 'req-1',
      entries: [
        { ...baseEntry, source: 'memory', title: '记忆建议' },
        { ...baseEntry, source: 'safety', title: '安全规则' },
        { ...baseEntry, source: 'user', title: '用户补充' },
        { ...baseEntry, source: 'knowledge', title: '知识条目' },
        { ...baseEntry, source: 'org-policy', title: '组织策略' },
        { ...baseEntry, source: 'agent-config', title: 'Agent 配置' },
        { ...baseEntry, source: 'project-policy', title: '项目规则' },
        { ...baseEntry, source: 'skill', title: 'Skill 指令' },
      ],
    })
    expect(ledger.entries.map(entry => entry.source)).toEqual([
      'safety', 'org-policy', 'project-policy', 'agent-config', 'skill', 'knowledge', 'memory', 'user',
    ])
    expect(ledger.injectedCount).toBe(8)
  })

  it('被权限过滤的条目不得注入，且必须携带过滤原因', () => {
    const ledger = buildContextLedger({
      turn: 1,
      step: 1,
      requestId: 'req-2',
      entries: [
        { ...baseEntry, title: '允许的知识', injected: true },
        { ...baseEntry, title: '无权限的记忆', permission: 'suppressed', permissionReason: '项目未授权该记忆库', injected: false },
      ],
    })
    const suppressed = ledger.entries.filter(entry => entry.permission === 'suppressed')
    expect(suppressed.length).toBe(1)
    expect(suppressed.every(entry => !entry.injected)).toBe(true)
    expect(suppressed.every(entry => (entry.permissionReason ?? '').length > 0)).toBe(true)
    expect(ledger.injectedCount).toBe(1)
    // 声明注入的被过滤条目是协议违例：直接拒绝。
    expect(() => buildContextLedger({
      turn: 1,
      step: 1,
      requestId: 'req-2',
      entries: [
        { ...baseEntry, title: '越权的记忆', permission: 'suppressed', permissionReason: '项目未授权该记忆库', injected: true },
      ],
    })).toThrow(/不得注入/u)
  })

  it('词表之外来源与缺失选择原因直接拒绝（协议违例，不用默认值吞掉）', () => {
    expect(() => buildContextLedger({
      turn: 1, step: 1, requestId: 'r',
      entries: [{ ...baseEntry, source: 'telemetry' as never }],
    })).toThrow(/未知来源/u)
    expect(() => buildContextLedger({
      turn: 1, step: 1, requestId: 'r',
      entries: [{ ...baseEntry, selectionReason: '' }],
    })).toThrow(/缺少选择原因/u)
  })

  it('被过滤但未说明原因的条目直接拒绝（未说明一律不得当成无原因放行）', () => {
    expect(() => buildContextLedger({
      turn: 1, step: 1, requestId: 'r',
      entries: [{ ...baseEntry, title: '静默过滤的记忆', permission: 'suppressed', injected: false }],
    })).toThrow(/被过滤但缺少过滤原因/u)
    expect(() => buildContextLedger({
      turn: 1, step: 1, requestId: 'r',
      entries: [{ ...baseEntry, title: '空白原因的知识', permission: 'suppressed', permissionReason: '   ', injected: false }],
    })).toThrow(/被过滤但缺少过滤原因/u)
  })

  it('八层词表常量冻结且顺序固定', () => {
    expect([...CONTEXT_LEDGER_SOURCES]).toEqual([
      'safety', 'org-policy', 'project-policy', 'agent-config', 'skill', 'knowledge', 'memory', 'user',
    ])
  })
})

describe('ContextLedgerLoop 会话事件落账与重建', () => {
  it('每次模型请求落一条 context-ledger 事件，账本可从会话日志重建', async () => {
    const ctx = await harness()
    const agent = await ctx.agentLoop.create(SessionId('context-ledger'), { provider: 'mock', model: 'mock' })
    const loop = new ContextLedgerLoop(ctx, {
      collect: (subject: Agent, _session: Session) => {
        if (subject !== agent) return []
        return [
          { source: 'memory', title: '记忆建议：使用 pnpm', permission: 'allowed', selectionReason: '召回命中', injected: true },
          { source: 'safety', title: '平台安全规则', permission: 'allowed', selectionReason: '安全层始终注入', injected: true },
          { source: 'knowledge', title: '知识：发布流程', permission: 'suppressed', permissionReason: '用户未选择知识库', selectionReason: '无有效检索结果', injected: false },
        ]
      },
    })
    expect(loop).toBeDefined()

    agent.followup(createUserMessage({ content: [{ type: 'text', text: '继续任务' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)

    // 从会话日志重建：类型化读取 + 逐字一致。
    const rebuilt = contextLedgerEvents(agent.session)
    expect(rebuilt.length).toBe(1)
    const payload = rebuilt[0]!.data
    expect(payload.turn).toBe(1)
    expect(payload.requestId.length).toBeGreaterThan(0)
    expect(payload.entries.map(entry => entry.source)).toEqual([
      'safety', 'knowledge', 'memory',
    ])
    const knowledge = payload.entries.find(entry => entry.source === 'knowledge')!
    expect(knowledge.permission).toBe('suppressed')
    expect(knowledge.injected).toBe(false)
    expect(knowledge.permissionReason).toBe('用户未选择知识库')
    expect(payload.injectedCount).toBe(2)

    // 空候选的第二次模型请求同样落事件（不跳过）。
    loop.setCollector(() => [])
    agent.followup(createUserMessage({ content: [{ type: 'text', text: '再来一次' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)
    const afterSecond = contextLedgerEvents(agent.session)
    expect(afterSecond.length).toBe(2)
    expect(afterSecond[1]!.data.entries).toHaveLength(0)
    expect(afterSecond[1]!.data.injectedCount).toBe(0)
  })

  it('dispose 后不再落账（卸载监听，不留悬挂写入）', async () => {
    const ctx = await harness()
    const agent = await ctx.agentLoop.create(SessionId('context-ledger-disposed'), { provider: 'mock', model: 'mock' })
    const loop = new ContextLedgerLoop(ctx, {
      collect: () => [
        { source: 'safety', title: '平台安全规则', permission: 'allowed', selectionReason: '安全层始终注入', injected: true },
      ],
    })

    loop.dispose()
    agent.followup(createUserMessage({ content: [{ type: 'text', text: '卸载之后' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)

    expect(contextLedgerEvents(agent.session)).toHaveLength(0)
  })
})
