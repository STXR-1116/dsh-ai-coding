/**
 * 夹具：会话记录的**列表与新建**（`docs/backend-api-requirements.md` §3.1.1）。
 *
 * 这三条覆盖契约里最容易出错的三处：
 *  1. 新建返回 201 + 记录形状；
 *  2. 新建后列表**立即**能查到（前端重新拉列表，不做本地乐观插入）；
 *  3. 同一 `client_request_id` 重试必须**幂等**（返回同一条，且列表里只有一条）。
 */
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

/** 起一个随机端口的夹具实例，返回端口与鉴权头。 */
async function boot(): Promise<{ readonly port: number; readonly headers: Record<string, string> }> {
  const service = createTeamSkillService({ port: 0 })
  services.push(service)
  await service.listen()
  const port = (service.server.address() as AddressInfo).port
  return {
    port,
    headers: { authorization: 'Bearer demo-token', 'content-type': 'application/json' },
  }
}

describe('夹具：会话记录 §3.1.1', () => {
  it('POST 新建 ⇒ 201 且返回记录形状', async () => {
    const { port, headers } = await boot()
    const response = await fetch(`http://127.0.0.1:${port}/v1/workspaces/ws-alpha-1/sessions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ title: '来自测试的新会话' }),
    })
    expect(response.status).toBe(201)
    const payload = (await bodyOf(response)) as { session?: Record<string, unknown> }
    expect(payload.session).toBeDefined()
    expect(payload.session?.title).toBe('来自测试的新会话')
    expect(typeof payload.session?.session_id).toBe('string')
    expect(typeof payload.session?.updated_at).toBe('string')
  })

  it('新建后列表立即能查到，且排在种子记录之前', async () => {
    const { port, headers } = await boot()
    const created = await fetch(`http://127.0.0.1:${port}/v1/workspaces/ws-alpha-1/sessions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ title: '排序检查' }),
    })
    const createdBody = (await bodyOf(created)) as { session?: { session_id?: string } }
    const listResponse = await fetch(`http://127.0.0.1:${port}/v1/workspaces/ws-alpha-1/sessions`, { headers })
    expect(listResponse.status).toBe(200)
    const list = (await bodyOf(listResponse)) as { items?: { session_id?: string; title?: string }[] }
    expect(list.items?.[0]?.session_id).toBe(createdBody.session?.session_id)
    expect(list.items?.some(item => item.title === '排序检查')).toBe(true)
    // 种子记录仍在（新的是追加，不是替换）
    expect(list.items?.some(item => item.title === '初始化与依赖安装')).toBe(true)
  })

  it('同一 client_request_id 重试 ⇒ 返回同一条，列表里也只有一条', async () => {
    const { port, headers } = await boot()
    const body = JSON.stringify({ title: '幂等检查', client_request_id: 'req-42' })
    const first = await fetch(`http://127.0.0.1:${port}/v1/workspaces/ws-alpha-1/sessions`, { method: 'POST', headers, body })
    const firstBody = (await bodyOf(first)) as { session?: { session_id?: string } }
    const second = await fetch(`http://127.0.0.1:${port}/v1/workspaces/ws-alpha-1/sessions`, { method: 'POST', headers, body })
    const secondBody = (await bodyOf(second)) as { session?: { session_id?: string } }
    expect(secondBody.session?.session_id).toBe(firstBody.session?.session_id)

    const list = (await bodyOf(await fetch(`http://127.0.0.1:${port}/v1/workspaces/ws-alpha-1/sessions`, { headers }))) as {
      items?: { title?: string }[]
    }
    expect(list.items?.filter(item => item.title === '幂等检查')).toHaveLength(1)
  })
})
