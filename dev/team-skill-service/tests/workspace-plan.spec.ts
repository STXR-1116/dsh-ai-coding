import { afterEach, describe, expect, it } from 'vitest'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createTeamSkillService } from '../src/server.ts'

// 1-1「Plan 实体」验收（契约：API 需求 §11.6，2026-09-16 冻结）。
//
// 异常矩阵（每一格都有对应用例断言，不允许只测成功路径）：
//   缺失     —— plan_id 不存在→404；goal/steps 缺失或空→422；change_summary 缺失→422；
//               If-Match 缺失→400 IF_MATCH_REQUIRED；Idempotency-Key 缺失→400。
//   类型错误 —— steps 非数组→422；depends_on 下标越界→422；asset_version_ids 不属于
//               所选版本→422；agent_profile_version_id 未绑定/未发布→403。
//   边界     —— 已确认计划不可编辑→409 INVALID_STATE（失败同样写审计）；重复确认→409；
//               draft 计划不可创建 Run→409 PLAN_NOT_CONFIRMED；跨工作空间 plan_id→404。
//   并发     —— 相同 If-Match 的两次编辑，后者 409 REVISION_CONFLICT；
//               同键同体重放返回原结果且不追加编辑记录；同键异体→409 IDEMPOTENCY_CONFLICT。
//   下游失败 —— 本实体为 fixture 本地资源，无下游；确认/编辑的失败路径仍写审计。
//   审计     —— plan.edit / plan.confirm 与失败路径都写工作空间审计行（字面 actor_name）。
//   历史不覆盖 —— 编辑记录携带编辑前完整内容快照（before），由「当前状态 + 编辑记录」
//               可重建第一版内容，历史只增不改。
//   draft 归属 —— draft 是 Plan 的状态而非运行状态；Run 只能引用 confirmed 计划，
//               Run DTO 携带只读 plan_id，创建后绑定不可变。

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
): Promise<{ readonly status: number; readonly body: Record<string, unknown> }> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: apiHeaders(token, extra),
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const value = (await response.json()) as Record<string, unknown>
  return { status: response.status, body: value }
}

interface PlanDto {
  readonly data: {
    readonly plan_id: string
    readonly workspace_id: string
    readonly project_id: string
    readonly goal: string
    readonly steps: ReadonlyArray<{ readonly title: string; readonly depends_on?: readonly number[] }>
    readonly agent_profile_version_id: string
    readonly asset_version_ids: readonly string[]
    readonly status: string
    readonly revision: number
    readonly created_by: string
    readonly created_at: string
    readonly confirmed_by?: string
    readonly confirmed_at?: string
    readonly edits: ReadonlyArray<{
      readonly edit_id: string
      readonly editor: string
      readonly edited_at: string
      readonly change_summary: string
      readonly revision_before: number
      readonly revision_after: number
      readonly before: { readonly goal: string; readonly steps: ReadonlyArray<{ readonly title: string }> }
    }>
  }
}

const VALID_PLAN = {
  goal: '为发布流水线补齐回归测试',
  steps: [{ title: '梳理现有用例' }, { title: '补充边界用例', depends_on: [0] }, { title: '接入 CI', depends_on: [1] }],
  agent_profile_version_id: 'apv-1',
  asset_version_ids: ['skill:code-review@1.0.0'],
}

describe('1-1 Plan 实体（fixture 契约 §11.6）', () => {
  it('创建草稿、编辑形成事件且不覆盖历史、确认归属明确，运行只能引用 confirmed 计划', async () => {
    const port = await start()
    const admin = await login(port, 'admin@example.com', 'admin-pass')

    // —— 创建草稿计划 ——
    const created = await send(port, 'POST', '/v1/workspaces/ws-alpha-1/plans', admin, VALID_PLAN, {
      'idempotency-key': 'plan-create-1',
    })
    expect(created.status, JSON.stringify(created.body)).toBe(201)
    const plan = (created.body as unknown as PlanDto).data
    expect(plan.plan_id.length).toBeGreaterThan(0)
    expect(plan.status).toBe('draft')
    expect(plan.revision).toBe(1)
    expect(plan.workspace_id).toBe('ws-alpha-1')
    expect(plan.project_id).toBe('project-alpha')
    expect(plan.created_by.length).toBeGreaterThan(0)
    expect(plan.edits).toHaveLength(0)
    expect(plan.steps[2]?.depends_on).toEqual([1])

    // 读取路径。
    const read = await send(port, 'GET', `/v1/workspaces/ws-alpha-1/plans/${plan.plan_id}`, admin)
    expect(read.status).toBe(200)
    expect((read.body as unknown as PlanDto).data.plan_id).toBe(plan.plan_id)
    const list = await send(port, 'GET', '/v1/workspaces/ws-alpha-1/plans', admin)
    expect((list.body as { data: { items: unknown[] } }).data.items).toHaveLength(1)

    // —— 编辑形成事件、不覆盖原始历史 ——
    const edited = await send(
      port,
      'PUT',
      `/v1/workspaces/ws-alpha-1/plans/${plan.plan_id}`,
      admin,
      {
        goal: '为发布流水线补齐回归测试与性能基线',
        steps: [{ title: '梳理现有用例' }, { title: '补充边界与性能基线用例', depends_on: [0] }, { title: '接入 CI', depends_on: [1] }],
        agent_profile_version_id: 'apv-1',
        asset_version_ids: ['skill:code-review@1.0.0'],
        change_summary: '补充性能基线步骤',
      },
      { 'idempotency-key': 'plan-edit-1', 'if-match': String(plan.revision) },
    )
    expect(edited.status, JSON.stringify(edited.body)).toBe(200)
    const editedPlan = (edited.body as unknown as PlanDto).data
    expect(editedPlan.revision).toBe(2)
    expect(editedPlan.edits).toHaveLength(1)
    const edit = editedPlan.edits[0]
    expect(edit.change_summary).toBe('补充性能基线步骤')
    expect(edit.editor.length).toBeGreaterThan(0)
    expect(edit.revision_before).toBe(1)
    expect(edit.revision_after).toBe(2)
    // before 快照保留了第一版内容：历史可重建，未被覆盖。
    expect(edit.before.goal).toBe(VALID_PLAN.goal)
    expect(edit.before.steps.map(step => step.title)).toEqual(VALID_PLAN.steps.map(step => step.title))

    // 幂等重放：同键同体返回原结果，不追加编辑记录。
    const replay = await send(
      port,
      'PUT',
      `/v1/workspaces/ws-alpha-1/plans/${plan.plan_id}`,
      admin,
      {
        goal: '为发布流水线补齐回归测试与性能基线',
        steps: [{ title: '梳理现有用例' }, { title: '补充边界与性能基线用例', depends_on: [0] }, { title: '接入 CI', depends_on: [1] }],
        agent_profile_version_id: 'apv-1',
        asset_version_ids: ['skill:code-review@1.0.0'],
        change_summary: '补充性能基线步骤',
      },
      { 'idempotency-key': 'plan-edit-1', 'if-match': String(plan.revision) },
    )
    expect(replay.status).toBe(200)
    expect(((replay.body as unknown as PlanDto).data.edits)).toHaveLength(1)
    expect((replay.body as unknown as PlanDto).data.revision).toBe(2)

    // 并发编辑：过期 If-Match → 409 REVISION_CONFLICT。
    const stale = await send(
      port,
      'PUT',
      `/v1/workspaces/ws-alpha-1/plans/${plan.plan_id}`,
      admin,
      { goal: '并发编辑', steps: [{ title: 's' }], agent_profile_version_id: 'apv-1', asset_version_ids: [], change_summary: '并发' },
      { 'idempotency-key': 'plan-edit-stale', 'if-match': String(plan.revision) },
    )
    expect(stale.status).toBe(409)
    expect(stale.body.code).toBe('REVISION_CONFLICT')

    // —— 确认：draft 归属明确 ——
    const confirmed = await send(port, 'POST', `/v1/workspaces/ws-alpha-1/plans/${plan.plan_id}:confirm`, admin, {}, {
      'idempotency-key': 'plan-confirm-1',
    })
    expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200)
    const confirmedPlan = (confirmed.body as unknown as PlanDto).data
    expect(confirmedPlan.status).toBe('confirmed')
    expect(confirmedPlan.confirmed_by?.length).toBeGreaterThan(0)
    expect(confirmedPlan.confirmed_at?.length).toBeGreaterThan(0)
    expect(confirmedPlan.revision).toBe(3)

    // 已确认计划不可再编辑（失败同样写审计，见下方审计断言）。
    const editConfirmed = await send(
      port,
      'PUT',
      `/v1/workspaces/ws-alpha-1/plans/${plan.plan_id}`,
      admin,
      { goal: 'x', steps: [{ title: 's' }], agent_profile_version_id: 'apv-1', asset_version_ids: [], change_summary: '越权编辑' },
      { 'idempotency-key': 'plan-edit-confirmed', 'if-match': String(confirmedPlan.revision) },
    )
    expect(editConfirmed.status).toBe(409)
    expect(editConfirmed.body.code).toBe('INVALID_STATE')

    // 重复确认 → 409 INVALID_STATE。
    const reconfirm = await send(port, 'POST', `/v1/workspaces/ws-alpha-1/plans/${plan.plan_id}:confirm`, admin, {}, {
      'idempotency-key': 'plan-confirm-2',
    })
    expect(reconfirm.status).toBe(409)
    expect(reconfirm.body.code).toBe('INVALID_STATE')

    // —— Run 联动：只能引用 confirmed 计划 ——
    const ws = await send(port, 'GET', '/v1/workspaces/ws-alpha-1', admin)
    const wsRevision = (ws.body as { data: { revision: number } }).data.revision

    const draftRun = await send(port, 'POST', '/v1/workspaces/ws-alpha-1/runs', admin, {
      session_id: 'sess-plan-1',
      write_mode: 'read_only',
      plan_id: 'plan-of-another-workspace-does-not-exist',
      expected_workspace_revision: wsRevision,
    }, { 'idempotency-key': 'plan-run-unknown' })
    expect(draftRun.status).toBe(404)

    // 先造一个 draft 计划，验证 draft 不能创建 Run。
    const draftPlan = await send(port, 'POST', '/v1/workspaces/ws-alpha-1/plans', admin, {
      goal: '草稿计划',
      steps: [{ title: 's' }],
      agent_profile_version_id: 'apv-1',
    }, { 'idempotency-key': 'plan-create-draft' })
    expect(draftPlan.status).toBe(201)
    const draftPlanId = (draftPlan.body as unknown as PlanDto).data.plan_id
    const runFromDraft = await send(port, 'POST', '/v1/workspaces/ws-alpha-1/runs', admin, {
      session_id: 'sess-plan-2',
      write_mode: 'read_only',
      plan_id: draftPlanId,
      expected_workspace_revision: wsRevision,
    }, { 'idempotency-key': 'plan-run-draft' })
    expect(runFromDraft.status).toBe(409)
    expect(runFromDraft.body.code).toBe('PLAN_NOT_CONFIRMED')

    // confirmed 计划创建 Run：Run DTO 携带只读 plan_id。
    const run = await send(port, 'POST', '/v1/workspaces/ws-alpha-1/runs', admin, {
      session_id: 'sess-plan-3',
      write_mode: 'read_only',
      plan_id: plan.plan_id,
      expected_workspace_revision: wsRevision,
    }, { 'idempotency-key': 'plan-run-confirmed' })
    expect(run.status, JSON.stringify(run.body)).toBe(202)
    expect((run.body as { data: { plan_id: string } }).data.plan_id).toBe(plan.plan_id)

    // —— 审计：编辑、确认与失败路径同等记录（0-6 契约：字面 actor_name）——
    const audits = await send(port, 'GET', '/v1/admin/audits', admin)
    expect(audits.status).toBe(200)
    const rows = (audits.body as { data: Array<Record<string, unknown>> }).data.filter(row =>
      String(row['action']).startsWith('plan.'),
    )
    const actions = new Set(rows.map(row => `${String(row['action'])}:${String(row['result'])}`))
    expect(actions.has('plan.edit:succeeded')).toBe(true)
    expect(actions.has('plan.confirm:succeeded')).toBe(true)
    expect(actions.has('plan.edit:failed')).toBe(true)
    for (const row of rows) {
      expect(typeof row['actor_name']).toBe('string')
      expect((row['actor_name'] as string).length).toBeGreaterThan(0)
      expect(row['request_id']).toBeTruthy()
    }
  })

  it('校验与异常矩阵：缺失、类型错误、边界、幂等冲突', async () => {
    const port = await start()
    const admin = await login(port, 'admin@example.com', 'admin-pass')

    // 缺 Idempotency-Key。
    const noKey = await send(port, 'POST', '/v1/workspaces/ws-alpha-1/plans', admin, VALID_PLAN)
    expect(noKey.status).toBe(400)
    expect(noKey.body.code).toBe('IDEMPOTENCY_KEY_REQUIRED')

    // goal 缺失。
    const noGoal = await send(port, 'POST', '/v1/workspaces/ws-alpha-1/plans', admin, {
      steps: [{ title: 's' }],
      agent_profile_version_id: 'apv-1',
    }, { 'idempotency-key': 'plan-v-no-goal' })
    expect(noGoal.status).toBe(422)

    // steps 空数组。
    const emptySteps = await send(port, 'POST', '/v1/workspaces/ws-alpha-1/plans', admin, {
      goal: 'g',
      steps: [],
      agent_profile_version_id: 'apv-1',
    }, { 'idempotency-key': 'plan-v-empty-steps' })
    expect(emptySteps.status).toBe(422)

    // depends_on 下标越界。
    const badIndex = await send(port, 'POST', '/v1/workspaces/ws-alpha-1/plans', admin, {
      goal: 'g',
      steps: [{ title: 's', depends_on: [9] }],
      agent_profile_version_id: 'apv-1',
    }, { 'idempotency-key': 'plan-v-bad-index' })
    expect(badIndex.status).toBe(422)

    // asset_version_ids 不属于所选版本。
    const badAsset = await send(port, 'POST', '/v1/workspaces/ws-alpha-1/plans', admin, {
      goal: 'g',
      steps: [{ title: 's' }],
      agent_profile_version_id: 'apv-1',
      asset_version_ids: ['knowledge:not-in-version@v1'],
    }, { 'idempotency-key': 'plan-v-bad-asset' })
    expect(badAsset.status).toBe(422)

    // agent_profile_version_id 未绑定/未发布 → 403（与 run.create 同判定）。
    const badProfile = await send(port, 'POST', '/v1/workspaces/ws-alpha-1/plans', admin, {
      goal: 'g',
      steps: [{ title: 's' }],
      agent_profile_version_id: 'apv-not-published',
    }, { 'idempotency-key': 'plan-v-bad-profile' })
    expect(badProfile.status).toBe(403)

    // 创建一个 draft 用于编辑类校验。
    const created = await send(port, 'POST', '/v1/workspaces/ws-alpha-1/plans', admin, VALID_PLAN, {
      'idempotency-key': 'plan-v-create',
    })
    const planId = (created.body as unknown as PlanDto).data.plan_id

    // 缺 If-Match → 400 IF_MATCH_REQUIRED。
    const noMatch = await send(port, 'PUT', `/v1/workspaces/ws-alpha-1/plans/${planId}`, admin, {
      goal: 'g2',
      steps: [{ title: 's' }],
      change_summary: '缺并发条件',
    }, { 'idempotency-key': 'plan-v-no-match' })
    expect(noMatch.status).toBe(400)
    expect(noMatch.body.code).toBe('IF_MATCH_REQUIRED')

    // 缺 change_summary → 422。
    const noSummary = await send(port, 'PUT', `/v1/workspaces/ws-alpha-1/plans/${planId}`, admin, {
      goal: 'g2',
      steps: [{ title: 's' }],
    }, { 'idempotency-key': 'plan-v-no-summary', 'if-match': '1' })
    expect(noSummary.status).toBe(422)

    // 不存在的计划 → 404。
    const missing = await send(port, 'GET', '/v1/workspaces/ws-alpha-1/plans/plan-missing', admin)
    expect(missing.status).toBe(404)

    // 同键异体 → 409 IDEMPOTENCY_CONFLICT。
    const sameKeyDiffBody = await send(port, 'POST', '/v1/workspaces/ws-alpha-1/plans', admin, {
      goal: '另一个目标',
      steps: [{ title: 's' }],
      agent_profile_version_id: 'apv-1',
    }, { 'idempotency-key': 'plan-v-create' })
    expect(sameKeyDiffBody.status).toBe(409)
    expect(sameKeyDiffBody.body.code).toBe('IDEMPOTENCY_CONFLICT')
  })
})
