import http from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NextRequest } from 'next/server'
import { handleTeamSkillProxy } from '../src/app/api/team-skill/proxy-handler.ts'
import { CloudWorkspaceStream } from '../src/lib/cloud-workspace-stream.ts'

function makeRequest(path: string, method = 'GET'): NextRequest {
  const request = new Request(`http://localhost/api/team-skill/${path}`, { method })
  // handleTeamSkillProxy 读取 nextUrl.search；普通 Request 没有该字段，补齐。
  return Object.assign(request as unknown as NextRequest, { nextUrl: new URL(request.url) })
}

function makeContext(path: string[]): { params: Promise<{ readonly path: readonly string[] }> } {
  return { params: Promise.resolve({ path }) }
}

const services: Array<{ readonly server: import('node:http').Server }> = []

/** 等待一个条件成立，用于观察异步透传的帧。 */
async function until(predicate: () => boolean, label: string, budget = 4000): Promise<void> {
  const deadline = Date.now() + budget
  while (!predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10))
  if (!predicate()) throw new Error(`timed out waiting for ${label}`)
}

afterEach(async () => {
  console.log('SERVICES_BEFORE', services.length, services.map(s => typeof s))
  for (const service of services.splice(0)) {
    service.server.closeAllConnections()
    await new Promise<void>((resolve) => {
      service.server.close(() => {
        resolve()
      })
    })
  }
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('team-skill admin proxy (P1-06)', () => {
  it('returns a stable JSON 503 when the base URL is not configured', async () => {
    vi.stubEnv('TEAM_SKILL_SERVICE_URL', '')
    const response = await handleTeamSkillProxy(makeRequest('admin/team-skills'), makeContext(['admin', 'team-skills']), async () => 'token')
    expect(response.status).toBe(503)
    const body = (await response.json()) as { code: string; data: unknown; request_id: string }
    expect(body.code).toBe('SERVICE_UNAVAILABLE')
    expect(body.data).toBeNull()
    expect(body.request_id).toBeTruthy()
  })

  it('does not fall back to the account service when MemoryService is not configured', async () => {
    vi.stubEnv('TEAM_SKILL_SERVICE_URL', 'http://127.0.0.1:49990/v1')
    vi.stubEnv('MEMORY_SERVICE_URL', '')
    const response = await handleTeamSkillProxy(
      makeRequest('v3/project-memory/list', 'POST'),
      makeContext(['v3', 'project-memory', 'list']),
      async () => 'token',
    )
    expect(response.status).toBe(503)
    const body = (await response.json()) as { code: string; data: unknown; request_id: string }
    expect(body.code).toBe('MEMORY_SERVICE_UNAVAILABLE')
    expect(body.data).toBeNull()
    expect(body.request_id).toBeTruthy()
  })

  it('returns a stable JSON 503 with request_id when the upstream port is closed', async () => {
    vi.stubEnv('TEAM_SKILL_SERVICE_URL', 'http://127.0.0.1:49990')
    const response = await handleTeamSkillProxy(
      makeRequest('admin/team-skills'),
      makeContext(['admin', 'team-skills']),
      async () => 'token',
    )
    expect(response.status).toBe(503)
    const body = (await response.json()) as { code: string; data: unknown; request_id: string }
    expect(body.code).toBe('UPSTREAM_UNAVAILABLE')
    expect(body.data).toBeNull()
    expect(body.request_id).toBeTruthy()
  })

  it('returns a complete auth error envelope when the browser session is absent', async () => {
    vi.stubEnv('TEAM_SKILL_SERVICE_URL', 'http://127.0.0.1:49990')
    const response = await handleTeamSkillProxy(
      makeRequest('admin/team-skills'),
      makeContext(['admin', 'team-skills']),
      async () => undefined,
    )
    expect(response.status).toBe(401)
    const body = (await response.json()) as { code: string; data: unknown; request_id: string }
    expect(body.code).toBe('AUTH_REQUIRED')
    expect(body.data).toBeNull()
    expect(body.request_id).toBeTruthy()
  })

  it('passes through upstream status and JSON body for non-2xx governance codes', async () => {
    const fixture = http.createServer((request, response) => {
      response.writeHead(422, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ code: 'VALIDATION_ERROR', message: '字段无效', request_id: 'up-1', data: null }))
    })
    await new Promise<void>((resolve) => {
      fixture.listen(0, '127.0.0.1', () => {
        resolve()
      })
    })
    services.push({ server: fixture })
    const address = fixture.address() as { port: number }
    vi.stubEnv('TEAM_SKILL_SERVICE_URL', `http://127.0.0.1:${address.port}`)

    const response = await handleTeamSkillProxy(
      makeRequest('admin/team-skills'),
      makeContext(['admin', 'team-skills']),
      async () => 'token',
    )
    expect(response.status).toBe(422)
    const body = (await response.json()) as { code: string; request_id: string }
    expect(body.code).toBe('VALIDATION_ERROR')
  })
  it('forwards a ` :verb` sub-resource segment to the upstream verbatim', async () => {
    // 服务端按原始路径段里的 `:` 切分 publish/archive/clone 动词；代理把已解码的段重新
    // encodeURIComponent 会把 `:` 变成 %3A，上游切不出动词、找不到 profile 而以 404 结束。
    let upstreamUrl = ''
    const upstream = http.createServer((request, response) => {
      upstreamUrl = request.url ?? ''
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ code: 0, message: 'ok', request_id: 'up-verb', data: { ok: true } }))
    })
    await new Promise<void>((resolve) => {
      upstream.listen(0, '127.0.0.1', () => {
        resolve()
      })
    })
    services.push({ server: upstream })
    const address = upstream.address() as { port: number }
    vi.stubEnv('TEAM_SKILL_SERVICE_URL', `http://127.0.0.1:${address.port}`)

    const response = await handleTeamSkillProxy(
      makeRequest('admin/agent-profiles/ap-1/versions/apv-9:publish', 'POST'),
      makeContext(['admin', 'agent-profiles', 'ap-1', 'versions', 'apv-9:publish']),
      async () => 'token',
    )
    expect(response.status).toBe(200)
    expect(upstreamUrl).toBe('/admin/agent-profiles/ap-1/versions/apv-9:publish')
  })
  it('carries an authorized event stream through without a request deadline', async () => {
    // 上游是一个长连接事件流；代理必须把 body 原样透传，并且不能给流设 30 秒超时。
    const upstream = http.createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
      response.write(
        'event: workspace.updated\nid: evt-1\ndata: '
        + '{"event_id":"evt-1","resource_type":"workspace","resource_id":"ws-1","revision":1,'
        + '"event_type":"workspace.updated","occurred_at":"2026-09-10T00:00:00Z","payload":{}}\n\n',
      )
      response.write('event: stream.replay-done\ndata: {}\n\n')
      // 保持连接打开：只有调用方断开时上游才结束。
    })
    await new Promise<void>((resolve) => {
      upstream.listen(0, '127.0.0.1', () => {
        resolve()
      })
    })
    services.push({ server: upstream })
    const address = upstream.address() as { port: number }
    vi.stubEnv('TEAM_SKILL_SERVICE_URL', `http://127.0.0.1:${address.port}`)

    let received = 0
    const stream = new CloudWorkspaceStream({
      url: '/api/team-skill/admin/events/stream',
      callbacks: {
        onStatus: () => undefined,
        onEvent: () => { received += 1 },
        onResync: () => Promise.resolve(),
      },
      fetch: (input, init) => {
        const target = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
        const url = `http://localhost${target}`
        const request = Object.assign(
          new Request(url, {
            headers: init?.headers as Record<string, string>,
            ...(init?.signal === undefined ? {} : { signal: init.signal }),
          }) as unknown as NextRequest,
          { nextUrl: new URL(url) },
        )
        return handleTeamSkillProxy(request, makeContext(['admin', 'events', 'stream']), async () => 'upstream-token')
      },
    })
    stream.start()
    try {
      await until(() => received === 1, 'the proxied frame')
      expect(stream.status).toBe('live')
      expect(stream.watermark).toBe('evt-1')
    } finally {
      stream.stop()
    }
  })
})
