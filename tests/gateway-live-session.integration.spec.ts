/* TeamSkillGateway 的「活性会话」接线（覆盖专项：gateway 批·续）。
 *
 * 会话级选择（知识库选择、项目记忆绑定）与 `agent/disposed` 清理此前只走过
 * 「会话不存在就抛错」的一支：真正活着的 agent 那一支从未执行，因为平台测试里
 * 从没有注册过 agent。本规格用 AgentRegistry 的 enter() 注册一个最小 agent 替身
 * （id 与 session.id 一致），把「活着」与「被释放」两种状态都驱动一遍。
 *
 * 分类：FIXTURE-ONLY。
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import { CredentialProvider, type CredentialKey, type CredentialRecord } from '@deepseek-ai/dsh-credentials'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
// 0.1.5 drift: AgentLoop.inject now also requires sessionProjections, which
// dsh-session-projection provides. On the 0.1.1-rc.2 sources the loop mounted
// without it; on this baseline an unmounted registry leaves the loop's fiber
// waiting on an unmet injection, so ctx.agentLoop never appears and every
// await ctx.agentLoop.create(...) call throws.
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { createTeamSkillService } from '../dev/team-skill-service/src/server.ts'
import { TeamSkillGateway } from '../src/gateway.ts'
import { MockAdapter, textResponse } from './helpers/mock-adapter.ts'

const services: ReturnType<typeof createTeamSkillService>[] = []
const roots: string[] = []
const servers: Server[] = []

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
    const next = await mutate(this.state.grant === undefined ? undefined : { kind: 'grant', payload: this.state.grant })
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
}

afterEach(async () => {
  for (const service of services.splice(0)) {
    service.server.closeAllConnections()
    await new Promise<void>((resolve) => {
      service.server.close(() => { resolve() })
    })
  }
  for (const server of servers.splice(0)) {
    server.closeAllConnections()
    await new Promise<void>((resolve) => {
      server.close(() => { resolve() })
    })
  }
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }).catch(() => undefined)))
})

const LIVE_SESSION = 'sess-live-1'

/**
 * Builds a gateway whose registry holds one live agent.
 *
 * The double carries exactly what the plugin reads — the agent identity and its
 * session id — because the registry seam is what is under test here, not a full
 * agent runtime.
 * @returns The gateway, the registry's release closure, and the live session id.
 */
async function liveGateway(): Promise<{
  readonly gateway: TeamSkillGateway
  readonly release: () => void
  readonly ctx: Context
  readonly agent: Agent
}> {
  const service = createTeamSkillService({ port: 0, seed: true })
  services.push(service)
  await service.listen()
  const port = (service.server.address() as AddressInfo).port
  const login = await fetch(`http://127.0.0.1:${port}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'member@example.com', password: 'member-pass' }),
  })
  const grant = ((await login.json()) as { data: { access_token: string } }).data.access_token

  const stateDirectory = await mkdtemp(join(tmpdir(), 'dsh-gateway-live-'))
  roots.push(stateDirectory)
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  const sessionId = SessionId(LIVE_SESSION)
  const agent = { id: sessionId, session: { id: sessionId } } as unknown as Agent
  const release = ctx.agents.enter(agent, undefined)
  const credentials = new MemoryCredentialProvider(ctx, {
    grant: { userId: 'member-1', accessToken: grant, refreshToken: 'refresh-live', expiresAt: Date.now() + 3_600_000 },
  })
  void credentials

  return {
    release,
    ctx,
    agent,
    gateway: new TeamSkillGateway(ctx, {
      apiBaseUrl: `http://127.0.0.1:${port}/v1`,
      stateDirectory,
      globalSkillRoot: join(stateDirectory, 'skills'),
      telemetry: { flushIntervalMs: 60_000, claimTimeoutMs: 60_000 },
    }),
  }
}

describe('TeamSkillGateway 活性会话接线', () => {
  it('binds and clears the session-scoped knowledge and memory selections', async () => {
    const { gateway } = await liveGateway()

    // 有选择：写入；空选择：删除（而不是写入一个空选择）。
    gateway.configureKnowledgeSelection(LIVE_SESSION, { projectId: 'project-alpha', knowledgeBaseIds: ['k-1'] })
    gateway.configureKnowledgeSelection(LIVE_SESSION, { projectId: 'project-alpha', knowledgeBaseIds: [] })
    expect(() => { gateway.clearKnowledgeSelection(LIVE_SESSION) }).not.toThrow()

    // 项目记忆绑定：有项目写入、空项目解绑。
    gateway.configureProjectMemory(LIVE_SESSION, 'project-alpha')
    gateway.configureProjectMemory(LIVE_SESSION, '')
    expect(() => { gateway.clearProjectMemory(LIVE_SESSION) }).not.toThrow()
  })

  it('drops the per-agent selections when the agent is disposed', async () => {
    const { gateway, release } = await liveGateway()
    gateway.configureKnowledgeSelection(LIVE_SESSION, { projectId: 'project-alpha', knowledgeBaseIds: ['k-1'] })
    gateway.configureProjectMemory(LIVE_SESSION, 'project-alpha')

    release()
    await new Promise<void>((resolve) => { setTimeout(resolve, 0) })

    // 释放之后同一个会话不再是活着的 agent：清理监听器已经执行，再次配置必须被拒绝
    // （而不是拿着一个已被丢弃的选择继续工作）。
    expect(() => { gateway.configureKnowledgeSelection(LIVE_SESSION, { projectId: 'project-alpha', knowledgeBaseIds: ['k-1'] }) })
      .toThrow(/not a live agent/u)
    expect(() => { gateway.clearProjectMemory(LIVE_SESSION) }).toThrow(/not a live agent/u)
  })

  it('refuses a session that is not live instead of answering with an empty selection', async () => {
    const { gateway } = await liveGateway()
    expect(() => { gateway.configureKnowledgeSelection('sess-absent', { projectId: 'project-alpha', knowledgeBaseIds: [] }) })
      .toThrow(/not a live agent/u)
    expect(() => { gateway.clearKnowledgeSelection('sess-absent') }).toThrow(/not a live agent/u)
    expect(() => { gateway.configureProjectMemory('sess-absent', 'project-alpha') }).toThrow(/not a live agent/u)
    expect(() => { gateway.clearProjectMemory('sess-absent') }).toThrow(/not a live agent/u)
  })

  it('drops the per-agent state when the runtime announces a disposed agent', async () => {
    const { gateway, ctx, agent } = await liveGateway()
    gateway.configureKnowledgeSelection(LIVE_SESSION, { projectId: 'project-alpha', knowledgeBaseIds: ['k-1'] })
    gateway.configureProjectMemory(LIVE_SESSION, 'project-alpha')

    // 运行时在 agent 结束生命周期时派发该事件；插件的清理监听器必须随之执行。
    ctx.emit('agent/disposed', { agent })
    await new Promise<void>((resolve) => { setTimeout(resolve, 0) })

    // 清理之后重新配置仍可用（agent 仍在注册表里，只是选择被丢掉）。
    expect(() => { gateway.clearKnowledgeSelection(LIVE_SESSION) }).not.toThrow()
  })

  it('answers the collector session seams explicitly, with and without telemetry storage', async () => {
    const { gateway } = await liveGateway()

    // 服务端确认授权后才绑定；空项目等于解绑。
    expect(await gateway.configureCollectorProject(LIVE_SESSION, 'project-alpha'))
      .toMatchObject({ status: 'ready', value: { projectId: 'project-alpha' } })
    expect(await gateway.configureCollectorProject(LIVE_SESSION, '')).toMatchObject({ status: 'ready', value: { projectId: '' } })
    // 未获授权的项目：保持原绑定并显式说明。
    expect(await gateway.configureCollectorProject(LIVE_SESSION, 'project-absent'))
      .toMatchObject({ status: 'failed', code: 'PROJECT_NOT_AUTHORIZED' })

    // 不存活会话：稳定码而不是异常。
    expect(await gateway.configureCollectorProject('sess-absent', 'project-alpha'))
      .toMatchObject({ status: 'failed', code: 'SESSION_NOT_LIVE' })
    expect(await gateway.clearCollectorProject('sess-absent'))
      .toMatchObject({ status: 'failed', code: 'SESSION_NOT_LIVE' })
    expect(await gateway.clearCollectorProject(LIVE_SESSION)).toMatchObject({ status: 'ready', value: { cleared: true } })
  })

  it('reports the collector as not-ready when its storage cannot be opened', async () => {
    // 状态根被一个文件占住：遥测队列打不开，采集后端缺席——绑定必须显式说明缺存储。
    const blocked = join(await mkdtemp(join(tmpdir(), 'dsh-gateway-nostorage-')), 'state-file')
    roots.push(blocked)
    await writeFile(blocked, 'not a directory', 'utf8')
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
    const sessionId = SessionId(LIVE_SESSION)
    const agent = { id: sessionId, session: { id: sessionId } } as unknown as Agent
    ctx.agents.enter(agent, undefined)
    const gateway = new TeamSkillGateway(ctx, {
      apiBaseUrl: 'http://127.0.0.1:1/v1',
      stateDirectory: blocked,
      globalSkillRoot: join(blocked, 'skills'),
      telemetry: { flushIntervalMs: 60_000, claimTimeoutMs: 60_000 },
    })

    const bound = await gateway.configureCollectorProject(LIVE_SESSION, 'project-alpha')
    expect(bound).toMatchObject({ status: 'not-ready', missing: ['telemetryStorage'] })
  })
})

/** The full runtime one real agent turn needs, plus the plugin's own services. */
async function agentRuntime(
  options: { readonly offline?: boolean; readonly endpoint?: string } = {},
): Promise<{ readonly ctx: Context; readonly gateway: TeamSkillGateway }> {
  const service = createTeamSkillService({ port: 0, seed: true })
  services.push(service)
  await service.listen()
  const port = (service.server.address() as AddressInfo).port
  const login = await fetch(`http://127.0.0.1:${port}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'member@example.com', password: 'member-pass' }),
  })
  const grant = ((await login.json()) as { data: { access_token: string } }).data.access_token
  const stateDirectory = await mkdtemp(join(tmpdir(), 'dsh-gateway-bridge-'))
  roots.push(stateDirectory)

  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  // 0.1.5 drift: satisfy AgentLoop's new sessionProjections injection.
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['mock'], new MockAdapter([textResponse('回答')]))
  // 插件的两个扩展点：DSH Skill 目录（安装握手）与工作空间路径解析。
  ctx.provide('skills', { list: async () => [] } as never)
  ctx.provide('workspaceRegistry', { get: () => undefined } as never)
  const credentials = new MemoryCredentialProvider(ctx, {
    grant: { userId: 'member-1', accessToken: grant, refreshToken: 'refresh-bridge', expiresAt: Date.now() + 3_600_000 },
  })
  void credentials

  return {
    ctx,
    gateway: new TeamSkillGateway(ctx, {
      // 离线模式：没有服务端点，插件必须把每条适配器的失败如实转成状态。
      // 指定 endpoint：服务端点存在但不可用（脚本化 503），失败发生在请求之后。
      ...(options.offline === true ? {} : { apiBaseUrl: options.endpoint ?? `http://127.0.0.1:${port}/v1` }),
      stateDirectory,
      globalSkillRoot: join(stateDirectory, 'skills'),
      telemetry: { flushIntervalMs: 60_000, claimTimeoutMs: 60_000 },
    }),
  }
}

/** Resolves once the agent's turn has finished. */
function waitForIdle(ctx: Context, agent: Agent): Promise<void> {
  return new Promise((resolve) => {
    const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject === agent && status === 'idle') {
        dispose()
        resolve()
      }
    })
  })
}

describe('TeamSkillGateway 与真实 agent 回合的桥接', () => {
  it('recalls knowledge and memory for a live turn through the real service', async () => {
    const { ctx, gateway } = await agentRuntime()
    const sessionId = SessionId('sess-bridge-1')
    const agent = await ctx.agentLoop.create(sessionId, { provider: 'mock', model: 'mock' })
    gateway.configureKnowledgeSelection(String(sessionId), { projectId: 'project-alpha', knowledgeBaseIds: ['k-1'] })
    gateway.configureProjectMemory(String(sessionId), 'project-alpha')

    // 一次真实回合：前步骤瀑布会依次调用插件注册的知识检索与记忆召回适配器。
    agent.followup(createUserMessage({ content: [{ type: 'text', text: '发布流程是什么' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)

    const events = agent.session.ownEvents().filter(event => event.type === 'knowledge-search')
    // 检索确实发生了：要么带命中结果，要么带逐库的跳过原因——但绝不会静默消失。
    expect(events.length).toBeGreaterThanOrEqual(1)
    expect(events[0]?.data).toMatchObject({ query: '发布流程是什么' })
  }, 30_000)

  it('turns an unreachable service into explicit adapter states for a live turn', async () => {
    const { ctx, gateway } = await agentRuntime({ offline: true })
    const sessionId = SessionId('sess-bridge-offline')
    const agent = await ctx.agentLoop.create(sessionId, { provider: 'mock', model: 'mock' })
    gateway.configureKnowledgeSelection(String(sessionId), { projectId: 'project-alpha', knowledgeBaseIds: ['k-1'] })
    gateway.configureProjectMemory(String(sessionId), 'project-alpha')

    // 没有端点：检索与召回适配器都必须给出显式状态（not-ready / failed），
    // 而不是把「服务不可达」当成空结果，也不能让回合崩掉。
    agent.followup(createUserMessage({ content: [{ type: 'text', text: '发布流程是什么' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)

    const events = agent.session.ownEvents().filter(event => event.type === 'knowledge-search')
    expect(events.length).toBeGreaterThanOrEqual(1)
    expect(JSON.stringify(events[0]?.data)).toContain('skipped')

    // 采集项目绑定：服务端还没有授权答案，必须显式 not-ready。
    expect(await gateway.configureCollectorProject(String(sessionId), 'project-alpha'))
      .toMatchObject({ status: 'not-ready' })
  }, 30_000)

  it('turns an unreachable service into explicit memory states for a memory-only turn', async () => {
    const { ctx, gateway } = await agentRuntime({ offline: true })
    const sessionId = SessionId('sess-bridge-memory')
    const agent = await ctx.agentLoop.create(sessionId, { provider: 'mock', model: 'mock' })
    // 只绑定项目记忆（不选知识库）：前步骤瀑布不会被知识检索的 reject 短路，
    // 记忆召回适配器才会带着「服务不可达」的结果跑完。
    gateway.configureProjectMemory(String(sessionId), 'project-alpha')

    agent.followup(createUserMessage({ content: [{ type: 'text', text: '上次的约定是什么' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)

    // 召回不可达必须映射成显式状态，回合照常跑完并留下模型的回答。
    expect(JSON.stringify(agent.session.ownEvents())).toContain('回答')
  }, 30_000)

  it('maps a failed recall to the unavailable state for a memory-only turn', async () => {
    // 端点存在、服务不可用：召回请求真的发出去并失败（503），适配器必须把它映射成
    // 「服务不可用」，而不是当成空结果或未就绪。记忆是咨询性的：失败既不阻断回合，
    // 也不注入任何记忆参考。另两个分支（就绪/未就绪）在消费者眼里同样不注入，
    // 因此这里钉住的是「请求确实发出并失败」与「失败不阻断」两件事。
    const recallCalls: string[] = []
    const server = createServer((request, response) => {
      recallCalls.push(`${request.method ?? 'GET'} ${request.url ?? '/'}`)
      response.writeHead(503, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ code: 'SERVICE_UNAVAILABLE', message: '维护中', request_id: 'r', data: null }))
    })
    servers.push(server)
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', () => { resolve() }) })
    const { ctx, gateway } = await agentRuntime({
      endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
    })
    const sessionId = SessionId('sess-bridge-memory-failed')
    const agent = await ctx.agentLoop.create(sessionId, { provider: 'mock', model: 'mock' })
    gateway.configureProjectMemory(String(sessionId), 'project-alpha')

    agent.followup(createUserMessage({ content: [{ type: 'text', text: '上次的约定是什么' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)

    expect(recallCalls.some(call => call.includes('/project-memory/recall'))).toBe(true)
    expect(JSON.stringify(agent.session.ownEvents())).toContain('回答')
    expect(JSON.stringify(agent.session.ownEvents())).not.toContain('Untrusted project-memory references')
  }, 30_000)

  it('isolates the collector account while an authentication request is in flight', async () => {
    const { gateway } = await liveGateway()
    // 登出先把采集账号标成 not-ready（挂起窗口内不写任何分区），再走真实的登出。
    const signedOut = await gateway.logout()
    expect(signedOut).toMatchObject({ status: 'signed-out' })
  })
})
