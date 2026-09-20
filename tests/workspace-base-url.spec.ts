/**
 * P1-04: one configuration contract for the cloud workspace API base URL.
 *
 * `apiBaseUrl` is the service endpoint. It may be written with or without a
 * trailing `/v1` and with or without a trailing slash; the client normalizes it
 * to the origin and every request path supplies its own `/v1`, so REST reads,
 * writes and the SSE stream each reach exactly one `/v1`. A base URL that is not
 * an absolute http(s) URL fails explicitly at the earliest determinable point
 * instead of being rewritten into a request against a wrong host.
 */

import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { normalizeApiBaseUrl } from '../src/workspace-http.ts'
import { WorkspaceHost } from '../src/workspace-host.ts'
import type { WorkspaceSessionProvider } from '../src/workspace-host.ts'

const servers: Server[] = []
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => { resolve() }))
  }
})

/** Serves JSON envelopes for REST and one SSE frame for the stream path, recording every URL. */
async function serve(): Promise<{ readonly baseUrl: string; readonly urls: string[] }> {
  const urls: string[] = []
  const server = createServer((request, response) => {
    const url = request.url ?? ''
    urls.push(url)
    if (url.startsWith('/v1/events/stream')) {
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(`event: workspace.updated\nid: evt-000002\ndata: ${JSON.stringify({
        event_id: 'evt-000002',
        resource_type: 'workspace',
        resource_id: 'ws-1',
        revision: 2,
        event_type: 'workspace.updated',
        occurred_at: '2026-01-01T00:00:00.000Z',
        payload: { workspace_id: 'ws-1' },
      })}\n\n`)
      return
    }
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ code: 0, message: 'ok', request_id: 'req-base-1', data: { items: [] } }))
  })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => { resolve() }))
  return { baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, urls }
}

const session: WorkspaceSessionProvider = {
  read: async () => ({ accessToken: 'base-url-token', identity: 'identity:base-url-token' }),
  clear: async () => true,
}

async function until(predicate: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error(`timed out waiting for ${label}`)
}

/** The three documented configuration shapes plus their trailing-slash twins. */
const shapes: ReadonlyArray<readonly [string, (origin: string) => string]> = [
  ['origin', origin => origin],
  ['origin with a trailing slash', origin => `${origin}/`],
  ['origin including /v1', origin => `${origin}/v1`],
  ['origin including /v1 and a trailing slash', origin => `${origin}/v1/`],
]

describe('P1-04 apiBaseUrl normalization', () => {
  it.each([
    ['http://service.test', 'http://service.test'],
    ['http://service.test/', 'http://service.test'],
    ['http://service.test/v1', 'http://service.test'],
    ['http://service.test/v1/', 'http://service.test'],
    ['http://service.test/api', 'http://service.test/api'],
    ['http://service.test/api/v1', 'http://service.test/api'],
    ['http://service.test/api/v1/', 'http://service.test/api'],
    ['https://service.test/v1', 'https://service.test'],
  ])('normalizes %s to %s', (input, expected) => {
    expect(normalizeApiBaseUrl(input)).toBe(expected)
  })

  it.each([
    ['/api/v1', /absolute URL/u],
    ['service.test', /absolute URL/u],
    ['ftp://service.test/v1', /http or https/u],
    ['http://service.test/v1?tenant=1', /query or fragment/u],
    ['http://service.test/v1#frag', /query or fragment/u],
  ])('rejects the invalid configuration %s', (input, expected) => {
    expect(() => normalizeApiBaseUrl(input)).toThrow(expected)
  })

  it('fails an invalid configuration explicitly instead of reporting not-ready', async () => {
    const host = new WorkspaceHost({ apiBaseUrl: 'not-a-url', session })
    const result = await host.workspaces('project-1')
    expect(result).toMatchObject({ status: 'failed', code: 'INVALID_CONFIGURATION' })
  })

  it('reports not-ready only for an absent or blank configuration', async () => {
    expect(await new WorkspaceHost({ session }).workspaces('project-1'))
      .toMatchObject({ status: 'not-ready', missing: ['apiBaseUrl'] })
    expect(await new WorkspaceHost({ apiBaseUrl: '   ', session }).workspaces('project-1'))
      .toMatchObject({ status: 'not-ready', missing: ['apiBaseUrl'] })
  })
})

describe('P1-04 every accepted shape reaches exactly one /v1', () => {
  it.each(shapes)('a REST read for %s reaches /v1 once', async (_name, shape) => {
    const { baseUrl, urls } = await serve()
    const result = await new WorkspaceHost({ apiBaseUrl: shape(baseUrl), session }).workspaces('project-1')

    expect(result.status).toBe('ready')
    expect(urls).toEqual(['/v1/projects/project-1/workspaces'])
    expect(urls.every(url => !url.includes('/v1/v1'))).toBe(true)
  })

  it.each(shapes)('a write for %s reaches /v1 once', async (_name, shape) => {
    const { baseUrl, urls } = await serve()
    await new WorkspaceHost({ apiBaseUrl: shape(baseUrl), session }).discardChanges('ws-1', 1)

    expect(urls).toEqual(['/v1/workspaces/ws-1/changes:discard'])
    expect(urls.every(url => !url.includes('/v1/v1'))).toBe(true)
  })

  it.each(shapes)('the SSE stream for %s reaches /v1 once', async (_name, shape) => {
    const { baseUrl, urls } = await serve()
    const host = new WorkspaceHost({ apiBaseUrl: shape(baseUrl), session, reconnectDelayMs: () => 0 })
    try {
      host.startStream({ projectId: 'project-1' })
      await until(() => urls.some(url => url.startsWith('/v1/events/stream')), 'the SSE request')
    } finally {
      host.stopStream()
    }

    const streamUrls = urls.filter(url => url.includes('events/stream'))
    expect(streamUrls[0]?.startsWith('/v1/events/stream?')).toBe(true)
    expect(streamUrls.every(url => !url.includes('/v1/v1'))).toBe(true)
  })
})
