import { access, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AddressInfo } from 'node:net'
/* oxlint-disable typescript/no-base-to-string -- Fetch spy assertions inspect RequestInfo wire values. */
/* oxlint-disable typescript/no-unsafe-assignment -- The integration fetch seam intentionally forwards native fetch tuples. */
/* oxlint-disable typescript/no-unsafe-argument -- The integration fetch seam intentionally forwards native fetch tuples. */
/* oxlint-disable typescript/no-unsafe-member-access -- The integration fetch seam reads opaque mock response fields. */
import { strToU8, zipSync } from 'fflate'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import type { CredentialProvider, CredentialRecord, CredentialKey } from '@deepseek-ai/dsh-credentials'
import { createTeamSkillService } from '../dev/team-skill-service/src/server.ts'
import { TeamSkillHost } from '../src/host.ts'

async function bodyOf(response: Response): Promise<unknown> {
  const value: unknown = await response.json()
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return value
  const record = value as Record<string, unknown>
  return record.code === 0 && Object.hasOwn(record, 'data') ? record.data : value
}

const services: ReturnType<typeof createTeamSkillService>[] = []
const roots: string[] = []

function accountGrantPayload(record: CredentialRecord | undefined): { readonly accessToken: string; readonly record: object } {
  if (
    record === undefined ||
    record.kind !== 'grant' ||
    typeof record.payload !== 'object' ||
    record.payload === null ||
    !('accessToken' in record.payload) ||
    typeof record.payload.accessToken !== 'string'
  ) {
    throw new Error('Expected Host account grant payload.')
  }
  return { accessToken: record.payload.accessToken, record: record.payload }
}

afterEach(async () => {
  for (const service of services.splice(0)) {
    service.server.closeAllConnections()
    await new Promise<void>((resolve) => {
      service.server.close(() => {
        resolve()
      })
    })
  }
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('Team Skill service and Host integration', () => {
  it('keeps account tokens in Host credentials and exposes only browser-safe state', async () => {
    const service = createTeamSkillService({ port: 0 })
    services.push(service)
    await service.listen()
    const port = (service.server.address() as AddressInfo).port
    const records = new Map<CredentialKey, CredentialRecord>()
    const credentials = {
      readRecord: async (key: CredentialKey) => records.get(key),
      modifyRecord: async (
        key: CredentialKey,
        mutate: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>,
      ) => {
        const next = await mutate(records.get(key))
        if (next !== undefined) records.set(key, next)
        return next
      },
      deleteRecord: async (key: CredentialKey) => {
        records.delete(key)
      },
    } as unknown as CredentialProvider
    const root = await mkdtemp(join(tmpdir(), 'dsh-team-skill-account-e2e-'))
    roots.push(root)
    const host = new TeamSkillHost({
      apiBaseUrl: `http://127.0.0.1:${port}/v1`,
      credentials,
      stateDirectory: join(root, 'state'),
      globalSkillRoot: join(root, 'global-skills'),
    })

    const loggedIn = await host.login({ username: 'manager@example.com', password: 'manager-pass' })
    expect(loggedIn).toMatchObject({ status: 'authenticated', user: { userId: 'manager-1' }, mustChangePassword: false })
    expect(JSON.stringify(loggedIn)).not.toContain('access-')
    expect(await credentials.readRecord(credentialKey('dsh-ai-coding-platform', 'account'))).toMatchObject({ kind: 'grant' })
    expect(await host.account()).toMatchObject({ status: 'authenticated', user: { displayName: '组织经理' } })
    expect(await host.accessSummary()).toMatchObject({
      organizations: expect.arrayContaining([expect.objectContaining({ organizationId: 'org-alpha' })]),
      projects: expect.arrayContaining([expect.objectContaining({ projectId: 'project-alpha' })]),
      assets: expect.arrayContaining([expect.objectContaining({ assetId: 'project-alpha', assetType: 'project' })]),
    })
    expect(await host.catalog('project-alpha')).toMatchObject({ status: 'ready', catalog: { items: [{ skillId: 'code-review' }] } })
    expect(await host.refreshAccount()).toMatchObject({ status: 'authenticated' })
    expect(await host.logout()).toEqual({ status: 'signed-out' })
    expect(await credentials.readRecord(credentialKey('dsh-ai-coding-platform', 'account'))).toBeUndefined()
  })

  it('refreshes an expired Host credential before reading a project catalog', async () => {
    const service = createTeamSkillService({ port: 0 })
    services.push(service)
    await service.listen()
    const port = (service.server.address() as AddressInfo).port
    const records = new Map<CredentialKey, CredentialRecord>()
    const credentials = {
      readRecord: async (key: CredentialKey) => records.get(key),
      modifyRecord: async (
        key: CredentialKey,
        mutate: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>,
      ) => {
        const next = await mutate(records.get(key))
        if (next !== undefined) records.set(key, next)
        return next
      },
      deleteRecord: async (key: CredentialKey) => {
        records.delete(key)
      },
    } as unknown as CredentialProvider
    const root = await mkdtemp(join(tmpdir(), 'dsh-team-skill-expired-'))
    roots.push(root)
    const expired = { accessToken: undefined as string | undefined }
    const fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const authorization = new Headers(init?.headers).get('authorization')
      if (expired.accessToken !== undefined && authorization === `Bearer ${expired.accessToken}` && String(input).includes('/team-skills?')) {
        return new Response(JSON.stringify({ code: 'TOKEN_EXPIRED', message: '会话已过期', request_id: 'expired-request', data: null }), {
          status: 401,
          headers: { 'content-type': 'application/json' },
        })
      }
      return globalThis.fetch(input, init)
    }
    const host = new TeamSkillHost({
      apiBaseUrl: `http://127.0.0.1:${port}/v1`,
      credentials,
      fetch,
      stateDirectory: join(root, 'state'),
      globalSkillRoot: join(root, 'global-skills'),
    })
    expect((await host.login({ username: 'manager@example.com', password: 'manager-pass' })).status).toBe('authenticated')
    const key = credentialKey('dsh-ai-coding-platform', 'account')
    const current = await credentials.readRecord(key)
    if (current === undefined || current.kind !== 'grant') throw new Error('Expected Host grant credential.')
    const currentPayload = accountGrantPayload(current)
    expired.accessToken = currentPayload.accessToken
    records.set(key, { ...current, payload: { ...currentPayload.record, expiresAt: 0 } })

    const catalog = await host.catalog('project-alpha')
    expect(catalog).toMatchObject({ status: 'ready', catalog: { items: [{ skillId: 'code-review' }] } })
    const refreshed = await credentials.readRecord(key)
    if (refreshed === undefined || refreshed.kind !== 'grant') throw new Error('Expected refreshed Host grant credential.')
    expect(accountGrantPayload(refreshed).accessToken).not.toBe(expired.accessToken)
  })

  it('clears a Host session rejected after the in-memory service restarts', async () => {
    const firstService = createTeamSkillService({ port: 0 })
    // 登录等断言可能失败：先登记清理，afterEach 才能在异常路径关闭首个实例。
    services.push(firstService)
    await firstService.listen()
    const port = (firstService.server.address() as AddressInfo).port
    const records = new Map<CredentialKey, CredentialRecord>()
    const credentials = {
      readRecord: async (key: CredentialKey) => records.get(key),
      modifyRecord: async (
        key: CredentialKey,
        mutate: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>,
      ) => {
        const next = await mutate(records.get(key))
        if (next !== undefined) records.set(key, next)
        return next
      },
      deleteRecord: async (key: CredentialKey) => {
        records.delete(key)
      },
    } as unknown as CredentialProvider
    const root = await mkdtemp(join(tmpdir(), 'dsh-team-skill-restarted-'))
    roots.push(root)
    const host = new TeamSkillHost({
      apiBaseUrl: `http://127.0.0.1:${port}/v1`,
      credentials,
      stateDirectory: join(root, 'state'),
      globalSkillRoot: join(root, 'global-skills'),
    })

    expect((await host.login({ username: 'member@example.com', password: 'member-pass' })).status).toBe('authenticated')
    const key = credentialKey('dsh-ai-coding-platform', 'account')
    expect(await credentials.readRecord(key)).toMatchObject({ kind: 'grant' })
    firstService.server.closeAllConnections()
    await new Promise<void>((resolve, reject) => {
      firstService.server.close((error) => {
        if (error === undefined) resolve()
        else reject(error)
      })
    })
    // 重启绑定同一实际端口：旧会话在内存中丢失，旧凭据必须失效。
    const restartedService = createTeamSkillService({ port })
    services.push(restartedService)
    await restartedService.listen()
    // 服务端 closeAllConnections 会强断旧 keep-alive socket；同端口重启后，客户端
    // undici 池里可能残留多个半死连接——其上的请求（尤其非幂等的 POST refresh）
    // 既不报错也不返回，且 undici 不会重试。串行探活只会复用健康 socket，碰不到
    // 死连接；这里先并发探活强制打开新连接，把池中的死 socket 全部顶出并由 300ms
    // 超时中止销毁，再串行确认到新实例的干净连接，host.account() 才开始断言。
    const probe = (): Promise<boolean> =>
      fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(300) })
        .then(response => response.ok)
        .catch(() => false)
    for (let round = 0; round < 4; round += 1) {
      await Promise.allSettled([probe(), probe(), probe(), probe()])
    }
    for (let attempt = 0; ; attempt += 1) {
      if (await probe()) break
      if (attempt > 12) throw new Error('restarted fixture service did not become reachable')
      await new Promise(resolve => setTimeout(resolve, 20))
    }

    expect(await host.account()).toEqual({ status: 'signed-out' })
    expect(await credentials.readRecord(key)).toBeUndefined()
  })

  it('installs a published service artifact into the DSH project root and records the result', async () => {
    const service = createTeamSkillService({ port: 0 })
    services.push(service)
    await service.listen()
    const port = (service.server.address() as AddressInfo).port
    const root = await mkdtemp(join(tmpdir(), 'dsh-team-skill-e2e-'))
    roots.push(root)
    const project = join(root, 'project')
    const host = new TeamSkillHost({
      apiBaseUrl: `http://127.0.0.1:${port}/v1`,
      accessToken: 'demo-token',
      stateDirectory: join(root, 'state'),
      globalSkillRoot: join(root, 'global-skills'),
      resolveWorkspace: workspaceId => (workspaceId === 'workspace-1' ? project : undefined),
      refreshSkillCatalog: async (_scope, workspacePath, runtimeName) => {
        return await readFile(join(workspacePath ?? root, '.dsh', 'skills', runtimeName, 'SKILL.md'), 'utf8').then(
          () => true,
          () => false,
        )
      },
    })

    const catalog = await host.catalog('project-alpha')
    expect(catalog.status).toBe('ready')
    if (catalog.status !== 'ready') return
    const item = catalog.catalog.items[0]!
    const result = await host.install({
      skillId: item.skillId,
      version: item.version,
      projectId: 'project-alpha',
      scope: 'project',
      workspaceId: 'workspace-1',
      environment: { dshVersion: '0.1.1', availableTools: [], availableMcpServers: [], presentEnvironmentVariableNames: [] },
    })

    expect(result.status).toBe('succeeded')
    expect(await readFile(join(project, '.dsh', 'skills', item.runtimeName, 'SKILL.md'), 'utf8')).toContain('代码评审')
    const completed = service.audits.filter(audit => audit.action === '本地安装完成')
    expect(completed).toHaveLength(1)
    expect(completed[0]).toMatchObject({ skillName: 'code-review', version: '1.0.0', scope: 'project', result: 'succeeded' })
    expect(JSON.stringify(completed)).not.toContain(project)
  })

  it('runs author governance, Host installation, withdrawal and quarantine over real HTTP', async () => {
    const service = createTeamSkillService({ port: 0, seed: false })
    services.push(service)
    await service.listen()
    const port = (service.server.address() as AddressInfo).port
    const root = await mkdtemp(join(tmpdir(), 'dsh-team-skill-full-flow-'))
    roots.push(root)
    const baseUrl = `http://127.0.0.1:${port}/v1`
    const authorHeaders = { authorization: 'Bearer manager-demo', 'content-type': 'application/json' }
    const adminHeaders = { authorization: 'Bearer admin-demo', 'content-type': 'application/json' }

    const createdResponse = await fetch(`${baseUrl}/admin/team-skills`, {
      method: 'POST',
      headers: { ...authorHeaders, 'idempotency-key': 'flow-draft' },
      body: JSON.stringify({ display_name: 'E2E Team Skill', summary: '端到端联调 Skill', visibility: 'organization' }),
    })
    expect(createdResponse.status).toBe(201)
    const created = (await bodyOf(createdResponse)) as { skillId: string; revision: number; runtimeName: string }
    const detailResponse = await fetch(`${baseUrl}/admin/team-skills/${created.skillId}`, { headers: authorHeaders })
    const detail = (await bodyOf(detailResponse)) as { skill: { revision: number }; versions: Array<{ version: string; revision: number }> }
    const draftVersion = detail.versions[0]!
    const artifact = zipSync({
      'SKILL.md': strToU8(`---\nname: ${created.runtimeName}\ndescription: 端到端联调 Skill\n---\n\n# E2E Team Skill\n`),
    })
    const uploadedResponse = await fetch(`${baseUrl}/admin/team-skills/${created.skillId}/versions/${draftVersion.version}/artifact`, {
      method: 'PUT',
      headers: {
        ...authorHeaders,
        'content-type': 'application/zip',
        'if-match': String(draftVersion.revision),
        'idempotency-key': 'flow-artifact',
      },
      body: artifact,
    })
    expect(uploadedResponse.status).toBe(200)
    const uploaded = (await bodyOf(uploadedResponse)) as {
      skill: { revision: number }
      version: { version: string; revision: number; validation: Array<{ status: string }> }
    }
    expect(uploaded.version.validation.every(item => item.status === 'passed')).toBe(true)

    const submittedResponse = await fetch(
      `${baseUrl}/admin/team-skills/${created.skillId}/versions/${uploaded.version.version}/submit-review`,
      {
        method: 'POST',
        headers: {
          ...authorHeaders,
          'if-match': String(uploaded.version.revision),
          'x-skill-revision': String(uploaded.skill.revision),
          'idempotency-key': 'flow-submit',
        },
        body: '{}',
      },
    )
    expect(submittedResponse.status).toBe(200)
    const reviewResponse = await fetch(`${baseUrl}/admin/team-skill-reviews`, { headers: adminHeaders })
    const review = (
      (await bodyOf(reviewResponse)) as Array<{ skill: { revision: number }; version: { version: string; revision: number } }>
    )[0]!
    const approvedResponse = await fetch(`${baseUrl}/admin/team-skills/${created.skillId}/versions/${review.version.version}/approve`, {
      method: 'POST',
      headers: {
        ...adminHeaders,
        'if-match': String(review.version.revision),
        'x-skill-revision': String(review.skill.revision),
        'idempotency-key': 'flow-approve',
      },
      body: JSON.stringify({ checks: { 'check-1': 'pass', 'check-2': 'pass', 'check-3': 'pass' } }),
    })
    expect(approvedResponse.status).toBe(200)
    const approved = (await bodyOf(approvedResponse)) as { skill: { revision: number }; version: { version: string; revision: number } }
    const publishedResponse = await fetch(`${baseUrl}/admin/team-skills/${created.skillId}/versions/${approved.version.version}/publish`, {
      method: 'POST',
      headers: {
        ...adminHeaders,
        'if-match': String(approved.version.revision),
        'x-skill-revision': String(approved.skill.revision),
        'idempotency-key': 'flow-publish',
      },
      body: '{}',
    })
    expect(publishedResponse.status).toBe(200)
    const published = (await bodyOf(publishedResponse)) as { skill: { revision: number }; version: { version: string; revision: number } }

    const unboundCatalog = await fetch(`${baseUrl}/team-skills?project_id=project-alpha`, {
      headers: { authorization: 'Bearer demo-token' },
    })
    expect(
      ((await bodyOf(unboundCatalog)) as { items: Array<{ skill_id: string }> }).items.some(
        value => value.skill_id === created.skillId,
      ),
    ).toBe(false)
    const projectResponse = await fetch(`${baseUrl}/admin/projects/project-alpha`, { headers: adminHeaders })
    const projectRevision = ((await bodyOf(projectResponse)) as { revision: number }).revision
    const boundResponse = await fetch(`${baseUrl}/admin/projects/project-alpha/assets`, {
      method: 'POST',
      headers: { ...adminHeaders, 'if-match': String(projectRevision), 'idempotency-key': 'flow-bind' },
      body: JSON.stringify({ asset_type: 'skill', asset_id: created.skillId, relation_kind: 'reference' }),
    })
    expect(boundResponse.status).toBe(201)

    const host = new TeamSkillHost({
      apiBaseUrl: baseUrl,
      accessToken: 'demo-token',
      stateDirectory: join(root, 'state'),
      globalSkillRoot: join(root, 'global-skills'),
      refreshSkillCatalog: async (_scope, _workspacePath, runtimeName, expectedPresent = true) =>
        access(join(root, 'global-skills', runtimeName, 'SKILL.md')).then(
          () => expectedPresent,
          () => !expectedPresent,
        ),
    })
    const catalog = await host.catalog('project-alpha')
    expect(catalog.status).toBe('ready')
    if (catalog.status !== 'ready') return
    const item = catalog.catalog.items.find(value => value.skillId === created.skillId)
    expect(item).toBeDefined()
    if (item === undefined) return
    const installed = await host.install({
      skillId: item.skillId,
      version: item.version,
      projectId: 'project-alpha',
      scope: 'global',
      environment: { dshVersion: '0.1.1', availableTools: [], availableMcpServers: [], presentEnvironmentVariableNames: [] },
    })
    expect(installed.status).toBe('succeeded')
    expect(await readFile(join(root, 'global-skills', item.runtimeName, 'SKILL.md'), 'utf8')).toContain('E2E Team Skill')

    const withdrawnResponse = await fetch(
      `${baseUrl}/admin/team-skills/${created.skillId}/versions/${published.version.version}/withdraw`,
      {
        method: 'POST',
        headers: {
          ...adminHeaders,
          'if-match': String(published.version.revision),
          'x-skill-revision': String(published.skill.revision),
          'idempotency-key': 'flow-withdraw',
        },
        body: JSON.stringify({ reason: '端到端回归下线' }),
      },
    )
    expect(withdrawnResponse.status).toBe(200)
    const synced = await host.syncReleaseStatus('project-alpha')
    expect(synced).toMatchObject([{ skillId: created.skillId, state: 'withdrawn', version: published.version.version }])
    await expect(access(join(root, 'global-skills', item.runtimeName))).rejects.toThrow()
    if (!Array.isArray(synced)) return
    const withdrawn = synced.find(value => value.skillId === created.skillId)
    expect(withdrawn).toBeDefined()
    if (withdrawn === undefined) return
    expect(
      await readFile(join(root, 'state', 'quarantine', withdrawn.localInstallationId, item.runtimeName, 'SKILL.md'), 'utf8'),
    ).toContain('E2E Team Skill')
  })
})
