/**
 * P1-06: account credentials and a static deployment token are mutually exclusive
 * identities, chosen by an explicit deployment mode.
 *
 * In an account deployment the shared credential record is the only identity: a
 * missing, deleted, unreadable, or 401-cleared grant is `signed-out` and never
 * silently becomes some other identity. A static token is usable only when the
 * deployment declares `authMode: 'static-token'`, and declaring that mode requires
 * the token — an account deployment that also carries one is ambiguous and rejects.
 */

import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import {
  WorkspaceGateway,
  validateWorkspaceGatewayConfig,
  type WorkspaceGatewayConfig,
} from '../src/workspace-gateway.ts'

const ACCOUNT_KEY = 'dsh-ai-coding-platform/account'

const servers: Server[] = []
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => { resolve() }))
  }
})

interface Recorded {
  readonly url: string
  readonly authorization: string | undefined
}

/** Serves a canned envelope, optionally rejecting with a 401 AUTH_REQUIRED. */
async function serve(behaviour: 'ok' | 'unauthorized' = 'ok'): Promise<{ readonly baseUrl: string; readonly requests: Recorded[] }> {
  const requests: Recorded[] = []
  const server = createServer((request, response) => {
    requests.push({ url: request.url ?? '', authorization: request.headers.authorization })
    if (behaviour === 'unauthorized') {
      response.writeHead(401, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ code: 'AUTH_REQUIRED', message: '登录已失效', request_id: 'req-401', data: null }))
      return
    }
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ code: 0, message: 'ok', request_id: 'req-ok', data: { items: [] } }))
  })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => { resolve() }))
  return { baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests }
}

/** Minimal credential store: presence of a `grant` record is the whole fact. */
class FakeCredentials {
  readonly deleted: string[] = []
  readonly records = new Map<string, unknown>()
  failReads = false
  /** Replaces the stored grant once, inside the next read-modify-write window. */
  swapOnModify: string | undefined

  async readRecord(key: string): Promise<unknown> {
    if (this.failReads) throw new Error('credential store unavailable')
    return this.records.get(key)
  }

  async deleteRecord(key: string): Promise<void> {
    this.deleted.push(key)
    this.records.delete(key)
  }

  /** Serialized read-modify-write; returning the current record leaves it untouched. */
  async modifyRecord(key: string, mutate: (current: unknown) => Promise<unknown>): Promise<unknown> {
    if (this.swapOnModify !== undefined) {
      this.records.set(key, { kind: 'grant', payload: { accessToken: this.swapOnModify } })
      this.swapOnModify = undefined
    }
    const current = this.records.get(key)
    const next = await mutate(current)
    if (next !== undefined && next !== current) this.records.set(key, next)
    return next ?? current
  }

  grant(accessToken: string): void {
    this.records.set(ACCOUNT_KEY, { kind: 'grant', payload: { accessToken } })
  }
}

function gateway(baseUrl: string, config: WorkspaceGatewayConfig, credentials: FakeCredentials): WorkspaceGateway {
  const ctx = new Context()
  ctx.provide('credentials', credentials as never)
  return new WorkspaceGateway(ctx, { apiBaseUrl: baseUrl, ...config })
}

describe('P1-06 deployment mode is explicit and mutually exclusive', () => {
  it.each<[string, WorkspaceGatewayConfig, boolean]>([
    ['an account deployment with no token', {}, true],
    ['a static deployment with its token', { authMode: 'static-token', accessToken: 'static-token' }, true],
    ['a static deployment without a token', { authMode: 'static-token' }, false],
    ['an implicit account deployment carrying a token', { accessToken: 'static-token' }, false],
    ['an explicit account deployment carrying a token', { authMode: 'account', accessToken: 'static-token' }, false],
  ])('%s', (_name, config, accepted) => {
    const run = (): WorkspaceGatewayConfig => validateWorkspaceGatewayConfig(config)
    if (accepted) {
      expect(run()).toMatchObject({ authMode: config.authMode ?? 'account' })
      return
    }
    expect(run).toThrow(/cloudWorkspaces/u)
  })

  it('refuses an account deployment that carries a static token instead of preferring one', () => {
    const ctx = new Context()
    ctx.provide('credentials', new FakeCredentials() as never)
    expect(() => new WorkspaceGateway(ctx, { apiBaseUrl: 'http://127.0.0.1:1', accessToken: 'static-token' }))
      .toThrow(/authMode "static-token"/u)
  })
})

describe('P1-06 account deployments use the credential record only', () => {
  it('sends the stored grant as the request identity', async () => {
    const { baseUrl, requests } = await serve()
    const credentials = new FakeCredentials()
    credentials.grant('account-grant-token')

    const result = await gateway(baseUrl, {}, credentials).workspaces('project-1')

    expect(result.status).toBe('ready')
    expect(requests).toHaveLength(1)
    expect(requests[0]?.authorization).toBe('Bearer account-grant-token')
  })

  it('reports signed-out for a deleted grant without issuing any request', async () => {
    const { baseUrl, requests } = await serve()
    const credentials = new FakeCredentials()
    credentials.grant('account-grant-token')
    await credentials.deleteRecord(ACCOUNT_KEY)

    const result = await gateway(baseUrl, {}, credentials).workspaces('project-1')

    expect(result).toEqual({ status: 'signed-out' })
    expect(requests).toEqual([])
    expect(credentials.deleted).toEqual([ACCOUNT_KEY])
  })

  it('reports signed-out when the credential store cannot be read', async () => {
    const { baseUrl, requests } = await serve()
    const credentials = new FakeCredentials()
    credentials.grant('account-grant-token')
    credentials.failReads = true

    const result = await gateway(baseUrl, {}, credentials).workspaces('project-1')

    expect(result).toEqual({ status: 'signed-out' })
    expect(requests).toEqual([])
  })

  it('clears the grant and signs out on a 401, and stays signed out afterwards', async () => {
    const { baseUrl, requests } = await serve('unauthorized')
    const credentials = new FakeCredentials()
    credentials.grant('account-grant-token')
    const cloudWorkspaces = gateway(baseUrl, {}, credentials)

    expect(await cloudWorkspaces.workspaces('project-1')).toEqual({ status: 'signed-out' })
    expect(credentials.deleted).toEqual([ACCOUNT_KEY])
    expect(requests).toHaveLength(1)

    // The cleared grant is not retried and no other identity takes its place.
    expect(await cloudWorkspaces.workspaces('project-1')).toEqual({ status: 'signed-out' })
    expect(requests).toHaveLength(1)
  })

  it('reports signed-out for a grant that carries no usable token', async () => {
    const { baseUrl, requests } = await serve()

    const empty = new FakeCredentials()
    empty.records.set(ACCOUNT_KEY, { kind: 'grant', payload: { accessToken: '' } })
    expect(await gateway(baseUrl, {}, empty).workspaces('project-1')).toEqual({ status: 'signed-out' })

    // A payload that is not a token at all is the same fact, not a token shaped like one.
    const malformed = new FakeCredentials()
    malformed.records.set(ACCOUNT_KEY, { kind: 'grant', payload: { accessToken: 42 } })
    expect(await gateway(baseUrl, {}, malformed).workspaces('project-1')).toEqual({ status: 'signed-out' })

    expect(requests).toEqual([])
  })

  it('declines the 401 clear when the stored grant was replaced while the request was out', async () => {
    const { baseUrl } = await serve('unauthorized')
    const credentials = new FakeCredentials()
    credentials.grant('superseded-token')
    const cloudWorkspaces = gateway(baseUrl, {}, credentials)
    // The 401 belongs to the token that just left the store: deleting it would take
    // the account that replaced it offline too.
    credentials.swapOnModify = 'replacement-token'

    expect(await cloudWorkspaces.workspaces('project-1')).toEqual({ status: 'signed-out' })
    expect(credentials.deleted).toEqual([])
    expect(credentials.records.get(ACCOUNT_KEY)).toMatchObject({ payload: { accessToken: 'replacement-token' } })
  })
})

describe('P1-06 static-token deployments are explicit and self-contained', () => {
  it('sends the configured static token as the request identity', async () => {
    const { baseUrl, requests } = await serve()
    const credentials = new FakeCredentials()
    credentials.grant('account-grant-token')

    const cloudWorkspaces = gateway(baseUrl, { authMode: 'static-token', accessToken: 'static-token' }, credentials)
    const result = await cloudWorkspaces.workspaces('project-1')

    expect(result.status).toBe('ready')
    expect(requests[0]?.authorization).toBe('Bearer static-token')
  })

  it('ignores the account credential record in a static deployment', async () => {
    const { baseUrl, requests } = await serve()
    const credentials = new FakeCredentials()
    credentials.grant('account-grant-token')

    await gateway(baseUrl, { authMode: 'static-token', accessToken: 'static-token' }, credentials).workspaces('project-1')

    expect(requests[0]?.authorization).toBe('Bearer static-token')
    expect(credentials.deleted).toEqual([])
  })

  it('does not delete the account credential record when a static deployment sees a 401', async () => {
    const { baseUrl } = await serve('unauthorized')
    const credentials = new FakeCredentials()
    credentials.grant('account-grant-token')

    const result = await gateway(baseUrl, { authMode: 'static-token', accessToken: 'static-token' }, credentials)
      .workspaces('project-1')

    expect(result).toEqual({ status: 'signed-out' })
    expect(credentials.deleted).toEqual([])
    expect(credentials.records.has(ACCOUNT_KEY)).toBe(true)
  })
})
