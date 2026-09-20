import { describe, expect, it } from 'vitest'
import type { SessionTelemetryRecord } from '@deepseek-ai/dsh-session-telemetry'
import { TelemetryProjection } from '../src/telemetry/projection.ts'
import type { TelemetryEventDto } from '../src/types.ts'

function ledger(eventType: string, seq: number, body: unknown, time = 1_700_000_000_000): SessionTelemetryRecord {
  return {
    channel: 'ledger',
    time,
    severity: 'info',
    attributes: { 'session.id': 'session-1', 'event.type': eventType, 'event.seq': seq },
    body,
  }
}

function ops(op: string, body: unknown, turn?: number, step?: number): SessionTelemetryRecord {
  return {
    channel: 'ops',
    time: 1_700_000_000_500,
    severity: 'error',
    attributes: {
      'telemetry.op': op,
      'session.id': 'session-1',
      ...(op === 'agent-error' ? { 'error.name': 'ProviderError' } : {}),
      ...(turn === undefined ? {} : { turn }),
      ...(step === undefined ? {} : { step }),
    },
    body,
  }
}

type Fact = Omit<TelemetryEventDto, 'schemaVersion' | 'eventId' | 'installationId' | 'projectId'> & { sessionId: string }

function factOf(projection: TelemetryProjection, record: SessionTelemetryRecord): Fact | null {
  const facts = projection.project(record, 'session-1')
  return facts.length === 0 ? null : (facts[facts.length - 1] ?? null)
}

function factsOf(projection: TelemetryProjection, record: SessionTelemetryRecord): readonly Fact[] {
  return projection.project(record, 'session-1')
}

describe('TelemetryProjection', () => {
  it('projects turn and step lifecycle with outcomes and in-session durations', () => {
    const projection = new TelemetryProjection()
    const started = factOf(projection, ledger('turn/start', 4, { turn: 2 }))
    expect(started).toMatchObject({ kind: 'turn.started', turn: 2, sourceSeq: 4, sourceType: 'turn/start' })
    const stepFacts = factsOf(projection, ledger('step/start', 5, { turn: 2, step: 1 }, 1_700_000_000_010))
    expect(stepFacts.map(fact => fact.kind)).toEqual(['llm.request', 'step.started'])
    expect(stepFacts[1]).toMatchObject({ turn: 2, step: 1 })
    expect(stepFacts[0]).toMatchObject({ kind: 'llm.request' })
    const stepEnded = factOf(projection, ledger('step/end', 6, { turn: 2, step: 1 }, 1_700_000_000_150))
    expect(stepEnded).toMatchObject({ kind: 'step.finished', durationMs: 140 })
    const turnEnded = factOf(projection, ledger('turn/end', 7, { turn: 2, reason: { kind: 'max-tokens' } }, 1_700_000_000_300))
    expect(turnEnded).toMatchObject({ kind: 'turn.finished', outcome: 'max_tokens', durationMs: 300 })
    // An unpaired end has no duration and no invented outcome.
    const unpaired = factOf(projection, ledger('turn/end', 8, { turn: 3, reason: { kind: 'completed' } }, 1_700_000_000_400))
    expect(unpaired).toMatchObject({ kind: 'turn.finished', outcome: 'success', durationMs: null })
  })

  it('maps every documented turn/end reason and never invents an outcome', () => {
    const cases: ReadonlyArray<readonly [string, string | undefined]> = [
      ['completed', 'success'],
      ['error', 'error'],
      ['aborted', 'cancelled'],
      ['blocked', 'blocked'],
      ['max-tokens', 'max_tokens'],
      ['interrupted', 'interrupted'],
      ['plugin-merged', undefined],
    ]
    for (const [kind, expected] of cases) {
      const projection = new TelemetryProjection()
      const fact = factOf(projection, ledger('turn/end', 1, { turn: 1, reason: { kind } }))
      expect(fact?.outcome).toBe(expected)
    }
  })

  it('keeps provider tokens verbatim and leaves totalTokens null because DSH has no provider total', () => {
    const projection = new TelemetryProjection()
    void projection.project(ledger('request/context', 1, { provider: 'deepseek', model: 'deepseek-chat' }), 'session-1')
    void projection.project(ledger('step/start', 2, { turn: 1, step: 1 }), 'session-1')
    const fact = factOf(
      projection,
      ledger('assistant/message', 3, {
        turn: 1,
        step: 1,
        message: { content: [{ type: 'text', text: 'secret assistant reply' }] },
        usage: { inputTokens: 1200, outputTokens: 350, cacheReadTokens: 10 },
      }),
    )
    expect(fact).toMatchObject({
      kind: 'llm.response',
      provider: 'deepseek',
      model: 'deepseek-chat',
      tokenUsage: { inputTokens: 1200, outputTokens: 350, totalTokens: null },
    })
    // Without a usage record the token counts are absent (never zero, never guessed).
    void projection.project(ledger('step/start', 4, { turn: 1, step: 2 }), 'session-1')
    const missing = factOf(projection, ledger('assistant/message', 5, { turn: 1, step: 2, message: { content: [] } }))
    expect(missing?.tokenUsage).toBeUndefined()
  })

  it('drops prompt, reply, chunk, argument, and result content from every fact', () => {
    const projection = new TelemetryProjection()
    void projection.project(ledger('step/start', 1, { turn: 1, step: 1 }), 'session-1')
    void projection.project(ledger('tool/call', 2, { turn: 1, step: 1, callId: 'call-1', name: 'read_file', arguments: '{"path":"C:/secret/main.py"}' }), 'session-1')
    const result = factOf(
      projection,
      ledger('tool/result', 3, {
        turn: 1,
        step: 1,
        callId: 'call-1',
        message: { content: [{ type: 'text', text: 'def api_key = sk-abcdef', isError: true }] },
        error: { name: 'ToolError', code: 'TOOL_FAILED' },
        meta: { diff: '+ password=hunter2' },
      }),
    )
    expect(result).toMatchObject({ kind: 'tool.result', callId: 'call-1', toolName: 'read_file', outcome: 'error', error: { name: 'ToolError', code: 'TOOL_FAILED' } })
    const serialized = JSON.stringify([result])
    expect(serialized).not.toContain('main.py')
    expect(serialized).not.toContain('api_key')
    expect(serialized).not.toContain('hunter2')
    expect(serialized).not.toContain('def ')
    // Content-bearing event types produce no fact at all.
    expect(factOf(projection, ledger('user/message', 4, { content: [{ type: 'text', text: 'user prompt with password=hunter2' }] }))).toBeNull()
    expect(factOf(projection, ledger('assistant/chunk', 5, { turn: 1, step: 1, chunk: { type: 'text', text: 'chunk' } }))).toBeNull()
    expect(factOf(projection, ledger('todo/write', 6, { todos: [] }))).toBeNull()
  })

  it('projects tool pairing, approvals, and compaction without bodies', () => {
    const projection = new TelemetryProjection()
    void projection.project(ledger('tool/call', 1, { turn: 1, step: 1, callId: 'call-9', name: 'bash' }, 1_700_000_000_000), 'session-1')
    const toolResult = factOf(projection, ledger('tool/result', 2, { turn: 1, step: 1, callId: 'call-9', message: { content: [] } }, 1_700_000_000_040) )
    expect(toolResult).toMatchObject({ kind: 'tool.result', toolName: 'bash', durationMs: 40, outcome: 'success' })
    const asked = factOf(projection, ledger('approval/asked', 3, { id: 'ap-1', toolName: 'bash', callId: 'call-9', reason: 'runs rm -rf /tmp/x' }))
    expect(asked).toMatchObject({ kind: 'approval.requested', approvalId: 'ap-1', toolName: 'bash' })
    expect(JSON.stringify(asked)).not.toContain('rm -rf')
    const decided = factOf(projection, ledger('approval/decided', 4, { id: 'ap-1', outcome: 'allowed-once' }))
    expect(decided).toMatchObject({ kind: 'approval.resolved', approval: { decision: 'allowed_once' } })
    void projection.project(ledger('compaction/start', 5, { compactionId: 'c-1' }), 'session-1')
    void projection.project(
      ledger('compaction/summary', 6, {
        compactionId: 'c-1',
        summary: [{ type: 'text', text: 'summary content' }],
        provider: 'deepseek',
        model: 'deepseek-chat',
        usage: { inputTokens: 10, outputTokens: 5 },
      }),
      'session-1',
    )
    const compaction = factOf(projection, ledger('compaction/end', 7, { compactionId: 'c-1', turn: 1 }, 1_700_000_000_100))
    expect(compaction).toMatchObject({
      kind: 'compaction.completed',
      compactionId: 'c-1',
      compaction: { kind: 'summary' },
      outcome: 'success',
      tokenUsage: { inputTokens: 10, outputTokens: 5, totalTokens: null },
    })
    expect(JSON.stringify(compaction)).not.toContain('summary content')
  })

  it('projects ops records to agent.error and session.finished with cleaned summaries', () => {
    const projection = new TelemetryProjection()
    const agentError = factOf(projection, ops('agent-error', { name: 'ProviderError', message: 'boom\r\nwith\tsecret sk-abcd1234efgh5678ijkl' }, 2, 1))
    expect(agentError).toMatchObject({ kind: 'agent.error', turn: 2, step: 1, error: { name: 'ProviderError' } })
    expect(agentError?.error?.summary).not.toContain('\n')
    expect(agentError?.error?.summary).not.toContain('\t')
    const shutdown = factOf(projection, ops('shutdown', { op: 'shutdown' }))
    expect(shutdown).toMatchObject({ kind: 'session.finished', sourceType: 'shutdown' })
    expect(shutdown?.outcome).toBeUndefined()
  })

  it('R15 redacts credential-bearing summaries at projection time', () => {
    const projection = new TelemetryProjection()
    const bs = String.fromCharCode(92)
    const windowsPath = `C:${bs}Users${bs}alice${bs}secrets${bs}db.sqlite`
    const unixPath = '/home/alice/secrets/db.sqlite'
    const samples = [
      'request failed: Bearer abc123.def456_ghi rejected',
      'auth=bearer eyJhbGciOiJIUzI1NiJ9.payload.sig denied',
      `login failed for password=hunter2 on ${windowsPath}`,
      `token refresh failed under ${unixPath}`,
      'Set-Cookie: session=xyz; HttpOnly caused the failure',
      "TypeError: access_token 'sup3r-secret' expired (api_key=AKIA123)",
    ]
    for (const [index, message] of samples.entries()) {
      const fact = factOf(projection, ops('agent-error', { name: 'ProviderError', message }, 3, 1))
      expect(fact?.error?.summary).toBeDefined()
      const summary = fact?.error?.summary ?? ''
      expect(summary).not.toContain('abc123.def456_ghi')
      expect(summary).not.toContain('eyJhbGciOiJIUzI1NiJ9')
      expect(summary).not.toContain('hunter2')
      expect(summary).not.toContain(windowsPath)
      expect(summary).not.toContain('alice')
      expect(summary).not.toContain(unixPath)
      expect(summary).not.toContain('session=xyz')
      expect(summary).not.toContain('sup3r-secret')
      expect(summary).not.toContain('AKIA123')
      if (index === 3) {
        // 纯路径样本：整段路径被替换为 [PATH]。
        expect(summary).toContain('[PATH]')
      } else {
        expect(summary).toContain('[REDACTED]')
      }
    }
  })

  it('ignores unknown ops and unknown ledger types without fabricating events', () => {
    const projection = new TelemetryProjection()
    expect(factOf(projection, ops('unknown-op', { x: 1 }))).toBeNull()
    expect(factOf(projection, ledger('knowledge-search', 1, { query: 'q' }))).toBeNull()
    expect(factOf(projection, ledger('session/end-seed', 2, {}))).toBeNull()
  })
})
