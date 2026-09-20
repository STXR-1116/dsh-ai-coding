/** Asynchronous telemetry batch reporter: splitting, delivery, per-event acks, and backoff. */

import type { CollectorAuthorizationState, CollectorFailure, CollectorMode, TelemetryBatchRequest, TelemetryBatchResult, TelemetryQueueSettings } from '../types.ts'
import type { PendingBatch, TelemetryQueue } from './queue.ts'
import { sanitizeSensitiveSummary } from './sanitize.ts'

/** Send outcome; every terminal state is explicit so the queue policy stays decidable. */
export type TelemetrySendOutcome =
  | { readonly status: 'sent'; readonly result: TelemetryBatchResult }
  /** 401 whose token refresh also failed; Host credentials were cleared. */
  | { readonly status: 'signed-out' }
  /** 403 PROJECT_ACCESS_REVOKED for this batch's project. */
  | { readonly status: 'revoked' }
  /** Transport failure, timeout, 5xx, or protocol error; retried with backoff. */
  | { readonly status: 'failed'; readonly code: string; readonly summary: string }

/**
 * Sends one marked batch for the given account partition; implementations own
 * the HTTP timeout and Bearer injection. The `accountId` is the partition the
 * batch was claimed from — the implementation must re-resolve its own account
 * and refuse to send when the two disagree, so the queue partition and the
 * `Authorization` identity cannot diverge across an await.
 */
export type TelemetrySend = (batch: TelemetryBatchRequest, accountId: string) => Promise<TelemetrySendOutcome>

/** Resolves the account partition the reporter may drain, without exposing tokens. */
export type TelemetryAccountResolve = () => Promise<{ readonly userId: string } | { readonly status: 'signed-out' | 'not-ready' }>

/** Highest backoff multiplier applied to repeated failures. */
const MAX_BACKOFF_EXPONENT = 4
/** Bound for failure summaries surfaced in status. */
const FAILURE_SUMMARY_MAX_LENGTH = 200

/**
 * Background reporter over a {@link TelemetryQueue}. Draining happens only on
 * the timer, on flush requests, and at shutdown — never on the capture hot
 * path. Each drain resolves the current account, expires retention-overdue
 * rows, then delivers single-project batches. Only accepted/duplicate acks
 * delete rows; retryable acks keep rows at the server-provided delay through
 * the local backoff; rejected rows become persisted `rejected` gaps; a 403
 * revocation stops the project partition with an `authorization_revoked`
 * gap; a failed 401 refresh pauses sending as signed-out. Transport failures
 * never throw into the caller.
 */
export class TelemetryReporter {
  private paused = false
  private signedOut = false
  private notReady = false
  private authorizationRevoked = false
  private failing = false
  private lastFailure: CollectorFailure | null = null
  private lastAcceptedAt: string | null = null
  private storageError: string | null = null
  private timer: NodeJS.Timeout | undefined
  private inFlight: Promise<void> | null = null
  private queuedDrain = false

  constructor(
    private readonly queue: TelemetryQueue,
    private readonly settings: TelemetryQueueSettings,
    private readonly deps: {
      readonly send: TelemetrySend | undefined
      readonly resolveAccount: TelemetryAccountResolve
      readonly now?: () => number
    },
  ) {}

  /** Start the periodic flush timer. */
  start(): void {
    if (this.timer !== undefined) return
    this.timer = setInterval(() => {
      void this.drainAsync()
    }, this.settings.flushIntervalMs)
    this.timer.unref()
  }

  /** Stop the periodic timer without touching queued rows. */
  stop(): void {
    if (this.timer === undefined) return
    clearInterval(this.timer)
    this.timer = undefined
  }

  /** Pause the collector: no new events enqueue and no batches send; rows are kept. */
  pause(): void {
    this.paused = true
  }

  /** Resume after a pause and schedule a drain. */
  resume(): void {
    this.paused = false
    void this.drainAsync()
  }

  /** Kick an immediate asynchronous drain; never waits for the network. */
  flush(): void {
    void this.drainAsync()
  }

  /** Mark the pipeline storage-unusable; sending stops until restart.
   * @param message - Bounded storage failure summary.
   */
  failStorage(message: string): void {
    this.storageError = message
  }

  /** Clear the authorization-revoked mode after the user re-selects a project. */
  clearRevocation(): void {
    this.authorizationRevoked = false
  }

  /** Current browser-safe pipeline state for the collector status view.
   * @param projectId - Currently bound project, or null while unbound.
   * @returns The browser-safe reporter state.
   */
  status(projectId: string | null): {
    readonly mode: CollectorMode
    readonly queueEventCount: number
    readonly queueByteCount: number
    readonly lastAcceptedAt: string | null
    readonly lastFailure: CollectorFailure | null
    readonly gapCount: number
    readonly authorizationState: CollectorAuthorizationState
    readonly storageError: string | null
  } {
    const counts = this.queue.counts()
    return {
      mode: this.mode(),
      queueEventCount: counts.events,
      queueByteCount: counts.bytes,
      lastAcceptedAt: this.lastAcceptedAt,
      lastFailure: this.lastFailure,
      gapCount: counts.gaps,
      authorizationState: this.authorizationRevoked ? 'revoked' : projectId === null ? 'unknown' : 'authorized',
      storageError: this.storageError,
    }
  }

  /**
   * Final drain for Host dispose: stop the timer and await one last delivery
   * pass. Best effort — a still-failing service must not hang or fail
   * application teardown.
   */
  async shutdown(): Promise<void> {
    this.stop()
    try {
      await this.drainAsync()
    } catch {
      // Teardown must not fail because a delivery attempt failed.
    }
  }

  /** Drain once; concurrent requests join the running drain and re-trigger once. */
  private drainAsync(): Promise<void> {
    if (this.inFlight !== null) {
      this.queuedDrain = true
      return this.inFlight
    }
    this.inFlight = this.runDrain()
      .catch((error: unknown) => {
        this.lastFailure = {
          stage: 'send',
          code: 'REPORTER_FAILED',
          at: new Date(this.now()).toISOString(),
          summary: sanitizeSensitiveSummary(error instanceof Error ? error.message : 'reporter drain failed').slice(0, FAILURE_SUMMARY_MAX_LENGTH),
        }
        this.failing = true
      })
      .finally(() => {
        this.inFlight = null
        if (this.queuedDrain) {
          this.queuedDrain = false
          void this.drainAsync()
        }
      })
    return this.inFlight
  }

  private async runDrain(): Promise<void> {
    if (this.paused || this.storageError !== null) return
    if (this.deps.send === undefined) {
      this.notReady = true
      return
    }
    this.notReady = false
    let account: Awaited<ReturnType<TelemetryAccountResolve>>
    try {
      account = await this.deps.resolveAccount()
    } catch (error) {
      // Account resolution throwing is a recoverable failure like any other:
      // no claim is held, rows stay queued, and the next drain retries.
      this.lastFailure = {
        stage: 'send',
        code: 'ACCOUNT_RESOLVE_FAILED',
        at: new Date(this.now()).toISOString(),
        summary: sanitizeSensitiveSummary(error instanceof Error ? error.message : 'account resolution failed').slice(0, FAILURE_SUMMARY_MAX_LENGTH),
      }
      this.failing = true
      return
    }
    if ('status' in account) {
      this.signedOut = account.status === 'signed-out'
      this.notReady = account.status === 'not-ready'
      return
    }
    this.signedOut = false
    const accountId = account.userId
    this.queue.expireOverdue(this.now())
    let idleRounds = 0
    for (;;) {
      const batch = this.queue.pendingBatch(accountId, this.now())
      if (batch === null) return
      if (this.queue.isRevoked(accountId, batch.projectId)) {
        // A revoked project keeps no queue; this guard only fires for rows
        // enqueued after revocation, and defers them out of the due window.
        this.authorizationRevoked = true
        this.queue.deferProject(accountId, batch.projectId, this.backoffMs(1), this.now())
        return
      }
      let outcome: TelemetrySendOutcome
      try {
        outcome = await this.deps.send(
          {
            schemaVersion: 1,
            batchId: batch.batchId,
            projectId: batch.projectId,
            clientSentAt: new Date(this.now()).toISOString(),
            events: batch.events.map(event => event.payload),
          },
          accountId,
        )
      } catch (error) {
        // A throwing send must land on the same recoverable path as an
        // explicit failure: reportFailure releases the claim and reschedules
        // every row, so the partition recovers on the next drain.
        this.recoverBatch(
          batch.batchId,
          'TELEMETRY_SEND_THREW',
          sanitizeSensitiveSummary(error instanceof Error ? error.message : 'telemetry send failed').slice(0, FAILURE_SUMMARY_MAX_LENGTH),
        )
        return
      }
      if (outcome.status === 'sent') {
        let progress: boolean
        try {
          progress = this.acknowledgeBatch(accountId, batch.projectId, batch, outcome.result)
        } catch (error) {
          // An ACK application failure (e.g. storage error) lands on the same
          // recoverable path as a failed send: reportFailure releases the
          // claim and registers a retry, so the batch is re-sent in full.
          this.recoverBatch(
            batch.batchId,
            'TELEMETRY_ACK_FAILED',
            sanitizeSensitiveSummary(error instanceof Error ? error.message : 'ack application failed').slice(0, FAILURE_SUMMARY_MAX_LENGTH),
          )
          return
        }
        if (!progress) {
          idleRounds += 1
          if (idleRounds >= 2) return
        }
        continue
      }
      if (outcome.status === 'signed-out') {
        this.signedOut = true
        return
      }
      if (outcome.status === 'revoked') {
        const removed = this.queue.revokeProject(accountId, batch.projectId)
        this.queue.enqueueGap(
          accountId,
          batch.projectId,
          null,
          {
            reason: 'authorization_revoked',
            count: removed.count,
            ...(removed.firstEventId === null ? {} : { firstEventId: removed.firstEventId }),
            ...(removed.lastEventId === null ? {} : { lastEventId: removed.lastEventId }),
          },
          this.now(),
        )
        this.authorizationRevoked = true
        return
      }
      const attempts = Math.max(...batch.events.map(event => event.attempts), 0)
      this.recoverBatch(batch.batchId, outcome.code, outcome.summary, attempts + 1)
      return
    }
  }

  /**
   * Unified recoverable failure registration for a claimed batch. The primary
   * path is `queue.reportFailure` (releases the claim, bumps attempts,
   * registers the retry). If the recovery operation itself throws, the claim
   * is released through the minimal `queue.releaseClaim` so the rows are
   * immediately recoverable without waiting for the lease; if even that
   * throws, the pipeline enters the explicit `storage-error` mode instead of
   * silently stalling. Summaries are sanitized before any persistence.
   */
  private recoverBatch(batchId: string, code: string, summary: string, attemptsBump = 1): void {
    try {
      const attempts = Math.max(attemptsBump - 1, 0)
      const safeSummary = sanitizeSensitiveSummary(summary).slice(0, FAILURE_SUMMARY_MAX_LENGTH)
      this.queue.reportFailure(batchId, code, safeSummary, this.now() + this.backoffMs(attempts + 1), this.now())
      this.lastFailure = {
        stage: 'send',
        code,
        at: new Date(this.now()).toISOString(),
        summary: safeSummary,
      }
      this.failing = true
    } catch (recoveryError) {
      const safeSummary = sanitizeSensitiveSummary(
        `recovery failed for batch ${batchId} (${code}): ${recoveryError instanceof Error ? recoveryError.message : 'unknown'}`,
      ).slice(0, FAILURE_SUMMARY_MAX_LENGTH)
      try {
        this.queue.releaseClaim(batchId)
      } catch {
        // The queue is unusable; stop the pipeline visibly instead of leaving
        // the claim to expire silently.
        this.failStorage(`claim release failed: ${safeSummary}`)
        this.lastFailure = {
          stage: 'send',
          code: 'REPORTER_RECOVERY_FAILED',
          at: new Date(this.now()).toISOString(),
          summary: safeSummary,
        }
        this.failing = true
        return
      }
      this.lastFailure = {
        stage: 'send',
        code: 'REPORTER_RECOVERY_FAILED',
        at: new Date(this.now()).toISOString(),
        summary: safeSummary,
      }
      this.failing = true
    }
  }

  /**
   * Apply per-event acks after strict protocol validation: the response batch
   * id must match, and the ACK set must cover exactly the sent events with no
   * duplicates or unknown ids. Any mismatch fails closed — no row is deleted
   * or re-scheduled from a partially trusted response; the whole batch goes
   * through the recoverable failure path instead.
   * @returns true when at least one row left the queue.
   */
  private acknowledgeBatch(accountId: string, projectId: string, batch: PendingBatch, result: TelemetryBatchResult): boolean {
    const sentIds = new Set(batch.events.map(event => event.eventId))
    const ackIds = result.results.map(ack => ack.eventId)
    const ackSet = new Set(ackIds)
    const mismatch =
      result.batchId !== batch.batchId ||
      result.results.length !== batch.events.length ||
      ackIds.some(id => !sentIds.has(id)) ||
      ackSet.size !== batch.events.length
    if (mismatch) {
      const foreignBatchId = result.batchId !== batch.batchId
      const summary = `batch ${batch.batchId}: ack set mismatch (expected ${batch.events.length}, got ${result.results.length}, foreign batch id ${foreignBatchId ? 'yes' : 'no'})`
      this.queue.reportFailure(batch.batchId, 'TELEMETRY_ACK_MISMATCH', summary.slice(0, FAILURE_SUMMARY_MAX_LENGTH), this.now() + this.backoffMs(1), this.now())
      this.lastFailure = {
        stage: 'parse',
        code: 'TELEMETRY_ACK_MISMATCH',
        at: new Date(this.now()).toISOString(),
        summary: summary.slice(0, FAILURE_SUMMARY_MAX_LENGTH),
      }
      this.failing = true
      return false
    }
    const acks = result.results.map(ack => ({
      eventId: ack.eventId,
      status: ack.status,
      ...(ack.status === 'retryable'
        ? { nextAttemptAt: this.now() + Math.max(ack.retryAfterSeconds * 1000, this.backoffMs(1)), reason: ack.reason }
        : {}),
      ...(ack.status === 'rejected' ? { reason: ack.reason } : {}),
    }))
    const rejectedRange = this.queue.acknowledge(batch.batchId, acks, result.serverCheckpoint)
    const accepted = result.results.filter(ack => ack.status === 'accepted' || ack.status === 'duplicate').length
    if (accepted > 0) {
      this.lastAcceptedAt = new Date(this.now()).toISOString()
      this.failing = false
    }
    if (rejectedRange !== null && rejectedRange.count > 0) {
      this.queue.enqueueGap(
        accountId,
        projectId,
        null,
        {
          reason: 'rejected',
          count: rejectedRange.count,
          ...(rejectedRange.firstEventId === null ? {} : { firstEventId: rejectedRange.firstEventId }),
          ...(rejectedRange.lastEventId === null ? {} : { lastEventId: rejectedRange.lastEventId }),
        },
        this.now(),
      )
      this.lastFailure = {
        stage: 'send',
        code: 'TELEMETRY_EVENT_REJECTED',
        at: new Date(this.now()).toISOString(),
        summary: `${rejectedRange.count} event(s) permanently rejected`,
      }
      this.failing = true
    }
    return accepted > 0 || (rejectedRange?.count ?? 0) > 0
  }

  /** Exponential backoff derived from the configured flush interval; no standalone tunable. */
  private backoffMs(attempts: number): number {
    const exponent = Math.min(Math.max(attempts - 1, 0), MAX_BACKOFF_EXPONENT)
    return this.settings.flushIntervalMs * 2 ** exponent
  }

  private now(): number {
    return (this.deps.now ?? Date.now)()
  }

  private mode(): CollectorMode {
    if (this.storageError !== null) return 'storage-error'
    if (this.paused) return 'paused'
    if (this.signedOut) return 'signed-out'
    if (this.notReady) return 'not-ready'
    if (this.authorizationRevoked) return 'authorization-revoked'
    if (this.failing) return 'failed'
    return 'active'
  }
}
