/**
 * P0-02 (event channel): the Host must expose the SSE events it consumed, so a
 * browser consumer can react to concrete `workspace` / `run` / `changes` / `file`
 * events instead of inferring progress from `streamState()` alone.
 *
 * The replay window is bounded: a watermark older than what is retained reports
 * `truncated` so the caller reconciles from a snapshot rather than applying a
 * partial list.
 */

import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { WorkspaceHost } from '../src/workspace-host.ts'
import type { WorkspaceSessionProvider } from '../src/workspace-host.ts'

/** Mirrors `EVENT_BUFFER_LIMIT` in workspace-host.ts: the retained replay window. */
const REPLAY_WINDOW = 256

const servers: Server[] = []
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => { resolve() }))
  }
})

function frame(resourceType: string, eventType: string, id: string, revision: number): string {
  return `event: ${eventType}\nid: ${id}\ndata: ${JSON.stringify({
    event_id: id,
    resource_type: resourceType,
    resource_id: 'ws-events-1',
    revision,
    event_type: eventType,
    occurred_at: new Date().toISOString(),
    payload: { workspace_id: 'ws-events-1' },
  })}\n\n`
}

/** Serves one SSE burst of `total` events, ids zero-padded so ordering is total. */
async function serveEvents(total: number): Promise<string> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
    const kinds = ['workspace', 'run', 'changes', 'file']
    for (let index = 1; index <= total; index += 1) {
      // A real service advances the resource revision on every state change;
      // the fixture does the same so the Host's revision ordering is exercised.
      response.write(frame(
        kinds[index % kinds.length]!,
        `${kinds[index % kinds.length]}.updated`,
        `evt-${String(index).padStart(6, '0')}`,
        index,
      ))
    }
    response.end()
  })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => { resolve() }))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

const session: WorkspaceSessionProvider = {
  read: async () => ({ accessToken: 'stream-events-token', identity: 'identity:stream-events-token' }),
  clear: async () => true,
}

async function until(predicate: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error(`timed out waiting for ${label}`)
}

/** Starts the Host stream and waits until it has consumed at least `count` events. */
async function consume(baseUrl: string, count: number): Promise<WorkspaceHost> {
  const host = new WorkspaceHost({ apiBaseUrl: baseUrl, session, reconnectDelayMs: () => 0 })
  host.startStream({ projectId: 'project-1' })
  await until(() => host.streamEventsAfter('').events.length >= count, `${count} events`)
  return host
}

describe('P0-02 the Host exposes the consumed SSE events', () => {
  it('reports the concrete resource types the UI must react to', async () => {
    const baseUrl = await serveEvents(4)
    const host = await consume(baseUrl, 4)
    try {
      const { events, truncated } = host.streamEventsAfter('')

      expect(truncated).toBe(false)
      expect([...new Set(events.map(event => event.resourceType))].sort()).toEqual(['changes', 'file', 'run', 'workspace'])
    } finally {
      host.stopStream()
    }
  })

  it('returns only the events after the caller watermark', async () => {
    const baseUrl = await serveEvents(4)
    const host = await consume(baseUrl, 4)
    try {
      const all = host.streamEventsAfter('')
      const first = all.events[0]
      if (first === undefined) throw new Error('expected at least one event')
      const rest = host.streamEventsAfter(first.eventId)

      expect(rest.truncated).toBe(false)
      expect(rest.events.map(event => event.eventId)).toEqual(all.events.slice(1).map(event => event.eventId))
      expect(host.streamEventsAfter(all.events.at(-1)?.eventId ?? '')).toEqual({ events: [], truncated: false })
    } finally {
      host.stopStream()
    }
  })

  it('reports truncation when the watermark fell outside the retained window', async () => {
    const baseUrl = await serveEvents(300)
    // Wait for the bounded replay window to saturate, then ask for a watermark
    // that predates it: the oldest retained event is the signal.
    const host = await consume(baseUrl, REPLAY_WINDOW)
    try {
      const oldest = host.streamEventsAfter('').events[0]
      if (oldest === undefined) throw new Error('expected a retained window')
      const { events, truncated } = host.streamEventsAfter('evt-000001')

      expect(truncated).toBe(true)
      expect(oldest.eventId > 'evt-000001').toBe(true)
      expect(events).toEqual(host.streamEventsAfter('').events)
    } finally {
      host.stopStream()
    }
  })

  it('releases the subscription on stop', async () => {
    const baseUrl = await serveEvents(2)
    const host = await consume(baseUrl, 2)
    host.stopStream()

    expect(host.streamState()).toEqual({ status: 'idle' })
  })
})
