import { describe, expect, it, vi } from 'vitest'
/* oxlint-disable typescript/no-base-to-string -- Fetch spy assertions inspect RequestInfo wire values. */
/* oxlint-disable typescript/no-this-alias -- This test deliberately observes the fetch receiver contract. */
import { refreshServiceSession, refreshServiceSessionOnce } from '../src/auth-session.ts'
import { TeamSkillApi } from '../src/lib/team-skill-api.ts'

function envelope(value: unknown, status = 200): Response {
  const error = status >= 400
  const record = typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
  const data = !error && record !== undefined && Object.hasOwn(record, 'data') ? record.data : value
  return new Response(JSON.stringify({
    code: error ? (typeof record?.code === 'string' ? record.code : `HTTP_${status}`) : 0,
    message: error ? (typeof record?.message === 'string' ? record.message : 'failed') : 'ok',
    request_id: 'test-request',
    data: error ? null : data,
  }), { status })
}

describe('TeamSkillApi', () => {
  it('rejects a top-level list response instead of accepting a legacy non-envelope payload', async () => {
    const api = new TeamSkillApi({
      baseUrl: 'https://service.example',
      accessToken: 'token',
      fetcher: async () => new Response(JSON.stringify([{ skill_id: 'legacy' }]), { status: 200 }),
    })

    await expect(api.listSkills()).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_RESPONSE' } })
  })

  it('rejects a successful response without the required data field', async () => {
    const api = new TeamSkillApi({
      baseUrl: 'https://service.example',
      accessToken: 'token',
      fetcher: async () => new Response(JSON.stringify({ items: [] }), { status: 200 }),
    })

    await expect(api.listOrganizations()).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_RESPONSE' } })
  })
  it('returns an explicit not-ready result when the service is not configured', async () => {
    const api = new TeamSkillApi({})
    expect(await api.listSkills()).toEqual({ ok: false, error: { kind: 'not-ready', missing: ['baseUrl', 'accessToken'] } })
  })

  it('sends bearer authentication and concurrency headers for a mutation', async () => {
    const fetcher = vi.fn<typeof fetch>(
      async (_input, _init) => envelope({ skill: { skillId: 'skill-1' } }),
    )
    const api = new TeamSkillApi({ baseUrl: 'https://skills.example/v1', accessToken: 'token-1', fetcher })
    const result = await api.publish('skill-1', '1.2.0', 7, 9, 'idem-1')
    expect(result.ok).toBe(true)
    const [, init] = fetcher.mock.calls[0]
    expect(init?.method).toBe('POST')
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer token-1')
    expect(new Headers(init?.headers).get('Idempotency-Key')).toBe('idem-1')
    expect(new Headers(init?.headers).get('If-Match')).toBe('7')
    expect(new Headers(init?.headers).get('X-Skill-Revision')).toBe('9')
  })

  it('maps revision conflicts to a stable business error', async () => {
    const fetcher = vi.fn<typeof fetch>(
      async (_input, _init) => envelope({ code: 'REVISION_CONFLICT', message: '资源已更新' }, 409),
    )
    const api = new TeamSkillApi({ baseUrl: 'https://skills.example/v1', accessToken: 'token-1', fetcher })
    expect(await api.publish('skill-1', '1.2.0', 7, 9, 'idem-2')).toEqual({
      ok: false,
      error: { kind: 'revision-conflict', code: 'REVISION_CONFLICT', message: '资源已更新' },
    })
  })

  it('classifies token expiry and revocation codes as unauthorized', async () => {
    for (const code of ['TOKEN_EXPIRED', 'TOKEN_REVOKED']) {
      const api = new TeamSkillApi({
        baseUrl: 'https://skills.example/v1',
        accessToken: 'token-1',
        fetcher: async () => envelope({ code, message: '会话已失效' }, 401),
      })
      await expect(api.listSkills()).resolves.toEqual({
        ok: false,
        error: { kind: 'unauthorized', code, message: '会话已失效' },
      })
    }
  })

  it('requires actor_name on authorization audit records', async () => {
    const audit = {
      id: 'audit-1',
      occurred_at: '2026-09-08T00:00:00Z',
      actor_user_id: 'admin-1',
      actor_name: '平台管理员',
      organization_id: 'org-alpha',
      action: 'project.member.add',
      result: 'succeeded',
      request_id: 'request-1',
    }
    const api = new TeamSkillApi({
      baseUrl: 'https://skills.example/v1',
      accessToken: 'token-1',
      fetcher: async () => envelope({ items: [audit] }),
    })
    await expect(api.listAuthorizationAudits()).resolves.toEqual({ ok: true, value: [audit] })

    const missingActorName = { ...audit, actor_name: undefined }
    const invalidApi = new TeamSkillApi({
      baseUrl: 'https://skills.example/v1',
      accessToken: 'token-1',
      fetcher: async () => envelope({ items: [missingActorName] }),
    })
    await expect(invalidApi.listAuthorizationAudits()).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_RESPONSE' } })
  })

  it('requires actor_name on Skill audit records', async () => {
    const audit = {
      id: 'audit-1',
      occurredAt: '2026-09-08T00:00:00Z',
      actor_name: '平台管理员',
      action: 'version.published',
      skillName: '接口联调规范',
      version: '1.0.0',
      scope: 'global',
      result: 'succeeded',
      requestId: 'request-1',
    }
    const api = new TeamSkillApi({
      baseUrl: 'https://skills.example/v1',
      accessToken: 'token-1',
      fetcher: async () => envelope([audit]),
    })
    await expect(api.listAuditLogs()).resolves.toEqual({ ok: true, value: [audit] })

    const missingActorName = { ...audit, actor_name: '' }
    const invalidApi = new TeamSkillApi({
      baseUrl: 'https://skills.example/v1',
      accessToken: 'token-1',
      fetcher: async () => envelope([missingActorName]),
    })
    await expect(invalidApi.listAuditLogs()).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_RESPONSE' } })
  })

  it('does not bind the TeamSkillApi instance as fetch receiver', async () => {
    let receiver: unknown = 'unset'
    const fetcher: typeof fetch = function (this: unknown, _input, _init) {
      receiver = this
      return Promise.resolve(envelope([]))
    }
    const api = new TeamSkillApi({ baseUrl: 'https://skills.example/v1', accessToken: 'token-1', fetcher })
    expect(await api.listSkills()).toEqual({ ok: true, value: [] })
    expect(receiver).toBeUndefined()
  })

  it('sends author draft and artifact requests with their revision and idempotency headers', async () => {
    const fetcher = vi.fn<typeof fetch>(
      async () => envelope({ skill: { skillId: 'skill-1' }, version: { version: '1.3.0' } }),
    )
    const api = new TeamSkillApi({ baseUrl: 'https://skills.example/v1', accessToken: 'token-1', fetcher })
    await api.updateSkill('skill-1', { displayName: '代码评审', summary: '更新说明', visibility: 'organization' }, 3, 'idem-update')
    await api.createVersion('skill-1', { version: '1.3.0', releaseNotes: '新增规则' }, 4, 'idem-version')
    await api.updateVersion(
      'skill-1',
      '1.3.0',
      { releaseNotes: '补充说明', dependencies: ['DSH >= 0.1.0'], permissions: ['read_file'] },
      5,
      'idem-version-update',
    )
    await api.uploadArtifact('skill-1', '1.3.0', new Uint8Array([1, 2, 3]), 6, 'idem-artifact')
    await api.submitReview('skill-1', '1.3.0', 7, 8, 'idem-submit')
    expect(fetcher).toHaveBeenCalledTimes(5)
    expect(fetcher.mock.calls.map(([input]) => String(input))).toEqual([
      'https://skills.example/v1/admin/team-skills/skill-1',
      'https://skills.example/v1/admin/team-skills/skill-1/versions',
      'https://skills.example/v1/admin/team-skills/skill-1/versions/1.3.0',
      'https://skills.example/v1/admin/team-skills/skill-1/versions/1.3.0/artifact',
      'https://skills.example/v1/admin/team-skills/skill-1/versions/1.3.0/submit-review',
    ])
    expect(new Headers(fetcher.mock.calls[3]?.[1]?.headers).get('Content-Type')).toBe('application/zip')
    expect(new Headers(fetcher.mock.calls[4]?.[1]?.headers).get('If-Match')).toBe('7')
  })

  it('uses same-origin session authentication without exposing an access token', async () => {
    const fetcher = vi.fn<typeof fetch>(
      async (_input, _init) =>
        envelope({ items: [{ organization_id: 'org-alpha', name: '星河 AI 平台', status: 'active', revision: 1 }] }),
    )
    const api = new TeamSkillApi({ baseUrl: '/api/team-skill', sessionAuth: true, fetcher })
    expect(await api.listOrganizations()).toEqual({
      ok: true,
      value: [{ organization_id: 'org-alpha', name: '星河 AI 平台', status: 'active', revision: 1 }],
    })
    const [, init] = fetcher.mock.calls[0]
    expect(new Headers(init?.headers).get('Authorization')).toBeNull()
  })

  it('uses the platform knowledge-base list for an unfiltered management view', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => envelope({ items: [] }))
    const api = new TeamSkillApi({ baseUrl: 'https://skills.example/v1', accessToken: 'token-1', fetcher })
    await expect(api.listKnowledgeBases()).resolves.toEqual({ ok: true, value: [] })
    expect(fetcher.mock.calls[0]?.[0]).toBe('https://skills.example/v1/admin/knowledge-bases')
    await api.listKnowledgeBases('org-alpha')
    expect(fetcher.mock.calls[1]?.[0]).toBe('https://skills.example/v1/admin/organizations/org-alpha/knowledge-bases')
  })

  it('sends account mutations with idempotency and revision headers', async () => {
    const fetcher = vi.fn<typeof fetch>(
      async (_input, _init) =>
        envelope({
          user_id: 'member-1',
          username: 'member@example.com',
          email: 'member@example.com',
          display_name: '成员',
          status: 'suspended',
          must_change_password: false,
          revision: 2,
        }),
    )
    const api = new TeamSkillApi({ baseUrl: 'https://skills.example/v1', accessToken: 'token-1', fetcher })
    expect((await api.updateUser('member-1', { status: 'suspended' }, 1, 'suspend-1')).ok).toBe(true)
    const [, init] = fetcher.mock.calls[0]
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer token-1')
    expect(new Headers(init?.headers).get('Idempotency-Key')).toBe('suspend-1')
    expect(new Headers(init?.headers).get('If-Match')).toBe('1')
  })

  it('rotates Auth.js refresh sessions with an idempotency key and the service-owned global role', async () => {
    const fetcher = vi.fn<typeof fetch>(async (_input, init) => {
      expect(init?.method).toBe('POST')
      expect(new Headers(init?.headers).get('Idempotency-Key')).toMatch(/^[0-9a-f-]{36}$/u)
      expect(init?.body).toBe(JSON.stringify({ refresh_token: 'refresh-old' }))
      return envelope({
        access_token: 'access-new',
        refresh_token: 'refresh-new',
        expires_in: 900,
        must_change_password: false,
        user: { global_role: 'admin' },
        memberships: [{ status: 'active' }, { status: 'active' }],
      })
    })
    await expect(refreshServiceSession('https://service.example/v1', 'refresh-old', fetcher)).resolves.toMatchObject({
      accessToken: 'access-new',
      refreshToken: 'refresh-new',
      role: 'admin',
      mustChangePassword: false,
    })
  })

  it('uses the service global role even when memberships have no role field', async () => {
    const fetcher = vi.fn<typeof fetch>(
      async () =>
        envelope({
          access_token: 'access-new',
          refresh_token: 'refresh-new',
          expires_in: 900,
          must_change_password: false,
          user: { global_role: 'manager' },
          memberships: [{ status: 'active' }],
        }),
    )
    await expect(refreshServiceSession('https://service.example/v1', 'refresh-old', fetcher)).resolves.toMatchObject({ role: 'manager' })
  })

  it('rejects an incomplete Auth.js refresh response instead of retaining stale credentials', async () => {
    const fetcher = vi.fn<typeof fetch>(
      async () => new Response(JSON.stringify({ access_token: 'access-new', expires_in: 900 }), { status: 200 }),
    )
    await expect(refreshServiceSession('https://service.example/v1', 'refresh-old', fetcher)).resolves.toBeUndefined()
  })

  it('coalesces concurrent Auth.js refresh callbacks for one refresh token', async () => {
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => { release = resolve })
    const fetcher = vi.fn<typeof fetch>(async () => {
      await gate
      return envelope({
        access_token: 'access-new',
        refresh_token: 'refresh-new',
        expires_in: 900,
        must_change_password: false,
        user: { global_role: 'member' },
        memberships: [],
      })
    })
    const first = refreshServiceSessionOnce('https://service.example/v1', 'refresh-coalesced', fetcher)
    const second = refreshServiceSessionOnce('https://service.example/v1', 'refresh-coalesced', fetcher)
    expect(fetcher).toHaveBeenCalledTimes(1)
    release?.()
    await expect(Promise.all([first, second])).resolves.toHaveLength(2)
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('unwraps project-memory mutation envelopes and sends scope concurrency headers', async () => {
    const memory = {
      memory_id: 'm-1',
      team_id: 'team-alpha',
      project_id: 'project-alpha',
      content: 'updated',
      layer: 'L1' as const,
      captured_by_user_id: 'member-1',
      created_at: '2026-09-02T00:00:00Z',
      updated_at: '2026-09-02T00:00:00Z',
      revision: 2,
      status: 'ACTIVE' as const,
      importance: 0.8,
      recall_count: 0,
      last_recalled_at: null,
      source_kind: 'agent_turn' as const,
    }
    const fetcher = vi.fn<typeof fetch>(async (_input, _init) => envelope({ memory, event_id: 'e-1', job_id: 'j-1', status: 'INDEX_PENDING' }, 202))
    const api = new TeamSkillApi({ baseUrl: 'https://skills.example/v1', accessToken: 'token-1', fetcher })
    await expect(api.updateMemoryRecord('m-1', 'updated', 1, 'update-1')).resolves.toEqual({ ok: true, value: memory })
    const [, updateInit] = fetcher.mock.calls[0]
    expect(new Headers(updateInit?.headers).get('If-Match')).toBe('1')
    // update 与 delete 同等要求幂等键：请求必须同时携带 If-Match 与 Idempotency-Key（0-3）。
    expect(new Headers(updateInit?.headers).get('Idempotency-Key')).toBe('update-1')
    expect(fetcher.mock.calls).toHaveLength(1)
  })

  it('routes project-memory requests through the v3 API even when the general base URL is v1', async () => {
    const fetcher = vi.fn<typeof fetch>(
      async () => envelope({ items: [], next_cursor: null, total_estimate: 0 }),
    )
    const api = new TeamSkillApi({ baseUrl: 'https://skills.example/v1', accessToken: 'token-1', fetcher })
    await api.listMemoryRecords({ projectId: 'project-alpha' })
    expect(fetcher.mock.calls[0]?.[0]).toBe('https://skills.example/v3/project-memory/list')
  })

  it('routes project-memory deletes through the v3 API and preserves mutation headers', async () => {
    const fetcher = vi.fn<typeof fetch>(
      async () =>
        envelope({ event_id: 'e-1', job_id: 'j-1', status: 'PENDING', cleanup_status: 'PENDING' }, 202),
    )
    const api = new TeamSkillApi({ baseUrl: 'https://skills.example/v1', accessToken: 'token-1', fetcher })
    await expect(api.deleteMemoryRecord('m-1', 3, 'delete-1')).resolves.toEqual({
      ok: true,
      value: { event_id: 'e-1', job_id: 'j-1', status: 'PENDING', cleanup_status: 'PENDING' },
    })
    const [input, init] = fetcher.mock.calls[0]
    expect(input).toBe('https://skills.example/v3/project-memory/delete')
    expect(new Headers(init?.headers).get('If-Match')).toBe('3')
    expect(new Headers(init?.headers).get('Idempotency-Key')).toBe('delete-1')
  })

  it('classifies the memory-specific revision conflict code as a revision conflict', async () => {
    const fetcher = vi.fn<typeof fetch>(
      async () => envelope({ code: 'MEMORY_REVISION_CONFLICT', message: '记忆已更新' }, 409),
    )
    const api = new TeamSkillApi({ baseUrl: 'https://skills.example/v1', accessToken: 'token-1', fetcher })
    await expect(api.updateMemoryRecord('m-1', 'stale', 1, 'update-stale-1')).resolves.toEqual({
      ok: false,
      error: { kind: 'revision-conflict', code: 'MEMORY_REVISION_CONFLICT', message: '记忆已更新' },
    })
  })

  it('rejects incomplete memory records instead of exposing a partially typed response', async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      envelope({ items: [{ memory_id: 'm-1', project_id: 'project-alpha', content: 'partial', revision: 1 }], next_cursor: null }),
    )
    const api = new TeamSkillApi({ baseUrl: 'https://skills.example/v1', accessToken: 'token-1', fetcher })
    await expect(api.listMemoryRecords({ projectId: 'project-alpha' })).resolves.toEqual({
      ok: false,
      error: { kind: 'service', code: 'INVALID_RESPONSE', message: '服务端未返回有效的记忆列表' },
    })
  })

  it('rejects a memory list without an explicit total estimate or cursor', async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      envelope({ items: [], next_cursor: undefined }),
    )
    const api = new TeamSkillApi({ baseUrl: 'https://skills.example/v1', accessToken: 'token-1', fetcher })
    await expect(api.listMemoryRecords()).resolves.toEqual({
      ok: false,
      error: { kind: 'service', code: 'INVALID_RESPONSE', message: '服务端未返回有效的记忆列表' },
    })
  })

  it('rejects incomplete memory mutation, policy, and job responses', async () => {
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const url = String(input)
      if (url.endsWith('/project-memory/update')) return envelope({ memory: {} }, 202)
      if (url.endsWith('/project-memory/policy/get')) return envelope({ scope_type: 'project' })
      if (url.endsWith('/project-memory/jobs/retry')) return envelope({ job_id: 'j-1' }, 202)
      return envelope({})
    })
    const api = new TeamSkillApi({ baseUrl: 'https://skills.example/v1', accessToken: 'token-1', fetcher })
    await expect(api.updateMemoryRecord('m-1', 'updated', 1, 'update-invalid-1')).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_RESPONSE' } })
    await expect(api.getMemoryPolicy('project-alpha')).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_RESPONSE' } })
    await expect(api.retryMemoryJob('j-1', 1, 'retry-1')).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_RESPONSE' } })
  })

  it('keeps memory job and audit cursors in their paged API results', async () => {
    const job = {
      job_id: 'j-1',
      event_id: 'e-1',
      kind: 'CAPTURE',
      team_id: 'team-alpha',
      project_id: 'project-alpha',
      requested_by_user_id: 'manager-1',
      status: 'PENDING',
      retryable: false,
      retry_count: 0,
      created_at: '2026-09-02T00:00:00Z',
      finished_at: null,
      error_code: null,
      revision: 0,
    }
    const audit = {
      audit_id: 'a-1',
      operation: 'CAPTURE_ACCEPTED',
      actor_name: '演示经理',
      operated_by_user_id: 'manager-1',
      role: 'manager',
      memory_id: null,
      project_id: 'project-alpha',
      result: 'SUCCEEDED',
      event_id: 'e-1',
    }
    const fetcher = vi.fn<typeof fetch>(async input =>
      envelope(String(input).endsWith('/jobs/list') ? { items: [job], next_cursor: 'jobs-next' } : { items: [audit], next_cursor: 'audit-next' }),
    )
    const api = new TeamSkillApi({ baseUrl: 'https://skills.example/v1', accessToken: 'token-1', fetcher })
    await expect(api.listMemoryJobs('project-alpha')).resolves.toEqual({ ok: true, value: { items: [job], next_cursor: 'jobs-next' } })
    await expect(api.listMemoryAudit('project-alpha')).resolves.toEqual({ ok: true, value: { items: [audit], next_cursor: 'audit-next' } })
  })

  it('reads authorized member projects through the memory context endpoint', async () => {
    const fetcher = vi.fn<typeof fetch>(
      async () =>
        envelope({ items: [{ project_id: 'project-alpha', organization_id: 'org-alpha', name: 'Alpha', status: 'active', revision: 1 }] }),
    )
    const api = new TeamSkillApi({ baseUrl: '/api/team-skill', sessionAuth: true, fetcher })
    await expect(api.listMemoryProjects()).resolves.toEqual({
      ok: true,
      value: [{ project_id: 'project-alpha', organization_id: 'org-alpha', name: 'Alpha', status: 'active', revision: 1 }],
    })
    expect(fetcher.mock.calls[0]?.[0]).toBe('/api/team-skill/me/projects')
  })
})

describe('TeamSkillApi 2xx business-code and envelope semantics (P1-05)', () => {
  function apiWithPayload(payload: unknown): TeamSkillApi {
    return new TeamSkillApi({
      baseUrl: 'https://skills.example/v1',
      accessToken: 'token-1',
      fetcher: async () => new Response(JSON.stringify(payload), { status: 200 }),
    })
  }

  it('treats HTTP 200 with a non-zero business code as a failure, not a success', async () => {
    const api = apiWithPayload({ code: 'BIZ_FAILED', message: '业务失败', request_id: 'req-1', data: null })
    const result = await api.listSkills()
    expect(result).toMatchObject({ ok: false, error: { kind: 'service', code: 'BIZ_FAILED', message: '业务失败' } })
  })

  it('treats HTTP 201 with a non-zero business code as a failure', async () => {
    const api = new TeamSkillApi({
      baseUrl: 'https://skills.example/v1',
      accessToken: 'token-1',
      fetcher: async () => new Response(JSON.stringify({ code: 'BIZ_CREATED_FAILED', message: '创建失败', request_id: 'req-2', data: null }), { status: 201 }),
    })
    const result = await api.listSkills()
    expect(result).toMatchObject({ ok: false, error: { code: 'BIZ_CREATED_FAILED' } })
  })

  it('treats HTTP 200 with code 0 but missing data as a failure instead of a null success', async () => {
    const api = apiWithPayload({ code: 0, message: 'ok', request_id: 'req-3' })
    const result = await api.listSkills()
    expect(result.ok).toBe(false)
  })

  it('keeps code 0 with data as a success', async () => {
    const api = apiWithPayload({ code: 0, message: 'ok', request_id: 'req-4', data: [] })
    const result = await api.listSkills()
    expect(result.ok).toBe(true)
  })
})


describe('AFC-12 opaque pagination walk', () => {
  const candidate = {
    asset_id: 'skill:code-review@1.0.0',
    asset_type: 'skill',
    version: '1.0.0',
    name: '代码评审 Skill',
    authorized: true,
    readiness: 'ready',
    invalid_reason: null,
    updated_at: '2026-09-01T00:00:00.000Z',
  }

  /** 按脚本服务分页，并记录每一页收到的游标与完整 URL。 */
  function walkFetcher(nextFor: (cursor: string | undefined) => unknown): {
    readonly fetcher: typeof fetch
    readonly cursors: (string | undefined)[]
    readonly urls: string[]
  } {
    const cursors: (string | undefined)[] = []
    const urls: string[] = []
    const fetcher = async (input: RequestInfo | URL): Promise<Response> => {
      const url = new URL(String(input))
      urls.push(url.pathname + url.search)
      const cursor = url.searchParams.get('cursor') ?? undefined
      cursors.push(cursor)
      return envelope({ items: [candidate], next_cursor: nextFor(cursor) })
    }
    return { fetcher, cursors, urls }
  }

  const apiFor = (fetcher: typeof fetch): TeamSkillApi =>
    new TeamSkillApi({ baseUrl: 'https://service.example', accessToken: 'token', fetcher })

  /** 走完 n 页后耗尽：第 k 次调用（k 从 1 起）返回 cursor-<k>，第 n 次返回 null。 */
  const pagesThenDone = (n: number) => (cursor: string | undefined): string | null => {
    const served = cursor === undefined ? 1 : Number(cursor.replace('cursor-', '')) + 1
    return served >= n ? null : `cursor-${String(served)}`
  }

  it('consumes a single page when the server declares completion', async () => {
    const { fetcher, cursors } = walkFetcher(() => null)
    const result = await apiFor(fetcher).cloudAssetCandidates('project-1')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toHaveLength(1)
    expect(cursors).toEqual([undefined])
  })

  it('consumes exactly fifty pages and passes every cursor through opaquely', async () => {
    const { fetcher, cursors, urls } = walkFetcher(pagesThenDone(50))
    const result = await apiFor(fetcher).cloudAssetCandidates('project-1')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toHaveLength(50)
    expect(cursors).toHaveLength(50)
    expect(cursors[0]).toBeUndefined()
    expect(cursors[1]).toBe('cursor-1')
    expect(urls[1]).toContain('cursor=cursor-1')
    // 筛选参数在每一页都保留。
    expect(urls.every(url => url.includes('project_id=project-1'))).toBe(true)
  })

  it('consumes page fifty-one instead of truncating at fifty', async () => {
    const { fetcher, cursors } = walkFetcher(pagesThenDone(51))
    const result = await apiFor(fetcher).cloudAssetCandidates('project-1')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    // 旧实现只循环 50 页却返回成功——第 51 页会被静默丢掉。
    expect(result.value).toHaveLength(51)
    expect(cursors).toHaveLength(51)
  })

  it('rejects a repeating cursor instead of reporting successful completion', async () => {
    const { fetcher, cursors } = walkFetcher(() => 'opaque-repeat')
    const result = await apiFor(fetcher).cloudAssetCandidates('project-1')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('INVALID_RESPONSE')
    expect(result.error.message).toContain('opaque-repeat')
    expect(cursors).toEqual([undefined, 'opaque-repeat'])
  })

  it('rejects a non-string cursor as a protocol error', async () => {
    const { fetcher } = walkFetcher(() => 42)
    const result = await apiFor(fetcher).cloudAssetCandidates('project-1')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('INVALID_RESPONSE')
  })

  it('fails with PAGINATION_LIMIT past the implementation bound instead of a partial list', async () => {
    const { fetcher, cursors } = walkFetcher(
      cursor => `cursor-${String(cursor === undefined ? 1 : Number(cursor.replace('cursor-', '')) + 1)}`,
    )
    const result = await apiFor(fetcher).cloudAssetCandidates('project-1')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('PAGINATION_LIMIT')
    expect(result.error.message).toContain('1000')
    expect(cursors).toHaveLength(1000)
  }, 60_000)
})
