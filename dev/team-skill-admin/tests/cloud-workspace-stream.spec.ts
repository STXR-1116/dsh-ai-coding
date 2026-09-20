/**
 * R2-09: the admin surface holds a real event subscription.
 *
 * The back office reads the REST list first and then subscribes through the
 * same-origin authorized proxy, so Workspace and Run state advance without a
 * manual reload. These tests drive the reader against the real local fixture
 * service: the first snapshot, duplicate and out-of-order replays, a dropped
 * connection resuming from its own watermark, a `resync_required` that re-reads
 * the snapshot and stays out of `live` when the snapshot cannot be read, a
 * rejected session, and release on unmount.
 */
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { createTeamSkillService } from '../../../apps/team-skill-service/src/server.ts'
import { CloudWorkspaceStream, type CloudStreamStatus, type CloudStreamEvent } from '../src/lib/cloud-workspace-stream.ts'

const services: ReturnType<typeof createTeamSkillService>[] = []

afterEach(async () => {
  for (const service of services.splice(0)) {
    service.server.closeAllConnections()
    await new Promise<void>((resolve) => {
      service.server.close(() => {
        resolve()
      })
    })
  }
})

/** Boots the local deterministic service the admin proxy would forward to. */
async function boot(): Promise<{ readonly baseUrl: string; readonly port: number }> {
  const service = createTeamSkillService({ port: 0 })
  services.push(service)
  await service.listen()
  const port = (service.server.address() as AddressInfo).port
  return { baseUrl: `http://127.0.0.1:${port}`, port }
}

/** The fixture's administrator bearer token, as every other admin test uses. */
const adminAuthorization = 'Bearer admin-demo'

interface Harness {
  readonly statuses: CloudStreamStatus[]
  readonly events: CloudStreamEvent[]
  readonly stream: CloudWorkspaceStream
  readonly resyncs: { count: number; reject: boolean }
}

/** Opens one reader against a URL, recording everything it reports. */
function reader(
  url: string,
  overrides: { readonly fetch?: typeof globalThis.fetch; readonly rejectResync?: boolean } = {},
): Harness {
  const statuses: CloudStreamStatus[] = []
  const events: CloudStreamEvent[] = []
  const resyncs = { count: 0, reject: overrides.rejectResync === true }
  const stream = new CloudWorkspaceStream({
    url,
    callbacks: {
      onStatus: (status) => { statuses.push(status) },
      onEvent: (event) => { events.push(event) },
      onResync: async () => {
        resyncs.count += 1
        if (resyncs.reject) throw new Error('snapshot unavailable')
      },
    },
    reconnectDelayMs: () => 20,
    fetch: overrides.fetch ?? ((input, init) => globalThis.fetch(input, {
      ...init,
      headers: { ...init?.headers as Record<string, string>, authorization: adminAuthorization },
    })),
  })
  return { statuses, events, stream, resyncs }
}

/** Waits for a condition the real service is expected to reach. */
async function until(predicate: () => boolean, label: string, budget = 8000): Promise<void> {
  const deadline = Date.now() + budget
  while (!predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10))
  expect(predicate(), `timed out waiting for ${label}`).toBe(true)
}

/** Issues one lifecycle write so the stream has something live to deliver. */
async function stopWorkspace(baseUrl: string, workspaceId: string, revision: number): Promise<void> {
  const response = await fetch(`${baseUrl}/v1/admin/workspaces/${workspaceId}:stop`, {
    method: 'POST',
    headers: {
      authorization: adminAuthorization,
      'content-type': 'application/json',
      'idempotency-key': `stream-${workspaceId}-${String(revision)}`,
      'if-match': String(revision),
    },
    body: JSON.stringify({ expected_workspace_revision: revision }),
  })
  expect(response.status).toBe(200)
}

describe('R2-09 the admin event subscription', () => {
  it('takes the first snapshot then reports live without a manual reload', async () => {
    const { baseUrl } = await boot()
    const harness = reader(`${baseUrl}/v1/admin/events/stream`)
    harness.stream.start()
    await until(() => harness.statuses.includes('live'), 'the stream to go live')
    expect(harness.events.length).toBeGreaterThan(0)
    expect(harness.stream.watermark).not.toBe('')

    const before = harness.events.length
    await stopWorkspace(baseUrl, 'ws-alpha-1', 7)
    await until(() => harness.events.length > before, 'a live event after the write')
    expect(harness.events.at(-1)?.resourceId).toBe('ws-alpha-1')
    harness.stream.stop()
    expect(harness.statuses.at(-1)).toBe('stopped')
  })

  it('resumes from its own watermark without re-delivering applied frames', async () => {
    const { baseUrl } = await boot()
    const first = reader(`${baseUrl}/v1/admin/events/stream`)
    first.stream.start()
    await until(() => first.events.length > 0, 'the first replay')
    await until(() => first.statuses.includes('live'), 'the first stream to go live')
    await stopWorkspace(baseUrl, 'ws-alpha-1', 7)
    await until(() => first.events.some(event => event.resourceId === 'ws-alpha-1'), 'the stop event')
    const watermark = first.stream.watermark
    first.stream.stop()

    // A reader resuming from that watermark receives only what came after it.
    const resumed = reader(`${baseUrl}/v1/admin/events/stream`, {})
    resumed.stream.start(watermark)
    await until(() => resumed.statuses.includes('live'), 'the resumed stream to go live')
    const alreadyApplied = new Set(first.events.map(event => event.eventId))
    for (const event of resumed.events) expect(alreadyApplied.has(event.eventId)).toBe(false)
    resumed.stream.stop()
  })

  it('reconnects from its own watermark after the connection drops', async () => {
    const { baseUrl } = await boot()
    let connections = 0
    const urls: string[] = []
    const dropFirst: typeof globalThis.fetch = async (input, init) => {
      connections += 1
      urls.push(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
      const response = await globalThis.fetch(input, {
        ...init,
        headers: { ...init?.headers as Record<string, string>, authorization: adminAuthorization },
      })
      if (connections > 1) return response
      // Model a server that ends the first connection after delivering its
      // replay: the connection the fixture keeps open is cut short here.
      const upstream = response.body
      const cut = new ReadableStream<Uint8Array>({
        async start(controller) {
          const upstreamReader = upstream?.getReader()
          if (upstreamReader === undefined) {
            controller.close()
            return
          }
          for (;;) {
            const { done, value } = await upstreamReader.read()
            if (done) break
            controller.enqueue(value)
            if (new TextDecoder().decode(value).includes('stream.replay-done')) break
          }
          controller.close()
          await upstreamReader.cancel().catch(() => undefined)
        },
      })
      return new Response(cut, { status: response.status, headers: response.headers })
    }
    const harness = reader(`${baseUrl}/v1/admin/events/stream`, { fetch: dropFirst })
    harness.stream.start()
    await until(() => harness.statuses.includes('reconnecting'), 'a reconnect')
    await until(() => connections >= 2, 'the resumed connection')
    expect(urls[0]).toContain('after=')
    expect(urls[1]).toContain(`after=${encodeURIComponent(harness.stream.watermark)}`)
    harness.stream.stop()
  })

  it('re-reads the snapshot on resync and stays out of live when that read fails', async () => {
    const { baseUrl } = await boot()
    const harness = reader(`${baseUrl}/v1/admin/events/stream`, { rejectResync: true })
    harness.stream.start()
    await until(() => harness.statuses.includes('live'), 'the stream to go live')
    // A watermark the service does not retain makes it ask for a resync.
    harness.stream.start('evt-not-retained')
    await until(() => harness.resyncs.count > 0, 'a resync request')
    await until(() => harness.statuses.at(-1) === 'resync', 'the resync state to hold')
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(harness.statuses.at(-1)).toBe('resync')
    harness.stream.stop()

    const succeeding = reader(`${baseUrl}/v1/admin/events/stream`)
    succeeding.stream.start()
    await until(() => succeeding.statuses.includes('live'), 'the healthy stream')
    succeeding.stream.start('evt-not-retained')
    await until(() => succeeding.resyncs.count > 0, 'a successful resync')
    await until(() => succeeding.statuses.at(-1) === 'live', 'the stream to return to live')
    succeeding.stream.stop()
  })

  it('reports a rejected session instead of reconnecting forever', async () => {
    const { baseUrl } = await boot()
    const refused = await fetch(`${baseUrl}/v1/admin/events/stream`, { headers: { authorization: 'Bearer nope' } })
    expect([401, 403]).toContain(refused.status)
    const denied = reader(`${baseUrl}/v1/admin/events/stream`, {
      fetch: async () => new Response(null, { status: 401 }),
    })
    denied.stream.start()
    await until(() => denied.statuses.includes('denied'), 'the denied state')
    await new Promise(resolve => setTimeout(resolve, 80))
    expect(denied.statuses.at(-1)).toBe('denied')
    denied.stream.stop()
  })

  it('releases the connection and forgets its cursor on stop', async () => {
    const { baseUrl } = await boot()
    let open = 0
    // Pass-through that owns the only reader for the body it serves: reading the
    // body here and then handing the same body on would lock it.
    const counting: typeof globalThis.fetch = async (input, init) => {
      open += 1
      const response = await globalThis.fetch(input, {
        ...init,
        headers: { ...init?.headers as Record<string, string>, authorization: adminAuthorization },
      })
      const upstream = response.body
      if (upstream === null) {
        open -= 1
        return response
      }
      const body = new ReadableStream<Uint8Array>({
        async start(controller) {
          const reader = upstream.getReader()
          try {
            for (;;) {
              const { done, value } = await reader.read()
              if (done) break
              controller.enqueue(value)
            }
            controller.close()
          } catch (error) {
            controller.error(error)
          } finally {
            open -= 1
          }
        },
        cancel(reason) {
          return upstream.cancel(reason)
        },
      })
      return new Response(body, { status: response.status, headers: response.headers })
    }
    const harness = reader(`${baseUrl}/v1/admin/events/stream`, { fetch: counting })
    harness.stream.start()
    await until(() => harness.statuses.includes('live'), 'the stream to go live')
    await until(() => open === 1, 'exactly one open connection')
    harness.stream.stop()
    await until(() => open === 0, 'the connection to close on stop')
    expect(harness.stream.watermark).toBe('')
    expect(harness.stream.status).toBe('stopped')
    const delivered = harness.events.length
    await new Promise(resolve => setTimeout(resolve, 80))
    expect(harness.events.length).toBe(delivered)
  })
})

/**
 * R3-01: the event contract is enforced, not approximated.
 *
 * The service event contract names seven fields and a closed resource-type
 * union. A frame that is missing a field, carries the wrong type, or names a
 * resource type outside the union is wire drift: the reader must reject the
 * frame as a whole (no callback event, cursor unchanged, `stale` carrying the
 * reason) instead of substituting a sentinel and reporting live.
 */
describe('R3-01 the admin consumer enforces the service event contract', () => {
  /** One contract-complete event, exactly as the service writes it. */
  const validEvent: Record<string, unknown> = {
    event_id: 'evt-1',
    resource_type: 'workspace',
    resource_id: 'ws-1',
    revision: 1,
    event_type: 'workspace.updated',
    occurred_at: '2026-09-11T00:00:00Z',
    payload: {},
  }

  /** Copies an event without one field, so "missing" is exact. */
  function without(record: Record<string, unknown>, key: string): Record<string, unknown> {
    return Object.fromEntries(Object.entries(record).filter(([name]) => name !== key))
  }

  /** One SSE frame in the service's own framing. */
  function frame(event: string, id: string, data: string): string {
    return `event: ${event}\nid: ${id}\ndata: ${data}\n\n`
  }

  /** One SSE frame carrying `data` for an event. */
  function dataFrame(data: unknown, id = 'evt-1'): string {
    return frame('workspace.updated', id, JSON.stringify(data))
  }

  /** Serves the given chunks verbatim, in order, then ends the connection. */
  function served(chunks: readonly string[]): Harness {
    const encoder = new TextEncoder()
    let connections = 0
    return reader('http://served.invalid/admin/events/stream', {
      fetch: async () => {
        connections += 1
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
            controller.close()
          },
        }), { status: 200, headers: { 'content-type': 'text/event-stream' } })
      },
    })
  }

  /** Runs one malformed frame to a settled state. */
  async function observe(frameText: string): Promise<Harness> {
    const harness = served([frameText])
    harness.stream.start()
    await until(() => harness.stream.violation !== undefined, 'the frame to be rejected')
    return harness
  }

  /** Every field the contract requires, in both failure directions. */
  const missingCases: readonly (readonly [string, Record<string, unknown>])[] = [
    ['event_id', without(validEvent, 'event_id')],
    ['resource_type', without(validEvent, 'resource_type')],
    ['resource_id', without(validEvent, 'resource_id')],
    ['revision', without(validEvent, 'revision')],
    ['event_type', without(validEvent, 'event_type')],
    ['occurred_at', without(validEvent, 'occurred_at')],
    ['payload', without(validEvent, 'payload')],
  ]

  const mistypedCases: readonly (readonly [string, Record<string, unknown>])[] = [
    ['event_id', { ...validEvent, event_id: 7 }],
    ['event_id empty', { ...validEvent, event_id: '' }],
    ['resource_type', { ...validEvent, resource_type: 7 }],
    ['resource_id', { ...validEvent, resource_id: 7 }],
    ['resource_id null', { ...validEvent, resource_id: null }],
    ['resource_id empty', { ...validEvent, resource_id: '' }],
    ['revision string', { ...validEvent, revision: 'bad' }],
    ['revision boolean', { ...validEvent, revision: true }],
    ['revision null', { ...validEvent, revision: null }],
    ['revision negative', { ...validEvent, revision: -1 }],
    ['revision fractional', { ...validEvent, revision: 1.5 }],
    ['event_type', { ...validEvent, event_type: 7 }],
    ['event_type empty', { ...validEvent, event_type: '' }],
    ['occurred_at', { ...validEvent, occurred_at: 7 }],
    ['occurred_at empty', { ...validEvent, occurred_at: '' }],
    ['payload array', { ...validEvent, payload: [] }],
    ['payload string', { ...validEvent, payload: 'text' }],
    ['payload null', { ...validEvent, payload: null }],
    ['payload number', { ...validEvent, payload: 3 }],
    ['resource_type unknown member', { ...validEvent, resource_type: 'unknown' }],
    ['resource_type off-contract', { ...validEvent, resource_type: 'widget' }],
  ]

  it.each(missingCases)('rejects an event missing %s', async (field, data) => {
    const harness = await observe(dataFrame(data))
    try {
      // No callback, no live claim, cursor untouched, and the reason names the field.
      expect(harness.events).toEqual([])
      expect(harness.statuses).toContain('stale')
      expect(harness.statuses).not.toContain('live')
      expect(harness.stream.watermark).toBe('')
      expect(harness.stream.violation?.code).toBe('SERVICE_PROTOCOL_ERROR')
      expect(harness.stream.violation?.message).toContain(field)
    } finally {
      harness.stream.stop()
    }
  })

  it.each(mistypedCases)('rejects an event with %s', async (_label, data) => {
    const harness = await observe(dataFrame(data))
    try {
      expect(harness.events).toEqual([])
      expect(harness.statuses).toContain('stale')
      expect(harness.statuses).not.toContain('live')
      expect(harness.stream.watermark).toBe('')
      expect(harness.stream.violation?.code).toBe('SERVICE_PROTOCOL_ERROR')
    } finally {
      harness.stream.stop()
    }
  })

  it('rejects a frame with no SSE id instead of borrowing the payload id', async () => {
    // The data carries a perfectly good event_id; the frame still cannot be
    // replayed from an unknown position, so the contract requires the SSE id.
    const harness = await observe(frame('workspace.updated', '', JSON.stringify(validEvent)).replace('id: \n', ''))
    try {
      expect(harness.events).toEqual([])
      expect(harness.statuses).toContain('stale')
      expect(harness.stream.violation?.message).toContain('SSE id')
    } finally {
      harness.stream.stop()
    }
  })

  it('rejects a frame that carries an SSE id but no data payload', async () => {
    const harness = await observe('event: workspace.updated\nid: evt-1\n\n')
    try {
      expect(harness.events).toEqual([])
      expect(harness.statuses).toContain('stale')
      expect(harness.stream.violation?.message).toContain('no data payload')
    } finally {
      harness.stream.stop()
    }
  })

  it('rejects malformed JSON instead of swallowing the frame', async () => {
    const harness = await observe('event: workspace.updated\nid: evt-1\ndata: {"event_id":\n\n')
    try {
      expect(harness.events).toEqual([])
      expect(harness.statuses).toContain('stale')
      expect(harness.stream.violation?.message).toContain('not valid JSON')
    } finally {
      harness.stream.stop()
    }
  })

  it('rejects a non-object JSON payload', async () => {
    const harness = await observe(frame('workspace.updated', 'evt-1', '[1,2,3]'))
    try {
      expect(harness.events).toEqual([])
      expect(harness.stream.violation?.message).toContain('must be a JSON object')
    } finally {
      harness.stream.stop()
    }
  })

  it('accepts a legal empty payload and a legal revision of zero', async () => {
    // The contract distinguishes "field absent" from "field present and empty";
    // the reader must keep that distinction instead of rejecting both.
    const harness = served([dataFrame({ ...validEvent, payload: {}, revision: 0 })])
    harness.stream.start()
    try {
      await until(() => harness.events.length === 1, 'the legal event to be applied')
      expect(harness.events[0]).toMatchObject({ revision: 0, payload: {} })
      expect(harness.events[0]?.resourceType).toBe('workspace')
      expect(harness.statuses).toContain('live')
      expect(harness.stream.violation).toBeUndefined()
      expect(harness.stream.watermark).toBe('evt-1')
    } finally {
      harness.stream.stop()
    }
  })

  it('accepts a payload carrying legal empty collections and nulls', async () => {
    // A service reporting "nothing changed" sends an empty list; that is data,
    // not a missing field, and must survive the strict parse.
    const payload = { files: [], changed: [], nested: { items: [] }, note: null }
    const harness = served([dataFrame({ ...validEvent, payload })])
    harness.stream.start()
    try {
      await until(() => harness.events.length === 1, 'the event with empty collections')
      expect(harness.events[0]?.payload).toEqual(payload)
      expect(harness.stream.violation).toBeUndefined()
      expect(harness.statuses).not.toContain('stale')
    } finally {
      harness.stream.stop()
    }
  })

  it('accepts CRLF framing and a frame split across chunks', async () => {
    const crlf = dataFrame(validEvent).replaceAll('\n', '\r\n')
    const split = dataFrame({ ...validEvent, event_id: 'evt-2', revision: 2 })
    const half = Math.floor(split.length / 2)
    const harness = served([crlf, split.slice(0, half), split.slice(half)])
    harness.stream.start()
    try {
      await until(() => harness.events.length === 2, 'both framed events to be applied')
      expect(harness.events.map(event => event.eventId)).toEqual(['evt-1', 'evt-2'])
      expect(harness.statuses).not.toContain('stale')
    } finally {
      harness.stream.stop()
    }
  })

  it('ignores a comment heartbeat frame', async () => {
    const harness = served([': ping\n\n', dataFrame(validEvent)])
    harness.stream.start()
    try {
      await until(() => harness.events.length === 1, 'the event after the heartbeat')
      expect(harness.events).toHaveLength(1)
      expect(harness.stream.violation).toBeUndefined()
    } finally {
      harness.stream.stop()
    }
  })

  it('keeps the cursor at the last good event and never claims live again', async () => {
    // A good event establishes the cursor; the malformed frame that follows must
    // not move it, and no later connection may report live until valid data
    // arrives — the failure would otherwise be invisible to the operator.
    const harness = served([dataFrame({ ...validEvent, event_id: 'evt-good' }), dataFrame(without(validEvent, 'revision'))])
    harness.stream.start()
    try {
      await until(() => harness.stream.violation !== undefined, 'the malformed frame to be rejected')
      expect(harness.events.map(event => event.eventId)).toEqual(['evt-good'])
      expect(harness.stream.watermark).toBe('evt-good')
      const staleAt = harness.statuses.indexOf('stale')
      expect(staleAt).toBeGreaterThanOrEqual(0)
      expect(harness.statuses.slice(staleAt)).not.toContain('live')
      // A protocol violation is recovered by replaying from the same cursor, so
      // it does not itself demand a snapshot resync.
      expect(harness.resyncs.count).toBe(0)
    } finally {
      harness.stream.stop()
    }
  })

  it('recovers to live when a valid event arrives after a violation', async () => {
    const encoder = new TextEncoder()
    let connections = 0
    const harness = reader('http://served.invalid/admin/events/stream', {
      fetch: async () => {
        connections += 1
        const body = connections === 1
          ? dataFrame(without(validEvent, 'payload'))
          : dataFrame({ ...validEvent, event_id: 'evt-recovered', revision: 2 })
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode(body))
            controller.close()
          },
        }), { status: 200, headers: { 'content-type': 'text/event-stream' } })
      },
    })
    harness.stream.start()
    try {
      await until(() => harness.events.length === 1, 'the recovery event to be applied')
      expect(harness.events[0]?.eventId).toBe('evt-recovered')
      expect(harness.statuses).toContain('stale')
      expect(harness.statuses.at(-1)).toBe('live')
      expect(harness.stream.violation).toBeUndefined()
    } finally {
      harness.stream.stop()
    }
  })

  it('drops duplicates and stale replays without reporting a protocol failure', async () => {
    // The contract says repeated events may be dropped and an older revision
    // must not overwrite newer state; that is normal traffic, not drift.
    const harness = served([
      dataFrame({ ...validEvent, event_id: 'evt-1', revision: 5 }),
      dataFrame({ ...validEvent, event_id: 'evt-1', revision: 5 }),
      dataFrame({ ...validEvent, event_id: 'evt-0', revision: 4 }),
      dataFrame({ ...validEvent, event_id: 'evt-2', revision: 6 }),
    ])
    harness.stream.start()
    try {
      await until(() => harness.events.length === 2, 'the two advancing events')
      expect(harness.events.map(event => event.eventId)).toEqual(['evt-1', 'evt-2'])
      expect(harness.statuses).not.toContain('stale')
      expect(harness.stream.watermark).toBe('evt-2')
    } finally {
      harness.stream.stop()
    }
  })

  it('keeps a failed resync snapshot out of live', async () => {
    const harness = reader('http://served.invalid/admin/events/stream', {
      rejectResync: true,
      fetch: async () => {
        const body = 'event: resync_required\nid: evt-resync\ndata: {"code":"RESYNC_REQUIRED"}\n\n'
        return new Response(new TextEncoder().encode(body), {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        })
      },
    })
    harness.stream.start()
    try {
      await until(() => harness.resyncs.count > 0, 'the resync request')
      await until(() => harness.statuses.at(-1) === 'resync', 'the resync state to hold')
      expect(harness.statuses.at(-1)).not.toBe('live')
      expect(harness.stream.watermark).toBe('')
    } finally {
      harness.stream.stop()
    }
  })

  it('accepts the real fixture stream under the strict contract', async () => {
    // The strict parser must not reject the service's own output: a real frame
    // from the deterministic fixture has to pass every contract check.
    const { baseUrl } = await boot()
    const harness = reader(`${baseUrl}/v1/admin/events/stream`)
    harness.stream.start()
    try {
      await until(() => harness.statuses.includes('live'), 'the fixture stream to go live')
      expect(harness.events.length).toBeGreaterThan(0)
      expect(harness.statuses).not.toContain('stale')
      expect(harness.stream.violation).toBeUndefined()
      for (const event of harness.events) {
        expect(event.eventId).not.toBe('')
        expect(event.resourceId).not.toBe('')
        expect(event.eventType).not.toBe('')
        expect(event.occurredAt).not.toBe('')
        expect(Number.isInteger(event.revision)).toBe(true)
        expect(event.revision).toBeGreaterThanOrEqual(0)
        expect(['workspace', 'run', 'file', 'changes', 'agent_profile']).toContain(event.resourceType)
      }
    } finally {
      harness.stream.stop()
    }
  })
})

/**
 * R4-01: revision ordering is subscription state, not connection state.
 *
 * `event_id` is the replay cursor and an exact-duplicate guard; it is not an
 * ordering key. A service may replay an older revision under a new event id on
 * the next connection (replay window, proxy reconnect, a restart re-delivering),
 * and that older revision must not reach the page.
 */
describe('R4-01 revision ordering survives a reconnect', () => {
  /** One event for `resourceId` at `revision`. */
  function eventFrame(eventId: string, resourceId: string, revision: number, resourceType = 'workspace'): string {
    const payload = {
      event_id: eventId,
      resource_type: resourceType,
      resource_id: resourceId,
      revision,
      event_type: `${resourceType}.updated`,
      occurred_at: '2026-09-12T00:00:00Z',
      payload: { revision },
    }
    return `event: ${resourceType}.updated\nid: ${eventId}\ndata: ${JSON.stringify(payload)}\n\n`
  }

  /**
   * Serves one scripted body per connection and records every request URL, so a
   * test can assert what each reconnect asked to replay from.
   */
  function scriptedReader(
    bodies: readonly string[],
    overrides: { readonly rejectResync?: boolean } = {},
  ): Harness & { readonly urls: string[]; readonly connections: () => number } {
    const encoder = new TextEncoder()
    const urls: string[] = []
    let connections = 0
    const harness = reader('http://served.invalid/admin/events/stream', {
      ...(overrides.rejectResync === undefined ? {} : { rejectResync: overrides.rejectResync }),
      fetch: async (input) => {
        urls.push(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
        const body = bodies[Math.min(connections, bodies.length - 1)] ?? ''
        connections += 1
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode(body))
            controller.close()
          },
        }), { status: 200, headers: { 'content-type': 'text/event-stream' } })
      },
    })
    return { ...harness, urls, connections: () => connections }
  }

  it('drops an older revision delivered under a new event id after a reconnect', async () => {
    const harness = scriptedReader([eventFrame('evt-2', 'ws-x', 2), eventFrame('evt-1', 'ws-x', 1)])
    harness.stream.start()
    try {
      await until(() => harness.events.length >= 1, 'the first connection event')
      await until(() => harness.connections() >= 2, 'the reconnect')
      await new Promise(resolve => setTimeout(resolve, 60))
      // Only the newer revision reached the page; the cursor never regressed.
      expect(harness.events.map(event => [event.eventId, event.revision])).toEqual([['evt-2', 2]])
      expect(harness.stream.watermark).toBe('evt-2')
      // The reconnect resumed from the applied cursor, not from the window start.
      expect(harness.urls[1]).toContain('after=evt-2')
      expect(harness.statuses).not.toContain('stale')
    } finally {
      harness.stream.stop()
    }
  })

  it('applies a newer revision arriving on a later connection', async () => {
    const harness = scriptedReader([eventFrame('evt-2', 'ws-x', 2), eventFrame('evt-3', 'ws-x', 3)])
    harness.stream.start()
    try {
      await until(() => harness.events.length >= 2, 'both revisions')
      expect(harness.events.map(event => event.revision)).toEqual([2, 3])
      expect(harness.stream.watermark).toBe('evt-3')
      expect(harness.statuses).toContain('live')
    } finally {
      harness.stream.stop()
    }
  })

  it('drops the same revision delivered under a different event id', async () => {
    // Equal revision is no progress: the contract treats it as a repeat, so the
    // page must not be told to reload for it.
    const harness = scriptedReader([eventFrame('evt-2', 'ws-x', 2), eventFrame('evt-2-again', 'ws-x', 2)])
    harness.stream.start()
    try {
      await until(() => harness.connections() >= 2, 'the reconnect')
      await new Promise(resolve => setTimeout(resolve, 60))
      expect(harness.events.map(event => event.eventId)).toEqual(['evt-2'])
      expect(harness.stream.watermark).toBe('evt-2')
    } finally {
      harness.stream.stop()
    }
  })

  it('keeps each resource ordered independently across connections', async () => {
    const harness = scriptedReader([
      eventFrame('a5', 'ws-a', 5) + eventFrame('b2', 'ws-b', 2),
      eventFrame('a4', 'ws-a', 4) + eventFrame('b3', 'ws-b', 3),
    ])
    harness.stream.start()
    try {
      await until(() => harness.events.length >= 3, 'the advancing events')
      await until(() => harness.connections() >= 2, 'the reconnect')
      await new Promise(resolve => setTimeout(resolve, 60))
      // ws-a's regression is dropped; ws-b's advance is independent of ws-a's.
      expect(harness.events.map(event => [event.resourceId, event.revision]))
        .toEqual([['ws-a', 5], ['ws-b', 2], ['ws-b', 3]])
      expect(harness.stream.watermark).toBe('b3')
    } finally {
      harness.stream.stop()
    }
  })

  it('keeps revision state across a protocol-error reconnect on the same cursor', async () => {
    const bad = 'event: workspace.updated\nid: evt-bad\ndata: {"event_id":"evt-bad","resource_type":"workspace","resource_id":"ws-x","event_type":"workspace.updated","occurred_at":"2026-09-12T00:00:00Z","payload":{}}\n\n'
    const harness = scriptedReader([
      eventFrame('evt-5', 'ws-x', 5) + bad,
      eventFrame('evt-4', 'ws-x', 4) + eventFrame('evt-6', 'ws-x', 6),
    ])
    harness.stream.start()
    try {
      await until(() => harness.stream.violation !== undefined, 'the protocol violation')
      await until(() => harness.events.length >= 2, 'the post-violation event')
      expect(harness.events.map(event => event.revision)).toEqual([5, 6])
      // Recovery replays from the cursor the reader already had.
      expect(harness.urls[1]).toContain('after=evt-5')
      expect(harness.stream.watermark).toBe('evt-6')
      expect(harness.stream.violation).toBeUndefined()
      expect(harness.statuses.at(-1)).toBe('live')
    } finally {
      harness.stream.stop()
    }
  })

  it('clears the revision state when the owner starts a new subscription', async () => {
    const harness = scriptedReader([eventFrame('evt-5', 'ws-x', 5)])
    harness.stream.start()
    try {
      await until(() => harness.events.length >= 1, 'the first subscription event')
      // A fresh subscription is a new world: the same resource may legitimately
      // restart from a lower revision, so `start()` must forget the old one.
      harness.stream.start()
      await until(() => harness.events.length >= 2, 'the new subscription event')
      expect(harness.events.map(event => event.revision)).toEqual([5, 5])
      expect(harness.stream.watermark).toBe('evt-5')
    } finally {
      harness.stream.stop()
    }
  })

  it('clears the revision state on stop and delivers nothing afterwards', async () => {
    const harness = scriptedReader([eventFrame('evt-5', 'ws-x', 5)])
    harness.stream.start()
    try {
      await until(() => harness.events.length >= 1, 'the event')
      harness.stream.stop()
      const delivered = harness.events.length
      const connections = harness.connections()
      await new Promise(resolve => setTimeout(resolve, 80))
      expect(harness.events.length).toBe(delivered)
      expect(harness.connections()).toBe(connections)
      expect(harness.stream.watermark).toBe('')
      expect(harness.stream.status).toBe('stopped')
    } finally {
      harness.stream.stop()
    }
  })

  it('recovers a real fixture sever from its own cursor', async () => {
    // The fixture is the service here: it replays from the cursor the reader
    // already holds, so a recovered connection carries only events the page has
    // not seen, and every delivered event id stays unique across connections.
    //
    // Scope note: this fixture never re-issues an applied revision under a new
    // event id (and its prune scenario also shrinks the replay window), so the
    // "new event id carrying an older revision across a connection" combination
    // is not producible through its HTTP surface. That combination is covered by
    // the scripted-connection cases above, which drive this same consumer through
    // real Response/ReadableStream SSE bodies.
    const { baseUrl, port } = await boot()
    const harness = reader(`${baseUrl}/v1/admin/events/stream`)
    harness.stream.start()
    try {
      await until(() => harness.statuses.includes('live') && harness.events.length > 0, 'the first replay')
      const baseline = harness.events.length
      expect(baseline).toBeGreaterThan(0)

      // The service drops the stream; the reader must resume from its cursor.
      const token = await fixtureToken(port)
      await fetch(`http://127.0.0.1:${String(port)}/v1/projects/project-alpha/workspaces`, {
        headers: { authorization: `Bearer ${token}`, 'x-fixture-scenario': 'workspace-sever-stream' },
      })

      await until(() => harness.statuses.includes('reconnecting'), 'the reconnect', 15_000)
      await until(() => harness.statuses.at(-1) === 'live', 'the recovered live state', 15_000)

      const ids = harness.events.map(event => event.eventId)
      expect(new Set(ids).size).toBe(ids.length)
      expect(harness.stream.watermark).toBe(ids.at(-1))
      expect(harness.stream.violation).toBeUndefined()
    } finally {
      harness.stream.stop()
    }
  })

  /** Logs in as the fixture's administrator, for the scenario headers above. */
  async function fixtureToken(port: number): Promise<string> {
    const res = await fetch(`http://127.0.0.1:${String(port)}/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin@example.com', password: 'admin-pass' }),
    })
    return ((await res.json()) as { data: { access_token: string } }).data.access_token
  }
})
