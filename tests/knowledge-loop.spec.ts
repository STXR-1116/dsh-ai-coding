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
/* oxlint-disable typescript/no-unsafe-assignment -- Vitest asymmetric matchers are typed as any. */
import { TeamSkillKnowledgeLoop, knowledgeSearchEvents } from '../src/knowledge-loop.ts'
import type { TeamSkillKnowledgeSearchResponse } from '../src/types.ts'
import { MockAdapter, textResponse } from './helpers/mock-adapter.ts'

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

function ask(agent: Agent, text: string): void {
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
}

const usedResponse: TeamSkillKnowledgeSearchResponse = {
  requestId: 'req-1',
  results: [
    {
      knowledgeBaseId: 'k-1',
      knowledgeId: 'doc-1',
      title: '发布流程',
      snippet: '先提交审核',
      score: 0.9,
      sourceUrl: '/preview/doc-1',
      version: 'v1',
      updatedAt: '2026-09-15T08:00:00.000Z',
      citation: { page: 1 },
    },
  ],
  knowledgeBases: [{ knowledgeBaseId: 'k-1', status: 'used', reason: null }],
}

describe('TeamSkillKnowledgeLoop', () => {
  it('skips retrieval for a pre-step that carries no user-sourced message', async () => {
    const ctx = await harness()
    const agent = await ctx.agentLoop.create(SessionId('knowledge-no-user'), { provider: 'mock', model: 'mock' })
    let searched = 0
    const loop = new TeamSkillKnowledgeLoop(ctx, {
      resolveSelection: subject => (subject === agent ? { projectId: 'project-alpha', knowledgeBaseIds: ['k-1'] } : undefined),
      search: async () => {
        searched += 1
        return { status: 'ready', response: usedResponse }
      },
    })

    // §11.15 前步骤的消息来自 inbox claim，类型上允许合并扩展出非 user 来源；
    // 这样的预步骤没有可检索的用户问句，必须跳过检索且不阻断回合。
    agent.followup(
      createUserMessage({
        content: [{ type: 'text', text: 'plugin-sourced pre-step message' }],
        source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-test-harness', form: 'relay' },
      }),
    )
    await waitForIdle(ctx, agent)

    expect(searched).toBe(0)
    expect(agent.session.ownEvents().some(event => event.type === 'knowledge-search')).toBe(false)
    expect(agent.session.ownEvents().some(event => event.type === 'assistant/message')).toBe(true)
    loop.dispose()
  })


  it('retrieves each user turn, records a knowledge-search event, and injects cited context', async () => {
    const ctx = await harness()
    const calls: Array<{ query: string; signal: AbortSignal }> = []
    const agent = await ctx.agentLoop.create(SessionId('knowledge-loop'), { provider: 'mock', model: 'mock' })
    const loop = new TeamSkillKnowledgeLoop(ctx, {
      resolveSelection: subject => (subject === agent ? { projectId: 'project-alpha', knowledgeBaseIds: ['k-1'] } : undefined),
      search: async (request, signal) => {
        calls.push({ query: request.query, signal })
        return { status: 'ready', response: usedResponse }
      },
    })

    ask(agent, '如何发布？')
    await waitForIdle(ctx, agent)

    expect(calls).toHaveLength(1)
    expect(calls[0]?.query).toBe('如何发布？')
    expect(agent.session.ownEvents()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'knowledge-search',
          data: expect.objectContaining({ requestId: 'req-1', knowledgeBaseIds: ['k-1'] }),
        }),
        expect.objectContaining({
          type: 'user/message',
          data: expect.objectContaining({ source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-ai-coding-platform', form: 'recall' } }),
        }),
      ]),
    )
    loop.dispose()
  })

  it('rejects the model request when every selected knowledge base is skipped', async () => {
    const skipped: TeamSkillKnowledgeSearchResponse = {
      requestId: 'req-2',
      results: [],
      knowledgeBases: [{ knowledgeBaseId: 'k-1', status: 'skipped', reason: 'unavailable' }],
    }
    const ctx = await harness()
    let modelRequests = 0
    ctx.llm.stream = async function* () {
      modelRequests += 1
    } as never
    const agent = await ctx.agentLoop.create(SessionId('knowledge-block'), { provider: 'mock', model: 'mock' })
    const loop = new TeamSkillKnowledgeLoop(ctx, {
      resolveSelection: subject => (subject === agent ? { projectId: 'project-alpha', knowledgeBaseIds: ['k-1'] } : undefined),
      search: async () => ({ status: 'ready', response: skipped }),
    })

    ask(agent, '不可用资料')
    await waitForIdle(ctx, agent)

    expect(modelRequests).toBe(0)
    expect(agent.session.ownEvents().find(event => event.type === 'turn/end')).toMatchObject({ data: { reason: { kind: 'blocked' } } })
    loop.dispose()
  })

  it('passes the turn abort signal to the search and does not retain an aborted response', async () => {
    const ctx = await harness()
    const started = Promise.withResolvers<AbortSignal>()
    const release = Promise.withResolvers<never>()
    const agent = await ctx.agentLoop.create(SessionId('knowledge-abort'), { provider: 'mock', model: 'mock' })
    const loop = new TeamSkillKnowledgeLoop(ctx, {
      resolveSelection: subject => (subject === agent ? { projectId: 'project-alpha', knowledgeBaseIds: ['k-1'] } : undefined),
      search: async (_request, signal) => {
        started.resolve(signal)
        return release.promise
      },
    })

    ask(agent, '等待检索')
    const signal = await started.promise
    agent.cancel({ kind: 'user' })

    expect(signal.aborted).toBe(true)
    release.reject(signal.reason)
    await agent.whenIdle()
    expect(agent.session.ownEvents().some(event => event.type === 'knowledge-search')).toBe(false)
    loop.dispose()
  })

  it('records one skipped row per selected base for every not-ready outcome and blocks the request', async () => {
    // 三种「检索没跑成」各自折叠成一个跳过原因：signed-out 是权限、not-ready 是依赖未就绪、
    // 其余（含 failed）归为外部错误。三条都必须留痕并把请求挡下来，不得静默当成无命中。
    const outcomes = [
      { status: 'failed', reason: 'external_error', result: { status: 'failed', code: 'DOWNSTREAM', message: 'down' } },
      { status: 'not-ready', reason: 'unavailable', result: { status: 'not-ready', missing: ['account'] } },
      { status: 'signed-out', reason: 'forbidden', result: { status: 'signed-out' } },
    ] as const

    for (const outcome of outcomes) {
      const ctx = await harness()
      let modelRequests = 0
      ctx.llm.stream = async function* () {
        modelRequests += 1
      } as never
      const agent = await ctx.agentLoop.create(SessionId(`knowledge-${outcome.status}`), { provider: 'mock', model: 'mock' })
      const loop = new TeamSkillKnowledgeLoop(ctx, {
        resolveSelection: subject => (subject === agent ? { projectId: 'project-alpha', knowledgeBaseIds: ['k-1', 'k-2'] } : undefined),
        search: async () => outcome.result,
      })

      ask(agent, '不可用资料')
      await waitForIdle(ctx, agent)

      expect(agent.session.ownEvents().find(event => event.type === 'knowledge-search')).toMatchObject({
        data: {
          requestId: expect.stringContaining('failed-'),
          knowledgeBaseIds: ['k-1', 'k-2'],
          knowledgeBases: [
            { knowledgeBaseId: 'k-1', status: 'skipped', reason: outcome.reason },
            { knowledgeBaseId: 'k-2', status: 'skipped', reason: outcome.reason },
          ],
          results: [],
        },
      })
      expect(modelRequests).toBe(0)
      loop.dispose()
    }
  }, 30_000)

  it('lets a search that found nothing skip the injection without blocking the turn', async () => {
    // 有知识库参与了、只是没有命中：这不是失败，运行必须照常继续。
    const noHits: TeamSkillKnowledgeSearchResponse = {
      requestId: 'req-4',
      results: [],
      knowledgeBases: [{ knowledgeBaseId: 'k-1', status: 'no_hits', reason: null }],
    }
    const ctx = await harness()
    const agent = await ctx.agentLoop.create(SessionId('knowledge-no-hits'), { provider: 'mock', model: 'mock' })
    const loop = new TeamSkillKnowledgeLoop(ctx, {
      resolveSelection: subject => (subject === agent ? { projectId: 'project-alpha', knowledgeBaseIds: ['k-1'] } : undefined),
      search: async () => ({ status: 'ready', response: noHits }),
    })

    ask(agent, '没有资料的问题')
    await waitForIdle(ctx, agent)

    expect(agent.session.ownEvents().some(event => event.type === 'assistant/message')).toBe(true)
    expect(agent.session.ownEvents().some(
      event => event.type === 'user/message' && event.data.source.kind === 'plugin',
    )).toBe(false)
    loop.dispose()
  })

  it('reconstructs the durable knowledge-search events from the session log', async () => {
    const ctx = await harness()
    const agent = await ctx.agentLoop.create(SessionId('knowledge-rebuild'), { provider: 'mock', model: 'mock' })
    const loop = new TeamSkillKnowledgeLoop(ctx, {
      resolveSelection: subject => (subject === agent ? { projectId: 'project-alpha', knowledgeBaseIds: ['k-1'] } : undefined),
      search: async () => ({ status: 'ready', response: usedResponse }),
    })

    ask(agent, '如何发布？')
    await waitForIdle(ctx, agent)

    expect(knowledgeSearchEvents(agent.session)).toHaveLength(1)
    loop.dispose()
  })

  it('omits an absent skip reason, an absent citation and an unknown page instead of writing nulls', async () => {
    const response: TeamSkillKnowledgeSearchResponse = {
      requestId: 'req-3',
      results: [
        {
          knowledgeBaseId: 'k-1', knowledgeId: 'doc-2', title: '无页码', snippet: '片段二', score: 0.5,
          sourceUrl: '/preview/doc-2', version: 'v1', updatedAt: '2026-09-15T08:00:00.000Z', citation: { chunk: 'c-1' },
        },
        {
          knowledgeBaseId: 'k-1', knowledgeId: 'doc-3', title: '无引用', snippet: '片段三', score: 0.4,
          sourceUrl: '/preview/doc-3', version: 'v1', updatedAt: '2026-09-15T08:00:00.000Z',
        },
      ],
      knowledgeBases: [{ knowledgeBaseId: 'k-1', status: 'used' } as never],
    }
    const ctx = await harness()
    const agent = await ctx.agentLoop.create(SessionId('knowledge-absent'), { provider: 'mock', model: 'mock' })
    const loop = new TeamSkillKnowledgeLoop(ctx, {
      resolveSelection: subject => (subject === agent ? { projectId: 'project-alpha', knowledgeBaseIds: ['k-1'] } : undefined),
      search: async () => ({ status: 'ready', response }),
    })

    ask(agent, '缺字段的资料')
    await waitForIdle(ctx, agent)

    const event = agent.session.ownEvents().find(item => item.type === 'knowledge-search')
    if (event?.type !== 'knowledge-search') throw new Error('knowledge-search event missing')
    // 缺席的原因与引用是「没有这个键」，不是 null；下游渲染靠键的有无区分二者。
    expect(event.data.knowledgeBases[0]).not.toHaveProperty('reason')
    // 有引用但没有页码：引用仍在，页码不补。
    expect(event.data.results[0]).toMatchObject({ citation: { chunk: 'c-1' } })
    expect(event.data.results[0]?.citation).not.toHaveProperty('page')
    expect(event.data.results[1]).not.toHaveProperty('citation')

    const recall = agent.session.ownEvents().find(item => item.type === 'user/message' && item.data.source.kind === 'plugin')
    if (recall?.type !== 'user/message') throw new Error('recall message missing')
    const text = recall.data.content.map(block => (block.type === 'text' ? block.text : '')).join('')
    expect(text).toContain('无页码')
    // 没有页码就不写页码，不得补一个 0 或空串。
    expect(text).not.toContain('page')
    loop.dispose()
  })
})
