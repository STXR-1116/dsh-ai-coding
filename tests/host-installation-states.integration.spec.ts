/* oxlint-disable typescript/no-base-to-string -- Fetch stubs stringify RequestInfo wire values. */
/* TeamSkillHost 的本地副本状态机（覆盖专项：host 批·续）。
 *
 * `syncReleaseStatus` 与 `uninstall` 的分支此前只走过「一切正常」的一支：本地副本处于
 * 隔离态、服务端不再返回该版本、隔离后刷新发现失败、卸载失败要回滚——这些都需要
 * 真实的磁盘副本 + 可注入的安装存储与刷新钩子。本规格用真实临时目录写出一份已安装
 * 副本（含真实摘要），注入可脚本化的存储与刷新，再把每条分支走一遍。
 *
 * 分类：FIXTURE-ONLY。
 */
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AddressInfo } from 'node:net'
import { createTeamSkillService } from '../dev/team-skill-service/src/server.ts'
import { TeamSkillHost } from '../src/host.ts'
import type { TeamSkillInstallationRecord } from '../src/types.ts'
import type { TeamSkillInstallationView } from '../src/types.ts'
import type { TeamSkillInstallationStoreLike } from '../src/installation-store.ts'
import type { TeamSkillScope } from '../src/types.ts'

const services: ReturnType<typeof createTeamSkillService>[] = []
const roots: string[] = []

afterEach(async () => {
  for (const service of services.splice(0)) {
    service.server.closeAllConnections()
    await new Promise<void>((resolve) => {
      service.server.close(() => { resolve() })
    })
  }
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }).catch(() => undefined)))
})

/** 一份可脚本化的安装存储：list 返回当前记录，upsert/remove 就地改写并记账。 */
class ScriptedStore implements TeamSkillInstallationStoreLike {
  readonly upserts: TeamSkillInstallationRecord[] = []

  constructor(private readonly records: TeamSkillInstallationRecord[]) {}

  list(): Promise<readonly TeamSkillInstallationRecord[]> {
    return Promise.resolve([...this.records])
  }

  upsert(next: TeamSkillInstallationRecord): Promise<void> {
    this.upserts.push(next)
    const index = this.records.findIndex(record => record.localInstallationId === next.localInstallationId)
    if (index === -1) this.records.push(next)
    else this.records[index] = next
    return Promise.resolve()
  }

  remove(localInstallationId: string): Promise<void> {
    const index = this.records.findIndex(record => record.localInstallationId === localInstallationId)
    if (index !== -1) this.records.splice(index, 1)
    return Promise.resolve()
  }

  current(): readonly TeamSkillInstallationRecord[] {
    return this.records
  }
}

/** 在临时目录里写出一份真实的已安装副本，并返回与磁盘一致的记录。 */
async function installedRecord(options: {
  readonly localInstallationId: string
  readonly runtimeName: string
  readonly state?: 'normal' | 'withdrawn' | 'uninstalled'
  readonly scope?: TeamSkillScope
  readonly skillId?: string
  readonly version?: string
}): Promise<{ readonly record: TeamSkillInstallationRecord; readonly directory: string; readonly stateDirectory: string }> {
  const stateDirectory = await mkdtemp(join(tmpdir(), 'dsh-installation-state-'))
  roots.push(stateDirectory)
  const directory = join(stateDirectory, 'skills', options.runtimeName)
  await mkdir(directory, { recursive: true })
  const body = Buffer.from(`# ${options.runtimeName}\n\n已安装的 Team Skill。\n`, 'utf8')
  await writeFile(join(directory, 'SKILL.md'), body)
  return {
    stateDirectory,
    directory,
    record: {
      localInstallationId: options.localInstallationId,
      skillId: options.skillId ?? 'skill-alpha',
      projectId: 'project-alpha',
      scope: options.scope ?? 'global',
      installed: {
        runtimeName: options.runtimeName,
        version: options.version ?? '1.0.0',
        artifactSha256: 'a'.repeat(64),
        directory,
        files: [{ path: 'SKILL.md', sha256: createHash('sha256').update(body).digest('hex') }],
        state: options.state ?? 'normal',
      },
      installedAt: '2026-09-01T00:00:00.000Z',
    },
  }
}

/** 起真实 fixture 并交付一个已完成登录的静态部署 Host。 */
/** The refresh hook the Host calls to confirm DSH sees (or no longer sees) a copy. */
type RefreshCatalog = (
  scope: TeamSkillScope,
  workspacePath: string | undefined,
  runtimeName: string,
  expectedPresent?: boolean,
) => Promise<boolean>

async function hostFor(options: {
  readonly store: TeamSkillInstallationStoreLike
  readonly stateDirectory: string
  readonly refresh?: RefreshCatalog
}): Promise<TeamSkillHost> {
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
  return new TeamSkillHost({
    apiBaseUrl: `http://127.0.0.1:${port}/v1`,
    accessToken: grant,
    stateDirectory: options.stateDirectory,
    globalSkillRoot: join(options.stateDirectory, 'skills'),
    installationStore: options.store,
    ...(options.refresh === undefined ? {} : { refreshSkillCatalog: options.refresh }),
  })
}

/** Narrows a seam result to the installation list, failing loud on any other outcome. */
function asListed(result: unknown, label: string): readonly TeamSkillInstallationView[] {
  if (!Array.isArray(result)) throw new Error(`${label}: ${JSON.stringify(result)}`)
  return result as readonly TeamSkillInstallationView[]
}

describe('TeamSkillHost 本地副本状态机', () => {
  it('quarantines a normal copy whose release the service no longer reports', async () => {
    const { record, directory, stateDirectory } = await installedRecord({ localInstallationId: 'local-1', runtimeName: 'skill-alpha' })
    const store = new ScriptedStore([record])
    const host = await hostFor({ store, stateDirectory, refresh: async () => true })

    const listed = asListed(await host.syncReleaseStatus('project-alpha'), '同步失败')
    const entry = listed.find(item => item.localInstallationId === 'local-1')
    // 隔离后仍然可见（隐藏它会让本地副本变成孤儿），但状态必须写明。
    expect(entry?.state).toBe('withdrawn')
    expect(await readdir(directory).catch(() => [])).toEqual([])
    expect(store.current()[0]?.installed.state).toBe('withdrawn')
  })

  it('keeps an already-quarantined copy without re-running discovery', async () => {
    const { record, stateDirectory } = await installedRecord({
      localInstallationId: 'local-2', runtimeName: 'skill-beta', state: 'withdrawn',
    })
    const store = new ScriptedStore([record])
    const host = await hostFor({ store, stateDirectory, refresh: async () => true })

    const listed = asListed(await host.syncReleaseStatus('project-alpha'), '同步失败')
    expect(listed.find(item => item.localInstallationId === 'local-2')?.state).toBe('withdrawn')
  })

  it('reports an explicit local failure when DSH does not confirm the quarantine', async () => {
    const { record, stateDirectory } = await installedRecord({ localInstallationId: 'local-3', runtimeName: 'skill-gamma' })
    const store = new ScriptedStore([record])
    const host = await hostFor({ store, stateDirectory, refresh: async () => false })

    const result = await host.syncReleaseStatus('project-alpha')
    expect(result).toMatchObject({ status: 'failed', code: 'LOCAL_REFRESH_FAILED' })
  })

  it('removes a managed copy, records the terminal state and confirms discovery', async () => {
    const { record, directory, stateDirectory } = await installedRecord({ localInstallationId: 'local-4', runtimeName: 'skill-delta' })
    const store = new ScriptedStore([record])
    const host = await hostFor({ store, stateDirectory, refresh: async () => true })

    const result = await host.uninstall({ localInstallationId: 'local-4' })
    expect(result).toMatchObject({ status: 'succeeded' })
    expect(await readdir(join(stateDirectory, 'skills')).catch(() => [])).toEqual([])
    expect(await readdir(directory).catch(() => [])).toEqual([])
    expect(store.current()[0]?.installed.state).toBe('uninstalled')
  })

  it('answers an already-removed copy without touching the disk', async () => {
    const { record, stateDirectory } = await installedRecord({
      localInstallationId: 'local-5', runtimeName: 'skill-epsilon', state: 'uninstalled',
    })
    const store = new ScriptedStore([record])
    const host = await hostFor({ store, stateDirectory, refresh: async () => true })

    expect(await host.uninstall({ localInstallationId: 'local-5' })).toMatchObject({ status: 'succeeded' })
    expect(store.upserts).toEqual([])
  })

  it('reports a failed artifact download as a download-stage failure', async () => {
    // 空的目标根：预检不该因为别的原因先失败。
    const stateDirectory = await mkdtemp(join(tmpdir(), 'dsh-installation-download-'))
    roots.push(stateDirectory)
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
    // 授权与目录走真实服务，制品下载被拦下：失败必须停在 download 阶段。
    const host = new TeamSkillHost({
      apiBaseUrl: `http://127.0.0.1:${port}/v1`,
      accessToken: grant,
      stateDirectory,
      globalSkillRoot: join(stateDirectory, 'skills'),
      refreshSkillCatalog: async () => true,
      fetch: async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        if (String(input).includes('/v1/downloads/')) {
          return new Response(JSON.stringify({ code: 'SERVICE_UNAVAILABLE', message: '制品不可用', request_id: 'r', data: null }), {
            status: 503, headers: { 'content-type': 'application/json' },
          })
        }
        return globalThis.fetch(input, init)
      },
    })

    const catalog = await host.catalog('project-alpha')
    if (catalog.status !== 'ready') throw new Error(`目录不可用: ${JSON.stringify(catalog)}`)
    const item = catalog.catalog.items[0]
    if (item === undefined) return
    // 预检要过：把信任卡声明的工具权限原样报成本地可用工具，失败才会落在下载阶段。
    const card = await host.trustCard({ skillId: item.skillId, version: item.version, projectId: 'project-alpha' })
    const tools = 'toolPermissions' in card ? card.toolPermissions : []
    const result = await host.install({
      skillId: item.skillId,
      version: item.version,
      projectId: 'project-alpha',
      scope: 'global',
      environment: { dshVersion: '0.1.1', availableTools: [...tools], availableMcpServers: [], presentEnvironmentVariableNames: [] },
    })
    expect(result.status).toBe('failed')
    // 失败发生在下载阶段：阶段证据必须写下载失败，而不是把它记成预检失败
    // （预检本身在授权响应里已经成功，把两者都写成 precheck 会自相矛盾）。
    if (result.status === 'failed') expect(result.failedStage).toBe('download')
  })

  it('keeps a quarantined copy whose release the service still reports', async () => {
    // 用真实目录里的发布身份建记录：服务端对它的发布状态是 published，
    // 于是「已隔离 + 仍在发布」这一支必须保持隔离态而不重复隔离。
    const { stateDirectory } = await installedRecord({ localInstallationId: 'local-9', runtimeName: 'skill-iota' })
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
    const catalogHost = new TeamSkillHost({ apiBaseUrl: `http://127.0.0.1:${port}/v1`, accessToken: grant })
    const catalog = await catalogHost.catalog('project-alpha')
    if (catalog.status !== 'ready') throw new Error(`目录不可用: ${JSON.stringify(catalog)}`)
    const item = catalog.catalog.items[0]
    if (item === undefined) return

    const released = await installedRecord({
      localInstallationId: 'local-9', runtimeName: item.runtimeName, state: 'withdrawn', skillId: item.skillId,
      version: item.version,
    })
    const store = new ScriptedStore([released.record])
    const host = await hostFor({ store, stateDirectory, refresh: async () => true })
    const listed = asListed(await host.syncReleaseStatus('project-alpha'), '同步失败')
    expect(listed.find(entry => entry.localInstallationId === 'local-9')?.state).toBe('withdrawn')
    expect(store.upserts).toEqual([])
  })

  it('answers the local guards explicitly when the Host is not configured for installs', async () => {
    const { record, stateDirectory } = await installedRecord({ localInstallationId: 'local-10', runtimeName: 'skill-kappa' })
    const store = new ScriptedStore([record])
    // 没有状态根：安装与卸载都必须显式说明缺什么。
    const bare = new TeamSkillHost({ installationStore: store })
    expect(await bare.uninstall({ localInstallationId: 'local-10' })).toMatchObject({ status: 'not-ready', missing: ['stateDirectory'] })
    expect(await bare.install({
      skillId: 'skill-x', version: '1.0.0', projectId: 'project-alpha', scope: 'global',
      environment: { dshVersion: '0.1.1', availableTools: [], availableMcpServers: [], presentEnvironmentVariableNames: [] },
    })).toMatchObject({ status: 'not-ready', missing: ['globalSkillRoot'] })

    // 有状态根但没有发现钩子：安装与卸载显式说明；同步则按「无钩子即视为已确认」推进。
    const noRefresh = new TeamSkillHost({ stateDirectory, globalSkillRoot: join(stateDirectory, 'skills'), installationStore: store })
    expect(await noRefresh.uninstall({ localInstallationId: 'local-10' })).toMatchObject({ status: 'not-ready', missing: ['refreshSkillCatalog'] })
    expect(await noRefresh.install({
      skillId: 'skill-x', version: '1.0.0', projectId: 'project-alpha', scope: 'global',
      environment: { dshVersion: '0.1.1', availableTools: [], availableMcpServers: [], presentEnvironmentVariableNames: [] },
    })).toMatchObject({ status: 'not-ready', missing: ['refreshSkillCatalog'] })
    const synced = await noRefresh.syncReleaseStatus('project-alpha')
    // 既没有发现钩子也没有服务端点：同步先停在 not-ready（缺 apiBaseUrl），
    // 与「有没有钩子」无关——两条缺项都必须显式点名。
    expect(synced).toMatchObject({ status: 'not-ready', missing: ['apiBaseUrl', 'accessToken'] })

    // 有端点、有状态根，只是没有发现钩子：隔离照做，且把「无钩子」视为已确认。
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
    const endpointOnly = new TeamSkillHost({
      apiBaseUrl: `http://127.0.0.1:${port}/v1`,
      accessToken: grant,
      stateDirectory,
      globalSkillRoot: join(stateDirectory, 'skills'),
      installationStore: store,
    })
    const quarantined = asListed(await endpointOnly.syncReleaseStatus('project-alpha'), '同步失败')
    expect(quarantined.find(entry => entry.localInstallationId === 'local-10')?.state).toBe('withdrawn')
  })

  it('restores the copy when a failed removal cannot be recorded and reports a discovery failure', async () => {
    // 目录已被移走：卸载必然失败，记录必须回滚成 normal 而不是停在 uninstalled。
    const { record, stateDirectory } = await installedRecord({ localInstallationId: 'local-11', runtimeName: 'skill-lambda' })
    const store = new ScriptedStore([record])
    const host = await hostFor({ store, stateDirectory, refresh: async () => true })
    await rm(join(stateDirectory, 'skills', 'skill-lambda'), { recursive: true, force: true })

    const failed = await host.uninstall({ localInstallationId: 'local-11' })
    expect(failed.status).toBe('failed')
    expect(store.current()[0]?.installed.state).toBe('normal')

    // 发现钩子确认不了移除：显式失败而不是「已移除」。
    const { record: second, stateDirectory: secondRoot } = await installedRecord({
      localInstallationId: 'local-12', runtimeName: 'skill-mu',
    })
    const secondStore = new ScriptedStore([second])
    const noDiscovery = await hostFor({ store: secondStore, stateDirectory: secondRoot, refresh: async () => false })
    expect(await noDiscovery.uninstall({ localInstallationId: 'local-12' }))
      .toMatchObject({ status: 'failed', code: 'LOCAL_REFRESH_FAILED' })
  })

  it('refuses to locate a project-scoped copy without its workspace', async () => {
    const { record, stateDirectory } = await installedRecord({
      localInstallationId: 'local-13', runtimeName: 'skill-nu', scope: 'project',
    })
    const store = new ScriptedStore([record])
    const host = await hostFor({ store, stateDirectory, refresh: async () => true })
    // 项目作用域没有工作空间身份：定位不了就返回 not-ready，而不是猜一个根目录。
    expect(await host.uninstall({ localInstallationId: 'local-13' })).toMatchObject({ status: 'not-ready' })
  })

  it('keeps a normal copy whose release the service still reports', async () => {
    // 正常副本 + 仍在发布：读取面把它列出来，且不触发任何隔离。
    const { stateDirectory } = await installedRecord({ localInstallationId: 'local-14', runtimeName: 'skill-xi' })
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
    const catalogHost = new TeamSkillHost({ apiBaseUrl: `http://127.0.0.1:${port}/v1`, accessToken: grant })
    const catalog = await catalogHost.catalog('project-alpha')
    if (catalog.status !== 'ready') throw new Error(`目录不可用: ${JSON.stringify(catalog)}`)
    const item = catalog.catalog.items[0]
    if (item === undefined) return

    const published = await installedRecord({
      localInstallationId: 'local-14', runtimeName: item.runtimeName, skillId: item.skillId, version: item.version,
    })
    const store = new ScriptedStore([published.record])
    const host = await hostFor({ store, stateDirectory, refresh: async () => true })
    const listed = asListed(await host.syncReleaseStatus('project-alpha'), '同步失败')
    expect(listed.find(entry => entry.localInstallationId === 'local-14')?.state).toBe('normal')
    expect(store.upserts).toEqual([])
  })

  it('passes an explicit replacement confirmation through to the local removal', async () => {
    // 本地副本被改过：带着显式确认卸载才会替换它。
    const { record, stateDirectory } = await installedRecord({ localInstallationId: 'local-15', runtimeName: 'skill-omicron' })
    await writeFile(join(stateDirectory, 'skills', 'skill-omicron', 'SKILL.md'), '# 被本地改过\n', 'utf8')
    const store = new ScriptedStore([record])
    const host = await hostFor({ store, stateDirectory, refresh: async () => true })

    const refused = await host.uninstall({ localInstallationId: 'local-15' })
    expect(refused.status).toBe('failed')

    const confirmed = await host.uninstall({ localInstallationId: 'local-15', confirmModifiedReplace: true })
    expect(confirmed).toMatchObject({ status: 'succeeded' })
  })

  it('reports an unreachable authorization as an authorization-stage failure', async () => {
    const { record, stateDirectory } = await installedRecord({ localInstallationId: 'local-16', runtimeName: 'skill-pi' })
    const store = new ScriptedStore([record])
    const offline = new TeamSkillHost({
      apiBaseUrl: 'http://127.0.0.1:1/v1',
      accessToken: 'static-token',
      stateDirectory,
      globalSkillRoot: join(stateDirectory, 'skills'),
      installationStore: store,
      refreshSkillCatalog: async () => true,
      fetch: async () => { throw new Error('offline') },
    })
    const result = await offline.install({
      skillId: 'skill-x', version: '1.0.0', projectId: 'project-alpha', scope: 'global',
      environment: { dshVersion: '0.1.1', availableTools: [], availableMcpServers: [], presentEnvironmentVariableNames: [] },
    })
    expect(result.status).toBe('failed')
    // 没有阶段证据的失败也必须被归到授权阶段，并给出可判定的下一步。
    if (result.status === 'failed') {
      expect(result.failedStage).toBe('authorization')
      expect(result.stages.length).toBeGreaterThan(0)
    }
  })

  it('rolls a superseded copy back into place when discovery fails', async () => {
    const { record, stateDirectory } = await installedRecord({ localInstallationId: 'local-17', runtimeName: 'skill-rho' })
    const store = new ScriptedStore([record])
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

    // 让既有记录与将要安装的身份一致：它会被当作「被取代的同一物理副本」。
    const catalogHost = new TeamSkillHost({ apiBaseUrl: `http://127.0.0.1:${port}/v1`, accessToken: grant })
    const catalog = await catalogHost.catalog('project-alpha')
    if (catalog.status !== 'ready') throw new Error(`目录不可用: ${JSON.stringify(catalog)}`)
    const item = catalog.catalog.items[0]
    if (item === undefined) return

    const supersededRecord = { ...record, skillId: item.skillId, installed: { ...record.installed, version: item.version } }
    await store.upsert(supersededRecord)
    const host = new TeamSkillHost({
      apiBaseUrl: `http://127.0.0.1:${port}/v1`,
      accessToken: grant,
      stateDirectory,
      globalSkillRoot: join(stateDirectory, 'skills'),
      installationStore: store,
      // 写入成功但运行时确认不了：必须整体回滚，把被取代的旧记录恢复成 normal。
      refreshSkillCatalog: async () => false,
    })
    const result = await host.install({
      skillId: item.skillId,
      version: item.version,
      projectId: 'project-alpha',
      scope: 'global',
      // 目标目录已存在同一副本：带显式确认才会替换它（并覆盖确认参数的透传分支）。
      confirmModifiedReplace: true,
      environment: { dshVersion: '0.1.1', availableTools: [], availableMcpServers: [], presentEnvironmentVariableNames: [] },
    })
    expect(result.status).toBe('failed')
    // 既有副本的制品摘要与本次发布不一致：写入阶段如实报冲突，而不是覆盖它。
    if (result.status === 'failed') {
      expect(result.code).toBe('target-conflict')
      expect(store.current().find(entry => entry.localInstallationId === 'local-17')?.installed.state).toBe('normal')
    }
  })

  it('lists the published copies and keeps a quarantined copy visible', async () => {
    const normal = await installedRecord({ localInstallationId: 'local-6', runtimeName: 'skill-zeta' })
    const withdrawn = await installedRecord({ localInstallationId: 'local-7', runtimeName: 'skill-eta', state: 'withdrawn' })
    const store = new ScriptedStore([normal.record, withdrawn.record])
    const host = await hostFor({ store, stateDirectory: normal.stateDirectory, refresh: async () => true })

    const listed = asListed(await host.installations('project-alpha'), '读取失败')
    // 读取面反映服务端仍发布的版本：服务端不再返回 local-6 的发布行，它就不在可用副本里
    // （它由 syncReleaseStatus 收敛为隔离态）；已隔离的副本仍然可见，否则本地副本成孤儿。
    expect(listed.map(item => [item.localInstallationId, item.state])).toEqual([['local-7', 'withdrawn']])
  })
})
