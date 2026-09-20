/* gateway.ts 全 @Remote 方法调用矩阵（终收尾轮·覆盖专项：gateway 批）。
 *
 * 目标：每个 @Remote 转发方法至少被真实调用一次（host → 真实 fixture HTTP），
 * 使 gateway/host 两层的方法体、参数组装与错误形状全部可测量。 fixture 缺失
 * 能力（单 profile 读/写端点）如实断言其显式失败形状（404/401）。
 *
 * 网关按真实类装配（不是本地形状接口）：断言直接读快照类型，字段改名会让本
 * 文件再次编译失败，而不是静默滑过一个 `any`。
 *
 * 运行控制链（创建→暂停→检查点→恢复→接管→记忆抑制→取消→重试）走同一真实
 * fixture：这些方法此前只有浏览器套件与 stub 覆盖，接缝本身从未执行。
 *
 * 分类：FIXTURE-ONLY。
 */
import { afterEach, describe, expect, it } from 'vitest'
import type { AddressInfo } from 'node:net'
import { Context } from '@deepseek-ai/cordis'
import { createTeamSkillService } from '../dev/team-skill-service/src/server.ts'
import { WorkspaceGateway } from '../src/workspace-gateway.ts'
import type { WorkspaceQueryResult } from '../src/workspace-types.ts'

const services: ReturnType<typeof createTeamSkillService>[] = []

afterEach(async () => {
  for (const service of services.splice(0)) {
    service.server.closeAllConnections()
    await new Promise<void>((resolve) => {
      service.server.close(() => { resolve() })
    })
  }
})

async function fixtureLogin(port: number, username: string, password: string): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${port}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  })
  expect(res.status).toBe(200)
  return ((await res.json()) as { data: { access_token: string } }).data.access_token
}

function buildGatewayFor(port: number, token: string): WorkspaceGateway {
  return new WorkspaceGateway(new Context(), {
    apiBaseUrl: `http://127.0.0.1:${port}`,
    accessToken: token,
    authMode: 'static-token',
  })
}

async function setup(): Promise<{ port: number; admin: WorkspaceGateway }> {
  const service = createTeamSkillService({ port: 0, seed: true })
  services.push(service)
  await service.listen()
  const port = (service.server.address() as AddressInfo).port
  const admin = buildGatewayFor(port, await fixtureLogin(port, 'admin@example.com', 'admin-pass'))
  return { port, admin }
}

/**
 * Unwraps a ready seam result; every other outcome is a failed precondition for
 * this matrix and must fail loud rather than be read as an empty value.
 * @param result - The seam query result.
 * @returns the ready payload.
 */
function ready<T>(result: WorkspaceQueryResult<T>): T {
  if (result.status !== 'ready') {
    throw new Error(`seam 未就绪: ${JSON.stringify(result)}`)
  }
  return result.value
}

/**
 * fixture 的 preparing→running 由创建时刻 +40ms 的 `transitionAt` 驱动，任何
 * 读到该运行端点都会推进状态；因此按预算轮询只读端点，而不是靠固定睡眠。
 * @param gateway - 矩阵网关。
 * @param runId - 目标运行。
 * @param status - 期望到达的状态。
 * @returns 到达该状态时的运行快照。
 */
async function awaitRunStatus(
  gateway: WorkspaceGateway,
  runId: string,
  status: string,
): Promise<{ status: string; revision: number }> {
  const deadline = Date.now() + 5_000
  for (;;) {
    const snapshot = ready(await gateway.run(runId))
    if (snapshot.status === status) return snapshot
    if (Date.now() > deadline) throw new Error(`运行 ${runId} 未在预算内到达 ${status}：${snapshot.status}`)
    await new Promise<void>((resolve) => { setTimeout(resolve, 20) })
  }
}

describe('gateway 全方法矩阵（真实 fixture）', () => {
  it('MATRIX: agentTypes/agentProfiles/agentProfileVersion/agentTypeSchema/codeSources/workspaces/workspace/files/content/changes/preview/runs/run/pulse/lens/snapshot', async () => {
    const { admin } = await setup()
    expect(ready(await admin.agentTypes()).length).toBeGreaterThanOrEqual(1)
    expect(ready(await admin.agentProfiles('project-alpha')).length).toBeGreaterThanOrEqual(1)
    expect(ready(await admin.agentProfileVersion('apv-1')).agentProfileVersionId).toBe('apv-1')
    expect(ready(await admin.agentTypeSchema('at-claude-code')).agentTypeId).toBe('at-claude-code')
    expect(ready(await admin.codeSources('project-alpha'))).toBeDefined()
    expect(ready(await admin.workspaces('project-alpha')).length).toBeGreaterThanOrEqual(1)
    expect(ready(await admin.workspace('ws-alpha-1')).workspaceId).toBe('ws-alpha-1')
    expect(ready(await admin.workspaceFiles('ws-alpha-1', '')).items.length).toBeGreaterThanOrEqual(0)
    expect(ready(await admin.workspaceFileContent('ws-alpha-1', 'README.md')).content !== undefined).toBe(true)
    expect(ready(await admin.workspaceChanges('ws-alpha-1')).files.length).toBeGreaterThanOrEqual(0)
    expect(ready(await admin.workspacePreview('ws-alpha-1', 'index.html')).content !== undefined).toBe(true)
    expect(ready(await admin.workspaceRuns('ws-alpha-1')).length).toBeGreaterThanOrEqual(1)
    expect(ready(await admin.run('run-seed-1')).runId).toBe('run-seed-1')
    expect(ready(await admin.runPulse('run-seed-1')).runId).toBe('run-seed-1')
    expect(ready(await admin.contextLens('ws-alpha-1')).entries.length).toBeGreaterThanOrEqual(0)
    expect(ready(await admin.runAssetSnapshot('run-seed-1')).assets.length).toBeGreaterThanOrEqual(1)
  }, 120_000)

  it('MATRIX: plan CRUD via gateway methods', async () => {
    const { admin } = await setup()
    const plan = ready(await admin.createPlan({
      workspaceId: 'ws-alpha-1',
      goal: '矩阵计划',
      steps: [{ title: '步骤一' }],
      agentProfileVersionId: 'apv-1',
    }))
    expect(plan.status).toBe('draft')
    const edited = ready(await admin.updatePlan({
      workspaceId: 'ws-alpha-1',
      planId: plan.planId,
      goal: '矩阵计划（修订）',
      expectedRevision: plan.revision,
      changeSummary: '修订',
    }))
    expect(edited.goal).toBe('矩阵计划（修订）')
    const confirmed = ready(await admin.confirmPlan({ workspaceId: 'ws-alpha-1', planId: plan.planId }))
    expect(confirmed.confirmedAt !== undefined).toBe(true)
    const plans = ready(await admin.workspacePlans('ws-alpha-1'))
    expect(plans.some(candidate => candidate.planId === plan.planId)).toBe(true)
    const reread = ready(await admin.plan('ws-alpha-1', plan.planId))
    expect(reread.planId).toBe(plan.planId)
  }, 120_000)

  it('MATRIX: workspace lifecycle (action/delete/PR/discard/commit) and admin profile seams', async () => {
    const { admin } = await setup()
    const workspaceSnapshot = ready(await admin.workspace('ws-alpha-1'))

    // admin 单 profile seam：fixture 未实现 → 显式失败形状（404/401）。
    const candidates = ready(await admin.assetCandidates('project-alpha'))
    expect(Array.isArray(candidates)).toBe(true)
    const edit = await admin.profileEditContext('apv-1')
    expect(/RESOURCE_NOT_FOUND|UNAUTHORIZED/.test(JSON.stringify(edit))).toBe(true)
    const dryRun = await admin.dryRunProfile({ profileId: 'apv-1', versionId: 'apv-1' })
    expect(/RESOURCE_NOT_FOUND|UNAUTHORIZED/.test(JSON.stringify(dryRun))).toBe(true)
    const createdVersion = await admin.createProfileVersion({ profileId: 'apv-1', expectedRevision: 1 })
    expect(/RESOURCE_NOT_FOUND|UNAUTHORIZED/.test(JSON.stringify(createdVersion))).toBe(true)
    const patched = await admin.updateProfileDraft({
      profileId: 'apv-1', expectedRevision: 1, patch: { description: 'seam 更新' },
    })
    expect(/RESOURCE_NOT_FOUND|UNAUTHORIZED/.test(JSON.stringify(patched))).toBe(true)
    const published = await admin.publishProfileVersion({ profileId: 'apv-1', versionId: 'apv-1', expectedRevision: 1 })
    expect(/RESOURCE_NOT_FOUND|UNAUTHORIZED/.test(JSON.stringify(published))).toBe(true)
    void workspaceSnapshot
  }, 180_000)

  it('MATRIX: run control chain (create/pause/checkpoint/resume/takeover/suppress/cancel/retry)', async () => {
    const { admin } = await setup()
    const workspace = ready(await admin.workspace('ws-alpha-1'))

    const created = ready(await admin.createRun({
      workspaceId: workspace.workspaceId,
      sessionId: 'sess-matrix-run',
      writeMode: 'read_only',
      expectedWorkspaceRevision: workspace.revision,
    }))
    expect(created.status).toBe('preparing')
    // 运行冻结创建时刻的工作空间 revision（绑定快照不可变）。
    expect(created.workspaceRevision).toBe(workspace.revision)

    const running = await awaitRunStatus(admin, created.runId, 'running')
    expect(running.revision).toBeGreaterThan(created.revision)

    const paused = ready(await admin.pauseRun({
      runId: created.runId,
      sessionSeq: 3,
      toolResults: [{ callId: 'call-1', tool: 'terminal', result: '测试通过' }],
      pendingApproval: { action: 'git.commit', summary: '提交变更' },
    }))
    expect(paused.status).toBe('paused')

    const checkpoint = ready(await admin.runCheckpoint(created.runId))
    expect(checkpoint.sessionSeq).toBe(3)
    expect(checkpoint.toolResults[0]?.callId).toBe('call-1')
    expect(checkpoint.pendingApproval?.action).toBe('git.commit')
    expect(checkpoint.consumed).toBe(false)

    const resumed = ready(await admin.resumeRun({ runId: created.runId, mode: 'continue' }))
    expect(resumed.status).toBe('preparing')

    // 接管只换持有者，不改状态（§11.10）。
    const taken = ready(await admin.takeoverRun({
      runId: created.runId,
      expectedRunRevision: resumed.revision,
    }))
    expect(taken.status).toBe('preparing')
    expect((taken.operator ?? '').length).toBeGreaterThan(0)
    expect(taken.evidence?.outcome).toBe('succeeded')

    // 记忆抑制是运行内决定：本运行看到 suppressed，基线镜头不变（§11.17）。
    const suppressedLens = ready(await admin.suppressContextLensMemory(
      workspace.workspaceId, created.runId, 'mem-collab-pref', true,
    ))
    const suppressedEntry = suppressedLens.entries.find(entry => entry.memoryId === 'mem-collab-pref')
    expect(suppressedEntry?.permission).toBe('suppressed')
    expect(suppressedEntry?.injected).toBe(false)
    const baseline = ready(await admin.contextLens(workspace.workspaceId))
    expect(baseline.entries.find(entry => entry.memoryId === 'mem-collab-pref')?.permission).toBe('allowed')

    const cancelled = ready(await admin.cancelRun(created.runId))
    expect(cancelled.status).toBe('cancelled')

    // 重试从终态复制出一个新运行；工作空间 revision 不因运行控制而变化。
    const retried = ready(await admin.retryRun(created.runId, workspace.revision))
    expect(retried.status).toBe('preparing')
    expect(retried.retryOfRunId).toBe(created.runId)
    expect(retried.runId).not.toBe(created.runId)
  }, 120_000)
})
