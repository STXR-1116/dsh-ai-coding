/**
 * P2-08 (Host side): the service's own provenance declaration must survive the
 * Host→UI seam so the plugin and the admin can render `fixture-only` mechanically
 * instead of presenting fixture data as production success.
 *
 * `x-fixture-only: true` is the service's declaration; the Host copies it onto the
 * `ready` outcome and never infers it locally. Failure outcomes carry no provenance
 * because there is no data to attribute.
 */

import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { createTeamSkillService } from '../dev/team-skill-service/src/server.ts'
import { WorkspaceHost } from '../src/workspace-host.ts'
import type { WorkspaceSessionProvider } from '../src/workspace-host.ts'

const servers: Server[] = []
const services: ReturnType<typeof createTeamSkillService>[] = []
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => { resolve() }))
  }
  for (const service of services.splice(0)) {
    service.server.closeAllConnections()
    await new Promise<void>(resolve => service.server.close(() => { resolve() }))
  }
})

const emptyWorkspaces = { items: [] as unknown[] }

/** Serves one envelope, optionally declaring fixture provenance. */
async function serve(fixtureOnly: boolean): Promise<string> {
  const server = createServer((_request, response) => {
    response.writeHead(200, {
      'content-type': 'application/json',
      ...(fixtureOnly ? { 'x-fixture-only': 'true' } : {}),
    })
    response.end(JSON.stringify({ code: 0, message: 'ok', request_id: 'req-prov-1', data: emptyWorkspaces }))
  })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => { resolve() }))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

const session: WorkspaceSessionProvider = {
  read: async () => ({ accessToken: 'provenance-token', identity: 'identity:provenance-token' }),
  clear: async () => true,
}

describe('P2-08 the Host carries the service provenance declaration', () => {
  it('marks a ready outcome fixture-only when the service declares it', async () => {
    const baseUrl = await serve(true)
    const result = await new WorkspaceHost({ apiBaseUrl: baseUrl, session }).workspaces('project-1')

    expect(result).toMatchObject({ status: 'ready', fixtureOnly: true })
  })

  it('marks a ready outcome as not fixture-only when the service does not declare it', async () => {
    const baseUrl = await serve(false)
    const result = await new WorkspaceHost({ apiBaseUrl: baseUrl, session }).workspaces('project-1')

    expect(result).toMatchObject({ status: 'ready', fixtureOnly: false })
  })

  it('carries no provenance on a failure outcome', async () => {
    const server = createServer((_request, response) => {
      response.writeHead(503, { 'content-type': 'application/json', 'x-fixture-only': 'true' })
      response.end(JSON.stringify({ code: 'SERVICE_UNAVAILABLE', message: '维护中', request_id: 'req-prov-2', data: null }))
    })
    servers.push(server)
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => { resolve() }))
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

    const result = await new WorkspaceHost({ apiBaseUrl: baseUrl, session }).workspaces('project-1')

    expect(result).toMatchObject({ status: 'failed', code: 'SERVICE_UNAVAILABLE' })
    expect('fixtureOnly' in result).toBe(false)
  })

  it('reports fixture-only for the real fixture service over real HTTP', async () => {
    const service = createTeamSkillService({ port: 0 })
    services.push(service)
    await service.listen()
    const baseUrl = `http://127.0.0.1:${(service.server.address() as AddressInfo).port}`

    const result = await new WorkspaceHost({
      apiBaseUrl: baseUrl,
      session: { read: async () => ({ accessToken: 'demo-token', identity: 'identity:demo-token' }), clear: async () => true },
    }).workspaces('project-alpha')

    expect(result).toMatchObject({ status: 'ready', fixtureOnly: true })
  })

  it('keeps provenance per call instead of leaking it across concurrent queries', async () => {
    const fixtureBase = await serve(true)
    const plainBase = await serve(false)

    const [fixture, plain] = await Promise.all([
      new WorkspaceHost({ apiBaseUrl: fixtureBase, session }).workspaces('project-1'),
      new WorkspaceHost({ apiBaseUrl: plainBase, session }).workspaces('project-1'),
    ])

    expect(fixture).toMatchObject({ status: 'ready', fixtureOnly: true })
    expect(plain).toMatchObject({ status: 'ready', fixtureOnly: false })
  })
})
