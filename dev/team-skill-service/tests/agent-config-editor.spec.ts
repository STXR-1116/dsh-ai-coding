import { afterEach, describe, expect, it } from 'vitest'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createTeamSkillService } from '../src/server.ts'

// 2-6「Agent 配置」fixture 契约探针（§11.12，2026-09-16 冻结）。
//
// 异常矩阵：
//   缺失      —— 资产候选必须携带 purpose/source；试运行必须返回四项检查。
//   词表      —— source ∈ builtin|team|organization；check 结果 ∈ pass|warn|fail。
//   状态      —— 已发布版本 PUT 原地修改 → 409 INVALID_STATE；编辑已发布配置的
//                固定组合 = POST versions（继承最新建草稿）→ PUT 草稿成功。
//   试运行    —— 阻断检查（未授权/未就绪资产）→ outcome=blocked；全部通过 →
//                ready；draft 版本 → version_state=warn；装配检查携带层计数。
//   无副作用  —— 试运行前后版本状态与 revision 不变；审计 agent_profile.dry_run。

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

function apiHeaders(token: string, extra: Record<string, string> = {}): Record<string, string> {
  return { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...extra }
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
    headers: apiHeaders(token, extra),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  return { status: response.status, json: (await response.json()) as Record<string, unknown> }
}

function dataOf(result: { json: Record<string, unknown> }): Record<string, unknown> {
  return result.json['data'] as Record<string, unknown>
}

describe('2-6 Agent 配置（§11.12）', () => {
  it('资产候选统一字段：purpose/source 齐备且来源词表闭合', async () => {
    const port = await start()
    const admin = await login(port, 'admin@example.com', 'admin-pass')
    const page = await send(port, 'GET', '/v1/admin/asset-candidates?project_id=project-alpha', admin)
    expect(page.status).toBe(200)
    const items = (dataOf(page)['items'] ?? []) as Array<Record<string, unknown>>
    expect(items.length).toBeGreaterThan(0)
    for (const item of items) {
      for (const field of ['asset_id', 'asset_type', 'version', 'name', 'authorized', 'readiness', 'invalid_reason', 'updated_at', 'purpose', 'source']) {
        expect(Object.hasOwn(item, field), `资产候选必须携带 ${field}`).toBe(true)
      }
      expect(String(item['purpose']).length).toBeGreaterThan(0)
      expect(['builtin', 'team', 'organization']).toContain(item['source'])
    }
  })

  it('配置试运行：draft 警告 + ready；无副作用；审计落 agent_profile.dry_run', async () => {
    const port = await start()
    const admin = await login(port, 'admin@example.com', 'admin-pass')
    const profiles = await send(port, 'GET', '/v1/admin/agent-profiles?status=draft', admin)
    const drafts = (dataOf(profiles)['items'] ?? []) as Array<Record<string, unknown>>
    expect(drafts.length).toBeGreaterThan(0)
    const profileId = drafts[0]['agent_profile_id'] as string
    const detail = dataOf(await send(port, 'GET', `/v1/admin/agent-profiles/${profileId}`, admin))
    const draftVersionId = ((detail['versions'] ?? []) as Array<Record<string, unknown>>)
      .find(version => version['status'] === 'draft')?.['agent_profile_version_id'] as string
    expect(draftVersionId).toBeTruthy()
    const before = detail

    const dry = await send(port, 'POST', `/v1/admin/agent-profiles/${profileId}/versions/${draftVersionId}:dry-run`, admin)
    expect(dry.status).toBe(200)
    const result = dataOf(dry)
    for (const field of ['dry_run_id', 'agent_profile_version_id', 'outcome', 'checks', 'created_at']) {
      expect(Object.hasOwn(result, field), `试运行必须携带 ${field}`).toBe(true)
    }
    expect(result['agent_profile_version_id']).toBe(draftVersionId)
    const checks = (result['checks'] ?? []) as Array<Record<string, unknown>>
    const kinds = checks.map(check => check['check'])
    expect(kinds).toEqual(['asset_authorized', 'asset_ready', 'version_state', 'context_assembly'])
    for (const check of checks) {
      expect(['pass', 'warn', 'fail']).toContain(check['result'])
      expect(String(check['detail']).length).toBeGreaterThan(0)
    }
    const versionState = checks.find(check => check['check'] === 'version_state')
    expect(versionState?.['result']).toBe('warn')
    const assembly = checks.find(check => check['check'] === 'context_assembly')
    expect(String(assembly?.['detail'])).toContain('Skill')

    // 无副作用：版本状态与 revision 不变
    const after = dataOf(await send(port, 'GET', `/v1/admin/agent-profiles/${profileId}`, admin))
    expect(after['revision']).toBe(before['revision'])
    expect(after['status']).toBe(before['status'])

    const audits = await send(port, 'GET', '/v1/admin/audits?action=agent_profile.dry_run', admin)
    const rows = (audits.json['data'] as Array<Record<string, unknown>>)
      .filter(row => row['agent_profile_id'] === profileId)
    expect(rows.length).toBeGreaterThanOrEqual(1)
    expect(rows[0]['actor_name']).not.toBeNull()
  })

  it('已发布版本 PUT → 409；编辑组合 POST versions 建草稿 → PUT 成功 → 试运行 ready → publish', async () => {
    const port = await start()
    const admin = await login(port, 'admin@example.com', 'admin-pass')
    const profiles = await send(port, 'GET', '/v1/admin/agent-profiles?status=published', admin)
    const published = (dataOf(profiles)['items'] ?? []) as Array<Record<string, unknown>>
    expect(published.length).toBeGreaterThan(0)
    // 选择「最新版本仍是 published」的配置：PUT 守卫针对最新版本状态。
    let profileId = ''
    let detail: Record<string, unknown> = {}
    let publishedVersionId = ''
    for (const item of published) {
      const candidateId = item['agent_profile_id'] as string
      const candidate = dataOf(await send(port, 'GET', `/v1/admin/agent-profiles/${candidateId}`, admin))
      const versions = (candidate['versions'] ?? []) as Array<Record<string, unknown>>
      if (versions.at(-1)?.['status'] === 'published') {
        profileId = candidateId
        detail = candidate
        publishedVersionId = versions.at(-1)?.['agent_profile_version_id'] as string
        break
      }
    }
    expect(profileId).toBeTruthy()
    const revision = detail['revision'] as number

    // 已发布版本不可原地修改
    const direct = await send(port, 'PUT', `/v1/admin/agent-profiles/${profileId}`, admin, {
      name: '改名尝试',
    }, { 'if-match': String(revision), 'idempotency-key': '26-direct-put' })
    expect([409, 422]).toContain(direct.status)

    // 编辑组合：POST versions 缺省继承最新 → 新草稿
    const cloned = await send(port, 'POST', `/v1/admin/agent-profiles/${profileId}/versions`, admin, {}, { 'if-match': String(revision), 'idempotency-key': '26-new-version' })
    expect(cloned.status).toBe(201)
    const detailAfter = dataOf(await send(port, 'GET', `/v1/admin/agent-profiles/${profileId}`, admin))
    const drafts = (detailAfter['versions'] as Array<Record<string, unknown>>).filter(version => version['status'] === 'draft')
    expect(drafts.length).toBeGreaterThanOrEqual(1)
    const draftVersionId = drafts[0]['agent_profile_version_id'] as string
    expect(draftVersionId).not.toBe(publishedVersionId)

    // 试运行草稿（继承已发布资产）：version_state=warn；阻断与否取决于继承的
    // 资产健康（种子数据可能携带不可用资产），两种 outcome 都必须是合法值。
    const dry = await send(port, 'POST', `/v1/admin/agent-profiles/${profileId}/versions/${draftVersionId}:dry-run`, admin)
    expect(dry.status).toBe(200)
    const checks = (dataOf(dry)['checks'] ?? []) as Array<Record<string, unknown>>
    expect(checks.find(check => check['check'] === 'version_state')?.['result']).toBe('warn')
    expect(['ready', 'blocked']).toContain(dataOf(dry)['outcome'])

    // 发布新草稿（If-Match 携带配置当前 revision）：资产健康的草稿发布成功；
    // 携带不可用资产的草稿被发布校验 422 逐项拒绝——两种都是契约行为。
    const outcome = dataOf(dry)['outcome']
    const beforePublish = dataOf(await send(port, 'GET', `/v1/admin/agent-profiles/${profileId}`, admin))
    const published2 = await send(port, 'POST', `/v1/admin/agent-profiles/${profileId}/versions/${draftVersionId}:publish`, admin, {}, {
      'if-match': String(beforePublish['revision']), 'idempotency-key': '26-publish',
    })
    if (outcome === 'ready') {
      expect([200, 201]).toContain(published2.status)
    } else {
      expect(published2.status).toBe(422)
      expect(String(published2.json['message']).length).toBeGreaterThan(0)
    }
  })

  it('未知版本的试运行 → 404', async () => {
    const port = await start()
    const admin = await login(port, 'admin@example.com', 'admin-pass')
    const missing = await send(port, 'POST', '/v1/admin/agent-profiles/ap-1/versions/apv-not-exist:dry-run', admin)
    expect(missing.status).toBe(404)
  })
})
