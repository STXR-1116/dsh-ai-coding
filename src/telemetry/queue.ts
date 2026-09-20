/** Independent durable telemetry queue: SQLite-backed, transactional, gap-preserving. */

import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { TelemetryEventDto, TelemetryGapDetail, TelemetryQueueSettings } from '../types.ts'

/** Current queue schema; unrecognized on-disk versions stop the collector instead of migrating. */
export const TELEMETRY_QUEUE_SCHEMA_VERSION = 2 as const

/** Raised when the queue database cannot be opened, validated, or written. */
export class TelemetryStorageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TelemetryStorageError'
  }
}

/** One marked outgoing batch as the reporter consumes it. */
export interface PendingBatch {
  readonly batchId: string
  readonly projectId: string
  readonly events: readonly QueuedTelemetryEvent[]
}

/** One queued event as the reporter consumes it. */
interface QueuedTelemetryEvent {
  readonly eventId: string
  readonly projectId: string
  readonly payload: TelemetryEventDto
  readonly bytes: number
  readonly attempts: number
}

/** Gap facts retained for gap-event construction after rows are removed. */
export interface QueueGapRange {
  readonly count: number
  readonly firstEventId: string | null
  readonly lastEventId: string | null
}

/** Per-event acks handed back to the queue after one batch attempt. */
/** Bookkeeping row shape shared by the queue's maintenance SELECTs. */
interface EventRow {
  event_id: string
  account_id: string
  project_id: string
  session_id: string | null
}

/** Per-event acks handed back to the queue after one batch attempt. */
export interface TelemetryAckInput {
  readonly eventId: string
  readonly status: 'accepted' | 'duplicate' | 'retryable' | 'rejected'
  /** Reporter-computed retry instant for `retryable` rows. */
  readonly nextAttemptAt?: number
  readonly reason?: string
}

/**
 * Persistent queue under `<stateDirectory>/telemetry/telemetry.db`, one file
 * independent of session persistence and installation records. Every write
 * commits inside a transaction before it counts; only `accepted`/`duplicate`
 * acks delete rows, and checkpoint updates commit in the same transaction as
 * their batch confirmation. Rows are partitioned by account so a new account
 * can never send or clear a previous account's queue. Capacity overflow,
 * retention expiry, and attempt exhaustion all produce persisted
 * `delivery.gap` events instead of silent drops. An unreadable or
 * future-versioned database raises {@link TelemetryStorageError} — the
 * collector stops sending rather than rebuilding or migrating.
 */
export class TelemetryQueue {
  private readonly db: DatabaseSync
  private readonly settings: TelemetryQueueSettings
  private readonly installationIdValue: string
  private closed = false

  private constructor(db: DatabaseSync, settings: TelemetryQueueSettings, installationIdValue: string) {
    this.db = db
    this.settings = settings
    this.installationIdValue = installationIdValue
  }

  /** Open (or create) the queue database and return the validated handle.
   * @param stateDirectory - Host-private state root.
   * @param settings - Validated queue capacity, batch, and retention settings.
   * @param options - Test seam: injects the clock used for claim-lease arithmetic.
   * @returns The opened queue.
   * @throws TelemetryStorageError when the database exists with an unknown schema or is unusable.
   */
  static open(stateDirectory: string, settings: TelemetryQueueSettings, options: { readonly now?: () => number } = {}): TelemetryQueue {
    const directory = join(stateDirectory, 'telemetry')
    try {
      mkdirSync(directory, { recursive: true, mode: 0o700 })
    } catch (error) {
      throw new TelemetryStorageError(`telemetry queue directory could not be created: ${String(error)}`)
    }
    const db = new DatabaseSync(join(directory, 'telemetry.db'))
    try {
      db.exec('PRAGMA journal_mode = WAL;')
      db.exec('PRAGMA synchronous = NORMAL;')
      db.exec(`
        CREATE TABLE IF NOT EXISTS telemetry_meta (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS telemetry_events (
          event_id TEXT PRIMARY KEY,
          account_id TEXT NOT NULL,
          project_id TEXT NOT NULL,
          session_id TEXT,
          payload TEXT NOT NULL,
          bytes INTEGER NOT NULL,
          created_at INTEGER NOT NULL,
          attempts INTEGER NOT NULL DEFAULT 0,
          next_attempt_at INTEGER NOT NULL DEFAULT 0,
          batch_id TEXT,
          claimed_at INTEGER NOT NULL DEFAULT 0,
          is_gap INTEGER NOT NULL DEFAULT 0,
          last_error_code TEXT,
          last_error TEXT
        );
        CREATE INDEX IF NOT EXISTS telemetry_events_due
          ON telemetry_events (account_id, next_attempt_at);
        CREATE TABLE IF NOT EXISTS telemetry_checkpoints (
          account_id TEXT NOT NULL,
          project_id TEXT NOT NULL,
          checkpoint TEXT NOT NULL,
          PRIMARY KEY (account_id, project_id)
        );
        CREATE TABLE IF NOT EXISTS telemetry_revocations (
          account_id TEXT NOT NULL,
          project_id TEXT NOT NULL,
          PRIMARY KEY (account_id, project_id)
        );
      `)
      const version = readMeta(db, 'schema_version')
      if (version === undefined) {
        db.prepare('INSERT INTO telemetry_meta (key, value) VALUES (?, ?)').run('schema_version', String(TELEMETRY_QUEUE_SCHEMA_VERSION))
      } else if (version !== String(TELEMETRY_QUEUE_SCHEMA_VERSION)) {
        throw new TelemetryStorageError(`telemetry queue schema version ${version} is not recognized; sending stopped`)
      }
      let installationId = readMeta(db, 'installation_id')
      if (installationId === undefined) {
        installationId = randomUUID()
        db.prepare('INSERT INTO telemetry_meta (key, value) VALUES (?, ?)').run('installation_id', installationId)
      }
      // 崩溃恢复：只释放超过租约（claimTimeoutMs）的过期 claim。仍存活的
      // 未过期 claim——包括另一个同时打开的队列句柄所持有的——不能被释放或并发发送。
      const openThreshold = options.now === undefined ? Date.now() - settings.claimTimeoutMs : options.now() - settings.claimTimeoutMs
      db.prepare('UPDATE telemetry_events SET batch_id = NULL WHERE batch_id IS NOT NULL AND claimed_at <= ?').run(openThreshold)
      return new TelemetryQueue(db, settings, installationId)
    } catch (error) {
      db.close()
      throw error instanceof TelemetryStorageError ? error : new TelemetryStorageError(`telemetry queue unusable: ${String(error)}`)
    }
  }

  /** Persisted installation identity for stable cross-restart event ids. */
  get installationId(): string {
    return this.installationIdValue
  }

  /**
   * Enqueue one structured event for an account partition. The insert
   * commits synchronously; duplicates (replayed records after restart) are
   * ignored by event id. Capacity enforcement afterwards may drop the oldest
   * unconfirmed events and persist one merged `overflow` gap.
   * @param event - Complete structured event DTO.
   * @param accountId - Host-local account partition owning the event.
   * @param now - Current Unix epoch milliseconds.
   * @returns true when the event was newly stored.
   */
  enqueue(event: TelemetryEventDto, accountId: string, now: number): boolean {
    if (this.closed) throw new TelemetryStorageError('telemetry queue is closed')
    let stored = false
    this.transaction(() => {
      stored = this.insertEvent(event, accountId, now)
    })
    return stored
  }

  /** Insert one event inside an already-open transaction; capacity-checked except for gaps. */
  private insertEvent(event: TelemetryEventDto, accountId: string, now: number): boolean {
    const payload = JSON.stringify(event)
    const bytes = Buffer.byteLength(payload, 'utf8')
    const isGap = event.kind === 'delivery.gap' ? 1 : 0
    const inserted = this.db
      .prepare(
        'INSERT OR IGNORE INTO telemetry_events (event_id, account_id, project_id, session_id, payload, bytes, created_at, is_gap) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(event.eventId, accountId, event.projectId, event.sessionId, payload, bytes, now, isGap)
    if (Number(inserted.changes) === 0) return false
    if (event.kind === 'delivery.gap') return true
    this.enforceCapacity(now)
    return true
  }

  /**
   * Persist one `delivery.gap` event for observed data loss.
   * @param accountId - Owning account partition.
   * @param projectId - Project the gap belongs to, when known.
   * @param sessionId - Session the gap belongs to, when not cross-session.
   * @param gap - Gap reason, count, and event-id range.
   * @param now - Current Unix epoch milliseconds.
   * @returns The stored gap event's id.
   */
  enqueueGap(accountId: string, projectId: string | null, sessionId: string | null, gap: TelemetryGapDetail, now: number): string {
    if (this.closed) throw new TelemetryStorageError('telemetry queue is closed')
    return this.transaction(() => this.insertGap(accountId, projectId, sessionId, gap, now))
  }

  /** Build and insert one gap event inside an already-open transaction. */
  private insertGap(accountId: string, projectId: string | null, sessionId: string | null, gap: TelemetryGapDetail, now: number): string {
    const eventId = `${this.installationIdValue}:gap:${randomUUID()}`
    const event = {
      schemaVersion: 1 as const,
      eventId,
      installationId: this.installationIdValue,
      projectId: projectId ?? '',
      sessionId,
      kind: 'delivery.gap' as const,
      occurredAt: new Date(now).toISOString(),
      sourceType: 'delivery/gap',
      gap,
    }
    this.insertEvent(event, accountId, now)
    return eventId
  }

  /**
   * Select the next due batch for an account: single-project, within the
   * batch event and byte limits, and mark it with a fresh batch id inside
   * the selection transaction.
   * @param accountId - Account partition to drain.
   * @param now - Current Unix epoch milliseconds.
   * @returns The marked batch, or null when nothing is due.
   */
  pendingBatch(accountId: string, now: number): PendingBatch | null {
    return this.transaction(() => {
      // 先释放其他持有者超过租约的 claim，再在本次事务内做选取与标记。
      this.db
        .prepare('UPDATE telemetry_events SET batch_id = NULL WHERE batch_id IS NOT NULL AND claimed_at <= ?')
        .run(now - this.settings.claimTimeoutMs)
      const first = this.db
        .prepare(
          'SELECT event_id, project_id, payload, bytes, attempts FROM telemetry_events WHERE account_id = ? AND next_attempt_at <= ? AND batch_id IS NULL ORDER BY rowid LIMIT 1',
        )
        .get(accountId, now) as { event_id: string; project_id: string; payload: string; bytes: number; attempts: number } | undefined
      if (first === undefined) return null
      const rows: Array<{ event_id: string; payload: string; bytes: number; attempts: number }> = []
      let totalBytes = 0
      const statement = this.db.prepare(
        'SELECT event_id, payload, bytes, attempts FROM telemetry_events WHERE account_id = ? AND project_id = ? AND next_attempt_at <= ? AND batch_id IS NULL ORDER BY rowid LIMIT ?',
      )
      for (const row of statement.all(accountId, first.project_id, now, this.settings.batchMaxEvents) as Array<{
        event_id: string
        payload: string
        bytes: number
        attempts: number
      }>) {
        // Always include the first row, even if it alone exceeds the byte
        // limit — otherwise an oversized event could never leave the queue.
        if (rows.length >= this.settings.batchMaxEvents || (rows.length > 0 && totalBytes + row.bytes > this.settings.batchMaxBytes)) break
        rows.push(row)
        totalBytes += row.bytes
      }
      if (rows.length === 0) return null
      const batchId = randomUUID()
      const mark = this.db.prepare('UPDATE telemetry_events SET batch_id = ?, claimed_at = ? WHERE event_id = ?')
      for (const row of rows) mark.run(batchId, now, row.event_id)
      return {
        batchId,
        projectId: first.project_id,
        events: rows.map(row => ({
          eventId: row.event_id,
          projectId: first.project_id,
          payload: parsePayload(row.payload),
          bytes: row.bytes,
          attempts: row.attempts,
        })),
      }
    })
  }

  /**
   * Apply per-event acks and the server checkpoint in one transaction: only
   * accepted/duplicate rows are deleted, retryable rows get their computed
   * retry instant, rejected rows are deleted and returned as a
   * `rejected`-gap range for the reporter to persist.
   * @param batchId - Batch the acks answer.
   * @param acks - Per-event statuses from the service.
   * @param checkpoint - Opaque server checkpoint stored with the confirmation.
   * @returns The rejected range, or null when nothing was rejected.
   */
  acknowledge(batchId: string, acks: readonly TelemetryAckInput[], checkpoint: string): QueueGapRange | null {
    return this.transaction(() => {
      const rows = this.db
        .prepare('SELECT event_id, account_id, project_id, session_id, is_gap FROM telemetry_events WHERE batch_id = ?')
        .all(batchId) as unknown as (EventRow & { is_gap: number })[]
      const byEvent = new Map(rows.map(row => [row.event_id, row]))
      const deleteRow = this.db.prepare('DELETE FROM telemetry_events WHERE event_id = ?')
      const retryRow = this.db.prepare(
        'UPDATE telemetry_events SET next_attempt_at = ?, last_error_code = ?, batch_id = NULL WHERE event_id = ?',
      )
      let rejected: QueueGapRange | null = null
      const rejectedIds: string[] = []
      let rejectedGapCount = 0
      for (const ack of acks) {
        const row = byEvent.get(ack.eventId)
        if (row === undefined) continue
        if (ack.status === 'accepted' || ack.status === 'duplicate') {
          deleteRow.run(ack.eventId)
          continue
        }
        if (ack.status === 'retryable') {
          retryRow.run(ack.nextAttemptAt ?? Number.MAX_SAFE_INTEGER, ack.reason ?? 'RETRYABLE', ack.eventId)
          continue
        }
        // A server-rejected gap must never spawn a replacement gap event (that
        // would loop forever); its loss stays visible through the persisted
        // counter, so the returned rejected range covers regular rows only.
        if (row.is_gap === 1) {
          rejectedGapCount += 1
          deleteRow.run(ack.eventId)
          continue
        }
        rejectedIds.push(ack.eventId)
        deleteRow.run(ack.eventId)
      }
      if (rejectedGapCount > 0) {
        this.db
          .prepare(
            'INSERT INTO telemetry_meta (key, value) VALUES (:lost, :count) ON CONFLICT (key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + :count AS TEXT)',
          )
          .run({ lost: 'lost_gap_events', count: String(rejectedGapCount) })
      }
      if (rejectedIds.length > 0) {
        const firstRejected = rejectedIds[0] ?? null
        const lastRejected = rejectedIds[rejectedIds.length - 1] ?? null
        rejected = {
          count: rejectedIds.length,
          firstEventId: firstRejected,
          lastEventId: lastRejected,
        }
      }
      const confirmed = rows.find(row => acks.some(ack => ack.eventId === row.event_id))
      if (confirmed !== undefined) {
        this.db
          .prepare(
            'INSERT INTO telemetry_checkpoints (account_id, project_id, checkpoint) VALUES (?, ?, ?) ON CONFLICT (account_id, project_id) DO UPDATE SET checkpoint = excluded.checkpoint',
          )
          .run(confirmed.account_id, confirmed.project_id, checkpoint)
      }
      return rejected
    })
  }

  /**
   * Minimal recovery release for a claimed batch when `reportFailure` itself
   * cannot run: the claim is cleared without touching attempts or the retry
   * instant, so the rows are immediately claimable again by the next drain.
   * @param batchId - Batch whose claim to release.
   */
  releaseClaim(batchId: string): void {
    this.db
      .prepare('UPDATE telemetry_events SET batch_id = NULL, claimed_at = 0 WHERE batch_id = ?')
      .run(batchId)
  }

  /**
   * Record a whole-batch delivery failure: every row gains an attempt, the
   * reporter-provided retry instant, and the failure facts; rows past the
   * attempt limit become persisted `expired` gaps.
   * @param batchId - Batch that failed.
   * @param code - Stable failure code.
   * @param message - Length-limited failure summary.
   * @param nextAttemptAt - Retry instant computed by the reporter's backoff.
   * @param now - Current Unix epoch milliseconds.
   */
  reportFailure(batchId: string, code: string, message: string, nextAttemptAt: number, now: number): void {
    this.transaction(() => {
      const rows = this.db
        .prepare('SELECT event_id, account_id, project_id, session_id, attempts FROM telemetry_events WHERE batch_id = ? ORDER BY rowid')
        .all(batchId) as unknown as EventRow[]
      const bump = this.db.prepare(
        'UPDATE telemetry_events SET attempts = attempts + 1, next_attempt_at = ?, last_error_code = ?, last_error = ?, batch_id = NULL WHERE event_id = ?',
      )
      for (const row of rows) bump.run(nextAttemptAt, code, message, row.event_id)
      this.expireExhausted(now)
    })
  }

  /**
   * Remove every queued event of one project partition after an authorization
   * revocation and record the revocation so the reporter refuses future
   * batches for the pair.
   * @param accountId - Account partition.
   * @param projectId - Revoked project.
   * @returns The removed range for the `authorization_revoked` gap.
   */
  revokeProject(accountId: string, projectId: string): QueueGapRange {
    return this.transaction(() => {
      this.db.prepare('INSERT OR IGNORE INTO telemetry_revocations (account_id, project_id) VALUES (?, ?)').run(accountId, projectId)
      return this.deletePartition(accountId, projectId)
    })
  }

  /** Whether the account/project pair is currently marked revoked.
   * @param accountId - Account partition.
   * @param projectId - Revoked project.
   * @returns Whether the pair is revoked.
   */
  isRevoked(accountId: string, projectId: string): boolean {
    return this.db.prepare('SELECT 1 AS one FROM telemetry_revocations WHERE account_id = ? AND project_id = ?').get(accountId, projectId) !== undefined
  }

  /**
   * Push every due row of one project partition out of the due window so a
   * blocked project cannot hot-loop the reporter.
   * @param accountId - Account partition.
   * @param projectId - Project to defer.
   * @param deferMs - Delay before the rows become due again.
   * @param now - Current Unix epoch milliseconds.
   */
  deferProject(accountId: string, projectId: string, deferMs: number, now: number): void {
    this.transaction(() => {
      this.db
        .prepare('UPDATE telemetry_events SET next_attempt_at = ? WHERE account_id = ? AND project_id = ? AND next_attempt_at <= ?')
        .run(now + deferMs, accountId, projectId, now)
    })
  }

  /**
   * Delete every queued event of one account partition after a confirmed
   * manual clear, grouped per project so each removed range stays
   * attributable.
   * @param accountId - Account partition.
   * @returns Per-project removed ranges for `manual_clear` gap events.
   */
  clearAccount(accountId: string): readonly (QueueGapRange & { readonly projectId: string })[] {
    return this.transaction(() => this.projects(accountId).map(projectId => ({ projectId, ...this.deletePartition(accountId, projectId) })))
  }

  /**
   * Drop queued events older than the retention window as `expired` gaps.
   * @param now - Current Unix epoch milliseconds.
   */
  expireOverdue(now: number): void {
    this.transaction(() => {
      const rows = this.db
        .prepare('SELECT event_id, account_id, project_id, session_id FROM telemetry_events WHERE created_at < ? ORDER BY rowid')
        .all(now - this.settings.retentionMs) as unknown as EventRow[]
      if (rows.length === 0) return
      this.deleteRows(rows.map(row => row.event_id))
      this.recordGap(rows, 'expired', now)
    })
  }

  /**
   * Queue totals for the collector status view; zeros after close. `gaps`
   * includes server-rejected gap events kept as a persisted loss counter.
   * @returns Non-gap event and byte totals plus the persisted gap count.
   */
  counts(): { readonly events: number; readonly bytes: number; readonly gaps: number } {
    if (this.closed) return { events: 0, bytes: 0, gaps: 0 }
    const row = this.db
      .prepare('SELECT COUNT(*) AS events, COALESCE(SUM(bytes), 0) AS bytes, COALESCE(SUM(is_gap), 0) AS gaps FROM telemetry_events')
      .get() as { events: number; bytes: number; gaps: number }
    const lost = readMeta(this.db, 'lost_gap_events')
    return { events: row.events, bytes: row.bytes, gaps: row.gaps + (lost === undefined ? 0 : Number(lost)) }
  }

  /** Close the database handle; further writes raise storage errors. */
  close(): void {
    if (this.closed) return
    this.closed = true
    this.db.close()
  }

  private enforceCapacity(now: number): void {
    for (;;) {
      // Capacity counts regular events only; gap records are bookkeeping and
      // are protected from dropping, so an overflow can never consume the
      // rows it just recorded.
      const row = this.db
        .prepare('SELECT COUNT(*) AS events, COALESCE(SUM(bytes), 0) AS bytes FROM telemetry_events WHERE is_gap = 0')
        .get() as { events: number; bytes: number }
      if (row.events <= this.settings.maxEvents && row.bytes <= this.settings.maxBytes) return
      const victims = this.db
        .prepare('SELECT event_id, account_id, project_id, session_id FROM telemetry_events WHERE is_gap = 0 ORDER BY rowid LIMIT ?')
        .all(Math.max(1, Math.ceil(this.settings.maxEvents / 10))) as unknown as EventRow[]
      if (victims.length === 0) return
      this.deleteRows(victims.map(row => row.event_id))
      this.recordGap(victims, 'overflow', now)
    }
  }

  private expireExhausted(now: number): void {
    const rows = this.db
      .prepare('SELECT event_id, account_id, project_id, session_id FROM telemetry_events WHERE attempts >= ? ORDER BY rowid')
      .all(this.settings.maxAttempts) as unknown as EventRow[]
    if (rows.length === 0) return
    this.deleteRows(rows.map(row => row.event_id))
    this.recordGap(rows, 'expired', now)
  }

  private deletePartition(accountId: string, projectId: string): QueueGapRange {
    const rows = this.db
      .prepare('SELECT event_id FROM telemetry_events WHERE account_id = ? AND project_id = ? ORDER BY rowid')
      .all(accountId, projectId) as Array<{ event_id: string }>
    if (rows.length === 0) return { count: 0, firstEventId: null, lastEventId: null }
    this.deleteRows(rows.map(row => row.event_id))
    return {
      count: rows.length,
      firstEventId: rows[0]?.event_id ?? null,
      lastEventId: rows[rows.length - 1]?.event_id ?? null,
    }
  }

  private deleteRows(eventIds: readonly string[]): void {
    const statement = this.db.prepare('DELETE FROM telemetry_events WHERE event_id = ?')
    for (const id of eventIds) statement.run(id)
  }

  /** Persist merged gap events covering removed rows, grouped per project; called inside an open transaction. */
  private recordGap(
    rows: ReadonlyArray<{ event_id: string; account_id: string; project_id: string; session_id: string | null }>,
    reason: 'overflow' | 'expired',
    now: number,
  ): void {
    const byProject = new Map<string, Array<{ event_id: string; account_id: string; session_id: string | null }>>()
    for (const row of rows) {
      const group = byProject.get(row.project_id) ?? []
      group.push(row)
      byProject.set(row.project_id, group)
    }
    for (const [projectId, group] of byProject) {
      const first = group[0]
      const last = group[group.length - 1]
      if (first === undefined || last === undefined) continue
      const sessionId = first.session_id !== null && group.every(row => row.session_id === first.session_id) ? first.session_id : null
      this.insertGap(
        first.account_id,
        projectId,
        sessionId,
        {
          reason,
          count: group.length,
          firstEventId: first.event_id,
          lastEventId: last.event_id,
        },
        now,
      )
    }
  }

  private projects(accountId: string): readonly string[] {
    return (this.db.prepare('SELECT DISTINCT project_id FROM telemetry_events WHERE account_id = ?').all(accountId) as Array<{ project_id: string }>).map(
      row => row.project_id,
    )
  }

  private transaction<T>(operation: () => T): T {
    if (this.closed) throw new TelemetryStorageError('telemetry queue is closed')
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const value = operation()
      this.db.exec('COMMIT')
      return value
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error instanceof TelemetryStorageError ? error : new TelemetryStorageError(`telemetry queue write failed: ${String(error)}`)
    }
  }
}

function readMeta(db: DatabaseSync, key: string): string | undefined {
  const row = db.prepare('SELECT value FROM telemetry_meta WHERE key = ?').get(key) as { value: string } | undefined
  return row?.value
}

function parsePayload(payload: string): TelemetryEventDto {
  const value: unknown = JSON.parse(payload)
  if (typeof value !== 'object' || value === null) throw new TelemetryStorageError('telemetry queue row payload is not an object')
  return value as TelemetryEventDto
}
