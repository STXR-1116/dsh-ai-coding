import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentRegistry, { agentEvents, type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
// 0.1.5 drift: AgentLoop.inject now also requires sessionProjections, which
// dsh-session-projection provides. On the 0.1.1-rc.2 sources the loop mounted
// without it; on this baseline an unmounted registry leaves the loop's fiber
// waiting on an unmet injection, so ctx.agentLoop never appears and every
// await ctx.agentLoop.create(...) call throws.
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { describe, expect, it, vi } from 'vitest'
import { TeamSkillMemoryLoop, type TeamSkillMemoryCaptureRequest } from '../src/memory-loop.ts'
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

describe('TeamSkillMemoryLoop', () => {
  it('recalls before a step and captures only direct conversation messages', async () => {
    const ctx = await harness()
    const recalls: string[] = []
    const captures: Array<{ messages: readonly { role: string; content: string }[]; key: string }> = []
    const agent = await ctx.agentLoop.create(SessionId('memory-loop'), { provider: 'mock', model: 'mock' })
    const loop = new TeamSkillMemoryLoop(ctx, {
      resolveProject: subject => (subject === agent ? 'project-alpha' : undefined),
      recall: async (request) => {
        recalls.push(request.query)
        return {
          status: 'READY',
          items: [{
            memoryId: 'm-1',
            content: 'item text must not be rebuilt',
            score: 0.9,
            layer: 'L1',
            recallReason: 'CONTENT_MATCH',
            sourceRunId: null,
            updatedAt: '2026-09-15T08:00:00.000Z',
            confidence: 0.6,
          }],
          contextText: 'Server-authoritative context',
          strategy: 'fixture',
          effectivePolicy: { topK: 5, relevanceThreshold: 0.5, tokenBudget: 500 },
        }
      },
      capture: async (request, key) => {
        captures.push({ messages: request.messages, key })
        return { status: 'PENDING', eventId: 'e-1', jobId: 'j-1', acceptedCount: request.messages.length }
      },
    })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'How should I code?' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)
    expect(recalls).toEqual(['How should I code?'])
    expect(captures).toHaveLength(1)
    expect(captures[0]?.key).toBe('dsh-memory-loop:memory-loop:1')
    expect(captures[0]?.messages).toEqual(
      expect.arrayContaining([
        { role: 'user', content: 'How should I code?' },
        { role: 'assistant', content: 'answer' },
      ]),
    )
    expect(captures[0]?.messages.some(item => item.content.includes('Server-authoritative context'))).toBe(false)
    expect(agent.session.ownEvents().some(event => event.type === 'user/message' && event.data.content.some(block => block.type === 'text' && block.text.includes('Server-authoritative context')))).toBe(true)
    loop.dispose()
  })

  it('keeps coding running when recall or capture is unavailable', async () => {
    const ctx = await harness()
    const agent = await ctx.agentLoop.create(SessionId('memory-failure'), { provider: 'mock', model: 'mock' })
    const loop = new TeamSkillMemoryLoop(ctx, {
      resolveProject: () => 'project-alpha',
      recall: async () => {
        throw new Error('503')
      },
      capture: async () => {
        throw new Error('503')
      },
    })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'continue coding' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)
    expect(agent.session.ownEvents().some(event => event.type === 'assistant/message')).toBe(true)
    loop.dispose()
  })

  it('retries a capture after an explicit failed result', async () => {
    const ctx = await harness()
    const agent = await ctx.agentLoop.create(SessionId('memory-capture-retry'), { provider: 'mock', model: 'mock' })
    const captureResults = [
      { status: 'failed' as const, code: 'MEMORY_SERVICE_UNAVAILABLE', message: 'down' },
      { status: 'PENDING' as const, eventId: 'e-2', jobId: 'j-2', acceptedCount: 1 },
    ]
    const capture = vi.fn(async (..._args: [TeamSkillMemoryCaptureRequest, string]) => captureResults.shift()!)
    const loop = new TeamSkillMemoryLoop(ctx, {
      resolveProject: () => 'project-alpha',
      recall: async () => ({
        status: 'PROJECT_REQUIRED' as const,
        items: [],
        contextText: '',
        strategy: 'not-ready',
        effectivePolicy: { topK: 0, relevanceThreshold: 1, tokenBudget: 0 },
      }),
      capture,
    })
    const firstIdle = waitForIdle(ctx, agent)
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'first' }], source: { kind: 'user' } }))
    await firstIdle
    await agentEvents(ctx, agent).serial('agent/turn-stopping', { turn: 1, signal: new AbortController().signal })
    expect(capture).toHaveBeenCalledTimes(2)
    expect(capture.mock.calls[0]?.[1]).toBe('dsh-memory-loop:memory-capture-retry:1')
    expect(capture.mock.calls[1]?.[1]).toBe('dsh-memory-loop:memory-capture-retry:1')
    loop.dispose()
  })

  it('does not inject anything for an UNAVAILABLE recall and still completes the turn', async () => {
    const ctx = await harness()
    const agent = await ctx.agentLoop.create(SessionId('memory-unavailable'), { provider: 'mock', model: 'mock' })
    const loop = new TeamSkillMemoryLoop(ctx, {
      resolveProject: () => 'project-alpha',
      recall: async () => ({
        status: 'UNAVAILABLE' as const,
        items: [],
        contextText: '',
        strategy: 'unavailable',
        effectivePolicy: { topK: 0, relevanceThreshold: 1, tokenBudget: 0 },
      }),
      capture: async () => ({ status: 'PENDING', eventId: 'e-1', jobId: 'j-1', acceptedCount: 1 }),
    })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'unavailable recall' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)
    expect(agent.session.ownEvents().some(event => event.type === 'assistant/message')).toBe(true)
    expect(agent.session.ownEvents().some(event => event.type === 'user/message' && event.data.content.some(block => block.type === 'text' && block.text.includes('Untrusted project-memory references')))).toBe(false)
    loop.dispose()
  })

  it('captures each turn once even when turn-stopping fires twice, and skips unbound agents', async () => {
    const ctx = await harness()
    const agent = await ctx.agentLoop.create(SessionId('memory-dedupe'), { provider: 'mock', model: 'mock' })
    const capture = vi.fn(async (..._args: [TeamSkillMemoryCaptureRequest, string]) => ({
      status: 'PENDING' as const,
      eventId: 'e-3',
      jobId: 'j-3',
      acceptedCount: 1,
    }))
    let bound = true
    const loop = new TeamSkillMemoryLoop(ctx, {
      resolveProject: subject => (subject === agent && bound ? 'project-alpha' : undefined),
      recall: async () => ({
        status: 'PROJECT_REQUIRED' as const,
        items: [],
        contextText: '',
        strategy: 'not-ready',
        effectivePolicy: { topK: 0, relevanceThreshold: 1, tokenBudget: 0 },
      }),
      capture,
    })
    const firstIdle = waitForIdle(ctx, agent)
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'dedupe turn' }], source: { kind: 'user' } }))
    await firstIdle
    const firstCalls = capture.mock.calls.length
    expect(firstCalls).toBeGreaterThanOrEqual(1)
    // 同一 turn 再次派发 turn-stopping：capturedTurns 去重，不重复捕获。
    await agentEvents(ctx, agent).serial('agent/turn-stopping', { turn: 1, signal: new AbortController().signal })
    expect(capture.mock.calls.length).toBe(firstCalls)
    // 解绑后派发新 turn：projectId undefined 直接返回，不捕获。
    bound = false
    await agentEvents(ctx, agent).serial('agent/turn-stopping', { turn: 2, signal: new AbortController().signal })
    expect(capture.mock.calls.length).toBe(firstCalls)
    loop.dispose()
  })

  it('skips recall and capture for a pre-step that carries no user-sourced message', async () => {
    const ctx = await harness()
    const agent = await ctx.agentLoop.create(SessionId('memory-no-user'), { provider: 'mock', model: 'mock' })
    let recalls = 0
    const captures: TeamSkillMemoryCaptureRequest[] = []
    const loop = new TeamSkillMemoryLoop(ctx, {
      resolveProject: () => 'project-alpha',
      recall: async () => {
        recalls += 1
        return {
          status: 'READY',
          items: [],
          contextText: '',
          strategy: 'fixture',
          effectivePolicy: { topK: 5, relevanceThreshold: 0.5, tokenBudget: 500 },
        }
      },
      capture: async (request) => {
        captures.push(request)
        return { status: 'PENDING', eventId: 'e-4', jobId: 'j-4', acceptedCount: request.messages.length }
      },
    })

    // inbox claim 的消息类型允许合并扩展出非 user 来源；没有用户问句就没有
    // 可检索的查询，也没有可捕获的直接对话内容。
    agent.followup(
      createUserMessage({
        content: [{ type: 'text', text: 'plugin-sourced pre-step message' }],
        source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-test-harness', form: 'relay' },
      }),
    )
    await waitForIdle(ctx, agent)

    // 无用户问句：recall 必须跳过；捕获只收集直接对话内容（此回合只有
    // assistant 回复，不得凭空捏造用户消息）。
    expect(recalls).toBe(0)
    for (const request of captures) {
      expect(request.messages.every(message => message.role !== 'user')).toBe(true)
    }
    expect(agent.session.ownEvents().some(event => event.type === 'assistant/message')).toBe(true)
    loop.dispose()
  })

  it('does not inject a recall response after the project binding changes', async () => {
    const ctx = await harness()
    const agent = await ctx.agentLoop.create(SessionId('memory-project-race'), { provider: 'mock', model: 'mock' })
    let currentProject = 'project-alpha'
    let recallStartedResolve: (() => void) | undefined
    const recallStarted = new Promise<void>((resolve) => {
      recallStartedResolve = resolve
    })
    let releaseRecall: (() => void) | undefined
    const recallReady = new Promise<void>((resolve) => {
      releaseRecall = resolve
    })
    const loop = new TeamSkillMemoryLoop(ctx, {
      resolveProject: () => currentProject,
      recall: async () => {
        recallStartedResolve?.()
        await recallReady
        return {
          status: 'READY',
          items: [{
            memoryId: 'm-old',
            content: 'old project secret',
            score: 0.9,
            layer: 'L1',
            recallReason: 'PREFIX_MATCH',
            sourceRunId: null,
            updatedAt: '2026-09-15T08:00:00.000Z',
            confidence: 0.6,
          }],
          contextText: 'old project secret',
          strategy: 'fixture',
          effectivePolicy: { topK: 5, relevanceThreshold: 0.5, tokenBudget: 500 },
        }
      },
      capture: async () => ({ status: 'PENDING', eventId: 'e-1', jobId: 'j-1', acceptedCount: 1 }),
    })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'race' }], source: { kind: 'user' } }))
    await recallStarted
    currentProject = 'project-beta'
    releaseRecall?.()
    await waitForIdle(ctx, agent)
    expect(agent.session.ownEvents().some(event => event.type === 'user/message' && event.data.content.some(block => block.type === 'text' && block.text.includes('old project secret')))).toBe(false)
    loop.dispose()
  })
})
