import { afterAll, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { WorkspaceHost } from '../src/workspace-host.ts'
import type { WorkspaceSessionProvider } from '../src/workspace-host.ts'

/** Minimal scriptable SSE origin used to drive reconnect and resync behavior. */
/** Builds one full SSE event frame for the scriptable stream server. */
function sseEventFrame(eventType: string, id: string, revision: number): string {
  return `event: ${eventType}\nid: ${id}\ndata: ${JSON.stringify({
    event_id: id,
    resource_type: 'workspace',
    resource_id: 'ws-stream-1',
    revision,
    event_type: eventType,
    occurred_at: new Date().toISOString(),
    payload: {},
  })}\n\n`
}

function createStreamServer(mode: () => 'drop' | 'resync', urls: string[]): Promise<Server> {
  return new Promise((resolve) => {
    const server = createServer((request, response) => {
      const url = request.url ?? '/'
      urls.push(url)
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
      const frame = sseEventFrame
      if (mode() === 'drop') {
        if (urls.length <= 1) {
          response.write(frame('workspace.updated', 'evt-000010', 10))
          response.write(frame('workspace.updated', 'evt-000011', 11))
          setTimeout(() => {
            response.destroy()
          }, 20)
          return
        }
        response.write(frame('changes.updated', 'evt-000012', 12))
        response.end()
        return
      }
      if (url.includes('after=evt')) {
        response.write(
          'event: resync_required\nid: evt-resync\ndata: {"code":"RESYNC_REQUIRED","message":"事件已超出保留窗口"}\n\n',
        )
        response.end()
        return
      }
      response.write(frame('workspace.ready', 'evt-000020', 20))
      response.end()
    })
    server.listen(0, '127.0.0.1', () => {
      resolve(server)
    })
  })
}

const session: WorkspaceSessionProvider = {
  read: async () => ({ accessToken: 'stream-token', identity: 'identity:stream-token' }),
  clear: async () => true,
}

async function listen(server: Server): Promise<string> {
  const address = server.address() as AddressInfo
  return `http://127.0.0.1:${address.port}`
}

const servers: Server[] = []
afterAll(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections()
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve()
      })
    })
  }
})

function waitFor(host: WorkspaceHost, predicate: (event: { eventType: string; resourceId: string }) => boolean): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('timed out waiting for stream event'))
    }, 4000)
    const dispose = host.onStreamEvent((_subscriptionId, event) => {
      if (!predicate(event)) return
      clearTimeout(timer)
      dispose()
      resolve()
    })
  })
}

describe('WorkspaceHost SSE reconnection', () => {
  it('reconnects after a dropped stream carrying the last event id', async () => {
    const urls: string[] = []
    const server = await createStreamServer(() => 'drop', urls)
    servers.push(server)
    const host = new WorkspaceHost({
      apiBaseUrl: await listen(server),
      session,
      reconnectDelayMs: () => 5,
    })
    host.startStream({ projectId: 'project-alpha' })
    await waitFor(host, event => event.eventType === 'changes.updated')
    expect(urls[0]).toContain('after=')
    expect(urls[1]).toContain('after=evt-000011')
    host.stopStream()
    expect(host.streamState().status).toBe('idle')
  })

  it('re-reads the snapshot on resync_required and resubscribes without a watermark', async () => {
    const urls: string[] = []
    let resyncs = 0
    const server = await createStreamServer(() => 'resync', urls)
    servers.push(server)
    const host = new WorkspaceHost({
      apiBaseUrl: await listen(server),
      session,
      reconnectDelayMs: () => 5,
    })
    host.startStream({
      projectId: 'project-alpha',
      lastEventId: 'evt-000001',
      resync: async () => {
        resyncs += 1
      },
    })
    await waitFor(host, event => event.eventType === 'workspace.ready')
    expect(resyncs).toBe(1)
    expect(urls[0]).toContain('after=evt-000001')
    expect(urls[1]).not.toContain('after=evt')
    host.stopStream()
  })

  it('reports connecting state and fails closed on stream HTTP errors', async () => {
    const host = new WorkspaceHost({
      apiBaseUrl: 'http://127.0.0.1:9',
      session,
      reconnectDelayMs: () => 5,
    })
    const states: string[] = []
    const dispose = host.onStreamStateChange((_subscriptionId, state) => {
      states.push(state.status)
    })
    host.startStream({ projectId: 'project-alpha' })
    await new Promise(resolve => setTimeout(resolve, 60))
    host.stopStream()
    dispose()
    const live = states.filter(status => status !== 'idle')
    expect(live[0]).toBe('connecting')
    expect(live).toContain('reconnecting')
  })

  it('drops duplicate and stale events instead of re-emitting them', async () => {
    const seen: string[] = []
    const server = await new Promise<ReturnType<typeof createServer>>((resolve) => {
      const s = createServer((_request, response) => {
        response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
        response.write(sseEventFrame('workspace.updated', 'evt-000010', 10))
        // Duplicate of the frame above, then a stale replay of an older revision.
        response.write(sseEventFrame('workspace.updated', 'evt-000010', 10))
        response.write(sseEventFrame('workspace.updated', 'evt-000009', 9))
        response.write(sseEventFrame('changes.updated', 'evt-000011', 11))
        response.end()
      })
      s.listen(0, '127.0.0.1', () => {
        resolve(s)
      })
    })
    servers.push(server)
    const host = new WorkspaceHost({
      apiBaseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      session,
      reconnectDelayMs: () => 5,
    })
    const dispose = host.onStreamEvent((_subscriptionId, event) => {
      seen.push(event.eventId)
    })
    host.startStream({ projectId: 'project-alpha' })
    await new Promise(resolve => setTimeout(resolve, 80))
    host.stopStream()
    dispose()
    expect(seen).toEqual(['evt-000010', 'evt-000011'])
  })
})
