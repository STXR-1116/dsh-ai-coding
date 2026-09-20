import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { TelemetryQueue, TelemetryStorageError } from '../src/telemetry/queue.ts'
import type { TelemetryEventDto, TelemetryQueueSettings } from '../src/types.ts'

const settings: TelemetryQueueSettings = {
  maxEvents: 10,
  maxBytes: 64 * 1024,
  batchMaxEvents: 3,
  batchMaxBytes: 16 * 1024,
  flushIntervalMs: 10,
  httpTimeoutMs: 100,
  maxAttempts: 2,
  retentionMs: 60_000,
  claimTimeoutMs: 60_000,
}

const roots: string[] = []
const queues: TelemetryQueue[] = []

afterEach(async () => {
  for (const queue of queues.splice(0)) queue.close()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function openQueue(overrides: Partial<TelemetryQueueSettings> = {}): Promise<TelemetryQueue> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-telemetry-queue-'))
  roots.push(root)
  const queue = TelemetryQueue.open(join(root, 'state'), { ...settings, ...overrides })
  queues.push(queue)
  return queue
}

let nextSeq = 1

function event(projectId = 'project-alpha', sessionId = 'session-1'): TelemetryEventDto {
  const seq = nextSeq++
  return {
    schemaVersion: 1,
    eventId: `installation:${sessionId}:${seq}`,
    installationId: 'installation',
    projectId,
    sessionId,
    kind: 'turn.finished',
    occurredAt: '2026-09-05T00:00:00.000Z',
    sourceType: 'turn/end',
    sourceSeq: seq,
    turn: 1,
    outcome: 'success',
  }
}

describe('TelemetryQueue', () => {
  it('persists events transactionally, dedupes by event id, and keeps a stable installation id', async () => {
    const queue = await openQueue()
    const installationId = queue.installationId
    expect(installationId.length).toBeGreaterThan(0)
    const item = event()
    expect(queue.enqueue(item, 'admin-1', 1)).toBe(true)
    // Replaying the same logical event (same id) after restart must not duplicate.
    expect(queue.enqueue(item, 'admin-1', 2)).toBe(false)
    const batch = queue.pendingBatch('admin-1', 3)
    expect(batch).not.toBeNull()
    expect(batch?.events).toHaveLength(1)
    // A fresh queue over the same state directory keeps the installation identity
    // so restarts cannot mint second logical identities for the same events.
    const root = roots[roots.length - 1]
    const reopened = TelemetryQueue.open(join(root!, 'state'), settings)
    queues.push(reopened)
    expect(reopened.installationId).toBe(installationId)
  })

  it('selects single-project batches within event and byte limits and confirms with checkpoint atomically', async () => {
    const queue = await openQueue()
    for (let index = 0; index < 5; index++) queue.enqueue(event(), 'admin-1', index)
    queue.enqueue(event('project-beta'), 'admin-1', 100)
    const batch = queue.pendingBatch('admin-1', 1000)
    expect(batch?.projectId).toBe('project-alpha')
    expect(batch?.events.length).toBe(3)
    // A second batch immediately after must not re-hand the marked rows.
    const second = queue.pendingBatch('admin-1', 1000)
    expect(second?.events.map(item => item.eventId)).not.toContain(batch?.events[0]?.eventId)
    const range = queue.acknowledge(
      batch!.batchId,
      batch!.events.map(item => ({ eventId: item.eventId, status: 'accepted' as const })),
      'checkpoint-1',
    )
    expect(range).toBeNull()
    expect(queue.counts().events).toBe(3)
    // Retryable rows stay queued and are deferred by the reporter-provided instant.
    queue.acknowledge(
      second!.batchId,
      second!.events.map(item => ({ eventId: item.eventId, status: 'retryable' as const, nextAttemptAt: 5000, reason: 'TELEMETRY_BUSY' })),
      'checkpoint-2',
    )
    // Another project's due rows are not blocked by the deferred partition.
    const betaBatch = queue.pendingBatch('admin-1', 4000)
    expect(betaBatch?.projectId).toBe('project-beta')
    // In-flight rows stay out of new batches; deferred rows are not due inside the window.
    expect(queue.pendingBatch('admin-1', 4000)).toBeNull()
    queue.acknowledge(
      batch!.batchId,
      batch!.events.map(item => ({ eventId: item.eventId, status: 'accepted' as const })),
      'checkpoint-1b',
    )
    expect(queue.pendingBatch('admin-1', 4000)).toBeNull()
    // Deferred rows become due again after their retry instant.
    const afterRetry = queue.pendingBatch('admin-1', 5000)
    expect(afterRetry?.projectId).toBe('project-alpha')
    expect(afterRetry?.events.length).toBe(2)
    expect(queue.counts().events).toBe(3)
  })

  it('returns rejected rows as a gap range and drops them from the queue', async () => {
    const queue = await openQueue()
    queue.enqueue(event(), 'admin-1', 1)
    const batch = queue.pendingBatch('admin-1', 10)!
    const rejected = queue.acknowledge(
      batch.batchId,
      batch.events.map(item => ({ eventId: item.eventId, status: 'rejected' as const, reason: 'TELEMETRY_SCHEMA_INVALID' })),
      'ckpt',
    )
    expect(rejected).toMatchObject({ count: 1, firstEventId: batch.events[0]?.eventId })
    expect(queue.counts().events).toBe(0)
  })

  it('enforces capacity by dropping the oldest events into persisted overflow gaps', async () => {
    const queue = await openQueue({ maxEvents: 5 })
    let firstEventId = ''
    let lastEventId = ''
    for (let index = 0; index < 8; index++) {
      const item = event()
      if (firstEventId === '') firstEventId = item.eventId
      lastEventId = item.eventId
      queue.enqueue(item, 'admin-1', index)
    }
    const counts = queue.counts()
    expect(counts.events - counts.gaps).toBe(5)
    expect(counts.gaps).toBeGreaterThanOrEqual(1)
    // The oldest events were dropped first; draining every batch still
    // delivers the newest event (gap rows are deliverable bookkeeping too).
    const delivered: string[] = []
    for (;;) {
      const page = queue.pendingBatch('admin-1', 10_000)
      if (page === null) break
      delivered.push(...page.events.map(item => item.eventId))
      queue.acknowledge(
        page.batchId,
        page.events.map(item => ({ eventId: item.eventId, status: 'accepted' as const })),
        'ckpt',
      )
    }
    expect(delivered).not.toContain(firstEventId)
    expect(delivered).toContain(lastEventId)
  })

  it('expires attempts-exhausted rows into gaps and retention-overdue rows into gaps', async () => {
    const queue = await openQueue()
    queue.enqueue(event(), 'admin-1', 1)
    const batch = queue.pendingBatch('admin-1', 10)!
    queue.reportFailure(batch.batchId, 'NETWORK_ERROR', 'down', 20, 10)
    // attempts=1 < maxAttempts=2: still queued, deferred.
    expect(queue.counts().events).toBe(1)
    const second = queue.pendingBatch('admin-1', 30)!
    queue.reportFailure(second.batchId, 'NETWORK_ERROR', 'down', 40, 30)
    expect(queue.counts()).toMatchObject({ events: 1, gaps: 1 })
    const retention = await openQueue({ retentionMs: 100 })
    retention.enqueue(event(), 'admin-1', 1_000)
    retention.expireOverdue(5_000)
    expect(retention.counts()).toMatchObject({ events: 1, gaps: 1 })
  })

  it('revokes a project partition, refuses future batches for it, and clears per account', async () => {
    const queue = await openQueue()
    queue.enqueue(event('project-alpha'), 'admin-1', 1)
    queue.enqueue(event('project-beta'), 'admin-1', 2)
    const removed = queue.revokeProject('admin-1', 'project-alpha')
    expect(removed).toMatchObject({ count: 1 })
    expect(queue.isRevoked('admin-1', 'project-alpha')).toBe(true)
    expect(queue.isRevoked('admin-1', 'project-beta')).toBe(false)
    // Another account's partition is unaffected by revocation or clearing.
    queue.enqueue(event('project-alpha'), 'manager-1', 3)
    const cleared = queue.clearAccount('admin-1')
    expect(cleared.map(entry => entry.projectId).sort()).toEqual(['project-beta'])
    expect(queue.counts().events).toBe(1)
  })

  it('releases only expired claims: a second live handle cannot re-send an unexpired claim', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-telemetry-claim-'))
    roots.push(root)
    let now = 1_000
    const clock = (): number => now
    const first = TelemetryQueue.open(join(root, 'state'), { ...settings, claimTimeoutMs: 30_000 }, { now: clock })
    const claimed = event()
    first.enqueue(claimed, 'admin-1', now)
    const batch = first.pendingBatch('admin-1', now)
    expect(batch?.events.map(item => item.eventId)).toEqual([claimed.eventId])

    // A second live handle on the same database must not release or re-send
    // the first sender's unexpired claim.
    const second = TelemetryQueue.open(join(root, 'state'), { ...settings, claimTimeoutMs: 30_000 }, { now: clock })
    queues.push(second)
    expect(second.pendingBatch('admin-1', now)).toBeNull()
    now += 10_000
    expect(second.pendingBatch('admin-1', now)).toBeNull()

    // After the claim lease expires, recovery reuses the same identity and
    // bookkeeping: event id, account, project, attempts, checkpoint semantics.
    now += 30_000
    const recovered = second.pendingBatch('admin-1', now)
    expect(recovered?.events.map(item => item.eventId)).toEqual([claimed.eventId])
    expect(recovered?.events[0]?.attempts).toBe(0)
    second.acknowledge(
      recovered!.batchId,
      recovered!.events.map(item => ({ eventId: item.eventId, status: 'accepted' as const })),
      'ckpt-recovered',
    )
    expect(second.counts()).toMatchObject({ events: 0, gaps: 0 })
    // The first handle sees the same acknowledged state (shared database).
    expect(first.counts()).toMatchObject({ events: 0, gaps: 0 })
    first.close()
  })

  it('releases batch claims left by a crashed process once the lease expires after reopen', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-telemetry-claim-'))
    roots.push(root)
    let now = 1_000
    const clock = (): number => now
    const first = TelemetryQueue.open(join(root, 'state'), { ...settings, claimTimeoutMs: 30_000 }, { now: clock })
    const claimed = event()
    first.enqueue(claimed, 'admin-1', now)
    expect(first.pendingBatch('admin-1', now)).not.toBeNull()
    first.close()

    const reopened = TelemetryQueue.open(join(root, 'state'), { ...settings, claimTimeoutMs: 30_000 }, { now: clock })
    queues.push(reopened)
    // Still within the lease: the claim survives even though the owner closed.
    now += 10_000
    expect(reopened.pendingBatch('admin-1', now)).toBeNull()
    // Lease expired: the crashed process's claim is recovered verbatim.
    now += 30_000
    const recovered = reopened.pendingBatch('admin-1', now)
    expect(recovered?.events.map(item => item.eventId)).toEqual([claimed.eventId])
    expect(recovered?.events[0]?.attempts).toBe(0)
    reopened.acknowledge(
      recovered!.batchId,
      recovered!.events.map(item => ({ eventId: item.eventId, status: 'accepted' as const })),
      'ckpt-recovered',
    )
    expect(reopened.counts()).toMatchObject({ events: 0, gaps: 0 })
  })

  it('stops with a storage error on an unknown schema version instead of migrating', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-telemetry-queue-'))
    roots.push(root)
    const first = TelemetryQueue.open(join(root, 'state'), settings)
    first.close()
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(join(root, 'state', 'telemetry', 'telemetry.db'))
    db.prepare("UPDATE telemetry_meta SET value = '999' WHERE key = 'schema_version'").run()
    db.close()
    expect(() => TelemetryQueue.open(join(root, 'state'), settings)).toThrow(TelemetryStorageError)
    // The rejected database file stays on disk untouched (no rebuild, no migration).
    await expect(stat(join(root, 'state', 'telemetry', 'telemetry.db'))).resolves.toBeTruthy()
  })
})
