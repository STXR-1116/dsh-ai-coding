/**
 * 3-5「运行资产版本快照」平台面契约探针（§11.18 A，2026-09-16 冻结）。
 *
 * 异常矩阵：
 *   缺失      —— run_id/captured_at/run_revision/assets/governance 缺一即协议错误；
 *                条目缺 name/required/order 同样拒绝，不用 0 或空串顶替。
 *   词表外    —— asset_type / readiness_at_binding / current_state 任一越出闭集即拒绝。
 *   自洽      —— `current_state='withdrawn'` 必须带撤回时间与审计行；其余状态必须
 *                两者都为 null。两组状态不得互相推导。
 *   冻结      —— 「读取时刻已撤回、绑定时仍是 ready」是**合法**输入：绑定时刻事实
 *                不被当前状态改写，正是这条契约要保住的东西。
 *   HTTP      —— Host 请求 `:asset-snapshot`；响应漂移时 fail-closed，不返回半份快照。
 */

import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { parseRunAssetSnapshot } from '../src/workspace-http.ts'
import { WorkspaceHost } from '../src/workspace-host.ts'
import type { WorkspaceSessionProvider } from '../src/workspace-host.ts'

const servers: Server[] = []
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => { resolve() }))
  }
})

async function serve(data: unknown): Promise<{ readonly baseUrl: string; readonly urls: string[] }> {
  const urls: string[] = []
  const server = createServer((request, response) => {
    urls.push(request.url ?? '')
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ code: 0, message: 'ok', request_id: 'req-asset-1', data }))
  })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => { resolve() }))
  return { baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, urls }
}

function session(): WorkspaceSessionProvider {
  return {
    read: async () => ({ accessToken: 'test-account-token', identity: 'identity:test-account-token' }),
    clear: async () => false,
  }
}

const boundAsset = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  asset_type: 'skill',
  asset_id: 'skill:code-review',
  asset_version_id: 'skill:code-review@1.0.0',
  name: '代码评审 Skill',
  required: true,
  order: 1,
  readiness_at_binding: 'ready',
  unavailable_reason_at_binding: null,
  current_state: 'bound',
  withdrawn_at: null,
  withdrawal_audit_id: null,
  ...overrides,
})

const snapshot = (
  assets: readonly Record<string, unknown>[],
  governance: readonly Record<string, unknown>[] = [],
): Record<string, unknown> => ({
  run_id: 'run-1',
  captured_at: '2026-09-10T00:00:00.000Z',
  run_revision: 4,
  assets,
  governance,
})

/** Copies a record without one key, so "missing field" cases stay honest. */
function without(record: Record<string, unknown>, key: string): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([name]) => name !== key))
}

describe('§11.18 A 运行资产快照解析是 fail-closed 的', () => {
  it('接受完整快照：绑定时刻事实与读取时刻状态各自成字段', () => {
    const parsed = parseRunAssetSnapshot(snapshot([boundAsset()]))
    expect(parsed.runId).toBe('run-1')
    expect(parsed.runRevision).toBe(4)
    expect(parsed.assets[0]?.readinessAtBinding).toBe('ready')
    expect(parsed.assets[0]?.currentState).toBe('bound')
    expect(parsed.governance).toEqual([])
  })

  it('接受「读取时已撤回、绑定时仍就绪」：冻结事实不被当前状态改写', () => {
    const parsed = parseRunAssetSnapshot(snapshot([boundAsset({
      current_state: 'withdrawn',
      withdrawn_at: '2026-09-11T00:00:00.000Z',
      withdrawal_audit_id: 'audit-1',
    })]))
    expect(parsed.assets[0]?.readinessAtBinding).toBe('ready')
    expect(parsed.assets[0]?.currentState).toBe('withdrawn')
    expect(parsed.assets[0]?.withdrawnAt).toBe('2026-09-11T00:00:00.000Z')
    expect(parsed.assets[0]?.withdrawalAuditId).toBe('audit-1')
  })

  it('缺绑定时刻事实即拒绝，绝不从当前状态推导', () => {
    expect(() => parseRunAssetSnapshot(snapshot([without(boundAsset(), 'readiness_at_binding')]))).toThrow(/readiness_at_binding/u)
    expect(() => parseRunAssetSnapshot(snapshot([without(boundAsset(), 'unavailable_reason_at_binding')]))).toThrow(/unavailable_reason_at_binding/u)
  })

  it('词表外取值与缺字段一律拒绝，不用 0/空串顶替', () => {
    expect(() => parseRunAssetSnapshot(snapshot([boundAsset({ asset_type: 'tool' })]))).toThrow(/run asset type/u)
    expect(() => parseRunAssetSnapshot(snapshot([boundAsset({ readiness_at_binding: 'degraded' })]))).toThrow(/readiness_at_binding/u)
    expect(() => parseRunAssetSnapshot(snapshot([boundAsset({ current_state: 'revoked' })]))).toThrow(/current_state/u)
    expect(() => parseRunAssetSnapshot(snapshot([without(boundAsset(), 'order')]))).toThrow(/run asset order/u)
    expect(() => parseRunAssetSnapshot(snapshot([without(boundAsset(), 'required')]))).toThrow(/run asset required/u)
    expect(() => parseRunAssetSnapshot(without(snapshot([boundAsset()]), 'run_revision'))).toThrow(/run_revision/u)
  })

  it('撤回事实与状态必须自洽：withdrawn 必带撤回时间与审计行，其余状态必为 null', () => {
    expect(() => parseRunAssetSnapshot(snapshot([boundAsset({ current_state: 'withdrawn' })]))).toThrow(/withdrawal time and audit row/u)
    expect(() => parseRunAssetSnapshot(snapshot([boundAsset({ current_state: 'withdrawn', withdrawn_at: '2026-09-11T00:00:00.000Z' })]))).toThrow(/withdrawal time and audit row/u)
    expect(() => parseRunAssetSnapshot(snapshot([boundAsset({ withdrawn_at: '2026-09-11T00:00:00.000Z' })]))).toThrow(/without being withdrawn/u)
    expect(() => parseRunAssetSnapshot(snapshot([boundAsset({ current_state: 'missing', withdrawal_audit_id: 'audit-1' })]))).toThrow(/without being withdrawn/u)
  })

  it('治理行字段齐备：缺 actor_name 即拒绝（跨模块审计必须能指到人）', () => {
    const governance = [{ audit_id: 'audit-1', action: 'asset.version.withdraw', actor_name: '平台管理员', at: '2026-09-11T00:00:00.000Z', asset_version_id: 'skill:code-review@1.0.0' }]
    expect(parseRunAssetSnapshot(snapshot([boundAsset()], governance)).governance[0]?.actorName).toBe('平台管理员')
    expect(() => parseRunAssetSnapshot(snapshot([boundAsset()], [without(governance[0] as Record<string, unknown>, 'actor_name')]))).toThrow(/actor_name/u)
  })
})

describe('§11.18 A Host 读取与漂移', () => {
  it('请求 :asset-snapshot 并解析快照', async () => {
    const { baseUrl, urls } = await serve(snapshot([boundAsset()]))
    const host = new WorkspaceHost({ apiBaseUrl: baseUrl, session: session() })
    const result = await host.runAssetSnapshot('run-1')
    expect(result.status).toBe('ready')
    expect(urls).toEqual(['/v1/runs/run-1:asset-snapshot'])
  })

  it('响应漂移时 fail-closed，不返回半份快照', async () => {
    const { baseUrl } = await serve(snapshot([boundAsset({ current_state: 'withdrawn' })]))
    const result = await new WorkspaceHost({ apiBaseUrl: baseUrl, session: session() }).runAssetSnapshot('run-1')
    expect(result).toMatchObject({ status: 'failed', code: 'SERVICE_PROTOCOL_ERROR' })
    expect('value' in result).toBe(false)
  })
})
