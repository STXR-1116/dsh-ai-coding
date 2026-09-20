import { afterEach, describe, expect, it } from 'vitest'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createTeamSkillService } from '../src/server.ts'

// 3-5「运行资产版本快照与跨模块审计」fixture 契约探针（§11.18，2026-09-16 冻结）。
//
// 异常矩阵：
//   缺失      —— 未知运行 → 404；快照字段集必须齐备。
//   冻结      —— readiness_at_binding/unavailable_reason_at_binding 是绑定时刻的事实，
//                撤回后不得改写；current_state 是读取时刻的状态，两者不同名不同义。
//   撤回      —— 撤回后：新运行（必需资产）422 ASSET_UNAVAILABLE；已创建运行的快照
//                与运行状态机都不变；可选资产不可用只是降级，不拦新运行。
//   跨模块审计—— governance 列出绑定资产版本的治理行（asset.*），且行在
//                /v1/admin/audits 里同样可查（actor_name 必填）。
//   并发/幂等 —— 缺 expected_asset_revision → 428；不匹配 → 409；未知版本 → 404；
//                缺幂等键 → 400；空 reason → 422；重复撤回 → 409 INVALID_STATE；
//                同键重放 → 200 同体。
//   只读      —— 两次读取之间，除 current_state/withdrawn_at/withdrawal_audit_id 外
//                逐字不变。

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

async function login(port: number, username: string, password: string): Promise<string> {
  const response = await fetch(`http://127.0.0.1:${port}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  })
  expect(response.status).toBe(200)
  return ((await response.json()) as { data: { access_token: string } }).data.access_token
}

async function send(
  port: number,
  method: string,
  path: string,
  token: string,
  body?: unknown,
  extra: Record<string, string> = {},
): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...extra },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  return { status: response.status, json: (await response.json()) as Record<string, unknown> }
}

function dataOf(result: { json: Record<string, unknown> }): Record<string, unknown> {
  return result.json['data'] as Record<string, unknown>
}

function assetOf(snapshot: Record<string, unknown>, reference: string): Record<string, unknown> | undefined {
  return (snapshot['assets'] as Array<Record<string, unknown>>).find(asset => asset['asset_version_id'] === reference)
}

const WITHDRAW_PATH = '/v1/admin/assets/skill:code-review@1.0.0:withdraw'

async function withdraw(
  port: number,
  token: string,
  key: string,
  body: Record<string, unknown> = { reason: '安全复核不通过，撤回该版本', expected_asset_revision: 1 },
): Promise<{ status: number; json: Record<string, unknown> }> {
  return send(port, 'POST', WITHDRAW_PATH, token, body, { 'idempotency-key': key })
}

async function createRun(
  port: number,
  token: string,
  key: string,
  versionId: string,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const revision = dataOf(await send(port, 'GET', '/v1/workspaces/ws-alpha-1', token))['revision'] as number
  return send(port, 'POST', '/v1/workspaces/ws-alpha-1/runs', token, {
    session_id: `sess-${key}`, write_mode: 'read_only', expected_workspace_revision: revision, agent_profile_version_id: versionId,
  }, { 'idempotency-key': key })
}

describe('3-5 运行资产版本快照（§11.18 A）', () => {
  it('快照字段齐备：绑定时事实与读取时刻状态分开，未知运行 404', async () => {
    const port = await start()
    const admin = await login(port, 'admin@example.com', 'admin-pass')
    const result = await send(port, 'GET', '/v1/runs/run-seed-1:asset-snapshot', admin)
    expect(result.status).toBe(200)
    const data = dataOf(result)
    for (const field of ['run_id', 'captured_at', 'run_revision', 'assets', 'governance']) {
      expect(Object.hasOwn(data, field), `快照必须携带 ${field}`).toBe(true)
    }
    expect(data['run_id']).toBe('run-seed-1')
    const assets = data['assets'] as Array<Record<string, unknown>>
    expect(assets.length).toBe(3)
    for (const asset of assets) {
      for (const field of [
        'asset_type', 'asset_id', 'asset_version_id', 'name', 'required', 'order',
        'readiness_at_binding', 'unavailable_reason_at_binding', 'current_state',
        'withdrawn_at', 'withdrawal_audit_id',
      ]) {
        expect(Object.hasOwn(asset, field), `资产条目必须携带 ${field}`).toBe(true)
      }
      // 种子运行的三条资产在绑定时都是就绪的。
      expect(asset['readiness_at_binding']).toBe('ready')
      expect(asset['unavailable_reason_at_binding']).toBeNull()
      expect(asset['current_state']).toBe('bound')
      expect(asset['withdrawn_at']).toBeNull()
      expect(asset['withdrawal_audit_id']).toBeNull()
    }
    expect(assetOf(data, 'skill:code-review@1.0.0')?.['required']).toBe(true)
    expect(data['governance']).toEqual([])
    expect((await send(port, 'GET', '/v1/runs/run-not-exist:asset-snapshot', admin)).status).toBe(404)
  })

  it('撤回只影响新运行：已创建运行的就绪事实原样保留，只有 current_state 变化', async () => {
    const port = await start()
    const admin = await login(port, 'admin@example.com', 'admin-pass')
    const before = dataOf(await send(port, 'GET', '/v1/runs/run-seed-1:asset-snapshot', admin))
    const runBefore = dataOf(await send(port, 'GET', '/v1/runs/run-seed-1', admin))

    const withdrawn = await withdraw(port, admin, '318-withdraw-1')
    expect(withdrawn.status).toBe(200)
    const row = dataOf(withdrawn)
    expect(row).toMatchObject({ asset_version_id: 'skill:code-review@1.0.0', readiness: 'unavailable', revision: 2 })
    expect(String(row['invalid_reason']).length).toBeGreaterThan(0)
    expect(String(row['withdrawn_at']).length).toBeGreaterThan(0)
    expect(String(row['withdrawal_audit_id']).length).toBeGreaterThan(0)

    // 新运行：必需资产已撤回 → 拒绝，并点名是哪一条。
    const blocked = await createRun(port, admin, '318-blocked-run', 'apv-1')
    expect(blocked.status).toBe(422)
    expect(blocked.json['code']).toBe('ASSET_UNAVAILABLE')
    expect(blocked.json['details']).toMatchObject({ asset_version_ids: ['skill:code-review@1.0.0'] })

    // 可选资产不可用只是降级：apv-lite-1 仍可创建运行。
    const degraded = await createRun(port, admin, '318-degraded-run', 'apv-lite-1')
    expect(degraded.status).toBe(202)

    // 已创建运行：绑定时事实不变，读取时刻状态变为 withdrawn。
    const after = dataOf(await send(port, 'GET', '/v1/runs/run-seed-1:asset-snapshot', admin))
    const assets = after['assets'] as Array<Record<string, unknown>>
    expect(assets.length).toBe((before['assets'] as unknown[]).length)
    const target = assetOf(after, 'skill:code-review@1.0.0') as Record<string, unknown>
    const targetBefore = assetOf(before, 'skill:code-review@1.0.0') as Record<string, unknown>
    expect(target['readiness_at_binding']).toBe('ready')
    expect(target['unavailable_reason_at_binding']).toBeNull()
    expect(target['current_state']).toBe('withdrawn')
    expect(target['withdrawn_at']).toBe(row['withdrawn_at'])
    expect(target['withdrawal_audit_id']).toBe(row['withdrawal_audit_id'])
    // 其余条目与其余字段逐字不变：撤回只动被撤回的那一条。
    for (const asset of assets) {
      if (asset['asset_version_id'] === 'skill:code-review@1.0.0') continue
      expect(asset).toEqual((before['assets'] as Array<Record<string, unknown>>).find(item => item['asset_version_id'] === asset['asset_version_id']))
    }
    expect(targetBefore['current_state']).toBe('bound')

    // 撤回不改运行状态机。
    const runAfter = dataOf(await send(port, 'GET', '/v1/runs/run-seed-1', admin))
    expect(runAfter['status']).toBe(runBefore['status'])
    expect(runAfter['revision']).toBe(runBefore['revision'])
  })

  it('跨模块审计：governance 列出治理行，且同一行在管理面审计里可查（actor_name 必填）', async () => {
    const port = await start()
    const admin = await login(port, 'admin@example.com', 'admin-pass')
    const withdrawn = dataOf(await withdraw(port, admin, '318-audit'))
    const snapshot = dataOf(await send(port, 'GET', '/v1/runs/run-seed-1:asset-snapshot', admin))
    const governance = snapshot['governance'] as Array<Record<string, unknown>>
    const row = governance.find(entry => entry['audit_id'] === withdrawn['withdrawal_audit_id'])
    expect(row, 'governance 必须包含该资产的撤回审计行').toBeDefined()
    expect(row?.['action']).toBe('asset.version.withdraw')
    expect(row?.['asset_version_id']).toBe('skill:code-review@1.0.0')
    expect(String(row?.['actor_name']).length).toBeGreaterThan(0)

    const audits = dataOf(await send(port, 'GET', '/v1/admin/audits?action=asset.version.withdraw', admin)) as unknown as Array<Record<string, unknown>>
    const auditRow = audits.find(entry => entry['id'] === withdrawn['withdrawal_audit_id'])
    expect(auditRow, '撤回必须写业务审计，且与快照引用同一行').toBeDefined()
    expect(String(auditRow?.['actor_name']).length).toBeGreaterThan(0)
    expect(auditRow?.['asset_version_ids']).toEqual(['skill:code-review@1.0.0'])
  })

  it('并发/幂等矩阵：428 / 409 / 404 / 400 / 422 / 重复撤回 409 / 同键重放同体', async () => {
    const port = await start()
    const admin = await login(port, 'admin@example.com', 'admin-pass')

    const noCondition = await send(port, 'POST', WITHDRAW_PATH, admin, { reason: '缺并发条件' }, { 'idempotency-key': '318-428' })
    expect(noCondition.status).toBe(428)
    expect(noCondition.json['code']).toBe('CONCURRENT_CONDITION_REQUIRED')

    const stale = await withdraw(port, admin, '318-stale', { reason: '过期 revision', expected_asset_revision: 7 })
    expect(stale.status).toBe(409)
    expect(stale.json['code']).toBe('REVISION_CONFLICT')

    const realUnknown = await send(port, 'POST', '/v1/admin/assets/skill:code-review@9.9.9:withdraw', admin,
      { reason: '不存在的版本', expected_asset_revision: 1 }, { 'idempotency-key': '318-unknown-2' })
    expect(realUnknown.status).toBe(404)
    expect(dataOf(realUnknown)).toBeNull()

    const noKey = await send(port, 'POST', WITHDRAW_PATH, admin, { reason: '缺键', expected_asset_revision: 1 })
    expect(noKey.status).toBe(400)
    expect(noKey.json['code']).toBe('IDEMPOTENCY_KEY_REQUIRED')

    const blankReason = await withdraw(port, admin, '318-blank', { reason: '   ', expected_asset_revision: 1 })
    expect(blankReason.status).toBe(422)

    const first = await withdraw(port, admin, '318-replay')
    expect(first.status).toBe(200)
    const replay = await withdraw(port, admin, '318-replay')
    expect(replay.status).toBe(200)
    expect(dataOf(replay)).toEqual(dataOf(first))

    const again = await withdraw(port, admin, '318-again')
    expect(again.status).toBe(409)
    expect(again.json['code']).toBe('INVALID_STATE')
  })
})
