/* 覆盖补齐：`TeamSkillGateway` 的 Remote 接缝方法。
 *
 * 已有 `host-service.integration.spec.ts` 直接驱动 `TeamSkillHost`，所以 host 与
 * 严格解析器都被覆盖；但浏览器真正调用的是 gateway 这一层，而插件测试用的是
 * stub remote，于是**接缝方法本身从未执行**（gateway.ts 函数覆盖率 31%，
 * workspace-gateway.ts 24%）。本文件用真实 fixture 把接缝逐个走一遍：断言每个
 * 方法确实把请求转给了服务端、并把响应解析成浏览器可用的形状。
 *
 * 分类：FIXTURE-ONLY。
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { CredentialProvider, type CredentialKey, type CredentialRecord } from '@deepseek-ai/dsh-credentials'
import SessionStore from '@deepseek-ai/dsh-session'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import { createTeamSkillService } from '../dev/team-skill-service/src/server.ts'
import { TeamSkillGateway } from '../src/gateway.ts'

const services: ReturnType<typeof createTeamSkillService>[] = []
const roots: string[] = []

/** 只服务一个可变 grant 的内存凭据提供者；与 telemetry-gateway 集成用例同款。 */
class MemoryCredentialProvider extends CredentialProvider {
  constructor(ctx: Context, private readonly state: { grant: Record<string, unknown> | undefined }) {
    super(ctx)
  }

  resolve(): Promise<undefined> {
    return Promise.resolve(undefined)
  }

  describe(): Promise<never> {
    return Promise.reject(new Error('not used in tests'))
  }

  set(): Promise<void> {
    return Promise.resolve()
  }

  unset(): Promise<void> {
    return Promise.resolve()
  }

  readRecord(_key: CredentialKey): Promise<CredentialRecord | undefined> {
    return Promise.resolve(this.state.grant === undefined ? undefined : { kind: 'grant', payload: this.state.grant })
  }

  describeRecord(_key: CredentialKey): Promise<never> {
    return Promise.reject(new Error('not used in tests'))
  }

  listRecords(): Promise<readonly never[]> {
    return Promise.resolve([])
  }

  async modifyRecord(
    _key: CredentialKey,
    mutate: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>,
  ): Promise<CredentialRecord | undefined> {
    const next = await mutate(this.readRecordSync())
    if (next === undefined) this.state.grant = undefined
    else if (next.kind === 'grant' && typeof next.payload === 'object' && next.payload !== null) {
      this.state.grant = next.payload as Record<string, unknown>
    }
    return next
  }

  deleteRecord(_key: CredentialKey): Promise<void> {
    this.state.grant = undefined
    return Promise.resolve()
  }

  private readRecordSync(): CredentialRecord | undefined {
    return this.state.grant === undefined ? undefined : { kind: 'grant', payload: this.state.grant }
  }
}

afterEach(async () => {
  for (const service of services.splice(0)) {
    service.server.closeAllConnections()
    await new Promise<void>((resolve) => {
      service.server.close(() => { resolve() })
    })
  }
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }).catch(() => undefined)))
})

/** 起 fixture、登录 member、把登录句柄写成 Host 凭据，返回装配好的 gateway。 */
async function buildGateway(): Promise<TeamSkillGateway> {
  const service = createTeamSkillService({ port: 0, seed: true })
  services.push(service)
  await service.listen()
  const port = (service.server.address() as AddressInfo).port
  const base = `http://127.0.0.1:${port}/v1`

  const login = await fetch(`${base}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'member@example.com', password: 'member-pass' }),
  })
  expect(login.status).toBe(200)
  const grant = ((await login.json()) as { data: { access_token: string } }).data.access_token

  const stateDirectory = await mkdtemp(join(tmpdir(), 'dsh-gateway-seam-'))
  roots.push(stateDirectory)
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  // 会话作用域的选择配置要经 ctx.agents 解析 sessionId。
  await ctx.plugin(AgentRegistry)
  const credentials = new MemoryCredentialProvider(ctx, {
    grant: { userId: 'member-1', accessToken: grant, refreshToken: 'refresh-seam', expiresAt: Date.now() + 3_600_000 },
  })
  void credentials
  return new TeamSkillGateway(ctx, {
    apiBaseUrl: base,
    stateDirectory,
    globalSkillRoot: join(stateDirectory, 'skills'),
    telemetry: { flushIntervalMs: 60_000, claimTimeoutMs: 60_000 },
  })
}

describe('TeamSkillGateway 接缝方法（真实 fixture）', () => {
  it('reads the browser-safe account state through the account seam', async () => {
    const gateway = await buildGateway()
    const result = await gateway.account()
    // 成功分支返回的就是 account state 本身（不是 ready 包装）。
    expect(result).toMatchObject({ status: 'authenticated' })
  })

  it('reads the authorized projects through the projects seam', async () => {
    const gateway = await buildGateway()
    const projects = await gateway.projects()
    // 成功分支返回数组本身；失败分支才是 { status: 'failed' | … }。
    expect(Array.isArray(projects)).toBe(true)
    if (!Array.isArray(projects)) return
    const listed = projects as readonly { readonly projectId: string }[]
    expect(listed.some(project => project.projectId === 'project-alpha')).toBe(true)
  })

  it('reads one project detail through the project seam', async () => {
    const gateway = await buildGateway()
    const detail = await gateway.project('project-alpha')
    expect(detail).toMatchObject({ project: { projectId: 'project-alpha' } })
  })

  it('reads the published catalog through the catalog seam', async () => {
    const gateway = await buildGateway()
    const catalog = await gateway.catalog('project-alpha')
    // catalog 走的是 ready 包装（与 account/projects 的裸值不同）。
    expect(catalog).toMatchObject({ status: 'ready' })
    if (catalog.status !== 'ready') return
    expect(Array.isArray(catalog.catalog.items)).toBe(true)
  })

  it('reads project knowledge bases through the knowledgeBases seam', async () => {
    const gateway = await buildGateway()
    const bases = await gateway.knowledgeBases('project-alpha')
    expect(Array.isArray(bases)).toBe(true)
    if (!Array.isArray(bases)) return
    expect(bases.length).toBeGreaterThanOrEqual(1)
  })

  it('searches the selected knowledge base through the knowledgeSearch seam', async () => {
    const gateway = await buildGateway()
    const bases = await gateway.knowledgeBases('project-alpha')
    expect(Array.isArray(bases)).toBe(true)
    if (!Array.isArray(bases)) return
    const summaries = bases as readonly { readonly searchable: boolean; readonly knowledgeBaseId: string }[]
    const selected = summaries.filter(base => base.searchable).map(base => base.knowledgeBaseId)
    expect(selected.length).toBeGreaterThanOrEqual(1)

    const result = await gateway.knowledgeSearch({
      projectId: 'project-alpha',
      query: '发布',
      knowledgeBaseIds: selected,
    })
    expect(result).toMatchObject({ status: 'ready' })
    if (!('response' in result)) return
    // 未参与检索的知识库也必须逐条出现，否则行会读成「没被选」。
    expect(result.response.knowledgeBases.length).toBe(selected.length)
  })

  it('lists project memory through the memoryList seam', async () => {
    const gateway = await buildGateway()
    const page = await gateway.memoryList({ projectId: 'project-alpha', limit: 10 })
    // 成功分支返回分页对象本身（items / nextCursor / totalEstimate）。
    if (!('items' in page)) throw new Error(`unexpected memory list result: ${JSON.stringify(page)}`)
    expect(Array.isArray(page.items)).toBe(true)
    expect(typeof page.totalEstimate).toBe('number')
  })

  it('accepts a memory capture through the memoryCapture seam', async () => {
    const gateway = await buildGateway()
    const result = await gateway.memoryCapture({
      projectId: 'project-alpha',
      sessionId: 'sess-seam',
      messages: [{ role: 'user', content: '接缝用例：捕获一条项目记忆' }],
    }, 'seam-capture-1')
    if (!('jobId' in result)) throw new Error(`capture rejected: ${JSON.stringify(result)}`)
    expect(typeof result.jobId).toBe('string')
    expect(['PENDING', 'INDEX_PENDING']).toContain(result.status)
  })

  it('answers an unknown memory id with an explicit failure rather than a crash', async () => {
    const gateway = await buildGateway()
    const result = await gateway.memoryGet('memory-does-not-exist')
    expect(result).toMatchObject({ status: 'failed' })
  })

  it('lists memory jobs and reports the audit plane this fixture does not serve as an explicit failure', async () => {
    // memoryJobs / memoryAudit 走**另一条基路径**：http.ts 把 `…/v1` 换成 `…/v3`
    // 的项目记忆平面。fixture 对 jobs 返回空列表，对 audit 不可达——两者都必须
    // 显式（空列表 / 显式失败），不得崩掉，也不得把失败伪装成空列表。
    const gateway = await buildGateway()
    const jobs = await gateway.memoryJobs('project-alpha')
    expect(Array.isArray(jobs)).toBe(true)
    const audit = await gateway.memoryAudit('project-alpha')
    expect(audit).toMatchObject({ status: 'failed' })
  })

  it('reads an authorized knowledge document preview through the knowledgePreview seam', async () => {
    const gateway = await buildGateway()
    const bases = await gateway.knowledgeBases('project-alpha')
    if (!Array.isArray(bases)) throw new Error(`knowledge bases unavailable: ${JSON.stringify(bases)}`)
    const summaries = bases as readonly { readonly searchable: boolean; readonly knowledgeBaseId: string }[]
    const base = summaries.find(item => item.searchable)
    expect(base).toBeDefined()
    const preview = await gateway.knowledgePreview(base?.knowledgeBaseId ?? '', 'doc-release')
    if (!('documentId' in preview)) throw new Error(`preview unavailable: ${JSON.stringify(preview)}`)
    expect(preview.documentId).toBe('doc-release')
  })

  it('refuses to configure a session-scoped selection when the session is not live', async () => {
    const gateway = await buildGateway()
    expect(() => { gateway.configureKnowledgeSelection('sess-not-live', { projectId: 'project-alpha', knowledgeBaseIds: [] }) })
      .toThrow(/not a live agent/u)
    expect(() => { gateway.clearKnowledgeSelection('sess-not-live') }).toThrow(/not a live agent/u)
    expect(() => { gateway.configureProjectMemory('sess-not-live', 'project-alpha') })
      .toThrow(/not a live agent/u)
  })
})
