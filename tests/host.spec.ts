import { createHash } from 'node:crypto'
import { access, mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
/* oxlint-disable typescript/no-base-to-string -- Fetch spy assertions inspect RequestInfo and BodyInit wire values. */
/* oxlint-disable typescript/no-unsafe-assignment -- Vitest asymmetric matchers are typed as any. */
import { zipSync, strToU8 } from 'fflate'
import { TeamSkillHost } from '../src/host.ts'
import { TeamSkillInstallationStore, type TeamSkillInstallationStoreLike } from '../src/installation-store.ts'
import type { TeamSkillInstallationRecord } from '../src/types.ts'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import type { CredentialProvider, CredentialRecord, CredentialKey } from '@deepseek-ai/dsh-credentials'

const RUNTIME_NAME = 'aicp-code-review'
const VERSION = '1.2.0'

function sha256(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

function artifact(): Uint8Array {
  return zipSync({
    'SKILL.md': strToU8(`---\nname: ${RUNTIME_NAME}\ndescription: 团队代码评审流程\n---\n`),
  })
}

function response(body: unknown, init: ResponseInit = {}): Response {
  const status = init.status ?? 200
  const record = typeof body === 'object' && body !== null && !Array.isArray(body) ? body as Record<string, unknown> : undefined
  const envelope = status >= 400
    ? { code: typeof record?.code === 'string' ? record.code : `HTTP_${status}`, message: typeof record?.message === 'string' ? record.message : 'failed', request_id: 'test-request', data: null }
    : { code: 0, message: 'ok', request_id: 'test-request', data: body }
  return new Response(JSON.stringify(envelope), {
    headers: { 'content-type': 'application/json' },
    ...init,
  })
}

function memoryCredentials(records: Map<CredentialKey, CredentialRecord>): CredentialProvider {
  return {
    readRecord: async (recordKey: CredentialKey) => records.get(recordKey),
    modifyRecord: async (
      recordKey: CredentialKey,
      mutate: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>,
    ) => {
      const next = await mutate(records.get(recordKey))
      if (next === undefined) records.delete(recordKey)
      else records.set(recordKey, next)
      return next
    },
    deleteRecord: async (recordKey: CredentialKey) => {
      records.delete(recordKey)
    },
  } as unknown as CredentialProvider
}

interface StoredGrant {
  accessToken: string
  refreshToken: string
}

async function credentials_read(records: Map<CredentialKey, CredentialRecord>, key: CredentialKey): Promise<StoredGrant> {
  const record = records.get(key)
  if (record === undefined || record.kind !== 'grant') throw new Error('grant missing')
  const payload = record.payload as { accessToken: string; refreshToken: string }
  return payload
}

const ACCOUNT_USER = {
  user_id: 'u-1',
  username: 'u@example.com',
  email: 'u@example.com',
  display_name: 'User',
  status: 'active',
  global_role: 'member',
  must_change_password: false,
  revision: 1,
}

describe('TeamSkillHost', () => {
  it('coalesces concurrent refreshes and does not delete a newer credential after a stale refresh fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-team-skill-refresh-'))
    const key = credentialKey('dsh-ai-coding-platform', 'account')
    const records = new Map<CredentialKey, CredentialRecord>([
      [
        key,
        {
          kind: 'grant',
          payload: { userId: 'user-1', accessToken: 'old-access', refreshToken: 'refresh-one', expiresAt: 0 },
        },
      ],
    ])
    let rejectRefresh: ((error: Error) => void) | undefined
    const refreshGate = new Promise<void>((_resolve, reject) => {
      rejectRefresh = reject
    })
    let refreshCalls = 0
    const credentials = {
      readRecord: async (recordKey: CredentialKey) => records.get(recordKey),
      modifyRecord: async (
        recordKey: CredentialKey,
        mutate: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>,
      ) => {
        const next = await mutate(records.get(recordKey))
        if (next === undefined) records.delete(recordKey)
        else records.set(recordKey, next)
        return next
      },
      deleteRecord: async (recordKey: CredentialKey) => {
        records.delete(recordKey)
      },
    } as unknown as CredentialProvider
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const url = String(input)
      if (url.endsWith('/auth/refresh')) {
        refreshCalls += 1
        await refreshGate
        return response({
          access_token: 'new-access',
          refresh_token: 'new-refresh',
          expires_in: 900,
          user: { user_id: 'u-1', username: 'u@example.com', email: 'u@example.com', display_name: 'User', status: 'active', global_role: 'member', must_change_password: false, revision: 1 },
          memberships: [],
        })
      }
      if (url.endsWith('/me')) return response({ user: { user_id: 'u-1', username: 'u@example.com', email: 'u@example.com', display_name: 'User', status: 'active', global_role: 'member', must_change_password: false, revision: 1 }, memberships: [] })
      throw new Error(`unexpected request ${url} ${JSON.stringify(init)}`)
    })
    const host = new TeamSkillHost({
      apiBaseUrl: 'https://service.example/v1',
      credentials,
      fetch,
      stateDirectory: join(root, 'state'),
      globalSkillRoot: join(root, 'global-skills'),
    })

    const first = host.account()
    await new Promise<void>(resolve => setTimeout(resolve, 0))
    const second = host.account()
    await new Promise<void>(resolve => setTimeout(resolve, 0))
    expect(refreshCalls).toBe(1)
    await credentials.modifyRecord(key, async () => ({ kind: 'grant', payload: { userId: 'user-1', accessToken: 'newer-access', refreshToken: 'newer-refresh', expiresAt: Date.now() + 60_000 } }))
    rejectRefresh?.(new Error('stale refresh failed'))
    await expect(first).resolves.toMatchObject({ status: 'failed' })
    await expect(second).resolves.toMatchObject({ status: 'failed' })
    await expect(credentials.readRecord(key)).resolves.toMatchObject({ payload: { accessToken: 'newer-access', refreshToken: 'newer-refresh' } })
  })
  it('reports not-ready without a configured service endpoint and token', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-team-skill-host-'))
    const host = new TeamSkillHost({ stateDirectory: root })

    expect(await host.catalog('project-alpha')).toEqual({
      status: 'not-ready',
      missing: ['apiBaseUrl', 'accessToken'],
    })
  })

  it('installs an authorized platform artifact and reports progress without a local path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-team-skill-host-'))
    const projectRoot = join(root, 'project')
    const archive = artifact()
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        response({
          operation_id: 'operation-1',
          status: 'authorized',
          skill_id: 'skill-1',
          runtime_name: RUNTIME_NAME,
          version: VERSION,
          artifact: {
            download_url: 'https://service.example.test/downloads/operation-1',
            expires_at: '2026-08-29T12:00:00Z',
            sha256: sha256(archive),
            size_bytes: archive.byteLength,
            files: [{ path: 'SKILL.md', sha256: sha256(strToU8(`---\nname: ${RUNTIME_NAME}\ndescription: 团队代码评审流程\n---\n`)) }],
          },
        }),
      )
      .mockResolvedValueOnce(response({ accepted: true }))
      .mockResolvedValueOnce(new Response(new Uint8Array(archive).buffer))
      .mockImplementation(async input =>
        String(input).includes('/team-skills/release-status')
          ? response({ items: [{ skill_id: 'skill-1', project_id: 'project-alpha', version: VERSION, status: 'published' }] })
          : response({ accepted: true }),
      )
    const host = new TeamSkillHost({
      apiBaseUrl: 'https://service.example.test/v1',
      accessToken: 'token-1',
      stateDirectory: join(root, 'state'),
      globalSkillRoot: join(root, 'global-skills'),
      fetch,
      resolveWorkspace: id => (id === 'workspace-1' ? projectRoot : undefined),
      refreshSkillCatalog: async () => true,
    })

    const result = await host.install({
      skillId: 'skill-1',
      version: VERSION,
      projectId: 'project-alpha',
      scope: 'project',
      workspaceId: 'workspace-1',
      environment: {
        dshVersion: '0.1.1',
        availableTools: [],
        availableMcpServers: [],
        presentEnvironmentVariableNames: [],
      },
    })

    expect(result.status).toBe('succeeded')
    expect(result).not.toHaveProperty('installation.installed.directory')
    // §11.14：成功安装同样携带七阶段证据，未发生的回滚必须是 skipped。
    expect(result).toMatchObject({
      failedStage: null,
      retryable: { retryable: false },
      stages: [
        { stage: 'authorization', outcome: 'succeeded' },
        { stage: 'precheck', outcome: 'succeeded' },
        { stage: 'download', outcome: 'succeeded' },
        { stage: 'verify', outcome: 'succeeded' },
        { stage: 'write', outcome: 'succeeded' },
        { stage: 'discovery', outcome: 'succeeded' },
        { stage: 'rollback', outcome: 'skipped' },
      ],
    })
    const installations = await host.installations('project-alpha')
    expect(installations).toHaveLength(1)
    expect(installations).toMatchObject([{ projectId: 'project-alpha' }])
    expect(installations).not.toHaveProperty('0.installed.directory')
    expect(await host.installations('project-beta')).toEqual([])
    expect(await readFile(join(projectRoot, '.dsh', 'skills', RUNTIME_NAME, 'SKILL.md'), 'utf8')).toContain('团队代码评审流程')
    expect(fetch.mock.calls[0]).toMatchObject([
      'https://service.example.test/v1/team-skill-installations',
      {
        method: 'POST',
        headers: expect.objectContaining({ authorization: 'Bearer token-1' }),
      },
    ])
    const eventBodies = fetch.mock.calls
      .filter(([url]) => String(url).includes('/events'))
      .map(([, init]) => parseJsonBody(init?.body))
    expect(eventBodies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: 'downloading', event_sequence: 1 }),
        expect.objectContaining({ status: 'succeeded' }),
      ]),
    )
    expect(JSON.stringify(eventBodies)).not.toContain(projectRoot)
  })

  it('uninstalls a managed copy and confirms that native discovery no longer sees it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-team-skill-host-'))
    const archive = artifact()
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        response({
          operation_id: 'operation-1',
          status: 'authorized',
          skill_id: 'skill-1',
          runtime_name: RUNTIME_NAME,
          version: VERSION,
          artifact: {
            download_url: 'https://service.example.test/downloads/operation-1',
            expires_at: '2026-08-29T12:00:00Z',
            sha256: sha256(archive),
            size_bytes: archive.byteLength,
            files: [{ path: 'SKILL.md', sha256: sha256(strToU8(`---\nname: ${RUNTIME_NAME}\ndescription: 团队代码评审流程\n---\n`)) }],
          },
        }),
      )
      .mockResolvedValueOnce(response({ accepted: true }))
      .mockResolvedValueOnce(new Response(new Uint8Array(archive).buffer))
      .mockImplementation(async () => response({ accepted: true }))
    const discovered: boolean[] = []
    const host = new TeamSkillHost({
      apiBaseUrl: 'https://service.example.test/v1',
      accessToken: 'token-1',
      stateDirectory: join(root, 'state'),
      globalSkillRoot: join(root, 'global-skills'),
      fetch,
      refreshSkillCatalog: async (_scope, _workspacePath, _runtimeName, expectedPresent = true) => {
        discovered.push(expectedPresent)
        return true
      },
    })
    const installed = await host.install({
      skillId: 'skill-1',
      version: VERSION,
      projectId: 'project-alpha',
      scope: 'global',
      environment: { dshVersion: '0.1.1', availableTools: [], availableMcpServers: [], presentEnvironmentVariableNames: [] },
    })
    expect(installed.status).toBe('succeeded')
    if (installed.status !== 'succeeded') return
    const removed = await host.uninstall({ localInstallationId: installed.installation.localInstallationId })
    expect(removed).toMatchObject({ status: 'succeeded', installation: { state: 'uninstalled' } })
    expect(discovered).toEqual([true, false])
  })

  it('keeps per-project authorization records and transfers physical ownership on a second global install', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-team-skill-host-'))
    const archive = artifact()
    const authorizeResponse = () =>
      response({
        operation_id: 'operation-1',
        status: 'authorized',
        skill_id: 'skill-1',
        runtime_name: RUNTIME_NAME,
        version: VERSION,
        artifact: {
          download_url: 'https://service.example.test/downloads/operation-1',
          expires_at: '2026-08-29T12:00:00Z',
          sha256: sha256(archive),
          size_bytes: archive.byteLength,
          files: [{ path: 'SKILL.md', sha256: sha256(strToU8(`---
name: ${RUNTIME_NAME}
description: 团队代码评审流程
---
`)) }],
        },
      })
    const pendingAuthorizations = 2
    let authorizationsIssued = 0
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
      const url = String(input)
      if (url.endsWith('/team-skill-installations')) {
        authorizationsIssued += 1
        return authorizationsIssued <= pendingAuthorizations
          ? authorizeResponse()
          : response({ accepted: true })
      }
      if (url.includes('/downloads/')) return new Response(new Uint8Array(archive).buffer)
      if (url.includes('/team-skills/release-status'))
        return response({
          items: [
            { skill_id: 'skill-1', project_id: 'project-alpha', version: VERSION, status: 'published' },
            { skill_id: 'skill-1', project_id: 'project-beta', version: VERSION, status: 'published' },
          ],
        })
      return response({ accepted: true })
    })
    const host = new TeamSkillHost({
      apiBaseUrl: 'https://service.example.test/v1',
      accessToken: 'token-1',
      stateDirectory: join(root, 'state'),
      globalSkillRoot: join(root, 'global-skills'),
      fetch,
      refreshSkillCatalog: async () => true,
    })
    const installRequest = {
      skillId: 'skill-1',
      version: VERSION,
      scope: 'global' as const,
      environment: { dshVersion: '0.1.1', availableTools: [], availableMcpServers: [], presentEnvironmentVariableNames: [] },
    }
    const first = await host.install({ ...installRequest, projectId: 'project-alpha' })
    expect(first.status).toBe('succeeded')
    const second = await host.install({ ...installRequest, projectId: 'project-beta' })
    expect(second.status).toBe('succeeded')

    const alphaInstallations = await host.installations('project-alpha')
    expect(alphaInstallations).toHaveLength(1)
    expect(alphaInstallations).toMatchObject([{ projectId: 'project-alpha', state: 'uninstalled' }])
    const betaInstallations = await host.installations('project-beta')
    expect(betaInstallations).toHaveLength(1)
    expect(betaInstallations).toMatchObject([{ projectId: 'project-beta', state: 'normal' }])

    if (second.status !== 'succeeded') return
    const removed = await host.uninstall({ localInstallationId: second.installation.localInstallationId })
    expect(removed).toMatchObject({ status: 'succeeded', installation: { state: 'uninstalled' } })
    expect(await host.installations('project-alpha')).toMatchObject([{ projectId: 'project-alpha', state: 'uninstalled' }])
    expect(await host.installations('project-beta')).toMatchObject([{ projectId: 'project-beta', state: 'uninstalled' }])
  })

  it('restores the prior physical copy and record when ownership transfer persistence fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-team-skill-host-'))
    const archive = artifact()
    const baseStore = new TeamSkillInstallationStore(join(root, 'state'))
    let authorizationCalls = 0
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
      const url = String(input)
      if (url.endsWith('/team-skill-installations')) {
        authorizationCalls += 1
        return response({
          operation_id: `operation-${authorizationCalls}`,
          status: 'authorized',
          skill_id: 'skill-1',
          runtime_name: RUNTIME_NAME,
          version: VERSION,
          artifact: {
            download_url: `https://service.example.test/downloads/operation-${authorizationCalls}`,
            expires_at: '2026-08-29T12:00:00Z',
            sha256: sha256(archive),
            size_bytes: archive.byteLength,
            files: [{ path: 'SKILL.md', sha256: sha256(strToU8(`---\nname: ${RUNTIME_NAME}\ndescription: 团队代码评审流程\n---\n`)) }],
          },
        })
      }
      if (url.includes('/downloads/')) return new Response(new Uint8Array(archive).buffer)
      return response({ accepted: true })
    })
    const common = {
      apiBaseUrl: 'https://service.example.test/v1',
      accessToken: 'token-1',
      stateDirectory: join(root, 'state'),
      globalSkillRoot: join(root, 'global-skills'),
      fetch,
      refreshSkillCatalog: async () => true,
    } as const
    const firstHost = new TeamSkillHost({ ...common, installationStore: baseStore })
    const first = await firstHost.install({
      skillId: 'skill-1',
      version: VERSION,
      projectId: 'project-alpha',
      scope: 'global',
      environment: { dshVersion: '0.1.1', availableTools: [], availableMcpServers: [], presentEnvironmentVariableNames: [] },
    })
    expect(first.status).toBe('succeeded')
    const before = await baseStore.list()
    const oldRecord = before[0]
    expect(oldRecord?.projectId).toBe('project-alpha')
    if (oldRecord === undefined) return
    const oldContents = await readFile(join(oldRecord.installed.directory, 'SKILL.md'), 'utf8')
    let failedNewUpsert = false
    const failingStore: TeamSkillInstallationStoreLike = {
      list: () => baseStore.list(),
      upsert: async (next: TeamSkillInstallationRecord) => {
        if (next.projectId === 'project-beta' && !failedNewUpsert) {
          failedNewUpsert = true
          throw new Error('simulated installation store failure')
        }
        await baseStore.upsert(next)
      },
      remove: id => baseStore.remove(id),
    }
    const secondHost = new TeamSkillHost({ ...common, installationStore: failingStore })
    const failed = await secondHost.install({
      skillId: 'skill-1',
      version: VERSION,
      projectId: 'project-beta',
      scope: 'global',
      environment: { dshVersion: '0.1.1', availableTools: [], availableMcpServers: [], presentEnvironmentVariableNames: [] },
    })
    expect(failed).toMatchObject({ status: 'failed', code: 'LOCAL_OPERATION_FAILED' })
    await expect(readFile(join(oldRecord.installed.directory, 'SKILL.md'), 'utf8')).resolves.toBe(oldContents)
    await expect(baseStore.list()).resolves.toEqual([oldRecord])
  })

  it('recovers an expired-token Team Skill request through exactly one refresh and updates the stored grant', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-team-skill-host-'))
    const key = credentialKey('dsh-ai-coding-platform', 'account')
    const records = new Map<CredentialKey, CredentialRecord>([
      [
        key,
        {
          kind: 'grant',
          payload: { userId: 'user-1', accessToken: 'stale-access', refreshToken: 'refresh-one', expiresAt: Date.now() + 600_000 },
        },
      ],
    ])
    let refreshCalls = 0
    let catalogCalls = 0
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
      const url = String(input)
      if (url.endsWith('/auth/refresh')) {
        refreshCalls += 1
        return response({
          access_token: 'new-access',
          refresh_token: 'new-refresh',
          expires_in: 900,
          user: ACCOUNT_USER,
          memberships: [],
          must_change_password: false,
        })
      }
      if (url.includes('/team-skills?')) {
        catalogCalls += 1
        if (catalogCalls === 1) return response({ code: 'TOKEN_EXPIRED', message: '会话已过期' }, { status: 401 })
        return response({ items: [{ skill_id: 'skill-1', display_name: '代码评审', runtime_name: RUNTIME_NAME, summary: '评审', version: VERSION, category: '质量', tags: ['审核'], published_at: '2026-09-04T00:00:00Z' }] })
      }
      throw new Error(`unexpected request ${url}`)
    })
    const host = new TeamSkillHost({
      apiBaseUrl: 'https://service.example.test/v1',
      credentials: memoryCredentials(records),
      fetch,
      stateDirectory: join(root, 'state'),
      globalSkillRoot: join(root, 'global-skills'),
    })

    const catalog = await host.catalog('project-alpha')
    expect(catalog).toMatchObject({ status: 'ready', catalog: { items: [{ skillId: 'skill-1' }] } })
    expect(refreshCalls).toBe(1)
    expect(catalogCalls).toBe(2)
    await expect(credentials_read(records, key)).resolves.toMatchObject({ accessToken: 'new-access', refreshToken: 'new-refresh' })
  })

  it('reports signed-out and clears the stored grant when the refresh after an expired token fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-team-skill-host-'))
    const key = credentialKey('dsh-ai-coding-platform', 'account')
    const records = new Map<CredentialKey, CredentialRecord>([
      [
        key,
        {
          kind: 'grant',
          payload: { userId: 'user-1', accessToken: 'stale-access', refreshToken: 'refresh-one', expiresAt: Date.now() + 600_000 },
        },
      ],
    ])
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
      const url = String(input)
      if (url.endsWith('/auth/refresh')) return response({ code: 'TOKEN_REVOKED', message: '刷新令牌已撤销' }, { status: 401 })
      if (url.includes('/team-skills?')) return response({ code: 'TOKEN_EXPIRED', message: '会话已过期' }, { status: 401 })
      throw new Error(`unexpected request ${url}`)
    })
    const host = new TeamSkillHost({
      apiBaseUrl: 'https://service.example.test/v1',
      credentials: memoryCredentials(records),
      fetch,
      stateDirectory: join(root, 'state'),
      globalSkillRoot: join(root, 'global-skills'),
    })

    const catalog = await host.catalog('project-alpha')
    expect(catalog).toEqual({ status: 'signed-out' })
    expect(records.size).toBe(0)
  })

  it('coalesces concurrent catalog and installation requests onto a single refresh for an expired session', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-team-skill-host-'))
    const projectRoot = join(root, 'project')
    const key = credentialKey('dsh-ai-coding-platform', 'account')
    const records = new Map<CredentialKey, CredentialRecord>([
      [key, { kind: 'grant', payload: { userId: 'user-1', accessToken: 'stale-access', refreshToken: 'refresh-one', expiresAt: 0 } }],
    ])
    const archive = artifact()
    let refreshCalls = 0
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const url = String(input)
      const isGet = (init?.method ?? 'GET') === 'GET'
      if (url.endsWith('/auth/refresh')) {
        refreshCalls += 1
        return response({
          access_token: 'new-access',
          refresh_token: 'new-refresh',
          expires_in: 900,
          user: ACCOUNT_USER,
          memberships: [],
          must_change_password: false,
        })
      }
      if (url.includes('/team-skills?'))
        return response({ items: [{ skill_id: 'skill-1', display_name: '代码评审', runtime_name: RUNTIME_NAME, summary: '评审', version: VERSION, category: '质量', tags: ['审核'], published_at: '2026-09-04T00:00:00Z' }] })
      if (url.endsWith('/team-skill-installations') && !isGet)
        return response({
          operation_id: 'operation-1',
          status: 'authorized',
          skill_id: 'skill-1',
          runtime_name: RUNTIME_NAME,
          version: VERSION,
          artifact: {
            download_url: 'https://service.example.test/downloads/operation-1',
            expires_at: '2026-08-29T12:00:00Z',
            sha256: sha256(archive),
            size_bytes: archive.byteLength,
            files: [{ path: 'SKILL.md', sha256: sha256(strToU8(`---
name: ${RUNTIME_NAME}
description: 团队代码评审流程
---
`)) }],
          },
        })
      if (url.includes('/downloads/')) return new Response(new Uint8Array(archive).buffer)
      if (url.includes('/team-skills/release-status'))
        return response({ items: [{ skill_id: 'skill-1', project_id: 'project-alpha', version: VERSION, status: 'published' }] })
      return response({ accepted: true })
    })
    const host = new TeamSkillHost({
      apiBaseUrl: 'https://service.example.test/v1',
      credentials: memoryCredentials(records),
      fetch,
      stateDirectory: join(root, 'state'),
      globalSkillRoot: join(root, 'global-skills'),
      resolveWorkspace: id => (id === 'workspace-1' ? projectRoot : undefined),
      refreshSkillCatalog: async () => true,
    })
    const installRequest = {
      skillId: 'skill-1',
      version: VERSION,
      projectId: 'project-alpha',
      scope: 'project' as const,
      workspaceId: 'workspace-1',
      environment: { dshVersion: '0.1.1', availableTools: [], availableMcpServers: [], presentEnvironmentVariableNames: [] },
    }

    const [firstCatalog, secondCatalog, installed] = await Promise.all([
      host.catalog('project-alpha'),
      host.catalog('project-alpha'),
      host.install(installRequest),
    ])
    expect(firstCatalog).toMatchObject({ status: 'ready' })
    expect(secondCatalog).toMatchObject({ status: 'ready' })
    expect(installed).toMatchObject({ status: 'succeeded' })
    expect(refreshCalls).toBe(1)
  })

  it('rolls back disk copy, record and superseded state when discovery fails during install (P1-07)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-team-skill-host-'))
    const projectRoot = join(root, 'project')
    const archive = artifact()
    let discoveryResult = false
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
      const url = String(input)
      if (url.endsWith('/team-skill-installations'))
        return response({
          operation_id: 'operation-1',
          status: 'authorized',
          skill_id: 'skill-1',
          runtime_name: RUNTIME_NAME,
          version: VERSION,
          artifact: {
            download_url: 'https://service.example.test/downloads/operation-1',
            expires_at: '2026-08-29T12:00:00Z',
            sha256: sha256(archive),
            size_bytes: archive.byteLength,
            files: [{ path: 'SKILL.md', sha256: sha256(strToU8(`---
name: ${RUNTIME_NAME}
description: 团队代码评审流程
---
`)) }],
          },
        })
      if (url.includes('/downloads/')) return new Response(new Uint8Array(archive).buffer)
      return response({ accepted: true })
    })
    const host = new TeamSkillHost({
      apiBaseUrl: 'https://service.example.test/v1',
      accessToken: 'token-1',
      stateDirectory: join(root, 'state'),
      globalSkillRoot: join(root, 'global-skills'),
      fetch,
      resolveWorkspace: id => (id === 'workspace-1' ? projectRoot : undefined),
      refreshSkillCatalog: async () => discoveryResult,
    })

    // RED：discovery 失败 → 安装失败，磁盘/记录/被取代状态必须全部回滚。
    discoveryResult = false
    const failed = await host.install({
      skillId: 'skill-1',
      version: VERSION,
      projectId: 'project-alpha',
      scope: 'project',
      workspaceId: 'workspace-1',
      environment: { dshVersion: '0.1.1', availableTools: [], availableMcpServers: [], presentEnvironmentVariableNames: [] },
    })
    expect(failed).toMatchObject({ status: 'failed', code: 'LOCAL_REFRESH_FAILED' })
    // §11.14：失败必须归到真正失败的阶段，其后的回滚必须显式呈现为已执行，
    // 未被执行的阶段一律 skipped（不得省略、也不得呈现为成功）。
    expect(failed).toMatchObject({
      failedStage: 'discovery',
      retryable: { retryable: false },
      stages: [
        { stage: 'authorization', outcome: 'succeeded' },
        { stage: 'precheck', outcome: 'succeeded' },
        { stage: 'download', outcome: 'succeeded' },
        { stage: 'verify', outcome: 'succeeded' },
        { stage: 'write', outcome: 'succeeded' },
        { stage: 'discovery', outcome: 'failed' },
        { stage: 'rollback', outcome: 'succeeded' },
      ],
    })
    const storePath = join(root, 'state', 'team-skill-installations.json')
    const storeRaw = JSON.parse(await readFile(storePath, 'utf8')) as { records: unknown[] }
    expect(storeRaw.records).toEqual([])

    // GREEN：discovery 恢复后重试安装成功且唯一确定。
    discoveryResult = true
    const retried = await host.install({
      skillId: 'skill-1',
      version: VERSION,
      projectId: 'project-alpha',
      scope: 'project',
      workspaceId: 'workspace-1',
      environment: { dshVersion: '0.1.1', availableTools: [], availableMcpServers: [], presentEnvironmentVariableNames: [] },
    })
    expect(retried).toMatchObject({ status: 'succeeded' })
    await expect(access(join(projectRoot, '.dsh', 'skills', RUNTIME_NAME, 'SKILL.md'))).resolves.toBeUndefined()
  })

  it('quarantines and hides a managed copy omitted from the authoritative release response', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-team-skill-host-'))
    const archive = artifact()
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        response({
          operation_id: 'operation-1',
          status: 'authorized',
          skill_id: 'skill-1',
          runtime_name: RUNTIME_NAME,
          version: VERSION,
          artifact: {
            download_url: 'https://service.example.test/downloads/operation-1',
            expires_at: '2026-08-29T12:00:00Z',
            sha256: sha256(archive),
            size_bytes: archive.byteLength,
            files: [{ path: 'SKILL.md', sha256: sha256(strToU8(`---\nname: ${RUNTIME_NAME}\ndescription: 团队代码评审流程\n---\n`)) }],
          },
        }),
      )
      .mockResolvedValueOnce(response({ accepted: true }))
      .mockResolvedValueOnce(new Response(new Uint8Array(archive).buffer))
      .mockResolvedValueOnce(response({ accepted: true }))
      .mockResolvedValueOnce(response({ accepted: true }))
      .mockResolvedValueOnce(response({ accepted: true }))
      .mockResolvedValueOnce(response({ accepted: true }))
      .mockResolvedValueOnce(response({ items: [] }))
      // 隔离后再次读取安装列表：installationContext 会重新调用 release-status。
      .mockResolvedValueOnce(response({ items: [] }))
    const discovered: boolean[] = []
    const host = new TeamSkillHost({
      apiBaseUrl: 'https://service.example.test/v1',
      accessToken: 'token-1',
      stateDirectory: join(root, 'state'),
      globalSkillRoot: join(root, 'global-skills'),
      fetch,
      refreshSkillCatalog: async (_scope, _workspacePath, _runtimeName, expectedPresent = true) => {
        discovered.push(expectedPresent)
        return true
      },
    })
    const installed = await host.install({
      skillId: 'skill-1',
      version: VERSION,
      projectId: 'project-alpha',
      scope: 'global',
      environment: { dshVersion: '0.1.1', availableTools: [], availableMcpServers: [], presentEnvironmentVariableNames: [] },
    })
    expect(installed.status).toBe('succeeded')
    const synced = await host.syncReleaseStatus('project-alpha')
    // The omitted release is quarantined locally; the record stays visible to the
    // browser as `withdrawn` (its local copy state), while the service response no
    // longer reveals the release itself.
    expect(synced).toEqual([
      expect.objectContaining({ skillId: 'skill-1', projectId: 'project-alpha', state: 'withdrawn' }),
    ])
    // §11.14：隔离记录不得从安装列表中被静默过滤掉——它必须以「已撤销」对
    // 浏览器可见，否则用户看到的是「消失」而不是「需要处理」。
    const listed = await host.installations('project-alpha')
    expect(listed).toEqual([
      expect.objectContaining({ skillId: 'skill-1', projectId: 'project-alpha', state: 'withdrawn' }),
    ])
    const releaseStatusCall = fetch.mock.calls.find(([url]) => String(url).includes('/team-skills/release-status'))
    expect(parseJsonBody(releaseStatusCall?.[1]?.body)).toEqual({
      items: [{ skill_id: 'skill-1', version: VERSION, project_id: 'project-alpha' }],
    })
    expect(discovered).toEqual([true, false])
  })
})

function parseJsonBody(body: BodyInit | null | undefined): unknown {
  if (typeof body !== 'string') throw new Error('Expected a JSON request body.')
  return JSON.parse(body) as unknown
}
