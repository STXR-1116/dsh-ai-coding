/* oxlint-disable typescript/no-unsafe-argument -- 分页游走测试直接操作 JSON 解析结果。 */
/* oxlint-disable typescript/no-unsafe-member-access -- 分页游走测试直接操作 JSON 解析结果。 */
/* oxlint-disable typescript/no-unsafe-assignment -- 分页游走测试直接操作 JSON 解析结果。 */
import { afterEach, describe, expect, it } from 'vitest'
import type { AddressInfo } from 'node:net'
import { createTeamSkillService } from '../src/server.ts'
import { bodyOf } from './response.ts'

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

interface Booted {
  readonly port: number
  readonly adminHeaders: Record<string, string>
  readonly memberHeaders: Record<string, string>
}

async function boot(): Promise<Booted> {
  const service = createTeamSkillService({ port: 0 })
  services.push(service)
  await service.listen()
  const port = (service.server.address() as AddressInfo).port
  return {
    port,
    adminHeaders: { authorization: 'Bearer admin-demo' },
    memberHeaders: { authorization: 'Bearer demo-token' },
  }
}

describe('AFC-03 opaque pagination contract', () => {
  it('pages the admin agent-profile list with a stable null terminator', async () => {
    const { port, adminHeaders } = await boot()
    const seen: string[] = []
    let cursor: string | null = null
    let lastBody: { items: unknown[]; next_cursor: string | null } | undefined
    let pages = 0
    do {
      const cursorParam = cursor === null ? '' : `cursor=${encodeURIComponent(cursor)}&`
      const page = await fetch(`http://127.0.0.1:${port}/v1/admin/agent-profiles?${cursorParam}pagesize=stable`, { headers: adminHeaders })
      if (page.status !== 200) console.log('PAGE DEBUG:', page.status, await page.clone().text())
      expect(page.status).toBe(200)
      expect(page.headers.get('x-fixture-only')).toBe('true')
      lastBody = (await bodyOf(page)) as { items: Array<{ agent_profile_id: string }>; next_cursor: string | null }
      for (const item of lastBody.items) {
        expect(seen).not.toContain(item.agent_profile_id)
        seen.push(item.agent_profile_id)
      }
      cursor = lastBody.next_cursor
      pages += 1
      expect(pages).toBeLessThan(10)
    } while (cursor !== null)
    // 稳定合同：耗尽页的 next_cursor 必须是严格 null（不是缺失、不是空串）。
    expect(lastBody?.next_cursor).toBeNull()
    // 新种子共 4 个 Profile，页大小 2 → 恰好两页耗尽。
    expect(seen.length).toBe(4)
  })

  it('pages user agent-profiles and walks cursor to exhaustion', async () => {
    const { port, memberHeaders } = await boot()
    const seen: string[] = []
    let cursor: string | null = null
    let pages = 0
    do {
      const suffix = cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`
      const page = await fetch(`http://127.0.0.1:${port}/v1/me/agent-profiles?project_id=project-alpha${suffix}`, { headers: memberHeaders })
      expect(page.status).toBe(200)
      const body = (await bodyOf(page)) as { items: Array<{ agent_profile_version_id: string }>; next_cursor: string | null }
      for (const item of body.items) {
        expect(seen).not.toContain(item.agent_profile_version_id)
        seen.push(item.agent_profile_version_id)
      }
      cursor = body.next_cursor
      pages += 1
      expect(pages).toBeLessThan(10)
    } while (cursor !== null)
    expect(seen).toContain('apv-1')
  })

  it('pages admin types and asset candidates lists', async () => {
    const { port, adminHeaders } = await boot()
    for (const path of ['/v1/admin/agent-types', '/v1/admin/asset-candidates?project_id=project-alpha']) {
      const seen: string[] = []
      let cursor: string | null = null
      let lastNext: string | null | undefined
      do {
        const cursorParam = cursor === null ? '' : `cursor=${encodeURIComponent(cursor)}&`
        const page = await fetch(`http://127.0.0.1:${port}${path}${path.includes('?') ? '&' : '?'}${cursorParam}pagesize=stable`, { headers: adminHeaders })
        expect(page.status).toBe(200)
        const body = (await bodyOf(page)) as { items: Array<{ asset_id?: string; agent_type_id?: string }>; next_cursor: string | null }
        expect(Array.isArray(body.items)).toBe(true)
        expect(body.items.length).toBeGreaterThan(0)
        for (const item of body.items) {
          const id = item.asset_id ?? item.agent_type_id
          expect(seen).not.toContain(id)
          seen.push(id)
        }
        lastNext = body.next_cursor
        cursor = body.next_cursor
        expect(seen.length).toBeLessThan(50)
      } while (cursor !== null)
      expect(lastNext).toBeNull()
    }
  })

  it('rejects malformed and stale cursors with INVALID_CURSOR', async () => {
    const { port, adminHeaders } = await boot()
    // ① 语法非法 cursor。
    const malformed = await fetch(`http://127.0.0.1:${port}/v1/admin/agent-profiles?cursor=@@not-a-cursor@@`, { headers: adminHeaders })
    expect(malformed.status).toBe(400)
    expect(await malformed.json()).toMatchObject({ code: 'INVALID_CURSOR', data: null })

    // ② 语法合法但签名不匹配（手造 payload）。
    const forged = Buffer.from(JSON.stringify({ f: 'tampered', o: 0 })).toString('base64url')
    const forgedRes = await fetch(`http://127.0.0.1:${port}/v1/admin/agent-profiles?cursor=${forged}`, { headers: adminHeaders })
    expect(forgedRes.status).toBe(400)
    expect(await forgedRes.json()).toMatchObject({ code: 'INVALID_CURSOR', data: null })

    // ③ 跨筛选复用旧 cursor：先取带 status=draft 的 cursor，再换 readiness=unavailable 重放。
    const seeded = await fetch(`http://127.0.0.1:${port}/v1/admin/agent-profiles`, { headers: adminHeaders })
    const seededBody = (await bodyOf(seeded)) as { next_cursor: string | null }
    expect(seededBody.next_cursor).not.toBeNull()
    const stale = await fetch(`http://127.0.0.1:${port}/v1/admin/agent-profiles?readiness=unavailable&cursor=${encodeURIComponent(seededBody.next_cursor as string)}`, { headers: adminHeaders })
    expect(stale.status).toBe(400)
    expect(await stale.json()).toMatchObject({ code: 'INVALID_CURSOR', data: null })
  })

  it('exposes pagination on the user agent-profiles list with filter-bound cursors', async () => {
    const { port, memberHeaders } = await boot()
    const first = await fetch(`http://127.0.0.1:${port}/v1/me/agent-profiles?project_id=project-alpha`, { headers: memberHeaders })
    expect(first.status).toBe(200)
    const body = (await bodyOf(first)) as { items: unknown[]; next_cursor: string | null }
    // 三个已发布绑定 > 默认页大小：第一页必须截断并给出 cursor。
    expect(body.items.length).toBeGreaterThan(0)
    expect(body.next_cursor).not.toBeNull()
    // 客户端只透传：cursor 是不透明字符串（此处仅校验可回传，不校验内容）。
    const next = await fetch(`http://127.0.0.1:${port}/v1/me/agent-profiles?project_id=project-alpha&cursor=${encodeURIComponent(body.next_cursor as string)}`, { headers: memberHeaders })
    expect(next.status).toBe(200)
    const nextBody = (await bodyOf(next)) as { items: Array<{ agent_profile_version_id: string }>; next_cursor: string | null }
    for (const item of body.items as Array<{ agent_profile_version_id: string }>) {
      expect(nextBody.items.map(entry => entry.agent_profile_version_id)).not.toContain(item.agent_profile_version_id)
    }
  })
})
