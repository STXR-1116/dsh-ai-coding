/* 覆盖补齐：知识检索会话记录的不变量伴随插件的两条 fail 分支。
 *
 * 该伴随插件此前只被「注册成功」这一路覆盖（重复注册抛错），它真正的判据——
 * 空的知识库选择/查询、以及事件报告了选中集合之外的知识库——从未被执行。
 * 这两条正是 §11.3 契约探针要守的东西，必须按真实会话事件驱动。
 */
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore from '@deepseek-ai/dsh-session'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import * as PlatformInvariant from '../src/invariant.ts'

const VIOLATION = /invariant violated by "dsh-ai-coding"/u

interface SearchOverrides {
  readonly query?: string
  readonly knowledgeBaseIds?: readonly string[]
  readonly reportedBaseIds?: readonly string[]
}

async function setup(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(InvariantRegistry)
  await ctx.plugin(PlatformInvariant)
  return ctx
}

/** 以 knowledge-loop 的真实形状追加一条知识检索事件。 */
function appendSearch(ctx: Context, overrides: SearchOverrides = {}): void {
  const session = ctx.sessions.create()
  session.append('knowledge-search', {
    turn: 1,
    step: 1,
    query: overrides.query ?? '如何发布？',
    knowledgeBaseIds: [...(overrides.knowledgeBaseIds ?? ['k-1'])],
    requestId: 'req-1',
    knowledgeBases: (overrides.reportedBaseIds ?? ['k-1']).map(knowledgeBaseId => ({
      knowledgeBaseId,
      status: 'used' as const,
      reason: null,
    })),
    results: [],
  })
}

describe('ai-coding-platform invariant companion', () => {
  it('accepts a knowledge-search event whose bases are inside the selected set', async () => {
    const ctx = await setup()
    expect(() => { appendSearch(ctx) }).not.toThrow()
    await ctx.fiber.dispose()
  })

  it('fails an event with an empty knowledge selection', async () => {
    const ctx = await setup()
    expect(() => { appendSearch(ctx, { knowledgeBaseIds: [] }) }).toThrow(VIOLATION)
    await ctx.fiber.dispose()
  })

  it('fails an event whose query is blank', async () => {
    const ctx = await setup()
    expect(() => { appendSearch(ctx, { query: '   ' }) }).toThrow(VIOLATION)
    await ctx.fiber.dispose()
  })

  it('fails an event reporting a knowledge base outside the selected set', async () => {
    const ctx = await setup()
    expect(() => {
      appendSearch(ctx, { knowledgeBaseIds: ['k-1'], reportedBaseIds: ['k-1', 'k-9'] })
    }).toThrow(VIOLATION)
    await ctx.fiber.dispose()
  })

  it('leaves other session events alone', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create()
    expect(() => { session.append('turn/start', { turn: 1 }) }).not.toThrow()
    await ctx.fiber.dispose()
  })
})
