import { afterEach, describe, expect, it } from 'vitest'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createTeamSkillService } from '../src/server.ts'

// 0-5：错误 envelope 与错误码表（API 需求 §12）机械探针。
// 逐状态码断言统一信封 {code,message,request_id,data} 且错误 data 必须为 null——
// 不得用空数组/空对象伪装失败。500 与下游未知状态由生产服务端交付（§12/§11.5），
// 内存 fixture 不产生该码，此处如实不覆盖。

const services: Array<{ readonly server: Server }> = []

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

async function start(): Promise<number> {
  const service = createTeamSkillService({ port: 0 })
  services.push(service)
  await service.listen()
  return (service.server.address() as AddressInfo).port
}

interface Envelope {
  readonly code: string | number
  readonly message: string
  readonly request_id: string
  readonly data: unknown
}

async function post(
  port: number,
  path: string,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<{ readonly status: number; readonly envelope: Envelope }> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer demo-token', ...headers },
    body: JSON.stringify(body),
  })
  return { status: response.status, envelope: (await response.json()) as Envelope }
}

function assertErrorEnvelope(envelope: Envelope, label: string): void {
  expect(envelope.request_id.length, `${label} 必须携带 request_id`).toBeGreaterThan(0)
  expect(envelope.message.length, `${label} 必须携带 message`).toBeGreaterThan(0)
  // 错误数据必须为 null：不能用空数组/空对象伪装失败。
  expect(envelope.data, `${label} 错误 data 必须为 null`).toBeNull()
}

describe('0-5 错误 envelope 与错误码表（§12）', () => {
  it('逐状态码断言统一信封且错误 data 为 null', async () => {
    const port = await start()

    // 400：写请求缺 Idempotency-Key。
    const missing = await post(port, '/v3/project-memory/update', { memory_id: 'm-1', content: 'x', expected_revision: 1 }, { 'if-match': '1' })
    expect(missing.status).toBe(400)
    expect(missing.envelope.code).toBe('IDEMPOTENCY_KEY_REQUIRED')
    assertErrorEnvelope(missing.envelope, '400')

    // 401：无效令牌。
    const unauthorized = await post(port, '/v3/project-memory/list', { project_id: 'project-alpha' }, { authorization: 'Bearer invalid-token' })
    expect(unauthorized.status).toBe(401)
    assertErrorEnvelope(unauthorized.envelope, '401')

    // 403：无权资源。
    const forbidden = await post(port, '/v3/project-memory/list', { project_id: 'project-beta' })
    expect(forbidden.status).toBe(403)
    expect(forbidden.envelope.code).toBe('PROJECT_ACCESS_DENIED')
    assertErrorEnvelope(forbidden.envelope, '403')

    // 404：资源不存在。
    const notFound = await post(port, '/v3/project-memory/get', { memory_id: 'm-missing' })
    expect(notFound.status).toBe(404)
    assertErrorEnvelope(notFound.envelope, '404')

    // 409：revision 冲突。
    const conflict = await post(port, '/v3/project-memory/update', { memory_id: 'm-1', content: 'stale', expected_revision: 99 }, { 'idempotency-key': 'envelope-409', 'if-match': '99' })
    expect(conflict.status, JSON.stringify(conflict.envelope)).toBe(409)
    expect(conflict.envelope.code).toBe('MEMORY_REVISION_CONFLICT')
    assertErrorEnvelope(conflict.envelope, '409')

    // 422：字段/业务校验失败（缺项目上下文）。
    const invalid = await post(port, '/v3/project-memory/list', {})
    expect(invalid.status).toBe(422)
    expect(invalid.envelope.code).toBe('PROJECT_CONTEXT_REQUIRED')
    assertErrorEnvelope(invalid.envelope, '422')

    // 503：下游依赖不可用（fixture 场景注入）。
    const unavailable = await post(port, '/v3/project-memory/recall', { project_id: 'project-alpha', query: 'x' }, { 'x-fixture-scenario': 'unavailable' })
    expect(unavailable.status).toBe(503)
    assertErrorEnvelope(unavailable.envelope, '503')
  })
})
