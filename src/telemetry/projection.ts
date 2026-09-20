/** Whitelist projection from `SessionTelemetryRecord` facts to structured observability events. */

import type { SessionTelemetryRecord } from '@deepseek-ai/dsh-session-telemetry'
import { sanitizeSensitiveSummary } from './sanitize.ts'
import type {
  TelemetryApprovalDetail,
  TelemetryCompactionDetail,
  TelemetryErrorDetail,
  TelemetryEventDto,
  TelemetryOutcome,
  TelemetryTokenUsage,
} from '../types.ts'

/** Upper bound for cleaned error summaries. */
const SUMMARY_MAX_LENGTH = 200

/** A projected fact with collector identity still unassigned. */
export type ProjectedTelemetryFact = Omit<TelemetryEventDto, 'schemaVersion' | 'eventId' | 'installationId' | 'projectId'> & {
  readonly sessionId: string
}

/**
 * Projection fields with `undefined` allowed on every optional member, so a
 * call site can pass observed-or-absent values without repeating
 * conditional spreads.
 */
type LooseFactFields = {
  [K in Exclude<
    keyof TelemetryEventDto,
    'schemaVersion' | 'eventId' | 'installationId' | 'projectId' | 'sessionId' | 'kind' | 'occurredAt' | 'sourceType'
  >]?: TelemetryEventDto[K] | undefined
}

/** Per-session pairing state; only provable in-session, in-process pairings are kept. */
interface SessionPairing {
  /** Latest `request/context` route facts. */
  route?: { readonly provider: string; readonly model: string }
  /** Open `turn/start` times by turn number. */
  turnStarts: Map<number, number>
  /** Open `step/start` times by `turn:step`. */
  stepStarts: Map<string, number>
  /** Open `tool/call` facts by callId. */
  toolCalls: Map<string, { readonly time: number; readonly name: string }>
  /** The single open compaction lifecycle; compaction is lock-held per session. */
  compaction?: { readonly compactionId: string; readonly startTime: number; kind?: string; usage?: TelemetryTokenUsage } | undefined
}

/**
 * Stateful projector. `project` reads only the fields each metric needs; the
 * record body is dropped when the call returns. Pairing state is per session
 * and never spans restarts, projects, or sessions — unmatched durations stay
 * null. Unrecognized sources produce no event and no invented metrics. One
 * source may yield several facts (a step opens both a step and its model
 * request); the caller receives them in source order.
 */
export class TelemetryProjection {
  private readonly sessions = new Map<string, SessionPairing>()

  /** Project one redacted record for an already-authorized session; an empty array means no whitelisted event.
   * @param record - Session telemetry record captured for the session.
   * @param sessionId - DSH session the record belongs to.
   * @returns The projected whitelist facts; empty when the record projects nothing.
   */
  project(record: SessionTelemetryRecord, sessionId: string): readonly ProjectedTelemetryFact[] {
    if (record.channel === 'ops') {
      const fact = this.projectOps(record, sessionId)
      return fact === null ? [] : [fact]
    }
    const facts: ProjectedTelemetryFact[] = []
    const fact = this.projectLedger(record, sessionId, facts)
    return fact === null ? facts : [...facts, fact]
  }

  /** Forget one session's pairing state at disposal or unbinding.
   * @param sessionId - DSH session whose pairing state is dropped.
   */
  forget(sessionId: string): void {
    this.sessions.delete(sessionId)
  }

  private pairing(sessionId: string): SessionPairing {
    let pairing = this.sessions.get(sessionId)
    if (pairing === undefined) {
      pairing = { turnStarts: new Map(), stepStarts: new Map(), toolCalls: new Map() }
      this.sessions.set(sessionId, pairing)
    }
    return pairing
  }

  private projectOps(record: SessionTelemetryRecord, sessionId: string): ProjectedTelemetryFact | null {
    const op = record.attributes['telemetry.op']
    if (op === 'agent-error') {
      const detail = errorDetailOf(record.body)
      if (detail === undefined) return null
      return base(record, sessionId, 'agent.error', 'agent-error', {
        turn: numberAttribute(record.attributes['turn']),
        step: numberAttribute(record.attributes['step']),
        error: detail,
      })
    }
    if (op === 'shutdown') {
      return base(record, sessionId, 'session.finished', 'shutdown', {})
    }
    return null
  }

  private projectLedger(record: SessionTelemetryRecord, sessionId: string, facts: ProjectedTelemetryFact[]): ProjectedTelemetryFact | null {
    const pairing = this.pairing(sessionId)
    const body = record.body
    const seq = numberAttribute(record.attributes['event.seq'])
    switch (record.attributes['event.type']) {
      case 'turn/start': {
        const turn = readNumber(body, 'turn')
        if (turn === undefined) return null
        pairing.turnStarts.set(turn, record.time)
        return base(record, sessionId, 'turn.started', 'turn/start', { turn, sourceSeq: seq })
      }
      case 'turn/end': {
        const turn = readNumber(body, 'turn')
        const reason = readRecord(body, 'reason')
        if (turn === undefined || reason === undefined) return null
        const startedAt = pairing.turnStarts.get(turn)
        pairing.turnStarts.delete(turn)
        return base(record, sessionId, 'turn.finished', 'turn/end', {
          turn,
          sourceSeq: seq,
          outcome: turnOutcome(readString(reason, 'kind')),
          durationMs: duration(record.time, startedAt),
        })
      }
      case 'step/start': {
        const turn = readNumber(body, 'turn')
        const step = readNumber(body, 'step')
        if (turn === undefined || step === undefined) return null
        pairing.stepStarts.set(`${turn}:${step}`, record.time)
        // The step edge opens both the step fact and its model-request fact.
        facts.push(base(record, sessionId, 'llm.request', 'step/start', {
          turn,
          step,
          sourceSeq: seq,
          provider: pairing.route?.provider ?? null,
          model: pairing.route?.model ?? null,
        }))
        return base(record, sessionId, 'step.started', 'step/start', { turn, step, sourceSeq: seq })
      }
      case 'step/end': {
        const turn = readNumber(body, 'turn')
        const step = readNumber(body, 'step')
        if (turn === undefined || step === undefined) return null
        const startedAt = pairing.stepStarts.get(`${turn}:${step}`)
        pairing.stepStarts.delete(`${turn}:${step}`)
        // The source has no independent step outcome; none is inferred.
        return base(record, sessionId, 'step.finished', 'step/end', {
          turn,
          step,
          sourceSeq: seq,
          durationMs: duration(record.time, startedAt),
        })
      }
      case 'request/context': {
        const provider = readString(body, 'provider')
        const model = readString(body, 'model')
        if (provider !== undefined && model !== undefined) pairing.route = { provider, model }
        return null
      }
      case 'assistant/message': {
        const turn = readNumber(body, 'turn')
        const step = readNumber(body, 'step')
        if (turn === undefined || step === undefined) return null
        const startedAt = pairing.stepStarts.get(`${turn}:${step}`)
        const usage = readRecord(body, 'usage')
        return base(record, sessionId, 'llm.response', 'assistant/message', {
          turn,
          step,
          sourceSeq: seq,
          durationMs: duration(record.time, startedAt),
          outcome: readBoolean(body, 'interrupted') === true ? 'interrupted' : 'success',
          provider: pairing.route?.provider ?? null,
          model: pairing.route?.model ?? null,
          tokenUsage: tokenUsageOf(usage),
        })
      }
      case 'tool/call': {
        const turn = readNumber(body, 'turn')
        const step = readNumber(body, 'step')
        const callId = readString(body, 'callId')
        const name = readString(body, 'name')
        if (turn === undefined || step === undefined || callId === undefined || name === undefined) return null
        pairing.toolCalls.set(callId, { time: record.time, name })
        return base(record, sessionId, 'tool.call', 'tool/call', { turn, step, sourceSeq: seq, callId, toolName: name })
      }
      case 'tool/result': {
        const turn = readNumber(body, 'turn')
        const step = readNumber(body, 'step')
        const callId = readString(body, 'callId')
        if (turn === undefined || step === undefined || callId === undefined) return null
        const call = pairing.toolCalls.get(callId)
        pairing.toolCalls.delete(callId)
        const sourceError = readRecord(body, 'error')
        const failed = readMessageErrorFlag(body)
        const sourceCode = sourceError === undefined ? undefined : readString(sourceError, 'code')
        const detail =
          sourceError === undefined
            ? undefined
            : {
              name: readString(sourceError, 'name') ?? 'ToolError',
              ...(sourceCode === undefined ? {} : { code: sourceCode }),
            }
        return base(record, sessionId, 'tool.result', 'tool/result', {
          turn,
          step,
          sourceSeq: seq,
          callId,
          toolName: call?.name ?? null,
          outcome: failed ? 'error' : 'success',
          durationMs: duration(record.time, call?.time),
          ...(detail === undefined ? {} : { error: detail }),
        })
      }
      case 'approval/asked': {
        const approvalId = readString(body, 'id')
        if (approvalId === undefined) return null
        return base(record, sessionId, 'approval.requested', 'approval/asked', {
          sourceSeq: seq,
          approvalId,
          toolName: readString(body, 'toolName') ?? null,
          callId: readString(body, 'callId') ?? null,
        })
      }
      case 'approval/decided': {
        const approvalId = readString(body, 'id')
        if (approvalId === undefined) return null
        const decision = approvalDecision(readString(body, 'outcome'))
        const approval: TelemetryApprovalDetail = { ...(decision === undefined ? {} : { decision }) }
        return base(record, sessionId, 'approval.resolved', 'approval/decided', { sourceSeq: seq, approvalId, approval })
      }
      case 'compaction/start': {
        const compactionId = readString(body, 'compactionId')
        if (compactionId === undefined) return null
        pairing.compaction = { compactionId, startTime: record.time }
        return null
      }
      case 'compaction/summary': {
        if (pairing.compaction === undefined) return null
        const usage = tokenUsageOf(readRecord(body, 'usage'))
        const open = pairing.compaction
        pairing.compaction = {
          ...open,
          kind: open.kind ?? 'summary',
          ...(usage === undefined ? {} : { usage }),
        }
        return null
      }
      case 'compaction/prune': {
        if (pairing.compaction === undefined) return null
        pairing.compaction = { ...pairing.compaction, kind: pairing.compaction.kind ?? 'prune' }
        return null
      }
      case 'compaction/end': {
        const compactionId = readString(body, 'compactionId')
        if (compactionId === undefined) return null
        const open = pairing.compaction?.compactionId === compactionId ? pairing.compaction : undefined
        pairing.compaction = undefined
        const failed = typeof readString(body, 'error') === 'string'
        const compaction: TelemetryCompactionDetail = { ...(open?.kind === undefined ? {} : { kind: open.kind }) }
        return base(record, sessionId, 'compaction.completed', 'compaction/end', {
          sourceSeq: seq,
          compactionId,
          turn: readNumber(body, 'turn'),
          durationMs: duration(record.time, open?.startTime),
          outcome: failed ? 'error' : 'success',
          compaction,
          tokenUsage: open?.usage,
        })
      }
      default:
        // Merge-extensible fall-through: prompt, reply, chunk, todo, seed, and
        // plugin-merged sources carry no whitelisted metric and produce nothing.
        return null
    }
  }
}

function base(
  record: SessionTelemetryRecord,
  sessionId: string,
  kind: TelemetryEventDto['kind'],
  sourceType: string,
  rest: LooseFactFields,
): ProjectedTelemetryFact {
  // compact() drops absent observations so a fact carries only present keys;
  // the static vocabulary cannot express per-key presence without this cast.
  const fields = Object.fromEntries(Object.entries(rest).filter(([, value]) => value !== undefined)) as LooseFactFields
  return { sessionId, kind, occurredAt: new Date(record.time).toISOString(), sourceType, ...fields } as ProjectedTelemetryFact
}

/** Map a `turn/end` reason kind to the public outcome vocabulary. */
function turnOutcome(kind: string | undefined): TelemetryOutcome | undefined {
  switch (kind) {
    case 'completed':
      return 'success'
    case 'error':
      return 'error'
    case 'aborted':
      return 'cancelled'
    case 'blocked':
      return 'blocked'
    case 'max-tokens':
      return 'max_tokens'
    case 'interrupted':
      return 'interrupted'
    default:
      return undefined
  }
}

function approvalDecision(outcome: string | undefined): TelemetryApprovalDetail['decision'] {
  switch (outcome) {
    case 'allowed-once':
      return 'allowed_once'
    case 'rejected':
      return 'rejected'
    case 'cancelled':
      return 'cancelled'
    case 'unavailable':
      return 'unavailable'
    default:
      return undefined
  }
}

/**
 * Provider-reported token counts only. DSH `TokenUsage` carries no provider
 * total, so `totalTokens` stays null here; nothing is summed or estimated.
 */
function tokenUsageOf(usage: Record<string, unknown> | undefined): TelemetryTokenUsage | undefined {
  if (usage === undefined) return undefined
  return {
    inputTokens: nonNegativeNumber(usage.inputTokens) ?? null,
    outputTokens: nonNegativeNumber(usage.outputTokens) ?? null,
    totalTokens: null,
  }
}

/** Reduce the agent-error op body to name plus a cleaned, bounded summary. */
function errorDetailOf(body: unknown): TelemetryErrorDetail | undefined {
  if (typeof body !== 'object' || body === null) return undefined
  const name = readString(body, 'name')
  if (name === undefined) return undefined
  const message = readString(body, 'message')
  return {
    name,
    ...(message === undefined ? {} : { summary: cleanSummary(message) }),
  }
}

/** Strip control characters, collapse whitespace, redact credential-bearing substrings, and bound the length of an error summary.
 * @param value - Raw error summary text.
 * @returns The cleaned, length-bounded summary.
 */
export function cleanSummary(value: string): string {
  const collapsed = value
    .replace(/[\u0000-\u001f\u007f]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
  const sanitized = sanitizeSensitiveSummary(collapsed)
  return sanitized.length > SUMMARY_MAX_LENGTH ? `${sanitized.slice(0, SUMMARY_MAX_LENGTH)}…` : sanitized
}

/** Read the tool-result failure flag without touching the result message content. */
function readMessageErrorFlag(body: unknown): boolean {
  if (typeof body !== 'object' || body === null) return false
  const message = readRecord(body, 'message')
  if (message === undefined) return false
  const content: unknown = message.content
  if (!Array.isArray(content)) return false
  return content.some(
    (block): boolean =>
      typeof block === 'object' && block !== null && 'isError' in block && (block as { isError?: unknown }).isError === true,
  )
}

function duration(now: number, startedAt: number | undefined): number | null {
  if (startedAt === undefined) return null
  const elapsed = now - startedAt
  return elapsed >= 0 ? elapsed : null
}

function numberAttribute(value: string | number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function readRecord(body: unknown, field: string): Record<string, unknown> | undefined {
  if (typeof body !== 'object' || body === null) return undefined
  const value = (body as Record<string, unknown>)[field]
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

function readString(body: unknown, field: string): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined
  const value = (body as Record<string, unknown>)[field]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function readBoolean(body: unknown, field: string): boolean | undefined {
  if (typeof body !== 'object' || body === null) return undefined
  const value = (body as Record<string, unknown>)[field]
  return typeof value === 'boolean' ? value : undefined
}

function readNumber(body: unknown, field: string): number | undefined {
  if (typeof body !== 'object' || body === null) return undefined
  const value = (body as Record<string, unknown>)[field]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function nonNegativeNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}
