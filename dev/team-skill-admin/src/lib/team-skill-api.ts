import type {
  AccountRole,
  AdminKnowledgeBase,
  AdminKnowledgeDeleteImpact,
  AdminKnowledgeDocument,
  AdminKnowledgeGraph,
  AdminKnowledgeOperation,
  AdminMemoryAudit,
  AdminMemoryAuditList,
  AdminMemoryJob,
  AdminMemoryJobList,
  AdminMemoryList,
  AdminMemoryMutation,
  AdminMemoryPolicy,
  AdminMemoryRecord,
  AdminOrganization,
  AdminProject,
  AdminProjectAsset,
  AdminProjectMember,
  AdminUser,
  AuthorizationAudit,
  AuditLogEntry,
  DirectoryUser,
  PermissionDefinition,
  ReviewItem,
  RoleDefinition,
  SkillVersion,
  TeamSkill,
  TelemetryBucket,
  TelemetryDelivery,
  TelemetryEventItem,
  TelemetryEventPage,
  TelemetryModelUsage,
  TelemetryOverview,
  TelemetryProjectSummary,
  TelemetrySummary,
  TelemetryToolUsage,
  CloudAgentProfile,
  CloudAgentType,
  CloudAssetCandidate,
  CloudRun,
  CloudWorkspace,
  CloudWorkspaceAudit,
  CloudAgentProfileVersion,
} from './team-skill-types.ts'

export type ApiError =
  | { readonly kind: 'not-ready'; readonly missing: readonly string[] }
  | { readonly kind: 'unauthorized'; readonly code: string; readonly message: string }
  | { readonly kind: 'forbidden'; readonly code: string; readonly message: string }
  | { readonly kind: 'revision-conflict'; readonly code: 'REVISION_CONFLICT' | 'MEMORY_REVISION_CONFLICT'; readonly message: string }
  | { readonly kind: 'unavailable'; readonly code: 'NETWORK_ERROR' | 'UPSTREAM_UNAVAILABLE'; readonly message: string }
  | { readonly kind: 'service'; readonly code: string; readonly message: string }

export type ApiResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: ApiError }

/**
 * 服务端在响应里声明的证据。云工作空间功能的能力状态只能由它推导，
 * 不能靠 `?? []` / `?? null` 之类的缺省值推断。
 */
export interface ResponseEvidence {
  /** 响应头 `x-fixture-only: true`；没有该响应头就是 false。 */
  readonly fixtureOnly: boolean
  /** 统一 envelope 里的 `request_id`；协议错误时为 null。 */
  readonly requestId: string | null
  /** HTTP 状态码；请求未到达服务端时为 0。 */
  readonly status: number
}

/** 带服务端证据的 API 结果：后台用它显示每个功能的服务端声明状态。 */
export type CloudApiResult<T> = ApiResult<T> & { readonly evidence: ResponseEvidence }

/** 请求根本没发出去（缺配置/网络异常）时的空证据。 */
const EMPTY_EVIDENCE: ResponseEvidence = { fixtureOnly: false, requestId: null, status: 0 }

export interface TeamSkillApiOptions {
  readonly baseUrl?: string
  readonly accessToken?: string
  /** Use the same-origin Auth.js proxy instead of a browser-held service token. */
  readonly sessionAuth?: boolean
  readonly fetcher?: typeof fetch
}

export interface CreateSkillRequest {
  readonly displayName: string
  readonly summary: string
  readonly visibility: TeamSkill['visibility']
  readonly category?: string
  readonly tags?: readonly string[]
  readonly groupId?: string
  readonly peopleIds?: readonly string[]
}

export interface UpdateSkillRequest {
  readonly displayName?: string
  readonly summary?: string
  readonly visibility?: TeamSkill['visibility']
  readonly category?: string
  readonly tags?: readonly string[]
  readonly groupId?: string
  readonly peopleIds?: readonly string[]
}

export interface CreateVersionRequest {
  readonly version: string
  readonly releaseNotes: string
}

export interface UpdateVersionRequest {
  readonly releaseNotes?: string
  readonly dependencies?: readonly string[]
  readonly permissions?: readonly string[]
}

/** Minimal typed REST client for the Skill administration API. */
export class TeamSkillApi {
  private readonly baseUrl?: string
  private readonly accessToken?: string
  private readonly sessionAuth: boolean
  private readonly fetcher: typeof fetch

  constructor(options: TeamSkillApiOptions) {
    const baseUrl = options.baseUrl?.trim()
    const accessToken = options.accessToken?.trim()
    this.baseUrl = baseUrl === undefined || baseUrl.length === 0 ? undefined : baseUrl.replace(/\/$/, '')
    this.accessToken = accessToken === undefined || accessToken.length === 0 ? undefined : accessToken
    this.sessionAuth = options.sessionAuth === true
    const fetcher = options.fetcher ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init))
    this.fetcher = (input, init) => fetcher(input, init)
  }

  /** List directory rows visible to the current admin role. */
  listSkills(): Promise<ApiResult<readonly TeamSkill[]>> {
    return this.request<unknown>('/admin/team-skills').then(result => {
      if (!result.ok) return result
      return !Array.isArray(result.value)
        ? { ok: false, error: { kind: 'service', code: 'INVALID_RESPONSE', message: '服务端未返回有效的 Skill 列表' } }
        : { ok: true, value: result.value as readonly TeamSkill[] }
    })
  }
  /** Search current-organization users for the manual visibility selector. */
  listDirectoryUsers(query = ''): Promise<ApiResult<readonly DirectoryUser[]>> {
    return this.request(`/admin/directory/users?query=${encodeURIComponent(query)}`).then(result => {
      if (!result.ok) return result
      const payload = result.value as {
        readonly items?: readonly {
          readonly user_id: string
          readonly display_name: string
          readonly email: string
          readonly groups: readonly string[]
        }[]
      }
      if (!isRecord(result.value) || !Array.isArray(payload.items))
        return { ok: false, error: { kind: 'service', code: 'INVALID_RESPONSE', message: '服务端未返回有效的目录用户列表' } }
      return {
        ok: true,
        value: (payload.items ?? []).map(item => ({
          userId: item.user_id,
          displayName: item.display_name,
          email: item.email,
          groups: item.groups,
        })),
      }
    })
  }
  /** List the review queue. */
  listReviews(): Promise<ApiResult<readonly ReviewItem[]>> {
    return this.request('/admin/team-skill-reviews?status=pending_review')
  }
  /** List audit records visible to administrators. */
  listAuditLogs(): Promise<ApiResult<readonly AuditLogEntry[]>> {
    return this.request<unknown>('/admin/team-skill-audit-logs').then(result => {
      if (!result.ok) return result
      return Array.isArray(result.value) && result.value.every(isAuditLogEntry)
        ? { ok: true, value: result.value }
        : { ok: false, error: { kind: 'service', code: 'INVALID_RESPONSE', message: '服务端未返回包含操作者姓名的有效 Skill 审计列表' } }
    })
  }
  /** Read role-authorized telemetry aggregation for the requested window. */
  getTelemetryOverview(
    query: { readonly from: string; readonly to: string; readonly organizationId?: string; readonly projectId?: string },
  ): Promise<ApiResult<TelemetryOverview>> {
    const search = new URLSearchParams({ from: query.from, to: query.to })
    if (query.organizationId !== undefined) search.set('organization_id', query.organizationId)
    if (query.projectId !== undefined) search.set('project_id', query.projectId)
    return this.request(`/admin/telemetry/overview?${search.toString()}`).then(result => {
      if (!result.ok) return result
      return isTelemetryOverview(result.value)
        ? { ok: true, value: result.value }
        : { ok: false, error: { kind: 'service', code: 'INVALID_RESPONSE', message: '服务端未返回有效的可观测总览' } }
    })
  }
  /** Read one authorized project's telemetry summary for the requested window. */
  getProjectTelemetrySummary(
    projectId: string,
    query: { readonly from: string; readonly to: string },
  ): Promise<ApiResult<TelemetryProjectSummary>> {
    const search = new URLSearchParams({ from: query.from, to: query.to })
    return this.request(`/admin/projects/${encodeURIComponent(projectId)}/telemetry/summary?${search.toString()}`).then(result => {
      if (!result.ok) return result
      return isTelemetryProjectSummary(result.value)
        ? { ok: true, value: result.value }
        : { ok: false, error: { kind: 'service', code: 'INVALID_RESPONSE', message: '服务端未返回有效的项目可观测摘要' } }
    })
  }
  /** Read one page of an authorized project's structured telemetry events. */
  listProjectTelemetryEvents(
    projectId: string,
    query: {
      readonly from: string
      readonly to: string
      readonly kind?: string
      readonly outcome?: string
      readonly cursor?: string
      readonly limit?: number
    },
  ): Promise<ApiResult<TelemetryEventPage>> {
    const search = new URLSearchParams({ from: query.from, to: query.to })
    if (query.kind !== undefined) search.set('kind', query.kind)
    if (query.outcome !== undefined) search.set('outcome', query.outcome)
    if (query.cursor !== undefined) search.set('cursor', query.cursor)
    if (query.limit !== undefined) search.set('limit', String(query.limit))
    return this.request(`/admin/projects/${encodeURIComponent(projectId)}/telemetry/events?${search.toString()}`).then(result => {
      if (!result.ok) return result
      return isTelemetryEventPage(result.value)
        ? { ok: true, value: result.value }
        : { ok: false, error: { kind: 'service', code: 'INVALID_RESPONSE', message: '服务端未返回有效的事件诊断页' } }
    })
  }
  /** List organizations visible to the current administrator role. */
  listOrganizations(): Promise<ApiResult<readonly AdminOrganization[]>> {
    return this.listEnvelope('/admin/organizations')
  }
  /** Create an organization and optionally assign its initial manager. */
  createOrganization(name: string, managerUserId: string | undefined, idempotencyKey: string): Promise<ApiResult<AdminOrganization>> {
    return this.request('/admin/organizations', {
      method: 'POST',
      body: JSON.stringify({ name, ...(managerUserId === undefined ? {} : { manager_user_id: managerUserId }) }),
      headers: { 'Idempotency-Key': idempotencyKey },
    })
  }
  /** Update organization metadata with optimistic concurrency protection. */
  updateOrganization(
    organizationId: string,
    input: { readonly name?: string; readonly status?: 'active' | 'archived' },
    revision: number,
    idempotencyKey: string,
  ): Promise<ApiResult<AdminOrganization>> {
    return this.mutate(
      `/admin/organizations/${encodeURIComponent(organizationId)}`,
      revision,
      undefined,
      idempotencyKey,
      input,
      'PATCH',
    ) as Promise<ApiResult<AdminOrganization>>
  }
  /** List users in the current administrator scope. */
  listUsers(organizationId?: string, query = ''): Promise<ApiResult<readonly AdminUser[]>> {
    const search = new URLSearchParams()
    if (organizationId !== undefined) search.set('organization_id', organizationId)
    if (query.trim().length > 0) search.set('query', query.trim())
    return this.listEnvelope(`/admin/users${search.size === 0 ? '' : `?${search.toString()}`}`)
  }
  /** Create a manager/member and return the one-time initial password. */
  createUser(
    input: {
      readonly username: string
      readonly displayName: string
      readonly organizationIds: readonly string[]
      readonly globalRole: 'manager' | 'member'
      readonly projectIds?: readonly string[]
    },
    idempotencyKey: string,
  ): Promise<ApiResult<{ readonly user: AdminUser; readonly initial_password: string }>> {
    return this.request('/admin/users', {
      method: 'POST',
      body: JSON.stringify({
        username: input.username,
        display_name: input.displayName,
        organization_ids: input.organizationIds,
        global_role: input.globalRole,
        project_ids: input.projectIds ?? [],
      }),
      headers: { 'Idempotency-Key': idempotencyKey },
    })
  }
  /** Suspend or restore an account with optimistic concurrency protection. */
  updateUser(
    userId: string,
    input: { readonly displayName?: string; readonly status?: 'active' | 'suspended' },
    revision: number,
    idempotencyKey: string,
  ): Promise<ApiResult<AdminUser>> {
    return this.mutate(
      `/admin/users/${encodeURIComponent(userId)}`,
      revision,
      undefined,
      idempotencyKey,
      {
        ...(input.displayName === undefined ? {} : { display_name: input.displayName }),
        ...(input.status === undefined ? {} : { status: input.status }),
      },
      'PATCH',
    ) as Promise<ApiResult<AdminUser>>
  }
  /** Add or reactivate an organization membership without changing the global role. */
  setMembership(
    organizationId: string,
    userId: string,
    revision: number | undefined,
    idempotencyKey: string,
  ): Promise<ApiResult<AdminUser>> {
    return this.mutate(
      `/admin/organizations/${encodeURIComponent(organizationId)}/members/${encodeURIComponent(userId)}`,
      revision,
      undefined,
      idempotencyKey,
      {},
      'PUT',
    ) as Promise<ApiResult<AdminUser>>
  }
  /** Remove an organization membership. */
  removeMembership(organizationId: string, userId: string, revision: number, idempotencyKey: string): Promise<ApiResult<AdminUser>> {
    return this.mutate(
      `/admin/organizations/${encodeURIComponent(organizationId)}/members/${encodeURIComponent(userId)}`,
      revision,
      undefined,
      idempotencyKey,
      undefined,
      'DELETE',
    ) as Promise<ApiResult<AdminUser>>
  }
  /** Read the fixed role dictionary. */
  listRoles(): Promise<ApiResult<readonly RoleDefinition[]>> {
    return this.listEnvelope('/admin/roles')
  }
  /** Read the server-owned permission dictionary. */
  listPermissions(): Promise<ApiResult<readonly PermissionDefinition[]>> {
    return this.listEnvelope('/admin/permissions')
  }
  /** List projects visible to the current administrator role. */
  listProjects(
    options: { readonly organizationId?: string; readonly status?: AdminProject['status']; readonly name?: string } = {},
  ): Promise<ApiResult<readonly AdminProject[]>> {
    const search = new URLSearchParams()
    if (options.organizationId !== undefined) search.set('organization_id', options.organizationId)
    if (options.status !== undefined) search.set('status', options.status)
    if (options.name !== undefined && options.name.trim().length > 0) search.set('name', options.name.trim())
    const suffix = search.size === 0 ? '' : `?${search.toString()}`
    return this.listEnvelope(`/admin/projects${suffix}`)
  }
  /** List active projects authorized for project-memory context resolution. */
  listMemoryProjects(): Promise<ApiResult<readonly AdminProject[]>> {
    return this.listEnvelope('/me/projects')
  }
  /** Read one project. */
  getProject(projectId: string): Promise<ApiResult<AdminProject>> {
    return this.request(`/admin/projects/${encodeURIComponent(projectId)}`)
  }
  /** Create a draft project in one explicitly selected organization. */
  createProject(
    input: { readonly organizationId: string; readonly name: string; readonly description?: string },
    idempotencyKey: string,
  ): Promise<ApiResult<AdminProject>> {
    return this.request('/admin/projects', {
      method: 'POST',
      body: JSON.stringify({
        organization_id: input.organizationId,
        name: input.name,
        ...(input.description === undefined ? {} : { description: input.description }),
      }),
      headers: { 'Idempotency-Key': idempotencyKey },
    })
  }
  /** Update project metadata with optimistic concurrency protection. */
  updateProject(
    projectId: string,
    input: { readonly name?: string; readonly description?: string },
    revision: number,
    idempotencyKey: string,
  ): Promise<ApiResult<AdminProject>> {
    return this.mutate(`/admin/projects/${encodeURIComponent(projectId)}`, revision, undefined, idempotencyKey, input, 'PATCH') as Promise<
      ApiResult<AdminProject>
    >
  }
  /** Explicitly activate a draft project. */
  activateProject(projectId: string, revision: number, idempotencyKey: string): Promise<ApiResult<AdminProject>> {
    return this.mutate(`/admin/projects/${encodeURIComponent(projectId)}:activate`, revision, undefined, idempotencyKey) as Promise<
      ApiResult<AdminProject>
    >
  }
  /** Explicitly archive an active project. */
  archiveProject(projectId: string, revision: number, idempotencyKey: string): Promise<ApiResult<AdminProject>> {
    return this.mutate(`/admin/projects/${encodeURIComponent(projectId)}:archive`, revision, undefined, idempotencyKey) as Promise<
      ApiResult<AdminProject>
    >
  }
  /** List project members and their relation revisions. */
  listProjectMembers(projectId: string): Promise<ApiResult<readonly AdminProjectMember[]>> {
    return this.listEnvelope(`/admin/projects/${encodeURIComponent(projectId)}/members`)
  }
  /** Add or update a project member relation; new relations use the project revision and existing ones use the relation revision. */
  setProjectMember(projectId: string, userId: string, revision: number, idempotencyKey: string): Promise<ApiResult<AdminProject>> {
    return this.mutate(
      `/admin/projects/${encodeURIComponent(projectId)}/members/${encodeURIComponent(userId)}`,
      revision,
      undefined,
      idempotencyKey,
      {},
      'PUT',
    ) as Promise<ApiResult<AdminProject>>
  }
  /** Remove a project member relation. */
  removeProjectMember(projectId: string, userId: string, revision: number, idempotencyKey: string): Promise<ApiResult<AdminProject>> {
    return this.mutate(
      `/admin/projects/${encodeURIComponent(projectId)}/members/${encodeURIComponent(userId)}`,
      revision,
      undefined,
      idempotencyKey,
      undefined,
      'DELETE',
    ) as Promise<ApiResult<AdminProject>>
  }
  /** List the project's authorized asset relations. */
  listProjectAssets(projectId: string): Promise<ApiResult<readonly AdminProjectAsset[]>> {
    return this.listEnvelope(`/admin/projects/${encodeURIComponent(projectId)}/assets`)
  }
  /** Add one asset relation to a project. */
  addProjectAsset(
    projectId: string,
    input: {
      readonly assetType: AdminProjectAsset['asset_type']
      readonly assetId: string
      readonly relationKind: AdminProjectAsset['relation_kind']
      readonly revision: number
    },
    idempotencyKey: string,
  ): Promise<ApiResult<AdminProjectAsset>> {
    return this.mutate(
      `/admin/projects/${encodeURIComponent(projectId)}/assets`,
      input.revision,
      undefined,
      idempotencyKey,
      { asset_type: input.assetType, asset_id: input.assetId, relation_kind: input.relationKind, expected_revision: input.revision },
      'POST',
    ) as Promise<ApiResult<AdminProjectAsset>>
  }
  /** Update one asset relation kind. */
  updateProjectAsset(
    projectId: string,
    assetType: AdminProjectAsset['asset_type'],
    assetId: string,
    relationKind: AdminProjectAsset['relation_kind'],
    revision: number,
    idempotencyKey: string,
  ): Promise<ApiResult<AdminProjectAsset>> {
    return this.mutate(
      `/admin/projects/${encodeURIComponent(projectId)}/assets/${encodeURIComponent(assetType)}/${encodeURIComponent(assetId)}`,
      revision,
      undefined,
      idempotencyKey,
      { relation_kind: relationKind },
      'PATCH',
    ) as Promise<ApiResult<AdminProjectAsset>>
  }
  /** Remove one asset relation. */
  removeProjectAsset(
    projectId: string,
    assetType: AdminProjectAsset['asset_type'],
    assetId: string,
    revision: number,
    idempotencyKey: string,
  ): Promise<ApiResult<AdminProject>> {
    return this.mutate(
      `/admin/projects/${encodeURIComponent(projectId)}/assets/${encodeURIComponent(assetType)}/${encodeURIComponent(assetId)}`,
      revision,
      undefined,
      idempotencyKey,
      undefined,
      'DELETE',
    ) as Promise<ApiResult<AdminProject>>
  }
  /** List authorization audits filtered by organization/action. */
  permissionCheck(body: {
    readonly action: string
    readonly project_id?: string
    readonly simulate_user_id?: string
    readonly agent_profile_version_id?: string
  }): Promise<ApiResult<Record<string, unknown>>> {
    return this.request('/permission-check', { method: 'POST', body: JSON.stringify(body) }).then(result => {
      if (!result.ok) return result
      return typeof result.value === 'object' && result.value !== null
        ? { ok: true, value: result.value as Record<string, unknown> }
        : { ok: false, error: { kind: 'service', code: 'INVALID_RESPONSE', message: '服务端未返回有效的权限判定' } }
    })
  }

  listAuthorizationAudits(organizationId?: string, action?: string, projectId?: string): Promise<ApiResult<readonly AuthorizationAudit[]>> {
    const search = new URLSearchParams()
    if (organizationId !== undefined) search.set('organization_id', organizationId)
    if (action !== undefined && action.length > 0) search.set('action', action)
    if (projectId !== undefined && projectId.length > 0) search.set('project_id', projectId)
    return this.listEnvelope<unknown>(`/admin/authorization-audits${search.size === 0 ? '' : `?${search.toString()}`}`).then(result => {
      if (!result.ok) return result
      return result.value.every(isAuthorizationAudit)
        ? { ok: true, value: result.value }
        : { ok: false, error: { kind: 'service', code: 'INVALID_RESPONSE', message: '服务端未返回包含操作者姓名的有效授权审计列表' } }
    })
  }
  /** List organization knowledge bases in the current management scope. */
  listKnowledgeBases(organizationId?: string): Promise<ApiResult<readonly AdminKnowledgeBase[]>> {
    if (organizationId === undefined) return this.listEnvelope('/admin/knowledge-bases')
    return this.listEnvelope(`/admin/organizations/${encodeURIComponent(organizationId)}/knowledge-bases`)
  }
  /** Create a knowledge base and return its external-operation state. */
  createKnowledgeBase(
    organizationId: string,
    input: { readonly name: string; readonly description: string; readonly type: AdminKnowledgeBase['type'] },
    idempotencyKey: string,
  ): Promise<ApiResult<AdminKnowledgeOperation>> {
    return this.request(`/admin/organizations/${encodeURIComponent(organizationId)}/knowledge-bases`, {
      method: 'POST',
      body: JSON.stringify(input),
      headers: { 'Idempotency-Key': idempotencyKey, 'If-Match': '1' },
    }) as Promise<ApiResult<AdminKnowledgeOperation>>
  }
  /** Read one knowledge base; the response is validated field-by-field so a
   * malformed body can never reach the page state as a partial object. */
  getKnowledgeBase(knowledgeBaseId: string): Promise<ApiResult<AdminKnowledgeBase>> {
    return this.request(`/admin/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}`).then(result => {
      if (!result.ok) return result
      return isKnownKnowledgeBase(result.value)
        ? { ok: true, value: result.value }
        : { ok: false, error: { kind: 'service' as const, code: 'INVALID_RESPONSE', message: '服务端未返回有效的知识库详情' } }
    })
  }
  /** Read projects affected by external knowledge-base deletion. */
  getKnowledgeDeleteImpact(knowledgeBaseId: string): Promise<ApiResult<AdminKnowledgeDeleteImpact>> {
    return this.request(`/admin/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/delete-impact`)
  }
  /** Start an external knowledge-base deletion after an impact confirmation. */
  deleteKnowledgeBase(
    knowledgeBaseId: string,
    revision: number,
    affectedProjectCount: number,
    idempotencyKey: string,
  ): Promise<ApiResult<AdminKnowledgeOperation>> {
    return this.request(`/admin/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}`, {
      method: 'DELETE',
      body: JSON.stringify({ expected_revision: revision, confirm_affected_project_count: affectedProjectCount }),
      headers: { 'Idempotency-Key': idempotencyKey, 'If-Match': String(revision) },
    }) as Promise<ApiResult<AdminKnowledgeOperation>>
  }
  /** Update basic knowledge-base configuration with optimistic concurrency. */
  updateKnowledgeBase(
    knowledgeBaseId: string,
    input: { readonly name?: string; readonly description?: string },
    revision: number,
    idempotencyKey: string,
  ): Promise<ApiResult<AdminKnowledgeBase>> {
    return this.mutate(
      `/admin/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}`,
      revision,
      undefined,
      idempotencyKey,
      input,
      'PATCH',
    ) as Promise<ApiResult<AdminKnowledgeBase>>
  }
  /** List documents and their authoritative processing states. */
  listKnowledgeDocuments(knowledgeBaseId: string): Promise<ApiResult<readonly AdminKnowledgeDocument[]>> {
    return this.listEnvelope(`/admin/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/documents`)
  }
  /** Read one document. */
  getKnowledgeDocument(knowledgeBaseId: string, documentId: string): Promise<ApiResult<AdminKnowledgeDocument>> {
    return this.request(`/admin/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/documents/${encodeURIComponent(documentId)}`)
  }
  /** Start document reprocessing. */
  reparseKnowledgeDocument(
    knowledgeBaseId: string,
    documentId: string,
    revision: number,
    idempotencyKey: string,
  ): Promise<ApiResult<AdminKnowledgeOperation>> {
    return this.request(
      `/admin/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/documents/${encodeURIComponent(documentId)}/reparse`,
      {
        method: 'POST',
        body: JSON.stringify({ expected_revision: revision }),
        headers: { 'Idempotency-Key': idempotencyKey, 'If-Match': String(revision) },
      },
    ) as Promise<ApiResult<AdminKnowledgeOperation>>
  }
  /** Start document deletion. */
  deleteKnowledgeDocument(
    knowledgeBaseId: string,
    documentId: string,
    revision: number,
    idempotencyKey: string,
  ): Promise<ApiResult<AdminKnowledgeOperation>> {
    return this.request(`/admin/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/documents/${encodeURIComponent(documentId)}`, {
      method: 'DELETE',
      body: JSON.stringify({ expected_revision: revision }),
      headers: { 'Idempotency-Key': idempotencyKey, 'If-Match': String(revision) },
    }) as Promise<ApiResult<AdminKnowledgeOperation>>
  }
  /** Read wiki graph data. */
  getKnowledgeGraph(knowledgeBaseId: string): Promise<ApiResult<AdminKnowledgeGraph>> {
    return this.request(`/admin/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/graph`)
  }
  /** Import hand-authored Markdown through an asynchronous service operation. */
  importKnowledgeMarkdown(
    knowledgeBaseId: string,
    input: { readonly title: string; readonly markdown: string },
    revision: number,
    idempotencyKey: string,
  ): Promise<ApiResult<AdminKnowledgeOperation>> {
    return this.request(`/admin/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/documents/markdown`, {
      method: 'POST',
      body: JSON.stringify(input),
      headers: { 'Idempotency-Key': idempotencyKey, 'If-Match': String(revision) },
    }) as Promise<ApiResult<AdminKnowledgeOperation>>
  }
  /** Import a URL as an asynchronous document operation. */
  importKnowledgeUrl(
    knowledgeBaseId: string,
    input: { readonly title?: string; readonly url: string },
    revision: number,
    idempotencyKey: string,
  ): Promise<ApiResult<AdminKnowledgeOperation>> {
    return this.request(`/admin/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/documents/urls`, {
      method: 'POST',
      body: JSON.stringify(input),
      headers: { 'Idempotency-Key': idempotencyKey, 'If-Match': String(revision) },
    }) as Promise<ApiResult<AdminKnowledgeOperation>>
  }
  /** Import one uploaded file descriptor as an asynchronous document operation. */
  importKnowledgeFile(
    knowledgeBaseId: string,
    input: { readonly title: string; readonly file_name: string },
    revision: number,
    idempotencyKey: string,
  ): Promise<ApiResult<AdminKnowledgeOperation>> {
    return this.request(`/admin/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/documents/files`, {
      method: 'POST',
      body: JSON.stringify(input),
      headers: { 'Idempotency-Key': idempotencyKey, 'If-Match': String(revision) },
    }) as Promise<ApiResult<AdminKnowledgeOperation>>
  }
  /** Read one operation status. */
  getKnowledgeOperation(operationId: string): Promise<ApiResult<AdminKnowledgeOperation>> {
    return this.request(`/admin/operations/${encodeURIComponent(operationId)}`) as Promise<ApiResult<AdminKnowledgeOperation>>
  }
  /** List active project memories in the caller's management scope. */
  listMemoryRecords(
    options: {
      readonly projectId?: string
      readonly keyword?: string
      readonly status?: AdminMemoryRecord['status']
      readonly cursor?: string
      readonly limit?: number
    } = {},
  ): Promise<ApiResult<AdminMemoryList>> {
    return this.memoryRequest<AdminMemoryList>(
      '/project-memory/list',
      Object.fromEntries(
        Object.entries({
          project_id: options.projectId,
          keyword: options.keyword,
          status: options.status,
          cursor: options.cursor,
          limit: options.limit,
        }).filter(([, value]) => value !== undefined),
      ),
    ).then(result => {
      if (!result.ok) return result
      if (!isMemoryList(result.value))
        return { ok: false, error: { kind: 'service', code: 'INVALID_RESPONSE', message: '服务端未返回有效的记忆列表' } }
      return result
    })
  }
  /** Read one project-memory detail. */
  getMemoryRecord(memoryId: string): Promise<ApiResult<AdminMemoryRecord>> {
    return this.memoryRequest<unknown>('/project-memory/get', { memory_id: memoryId }).then(result => {
      if (!result.ok) return result
      const value = isRecord(result.value) && isRecord(result.value.memory) ? result.value.memory : result.value
      return isMemoryRecord(value)
        ? { ok: true, value }
        : { ok: false, error: { kind: 'service', code: 'INVALID_RESPONSE', message: '服务端未返回有效的记忆详情' } }
    })
  }
  /** Update one memory with optimistic concurrency. */
  /** Update one memory body. The service requires both concurrency headers. */
  updateMemoryRecord(memoryId: string, content: string, revision: number, idempotencyKey: string): Promise<ApiResult<AdminMemoryRecord>> {
    return this.memoryRequest<unknown>(
      '/project-memory/update',
      { memory_id: memoryId, content, expected_revision: revision },
      { 'If-Match': String(revision), 'Idempotency-Key': idempotencyKey },
    ).then(result => {
      if (!result.ok) return result
      const mutation = parseMemoryMutation(result.value)
      return mutation === undefined || mutation.memory === undefined
        ? { ok: false, error: { kind: 'service', code: 'INVALID_RESPONSE', message: '服务端未返回更新后的记忆' } }
        : { ok: true, value: mutation.memory }
    })
  }
  /** Delete one memory and return the asynchronous cleanup result. */
  deleteMemoryRecord(memoryId: string, revision: number, idempotencyKey: string): Promise<ApiResult<AdminMemoryMutation>> {
    return this.memoryRequest<unknown>(
      '/project-memory/delete',
      { memory_id: memoryId, expected_revision: revision },
      { 'If-Match': String(revision), 'Idempotency-Key': idempotencyKey },
    ).then(result => (result.ok ? parseMemoryMutationResult(result.value) : result))
  }
  /** Read one project's memory policy. */
  getMemoryPolicy(projectId: string): Promise<ApiResult<AdminMemoryPolicy>> {
    return this.memoryRequest<unknown>('/project-memory/policy/get', { scope_type: 'project', scope_id: projectId }).then(result =>
      result.ok ? parseMemoryPolicyResult(result.value) : result,
    )
  }
  /** Update one project's memory policy. */
  updateMemoryPolicy(
    projectId: string,
    patch: { readonly top_k?: number; readonly relevance_threshold?: number; readonly token_budget?: number },
    revision: number,
    idempotencyKey: string,
  ): Promise<ApiResult<AdminMemoryPolicy>> {
    return this.memoryRequest<unknown>(
      '/project-memory/policy/update',
      { scope_type: 'project', scope_id: projectId, patch, expected_revision: revision },
      { 'If-Match': String(revision), 'Idempotency-Key': idempotencyKey },
    ).then(result => (result.ok ? parseMemoryPolicyResult(result.value) : result))
  }
  /** Read project-memory jobs. */
  listMemoryJobs(projectId?: string): Promise<ApiResult<AdminMemoryJobList>> {
    return this.memoryRequest<unknown>('/project-memory/jobs/list', projectId === undefined ? {} : { project_id: projectId }).then(result => {
      if (!result.ok) return result
      return isMemoryJobList(result.value)
        ? { ok: true, value: result.value }
        : { ok: false, error: { kind: 'service', code: 'INVALID_RESPONSE', message: '服务端未返回有效的记忆任务列表' } }
    })
  }
  /** Read project-memory governance audit records. */
  listMemoryAudit(projectId?: string): Promise<ApiResult<AdminMemoryAuditList>> {
    return this.memoryRequest<unknown>('/project-memory/audit/list', projectId === undefined ? {} : { project_id: projectId }).then(result => {
      if (!result.ok) return result
      return isMemoryAuditList(result.value)
        ? { ok: true, value: result.value }
        : { ok: false, error: { kind: 'service', code: 'INVALID_RESPONSE', message: '服务端未返回有效的记忆审计列表' } }
    })
  }
  /** Retry one failed project-memory job. */
  retryMemoryJob(jobId: string, revision: number, idempotencyKey: string): Promise<ApiResult<AdminMemoryJob>> {
    return this.memoryRequest<unknown>(
      '/project-memory/jobs/retry',
      { job_id: jobId, expected_revision: revision },
      { 'Idempotency-Key': idempotencyKey, 'If-Match': String(revision) },
    ).then(result => (result.ok ? parseMemoryJobResult(result.value) : result))
  }
  /** Read a Skill with its version timeline. */
  getSkill(skillId: string): Promise<ApiResult<{ readonly skill: TeamSkill; readonly versions: readonly SkillVersion[] }>> {
    return this.request(`/admin/team-skills/${encodeURIComponent(skillId)}`)
  }
  /** Create the first author-owned draft. */
  createSkill(request: CreateSkillRequest): Promise<ApiResult<TeamSkill>> {
    return this.request('/admin/team-skills', {
      method: 'POST',
      body: JSON.stringify({
        display_name: request.displayName,
        summary: request.summary,
        visibility: request.visibility,
        ...(request.category === undefined ? {} : { category: request.category }),
        ...(request.tags === undefined ? {} : { tags: request.tags }),
        ...(request.groupId === undefined ? {} : { group_id: request.groupId }),
        ...(request.peopleIds === undefined ? {} : { people_ids: request.peopleIds }),
      }),
      headers: { 'Idempotency-Key': crypto.randomUUID() },
    })
  }
  /** Update author-owned metadata for a draft Skill. */
  updateSkill(skillId: string, request: UpdateSkillRequest, revision: number, idempotencyKey: string): Promise<ApiResult<TeamSkill>> {
    return this.mutate(
      `/admin/team-skills/${encodeURIComponent(skillId)}`,
      revision,
      undefined,
      idempotencyKey,
      {
        ...(request.displayName === undefined ? {} : { display_name: request.displayName }),
        ...(request.summary === undefined ? {} : { summary: request.summary }),
        ...(request.visibility === undefined ? {} : { visibility: request.visibility }),
        ...(request.category === undefined ? {} : { category: request.category }),
        ...(request.tags === undefined ? {} : { tags: request.tags }),
        ...(request.groupId === undefined ? {} : { group_id: request.groupId }),
        ...(request.peopleIds === undefined ? {} : { people_ids: request.peopleIds }),
      },
      'PATCH',
    ) as Promise<ApiResult<TeamSkill>>
  }
  /** Create a new immutable-version draft for a Skill. */
  createVersion(skillId: string, request: CreateVersionRequest, revision: number, idempotencyKey: string): Promise<ApiResult<unknown>> {
    return this.mutate(`/admin/team-skills/${encodeURIComponent(skillId)}/versions`, revision, undefined, idempotencyKey, {
      version: request.version,
      release_notes: request.releaseNotes,
    })
  }
  /** Update fields that belong to an unsubmitted draft version. */
  updateVersion(
    skillId: string,
    version: string,
    request: UpdateVersionRequest,
    revision: number,
    idempotencyKey: string,
  ): Promise<ApiResult<unknown>> {
    return this.mutate(
      `/admin/team-skills/${encodeURIComponent(skillId)}/versions/${encodeURIComponent(version)}`,
      revision,
      undefined,
      idempotencyKey,
      {
        ...(request.releaseNotes === undefined ? {} : { release_notes: request.releaseNotes }),
        ...(request.dependencies === undefined ? {} : { dependencies: request.dependencies }),
        ...(request.permissions === undefined ? {} : { permissions: request.permissions }),
      },
      'PATCH',
    )
  }
  /** Upload a platform-hosted immutable DSH Skill ZIP. */
  uploadArtifact(
    skillId: string,
    version: string,
    artifact: Uint8Array,
    revision: number,
    idempotencyKey: string,
  ): Promise<ApiResult<unknown>> {
    const body = new ArrayBuffer(artifact.byteLength)
    new Uint8Array(body).set(artifact)
    return this.request(`/admin/team-skills/${encodeURIComponent(skillId)}/versions/${encodeURIComponent(version)}/artifact`, {
      method: 'PUT',
      body,
      headers: { 'Content-Type': 'application/zip', 'Idempotency-Key': idempotencyKey, 'If-Match': String(revision) },
    })
  }
  /** Submit a validated draft version for administrator review. */
  submitReview(
    skillId: string,
    version: string,
    versionRevision: number,
    skillRevision: number,
    idempotencyKey: string,
  ): Promise<ApiResult<unknown>> {
    return this.request(`/admin/team-skills/${encodeURIComponent(skillId)}/versions/${encodeURIComponent(version)}/submit-review`, {
      method: 'POST',
      body: '{}',
      headers: { 'Idempotency-Key': idempotencyKey, 'If-Match': String(versionRevision), 'X-Skill-Revision': String(skillRevision) },
    })
  }
  /** Publish an approved version with optimistic concurrency protection. */
  publish(
    skillId: string,
    version: string,
    versionRevision: number,
    skillRevision: number,
    idempotencyKey: string,
  ): Promise<ApiResult<unknown>> {
    return this.mutate(
      `/admin/team-skills/${encodeURIComponent(skillId)}/versions/${encodeURIComponent(version)}/publish`,
      versionRevision,
      skillRevision,
      idempotencyKey,
    )
  }
  /** Withdraw a published version. */
  withdraw(
    skillId: string,
    version: string,
    reason: string,
    versionRevision: number,
    skillRevision: number,
    idempotencyKey: string,
  ): Promise<ApiResult<unknown>> {
    return this.mutate(
      `/admin/team-skills/${encodeURIComponent(skillId)}/versions/${encodeURIComponent(version)}/withdraw`,
      versionRevision,
      skillRevision,
      idempotencyKey,
      { reason },
    )
  }
  /** Approve a version after its structured review checks are complete. */
  approve(
    skillId: string,
    version: string,
    checks: Record<string, 'pass' | 'fail' | 'na'>,
    versionRevision: number,
    skillRevision: number,
    idempotencyKey: string,
  ): Promise<ApiResult<unknown>> {
    return this.mutate(
      `/admin/team-skills/${encodeURIComponent(skillId)}/versions/${encodeURIComponent(version)}/approve`,
      versionRevision,
      skillRevision,
      idempotencyKey,
      { checks },
    )
  }
  /** Reject a version with an author-visible reason. */
  reject(
    skillId: string,
    version: string,
    reason: string,
    versionRevision: number,
    skillRevision: number,
    idempotencyKey: string,
  ): Promise<ApiResult<unknown>> {
    return this.mutate(
      `/admin/team-skills/${encodeURIComponent(skillId)}/versions/${encodeURIComponent(version)}/reject`,
      versionRevision,
      skillRevision,
      idempotencyKey,
      { reason },
    )
  }
  /** Select a previously published version as the recommended release. */
  rollback(skillId: string, version: string, revision: number, idempotencyKey: string): Promise<ApiResult<unknown>> {
    return this.mutate(`/admin/team-skills/${encodeURIComponent(skillId)}/rollback`, revision, undefined, idempotencyKey, { version })
  }

  // --- 云工作空间管理域（fixture-only 子集） --------------------------------

  /** 项目资产候选（元数据：授权/readiness/失效原因）；缺字段是协议错误而不是空列表。 */
  cloudAssetCandidates(projectId: string): Promise<CloudApiResult<readonly CloudAssetCandidate[]>> {
    return this.cloudWalkPages<CloudAssetCandidate>(`/admin/asset-candidates?project_id=${encodeURIComponent(projectId)}`).then(result =>
      requireCloudFields(result, '资产候选', ['asset_id', 'asset_type', 'version', 'name', 'authorized', 'readiness', 'invalid_reason', 'updated_at']),
    )
  }

  /** 编辑最新草稿版本（name/model/reasoning/资产/执行策略）；已发布内容不可原地修改。 */
  updateCloudAgentProfile(profileId: string, body: Record<string, unknown>, profileRevision: number, idempotencyKey: string): Promise<CloudApiResult<unknown>> {
    return this.cloudMutate(
      `/admin/agent-profiles/${encodeURIComponent(profileId)}`,
      profileRevision,
      undefined,
      idempotencyKey,
      body,
      'PUT',
    )
  }

  /** Agent 执行器类型、readiness 与扩展 schema；缺字段是协议错误而不是空列表。 */
  cloudAgentTypes(): Promise<CloudApiResult<readonly CloudAgentType[]>> {
    return this.cloudWalkPages<CloudAgentType>('/admin/agent-types').then(result =>
      requireCloudFields(result, 'Agent 类型', ['agent_type_id', 'key', 'name', 'readiness', 'schema_version'], ['capabilities', 'schema']),
    )
  }

  /** 按组织、状态、类型、项目、readiness、创建人和更新时间筛选 Agent 配置；缺字段是协议错误而不是空列表。 */
  cloudAgentProfiles(filters: {
    readonly organizationId?: string
    readonly status?: string
    readonly agentTypeId?: string
    readonly projectId?: string
    readonly readiness?: string
    readonly createdBy?: string
    readonly updatedAfter?: string
  } = {}): Promise<CloudApiResult<readonly CloudAgentProfile[]>> {
    const query = new URLSearchParams()
    if (filters.organizationId !== undefined) query.set('organization_id', filters.organizationId)
    if (filters.status !== undefined) query.set('status', filters.status)
    if (filters.agentTypeId !== undefined) query.set('agent_type_id', filters.agentTypeId)
    if (filters.projectId !== undefined) query.set('project_id', filters.projectId)
    if (filters.readiness !== undefined) query.set('readiness', filters.readiness)
    if (filters.createdBy !== undefined) query.set('created_by', filters.createdBy)
    if (filters.updatedAfter !== undefined) query.set('updated_after', filters.updatedAfter)
    const suffix = query.toString()
    return this.cloudWalkPages<CloudAgentProfile>(`/admin/agent-profiles${suffix.length === 0 ? '' : `?${suffix}`}`)
      .then(result =>
        requireCloudFields(
          result,
          'Agent 配置',
          [
            'agent_profile_id',
            'name',
            'status',
            'revision',
            'readiness',
            'unavailable_reason',
            'created_by',
            'created_at',
            'updated_at',
            'agent_type_name',
            'agent_type_readiness',
            'skill_count',
            'knowledge_count',
            'memory_name',
            'project_count',
          ],
          ['versions', 'project_bindings'],
        ),
      )
      .then(result =>
        requireNestedCloudFields(
          result,
          'Agent 配置',
          'versions',
          ['agent_profile_version_id', 'version', 'status', 'model', 'reasoning', 'change_summary', 'type_extension_config', 'credential_ref', 'asset_bindings'],
          ['asset_version_ids'],
        ),
      )
      .then(result => validateAssetBindings(result))
      .then(result =>
        requireNestedCloudFields(result, 'Agent 配置', 'project_bindings', ['project_id', 'agent_profile_version_id', 'revision']),
      )
  }

  /** 配置详情与版本摘要；与列表行同一套严格校验。 */
  cloudAgentProfile(profileId: string): Promise<ApiResult<CloudAgentProfile>> {
    return this.request<unknown>(`/admin/agent-profiles/${encodeURIComponent(profileId)}`).then(result => {
      if (!result.ok) return result
      const checked = validateCloudProfileShape(result.value)
      return checked.ok
        ? { ok: true, value: checked.profile }
        : { ok: false, error: { kind: 'service' as const, code: 'INVALID_RESPONSE', message: checked.message } }
    })
  }

  /** 创建配置草稿。 */
  createCloudAgentProfile(body: Record<string, unknown>, idempotencyKey: string): Promise<CloudApiResult<unknown>> {
    return this.cloudMutate('/admin/agent-profiles', undefined, undefined, idempotencyKey, body)
  }

  /** 创建新草稿版本；与其它写操作一样携带 If-Match 参与 profile revision 竞争。 */
  createCloudAgentProfileVersion(profileId: string, body: Record<string, unknown>, profileRevision: number, idempotencyKey: string): Promise<CloudApiResult<unknown>> {
    return this.cloudMutate(`/admin/agent-profiles/${encodeURIComponent(profileId)}/versions`, profileRevision, undefined, idempotencyKey, body)
  }

  /** 复制为新配置：新 Profile + 新草稿，不复制项目绑定与发布状态。 */
  cloneCloudAgentProfile(profileId: string, idempotencyKey: string): Promise<CloudApiResult<unknown>> {
    return this.cloudMutate(
      `/admin/agent-profiles/${encodeURIComponent(profileId)}:clone`,
      undefined,
      undefined,
      idempotencyKey,
      {},
    )
  }

  /** 发布版本：发布后不可原地修改。 */
  dryRunCloudAgentProfileVersion(profileId: string, versionId: string): Promise<CloudApiResult<Record<string, unknown>>> {
    return this.cloudRequest(`/admin/agent-profiles/${encodeURIComponent(profileId)}/versions/${encodeURIComponent(versionId)}:dry-run`, {
      method: 'POST',
      body: JSON.stringify({}),
    }).then(result => {
      if (!result.ok) return result
      return typeof result.value === 'object' && result.value !== null
        ? { ok: true, value: result.value as Record<string, unknown>, evidence: result.evidence }
        : { ok: false, error: { kind: 'service' as const, code: 'INVALID_RESPONSE', message: '服务端未返回有效的试运行结果' }, evidence: result.evidence }
    })
  }

  publishCloudAgentProfileVersion(profileId: string, versionId: string, profileRevision: number, idempotencyKey: string): Promise<CloudApiResult<unknown>> {
    return this.cloudMutate(
      `/admin/agent-profiles/${encodeURIComponent(profileId)}/versions/${encodeURIComponent(versionId)}:publish`,
      profileRevision,
      undefined,
      idempotencyKey,
    )
  }

  /** 归档版本：归档版本不能用于新 Run。 */
  archiveCloudAgentProfileVersion(profileId: string, versionId: string, profileRevision: number, idempotencyKey: string): Promise<CloudApiResult<unknown>> {
    return this.cloudMutate(
      `/admin/agent-profiles/${encodeURIComponent(profileId)}/versions/${encodeURIComponent(versionId)}:archive`,
      profileRevision,
      undefined,
      idempotencyKey,
    )
  }

  /** 绑定 published 版本到项目。 */
  bindCloudAgentProfile(
    profileId: string,
    projectId: string,
    profileRevision: number,
    body: Record<string, unknown>,
    idempotencyKey: string,
  ): Promise<CloudApiResult<unknown>> {
    return this.cloudMutate(
      `/admin/agent-profiles/${encodeURIComponent(profileId)}/project-bindings/${encodeURIComponent(projectId)}`,
      profileRevision,
      undefined,
      idempotencyKey,
      body,
      'PUT',
    )
  }

  /** 解除项目绑定。 */
  unbindCloudAgentProfile(
    profileId: string,
    projectId: string,
    profileRevision: number,
    idempotencyKey: string,
  ): Promise<CloudApiResult<unknown>> {
    return this.cloudMutate(
      `/admin/agent-profiles/${encodeURIComponent(profileId)}/project-bindings/${encodeURIComponent(projectId)}`,
      profileRevision,
      undefined,
      idempotencyKey,
      undefined,
      'DELETE',
    )
  }

  /** Workspace 运维列表与筛选；缺字段是协议错误而不是空列表。 */
  cloudWorkspaces(filters: { readonly status?: string; readonly projectId?: string; readonly ownerUserId?: string; readonly branch?: string } = {}): Promise<CloudApiResult<readonly CloudWorkspace[]>> {
    const query = new URLSearchParams()
    if (filters.status !== undefined) query.set('status', filters.status)
    if (filters.projectId !== undefined) query.set('project_id', filters.projectId)
    if (filters.ownerUserId !== undefined) query.set('owner_user_id', filters.ownerUserId)
    if (filters.branch !== undefined) query.set('branch', filters.branch)
    const suffix = query.toString()
    return this.cloudListEnvelope<CloudWorkspace>(`/admin/workspaces${suffix.length === 0 ? '' : `?${suffix}`}`).then(result =>
      requireCloudRows(result, 'Workspace', isCloudWorkspace),
    )
  }

  /**
   * Workspace 详情、快照与审计关联。
   * 详情必须携带 `recent_audits` / `runs` / `config_snapshot` 三个服务端字段：
   * 缺任何一个都返回 INVALID_RESPONSE（BLOCKED），而不是静默回落成空列表/空详情。
   */
  cloudWorkspace(workspaceId: string): Promise<CloudApiResult<CloudWorkspace>> {
    return this.cloudRequest<unknown>(`/admin/workspaces/${encodeURIComponent(workspaceId)}`).then(result => {
      if (!result.ok) return result
      if (!isCloudWorkspace(result.value)) {
        return invalidResponse(result.evidence, '服务端未返回符合合同的 Workspace 详情')
      }
      const value = result.value
      const required = ['recent_audits', 'runs', 'config_snapshot']
      const missing = required.filter(key => !Object.hasOwn(value, key))
      if (missing.length > 0) return invalidResponse(result.evidence, `Workspace 详情缺少必需字段：${missing.join('、')}`)
      if (!Array.isArray(value.recent_audits) || !Array.isArray(value.runs)) {
        return invalidResponse(result.evidence, 'Workspace 详情 recent_audits/runs 必须是数组')
      }
      if (!value.recent_audits.every(row => isCloudWorkspaceAudit(row))) {
        return invalidResponse(result.evidence, 'Workspace 详情 recent_audits 行不符合审计合同')
      }
      for (const [index, row] of value.runs.entries()) {
        if (isCloudRun(row) && Array.isArray((row as Record<string, unknown>).asset_version_ids)) continue
        return invalidResponse(result.evidence, `Workspace 详情 runs 第 ${index + 1} 行不符合 Run 合同`)
      }
      if (value.config_snapshot !== null && !isRecord(value.config_snapshot)) {
        return invalidResponse(result.evidence, 'Workspace 详情 config_snapshot 必须是对象或 null')
      }
      return { ok: true, value: result.value as unknown as CloudWorkspace, evidence: result.evidence }
    })
  }

  /** 管理员允许范围内的停止，带当前 revision。 */
  stopCloudWorkspace(workspaceId: string, revision: number, idempotencyKey: string): Promise<CloudApiResult<unknown>> {
    return this.cloudMutate(
      `/admin/workspaces/${encodeURIComponent(workspaceId)}:stop`,
      undefined,
      undefined,
      idempotencyKey,
      { expected_workspace_revision: revision },
    )
  }

  /** 管理员允许范围内的启动，带当前 revision。 */
  startCloudWorkspace(workspaceId: string, revision: number, idempotencyKey: string): Promise<CloudApiResult<unknown>> {
    return this.cloudMutate(
      `/admin/workspaces/${encodeURIComponent(workspaceId)}:start`,
      revision,
      undefined,
      idempotencyKey,
      { expected_workspace_revision: revision },
    )
  }

  /** 全局 Run 检索；缺字段是协议错误而不是空列表。 */
  cloudRuns(filters: Record<string, string> = {}): Promise<CloudApiResult<readonly CloudRun[]>> {
    return this.cloudRequest<unknown>('/admin/runs', { method: 'POST', body: JSON.stringify(filters) }).then(result => {
      if (!result.ok) return result
      if (!isRecord(result.value) || !Array.isArray(result.value.items))
        return invalidResponse(result.evidence, '服务端未返回有效的 Run 列表')
      const rows = result.value.items as readonly CloudRun[]
      const typed = requireCloudRows({ ok: true, value: rows, evidence: result.evidence }, 'Run', isCloudRun)
      if (!typed.ok) return typed
      // The run's asset snapshot is part of the contract, so a row whose
      // `asset_version_ids` is not an array is protocol drift like any other.
      const raw = result.value.items as readonly unknown[]
      const missingAssetIds = raw.findIndex(row => !Array.isArray((row as { asset_version_ids?: unknown }).asset_version_ids))
      if (missingAssetIds >= 0) {
        return invalidResponse(result.evidence, `Run第 ${missingAssetIds + 1} 行缺少数组字段：asset_version_ids`)
      }
      return typed
    })
  }

  /** Run 详情、事件与配置快照。 */
  cloudRun(runId: string): Promise<ApiResult<CloudRun>> {
    return this.request<unknown>(`/admin/runs/${encodeURIComponent(runId)}`).then(result => {
      if (!result.ok) return result
      return isRecord(result.value)
        ? { ok: true, value: result.value as unknown as CloudRun }
        : { ok: false, error: { kind: 'service', code: 'INVALID_RESPONSE', message: '服务端未返回有效的 Run 详情' } }
    })
  }

  /** 管理面读取运行脉搏（§11.11）。 */
  runPulse(runId: string): Promise<CloudApiResult<Record<string, unknown>>> {
    return this.cloudRequest(`/admin/runs/${encodeURIComponent(runId)}/pulse`).then(result => {
      if (!result.ok) return result
      return typeof result.value === 'object' && result.value !== null
        ? { ok: true as const, value: result.value as Record<string, unknown>, evidence: result.evidence }
        : { ok: false as const, error: { kind: 'service' as const, code: 'INVALID_RESPONSE', message: '服务端未返回有效的运行脉搏' }, evidence: result.evidence }
    })
  }

  /** 管理面读取工作空间变更（§11.13 项目文件证据）。 */
  cloudChanges(workspaceId: string): Promise<CloudApiResult<Record<string, unknown>>> {
    return this.cloudRequest(`/admin/workspaces/${encodeURIComponent(workspaceId)}/changes`).then(result => {
      if (!result.ok) return result
      return typeof result.value === 'object' && result.value !== null
        ? { ok: true as const, value: result.value as Record<string, unknown>, evidence: result.evidence }
        : { ok: false as const, error: { kind: 'service' as const, code: 'INVALID_RESPONSE', message: '服务端未返回有效的变更列表' }, evidence: result.evidence }
    })
  }

  /** Workspace/Run/配置统一审计查询；每行必须携带字面字段 actor_name。 */
  cloudAudits(filters: { readonly workspaceId?: string; readonly projectId?: string; readonly runId?: string; readonly agentProfileId?: string; readonly action?: string } = {}): Promise<CloudApiResult<readonly CloudWorkspaceAudit[]>> {
    const query = new URLSearchParams()
    if (filters.workspaceId !== undefined) query.set('workspace_id', filters.workspaceId)
    if (filters.projectId !== undefined) query.set('project_id', filters.projectId)
    if (filters.runId !== undefined) query.set('run_id', filters.runId)
    if (filters.agentProfileId !== undefined) query.set('agent_profile_id', filters.agentProfileId)
    if (filters.action !== undefined) query.set('action', filters.action)
    const suffix = query.toString()
    return this.cloudRequest<unknown>(`/admin/audits${suffix.length === 0 ? '' : `?${suffix}`}`).then(result => {
      if (!result.ok) return result
      if (!Array.isArray(result.value)) return invalidResponse(result.evidence, '服务端未返回有效的审计列表')
      const rows = result.value as unknown[]
      if (rows.some(row => !isCloudWorkspaceAudit(row)))
        return invalidResponse(result.evidence, '审计行缺少 actor_name 或关联字段')
      return { ok: true, value: rows as readonly CloudWorkspaceAudit[], evidence: result.evidence }
    })
  }

  private async mutate(
    path: string,
    versionRevision: number | undefined,
    skillRevision: number | undefined,
    idempotencyKey: string,
    body?: unknown,
    method: 'POST' | 'PATCH' | 'PUT' | 'DELETE' = 'POST',
  ): Promise<ApiResult<unknown>> {
    return this.request(path, {
      method,
      headers: {
        'Idempotency-Key': idempotencyKey,
        ...(versionRevision === undefined ? {} : { 'If-Match': String(versionRevision) }),
        ...(skillRevision === undefined ? {} : { 'X-Skill-Revision': String(skillRevision) }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<ApiResult<T>> {
    return this.requestAt(this.baseUrl, path, init)
  }

  private listEnvelope<T>(path: string): Promise<ApiResult<readonly T[]>> {
    return this.request<unknown>(path).then(result => {
      if (!result.ok) return result
      if (!isRecord(result.value) || !Array.isArray(result.value.items))
        return { ok: false, error: { kind: 'service', code: 'INVALID_RESPONSE', message: '服务端未返回有效的列表' } }
      return { ok: true, value: result.value.items as readonly T[] }
    })
  }

  private memoryRequest<T>(path: string, body: unknown, headers: HeadersInit = {}): Promise<ApiResult<T>> {
    const baseUrl = this.baseUrl?.replace(/\/v1\/?$/u, '/v3')
    const requestPath = baseUrl === this.baseUrl && this.baseUrl?.startsWith('/api/team-skill') === true ? `/v3${path}` : path
    return this.requestAt<T>(baseUrl, requestPath, { method: 'POST', headers, body: JSON.stringify(body) })
  }

  private requestAt<T>(baseUrl: string | undefined, path: string, init: RequestInit = {}): Promise<ApiResult<T>> {
    const missing = [
      baseUrl === undefined ? 'baseUrl' : undefined,
      this.accessToken === undefined && !this.sessionAuth ? 'accessToken' : undefined,
    ].filter((value): value is string => value !== undefined)
    if (missing.length > 0) return Promise.resolve({ ok: false, error: { kind: 'not-ready', missing } })
    return this.fetchRequest<T>(baseUrl!, path, init)
  }

  private async fetchRequest<T>(baseUrl: string, path: string, init: RequestInit): Promise<ApiResult<T>> {
    return (await this.fetchRequestDetailed<T>(baseUrl, path, init)).result
  }

  /**
   * 发送一次请求，同时把服务端声明的证据（fixture 头 / request_id / HTTP 状态）
   * 原样带出来，供云工作空间后台显示能力状态。
   */
  /**
   * Opens one streaming request through the same authorized chain the JSON
   * calls use: the deployment base URL, the session bearer token when one is
   * configured, and the response body left unread so the caller can consume it
   * frame by frame. Only `text/event-stream` responses reach here, so the JSON
   * envelope handling stays where it belongs.
   * @param path - Service path beginning with `/`.
   * @param init - Method, headers and abort signal for the connection.
   * @returns the raw response.
   */
  cloudStream(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
    const baseUrl = this.baseUrl
    if (baseUrl === undefined) {
      return Promise.resolve(Response.json(
        { code: 'SERVICE_UNAVAILABLE', message: 'Skill 服务尚未配置', request_id: crypto.randomUUID(), data: null },
        { status: 503 },
      ))
    }
    // A relative path is joined to the deployment base; an absolute URL is used
    // as given, so the caller can stream from either shape.
    const path = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const target = /^https?:/u.test(path) ? path : `${baseUrl}${path}`
    const headers = new Headers(init.headers)
    if (this.accessToken !== undefined) headers.set('Authorization', `Bearer ${this.accessToken}`)
    return this.fetcher(target, { ...init, headers })
  }

  private async fetchRequestDetailed<T>(
    baseUrl: string,
    path: string,
    init: RequestInit,
  ): Promise<{ readonly result: ApiResult<T>; readonly evidence: ResponseEvidence }> {
    try {
      const response = await this.fetcher(`${baseUrl}${path}`, {
        ...init,
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          ...(this.accessToken === undefined ? {} : { Authorization: `Bearer ${this.accessToken}` }),
          ...init.headers,
        },
      })
      const payload = await readJson(response)
      const evidence: ResponseEvidence = {
        fixtureOnly: response.headers.get('x-fixture-only') === 'true',
        requestId: isRecord(payload) && typeof payload.request_id === 'string' ? payload.request_id : null,
        status: response.status,
      }
      return { result: classifyResponse<T>(response, payload), evidence }
    } catch (error) {
      return {
        result: {
          ok: false,
          error: { kind: 'unavailable', code: 'NETWORK_ERROR', message: error instanceof Error ? error.message : '无法连接 Skill 服务' },
        },
        evidence: EMPTY_EVIDENCE,
      }
    }
  }

  /** 云工作空间读取：保留服务端证据，缺配置时给出显式 not-ready。 */
  private async cloudRequest<T>(path: string, init: RequestInit = {}): Promise<CloudApiResult<T>> {
    const missing = [
      this.baseUrl === undefined ? 'baseUrl' : undefined,
      this.accessToken === undefined && !this.sessionAuth ? 'accessToken' : undefined,
    ].filter((value): value is string => value !== undefined)
    if (missing.length > 0) return { ok: false, error: { kind: 'not-ready', missing }, evidence: EMPTY_EVIDENCE }
    const { result, evidence } = await this.fetchRequestDetailed<T>(this.baseUrl!, path, init)
    return result.ok ? { ok: true, value: result.value, evidence } : { ok: false, error: result.error, evidence }
  }

  /** 云工作空间写操作：同样保留服务端证据。 */
  private async cloudMutate(
    path: string,
    versionRevision: number | undefined,
    skillRevision: number | undefined,
    idempotencyKey: string,
    body?: unknown,
    method: 'POST' | 'PATCH' | 'PUT' | 'DELETE' = 'POST',
  ): Promise<CloudApiResult<unknown>> {
    return this.cloudRequest(path, {
      method,
      headers: {
        'Idempotency-Key': idempotencyKey,
        ...(versionRevision === undefined ? {} : { 'If-Match': String(versionRevision) }),
        ...(skillRevision === undefined ? {} : { 'X-Skill-Revision': String(skillRevision) }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  }

  /** 云工作空间列表：严格校验 items envelope。 */
  private cloudListEnvelope<T>(path: string): Promise<CloudApiResult<readonly T[]>> {
    return this.cloudRequest<unknown>(path).then(result => {
      if (!result.ok) return result
      if (!isRecord(result.value) || !Array.isArray(result.value.items))
        return invalidResponse(result.evidence, '服务端未返回有效的列表')
      return { ok: true, value: result.value.items as readonly T[], evidence: result.evidence }
    })
  }

  /**
   * 不透明分页游走：服务端 cursor 原样回传（不解析内容），一直拉到服务端明确声明
   * 耗尽（`next_cursor` 为 `null`/缺省）为止。
   *
   * 两种无法收敛的情形都**显式失败**，绝不返回部分列表冒充完整结果：
   * - 服务端重复给出已消费过的 cursor（循环）→ `INVALID_RESPONSE`；
   * - 页数达到 `PAGE_WALK_LIMIT`（1000）→ `PAGINATION_LIMIT`。
   *
   * 该上限只是**失控保护，不是产品限制**：正常规模不会触达；一旦触达就意味着
   * 「不知道服务端还有没有下一页」，因此只能失败，不能当成读完。
   */
  private async cloudWalkPages<T>(path: string): Promise<CloudApiResult<readonly T[]>> {
    const all: T[] = []
    let evidence: ResponseEvidence | undefined
    let cursor: string | undefined
    const seen = new Set<string>()
    for (let page = 0; ; page += 1) {
      if (page >= PAGE_WALK_LIMIT) {
        // 失控保护：超过上限时显式失败，绝不把截断的列表当成完整结果返回。
        return paginationLimit(evidence ?? EMPTY_EVIDENCE, `分页超过实现上限 ${String(PAGE_WALK_LIMIT)} 页，结果不完整`)
      }
      const separated = path.includes('?') ? '&' : '?'
      const pagePath = cursor === undefined ? path : `${path}${separated}cursor=${encodeURIComponent(cursor)}`
      const result = await this.cloudRequest<unknown>(pagePath)
      if (!result.ok) return result
      if (!isRecord(result.value) || !Array.isArray(result.value.items)) {
        return invalidResponse(result.evidence, '服务端未返回有效的列表')
      }
      all.push(...(result.value.items as T[]))
      evidence = result.evidence
      const next = result.value.next_cursor
      if (next === undefined || next === null) break
      if (typeof next !== 'string') return invalidResponse(result.evidence, 'next_cursor 必须是字符串或 null')
      if (seen.has(next)) {
        // 循环游标：服务端把已消费过的游标再给一次，分页永远不会收敛。
        return invalidResponse(result.evidence, `服务端重复返回游标，分页无法收敛：${next}`)
      }
      seen.add(next)
      cursor = next
    }
    return { ok: true, value: all, evidence: evidence as ResponseEvidence }
  }

  /** 分页列表骨架：游走全部页后返回合并行（校验由调用方接续）。 */
  private async cloudWalkList<T>(path: string): Promise<CloudApiResult<readonly T[]>> {
    return this.cloudWalkPages<T>(path)
  }

  private memoryList<T>(path: string, body: Record<string, unknown>): Promise<ApiResult<readonly T[]>> {
    return this.memoryRequest<unknown>(path, body).then(result => {
      if (!result.ok) return result
      const value = isRecord(result.value) && Array.isArray(result.value.items) ? (result.value.items as readonly T[]) : undefined
      return value === undefined
        ? { ok: false, error: { kind: 'service', code: 'INVALID_RESPONSE', message: '服务端未返回有效的记忆列表' } }
        : { ok: true, value }
    })
  }
}

/**
 * 校验一个版本的 `asset_bindings` 结构：skill/knowledge 条目必须带明确的
 * `asset_version_id` 与 `required` 布尔；memory 只能是同形对象或 null。
 */
function validateAssetBindings<T>(result: CloudApiResult<readonly T[]>): CloudApiResult<readonly T[]> {
  if (!result.ok) return result
  const invalid = (message: string): CloudApiResult<readonly T[]> => invalidResponse(result.evidence, message)
  for (const row of result.value) {
    if (!isRecord(row)) continue
    const versions = row.versions
    if (!Array.isArray(versions)) continue
    for (const version of versions) {
      if (!isRecord(version)) continue
      const bindings = version.asset_bindings
      if (!isRecord(bindings)) return invalid('Agent 配置版本缺少 asset_bindings 对象')
      for (const key of ['skills', 'knowledge_bases'] as const) {
        const list = bindings[key]
        if (!Array.isArray(list)) return invalid(`asset_bindings.${key} 必须是数组`)
        for (const entry of list) {
          if (!isRecord(entry)) return invalid(`asset_bindings.${key} 条目必须是对象`)
          if (typeof entry.asset_version_id !== 'string' || entry.asset_version_id.length === 0) {
            return invalid(`asset_bindings.${key} 条目缺少 asset_version_id`)
          }
          if (typeof entry.required !== 'boolean') return invalid(`asset_bindings.${key} 条目缺少 required 布尔标记`)
        }
      }
      const memory = bindings.memory
      if (memory !== null && !isRecord(memory)) return invalid('asset_bindings.memory 必须是对象或 null')
      if (isRecord(memory) && (typeof memory.asset_version_id !== 'string' || typeof memory.required !== 'boolean')) {
        return invalid('asset_bindings.memory 条目缺少 asset_version_id 或 required')
      }
    }
  }
  return result
}

/**
 * 配置详情行校验：与列表行同一套字段合同。通过返回 Profile，任何缺字段、
 * 类型错误或结构漂移都返回错误消息（调用方转 INVALID_RESPONSE）。
 */
function validateCloudProfileShape(value: unknown): { readonly ok: true; readonly profile: CloudAgentProfile } | { readonly ok: false; readonly message: string } {
  const fail = (message: string): { readonly ok: false; readonly message: string } => ({ ok: false, message })
  for (const row of [value]) {
    if (!isRecord(row)) return fail('Agent 配置行不是对象')
    const missing = [
      'agent_profile_id',
      'name',
      'status',
      'revision',
      'readiness',
      'unavailable_reason',
      'created_by',
      'created_at',
      'updated_at',
      'agent_type_name',
      'agent_type_readiness',
      'skill_count',
      'knowledge_count',
      'memory_name',
      'project_count',
    ]
      .filter(key => !Object.hasOwn(row, key))
    if (missing.length > 0) return fail(`Agent 配置行缺少必需字段：${missing.join('、')}`)
    for (const key of ['versions', 'project_bindings'] as const) {
      if (!Array.isArray(row[key])) return fail(`Agent 配置行缺少数组字段：${key}`)
    }
    for (const version of row.versions as readonly unknown[]) {
      if (!isRecord(version)) return fail('Agent 配置版本行不是对象')
      const versionRequired = ['agent_profile_version_id', 'version', 'status', 'model', 'reasoning', 'change_summary', 'type_extension_config', 'credential_ref', 'asset_version_ids', 'asset_bindings']
      const missingVersion = versionRequired.filter(key => !Object.hasOwn(version, key))
      if (missingVersion.length > 0) return fail(`Agent 配置版本缺少必需字段：${missingVersion.join('、')}`)
      if (!Array.isArray(version.asset_version_ids) || !isRecord(version.asset_bindings)) {
        return fail('Agent 配置版本的 asset_version_ids 必须是数组、asset_bindings 必须是对象')
      }
      if (!isRecord(version.type_extension_config)) return fail('Agent 配置版本的 type_extension_config 必须是对象')
      const bindings = version.asset_bindings
      for (const key of ['skills', 'knowledge_bases'] as const) {
        const list = bindings[key]
        if (!Array.isArray(list)) return fail(`asset_bindings.${key} 必须是数组`)
        for (const entry of list) {
          if (!isRecord(entry) || typeof entry.asset_version_id !== 'string' || entry.asset_version_id.length === 0 || typeof entry.required !== 'boolean') {
            return fail(`asset_bindings.${key} 条目缺少 asset_version_id 或 required 布尔标记`)
          }
        }
      }
      const memory = bindings.memory
      if (memory !== null) {
        if (!isRecord(memory) || typeof memory.asset_version_id !== 'string' || typeof memory.required !== 'boolean') {
          return fail('asset_bindings.memory 必须是带 asset_version_id 与 required 的对象或 null')
        }
      }
      const credential = version.credential_ref
      if (credential !== null && (!isRecord(credential) || typeof credential.name !== 'string' || typeof credential.kind !== 'string' || typeof credential.authorized !== 'boolean')) {
        return fail('credential_ref 必须是带 name/kind/authorized/readiness 的对象或 null')
      }
    }
    for (const binding of row.project_bindings as readonly unknown[]) {
      if (!isRecord(binding)) return fail('项目绑定行不是对象')
      const missingBinding = ['project_id', 'agent_profile_version_id', 'revision'].filter(key => !Object.hasOwn(binding, key))
      if (missingBinding.length > 0) return fail(`项目绑定缺少必需字段：${missingBinding.join('、')}`)
    }
  }
  return { ok: true, profile: value as CloudAgentProfile }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isAuditLogEntry(value: unknown): value is AuditLogEntry {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.occurredAt === 'string' &&
    typeof value.actor_name === 'string' &&
    value.actor_name.trim().length > 0 &&
    typeof value.action === 'string' &&
    typeof value.skillName === 'string' &&
    typeof value.version === 'string' &&
    (value.scope === undefined || value.scope === 'project' || value.scope === 'global') &&
    (value.result === 'succeeded' || value.result === 'failed' || value.result === 'cancelled') &&
    typeof value.requestId === 'string'
  )
}

function isAuthorizationAudit(value: unknown): value is AuthorizationAudit {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.occurred_at === 'string' &&
    typeof value.actor_user_id === 'string' &&
    typeof value.actor_name === 'string' &&
    value.actor_name.trim().length > 0 &&
    (value.organization_id === undefined || typeof value.organization_id === 'string') &&
    (value.target_user_id === undefined || typeof value.target_user_id === 'string') &&
    (value.project_id === undefined || typeof value.project_id === 'string') &&
    typeof value.action === 'string' &&
    (value.result === 'succeeded' || value.result === 'failed') &&
    (value.error_code === undefined || typeof value.error_code === 'string') &&
    typeof value.request_id === 'string'
  )
}

function successEnvelope(value: unknown): { readonly code: number | string; readonly message: string; readonly request_id: string; readonly data: unknown } | undefined {
  if (!isRecord(value) || !Object.hasOwn(value, 'data')) return undefined
  if ((typeof value.code !== 'number' && typeof value.code !== 'string') || typeof value.message !== 'string' || typeof value.request_id !== 'string')
    return undefined
  return value as { readonly code: number | string; readonly message: string; readonly request_id: string; readonly data: unknown }
}

/** 把一次 HTTP 响应分类成统一 ApiResult：2xx 只代表传输成功。 */
function classifyResponse<T>(response: Response, payload: unknown): ApiResult<T> {
  if (response.ok) {
    // 204 无内容：合法的无body成功。
    if (response.status === 204) return { ok: true, value: undefined as T }
    const envelope = successEnvelope(payload)
    if (envelope === undefined)
      return { ok: false, error: { kind: 'service', code: 'INVALID_RESPONSE', message: '服务端响应不是有效的统一 envelope' } }
    // 2xx 只代表传输成功：业务成败由 envelope.code === 0 判定，非零业务码
    // 进入失败分类并保留 request_id，防止上游业务失败被误判为成功。
    if (envelope.code !== 0 && envelope.code !== '0') {
      const code = String(envelope.code)
      const message = envelope.message
      if (response.status === 401 || code === 'UNAUTHORIZED' || code === 'AUTH_REQUIRED' || code === 'TOKEN_EXPIRED' || code === 'TOKEN_REVOKED')
        return { ok: false, error: { kind: 'unauthorized', code, message } }
      if (response.status === 403 || code === 'FORBIDDEN' || code === 'PROJECT_ACCESS_DENIED')
        return { ok: false, error: { kind: 'forbidden', code, message } }
      if (code === 'REVISION_CONFLICT' || code === 'MEMORY_REVISION_CONFLICT')
        return { ok: false, error: { kind: 'revision-conflict', code, message } }
      return { ok: false, error: { kind: 'service', code, message } }
    }
    if (envelope.data === undefined || envelope.data === null)
      return { ok: false, error: { kind: 'service', code: 'INVALID_RESPONSE', message: '成功响应缺少 data 字段' } }
    return { ok: true, value: envelope.data as T }
  }
  const envelope = successEnvelope(payload)
  if (envelope === undefined || envelope.data !== null)
    return { ok: false, error: { kind: 'service', code: 'INVALID_RESPONSE', message: '服务端错误响应不是有效的统一 envelope' } }
  const code = String(envelope.code)
  const message = envelope.message
  if (response.status === 401 || code === 'UNAUTHORIZED' || code === 'AUTH_REQUIRED' || code === 'TOKEN_EXPIRED' || code === 'TOKEN_REVOKED')
    return { ok: false, error: { kind: 'unauthorized', code, message } }
  if (response.status === 403 || code === 'FORBIDDEN' || code === 'PROJECT_ACCESS_DENIED')
    return { ok: false, error: { kind: 'forbidden', code, message } }
  if (code === 'REVISION_CONFLICT' || code === 'MEMORY_REVISION_CONFLICT')
    return { ok: false, error: { kind: 'revision-conflict', code, message } }
  return { ok: false, error: { kind: 'service', code, message } }
}

/** 协议错误（缺字段、非 envelope、无效 JSON）统一带证据返回。 */
function invalidResponse<T>(evidence: ResponseEvidence, message: string): CloudApiResult<T> {
  return { ok: false, error: { kind: 'service', code: 'INVALID_RESPONSE', message }, evidence }
}

/**
 * 分页游走的页数上限：只是失控保护，不是产品限制。
 *
 * 达到上限意味着「不知道服务端还有没有下一页」，所以必须显式失败——
 * 返回一个恰好到这里为止的列表会让调用方把截断当成完整结果。
 * 服务端重复游标（循环）另有一条更早触发的显式失败。
 */
const PAGE_WALK_LIMIT = 1000

/** 分页无法收敛（超过实现上限）：显式失败并保留证据。 */
function paginationLimit<T>(evidence: ResponseEvidence, message: string): CloudApiResult<T> {
  return { ok: false, error: { kind: 'service', code: 'PAGINATION_LIMIT', message }, evidence }
}

/**
 * 云工作空间列表行的必需服务端字段校验。缺字段是协议错误，
 * 必须显式失败，不能回落成空列表或默认值。
 */
function requireCloudFields<T>(
  result: CloudApiResult<readonly T[]>,
  label: string,
  required: readonly string[],
  arrayFields: readonly string[] = [],
): CloudApiResult<readonly T[]> {
  if (!result.ok) return result
  for (const row of result.value) {
    if (!isRecord(row)) return invalidResponse(result.evidence, `${label}行不是对象`)
    const missing = required.filter(key => !Object.hasOwn(row, key))
    if (missing.length > 0) return invalidResponse(result.evidence, `${label}行缺少必需字段：${missing.join('、')}`)
    const missingArrays = arrayFields.filter(key => !Array.isArray(row[key]))
    if (missingArrays.length > 0) return invalidResponse(result.evidence, `${label}行缺少数组字段：${missingArrays.join('、')}`)
  }
  return result
}

/** 嵌套列表字段（versions / project_bindings / runs / recent_audits …）的必需字段校验。 */
function requireNestedCloudFields<T>(
  result: CloudApiResult<readonly T[]>,
  label: string,
  parentField: string,
  required: readonly string[],
  arrayFields: readonly string[] = [],
): CloudApiResult<readonly T[]> {
  if (!result.ok) return result
  for (const parent of result.value) {
    const children = isRecord(parent) ? parent[parentField] : undefined
    if (!Array.isArray(children)) return invalidResponse(result.evidence, `${label}缺少 ${parentField} 数组`)
    for (const child of children) {
      if (!isRecord(child)) return invalidResponse(result.evidence, `${label}.${parentField} 行不是对象`)
      const missing = required.filter(key => !Object.hasOwn(child, key))
      if (missing.length > 0) return invalidResponse(result.evidence, `${label}.${parentField} 行缺少必需字段：${missing.join('、')}`)
      const missingArrays = arrayFields.filter(key => !Array.isArray(child[key]))
      if (missingArrays.length > 0) return invalidResponse(result.evidence, `${label}.${parentField} 行缺少数组字段：${missingArrays.join('、')}`)
    }
  }
  return result
}
function isMemoryRecord(value: unknown): value is AdminMemoryRecord {
  return (
    isRecord(value) &&
    typeof value.memory_id === 'string' &&
    typeof value.team_id === 'string' &&
    typeof value.project_id === 'string' &&
    typeof value.content === 'string' &&
    value.layer === 'L1' &&
    typeof value.captured_by_user_id === 'string' &&
    typeof value.created_at === 'string' &&
    typeof value.updated_at === 'string' &&
    typeof value.revision === 'number' &&
    (value.status === 'ACTIVE' || value.status === 'DELETED') &&
    typeof value.importance === 'number' &&
    typeof value.recall_count === 'number' &&
    (value.last_recalled_at === null || typeof value.last_recalled_at === 'string') &&
    value.source_kind === 'agent_turn'
  )
}
function isMemoryList(value: unknown): value is AdminMemoryList {
  return (
    isRecord(value) &&
    Array.isArray(value.items) &&
    value.items.every(isMemoryRecord) &&
    (value.next_cursor === null || typeof value.next_cursor === 'string') &&
    typeof value.total_estimate === 'number' &&
    Number.isFinite(value.total_estimate)
  )
}

function isMemoryJob(value: unknown): value is AdminMemoryJob {
  return (
    isRecord(value) &&
    typeof value.job_id === 'string' &&
    typeof value.event_id === 'string' &&
    (value.kind === 'CAPTURE' ||
      value.kind === 'INDEX_REFRESH' ||
      value.kind === 'DELETE_CLEANUP' ||
      value.kind === 'PROJECT_PROVISION' ||
      value.kind === 'POLICY_UPDATE' ||
      value.kind === 'PROJECT_PURGE') &&
    typeof value.team_id === 'string' &&
    typeof value.project_id === 'string' &&
    typeof value.requested_by_user_id === 'string' &&
    (value.status === 'PENDING' || value.status === 'SUCCEEDED' || value.status === 'FAILED') &&
    typeof value.retryable === 'boolean' &&
    typeof value.retry_count === 'number' &&
    typeof value.created_at === 'string' &&
    (value.finished_at === null || typeof value.finished_at === 'string') &&
    (value.error_code === null || typeof value.error_code === 'string') &&
    typeof value.revision === 'number'
  )
}

function isMemoryAudit(value: unknown): value is AdminMemoryAudit {
  return (
    isRecord(value) &&
    typeof value.audit_id === 'string' &&
    typeof value.operation === 'string' &&
    // 审计字段契约（API 需求 §7.3）：字面 actor_name 必须存在且非空。
    typeof value.actor_name === 'string' &&
    (value.actor_name as string).length > 0 &&
    typeof value.operated_by_user_id === 'string' &&
    (value.role === 'admin' || value.role === 'manager' || value.role === 'member' || value.role === 'system') &&
    (value.memory_id === null || typeof value.memory_id === 'string') &&
    typeof value.project_id === 'string' &&
    typeof value.result === 'string' &&
    typeof value.event_id === 'string'
  )
}

function isMemoryJobList(value: unknown): value is AdminMemoryJobList {
  return isRecord(value) && Array.isArray(value.items) && value.items.every(isMemoryJob) && (value.next_cursor === null || typeof value.next_cursor === 'string')
}

function isMemoryAuditList(value: unknown): value is AdminMemoryAuditList {
  return isRecord(value) && Array.isArray(value.items) && value.items.every(isMemoryAudit) && (value.next_cursor === null || typeof value.next_cursor === 'string')
}

function parseMemoryMutation(value: unknown): AdminMemoryMutation | undefined {
  if (!isRecord(value)) return undefined
  const memory = value.memory === undefined ? undefined : isMemoryRecord(value.memory) ? value.memory : undefined
  if (value.memory !== undefined && memory === undefined) return undefined
  if (typeof value.event_id !== 'string' || typeof value.job_id !== 'string') return undefined
  if (value.status !== 'PENDING' && value.status !== 'INDEX_PENDING') return undefined
  if (value.accepted_count !== undefined && typeof value.accepted_count !== 'number') return undefined
  if (value.cleanup_status !== undefined && value.cleanup_status !== 'PENDING' && value.cleanup_status !== 'FAILED') return undefined
  return {
    ...(memory === undefined ? {} : { memory }),
    event_id: value.event_id,
    job_id: value.job_id,
    status: value.status,
    ...(value.accepted_count === undefined ? {} : { accepted_count: value.accepted_count }),
    ...(value.cleanup_status === undefined ? {} : { cleanup_status: value.cleanup_status }),
  }
}

function parseMemoryMutationResult(value: unknown): ApiResult<AdminMemoryMutation> {
  const mutation = parseMemoryMutation(value)
  return mutation === undefined
    ? { ok: false, error: { kind: 'service', code: 'INVALID_RESPONSE', message: '服务端未返回有效的记忆操作结果' } }
    : { ok: true, value: mutation }
}

function parseMemoryPolicyResult(value: unknown): ApiResult<AdminMemoryPolicy> {
  if (
    isRecord(value) &&
    value.scope_type === 'project' &&
    typeof value.scope_id === 'string' &&
    typeof value.revision === 'number' &&
    isRecord(value.values) &&
    typeof value.values.top_k === 'number' &&
    typeof value.values.relevance_threshold === 'number' &&
    typeof value.values.token_budget === 'number' &&
    (value.inherited_from === 'organization' || value.inherited_from === 'project')
  )
    return { ok: true, value: value as unknown as AdminMemoryPolicy }
  return { ok: false, error: { kind: 'service', code: 'INVALID_RESPONSE', message: '服务端未返回有效的记忆策略' } }
}

function parseMemoryJobResult(value: unknown): ApiResult<AdminMemoryJob> {
  return isMemoryJob(value)
    ? { ok: true, value }
    : { ok: false, error: { kind: 'service', code: 'INVALID_RESPONSE', message: '服务端未返回有效的记忆任务' } }
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text()
  if (text.length === 0) return {}
  try {
    return JSON.parse(text) as unknown
  } catch {
    return { code: 'INVALID_JSON', message: '服务端返回了无效 JSON' }
  }
}

const TELEMETRY_KINDS: readonly string[] = [
  'session.started', 'session.finished', 'turn.started', 'turn.finished', 'step.started', 'step.finished',
  'llm.request', 'llm.response', 'tool.call', 'tool.result', 'approval.requested', 'approval.resolved',
  'compaction.completed', 'agent.error', 'delivery.gap',
]

const TELEMETRY_OUTCOMES: readonly string[] = ['success', 'error', 'interrupted', 'cancelled', 'blocked', 'max_tokens']

const TELEMETRY_GAP_REASONS: readonly string[] = ['overflow', 'expired', 'rejected', 'manual_clear', 'authorization_revoked']

const TELEMETRY_DECISIONS: readonly string[] = ['allowed_once', 'rejected', 'cancelled', 'unavailable']

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && Number.isFinite(value) && value >= 0
}

function isNullableCount(value: unknown): value is number | null {
  return value === null || isCount(value)
}

function isStringOrNull(value: unknown): value is string | null {
  return value === null || typeof value === 'string'
}

/** Field-by-field guard so a malformed knowledge-base detail can never reach page state. */
function isKnownKnowledgeBase(value: unknown): value is AdminKnowledgeBase {
  if (!isRecord(value)) return false
  const types = ['document', 'faq', 'wiki']
  const states = ['active', 'unavailable', 'deleting']
  return (
    typeof value.knowledge_base_id === 'string' &&
    typeof value.organization_id === 'string' &&
    typeof value.name === 'string' &&
    typeof value.description === 'string' &&
    typeof value.type === 'string' &&
    types.includes(value.type) &&
    typeof value.state === 'string' &&
    states.includes(value.state) &&
    typeof value.searchable === 'boolean' &&
    typeof value.updated_at === 'string' &&
    isCount(value.revision) &&
    (value.document_count === undefined || isCount(value.document_count))
  )
}

function isTelemetryDelivery(value: unknown): value is TelemetryDelivery {
  return (
    isRecord(value) &&
    isCount(value.accepted) &&
    isCount(value.duplicate) &&
    isCount(value.retryable) &&
    isCount(value.rejected) &&
    isCount(value.queued) &&
    isCount(value.gaps)
  )
}

function isTelemetrySummary(value: unknown): value is TelemetrySummary {
  if (!isRecord(value)) return false
  if (!isTelemetryDelivery(value.delivery)) return false
  const sessions = value.sessions
  const turns = value.turns
  const steps = value.steps
  const llm = value.llm
  const tools = value.tools
  const approvals = value.approvals
  if (!isRecord(sessions)) return false
  if (![sessions.total, sessions.completed, sessions.errors, sessions.interrupted, sessions.cancelled].every(isCount)) return false
  if (!isRecord(turns)) return false
  if (![turns.total, turns.completed, turns.errors, turns.blocked, turns.max_tokens, turns.interrupted, turns.cancelled].every(isCount)) return false
  if (!isNullableCount(turns.p50_duration_ms) || !isNullableCount(turns.p95_duration_ms)) return false
  if (!isRecord(steps)) return false
  if (![steps.started, steps.finished].every(isCount)) return false
  if (!isNullableCount(steps.p50_duration_ms) || !isNullableCount(steps.p95_duration_ms)) return false
  if (!isRecord(llm)) return false
  if (
    ![llm.requests, llm.retries, llm.input_tokens, llm.output_tokens, llm.token_sample_size, llm.input_token_samples, llm.output_token_samples, llm.total_token_samples].every(
      isCount,
    )
  ) {
    return false
  }
  if (!isNullableCount(llm.total_tokens)) return false
  if (!isRecord(tools)) return false
  if (![tools.calls, tools.errors].every(isCount)) return false
  if (!isNullableCount(tools.p50_duration_ms) || !isNullableCount(tools.p95_duration_ms)) return false
  if (!isRecord(approvals)) return false
  if (![approvals.requested, approvals.allowed_once, approvals.rejected, approvals.cancelled, approvals.unavailable].every(isCount)) return false
  if (!isCount(value.compactions)) return false
  return isTelemetryDelivery(value.delivery)
}

function isTelemetryBucket(value: unknown): value is TelemetryBucket {
  return isRecord(value) && typeof value.bucket_start === 'string' && isTelemetrySummary(value)
}

function isTelemetryModelUsage(value: unknown): value is TelemetryModelUsage {
  return (
    isRecord(value) &&
    typeof value.provider === 'string' &&
    typeof value.model === 'string' &&
    isCount(value.requests) &&
    isCount(value.input_tokens) &&
    isCount(value.output_tokens) &&
    isNullableCount(value.total_tokens) &&
    isCount(value.input_token_samples) &&
    isCount(value.output_token_samples) &&
    isCount(value.total_token_samples)
  )
}

function isTelemetryToolUsage(value: unknown): value is TelemetryToolUsage {
  return (
    isRecord(value) &&
    typeof value.tool_name === 'string' &&
    isCount(value.calls) &&
    isCount(value.errors) &&
    isNullableCount(value.p50_duration_ms) &&
    isNullableCount(value.p95_duration_ms)
  )
}

function isTelemetryProjectSummary(value: unknown): value is TelemetryProjectSummary {
  return (
    isRecord(value) &&
    typeof value.project_id === 'string' &&
    typeof value.from === 'string' &&
    typeof value.to === 'string' &&
    typeof value.has_data === 'boolean' &&
    isTelemetrySummary(value.summary) &&
    Array.isArray(value.models) &&
    value.models.every(isTelemetryModelUsage) &&
    Array.isArray(value.tools) &&
    value.tools.every(isTelemetryToolUsage) &&
    isTelemetryDelivery(value.delivery) &&
    isCount(value.retention_days)
  )
}

function isTelemetryEventItem(value: unknown): value is TelemetryEventItem {
  if (!isRecord(value)) return false
  for (const field of ['event_id', 'installation_id', 'project_id', 'kind', 'occurred_at', 'received_at', 'source_type'] as const) {
    if (typeof value[field] !== 'string') return false
  }
  if (!TELEMETRY_KINDS.includes(value.kind as string)) return false
  if (!isStringOrNull(value.session_id)) return false
  if (!isNullableCount(value.source_seq) || !isNullableCount(value.turn) || !isNullableCount(value.step)) return false
  if (!isNullableCount(value.duration_ms)) return false
  if (!isStringOrNull(value.outcome) || (typeof value.outcome === 'string' && !TELEMETRY_OUTCOMES.includes(value.outcome))) return false
  for (const field of ['provider', 'model', 'tool_category', 'compaction_id'] as const) {
    if (!isStringOrNull(value[field])) return false
  }
  for (const field of ['tool_name', 'call_id', 'approval_id'] as const) {
    if (!isStringOrNull(value[field])) return false
  }
  if (value.retryable !== null && typeof value.retryable !== 'boolean') return false
  if (!isNullableCount(value.retry_count)) return false
  if (value.token_usage !== null && value.token_usage !== undefined) {
    const usage = value.token_usage
    if (!isRecord(usage)) return false
    if (!isNullableCount(usage.input_tokens) || !isNullableCount(usage.output_tokens) || !isNullableCount(usage.total_tokens)) return false
  }
  if (value.error !== null && value.error !== undefined) {
    const detail = value.error
    if (!isRecord(detail) || typeof detail.name !== 'string' || !isStringOrNull(detail.code) || !isStringOrNull(detail.summary)) return false
  }
  if (value.approval !== null && value.approval !== undefined) {
    const detail = value.approval
    if (!isRecord(detail)) return false
    if (detail.decision !== null && detail.decision !== undefined && !TELEMETRY_DECISIONS.includes(detail.decision as string)) return false
  }
  if (value.compaction !== null && value.compaction !== undefined) {
    const detail = value.compaction
    if (!isRecord(detail) || !isStringOrNull(detail.kind)) return false
  }
  if (value.gap !== null && value.gap !== undefined) {
    const detail = value.gap
    if (!isRecord(detail)) return false
    if (typeof detail.reason !== 'string' || !TELEMETRY_GAP_REASONS.includes(detail.reason)) return false
    if (!isCount(detail.count)) return false
    if (!isStringOrNull(detail.first_event_id) || !isStringOrNull(detail.last_event_id)) return false
  }
  return true
}

function isTelemetryOverview(value: unknown): value is TelemetryOverview {
  return (
    isRecord(value) &&
    typeof value.from === 'string' &&
    typeof value.to === 'string' &&
    typeof value.has_data === 'boolean' &&
    isTelemetrySummary(value.summary) &&
    Array.isArray(value.buckets) &&
    value.buckets.every(isTelemetryBucket) &&
    isCount(value.retention_days)
  )
}

function isTelemetryEventPage(value: unknown): value is TelemetryEventPage {
  return (
    isRecord(value) &&
    typeof value.project_id === 'string' &&
    Array.isArray(value.items) &&
    value.items.every(isTelemetryEventItem) &&
    (value.next_cursor === null || typeof value.next_cursor === 'string') &&
    typeof value.has_more === 'boolean' &&
    isCount(value.retention_days)
  )
}

/** Lifecycle states the service contract defines, plus the UI's own `unknown` fallback. */
const CLOUD_WORKSPACE_STATUSES: readonly string[] = [
  'draft', 'provisioning', 'starting', 'ready', 'degraded', 'stopping', 'stopped', 'failed', 'archived', 'deleting', 'unknown',
]

/** Run states the service contract defines, plus the UI's own `unknown` fallback. */
const CLOUD_RUN_STATUSES: readonly string[] = [
  'preparing', 'awaiting_approval', 'running', 'paused', 'awaiting_user', 'succeeded', 'failed', 'cancelled', 'expired', 'unknown',
]

const CLOUD_RUN_WRITE_MODES: readonly string[] = ['read_only', 'write']

/** A non-empty string, the shape every opaque service id has on the wire. */
function isOpaqueId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

/** A counter the service owns: a whole number that never goes backwards below zero. */
function isRevision(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

/** A contract-optional member that, when present, must still have its declared type. */
function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string'
}

/**
 * Validates one cloud workspace row against the service field contract.
 *
 * `Object.hasOwn` answers "did the service say anything here"; it does not
 * answer "is what it said usable". A row whose `project_id` is an array or whose
 * `revision` is the string `'bad'` satisfies presence and then renders as a
 * broken pane, so every member is checked for the type the contract declares.
 */
function isCloudWorkspace(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false
  return (
    isOpaqueId(value.workspace_id)
    && isOpaqueId(value.project_id)
    && isOpaqueId(value.owner_user_id)
    && isOpaqueId(value.branch)
    && typeof value.status === 'string'
    && CLOUD_WORKSPACE_STATUSES.includes(value.status)
    && isRevision(value.revision)
    && (value.repository_id === undefined || isOpaqueId(value.repository_id))
    && isOptionalString(value.display_name)
    && (value.last_error === undefined || value.last_error === null || typeof value.last_error === 'string')
    && isOptionalString(value.default_agent_profile_version_id)
    && isOptionalString(value.created_at)
    && isOptionalString(value.updated_at)
  )
}

/** Validates one cloud run row against the service field contract. */
function isCloudRun(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false
  return (
    isOpaqueId(value.run_id)
    && isOpaqueId(value.workspace_id)
    && typeof value.status === 'string'
    && CLOUD_RUN_STATUSES.includes(value.status)
    && typeof value.write_mode === 'string'
    && CLOUD_RUN_WRITE_MODES.includes(value.write_mode)
    && isRevision(value.workspace_revision)
    && (value.agent_profile_version_id === undefined || isOpaqueId(value.agent_profile_version_id))
    && (value.asset_version_ids === undefined
      || (Array.isArray(value.asset_version_ids) && value.asset_version_ids.every(entry => typeof entry === 'string')))
    && (value.session_id === undefined || isOpaqueId(value.session_id))
    && (value.lease_id === undefined || value.lease_id === null || typeof value.lease_id === 'string')
    && (value.error_code === undefined || value.error_code === null || typeof value.error_code === 'string')
    && (value.revision === undefined || isRevision(value.revision))
  )
}

/**
 * Applies one row predicate to a whole list result, reporting the first row that
 * fails with its position so a protocol problem is diagnosable.
 */
function requireCloudRows<T>(
  result: CloudApiResult<readonly T[]>,
  label: string,
  isValid: (row: unknown) => boolean,
): CloudApiResult<readonly T[]> {
  if (!result.ok) return result
  for (const [index, row] of result.value.entries()) {
    if (isValid(row)) continue
    return invalidResponse(result.evidence, `${label}第 ${index + 1} 行字段类型不符合服务端合同`)
  }
  return result
}

function isCloudWorkspaceAudit(value: unknown): value is CloudWorkspaceAudit {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return (
    typeof record.actor_name === 'string' &&
    record.actor_name.length > 0 &&
    typeof record.request_id === 'string' &&
    typeof record.action === 'string' &&
    (record.result === 'succeeded' || record.result === 'failed') &&
    typeof record.occurred_at === 'string'
  )
}
