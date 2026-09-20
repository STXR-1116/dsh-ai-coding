/**
 * AFC-12：Host 侧的不透明分页游走必须**完整消费或显式失败**。
 *
 * 旧实现只循环 50 页，达到上限后仍然返回 `ok`——第 51 页存在时调用方拿到的是被
 * 静默截断的列表，却看到成功状态。本规格覆盖 0/1/50/51 页、重复游标与超过实现上限，
 * 并断言请求次数、最终条数与失败时的错误码。
 */
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { WorkspaceHost } from '../src/workspace-host.ts'
import type { WorkspaceSessionProvider } from '../src/workspace-host.ts'

const servers: Server[] = []
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections()
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve()
      })
    })
  }
})

function session(): WorkspaceSessionProvider {
  const current = 'pagination-token'
  return {
    read: async () => ({ accessToken: current, identity: `identity:${current}` }),
    clear: async () => false,
  }
}

const profile = {
  agent_profile_id: 'ap-1',
  agent_profile_version_id: 'apv-1',
  name: 'Default',
  description: '默认执行配置',
  version_label: 'v1',
  change_summary: '首个发布版本',
  agent_type_id: 'at-1',
  agent_type_name: 'Claude Code',
  agent_type_key: 'claude_code',
  agent_type_readiness: 'ready',
  agent_type_capabilities: ['bash'],
  model: 'deepseek-v3.2',
  reasoning: 'medium',
  skills: [],
  knowledge_bases: [],
  memory: null,
  execution_policy: { permission_mode: 'approval', write_mode: 'write' },
  type_extension_config: { permission_mode: 'approval' },
  readiness: 'ready',
  unavailable_reason: null,
  default: false,
  status: 'published',
  created_by: '平台管理员',
  published_at: '2026-09-01T00:00:00.000Z',
  updated_at: '2026-09-01T00:00:00.000Z',
}

/** 按脚本服务分页；`nextFor` 决定每一页声明的下一个游标（null = 耗尽）。 */
async function serveWalk(
  nextFor: (cursor: string | undefined) => string | null,
  items: readonly unknown[] = [profile],
): Promise<{ readonly baseUrl: string; readonly cursors: (string | undefined)[] }> {
  const cursors: (string | undefined)[] = []
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost')
    const cursor = url.searchParams.get('cursor') ?? undefined
    cursors.push(cursor)
    const next = nextFor(cursor)
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({
      code: 0,
      message: 'ok',
      request_id: `req-${String(cursors.length)}`,
      data: { items, next_cursor: next },
    }))
  })
  servers.push(server)
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve()
    })
  })
  return { baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, cursors }
}

/** 走完 n 页后耗尽：第 k 次调用（k 从 1 起）返回 `cursor-<k>`，第 n 次返回 null。 */
const pagesThenDone = (n: number) => (cursor: string | undefined): string | null => {
  const served = cursor === undefined ? 1 : Number(cursor.replace('cursor-', '')) + 1
  return served >= n ? null : `cursor-${String(served)}`
}

describe('AFC-12 host pagination walk', () => {
  it('consumes an empty result and stops at the declared completion', async () => {
    const { baseUrl, cursors } = await serveWalk(() => null, [])
    const result = await new WorkspaceHost({ apiBaseUrl: baseUrl, session: session() }).agentProfiles('project-1')
    expect(result.status).toBe('ready')
    if (result.status !== 'ready') return
    expect(result.value).toEqual([])
    expect(cursors).toEqual([undefined])
  })

  it('consumes a single page when the server declares completion', async () => {
    const { baseUrl, cursors } = await serveWalk(() => null)
    const result = await new WorkspaceHost({ apiBaseUrl: baseUrl, session: session() }).agentProfiles('project-1')
    expect(result.status).toBe('ready')
    if (result.status !== 'ready') return
    expect(result.value).toHaveLength(1)
    expect(cursors).toEqual([undefined])
  })

  it('consumes exactly fifty pages and passes every cursor through opaquely', async () => {
    const { baseUrl, cursors } = await serveWalk(pagesThenDone(50))
    const result = await new WorkspaceHost({ apiBaseUrl: baseUrl, session: session() }).agentProfiles('project-1')
    expect(result.status).toBe('ready')
    if (result.status !== 'ready') return
    expect(result.value).toHaveLength(50)
    expect(cursors).toHaveLength(50)
    expect(cursors[0]).toBeUndefined()
    expect(cursors[1]).toBe('cursor-1')
    expect(cursors.at(-1)).toBe('cursor-49')
  })

  it('consumes page fifty-one instead of truncating at fifty', async () => {
    const { baseUrl, cursors } = await serveWalk(pagesThenDone(51))
    const result = await new WorkspaceHost({ apiBaseUrl: baseUrl, session: session() }).agentProfiles('project-1')
    expect(result.status).toBe('ready')
    if (result.status !== 'ready') return
    // 第 51 页真的被读到了：旧实现会在这里返回 50 条却报成功。
    expect(result.value).toHaveLength(51)
    expect(cursors).toHaveLength(51)
  })

  it('fails explicitly on a repeating cursor instead of reporting success', async () => {
    const { baseUrl, cursors } = await serveWalk(() => 'opaque-repeat')
    const result = await new WorkspaceHost({ apiBaseUrl: baseUrl, session: session() }).agentProfiles('project-1')
    expect(result.status).toBe('failed')
    if (result.status !== 'failed') return
    expect(result.code).toBe('SERVICE_PROTOCOL_ERROR')
    expect(result.message).toContain('opaque-repeat')
    // 第一次读到重复游标就停：不会继续空转，也不会返回部分列表。
    expect(cursors).toEqual([undefined, 'opaque-repeat'])
  })

  it('fails explicitly past the implementation limit instead of returning a partial list', async () => {
    const { baseUrl, cursors } = await serveWalk(cursor => `cursor-${String(cursor === undefined ? 1 : Number(cursor.replace('cursor-', '')) + 1)}`)
    const result = await new WorkspaceHost({ apiBaseUrl: baseUrl, session: session() }).agentProfiles('project-1')
    expect(result.status).toBe('failed')
    if (result.status !== 'failed') return
    expect(result.code).toBe('PAGINATION_LIMIT')
    expect(result.message).toContain('1000')
    expect(cursors).toHaveLength(1000)
  }, 60_000)

  it('keeps the opaque cursor alongside the caller filter', async () => {
    const urls: string[] = []
    const server = createServer((request, response) => {
      urls.push(request.url ?? '')
      const url = new URL(request.url ?? '/', 'http://localhost')
      const served = url.searchParams.get('cursor') === null ? 1 : 2
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({
        code: 0,
        message: 'ok',
        request_id: 'req-filter',
        data: { items: [profile], next_cursor: served >= 2 ? null : 'cursor-next' },
      }))
    })
    servers.push(server)
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        resolve()
      })
    })
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    const result = await new WorkspaceHost({ apiBaseUrl: baseUrl, session: session() }).agentProfiles('project-alpha')
    expect(result.status).toBe('ready')
    expect(urls).toHaveLength(2)
    // 两页都带着项目筛选，第二页额外带上服务端给的游标。
    expect(urls[0]).toBe('/v1/me/agent-profiles?project_id=project-alpha')
    expect(urls[1]).toBe('/v1/me/agent-profiles?project_id=project-alpha&cursor=cursor-next')
  })
})
