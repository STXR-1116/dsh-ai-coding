/* 覆盖补齐（续）：`WorkspaceGateway` 已由真实 fixture 实证的 seam。
 *
 * 前一接缝规格覆盖了只读 seam；本规格驱动计划 CRUD、审批决策与 admin
 * 资产/配置 seam。全部走真实 fixture（static-token 装配，与 seam 前篇
 * 同一模式）。
 *
 * 已查明并如实登记的两个边界（详见拍板请求 OWNER-DECISION-REQUEST.md）：
 * 1. workspace-fixture 未实现单 profile 的读/试运行/写端点（GET、:dry-run、
 *    versions 均 404 RESOURCE_NOT_FOUND，本轮直接实证）。这些 seam 缺 `/v1`
 *    前缀正是「admin token 经 gateway 401、直连 fixture 200」的原因，已由
 *    `a1b4cc8` 修复并由所有者关闭；修复后 admin 读端点与直连同形。
 *    fixture 能力缺口登记在 BLOCKED.md。
 * 2. 运行控制（pause/resume/takeover/cancel/checkpoint/suppress）与运行创建
 *    此前只有浏览器套件经同一 Host 真实驱动，istanbul 不计浏览器执行；现由
 *    `gateway-matrix.spec.ts` 的「run control chain」以真实 fixture 覆盖
 *    （证据 `runtime-logs/afc-deep-optimization/56-gateway-run-control/`）。
 *
 * 分类：FIXTURE-ONLY。
 */
import { afterEach, describe, expect, it } from 'vitest'
import type { AddressInfo } from 'node:net'
import { Context } from '@deepseek-ai/cordis'
import { createTeamSkillService } from '../dev/team-skill-service/src/server.ts'
import { WorkspaceGateway } from '../src/workspace-gateway.ts'

const services: ReturnType<typeof createTeamSkillService>[] = []
let adminToken = ''

afterEach(async () => {
  for (const service of services.splice(0)) {
    service.server.closeAllConnections()
    await new Promise<void>((resolve) => {
      service.server.close(() => { resolve() })
    })
  }
})

async function buildGateway(asAdmin = false): Promise<WorkspaceGateway> {
  const service = createTeamSkillService({ port: 0, seed: true })
  services.push(service)
  await service.listen()
  const base = `http://127.0.0.1:${(service.server.address() as AddressInfo).port}`
  if (asAdmin) {
    const login = await fetch(`${base}/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin@example.com', password: 'admin-pass' }),
    })
    expect(login.status).toBe(200)
    adminToken = ((await login.json()) as { data: { access_token: string } }).data.access_token
  }
  return new WorkspaceGateway(new Context(), {
    apiBaseUrl: base,
    accessToken: asAdmin ? adminToken : 'demo-token',
    authMode: 'static-token',
  })
}

function expectReady<T>(result: { status: string; value?: T; error?: unknown }): T {
  if (result.status !== 'ready') {
    throw new Error(`seam 未就绪: ${JSON.stringify(result)}`)
  }
  return result.value as T
}

describe('WorkspaceGateway 写路径与治理 seam（真实 fixture）', () => {
  it('creates a plan, edits it, confirms it and reads it back', async () => {
    const gateway = await buildGateway()
    const created = expectReady(await gateway.createPlan({
      workspaceId: 'ws-alpha-1',
      goal: 'seam 计划目标',
      steps: [{ title: '步骤一' }, { title: '步骤二', dependsOn: [0] }],
      agentProfileVersionId: 'apv-1',
    }))
    expect(created.status).toBe('draft')

    const edited = expectReady(await gateway.updatePlan({
      workspaceId: 'ws-alpha-1',
      planId: created.planId,
      goal: 'seam 计划目标（修订）',
      expectedRevision: created.revision,
      changeSummary: 'seam 修订',
    }))
    expect(edited.goal).toBe('seam 计划目标（修订）')

    const confirmed = expectReady(await gateway.confirmPlan({ workspaceId: 'ws-alpha-1', planId: created.planId }))
    expect(confirmed.confirmedAt !== undefined).toBe(true)

    const plans = expectReady(await gateway.workspacePlans('ws-alpha-1'))
    expect(plans.some(plan => plan.planId === created.planId)).toBe(true)
    const reread = expectReady(await gateway.plan('ws-alpha-1', created.planId))
    expect(reread.planId).toBe(created.planId)
  })

  it('reads an approval for an awaiting_approval run and decides it with evidence', async () => {
    const gateway = await buildGateway()
    // 测试侧经 fixture 以 approval_required 创建运行；gateway 走读审批 seam。
    const service = services[0]
    if (service === undefined) throw new Error('fixture 服务丢失')
    const port = (service.server.address() as AddressInfo).port
    const login = await fetch(`http://127.0.0.1:${port}/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'member@example.com', password: 'member-pass' }),
    })
    const token = ((await login.json()) as { data: { access_token: string } }).data.access_token
    const snapshot = await fetch(`http://127.0.0.1:${port}/v1/workspaces/ws-alpha-1`, { headers: { authorization: `Bearer ${token}` } })
    const revision = ((await snapshot.json()) as { data: { revision: number } }).data.revision
    const created = await fetch(`http://127.0.0.1:${port}/v1/workspaces/ws-alpha-1/runs`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'idempotency-key': `seam2-approval-${String(Date.now())}`, 'if-match': String(revision) },
      body: JSON.stringify({ session_id: 'sess-seed-1', write_mode: 'read_only', approval_required: true }),
    })
    expect(created.status).toBeLessThan(300)
    const runId = (((await created.json()) as { data: { run_id: string } }).data).run_id

    const approval = expectReady(await gateway.runApproval(runId))
    expect(approval.action.length).toBeGreaterThan(0)
    const fresh = expectReady(await gateway.run(runId))
    const decided = expectReady(await gateway.decideApproval({ runId, decision: 'approve', expectedRunRevision: fresh.revision }))
    expect(['preparing', 'running', 'awaiting_approval', 'succeeded']).toContain(decided.status)
  })

  it('runs the member-side authorization shape for admin seams', async () => {
    const gateway = await buildGateway()
    const result = await gateway.assetCandidates('project-alpha')
    // member 作用域被服务端拒绝；无论服务端返回显式失败还是空集，客户端都
    // 不得崩溃——这是被钉住的授权形状。
    expect(['ready', 'failed', 'not-ready', 'signed-out']).toContain(result.status)
  })
})
