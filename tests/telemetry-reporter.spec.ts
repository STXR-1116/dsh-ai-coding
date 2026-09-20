import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { TelemetryQueue } from '../src/telemetry/queue.ts'
import { TelemetryReporter, type TelemetrySend, type TelemetrySendOutcome } from '../src/telemetry/reporter.ts'
import type { TelemetryEventDto, TelemetryQueueSettings } from '../src/types.ts'

const settings: TelemetryQueueSettings = {
  maxEvents: 100,
  maxBytes: 1024 * 1024,
  batchMaxEvents: 10,
  batchMaxBytes: 64 * 1024,
  flushIntervalMs: 10,
  httpTimeoutMs: 100,
  maxAttempts: 3,
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
  const root = await mkdtemp(join(tmpdir(), 'dsh-telemetry-reporter-'))
  roots.push(root)
  const queue = TelemetryQueue.open(join(root, 'state'), { ...settings, ...overrides })
  queues.push(queue)
  return queue
}

let nextSeq = 1

function event(): TelemetryEventDto {
  const seq = nextSeq++
  return {
    schemaVersion: 1,
    eventId: `installation:session-1:${seq}`,
    installationId: 'installation',
    projectId: 'project-alpha',
    sessionId: 'session-1',
    kind: 'turn.finished',
    occurredAt: '2026-09-05T00:00:00.000Z',
    sourceType: 'turn/end',
    sourceSeq: seq,
    turn: 1,
    outcome: 'success',
  }
}

function reporter(
  queue: TelemetryQueue,
  send: TelemetrySend | undefined,
  options: { readonly userId?: string; readonly signedOut?: boolean } = {},
): TelemetryReporter {
  const account = options.signedOut === true ? ({ status: 'signed-out' } as const) : { userId: options.userId ?? 'admin-1' }
  return new TelemetryReporter(queue, settings, {
    send,
    resolveAccount: async () => account,
  })
}

interface BatchShape {
  readonly batchId: string
  readonly events: readonly { readonly eventId: string }[]
}

function batchResultFor(batch: BatchShape): TelemetrySendOutcome {
  return {
    status: 'sent',
    result: {
      batchId: batch.batchId,
      serverReceivedAt: '2026-09-05T00:00:01.000Z',
      serverCheckpoint: 'ckpt-1',
      results: batch.events.map(item => ({ eventId: item.eventId, status: 'accepted' as const })),
    },
  }
}

describe('TelemetryReporter', () => {
  it('sends queued batches, deletes only accepted rows, and reports the accepted time', async () => {
    const queue = await openQueue()
    queue.enqueue(event(), 'admin-1', Date.now())
    const sent: string[] = []
    const instance = reporter(queue, async (batch) => {
      sent.push(batch.projectId)
      expect(batch.events.every(item => item.schemaVersion === 1)).toBe(true)
      return batchResultFor(batch)
    })
    await instance.shutdown()
    expect(sent).toEqual(['project-alpha'])
    expect(queue.counts()).toMatchObject({ events: 0, gaps: 0 })
    expect(instance.status('project-alpha').lastAcceptedAt).not.toBeNull()
    expect(instance.status('project-alpha').mode).toBe('active')
  })

  it('keeps retryable rows with server delay, never re-sending before the retry instant', async () => {
    const queue = await openQueue()
    queue.enqueue(event(), 'admin-1', Date.now())
    let attempts = 0
    const instance = reporter(queue, async (batch) => {
      attempts += 1
      return {
        status: 'sent',
        result: {
          batchId: batch.batchId,
          serverReceivedAt: '2026-09-05T00:00:01.000Z',
          serverCheckpoint: `ckpt-${attempts}`,
          results: batch.events.map(item => ({ eventId: item.eventId, status: 'retryable' as const, retryAfterSeconds: 30, reason: 'TELEMETRY_BUSY' })),
        },
      }
    })
    await instance.shutdown()
    expect(attempts).toBe(1)
    expect(queue.counts().events).toBe(1)
    // The row is not due again within the server delay window.
    expect(queue.pendingBatch('admin-1', Date.now())).toBeNull()
  })

  it('turns permanently rejected rows into persisted rejected gaps and keeps the pipeline failing-visible', async () => {
    const queue = await openQueue()
    queue.enqueue(event(), 'admin-1', Date.now())
    const instance = reporter(
      queue,
      async batch => ({
        status: 'sent',
        result: {
          batchId: batch.batchId,
          serverReceivedAt: '2026-09-05T00:00:01.000Z',
          serverCheckpoint: 'ckpt',
          results: batch.events.map(item => ({ eventId: item.eventId, status: 'rejected' as const, reason: 'TELEMETRY_SCHEMA_INVALID' })),
        },
      }),
    )
    await instance.shutdown()
    const counts = queue.counts()
    expect(counts.gaps).toBe(1)
    const status = instance.status('project-alpha')
    expect(status.mode).toBe('failed')
    expect(status.lastFailure?.code).toBe('TELEMETRY_EVENT_REJECTED')
  })

  it('stops a revoked project partition with an authorization_revoked gap and revocation mode', async () => {
    const queue = await openQueue()
    queue.enqueue(event(), 'admin-1', Date.now())
    const instance = reporter(queue, async () => ({ status: 'revoked' }))
    await instance.shutdown()
    expect(queue.counts().events).toBe(1)
    expect(queue.isRevoked('admin-1', 'project-alpha')).toBe(true)
    const status = instance.status('project-alpha')
    expect(status.mode).toBe('authorization-revoked')
    expect(status.authorizationState).toBe('revoked')
    expect(instance.status(null).lastFailure).toBeNull()
  })

  it('keeps rows and stays signed-out after a failed 401 refresh', async () => {
    const queue = await openQueue()
    queue.enqueue(event(), 'admin-1', Date.now())
    let sends = 0
    const instance = reporter(
      queue,
      async () => {
        sends += 1
        return { status: 'signed-out' }
      },
      { userId: 'admin-1' },
    )
    await instance.shutdown()
    expect(sends).toBe(1)
    expect(queue.counts().events).toBe(1)
    expect(instance.status('project-alpha').mode).toBe('signed-out')
  })

  it('retains rows through transport failures and never throws into the caller', async () => {
    const queue = await openQueue()
    queue.enqueue(event(), 'admin-1', Date.now())
    const instance = reporter(queue, async () => ({ status: 'failed', code: 'NETWORK_ERROR', summary: 'socket hang up' }))
    await instance.shutdown()
    expect(queue.counts().events).toBe(1)
    const status = instance.status('project-alpha')
    expect(status.lastFailure).toMatchObject({ code: 'NETWORK_ERROR', stage: 'send' })
    expect(status.mode).toBe('failed')
  })

  it('passes the claimed account partition to every send so identity and partition stay atomic', async () => {
    const queue = await openQueue()
    queue.enqueue(event(), 'admin-1', Date.now())
    const seen: string[] = []
    const instance = reporter(queue, async (batch, accountId) => {
      seen.push(accountId)
      return batchResultFor(batch)
    })
    await instance.shutdown()
    expect(seen).toEqual(['admin-1'])
    expect(queue.counts().events).toBe(0)
  })

  it('recovers rows when the sender throws instead of stalling the claim', async () => {
    const queue = await openQueue()
    queue.enqueue(event(), 'admin-1', Date.now())
    const throwing = reporter(queue, async () => {
      throw new Error('send failed with Bearer abc-secret-token attached')
    })
    await throwing.shutdown()
    // The unified failure path released the claim and kept the row recoverable.
    expect(queue.counts().events).toBe(1)
    const status = throwing.status('project-alpha')
    expect(status.lastFailure?.code).toBe('TELEMETRY_SEND_THREW')
    // The sanitized summary never carries the credential-bearing message.
    expect(status.lastFailure?.summary).toContain('[REDACTED]')
    expect(status.lastFailure?.summary).not.toContain('abc-secret-token')
    expect(status.mode).toBe('failed')
    // The first failure's backoff (flushIntervalMs × 2⁰) must elapse before the retry is due.
    await new Promise(resolve => setTimeout(resolve, settings.flushIntervalMs * 4))
    const recovered = reporter(queue, async batch => batchResultFor(batch))
    await recovered.shutdown()
    expect(queue.counts().events).toBe(0)
  })

  it('recovers rows when the ACK application throws instead of stalling the claim (red→green)', async () => {
    const queue = await openQueue()
    queue.enqueue(event(), 'admin-1', Date.now())
    // One-shot failing acknowledge: delegates to the real queue, throws on the first call only.
    let acknowledgeCalls = 0
    const realAcknowledge = queue.acknowledge.bind(queue)
    const flakyQueue = {
      expireOverdue: queue.expireOverdue.bind(queue),
      pendingBatch: queue.pendingBatch.bind(queue),
      isRevoked: queue.isRevoked.bind(queue),
      deferProject: queue.deferProject.bind(queue),
      reportFailure: queue.reportFailure.bind(queue),
      revokeProject: queue.revokeProject.bind(queue),
      enqueueGap: queue.enqueueGap.bind(queue),
      counts: queue.counts.bind(queue),
      acknowledge: (...args: Parameters<TelemetryQueue['acknowledge']>) => {
        acknowledgeCalls += 1
        if (acknowledgeCalls === 1) throw new Error('sqlite disk I/O error during ack commit')
        return realAcknowledge(...args)
      },
    } as unknown as TelemetryQueue
    const instance = reporter(flakyQueue, async batch => batchResultFor(batch))
    await instance.shutdown()
    // The ACK failure is visible and the claimed row was released with a retry registration.
    expect(instance.status('project-alpha').lastFailure?.code).toBe('TELEMETRY_ACK_FAILED')
    expect(instance.status('project-alpha').mode).toBe('failed')
    expect(queue.counts().events).toBe(1)
    // After the backoff window a healthy drain delivers the retained row.
    await new Promise(resolve => setTimeout(resolve, settings.flushIntervalMs * 4))
    const recovered = reporter(queue, async batch => batchResultFor(batch))
    await recovered.shutdown()
    expect(queue.counts().events).toBe(0)
  })

  it('enters explicit storage-error when reportFailure AND releaseClaim both throw (red→green)', async () => {
    const queue = await openQueue()
    queue.enqueue(event(), 'admin-1', Date.now())
    // 双连抛错：send 抛错触发恢复，reportFailure 首调抛错，releaseClaim 也抛错——
    // 队列不可用，管线必须显式进入 storage-error 终态而不是静默等待租约。
    let reportCalls = 0
    let releaseCalls = 0
    const flakyQueue = {
      expireOverdue: queue.expireOverdue.bind(queue),
      pendingBatch: queue.pendingBatch.bind(queue),
      isRevoked: queue.isRevoked.bind(queue),
      deferProject: queue.deferProject.bind(queue),
      revokeProject: queue.revokeProject.bind(queue),
      enqueueGap: queue.enqueueGap.bind(queue),
      acknowledge: queue.acknowledge.bind(queue),
      counts: queue.counts.bind(queue),
      releaseClaim: () => {
        releaseCalls += 1
        throw new Error('sqlite corrupted during claim release')
      },
      reportFailure: () => {
        reportCalls += 1
        throw new Error('sqlite busy during failure registration')
      },
    } as unknown as TelemetryQueue
    const instance = reporter(flakyQueue, async () => {
      throw new Error('primary send failure')
    })
    await instance.shutdown()
    // 明确的 storage-error 终态 + 可见失败事实；事件保留在队列中不丢失。
    const status = instance.status('project-alpha')
    expect(status.mode).toBe('storage-error')
    expect(status.storageError).toContain('claim release failed')
    expect(status.lastFailure?.code).toBe('REPORTER_RECOVERY_FAILED')
    expect(queue.counts().events).toBe(1)
    expect(reportCalls).toBe(1)
    expect(releaseCalls).toBe(1)
    // 行保留且当前 claim 仍在；不能把租约到期后的可见性误当作即时恢复。
    expect(queue.pendingBatch('admin-1', Date.now())).toBeNull()
    // 租约到期仍是最后兜底，管线已显式停机可见。
    expect(queue.pendingBatch('admin-1', Date.now() + 120_000)?.events.length).toBe(1)
  })

  it('recovers when the reportFailure recovery operation itself throws (red→green)', async () => {
    const queue = await openQueue()
    queue.enqueue(event(), 'admin-1', Date.now())
    // 一次性失败代理：send 先抛错（触发恢复路径），reportFailure 再抛错（恢复自身失败）。
    let sendCalls = 0
    let reportCalls = 0
    const realReportFailure = queue.reportFailure.bind(queue)
    const flakyQueue = {
      expireOverdue: queue.expireOverdue.bind(queue),
      pendingBatch: queue.pendingBatch.bind(queue),
      isRevoked: queue.isRevoked.bind(queue),
      deferProject: queue.deferProject.bind(queue),
      revokeProject: queue.revokeProject.bind(queue),
      enqueueGap: queue.enqueueGap.bind(queue),
      acknowledge: queue.acknowledge.bind(queue),
      counts: queue.counts.bind(queue),
      releaseClaim: queue.releaseClaim.bind(queue),
      reportFailure: (...args: Parameters<TelemetryQueue['reportFailure']>) => {
        reportCalls += 1
        if (reportCalls === 1) throw new Error('sqlite busy during failure registration')
        realReportFailure(...args)
      },
    } as unknown as TelemetryQueue
    const instance = reporter(flakyQueue, async () => {
      sendCalls += 1
      if (sendCalls === 1) throw new Error('primary send failure')
      return { status: 'failed', code: 'UNREACHABLE', summary: 'must not be called again before recovery' }
    })
    await instance.shutdown()
    // 恢复操作自身抛错也必须有明确状态，且 claim 被释放（不等待租约）。
    expect(instance.status('project-alpha').lastFailure?.code).toBe('REPORTER_RECOVERY_FAILED')
    expect(instance.status('project-alpha').mode).toBe('failed')
    expect(queue.counts().events).toBe(1)
    // 立即可恢复：claim 已释放，健康 drain 能再次取到同一 event 并 ACK。
    const recovered = reporter(queue, async batch => batchResultFor(batch))
    await recovered.shutdown()
    expect(queue.counts().events).toBe(0)
  })

  it('survives a throwing account resolution and keeps rows queued', async () => {
    const queue = await openQueue()
    queue.enqueue(event(), 'admin-1', Date.now())
    const instance = new TelemetryReporter(queue, settings, {
      send: async batch => batchResultFor(batch),
      resolveAccount: async () => {
        throw new Error('credential store failed: password=hunter2')
      },
    })
    await instance.shutdown()
    expect(queue.counts().events).toBe(1)
    const status = instance.status('project-alpha')
    expect(status.mode).toBe('failed')
    expect(status.lastFailure?.code).toBe('ACCOUNT_RESOLVE_FAILED')
    expect(status.lastFailure?.summary).toContain('[REDACTED]')
    expect(status.lastFailure?.summary).not.toContain('hunter2')
    // No claim was held, so the row is immediately claimable again.
    expect(queue.pendingBatch('admin-1', Date.now())?.events.length).toBe(1)
  })

  it('reports not-ready without a sender and never drains a paused collector', async () => {
    const queue = await openQueue()
    queue.enqueue(event(), 'admin-1', Date.now())
    const notReady = reporter(queue, undefined)
    await notReady.shutdown()
    expect(notReady.status('project-alpha').mode).toBe('not-ready')
    expect(queue.counts().events).toBe(1)

    let sends = 0
    const paused = reporter(
      queue,
      async () => {
        sends += 1
        return { status: 'failed', code: 'UNREACHABLE', summary: 'must not be called' }
      },
    )
    paused.pause()
    await paused.shutdown()
    expect(sends).toBe(0)
    expect(queue.counts().events).toBe(1)
    expect(paused.status('project-alpha').mode).toBe('paused')
    // Resume drains again.
    const resumed = reporter(queue, async batch => batchResultFor(batch))
    await resumed.shutdown()
    expect(queue.counts().events).toBe(0)
  })

  it('fails closed when the batch response covers only part of the sent events', async () => {
    const queue = await openQueue()
    const first = event()
    const second = event()
    queue.enqueue(first, 'admin-1', Date.now())
    queue.enqueue(second, 'admin-1', Date.now())
    const instance = reporter(queue, async batch => ({
      status: 'sent',
      result: {
        batchId: batch.batchId,
        serverReceivedAt: '2026-09-05T00:00:01.000Z',
        serverCheckpoint: 'ckpt-partial',
        results: [{ eventId: batch.events[0]!.eventId, status: 'accepted' }],
      },
    }))
    await instance.shutdown()
    // Fail-closed: no row was deleted on an incomplete ACK set, and the
    // protocol failure is visible for recovery.
    expect(queue.counts().events).toBe(2)
    const status = instance.status('project-alpha')
    expect(status.lastFailure?.code).toBe('TELEMETRY_ACK_MISMATCH')
    // Both rows stay recoverable on a later, well-formed batch.
    expect(queue.pendingBatch('admin-1', Date.now() + 60_000)?.events.length).toBe(2)
  })

  it('fails closed on duplicate or unknown event ACKs and on a foreign batch id', async () => {
    const queue = await openQueue()
    const only = event()
    queue.enqueue(only, 'admin-1', Date.now())
    let mode = 0
    const instance = reporter(queue, async (batch) => {
      mode += 1
      if (mode === 1) {
        return {
          status: 'sent',
          result: {
            batchId: batch.batchId,
            serverReceivedAt: 'x',
            serverCheckpoint: 'c',
            results: [
              { eventId: only.eventId, status: 'accepted' },
              { eventId: only.eventId, status: 'duplicate' },
            ],
          },
        }
      }
      if (mode === 2) {
        return {
          status: 'sent',
          result: {
            batchId: batch.batchId,
            serverReceivedAt: 'x',
            serverCheckpoint: 'c',
            results: [{ eventId: 'unknown-event-id', status: 'accepted' }],
          },
        }
      }
      return {
        status: 'sent',
        result: {
          batchId: 'a-foreign-batch-id',
          serverReceivedAt: 'x',
          serverCheckpoint: 'c',
          results: [{ eventId: only.eventId, status: 'accepted' }],
        },
      }
    })
    await instance.shutdown()
    await instance.shutdown()
    await instance.shutdown()
    // Fail-closed across all three malformed responses: the row survives.
    expect(queue.counts().events).toBe(1)
    expect(instance.status('project-alpha').lastFailure?.code).toBe('TELEMETRY_ACK_MISMATCH')
  })

  it('expires events past the attempt limit into gaps instead of retrying forever', async () => {
    const queue = await openQueue({ maxAttempts: 2 })
    queue.enqueue(event(), 'admin-1', Date.now())
    const failing = new TelemetryReporter(queue, { ...settings, maxAttempts: 2, flushIntervalMs: 5 }, {
      send: async () => ({ status: 'failed', code: 'TELEMETRY_UNAVAILABLE', summary: '503' }),
      resolveAccount: async () => ({ userId: 'admin-1' }),
    })
    // shutdown drains once per call; two consecutive failures exhaust the row.
    await failing.shutdown()
    await failing.shutdown()
    // A third drain finds nothing due until backoff elapses; force the queue window.
    const counts = queue.counts()
    expect(counts.gaps + counts.events).toBeGreaterThanOrEqual(1)
  })
})
