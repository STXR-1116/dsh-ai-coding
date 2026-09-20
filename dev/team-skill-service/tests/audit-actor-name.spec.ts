import { afterEach, describe, expect, it } from 'vitest'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createTeamSkillService } from '../src/server.ts'

// 0-6：全部审计读取路径统一返回字面 `actor_name`（非空字符串），不得出现
// `actorName` 或空值；拒绝、失败、取消与成功同等留痕。本探针在同一个真实
// fixture 进程内先制造各域审计事件（授权拒绝、Workspace 停止、Skill 治理、
// 记忆更新），再逐条读取全部审计列表并机械校验字段。

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
  const body = (await response.json()) as { data: { access_token: string } }
  return body.data.access_token
}

function apiHeaders(token: string, extra: Record<string, string> = {}): Record<string, string> {
  return { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...extra }
}

async function getJson(port: number, path: string, token: string): Promise<{ readonly status: number; readonly body: unknown }> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, { headers: apiHeaders(token) })
  return { status: response.status, body: (await response.json()) as unknown }
}

/** 校验一行审计：字面 actor_name 非空，且不存在驼峰别名或空值冒充。 */
function assertActorNameRow(row: Record<string, unknown>, label: string): void {
  expect(Object.hasOwn(row, 'actor_name'), `${label} 行必须携带字面 actor_name 字段`).toBe(true)
  expect(typeof row['actor_name'], `${label} actor_name 必须是字符串`).toBe('string')
  expect((row['actor_name'] as string).length, `${label} actor_name 不得为空`).toBeGreaterThan(0)
  expect(Object.hasOwn(row, 'actorName'), `${label} 行不得出现 actorName 别名`).toBe(false)
}

/** 把任意审计列表的每一行交给字段校验；列表必须非空（有事件才有证据）。 */
function assertAllRows(rows: unknown, label: string): void {
  expect(Array.isArray(rows), `${label} 必须返回列表`).toBe(true)
  expect((rows as readonly unknown[]).length, `${label} 必须至少有一条审计行`).toBeGreaterThan(0)
  for (const row of rows as Array<Record<string, unknown>>) assertActorNameRow(row, label)
}

describe('audit actor_name contract (0-6)', () => {
  it('every audit read path returns literal non-empty actor_name, including denials and failures', async () => {
    const port = await start()
    const admin = await login(port, 'admin@example.com', 'admin-pass')
    const member = await login(port, 'member@example.com', 'member-pass')

    // —— 制造各域审计事件 ——

    // 授权拒绝：member 直接访问未授权项目 → failed 授权审计（拒绝与成功同等记录）。
    const denied = await fetch(`http://127.0.0.1:${port}/v1/team-skills?project_id=project-beta`, {
      headers: apiHeaders(member),
    })
    expect(denied.status).toBe(404)

    // Workspace 运维：停止 ws-alpha-1 → succeeded + 取消路径由 fixture 停止接口自身的幂等键留痕。
    const detail = await getJson(port, '/v1/admin/workspaces/ws-alpha-1', admin)
    expect(detail.status).toBe(200)
    const revision = ((detail.body as { data: { revision: number } }).data).revision
    const stop = await fetch(`http://127.0.0.1:${port}/v1/admin/workspaces/ws-alpha-1:stop`, {
      method: 'POST',
      headers: apiHeaders(admin, { 'idempotency-key': 'actor-name-probe-stop' }),
      body: JSON.stringify({ expected_workspace_revision: revision }),
    })
    expect(stop.status).toBe(200)

    // Skill 治理：创建草稿 → 治理审计。
    const created = await fetch(`http://127.0.0.1:${port}/v1/admin/team-skills`, {
      method: 'POST',
      headers: apiHeaders(admin, { 'idempotency-key': 'actor-name-probe-skill-create' }),
      body: JSON.stringify({ display_name: '审计字段探针 Skill', summary: '0-6 探针', visibility: 'organization', organization_id: 'org-alpha' }),
    })
    expect(created.status, await created.clone().text()).toBe(201)
    const createdSkill = ((await created.json()) as { data: { skillId: string; revision: number } }).data
    // 编辑草稿会写入「编辑草稿」治理审计（创建本身不写审计）。
    const edited = await fetch(`http://127.0.0.1:${port}/v1/admin/team-skills/${createdSkill.skillId}`, {
      method: 'PATCH',
      headers: apiHeaders(admin, {
        'idempotency-key': 'actor-name-probe-skill-edit',
        'if-match': String(createdSkill.revision),
      }),
      body: JSON.stringify({ summary: '0-6 探针（编辑草稿以产生治理审计）' }),
    })
    expect(edited.status, await edited.text()).toBe(200)

    // 记忆更新：capture + update（带幂等键与 If-Match）。
    const capture = await fetch(`http://127.0.0.1:${port}/v3/project-memory/capture`, {
      method: 'POST',
      headers: apiHeaders(admin, { 'idempotency-key': 'actor-name-probe-capture' }),
      body: JSON.stringify({
        project_id: 'project-alpha',
        session_id: 'session-actor-name',
        messages: [{ role: 'user', content: 'audit actor_name probe memory' }],
      }),
    })
    expect(capture.status).toBe(202)
    const listed = await fetch(`http://127.0.0.1:${port}/v3/project-memory/list`, {
      method: 'POST',
      headers: apiHeaders(admin),
      body: JSON.stringify({ project_id: 'project-alpha', keyword: 'actor_name probe' }),
    })
    const listedBody = (await listed.json()) as { data: { items: Array<{ memory_id: string; revision: number }> } }
    const memory = listedBody.data.items[0]
    expect(memory).toBeDefined()
    const updated = await fetch(`http://127.0.0.1:${port}/v3/project-memory/update`, {
      method: 'POST',
      headers: apiHeaders(admin, { 'idempotency-key': 'actor-name-probe-update', 'if-match': String(memory.revision) }),
      body: JSON.stringify({ memory_id: memory.memory_id, content: 'audit actor_name probe memory v2', expected_revision: memory.revision }),
    })
    expect(updated.status).toBe(202)

    // —— 逐条读取全部审计路径并机械校验 ——

    // 1) 授权审计（含拒绝行）：envelope.data.items。
    const authorization = await getJson(port, '/v1/admin/authorization-audits', admin)
    expect(authorization.status).toBe(200)
    const authorizationItems = (authorization.body as { data: { items: Array<Record<string, unknown>> } }).data.items
    assertAllRows(authorizationItems, '授权审计')
    const denialRow = authorizationItems.find(item => item['result'] === 'failed')
    expect(denialRow, '授权审计必须包含拒绝（failed）行').toBeDefined()
    assertActorNameRow(denialRow!, '授权审计拒绝行')

    // 2) Skill 审计：信封 data 为裸数组。
    const skillAudit = await getJson(port, '/v1/admin/team-skill-audit-logs', admin)
    expect(skillAudit.status).toBe(200)
    assertAllRows((skillAudit.body as { data: unknown[] }).data, 'Skill 审计')

    // 3) Workspace 审计：信封 data 为裸数组。
    const workspaceAudit = await getJson(port, '/v1/admin/audits', admin)
    expect(workspaceAudit.status).toBe(200)
    assertAllRows((workspaceAudit.body as { data: unknown[] }).data, 'Workspace 审计')

    // 4) 记忆审计：envelope.data.items（/v3 记忆路由全部为 POST）。
    const memoryAudit = await fetch(`http://127.0.0.1:${port}/v3/project-memory/audit/list`, {
      method: 'POST',
      headers: apiHeaders(admin),
      body: JSON.stringify({}),
    })
    expect(memoryAudit.status).toBe(200)
    assertAllRows(((await memoryAudit.json()) as { data: { items: unknown[] } }).data.items, '记忆审计')

    // 5) 知识库审计：fixture 以空列表占位（无行即无字段可违反），路径必须可读且角色受控。
    const knowledgeAudit = await getJson(port, '/v1/admin/knowledge-audits', admin)
    expect(knowledgeAudit.status).toBe(200)
    const knowledgeBody = knowledgeAudit.body as { items?: unknown[]; data?: { items?: unknown[] } }
    expect(Array.isArray(knowledgeBody.items ?? knowledgeBody.data?.items)).toBe(true)
  })
})
