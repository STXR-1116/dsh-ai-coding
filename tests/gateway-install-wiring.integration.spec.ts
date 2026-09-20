/* TeamSkillGateway 的安装接线与发现握手（覆盖专项：gateway 批·续）。
 *
 * gateway 构造时把 `resolveWorkspace` 与 `refreshSkillCatalog` 交给 Host：安装/卸载
 * 的真实路径必须经 `ctx.skills.list()` 轮询确认 DSH 已经（或不再）发现该副本，且
 * 工作空间作用域的根目录由 `ctx.workspaceRegistry` 解析。这些闭包此前从未执行——
 * host 层规格直接构造 Host，refresh 由测试自己提供。
 *
 * 本规格经**真实 fixture**（目录 + 授权 + 制品下载 + 本地写入）走完整条安装/卸载链。
 *
 * 分类：FIXTURE-ONLY。
 */
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
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
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }).catch(() => undefined)))
})

/** 起 fixture、装配带 skills/workspaceRegistry 桩的 gateway，并交出可脚本化的发现目录。 */
async function wiredGateway(): Promise<{
  readonly gateway: TeamSkillGateway
  readonly projectRoot: string
  readonly discovered: { names: readonly string[] }
}> {
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

  const stateDirectory = await mkdtemp(join(tmpdir(), 'dsh-gateway-wiring-'))
  roots.push(stateDirectory)
  const projectRoot = join(stateDirectory, 'project')
  await mkdir(projectRoot, { recursive: true })

  // DSH 的 Skill 目录由测试脚本化：安装后报出名字，卸载后不再报出。
  const discovered: { names: readonly string[] } = { names: [] }
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  ctx.provide('skills', { list: async () => discovered.names.map(name => ({ name })) } as never)
  ctx.provide('workspaceRegistry', {
    get: (workspaceId: string) => (workspaceId === 'workspace-1' ? { path: projectRoot } : undefined),
  } as never)
  const credentials = new MemoryCredentialProvider(ctx, {
    grant: { userId: 'member-1', accessToken: grant, refreshToken: 'refresh-wiring', expiresAt: Date.now() + 3_600_000 },
  })
  void credentials

  const gateway = new TeamSkillGateway(ctx, {
    apiBaseUrl: base,
    stateDirectory,
    globalSkillRoot: join(stateDirectory, 'global-skills'),
    telemetry: { flushIntervalMs: 60_000, claimTimeoutMs: 60_000 },
  })
  return { gateway, projectRoot, discovered }
}

describe('TeamSkillGateway 安装接线（真实 fixture）', () => {
  it('installs a real skill into the workspace root and confirms DSH discovery', async () => {
    const { gateway, projectRoot, discovered } = await wiredGateway()

    const catalog = await gateway.catalog('project-alpha')
    if (catalog.status !== 'ready') throw new Error(`目录不可用: ${JSON.stringify(catalog)}`)
    const item = catalog.catalog.items[0]
    expect(item).toBeDefined()
    if (item === undefined) return

    // 接入前 DSH 还没看见这份副本：Host 必须轮询到「已发现」才判定安装成功。
    discovered.names = [item.runtimeName]
    const installed = await gateway.install({
      skillId: item.skillId,
      version: item.version,
      projectId: 'project-alpha',
      scope: 'project',
      workspaceId: 'workspace-1',
      environment: { dshVersion: '0.1.1', availableTools: [], availableMcpServers: [], presentEnvironmentVariableNames: [] },
    })
    expect(installed.status).toBe('succeeded')
    const written = await readFile(join(projectRoot, '.dsh', 'skills', item.runtimeName, 'SKILL.md'), 'utf8')
    expect(written.length).toBeGreaterThan(0)

    // 卸载：DSH 不再报出该名字后，Host 才判定移除成功。
    const localInstallationId = installed.status === 'succeeded' ? installed.installation.localInstallationId : ''
    discovered.names = []
    const removed = await gateway.uninstall({ localInstallationId })
    expect(removed.status).toBe('succeeded')
    await expect(readFile(join(projectRoot, '.dsh', 'skills', item.runtimeName, 'SKILL.md'), 'utf8')).rejects.toThrow()
  })

  it('installs into the global root, which has no workspace path to list', async () => {
    const { gateway, discovered } = await wiredGateway()
    const catalog = await gateway.catalog('project-alpha')
    if (catalog.status !== 'ready') throw new Error(`目录不可用: ${JSON.stringify(catalog)}`)
    const item = catalog.catalog.items[0]
    if (item === undefined) return

    // 全局作用域没有工作空间路径：发现握手必须问整个 Skill 目录，而不是带 cwd 问。
    discovered.names = [item.runtimeName]
    const installed = await gateway.install({
      skillId: item.skillId,
      version: item.version,
      projectId: 'project-alpha',
      scope: 'global',
      environment: { dshVersion: '0.1.1', availableTools: [], availableMcpServers: [], presentEnvironmentVariableNames: [] },
    })
    expect(installed.status).toBe('succeeded')
  })

  it('keeps polling while DSH has not confirmed discovery, then fails explicitly', async () => {
    const { gateway, discovered } = await wiredGateway()
    const catalog = await gateway.catalog('project-alpha')
    if (catalog.status !== 'ready') throw new Error(`目录不可用: ${JSON.stringify(catalog)}`)
    const item = catalog.catalog.items[0]
    if (item === undefined) return

    // 永不报出：确认窗口耗尽后必须显式失败，而不是把未确认当成成功。
    discovered.names = []
    const installed = await gateway.install({
      skillId: item.skillId,
      version: item.version,
      projectId: 'project-alpha',
      scope: 'project',
      workspaceId: 'workspace-1',
      environment: { dshVersion: '0.1.1', availableTools: [], availableMcpServers: [], presentEnvironmentVariableNames: [] },
    })
    expect(installed.status).toBe('failed')
    if (installed.status === 'failed') expect(installed.code).toBe('LOCAL_REFRESH_FAILED')
  }, 30_000)
})
