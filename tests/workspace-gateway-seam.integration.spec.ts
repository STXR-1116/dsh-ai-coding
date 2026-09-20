/* 覆盖补齐：`WorkspaceGateway` 的 Remote 接缝方法。
 *
 * 与 `TeamSkillGateway` 同样的缺口——`workspace-host.integration.spec.ts` 直接驱动
 * `WorkspaceHost`（所以 host 与 workspace-http 的解析器被覆盖），而浏览器走的是
 * 上一层 gateway；插件测试用 stub remote，于是接缝方法本身从未执行
 * （workspace-gateway.ts 函数覆盖率 24%）。
 *
 * 未覆盖并如实标注：`assetCandidates` 与 `profileEditContext` / `dryRunProfile`。
 * 前者在 fixture 里挂的是 admin 作用域路由，后两者即使用 admin token 也仍返回显式
 * 失败；本轮**没有查明**是 id 形态不同还是路由差异，因此既**不写成「已覆盖」**，
 * 也**不去断言一个自己没搞懂的失败形状**——弱断言比缺覆盖更糟。
 *
 * 用 `authMode: 'static-token'` 装配：该模式下身份就是显式 token，不需要凭据插件，
 * 因此可以用一个干净的 Context 起真实 gateway，再逐个走读方法。
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

/**
 * 起 fixture 并以 static-token 身份装配真实 WorkspaceGateway。
 * @param asAdmin - 以管理员登录取 token；资产候选与 Agent 配置治理是 admin 作用域的
 *   seam，用 member token 只会拿到显式失败（这本身也是被钉住的行为之一）。
 */
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

describe('WorkspaceGateway 接缝方法（真实 fixture）', () => {
  it('lists the agent executor types with their readiness through the agentTypes seam', async () => {
    const gateway = await buildGateway()
    const result = await gateway.agentTypes()
    expect(result.status).toBe('ready')
    if (result.status !== 'ready') return
    expect(result.value.length).toBeGreaterThanOrEqual(1)
  })

  it('lists the published agent profiles through the agentProfiles seam', async () => {
    const gateway = await buildGateway()
    const result = await gateway.agentProfiles('project-alpha')
    expect(result.status).toBe('ready')
    if (result.status !== 'ready') return
    expect(result.value.length).toBeGreaterThanOrEqual(1)
    expect(result.value.every(profile => typeof profile.name === 'string' && profile.name.length > 0)).toBe(true)
  })

  it('lists the project code sources through the codeSources seam', async () => {
    const gateway = await buildGateway()
    const result = await gateway.codeSources('project-alpha')
    expect(result.status).toBe('ready')
  })

  it('lists the project workspaces through the workspaces seam', async () => {
    const gateway = await buildGateway()
    const result = await gateway.workspaces('project-alpha')
    expect(result.status).toBe('ready')
    if (result.status !== 'ready') return
    expect(result.value.some(workspace => workspace.workspaceId === 'ws-alpha-1')).toBe(true)
  })

  it('reads one workspace snapshot through the workspace seam', async () => {
    const gateway = await buildGateway()
    const result = await gateway.workspace('ws-alpha-1')
    expect(result.status).toBe('ready')
    if (result.status !== 'ready') return
    expect(result.value.workspaceId).toBe('ws-alpha-1')
  })

  it('lists a workspace directory through the workspaceFiles seam', async () => {
    const gateway = await buildGateway()
    const result = await gateway.workspaceFiles('ws-alpha-1', '')
    expect(result.status).toBe('ready')
    if (result.status !== 'ready') return
    expect(Array.isArray(result.value.items)).toBe(true)
  })

  it('reads one file through the workspaceFileContent seam', async () => {
    const gateway = await buildGateway()
    const result = await gateway.workspaceFileContent('ws-alpha-1', 'README.md')
    expect(result.status).toBe('ready')
    if (result.status !== 'ready') return
    expect(typeof result.value.content).toBe('string')
  })

  it('reads the change set through the workspaceChanges seam', async () => {
    const gateway = await buildGateway()
    const result = await gateway.workspaceChanges('ws-alpha-1')
    expect(result.status).toBe('ready')
    if (result.status !== 'ready') return
    expect(Array.isArray(result.value.files)).toBe(true)
  })

  it('reads an authorized preview through the workspacePreview seam', async () => {
    const gateway = await buildGateway()
    const result = await gateway.workspacePreview('ws-alpha-1', 'index.html')
    expect(result.status).toBe('ready')
    if (result.status !== 'ready') return
    expect(typeof result.value.content).toBe('string')
  })

  it('lists the workspace runs through the workspaceRuns seam', async () => {
    const gateway = await buildGateway()
    const result = await gateway.workspaceRuns('ws-alpha-1')
    expect(result.status).toBe('ready')
    if (result.status !== 'ready') return
    expect(result.value.some(run => run.runId === 'run-seed-1')).toBe(true)
  })

  it('reads the run pulse (with its test evidence) through the runPulse seam', async () => {
    const gateway = await buildGateway()
    const result = await gateway.runPulse('run-seed-1')
    expect(result.status).toBe('ready')
    if (result.status !== 'ready') return
    expect(result.value.runId).toBe('run-seed-1')
  })

  it('reads the frozen asset snapshot through the runAssetSnapshot seam', async () => {
    const gateway = await buildGateway()
    const result = await gateway.runAssetSnapshot('run-seed-1')
    expect(result.status).toBe('ready')
  })

  it('reads the run context lens through the contextLens seam', async () => {
    const gateway = await buildGateway()
    const result = await gateway.contextLens('ws-alpha-1')
    expect(result.status).toBe('ready')
  })

})
