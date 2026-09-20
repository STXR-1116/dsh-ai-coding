/* http.ts 各响应解析器的闭集词表与可选成员（覆盖专项：http 批·续）。
 *
 * 这些解析器不在模块外导出，只能用脚本化的 fetch 从两个客户端驱动。此前「合法样本」
 * 由 host 集成规格经真实夹具覆盖，但每条词表守卫的**拒绝臂**（越出闭集即协议漂移）
 * 从未执行，可选成员的两支也只走了一支。
 *
 * 分类：FIXTURE-ONLY（构造载荷，不开真实连接）。
 */
import { describe, expect, it } from 'vitest'
import { TeamSkillAccountHttpClient, TeamSkillHttpClient } from '../src/http.ts'

/** Wraps one payload in the success envelope every endpoint answers with. */
function ok(data: unknown): string {
  return JSON.stringify({ code: 0, message: 'ok', request_id: 'req-1', data })
}

/** A client pair whose fetch always answers the same payload. */
function clientsReturning(data: unknown): {
  readonly account: TeamSkillAccountHttpClient
  readonly service: TeamSkillHttpClient
} {
  const respond = (): Response => new Response(ok(data), { status: 200, headers: { 'content-type': 'application/json' } })
  return {
    account: new TeamSkillAccountHttpClient({ apiBaseUrl: 'https://service.test/v1', fetch: async () => respond() }),
    service: new TeamSkillHttpClient({ apiBaseUrl: 'https://service.test/v1', accessToken: 'token-1', fetch: async () => respond() }),
  }
}

const ACCOUNT_USER = {
  user_id: 'member-1',
  username: 'member',
  email: 'member@example.com',
  display_name: '演示成员',
  status: 'active',
  global_role: 'member',
  must_change_password: false,
  revision: 1,
}

const SESSION = {
  access_token: 'access-1',
  refresh_token: 'refresh-1',
  expires_in: 3600,
  user: ACCOUNT_USER,
  memberships: [{ organization_id: 'org-alpha', organization_name: '星河 AI 平台', status: 'active', revision: 1 }],
  must_change_password: false,
}

const PROJECT = {
  project_id: 'project-alpha',
  organization_id: 'org-alpha',
  name: '协作台前端',
  organization_name: '星河 AI 平台',
  description: '前端协作台',
  status: 'active',
  created_by: '平台管理员',
  created_at: '2026-09-01T00:00:00.000Z',
  updated_at: '2026-09-01T00:00:00.000Z',
  member_count: 2,
  asset_count: 3,
  revision: 4,
}

const MEMORY = {
  memory_id: 'memory-1',
  team_id: 'team-1',
  project_id: 'project-alpha',
  content: '联调约定',
  layer: 'L1',
  source_kind: 'agent_turn',
  tier: 'team',
  scope: 'shared',
  source_event_id: 'evt-1',
  expires_at: null,
  captured_by_user_id: 'member-1',
  created_at: '2026-09-01T00:00:00.000Z',
  updated_at: '2026-09-01T00:00:00.000Z',
  revision: 3,
  status: 'ACTIVE',
  importance: 0.5,
  recall_count: 1,
  last_recalled_at: null,
}

describe('账户客户端解析器', () => {
  it('accepts the closed account vocabularies and rejects values outside them', async () => {
    expect((await clientsReturning(SESSION).account.login({ username: 'member', password: 'p' })).user.userId).toBe('member-1')

    await expect(clientsReturning({ ...SESSION, user: { ...ACCOUNT_USER, status: 'disabled' } })
      .account.login({ username: 'member', password: 'p' })).rejects.toThrow(/invalid account status/u)

    await expect(clientsReturning({
      user: ACCOUNT_USER,
      memberships: [{ organization_id: 'org-alpha', organization_name: '星河 AI 平台', status: 'pending', revision: 1 }],
    }).account.me('token-1')).rejects.toThrow(/invalid membership status/u)

    await expect(clientsReturning({ user: { ...ACCOUNT_USER, global_role: 'owner' }, memberships: [] })
      .account.me('token-1')).rejects.toThrow(/invalid global role/u)
  })

  it('rejects organization and project statuses outside their vocabularies', async () => {
    const summary = {
      organizations: [{ organization_id: 'org-alpha', name: '星河 AI 平台', status: 'active', revision: 1 }],
      projects: [PROJECT],
      assets: [],
      management_organization_ids: ['org-alpha'],
      management_project_ids: ['project-alpha'],
      revision: 1,
    }
    const parsed = await clientsReturning(summary).account.accessSummary('token-1')
    expect(parsed.organizations).toHaveLength(1)
    expect(parsed.management.projectIds).toEqual(['project-alpha'])
    await expect(clientsReturning({
      ...summary,
      organizations: [{ organization_id: 'org-alpha', name: '星河 AI 平台', status: 'deleted', revision: 1 }],
    }).account.accessSummary('token-1')).rejects.toThrow(/invalid organization status/u)

    expect((await clientsReturning({ items: [PROJECT] }).account.projects('token-1'))[0]?.projectId).toBe('project-alpha')
    await expect(clientsReturning({ items: [{ ...PROJECT, status: 'closed' }] }).account.projects('token-1'))
      .rejects.toThrow(/invalid project status/u)

    // 项目详情同时带项目与它的资产：资产的类型与关系同样走闭集。
    const asset = {
      project_id: 'project-alpha', asset_type: 'skill', asset_id: 'skill-1', name: '代码评审',
      relation_kind: 'reference', created_at: 'a', updated_at: 'b', revision: 1,
    }
    const detail = await clientsReturning({ project: PROJECT, assets: [asset] }).account.project('token-1', 'project-alpha')
    expect(detail.assets[0]?.assetType).toBe('skill')
    await expect(clientsReturning({ project: { ...PROJECT, status: 'closed' }, assets: [] })
      .account.project('token-1', 'project-alpha')).rejects.toThrow(/invalid project status/u)
    await expect(clientsReturning({ project: PROJECT, assets: [{ ...asset, asset_type: 'prompt' }] })
      .account.project('token-1', 'project-alpha')).rejects.toThrow(/invalid project asset type/u)
    await expect(clientsReturning({ project: PROJECT, assets: [{ ...asset, relation_kind: 'owned' }] })
      .account.project('token-1', 'project-alpha')).rejects.toThrow(/invalid project relation kind/u)
  })
})

describe('服务客户端解析器', () => {
  it('rejects knowledge base types and states outside their vocabularies', async () => {
    const base = {
      knowledge_base_id: 'k-1', name: '平台架构', description: '架构决策', type: 'document',
      state: 'active', searchable: true, updated_at: '2026-09-01T00:00:00.000Z', revision: 2,
    }
    expect((await clientsReturning({ items: [base] }).service.knowledgeBases('project-alpha'))[0]?.knowledgeBaseId).toBe('k-1')
    await expect(clientsReturning({ items: [{ ...base, type: 'spreadsheet' }] }).service.knowledgeBases('project-alpha'))
      .rejects.toThrow(/invalid knowledge base type/u)
    await expect(clientsReturning({ items: [{ ...base, state: 'indexing' }] }).service.knowledgeBases('project-alpha'))
      .rejects.toThrow(/invalid knowledge base state/u)
  })

  it('rejects memory status, metadata, tier and scope outside their vocabularies', async () => {
    expect((await clientsReturning(MEMORY).service.memoryGet('memory-1')).memoryId).toBe('memory-1')
    await expect(clientsReturning({ ...MEMORY, status: 'PENDING' }).service.memoryGet('memory-1'))
      .rejects.toThrow(/invalid memory status/u)
    await expect(clientsReturning({ ...MEMORY, layer: 'L2' }).service.memoryGet('memory-1'))
      .rejects.toThrow(/invalid memory metadata/u)
    await expect(clientsReturning({ ...MEMORY, tier: 'global' }).service.memoryGet('memory-1'))
      .rejects.toThrow(/invalid memory tier/u)
    await expect(clientsReturning({ ...MEMORY, scope: 'everyone' }).service.memoryGet('memory-1'))
      .rejects.toThrow(/invalid memory scope/u)
  })

  it('rejects a recall status, a recall item layer and an out-of-range confidence', async () => {
    const recall = {
      status: 'READY', items: [], context_text: '', strategy: 'server',
      effective_policy: { top_k: 5, relevance_threshold: 0.5, token_budget: 1000 },
    }
    expect((await clientsReturning(recall).service.memoryRecall({ projectId: 'project-alpha', query: 'q' })).status).toBe('READY')

    await expect(clientsReturning({ ...recall, status: 'MAYBE' }).service.memoryRecall({ projectId: 'project-alpha', query: 'q' }))
      .rejects.toThrow(/invalid memory recall status/u)

    // 上下文文本允许为空串，但类型不对仍是协议漂移。
    await expect(clientsReturning({ ...recall, context_text: 42 }).service.memoryRecall({ projectId: 'project-alpha', query: 'q' }))
      .rejects.toThrow(/invalid memory context_text/u)

    const item = {
      memory_id: 'memory-1', content: '联调约定', score: 0.8, layer: 'L1', recall_reason: 'CONTENT_MATCH',
      source_run_id: null, updated_at: '2026-09-01T00:00:00.000Z', confidence: 0.6,
    }
    const parsed = await clientsReturning({ ...recall, items: [item] }).service.memoryRecall({ projectId: 'project-alpha', query: 'q' })
    expect(parsed.items[0]?.sourceRunId).toBeNull()
    // 带运行来源的召回条目也必须原样透出（会话来源与运行来源是两种合法事实）。
    const withRun = await clientsReturning({ ...recall, items: [{ ...item, source_run_id: 'run-1' }] })
      .service.memoryRecall({ projectId: 'project-alpha', query: 'q' })
    expect(withRun.items[0]?.sourceRunId).toBe('run-1')
    await expect(clientsReturning({ ...recall, items: [{ ...item, layer: 'L2' }] })
      .service.memoryRecall({ projectId: 'project-alpha', query: 'q' })).rejects.toThrow(/invalid memory recall layer/u)
    await expect(clientsReturning({ ...recall, items: [{ ...item, confidence: 1.5 }] })
      .service.memoryRecall({ projectId: 'project-alpha', query: 'q' })).rejects.toThrow(/invalid memory recall confidence/u)
  })

  it('rejects a mutation status and a cleanup status outside their vocabularies', async () => {
    const capture = { projectId: 'project-alpha', sessionId: 'sess-1', messages: [] }
    expect((await clientsReturning({ status: 'PENDING', event_id: 'evt-1', job_id: 'job-1' })
      .service.memoryCapture(capture, 'key-1')).status).toBe('PENDING')
    await expect(clientsReturning({ status: 'DONE', event_id: 'evt-1', job_id: 'job-1' })
      .service.memoryCapture(capture, 'key-2')).rejects.toThrow(/invalid memory mutation status/u)
    await expect(clientsReturning({ status: 'PENDING', event_id: 'evt-1', job_id: 'job-1', cleanup_status: 'RUNNING' })
      .service.memoryCapture(capture, 'key-3')).rejects.toThrow(/invalid memory cleanup status/u)
  })

  it('rejects memory job kinds and audit roles outside their vocabularies', async () => {
    const job = {
      job_id: 'job-1', event_id: 'evt-1', kind: 'CAPTURE', team_id: 'team-1', project_id: 'project-alpha',
      requested_by_user_id: 'member-1', status: 'PENDING', retryable: true, retry_count: 0,
      created_at: 'a', finished_at: null, error_code: null, revision: 1,
    }
    expect((await clientsReturning({ items: [job] }).service.memoryJobs('project-alpha'))[0]?.jobId).toBe('job-1')
    await expect(clientsReturning({ items: [{ ...job, kind: 'COMPACT' }] }).service.memoryJobs('project-alpha'))
      .rejects.toThrow(/invalid memory job kind/u)
    await expect(clientsReturning({ items: [{ ...job, status: 'RUNNING' }] }).service.memoryJobs('project-alpha'))
      .rejects.toThrow(/invalid memory job status/u)

    const audit = {
      audit_id: 'audit-1', operation: 'memory.confirm', operated_by_user_id: 'member-1', role: 'member',
      memory_id: null, project_id: 'project-alpha', result: 'succeeded', event_id: 'evt-1',
    }
    expect((await clientsReturning({ items: [audit] }).service.memoryAudit('project-alpha'))[0]?.role).toBe('member')
    await expect(clientsReturning({ items: [{ ...audit, role: 'viewer' }] }).service.memoryAudit('project-alpha'))
      .rejects.toThrow(/invalid memory audit role/u)
  })

  it('carries the catalog item members, including the tag list', async () => {
    const item = {
      skill_id: 'skill-1', display_name: '代码评审', runtime_name: 'code-review', summary: '评审变更',
      version: '1.0.0', category: 'quality', tags: ['review', 'go'], published_at: '2026-09-01T00:00:00.000Z',
    }
    const catalog = await clientsReturning({ items: [item] }).service.catalog('project-alpha')
    expect(catalog.items[0]).toMatchObject({ skillId: 'skill-1', tags: ['review', 'go'] })
  })

  it('rejects a knowledge search status and reason outside their vocabularies', async () => {
    const search = { projectId: 'project-alpha', query: '发布', knowledgeBaseIds: ['k-1'] }
    const base = { knowledge_bases: [{ knowledge_base_id: 'k-1', status: 'used', reason: null }], results: [] }
    expect((await clientsReturning(base).service.knowledgeSearch(search)).knowledgeBases[0]?.status).toBe('used')

    const withReason = (reason: string | null): unknown => ({
      knowledge_bases: [{ knowledge_base_id: 'k-1', status: 'skipped', reason }], results: [],
    })
    // 每个声明的跳过原因都是词表内取值；词表外的原因必须拒绝。
    for (const reason of ['processing', 'unavailable', 'forbidden', 'not_found', 'timeout', 'external_error']) {
      expect((await clientsReturning(withReason(reason)).service.knowledgeSearch(search)).knowledgeBases[0]?.reason).toBe(reason)
    }
    expect((await clientsReturning(withReason(null)).service.knowledgeSearch(search)).knowledgeBases[0]?.reason).toBeNull()
    await expect(clientsReturning(withReason('because')).service.knowledgeSearch(search))
      .rejects.toThrow(/invalid knowledge search reason/u)
    await expect(clientsReturning({
      knowledge_bases: [{ knowledge_base_id: 'k-1', status: 'maybe', reason: null }], results: [],
    }).service.knowledgeSearch(search)).rejects.toThrow(/invalid knowledge search status/u)
  })

  it('carries a citation page and the non-null memory timestamps', async () => {
    const search = { projectId: 'project-alpha', query: '发布', knowledgeBaseIds: ['k-1'] }
    const result = {
      knowledge_base_id: 'k-1', knowledge_id: 'doc-1', title: '发布流程', snippet: '片段', score: 0.9,
      source_url: 'https://docs.test/1', version: 'v3', updated_at: '2026-09-01T00:00:00.000Z',
      citation: { page: 12, chunk: 'chunk-2' },
    }
    expect((await clientsReturning({ knowledge_bases: [], results: [result] }).service.knowledgeSearch(search))
      .results[0]?.citation).toEqual({ page: 12, chunk: 'chunk-2' })
    expect((await clientsReturning({ knowledge_bases: [], results: [{ ...result, citation: undefined }] })
      .service.knowledgeSearch(search)).results[0]?.citation).toBeUndefined()
    // 只有分块没有页码（或反之）也是合法引用：缺席的成员不补造。
    expect((await clientsReturning({ knowledge_bases: [], results: [{ ...result, citation: { chunk: 'chunk-3' } }] })
      .service.knowledgeSearch(search)).results[0]?.citation).toEqual({ chunk: 'chunk-3' })
    expect((await clientsReturning({ knowledge_bases: [], results: [{ ...result, citation: { page: 7 } }] })
      .service.knowledgeSearch(search)).results[0]?.citation).toEqual({ page: 7 })

    // 记忆的时间戳可以缺席（null）或给出具体取值，两者都是服务端事实。
    const stamped = {
      ...MEMORY, expires_at: '2026-12-01T00:00:00.000Z', last_recalled_at: '2026-09-02T00:00:00.000Z',
    }
    const memory = await clientsReturning(stamped).service.memoryGet('memory-1')
    expect(memory.expiresAt).toBe('2026-12-01T00:00:00.000Z')
    expect(memory.lastRecalledAt).toBe('2026-09-02T00:00:00.000Z')
  })

  it('carries a finished job outcome and an audit row that names its memory', async () => {
    const job = {
      job_id: 'job-1', event_id: 'evt-1', kind: 'CAPTURE', team_id: 'team-1', project_id: 'project-alpha',
      requested_by_user_id: 'member-1', status: 'FAILED', retryable: false, retry_count: 2,
      created_at: 'a', finished_at: '2026-09-02T00:00:00.000Z', error_code: 'UPSTREAM_TIMEOUT', revision: 2,
    }
    const parsed = await clientsReturning({ items: [job] }).service.memoryJobs('project-alpha')
    expect(parsed[0]).toMatchObject({ finishedAt: '2026-09-02T00:00:00.000Z', errorCode: 'UPSTREAM_TIMEOUT' })

    const audit = {
      audit_id: 'audit-1', operation: 'memory.confirm', operated_by_user_id: 'member-1', role: 'manager',
      memory_id: 'memory-1', project_id: 'project-alpha', result: 'succeeded', event_id: 'evt-1',
    }
    expect((await clientsReturning({ items: [audit] }).service.memoryAudit('project-alpha'))[0]?.memoryId).toBe('memory-1')
  })

  it('rejects a knowledge search envelope that is malformed', async () => {
    const search = { projectId: 'project-alpha', query: '发布', knowledgeBaseIds: ['k-1'] }

    // 非 JSON 响应体、缺 data、code/message 类型不符：三种都必须按协议漂移拒绝。
    const notJson = new TeamSkillHttpClient({
      apiBaseUrl: 'https://service.test/v1', accessToken: 'token-1',
      fetch: async () => new Response('not json', { status: 200, headers: { 'content-type': 'application/json' } }),
    })
    await expect(notJson.knowledgeSearch(search)).rejects.toThrow(/invalid JSON\./u)

    const noData = new TeamSkillHttpClient({
      apiBaseUrl: 'https://service.test/v1', accessToken: 'token-1',
      fetch: async () => new Response(JSON.stringify({ code: 0, message: 'ok', request_id: 'r' }), {
        status: 200, headers: { 'content-type': 'application/json' },
      }),
    })
    await expect(noData.knowledgeSearch(search)).rejects.toThrow(/a response without data/u)

    const badEnvelope = new TeamSkillHttpClient({
      apiBaseUrl: 'https://service.test/v1', accessToken: 'token-1',
      fetch: async () => new Response(JSON.stringify({ code: 'OK', message: 42, request_id: 'r', data: {} }), {
        status: 200, headers: { 'content-type': 'application/json' },
      }),
    })
    await expect(badEnvelope.knowledgeSearch(search)).rejects.toThrow(/invalid response envelope/u)

    // 服务端失败（!= 2xx）同样走错误信封。
    const failing = new TeamSkillHttpClient({
      apiBaseUrl: 'https://service.test/v1', accessToken: 'token-1',
      fetch: async () => new Response(JSON.stringify({ code: 'SERVICE_UNAVAILABLE', message: '维护中', request_id: 'r', data: null }), {
        status: 503, headers: { 'content-type': 'application/json' },
      }),
    })
    await expect(failing.knowledgeSearch(search)).rejects.toThrow(/维护中/u)
  })

  it('sends an account request without a token and maps an account failure', async () => {
    // 登录本身就是没有令牌的请求（614 的另一支）。
    const login = new TeamSkillAccountHttpClient({
      apiBaseUrl: 'https://service.test/v1',
      fetch: async () => new Response(ok(SESSION), { status: 200, headers: { 'content-type': 'application/json' } }),
    })
    expect((await login.login({ username: 'member', password: 'p' })).accessToken).toBe('access-1')

    // 账户平面的失败响应必须映射成稳定的失败，而不是抛出原始 Response。
    const failing = new TeamSkillAccountHttpClient({
      apiBaseUrl: 'https://service.test/v1',
      fetch: async () => new Response(
        JSON.stringify({ code: 'AUTH_REQUIRED', message: '登录已失效', request_id: 'r', data: null }),
        { status: 401, headers: { 'content-type': 'application/json' } },
      ),
    })
    await expect(failing.projects('token-1')).rejects.toThrow(/登录已失效/u)
  })

  it('rejects a non-boolean member and a non-object or non-array payload', async () => {
    const base = {
      knowledge_base_id: 'k-1', name: '平台架构', description: '架构决策', type: 'document',
      state: 'active', searchable: true, updated_at: '2026-09-01T00:00:00.000Z', revision: 2,
    }
    // requireBoolean 的拒绝臂：'yes' 不是布尔。
    await expect(clientsReturning({ items: [{ ...base, searchable: 'yes' }] }).service.knowledgeBases('project-alpha'))
      .rejects.toThrow(/invalid knowledge base searchable/u)

    // requireRecord / requireArray 的拒绝臂：整页不是对象、items 不是数组。
    await expect(clientsReturning(null).account.projects('token-1')).rejects.toThrow(/must be an object|invalid/u)
    await expect(clientsReturning({ items: {} }).account.projects('token-1')).rejects.toThrow(/must be an array|invalid/u)

    // requireString / requireNumber 的拒绝臂：字段类型不对即协议漂移。
    await expect(clientsReturning({ items: [{ ...base, name: 7 }] }).service.knowledgeBases('project-alpha'))
      .rejects.toThrow(/invalid knowledge base name/u)
    await expect(clientsReturning({ items: [{ ...base, revision: -1 }] }).service.knowledgeBases('project-alpha'))
      .rejects.toThrow(/invalid knowledge base revision/u)
  })

  it('carries the catalog cursor, the asset vocabularies and the optional asset owners', async () => {
    const catalog = await clientsReturning({
      items: [{
        skill_id: 'skill-1', display_name: '代码评审', runtime_name: 'code-review', summary: '评审变更',
        version: '1.0.0', category: 'quality', tags: [], published_at: '2026-09-01T00:00:00.000Z',
      }],
      next_cursor: 'cursor-9',
    }).service.catalog('project-alpha')
    expect(catalog.nextCursor).toBe('cursor-9')

    const summaryOf = (assets: readonly unknown[]): unknown => ({
      organizations: [], projects: [],
      assets,
      management_organization_ids: [], management_project_ids: [], revision: 1,
    })
    const owned = { asset_id: 'asset-1', asset_type: 'project', name: '协作台', visibility: 'platform' }
    const scoped = { ...owned, organization_id: 'org-alpha', project_id: 'project-alpha' }
    expect((await clientsReturning(summaryOf([owned])).account.accessSummary('token-1')).assets[0]?.assetId).toBe('asset-1')
    const withOwners = (await clientsReturning(summaryOf([scoped])).account.accessSummary('token-1')).assets[0]
    expect(withOwners).toMatchObject({ organizationId: 'org-alpha', projectId: 'project-alpha' })

    await expect(clientsReturning(summaryOf([{ ...owned, asset_type: 'prompt' }])).account.accessSummary('token-1'))
      .rejects.toThrow(/invalid asset type/u)
    await expect(clientsReturning(summaryOf([{ ...owned, visibility: 'private' }])).account.accessSummary('token-1'))
      .rejects.toThrow(/invalid asset visibility/u)
  })

  it('rejects a trust card whose external access is not a boolean', async () => {
    const card = {
      skill_id: 'skill-1', version: '1.0.0', display_name: '代码评审',
      publisher: { name: '平台管理员', organization_id: 'org-alpha' },
      signature: { key_id: 'key-1', fingerprint: 'fp', signed_at: '2026-09-01T00:00:00.000Z' },
      tool_permissions: [],
      file_scope: { roots: [] },
      external_access: { network: 'yes', hosts: [] },
      recent_audits: [],
    }
    await expect(clientsReturning(card).service.trustCard({ skillId: 'skill-1', version: '1.0.0', projectId: 'project-alpha' }))
      .rejects.toThrow(/invalid trust card external|invalid/u)
  })
})
