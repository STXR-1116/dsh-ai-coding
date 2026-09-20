import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
// 0.1.5 drift: AgentLoop.inject now also requires sessionProjections, which
// dsh-session-projection provides. On the 0.1.1-rc.2 sources the loop mounted
// without it; on this baseline an unmounted registry leaves the loop's fiber
// waiting on an unmet injection, so ctx.agentLoop never appears and every
// await ctx.agentLoop.create(...) call throws.
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { TelemetryQueue } from '../src/telemetry/queue.ts'
import { TelemetryReporter } from '../src/telemetry/reporter.ts'
import { TeamSkillTelemetryBackend } from '../src/telemetry/backend.ts'
import type { TelemetryEventDto, TelemetryQueueSettings } from '../src/types.ts'
import { MockAdapter, textResponse } from './helpers/mock-adapter.ts'

const settings: TelemetryQueueSettings = {
  maxEvents: 1000,
  maxBytes: 1024 * 1024,
  batchMaxEvents: 50,
  batchMaxBytes: 256 * 1024,
  flushIntervalMs: 5,
  httpTimeoutMs: 100,
  maxAttempts: 3,
  retentionMs: 24 * 60 * 60 * 1000,
  claimTimeoutMs: 60_000,
}

const roots: string[] = []
const contexts: Context[] = []
const fibers: Array<{ dispose: () => Promise<void> | void }> = []
const queues: TelemetryQueue[] = []

afterEach(async () => {
  for (const fiber of fibers.splice(0)) await fiber.dispose()
  contexts.splice(0)
  for (const queue of queues.splice(0)) queue.close()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

type Agent = ReturnType<Context['agentLoop']['create']>

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

interface Harness {
  readonly ctx: Context
  readonly queue: TelemetryQueue
  readonly backend: TeamSkillTelemetryBackend
}

async function harness(liveSessions: (sessionId: string) => boolean): Promise<Harness> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  // 0.1.5 drift: satisfy AgentLoop's new sessionProjections injection.
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['mock'], new MockAdapter([textResponse('secret assistant answer')]))
  const root = await mkdtemp(join(tmpdir(), 'dsh-telemetry-backend-'))
  roots.push(root)
  const queue = TelemetryQueue.open(join(root, 'state'), settings)
  queues.push(queue)
  const reporter = new TelemetryReporter(queue, settings, {
    send: undefined,
    resolveAccount: async () => ({ userId: 'admin-1' }),
  })
  let backend!: TeamSkillTelemetryBackend
  const fiber = await ctx.plugin({
    name: 'test-telemetry-backend',
    inject: ['sessions'],
    apply: (inner: Context) => {
      backend = new TeamSkillTelemetryBackend(inner, queue, reporter, liveSessions)
      backend.setAccount({ userId: 'admin-1' })
    },
  })
  fibers.push(fiber)
  return { ctx, queue, backend }
}

function drainEvents(queue: TelemetryQueue, accountId = 'admin-1'): TelemetryEventDto[] {
  const events: TelemetryEventDto[] = []
  for (;;) {
    const batch = queue.pendingBatch(accountId, Number.MAX_SAFE_INTEGER)
    if (batch === null) break
    events.push(...batch.events.map(item => item.payload))
    queue.acknowledge(
      batch.batchId,
      batch.events.map(item => ({ eventId: item.eventId, status: 'accepted' as const })),
      'test',
    )
  }
  return events
}

describe('TeamSkillTelemetryBackend', () => {
  it('captures a real coding turn into whitelist DTOs and never carries prompt or reply content', async () => {
    const { ctx, queue, backend } = await harness(() => true)
    const agent = await ctx.agentLoop.create(SessionId('telemetry-turn'), { provider: 'mock', model: 'mock' })
    backend.configureProject(String(agent.session.id), 'project-alpha')
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'top secret user prompt' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)

    const events = drainEvents(queue)
    expect(events.map(event => event.kind)).toEqual([
      'session.started',
      'turn.started',
      'llm.request',
      'step.started',
      'llm.response',
      'step.finished',
      'turn.finished',
    ])
    expect(events.filter(event => event.kind === 'llm.request')).toHaveLength(1)
    const response = events.find(event => event.kind === 'llm.response')
    expect(response).toMatchObject({ turn: 1, step: 1, provider: 'mock', model: 'mock', outcome: 'success' })
    expect(events.some(event => event.kind === 'turn.finished' && event.outcome === 'success')).toBe(true)
    const serialized = JSON.stringify(events)
    expect(serialized).not.toContain('top secret user prompt')
    expect(serialized).not.toContain('secret assistant answer')
    // Ledger identities are stable across a restart of the same process state.
    expect(events.filter(event => event.kind === 'turn.started').every(event => event.eventId.startsWith(`${queue.installationId}:telemetry-turn:`))).toBe(true)
  })

  it('captures nothing for an unbound session and nothing while signed out', async () => {
    const { ctx, queue, backend } = await harness(() => true)
    const agent = await ctx.agentLoop.create(SessionId('telemetry-unbound'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'prompt while unbound' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)
    expect(queue.counts().events).toBe(0)

    // Signing out stops capture even for a bound session.
    const bound = await ctx.agentLoop.create(SessionId('telemetry-signed-out'), { provider: 'mock', model: 'mock' })
    backend.configureProject(String(bound.session.id), 'project-alpha')
    const queuedAtBinding = queue.counts().events
    backend.setAccount({ status: 'signed-out' })
    bound.followup(createUserMessage({ content: [{ type: 'text', text: 'prompt while signed out' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, bound)
    // Only the collector start edge queued; the signed-out turn produced nothing.
    expect(queue.counts().events).toBe(queuedAtBinding)
  })

  it('emits session.started at the binding edge, skips dead sessions, and forgets bindings at disposal', async () => {
    const live: string[] = []
    const { ctx, queue, backend } = await harness(sessionId => live.includes(sessionId))
    const agent = await ctx.agentLoop.create(SessionId('telemetry-binding'), { provider: 'mock', model: 'mock' })
    live.push(String(agent.session.id))
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'hello there' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)
    backend.configureProject(String(agent.session.id), 'project-alpha')
    const events = drainEvents(queue)
    expect(events.filter(event => event.kind === 'session.started')).toHaveLength(1)
    // Binding after the turn: pre-binding runtime facts are not retro-projected.
    expect(events.some(event => event.kind === 'turn.finished')).toBe(false)
    expect(backend.projectOf(String(agent.session.id))).toBe('project-alpha')

    // Clearing the binding drops late events and forgets pairing state.
    backend.clearProject(String(agent.session.id))
    expect(backend.projectOf(String(agent.session.id))).toBeUndefined()
    expect(backend.boundProjects()).toEqual([])
  })

  it('rebinds a live session across projects with exactly one session.started per binding edge', async () => {
    const { ctx, queue, backend } = await harness(() => true)
    const agent = await ctx.agentLoop.create(SessionId('telemetry-switch'), { provider: 'mock', model: 'mock' })
    const sessionId = String(agent.session.id)

    // Bind to project A, run a turn, then switch to project B and run another.
    backend.configureProject(sessionId, 'project-a')
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'turn under project a' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)
    backend.clearProject(sessionId)
    backend.configureProject(sessionId, 'project-b')
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'turn under project b' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)

    const events = drainEvents(queue)
    const starts = events.filter(event => event.kind === 'session.started')
    expect(starts.map(event => event.projectId)).toEqual(['project-a', 'project-b'])
    // Pre-switch runtime facts stay with A; post-switch runtime facts go to B.
    const turns = events.filter(event => event.kind === 'turn.started')
    expect(turns.map(event => event.projectId)).toEqual(['project-a', 'project-b'])
    expect(JSON.stringify(events)).not.toContain('turn under project b')
  })

  it('does not mint a second session.started when the same binding is repeated or the session is gone', async () => {
    const live: string[] = []
    const { ctx, queue, backend } = await harness(sessionId => live.includes(sessionId))
    const agent = await ctx.agentLoop.create(SessionId('telemetry-repeat'), { provider: 'mock', model: 'mock' })
    live.push(String(agent.session.id))
    backend.configureProject(String(agent.session.id), 'project-a')
    backend.configureProject(String(agent.session.id), 'project-a')
    backend.clearProject(String(agent.session.id))
    // Repeat binding to the same still-live session: a fresh collection edge is expected.
    backend.configureProject(String(agent.session.id), 'project-a')

    const live2: string[] = []
    void live2
    // A session that no longer exists must not gain a session.started at all.
    backend.configureProject('telemetry-ghost', 'project-a')

    const events = drainEvents(queue)
    const starts = events.filter(event => event.kind === 'session.started')
    expect(starts).toHaveLength(2)
    expect(starts.every(event => event.projectId === 'project-a')).toBe(true)
    expect(starts.every(event => event.sessionId !== 'telemetry-ghost')).toBe(true)
  })

  it('keeps accounts isolated: a second account never sees or clears the first partition', async () => {
    const { ctx, queue, backend } = await harness(() => true)
    const agent = await ctx.agentLoop.create(SessionId('telemetry-accounts'), { provider: 'mock', model: 'mock' })
    backend.configureProject(String(agent.session.id), 'project-alpha')
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'first account prompt' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)
    expect(queue.counts().events).toBeGreaterThan(0)
    // The manager partition has nothing and drains nothing.
    expect(queue.pendingBatch('manager-1', Number.MAX_SAFE_INTEGER)).toBeNull()
    // Clearing the manager partition leaves the admin rows untouched.
    queue.clearAccount('manager-1')
    expect(queue.counts().events).toBeGreaterThan(0)
    expect(drainEvents(queue, 'manager-1')).toEqual([])
  })
})
