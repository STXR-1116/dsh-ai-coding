/** The single AI Coding collector backend: capture -> whitelist projection -> durable queue. */

import { randomUUID } from 'node:crypto'
import { SessionTelemetryBackend, SessionTelemetryCoordinator, type SessionTelemetryRecord, type SessionTelemetrySharingStatus } from '@deepseek-ai/dsh-session-telemetry'
import type { Context } from '@deepseek-ai/cordis'
import { TelemetryProjection } from './projection.ts'
import { TelemetryQueue, TelemetryStorageError } from './queue.ts'
import { TelemetryReporter } from './reporter.ts'
import type { CollectorSnapshot, TelemetryEventDto } from '../types.ts'

/** Resolves the live-session predicate used for the collector start edge. */
export type SessionLiveness = (sessionId: string) => boolean

/**
 * The one `sessionTelemetry` implementation for the AI Coding profile. Cordis
 * service registration under the `sessionTelemetry` key throws on a second
 * implementation, so a profile either mounts this collector or another
 * telemetry backend — never both. Records arrive from the reused
 * {@link SessionTelemetryCoordinator} live capture; unbound sessions produce
 * nothing, bound sessions are projected to the whitelist DTO and enqueued
 * synchronously (no network on the hot path). The record body is dropped as
 * soon as `emit` returns and never reaches the queue, the reporter, or the
 * wire. `sharing` deliberately over-discloses as `full`: the projection
 * ships metadata only, but the disclosure enum has no metadata-only value
 * and users must assume recorded data leaves the process.
 */
export class TeamSkillTelemetryBackend extends SessionTelemetryBackend {
  override readonly sharing: SessionTelemetrySharingStatus = 'full'

  private readonly projection = new TelemetryProjection()
  private readonly bindings = new Map<string, string>()
  private readonly startedEmitted = new Set<string>()
  private receivedCount = 0
  private isolatedCount = 0
  private account: { readonly userId: string } | { readonly status: 'signed-out' | 'not-ready' } = { status: 'signed-out' }

  /** Records that reached the collector entry for bound sessions (any account state).
   * @returns The reception count since collector construction. */
  receivedEventCount(): number {
    return this.receivedCount
  }

  /** Records that reached the collector for bound sessions while no account
   * partition was publishable and were dropped (isolation is observable).
   * @returns The isolation drop count since collector construction. */
  isolatedEventCount(): number {
    return this.isolatedCount
  }

  constructor(
    ctx: Context,
    private readonly queue: TelemetryQueue,
    private readonly reporter: TelemetryReporter,
    private readonly isSessionLive: SessionLiveness,
  ) {
    super(ctx)
    // The coordinator registers its own capture listeners and dispose effect
    // on the context; it needs no further reference from the backend.
    new SessionTelemetryCoordinator(ctx, this, 'live')
  }

  /**
   * Bind one live session to its active project and emit the collector's
   * `session.started` edge. A binding is the only proven start this collector
   * observes; sessions bound late never receive a retroactive start event.
   * @param sessionId - Live DSH session identity.
   * @param projectId - Opaque authorized project identity.
   */
  configureProject(sessionId: string, projectId: string): void {
    this.bindings.set(sessionId, projectId)
    this.reporter.clearRevocation()
    if (this.startedEmitted.has(sessionId) || !this.isSessionLive(sessionId)) return
    this.startedEmitted.add(sessionId)
    this.enqueueOps(sessionId, projectId, 'session.started', 'collector/binding', { occurredAt: new Date(this.now()).toISOString() })
  }

  /**
   * Clear one session's collector binding and forget its pairing state, so
   * late events can never be re-attributed to the previous project. The
   * started edge is forgotten too: a re-binding (same or different project)
   * of a still-live session is a new collection lifecycle and must produce
   * exactly one fresh `session.started`.
   * @param sessionId - Live DSH session identity.
   */
  clearProject(sessionId: string): void {
    this.bindings.delete(sessionId)
    this.projection.forget(sessionId)
    this.startedEmitted.delete(sessionId)
  }

  /** The project currently bound to a session, when any.
   * @param sessionId - DSH session whose binding is read.
   * @returns The bound project id, or undefined when the session is unbound.
   */
  projectOf(sessionId: string): string | undefined {
    return this.bindings.get(sessionId)
  }

  /** The cached capture-time account partition user id, when signed in.
   * @returns The signed-in user id, or undefined while signed out or not ready.
   */
  cachedAccountUserId(): string | undefined {
    return 'userId' in this.account ? this.account.userId : undefined
  }

  /** Every distinct project currently bound by live sessions.
   * @returns Distinct bound project ids; empty when no live session is bound.
   */
  boundProjects(): readonly string[] {
    return [...new Set(this.bindings.values())]
  }

  /** Update the cached capture-time account partition; events while signed out are dropped.
   * @param account - The signed-in user id, or the explicit signed-out or not-ready state.
   */
  setAccount(account: { readonly userId: string } | { readonly status: 'signed-out' | 'not-ready' }): void {
    this.account = account
  }

  /** Non-blocking capture entry point; see {@link SessionTelemetryBackend.emit}. */
  override emit(record: SessionTelemetryRecord): void {
    const sessionId = record.attributes['session.id']
    if (typeof sessionId !== 'string') return
    const projectId = this.bindings.get(sessionId)
    if (projectId === undefined) return
    this.receivedCount += 1
    if (record.channel === 'ops' && record.attributes['telemetry.op'] === 'shutdown') {
      this.bindings.delete(sessionId)
      this.projection.forget(sessionId)
      // Only prove an end for sessions whose start this collector observed.
      if (!this.startedEmitted.delete(sessionId)) return
    }
    const accountId = 'userId' in this.account ? this.account.userId : undefined
    if (accountId === undefined) {
      // The event reached the collector for a bound session while no account
      // partition was publishable (authentication pending/isolated or signed
      // out); it is dropped and counted so isolation is observable.
      this.isolatedCount += 1
      return
    }
    for (const fact of this.projection.project(record, sessionId)) {
      const event: TelemetryEventDto = {
        schemaVersion: 1,
        // One source event can project several facts (a step opens a step and
        // its model request), so the stable ledger identity includes the kind.
        eventId:
          fact.sourceSeq === undefined
            ? `${this.queue.installationId}:${randomUUID()}`
            : `${this.queue.installationId}:${sessionId}:${fact.sourceSeq}:${fact.kind}`,
        installationId: this.queue.installationId,
        projectId,
        ...fact,
        sessionId,
      }
      try {
        this.queue.enqueue(event, accountId, this.now())
      } catch (error) {
        if (error instanceof TelemetryStorageError) this.reporter.failStorage(error.message)
      }
    }
  }

  /** Forward the turn-end boundary as a reporter flush hint. */
  override flush(): void {
    this.reporter.flush()
  }

  /** Drain pending batches and quiesce; awaited by the coordinator's dispose. */
  override async shutdown(): Promise<void> {
    await this.reporter.shutdown()
  }

  /** Enqueue one ops-sourced event (collector edges and gaps) with a fresh persisted identity.
   * @param sessionId - DSH session id, or null for a cross-session gap.
   * @param projectId - Project the event is attributed to, or null.
   * @param kind - Whitelisted event kind.
   * @param sourceType - Ops source label.
   * @param rest - Remaining observed fields (occurred time, gap, error, outcome).
   * @returns The persisted event id.
   */
  enqueueOps(
    sessionId: string | null,
    projectId: string | null,
    kind: TelemetryEventDto['kind'],
    sourceType: string,
    rest: Partial<Pick<TelemetryEventDto, 'occurredAt' | 'gap' | 'error' | 'outcome'>>,
  ): string {
    const accountId = 'userId' in this.account ? this.account.userId : undefined
    if (accountId === undefined) return ''
    const eventId = `${this.queue.installationId}:ops:${randomUUID()}`
    const event: TelemetryEventDto = {
      schemaVersion: 1,
      eventId,
      installationId: this.queue.installationId,
      projectId: projectId ?? '',
      sessionId,
      kind,
      occurredAt: rest.occurredAt ?? new Date(this.now()).toISOString(),
      sourceType,
      ...rest,
    }
    try {
      this.queue.enqueue(event, accountId, this.now())
    } catch (error) {
      if (error instanceof TelemetryStorageError) this.reporter.failStorage(error.message)
    }
    return eventId
  }

  private now(): number {
    return Date.now()
  }
}

/**
 * Collector control surface: status reads and pause/resume/flush/clear. It
 * never touches SQLite directly and never returns void — every operation
 * reports the resulting pipeline state or an explicit failure.
 */
export class CollectorController {
  constructor(
    private readonly parts:
      | {
        readonly queue: TelemetryQueue
        readonly reporter: TelemetryReporter
        readonly backend: TeamSkillTelemetryBackend
      }
      | undefined,
    private readonly missing: readonly string[],
    private readonly storageError: string | null,
  ) {}

  /** Build a controller for a not-ready deployment (missing configuration).
   * @param missing - Missing configuration field names, never secret values.
   * @returns A controller that always reports the not-ready state.
   */
  static notReady(missing: readonly string[]): CollectorController {
    return new CollectorController(undefined, missing, null)
  }

  /** Build a controller whose queue storage failed to open; the mode stays `storage-error`.
   * @param message - Bounded storage failure summary.
   * @param missing - Missing configuration field names, never secret values.
   * @returns A controller that always reports the storage-error state.
   */
  static storageError(message: string, missing: readonly string[]): CollectorController {
    return new CollectorController(undefined, missing, message)
  }

  /** Read the full pipeline status for the collector page.
   * @returns The browser-safe collector snapshot.
   */
  status(): CollectorSnapshot {
    if (this.parts === undefined) {
      if (this.storageError !== null) {
        return {
          status: 'ready',
          value: {
            mode: 'storage-error',
            projectId: null,
            queueEventCount: 0,
            queueByteCount: 0,
            receivedEventCount: 0,
            isolatedEventCount: 0,
            lastAcceptedAt: null,
            lastFailure: null,
            gapCount: 0,
            authorizationState: 'unknown',
            storageError: this.storageError,
          },
        }
      }
      return { status: 'not-ready', missing: this.missing }
    }
    const bound = this.parts.backend.boundProjects()
    const projectId = bound.length === 1 ? (bound[0] ?? null) : null
    return {
      status: 'ready',
      value: {
        projectId,
        ...this.parts.reporter.status(projectId),
        receivedEventCount: this.parts.backend.receivedEventCount(),
        isolatedEventCount: this.parts.backend.isolatedEventCount(),
      },
    }
  }

  /** Pause capture and delivery, keeping queued rows.
   * @returns The collector snapshot after pausing.
   */
  pause(): CollectorSnapshot {
    if (this.parts === undefined) return this.status()
    this.parts.reporter.pause()
    return this.status()
  }

  /** Resume capture and delivery.
   * @returns The collector snapshot after resuming.
   */
  resume(): CollectorSnapshot {
    if (this.parts === undefined) return this.status()
    this.parts.reporter.resume()
    return this.status()
  }

  /** Start an asynchronous flush and return immediately with current state.
   * @returns The collector snapshot captured when the flush started.
   */
  flush(): CollectorSnapshot {
    if (this.parts === undefined) return this.status()
    this.parts.reporter.flush()
    return this.status()
  }

  /**
   * Delete every queued event after explicit user confirmation and persist
   * one `manual_clear` gap per affected project, so the loss stays visible
   * end to end.
   * @returns The collector snapshot after the clear.
   */
  clearPending(): CollectorSnapshot {
    if (this.parts === undefined) return this.status()
    // Cleared rows and their gaps share the same capture-time account partition.
    const accountId = this.parts.backend.cachedAccountUserId()
    if (accountId === undefined) {
      return { status: 'failed', code: 'SIGNED_OUT', message: '账号未登录，无法清理采集队列。' }
    }
    for (const range of this.parts.queue.clearAccount(accountId)) {
      if (range.count === 0) continue
      this.parts.queue.enqueueGap(
        accountId,
        range.projectId,
        null,
        {
          reason: 'manual_clear',
          count: range.count,
          ...(range.firstEventId === null ? {} : { firstEventId: range.firstEventId }),
          ...(range.lastEventId === null ? {} : { lastEventId: range.lastEventId }),
        },
        Date.now(),
      )
    }
    return this.status()
  }
}
