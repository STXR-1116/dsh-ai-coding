import { createHash, randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { unzipSync, zipSync, strToU8 } from 'fflate'
import {
  AccountStore,
  type AccountOperationResult,
  type AccountPrincipal,
  type AccountRole,
  type ProjectView,
} from './account-store.ts'
import { ProjectMemoryFixture } from './project-memory-fixture.ts'
import { TelemetryFixture } from './telemetry-fixture.ts'
import { WorkspaceFixture } from './workspace-fixture.ts'

type Visibility = 'organization' | 'group' | 'people'
type Status = 'draft' | 'pending_review' | 'approved' | 'published' | 'withdrawn'
type Principal = AccountPrincipal

/** Closed vocabulary of tool permissions a release may declare (§11.14). */
const TOOL_PERMISSIONS = ['bash', 'read_file', 'write_file', 'web_fetch', 'subprocess'] as const

/** Deterministic release signature minted when a version is published (§11.14). */
interface ReleaseSignature {
  readonly algorithm: 'sha256-rsa' | 'sha256-ecdsa'
  readonly keyId: string
  readonly fingerprint: string
  readonly signedAt: string
}

interface VersionRecord {
  readonly skillId: string
  version: string
  status: Status
  releaseNotes: string
  artifact: Uint8Array
  artifactSha256: string
  files: readonly { readonly path: string; readonly sha256: string }[]
  dependencies: readonly string[]
  permissions: readonly string[]
  validation: readonly { readonly name: string; readonly status: 'passed' | 'failed'; readonly detail?: string }[]
  revision: number
  publishedAt?: string
  withdrawnReason?: string
  /** Signature minted at publish; absent on an unsigned release (§11.14). */
  signature?: ReleaseSignature
}

interface SkillRecord {
  readonly skillId: string
  /** Owning organization resolved from the author's active membership at creation. */
  readonly organizationId: string
  displayName: string
  summary: string
  readonly runtimeName: string
  category: string
  tags: readonly string[]
  visibility: Visibility
  groupId?: string
  peopleIds: string[]
  readonly authorId: string
  readonly authorName: string
  status: Status
  currentVersion?: string
  revision: number
  readonly versions: VersionRecord[]
}

interface OperationRecord {
  readonly operationId: string
  readonly skillId: string
  readonly version: string
  readonly projectId: string
  readonly runtimeName: string
  readonly artifact: VersionRecord
  readonly actor: Principal
  readonly scope: 'project' | 'global'
  status: 'authorized' | 'downloading' | 'verifying' | 'writing' | 'refreshing' | 'succeeded' | 'failed' | 'cancelled'
  readonly events: Array<{ readonly event_sequence: number; readonly status: string; readonly error_code?: string }>
}

interface AuditRecord {
  readonly id: string
  readonly occurredAt: string
  readonly actorUserId: string
  readonly actor_name: string
  readonly action: string
  readonly skillName: string
  readonly version: string
  readonly scope?: 'project' | 'global'
  readonly result: 'succeeded' | 'failed' | 'cancelled'
  readonly requestId: string
  readonly organizationId?: string
  readonly projectId?: string
  readonly resourceId?: string
  readonly errorCode?: string
}

interface IdempotentResponse {
  readonly fingerprint: string
  readonly value: unknown
  readonly status: number
}

type KnowledgeBaseType = 'document' | 'faq' | 'wiki'
type KnowledgeBaseState = 'active' | 'unavailable' | 'deleting'
interface KnowledgeBaseRecord {
  readonly knowledgeBaseId: string
  readonly externalId: string
  readonly organizationId: string
  name: string
  description: string
  readonly type: KnowledgeBaseType
  state: KnowledgeBaseState
  searchable: boolean
  revision: number
  updatedAt: string
  readonly documents: KnowledgeDocumentRecord[]
}
interface KnowledgeDocumentRecord {
  readonly documentId: string
  readonly externalId: string
  readonly title: string
  readonly source: string
  status: 'pending' | 'processing' | 'completed' | 'failed'
  readonly snippet: string
  /** Immutable document version; search hits report it (§11.15). */
  version: string
  /** Last content update; search hits report it (§11.15). */
  updatedAt: string
}
interface KnowledgeOperationRecord {
  readonly operationId: string
  readonly knowledgeBaseId: string
  readonly documentId: string
  readonly actor: Principal
  readonly operationType: 'knowledge_base_create' | 'document_import' | 'document_reparse' | 'document_delete' | 'knowledge_base_delete'
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'
  readonly idempotencyKey: string
}

/** Platform-to-WeKnora mapping passed only to the server-side adapter. */
export interface WeKnoraKnowledgeBaseRef {
  readonly platformId: string
  readonly externalId: string
  readonly type: KnowledgeBaseType
}

/** One external result returned by the native WeKnora search capability. */
export interface WeKnoraSearchResult {
  readonly externalKnowledgeBaseId: string
  readonly externalKnowledgeId: string
  readonly title: string
  readonly snippet: string
  readonly score: number
  readonly sourceUrl: string
  /** Immutable version of the document this hit came from (§11.15). */
  readonly version: string
  /** Last content update of that document (§11.15). */
  readonly updatedAt: string
  readonly citation?: { readonly page?: number; readonly chunk?: string }
}

/** Per-external-KB outcome returned by the native WeKnora search capability. */
export interface WeKnoraSearchStatus {
  readonly externalId: string
  readonly status: 'used' | 'no_hits' | 'skipped'
  readonly reason?: 'processing' | 'unavailable' | 'forbidden' | 'not_found' | 'timeout' | 'external_error' | null
}

/** Minimal native WeKnora capability required by the local platform fixture. */
export interface WeKnoraAdapter {
  /** Execute one native multi-KB hybrid search. */
  search(request: {
    readonly query: string
    readonly knowledgeBases: readonly WeKnoraKnowledgeBaseRef[]
    readonly topK?: number
    readonly traceId?: string
  }): Promise<{ readonly knowledgeBases: readonly WeKnoraSearchStatus[]; readonly results: readonly WeKnoraSearchResult[] }>
}

export interface TeamSkillServiceOptions {
  readonly port?: number
  readonly host?: string
  readonly publicUrl?: string
  readonly seed?: boolean
  /** Server-only WeKnora REST/MCP capability adapter used by the platform routes. */
  readonly weknora?: WeKnoraAdapter
  /**
   * Clock the workspace fixture's scheduled transitions and expiries read.
   *
   * Tests inject a controllable clock so a deadline cannot elapse between a
   * client's revision read and its `If-Match` write — the load-sensitive race
   * documented on {@link WorkspaceFixtureOptions.now}. Defaults to the wall
   * clock, which is what the standalone server and the browser smoke want.
   */
  readonly now?: (() => number) | undefined
}

/** Small in-memory API used to validate the plugin and admin workflow locally. */
export function createTeamSkillService(options: TeamSkillServiceOptions = {}) {
  const accounts = new AccountStore()
  const skills: SkillRecord[] = options.seed === false ? [] : [seedPublishedSkill(), seedReviewSkill()]
  for (const skill of skills) accounts.registerPlatformAsset('skill', skill.skillId)
  const operations = new Map<string, OperationRecord>()
  const knowledgeOperations = new Map<string, KnowledgeOperationRecord>()
  const knowledgeBases: KnowledgeBaseRecord[] = options.seed === false ? [] : seedKnowledgeBases()
  const knowledgeIdsFor = (projectId: string): readonly string[] => accounts.projectAssetIds(projectId, 'knowledge')
  const weknora = options.weknora ?? createFixtureWeKnoraAdapter(() => knowledgeBases)
  const audits: AuditRecord[] = []
  const denialAuditRequests = new Set<string>()
  const idempotency = new Map<string, IdempotentResponse>()
  const projectMemory = new ProjectMemoryFixture(accounts, options.seed !== false)
  const telemetry = new TelemetryFixture(accounts)
  const workspace = new WorkspaceFixture(accounts, {
    seed: options.seed !== false,
    ...(options.now === undefined ? {} : { now: options.now }),
    assetExists: (kind, id, version) => {
      if (kind === 'skill') {
        return skills.some(skill => skill.skillId === id && skill.versions.some(item => item.version === version && item.status === 'published'))
      }
      if (kind === 'knowledge') return knowledgeBases.some(base => base.knowledgeBaseId === id)
      return accounts.projectIdsForAsset('memory', id).length > 0
    },
  })

  type SkillAccessResult =
    | { readonly ok: true; readonly skill: SkillRecord }
    | { readonly ok: false; readonly status: number; readonly code: string; readonly message: string }

  /** Base Skill access decision for regular-user surfaces (catalog, detail, release-status,
   * installation, download): the caller must already have authorized project reachability via
   * `authorizeProject` and pass the project's organization id in; this predicate verifies the
   * Skill's organization matches the project's, the Skill is bound to the project as a `skill`
   * asset, and the caller is inside the Skill's visibility scope in that organization. It does
   * not verify publication state — regular-user paths stack `authorizeInstallableSkillVersion`
   * on top, and management routes authorize separately via `canManageSkillRecord`. */
  function authorizeSkillForProject(
    skill: SkillRecord,
    principal: Principal,
    projectId: string,
    projectOrganizationId: string,
  ): SkillAccessResult {
    if (projectOrganizationId !== skill.organizationId)
      return { ok: false, status: 403, code: 'SKILL_ORGANIZATION_FORBIDDEN', message: 'Skill 不属于项目所在组织' }
    if (!accounts.projectAssetIds(projectId, 'skill').includes(skill.skillId))
      return { ok: false, status: 403, code: 'SKILL_NOT_PROJECT_ASSET', message: 'Skill 尚未绑定当前项目资产' }
    if (!canViewSkill(skill, principal))
      return { ok: false, status: 403, code: 'FORBIDDEN', message: '当前账号不在 Skill 可见范围内' }
    return { ok: true, skill }
  }

  /** Regular-user installable gate stacked on `authorizeSkillForProject`: on top of the base
   * decision the Skill itself must be published and the requested version (when given) must be
   * the Skill's current published release. Unpublished states return the same 404 as a missing
   * resource. Used by detail, release-status, installation and download; management routes do
   * not pass through here. */
  function authorizeInstallableSkillVersion(
    skill: SkillRecord,
    principal: Principal,
    projectId: string,
    projectOrganizationId: string,
    version?: string,
  ): SkillAccessResult {
    const access = authorizeSkillForProject(skill, principal, projectId, projectOrganizationId)
    if (!access.ok) return access
    if (skill.status !== 'published' || skill.currentVersion === undefined)
      return { ok: false, status: 404, code: 'RESOURCE_NOT_FOUND', message: '资源不存在' }
    if (version !== undefined) {
      const release = skill.versions.find(item => item.version === version)
      if (release === undefined || release.status !== 'published' || skill.currentVersion !== version)
        return { ok: false, status: 404, code: 'RESOURCE_NOT_FOUND', message: '资源不存在' }
    }
    return access
  }

  function canViewSkill(skill: SkillRecord, principal: Principal): boolean {
    if (principal.role === 'admin') return true
    if (!accounts.hasActiveMembership(principal.userId, skill.organizationId)) return false
    if (skill.visibility === 'organization') return true
    if (skill.visibility === 'group')
      return skill.groupId !== undefined && accounts.userGroupIds(principal.userId, skill.organizationId).includes(skill.groupId)
    return skill.peopleIds.includes(principal.userId)
  }

  /** Management scope for governance routes (`/v1/admin/team-skills`): admin spans the
   * platform, a manager spans their active organizations. Unlike the regular-user installable
   * gate it does not check publication state — governance reads must reach draft, pending_review,
   * approved and withdrawn Skills — and admins additionally gate review, publish and rollback
   * actions inside the routes. */
  function canManageSkillRecord(principal: Principal, skill: SkillRecord): boolean {
    if (principal.role === 'admin') return true
    return principal.role === 'manager' && accounts.hasActiveMembership(principal.userId, skill.organizationId)
  }

  function recordSkillDenial(
    principal: Principal,
    action: string,
    code: string,
    requestId: string,
    skill?: SkillRecord,
    projectId?: string,
    version?: string,
    resourceId?: string,
  ): void {
    const dedupeKey = `${principal.userId}|${action}|${requestId}`
    if (denialAuditRequests.has(dedupeKey)) return
    denialAuditRequests.add(dedupeKey)
    audits.push({
      id: randomUUID(),
      occurredAt: new Date().toISOString(),
      actorUserId: principal.userId,
      actor_name: principal.displayName,
      action,
      skillName: skill?.skillId ?? 'unknown',
      version: version ?? 'unknown',
      result: 'failed',
      requestId,
      ...(skill?.organizationId === undefined ? {} : { organizationId: skill.organizationId }),
      ...(projectId === undefined ? {} : { projectId }),
      ...(resourceId === undefined ? {} : { resourceId }),
      errorCode: code,
    })
  }

  /** People targets must be active members of the Skill's organization directory. */
  function parsePeopleIds(
    value: unknown,
    visibility: Visibility,
    organizationId: string,
    principal: Principal,
    fallback: readonly string[] = [],
  ): string[] | undefined {
    if (visibility !== 'people') return []
    if (value === undefined) return fallback.length > 0 ? [...fallback] : [principal.userId]
    if (!Array.isArray(value) || value.length === 0) return undefined
    const ids = value.filter((item): item is string => typeof item === 'string')
    if (
      ids.length !== value.length ||
      ids.some(id => !accounts.activeMemberUserIds(organizationId).includes(id))
    )
      return undefined
    return [...new Set(ids)]
  }

  /** Group targets must exist inside the Skill's organization; the default is the caller's first group there. */
  function parseGroupId(
    value: unknown,
    visibility: Visibility,
    organizationId: string,
    principal: Principal,
  ): string | undefined {
    if (visibility !== 'group') return undefined
    const groupId = typeof value === 'string' && value.length > 0 ? value : accounts.userGroupIds(principal.userId, organizationId)[0]
    return groupId !== undefined && accounts.isOrganizationGroup(organizationId, groupId) ? groupId : undefined
  }

  /** Project-context view of one Skill for signed-in users: catalog facts and published
   * versions only. Management metadata (organization, project bindings, group and people
   * targets, revision) stays on the admin DTO.
   */
  function toUserSkill(skill: SkillRecord) {
    const currentVersion = skill.versions.find(value => value.version === skill.currentVersion)
    return {
      skillId: skill.skillId,
      displayName: skill.displayName,
      summary: skill.summary,
      runtimeName: skill.runtimeName,
      category: skill.category,
      tags: skill.tags,
      currentVersion: skill.currentVersion,
      publishedVersions: skill.versions.filter(version => version.status === 'published').map(version => version.version),
      ...(currentVersion === undefined ? {} : { publishedAt: currentVersion.publishedAt }),
    }
  }

  /** Governance view of one Skill including its organization and project-asset bindings. */
  function toAdminSkill(skill: SkillRecord) {
    return {
      skillId: skill.skillId,
      organization_id: skill.organizationId,
      displayName: skill.displayName,
      summary: skill.summary,
      runtimeName: skill.runtimeName,
      category: skill.category,
      tags: skill.tags,
      currentVersion: skill.currentVersion,
      publishedVersions: skill.versions.filter(version => version.status === 'published').map(version => version.version),
      latestVersion: latestVersion(skill)?.version,
      latestVersionRevision: latestVersion(skill)?.revision,
      status: skill.status,
      visibility: skill.visibility,
      revision: skill.revision,
      authorName: skill.authorName,
      project_ids: accounts.projectIdsForAsset('skill', skill.skillId),
      ...(skill.groupId === undefined ? {} : { groupId: skill.groupId }),
      ...(skill.visibility === 'people' ? { peopleIds: skill.peopleIds } : {}),
      ...(skill.currentVersion === undefined
        ? {}
        : { publishedAt: skill.versions.find(value => value.version === skill.currentVersion)?.publishedAt }),
    }
  }

  const server = createServer((request, response) => {
    const requestId = randomUUID()
    void handle(request, response, requestId).catch((error: unknown) => {
      if (error instanceof InvalidJsonRequest) {
        send(response, 400, { code: 'INVALID_JSON', message: error.message, request_id: requestId })
        return
      }
      if (error instanceof RequestValidationError) {
        send(response, error.status, { code: error.code, message: error.message, request_id: requestId })
        return
      }
      send(response, 500, {
        code: 'INTERNAL_ERROR',
        message: error instanceof Error ? error.message : '服务端内部错误',
        request_id: requestId,
      })
    })
  })

  async function handle(request: IncomingMessage, response: ServerResponse, requestId: string): Promise<void> {
    addCors(response)
    if (request.method === 'OPTIONS') {
      response.writeHead(204)
      response.end()
      return
    }
    const url = new URL(request.url ?? '/', 'http://localhost')
    const parts = url.pathname.split('/').filter(Boolean)
    if (url.pathname === '/health') {
      send(response, 200, { status: 'ok', request_id: requestId })
      return
    }
    if (parts[0] !== 'v1' && parts[0] !== 'v3') {
      send(response, 401, { code: 'UNAUTHORIZED', message: '需要有效的 Bearer 令牌', request_id: requestId })
      return
    }
    if (parts[1] === 'auth') {
      await handleAuthRoute(parts.slice(2), request, response, requestId)
      return
    }
    const principal = authenticate(request, accounts)
    if (principal === undefined) {
      send(response, 401, {
        code: workspace.appliesTo(parts) ? 'AUTH_REQUIRED' : 'UNAUTHORIZED',
        message: '需要有效的 Bearer 令牌',
        request_id: requestId,
      })
      return
    }

    if (request.method === 'GET' && parts.length === 2 && parts[1] === 'me') {
      const me = accounts.me(principal)
      if (me === undefined) {
        send(response, 404, { code: 'RESOURCE_NOT_FOUND', message: '用户不存在', request_id: requestId })
        return
      }
      send(response, 200, { user: me.user, memberships: me.memberships, request_id: requestId })
      return
    }

    if (principal.mustChangePassword && !(request.method === 'GET' && parts.length === 2 && parts[1] === 'me')) {
      send(response, 403, { code: 'PASSWORD_CHANGE_REQUIRED', message: '首次登录必须修改密码', request_id: requestId })
      return
    }

    if (parts[0] === 'v3' && parts[1] === 'projects' && parts[2] === 'list' && request.method === 'POST') {
      send(response, 200, { projects: accounts.listMemberProjects(principal), request_id: requestId })
      return
    }

    if (parts[1] === 'project-memory' && request.method === 'POST') {
      const body = await readJson(request)
      const operation = parts.slice(2).join('/')
      if (request.headers['x-fixture-scenario'] === 'cleanup-failed') body.fixture_cleanup_failed = true
      const result = projectMemory.execute(operation, principal, body, {
        'idempotency-key': headerValue(request, 'idempotency-key'),
        'if-match': headerValue(request, 'if-match'),
        'x-fixture-scenario': headerValue(request, 'x-fixture-scenario'),
      }, requestId)
      send(response, result.status, { ...result.body, request_id: requestId })
      return
    }

    if (request.method === 'POST' && parts.length === 3 && parts[1] === 'telemetry' && parts[2] === 'batches') {
      const body = await readJson(request)
      const result = telemetry.batches(principal, body, {
        'idempotency-key': headerValue(request, 'idempotency-key'),
        'x-fixture-scenario': headerValue(request, 'x-fixture-scenario'),
      }, requestId)
      send(response, result.status, { ...result.body, request_id: requestId })
      return
    }
    if (request.method === 'GET' && parts.length === 4 && parts[1] === 'admin' && parts[2] === 'telemetry' && parts[3] === 'overview') {
      const result = telemetry.overview(principal, url.searchParams, requestId)
      send(response, result.status, { ...result.body, request_id: requestId })
      return
    }
    if (
      request.method === 'GET' && parts.length === 6 && parts[1] === 'admin' && parts[2] === 'projects' && parts[4] === 'telemetry'
      && (parts[5] === 'summary' || parts[5] === 'events')
    ) {
      const result =
        parts[5] === 'summary'
          ? telemetry.projectSummary(principal, requiredPart(parts, 3), url.searchParams, requestId)
          : telemetry.projectEvents(principal, requiredPart(parts, 3), url.searchParams, requestId)
      send(response, result.status, { ...result.body, request_id: requestId })
      return
    }
    if (request.method === 'GET' && parts.length === 3 && parts[1] === 'me' && parts[2] === 'organizations') {
      send(response, 200, { items: accounts.organizations(principal), request_id: requestId })
      return
    }
    if (request.method === 'GET' && parts.length === 3 && parts[1] === 'me' && parts[2] === 'access-summary') {
      sendAccountResult(response, requestId, accounts.accessSummary(principal))
      return
    }
    if (request.method === 'GET' && parts.length === 3 && parts[1] === 'me' && parts[2] === 'projects') {
      const projects = accounts.listMemberProjects(principal)
      send(response, 200, { items: projects, request_id: requestId })
      return
    }
    if (request.method === 'GET' && parts.length === 4 && parts[1] === 'me' && parts[2] === 'projects') {
      const detail = accounts.getProjectDetail(principal, requiredPart(parts, 3))
      sendAccountResult(response, requestId, detail)
      return
    }

    if (parts[1] === 'projects' && parts.length >= 4 && (parts[3] === 'knowledge-bases' || parts[3] === 'knowledge-search')) {
      await handleKnowledgeProjectRoute(parts.slice(1), request, response, requestId, principal)
      return
    }
    if (parts[1] === 'knowledge-bases' || (parts[1] === 'organizations' && parts[3] === 'knowledge-bases') || parts[1] === 'operations') {
      await handleKnowledgeRoute(parts.slice(1), request, response, requestId, principal)
      return
    }

    if (workspace.appliesTo(parts)) {
      await workspace.handle(parts, request, response, url, principal, requestId, headerValue(request, 'x-fixture-scenario'))
      return
    }

    if (parts[1] === 'permission-check' && parts.length === 2 && request.method === 'POST') {
      await workspace.handlePermissionCheck(request, response, principal, requestId)
      return
    }

    if (request.method === 'GET' && parts.length === 2 && parts[1] === 'team-skills') {
      const projectId = url.searchParams.get('project_id')
      if (projectId === null || projectId.length === 0) {
        send(response, 422, { code: 'VALIDATION_ERROR', message: 'project_id 必填', request_id: requestId })
        return
      }
      const project = accounts.authorizeProject(principal, projectId, requestId)
      if (isAccountFailure(project)) {
        sendAccountResult(response, requestId, project)
        return
      }
      const query = url.searchParams.get('query')?.trim().toLocaleLowerCase() ?? ''
      const category = url.searchParams.get('category')
      const tag = url.searchParams.get('tag')
      const items = skills
        .filter((skill) => {
          const allowed = skill.status === 'published' && authorizeSkillForProject(skill, principal, projectId, project.organization_id).ok
          if (!allowed) recordSkillDenial(principal, 'Skill 目录访问拒绝', 'RESOURCE_NOT_FOUND', requestId, skill, projectId, undefined, skill.skillId)
          return allowed
        })
        .filter(
          skill =>
            query.length === 0 ||
            `${skill.displayName}${skill.summary}${skill.category}${skill.tags.join('')}`.toLocaleLowerCase().includes(query),
        )
        .filter(skill => category === null || skill.category === category)
        .filter(skill => tag === null || skill.tags.includes(tag))
        .map(toCatalogItem)
      send(response, 200, { items, request_id: requestId })
      return
    }
    if (request.method === 'GET' && parts.length === 3 && parts[1] === 'team-skills') {
      const projectId = url.searchParams.get('project_id')
      if (projectId === null || projectId.length === 0) {
        send(response, 422, { code: 'VALIDATION_ERROR', message: 'project_id 必填', request_id: requestId })
        return
      }
      const project = accounts.authorizeProject(principal, projectId, requestId)
      if (isAccountFailure(project)) {
        sendAccountResult(response, requestId, project)
        return
      }
      const skill = findSkill(skills, parts[2])
      if (
        skill === undefined ||
        !authorizeInstallableSkillVersion(skill, principal, projectId, project.organization_id).ok
      ) {
        recordSkillDenial(principal, 'Skill 详情访问拒绝', 'RESOURCE_NOT_FOUND', requestId, skill, projectId, undefined, parts[2])
        notFound(response, requestId)
        return
      }
      send(response, 200, {
        skill: toUserSkill(skill),
        versions: skill.versions.filter(version => version.status === 'published').map(toVersion),
        request_id: requestId,
      })
      return
    }
    if (
      request.method === 'GET' &&
      parts.length === 5 &&
      parts[1] === 'team-skills' &&
      parts[3] === 'versions' &&
      (parts[4] ?? '').endsWith(TRUST_CARD_SUFFIX)
    ) {
      const projectId = url.searchParams.get('project_id')
      if (projectId === null || projectId.length === 0) {
        send(response, 422, { code: 'VALIDATION_ERROR', message: 'project_id 必填', request_id: requestId })
        return
      }
      const project = accounts.authorizeProject(principal, projectId, requestId)
      if (isAccountFailure(project)) {
        sendAccountResult(response, requestId, project)
        return
      }
      const versionNumber = (parts[4] ?? '').slice(0, -TRUST_CARD_SUFFIX.length)
      const skill = findSkill(skills, parts[2])
      const version = skill?.versions.find(item => item.version === versionNumber)
      // Only a published release the caller may install has a trust card; every
      // other case is the same 404 so the endpoint never leaks existence.
      if (
        skill === undefined ||
        version === undefined ||
        version.status !== 'published' ||
        !authorizeInstallableSkillVersion(skill, principal, projectId, project.organization_id).ok
      ) {
        recordSkillDenial(principal, 'Skill 信任卡访问拒绝', 'RESOURCE_NOT_FOUND', requestId, skill, projectId, versionNumber, parts[2])
        notFound(response, requestId)
        return
      }
      if (version.signature === undefined) {
        send(response, 404, {
          code: 'SIGNATURE_NOT_AVAILABLE',
          message: '该发布版本未签名，无法提供信任卡',
          request_id: requestId,
        })
        return
      }
      send(response, 200, { ...trustCardOf(audits, skill, version, version.signature), request_id: requestId })
      return
    }
    if (request.method === 'POST' && parts.length === 3 && parts[1] === 'team-skills' && parts[2] === 'release-status') {
      const body = await readJson(request)
      const values = Array.isArray(body.items) ? body.items : []
      const requested = [] as Array<{ readonly skillId: string; readonly version: string; readonly projectId: string }>
      for (const value of values) {
        const entry = recordOf(value)
        const skillId = entry !== undefined && typeof entry.skill_id === 'string' && entry.skill_id.length > 0 ? entry.skill_id : undefined
        const version = entry !== undefined && typeof entry.version === 'string' && entry.version.length > 0 ? entry.version : undefined
        const projectId =
          entry !== undefined && typeof entry.project_id === 'string' && entry.project_id.length > 0 ? entry.project_id : undefined
        if (skillId === undefined || version === undefined || projectId === undefined) {
          send(response, 422, {
            code: 'VALIDATION_ERROR',
            message: 'release-status 项必须包含 skill_id、version 和 project_id',
            request_id: requestId,
          })
          return
        }
        requested.push({ skillId, version, projectId })
      }
      const authorizedProjects = new Map<string, string>()
      for (const item of requested) {
        if (authorizedProjects.has(item.projectId)) continue
        const project = accounts.authorizeProject(principal, item.projectId, requestId)
        if (isAccountFailure(project)) {
          sendAccountResult(response, requestId, project)
          return
        }
        authorizedProjects.set(item.projectId, project.organization_id)
      }
      const result = requested.flatMap((item) => {
        const skill = findSkill(skills, item.skillId)
        const projectOrganizationId = authorizedProjects.get(item.projectId)
        // Regular users learn release state only for installable releases: the Skill and
        // the requested version must both be published. Other states return no record,
        // never a forged `withdrawn` entry that would expose the resource's existence.
        const authorized =
          skill !== undefined &&
          projectOrganizationId !== undefined &&
          authorizeInstallableSkillVersion(skill, principal, item.projectId, projectOrganizationId, item.version).ok
        if (!authorized)
          recordSkillDenial(principal, 'Skill 版本状态访问拒绝', 'RESOURCE_NOT_FOUND', requestId, skill, item.projectId, item.version, item.skillId)
        return authorized
          ? [
            {
              skill_id: skill.skillId,
              version: item.version,
              project_id: item.projectId,
              status: 'published' as const,
            },
          ]
          : []
      })
      send(response, 200, { items: result, request_id: requestId })
      return
    }
    if (request.method === 'POST' && parts.length === 2 && parts[1] === 'team-skill-installations') {
      const body = await readJson(request)
      const skillId = stringField(body, 'skill_id')
      const version = stringField(body, 'version')
      const projectId = typeof body.project_id === 'string' && body.project_id.length > 0 ? body.project_id : undefined
      if (projectId === undefined) {
        send(response, 422, { code: 'VALIDATION_REQUIRED', message: 'project_id 必填', request_id: requestId })
        return
      }
      const project = accounts.authorizeProject(principal, projectId, requestId)
      if (isAccountFailure(project)) {
        sendAccountResult(response, requestId, project)
        return
      }
      const skill = findSkill(skills, skillId)
      const release = skill?.versions.find(value => value.version === version)
      if (skill === undefined || release === undefined) {
        recordSkillDenial(principal, 'Skill 安装拒绝', 'RESOURCE_NOT_FOUND', requestId, skill, projectId, version, skillId)
        notFound(response, requestId)
        return
      }
      // Installation uses the same installable gate as detail, release-status and
      // download: the Skill must be published and the requested version must be its
      // current published release. A version-level published record alone never
      // authorizes installation once the Skill sits in draft, review, approval or
      // withdrawn state.
      const access = authorizeInstallableSkillVersion(skill, principal, projectId, project.organization_id, version)
      if (!access.ok) {
        recordSkillDenial(principal, 'Skill 安装拒绝', access.code, requestId, skill, projectId, version, skillId)
        send(response, access.status, { code: access.code, message: access.message, request_id: requestId })
        return
      }
      const key = requiredIdempotencyKey(request, response, requestId)
      if (key === undefined) return
      const fingerprint = JSON.stringify({ skillId, version, body })
      const previous = idempotency.get(key)
      if (previous !== undefined) {
        if (previous.fingerprint !== fingerprint)
          send(response, 409, { code: 'IDEMPOTENCY_CONFLICT', message: '幂等键已用于另一请求', request_id: requestId })
        else send(response, previous.status, previous.value)
        return
      }
      const scope = body.scope === 'project' ? 'project' : body.scope === 'global' ? 'global' : undefined
      if (scope === undefined) {
        send(response, 422, { code: 'VALIDATION_REQUIRED', message: '安装作用域无效', request_id: requestId })
        return
      }
      const operationId = randomUUID()
      const operation: OperationRecord = {
        operationId,
        skillId,
        version,
        projectId,
        runtimeName: skill.runtimeName,
        artifact: release,
        actor: principal,
        scope,
        status: 'authorized',
        events: [],
      }
      operations.set(operationId, operation)
      const address = options.publicUrl ?? `http://${options.host ?? '127.0.0.1'}:${
        options.port === undefined || options.port === 0 ? (server.address() as import('node:net').AddressInfo).port : options.port
      }`
      const value = authorizedResponse(operation, requestId, address)
      idempotency.set(key, { fingerprint, value, status: 201 })
      send(response, 201, value)
      return
    }
    if (request.method === 'GET' && parts.length === 3 && parts[1] === 'downloads') {
      const operationId = parts[2]
      if (operationId === undefined) {
        notFound(response, requestId)
        return
      }
      const operation = operations.get(operationId)
      if (operation === undefined) {
        recordSkillDenial(principal, 'Skill 下载拒绝', 'RESOURCE_NOT_FOUND', requestId, undefined, undefined, undefined, operationId)
        notFound(response, requestId)
        return
      }
      if (operation.actor.token !== principal.token) {
        const skill = findSkill(skills, operation.skillId)
        recordSkillDenial(principal, 'Skill 下载拒绝', 'RESOURCE_NOT_FOUND', requestId, skill, operation.projectId, operation.version, operationId)
        notFound(response, requestId)
        return
      }
      const project = accounts.authorizeProject(principal, operation.projectId, requestId)
      const skill = findSkill(skills, operation.skillId)
      // An issued download URL is re-authorized on every request: the Skill and the
      // operation's version must still be published, the project binding, organization,
      // visibility scope, and the operation owner must all still hold.
      const authorized =
        !isAccountFailure(project) &&
        skill !== undefined &&
        authorizeInstallableSkillVersion(skill, principal, operation.projectId, project.organization_id, operation.version).ok
      if (!authorized) {
        recordSkillDenial(principal, 'Skill 下载拒绝', 'INSTALL_AUTHORIZATION_REVOKED', requestId, skill, operation.projectId, operation.version, operationId)
        send(response, 403, { code: 'INSTALL_AUTHORIZATION_REVOKED', message: '安装授权已失效', request_id: requestId })
        return
      }
      response.writeHead(200, {
        'content-type': 'application/zip',
        'content-length': String(operation.artifact.artifact.byteLength),
        'access-control-allow-origin': '*',
      })
      response.end(Buffer.from(operation.artifact.artifact))
      return
    }
    if (parts[1] === 'team-skill-installations' && parts.length === 4 && parts[3] === 'events' && request.method === 'POST') {
      const operationId = parts[2]
      if (operationId === undefined) {
        notFound(response, requestId)
        return
      }
      const operation = operations.get(operationId)
      if (operation === undefined) {
        recordSkillDenial(principal, 'Skill 操作事件拒绝', 'RESOURCE_NOT_FOUND', requestId, undefined, undefined, undefined, operationId)
        notFound(response, requestId)
        return
      }
      if (operation.actor.token !== principal.token) {
        recordSkillDenial(principal, 'Skill 操作事件拒绝', 'RESOURCE_NOT_FOUND', requestId, findSkill(skills, operation.skillId), operation.projectId, operation.version, operationId)
        notFound(response, requestId)
        return
      }
      const body = await readJson(request)
      const fingerprint = JSON.stringify({ path: request.url, body })
      const mutation = beginMutation(request, response, requestId, idempotency, fingerprint)
      if (mutation === undefined || mutation.kind === 'replayed') return
      const sequence = numberField(body, 'event_sequence')
      const status = parseOperationStatus(body.status)
      if (status === undefined) {
        send(response, 422, { code: 'VALIDATION_REQUIRED', message: '操作状态无效', request_id: requestId })
        return
      }
      if (sequence !== operation.events.length + 1) {
        send(response, 409, { code: 'INVALID_STATUS', message: '事件序号必须连续递增', request_id: requestId })
        return
      }
      if (!validOperationTransition(operation.status, status)) {
        send(response, 409, { code: 'INVALID_STATUS', message: '操作状态不能回退或重复结束', request_id: requestId })
        return
      }
      operation.events.push({
        event_sequence: sequence,
        status,
        ...(typeof body.error_code === 'string' ? { error_code: body.error_code } : {}),
      })
      operation.status = status
      if (status === 'succeeded' || status === 'failed' || status === 'cancelled') recordAudit(audits, operation, status, requestId, body)
      const value = { accepted: true, request_id: requestId }
      rememberMutation(idempotency, mutation, value, 202, fingerprint)
      send(response, 202, value)
      return
    }
    if (parts[1] === 'team-skill-installations' && parts.length === 3 && request.method === 'GET') {
      const operationId = parts[2]
      if (operationId === undefined) {
        notFound(response, requestId)
        return
      }
      const operation = operations.get(operationId)
      if (operation === undefined) {
        recordSkillDenial(principal, 'Skill 操作读取拒绝', 'RESOURCE_NOT_FOUND', requestId, undefined, undefined, undefined, operationId)
        notFound(response, requestId)
        return
      }
      if (operation.actor.token !== principal.token) {
        recordSkillDenial(principal, 'Skill 操作读取拒绝', 'RESOURCE_NOT_FOUND', requestId, findSkill(skills, operation.skillId), operation.projectId, operation.version, operationId)
        notFound(response, requestId)
        return
      }
      send(response, 200, { operation_id: operation.operationId, status: operation.status, request_id: requestId })
      return
    }
    if (parts[1] === 'team-skill-installations' && parts.length === 4 && parts[3] === 'cancel' && request.method === 'POST') {
      const operationId = parts[2]
      if (operationId === undefined) {
        notFound(response, requestId)
        return
      }
      const operation = operations.get(operationId)
      if (operation === undefined) {
        recordSkillDenial(principal, 'Skill 操作取消拒绝', 'RESOURCE_NOT_FOUND', requestId, undefined, undefined, undefined, operationId)
        notFound(response, requestId)
        return
      }
      if (operation.actor.token !== principal.token) {
        recordSkillDenial(principal, 'Skill 操作取消拒绝', 'RESOURCE_NOT_FOUND', requestId, findSkill(skills, operation.skillId), operation.projectId, operation.version, operationId)
        notFound(response, requestId)
        return
      }
      if (operation.status === 'succeeded' || operation.status === 'failed' || operation.status === 'cancelled') {
        send(response, 409, { code: 'INVALID_STATUS', message: '操作已经结束', request_id: requestId })
        return
      }
      const body = await readJson(request)
      const fingerprint = JSON.stringify({ path: request.url, body })
      const mutation = beginMutation(request, response, requestId, idempotency, fingerprint)
      if (mutation === undefined || mutation.kind === 'replayed') return
      operation.status = 'cancelled'
      recordAudit(audits, operation, 'cancelled', requestId, body)
      const value = { status: 'cancelled', request_id: requestId }
      rememberMutation(idempotency, mutation, value, 200, fingerprint)
      send(response, 200, value)
      return
    }
    if (parts[1] === 'admin') {
      if (await handleAccountAdmin(parts.slice(2), request, response, requestId, principal)) return
      await handleAdmin(parts.slice(2), request, response, requestId, principal)
      return
    }
    notFound(response, requestId)
  }

  async function handleKnowledgeProjectRoute(
    route: string[],
    request: IncomingMessage,
    response: ServerResponse,
    requestId: string,
    principal: Principal,
  ): Promise<void> {
    const projectId = route[1]
    if (projectId === undefined || route[0] !== 'projects') {
      notFound(response, requestId)
      return
    }
    const project = accounts.authorizeProject(principal, projectId, requestId)
    if (isAccountFailure(project)) {
      sendAccountResult(response, requestId, project)
      return
    }
    if (route.length === 3 && route[2] === 'knowledge-bases' && request.method === 'GET') {
      const items = knowledgeIdsFor(projectId)
        .map(id => knowledgeBases.find(item => item.knowledgeBaseId === id))
        .filter((item): item is KnowledgeBaseRecord => item !== undefined)
        .map(knowledgeBaseView)
      send(response, 200, { items, request_id: requestId })
      return
    }
    if (route.length === 3 && route[2] === 'knowledge-search' && request.method === 'POST') {
      await handleKnowledgeSearch(request, response, requestId, projectId)
      return
    }
    notFound(response, requestId)
  }

  async function handleKnowledgeSearch(
    request: IncomingMessage,
    response: ServerResponse,
    requestId: string,
    projectId: string,
  ): Promise<void> {
    const body = await readJson(request)
    const query = typeof body.query === 'string' ? body.query.trim() : ''
    const selected = Array.isArray(body.knowledge_base_ids)
      ? body.knowledge_base_ids.filter((value): value is string => typeof value === 'string' && value.length > 0)
      : []
    if (query.length === 0 || selected.length === 0 || selected.length !== new Set(selected).size) {
      send(response, 422, { code: 'VALIDATION_ERROR', message: 'query 和 knowledge_base_ids 必填且不能重复', request_id: requestId })
      return
    }
    if (optionalQuery(request, 'fixture_failure') === '503') {
      const statuses = selected.map(knowledgeBaseId => ({
        knowledge_base_id: knowledgeBaseId,
        status: 'skipped' as const,
        reason: 'external_error' as const,
      }))
      send(response, 503, {
        code: 'SERVICE_UNAVAILABLE',
        message: '外部知识库服务暂不可用',
        request_id: requestId,
        results: [],
        knowledge_bases: statuses,
      })
      return
    }
    const statuses: Array<{
      readonly knowledge_base_id: string
      readonly status: 'used' | 'no_hits' | 'skipped'
      readonly reason?: string | null
    }> = []
    const results: Array<Record<string, unknown>> = []
    const refs: WeKnoraKnowledgeBaseRef[] = []
    for (const id of selected) {
      const knowledgeBase = knowledgeBases.find(item => item.knowledgeBaseId === id)
      if (!knowledgeIdsFor(projectId).includes(id) || knowledgeBase === undefined) {
        statuses.push({ knowledge_base_id: id, status: 'skipped', reason: knowledgeBase === undefined ? 'not_found' : 'forbidden' })
        continue
      }
      if (!knowledgeBase.searchable || knowledgeBase.state !== 'active') {
        statuses.push({ knowledge_base_id: id, status: 'skipped', reason: knowledgeBase.state === 'active' ? 'processing' : 'unavailable' })
        continue
      }
      refs.push({ platformId: knowledgeBase.knowledgeBaseId, externalId: knowledgeBase.externalId, type: knowledgeBase.type })
    }
    if (optionalQuery(request, 'fixture_failure') === '503') {
      for (const ref of refs) statuses.push({ knowledge_base_id: ref.platformId, status: 'skipped', reason: 'external_error' })
    } else {
      try {
        const external = await weknora.search({
          query,
          knowledgeBases: refs,
          ...(typeof body.top_k === 'number' ? { topK: body.top_k } : {}),
          ...(typeof body.trace_id === 'string' ? { traceId: body.trace_id } : {}),
        })
        for (const ref of refs) {
          const status = external.knowledgeBases.find(item => item.externalId === ref.externalId)
          statuses.push({
            knowledge_base_id: ref.platformId,
            status: status?.status ?? 'skipped',
            reason: status?.reason ?? (status === undefined ? 'external_error' : null),
          })
        }
        for (const item of external.results) {
          const knowledgeBase = knowledgeBases.find(value => value.externalId === item.externalKnowledgeBaseId)
          const document = knowledgeBase?.documents.find(value => value.externalId === item.externalKnowledgeId)
          if (knowledgeBase === undefined || document === undefined) continue
          results.push({
            knowledge_base_id: knowledgeBase.knowledgeBaseId,
            knowledge_id: document.documentId,
            title: item.title,
            snippet: item.snippet,
            score: item.score,
            version: item.version,
            updated_at: item.updatedAt,
            source_url: `/v1/knowledge-bases/${encodeURIComponent(knowledgeBase.knowledgeBaseId)}/documents/${encodeURIComponent(document.documentId)}/preview`,
            ...(item.citation === undefined ? {} : { citation: { ...item.citation } }),
          })
        }
      } catch {
        for (const ref of refs) statuses.push({ knowledge_base_id: ref.platformId, status: 'skipped', reason: 'external_error' })
      }
    }
    const value = { request_id: requestId, results, knowledge_bases: statuses }
    if (statuses.length > 0 && statuses.every(item => item.status === 'skipped')) {
      send(response, 503, { code: 'SERVICE_UNAVAILABLE', message: '所有知识库暂不可用', ...value })
      return
    }
    send(response, 200, value)
  }

  async function handleKnowledgeRoute(
    route: string[],
    request: IncomingMessage,
    response: ServerResponse,
    requestId: string,
    principal: Principal,
  ): Promise<void> {
    if (route[0] === 'operations' && route.length === 2 && request.method === 'GET') {
      const operation = knowledgeOperations.get(requiredPart(route, 1))
      if (operation === undefined || operation.actor.token !== principal.token) {
        notFound(response, requestId)
        return
      }
      if (operation.status === 'queued') operation.status = 'running'
      else if (operation.status === 'running') {
        operation.status = 'succeeded'
        const knowledgeBase = knowledgeBases.find(item => item.knowledgeBaseId === operation.knowledgeBaseId)
        const document = knowledgeBase?.documents.find(item => item.documentId === operation.documentId)
        if (operation.operationType === 'knowledge_base_delete' && knowledgeBase !== undefined) {
          knowledgeBase.state = 'unavailable'
          knowledgeBase.searchable = false
          accounts.detachAssetEverywhere('knowledge', knowledgeBase.knowledgeBaseId)
        } else if (operation.operationType === 'document_delete' && knowledgeBase !== undefined && document !== undefined) {
          document.status = 'failed'
          knowledgeBase.documents.splice(knowledgeBase.documents.indexOf(document), 1)
        } else if (document !== undefined) {
          // A completed import is the point the content becomes searchable, so
          // it is also the document's effective content update time (§11.15).
          document.status = 'completed'
          document.updatedAt = new Date().toISOString()
        }
      }
      send(response, 200, { operation_id: operation.operationId, status: operation.status, request_id: requestId })
      return
    }
    if (route[0] === 'organizations' && route[2] === 'knowledge-bases') {
      const organizationId = route[1]
      if (
        organizationId === undefined ||
        principal.role === 'member' ||
        isAccountFailure(accounts.getOrganization(principal, organizationId))
      ) {
        send(response, 403, { code: 'FORBIDDEN', message: '知识库管理权限不足', request_id: requestId })
        return
      }
      const list = knowledgeBases.filter(item => item.organizationId === organizationId)
      if (route.length === 3 && request.method === 'GET') {
        send(response, 200, { items: list.map(knowledgeBaseView), request_id: requestId })
        return
      }
      if (route.length === 3 && request.method === 'POST') {
        const body = await readJson(request)
        const type = parseKnowledgeType(body.type)
        if (type === undefined) {
          send(response, 422, { code: 'VALIDATION_ERROR', message: '知识库类型无效', request_id: requestId })
          return
        }
        const mutation = beginMutation(request, response, requestId, idempotency, JSON.stringify({ path: request.url, body }))
        if (mutation === undefined || mutation.kind === 'replayed') return
        const id = `kb-${randomUUID().slice(0, 8)}`
        const now = new Date().toISOString()
        const record: KnowledgeBaseRecord = {
          knowledgeBaseId: id,
          externalId: `weknora-${id}`,
          organizationId,
          name: typeof body.name === 'string' && body.name.length > 0 ? body.name : id,
          description: typeof body.description === 'string' ? body.description : '',
          type,
          state: 'active',
          searchable: true,
          revision: 1,
          updatedAt: now,
          documents: [],
        }
        knowledgeBases.push(record)
        const operationId = randomUUID()
        knowledgeOperations.set(operationId, {
          operationId,
          knowledgeBaseId: id,
          documentId: '',
          actor: principal,
          operationType: 'knowledge_base_create',
          status: 'queued',
          idempotencyKey: mutation.key,
        })
        const value = {
          operation_id: operationId,
          operation_type: 'knowledge_base_create',
          status: 'queued',
          knowledge_base: knowledgeBaseView(record),
          request_id: requestId,
        }
        rememberMutation(idempotency, mutation, value, 202, JSON.stringify({ path: request.url, body }))
        send(response, 202, value)
        return
      }
      notFound(response, requestId)
      return
    }
    if (route[0] !== 'knowledge-bases') {
      notFound(response, requestId)
      return
    }
    if (route.length === 1 && request.method === 'GET') {
      if (principal.role === 'member') {
        notFound(response, requestId)
        return
      }
      const organizations = accounts.listOrganizationsForAdmin(principal)
      if (isAccountFailure(organizations)) {
        sendAccountResult(response, requestId, organizations)
        return
      }
      const visible = new Set((organizations as readonly { readonly organization_id: string }[]).map(item => item.organization_id))
      send(response, 200, {
        items: knowledgeBases.filter(item => visible.has(item.organizationId)).map(knowledgeBaseView),
        request_id: requestId,
      })
      return
    }
    const knowledgeBase = knowledgeBases.find(item => item.knowledgeBaseId === route[1])
    if (knowledgeBase === undefined) {
      notFound(response, requestId)
      return
    }
    const organization = accounts.getOrganization(principal, knowledgeBase.organizationId)
    const memberCanRead =
      principal.role === 'member' &&
      accounts
        .accessSummary(principal)
        .assets.some(item => item.asset_type === 'knowledge' && item.asset_id === knowledgeBase.knowledgeBaseId)
    if (principal.role === 'member' && !memberCanRead) {
      notFound(response, requestId)
      return
    }
    if (principal.role !== 'member' && isAccountFailure(organization)) {
      send(response, 403, { code: 'FORBIDDEN', message: '知识库管理权限不足', request_id: requestId })
      return
    }
    if (principal.role === 'member' && !(route[2] === 'documents' && route[4] === 'preview')) {
      send(response, 403, { code: 'FORBIDDEN', message: '知识库管理权限不足', request_id: requestId })
      return
    }
    if (route.length === 2 && request.method === 'GET' && route[1] !== undefined && route[2] === undefined) {
      send(response, 200, { ...knowledgeBaseView(knowledgeBase), request_id: requestId })
      return
    }
    if (route.length === 3 && route[2] === 'delete-impact' && request.method === 'GET') {
      const listedProjects = accounts.listProjects(principal, {})
      const visibleProjects = isProjectViews(listedProjects) ? listedProjects : []
      const projects = visibleProjects
        .filter(project => accounts.projectAssetIds(project.project_id, 'knowledge').includes(knowledgeBase.knowledgeBaseId))
        .map(project => accounts.getProject(principal, project.project_id))
        .filter(item => !isAccountFailure(item) && 'project_id' in item)
        .map(item => ({ project_id: item.project_id, name: item.name, status: item.status }))
      send(response, 200, {
        knowledge_base_id: knowledgeBase.knowledgeBaseId,
        revision: knowledgeBase.revision,
        affected_projects: projects,
        request_id: requestId,
      })
      return
    }
    if (route.length === 2 && request.method === 'DELETE') {
      const body = await readJson(request)
      if (!checkRevision(request, knowledgeBase.revision, body)) {
        send(response, 409, { code: 'REVISION_CONFLICT', message: '知识库已更新，请刷新后重试', request_id: requestId })
        return
      }
      const mutation = beginMutation(request, response, requestId, idempotency, JSON.stringify({ path: request.url, body }))
      if (mutation === undefined || mutation.kind === 'replayed') return
      const operationId = randomUUID()
      knowledgeBase.state = 'deleting'
      knowledgeBase.searchable = false
      knowledgeOperations.set(operationId, {
        operationId,
        knowledgeBaseId: knowledgeBase.knowledgeBaseId,
        documentId: '',
        actor: principal,
        operationType: 'knowledge_base_delete',
        status: 'queued',
        idempotencyKey: mutation.key,
      })
      const value = { operation_id: operationId, operation_type: 'knowledge_base_delete', status: 'queued', request_id: requestId }
      rememberMutation(idempotency, mutation, value, 202, JSON.stringify({ path: request.url, body }))
      send(response, 202, value)
      return
    }
    if (route.length === 2 && request.method === 'PATCH') {
      const body = await readJson(request)
      if (!checkRevision(request, knowledgeBase.revision, body)) {
        send(response, 409, { code: 'REVISION_CONFLICT', message: '知识库已更新，请刷新后重试', request_id: requestId })
        return
      }
      const mutation = beginMutation(request, response, requestId, idempotency, JSON.stringify({ path: request.url, body }))
      if (mutation === undefined || mutation.kind === 'replayed') return
      if (typeof body.name === 'string' && body.name.trim().length > 0) knowledgeBase.name = body.name.trim()
      if (typeof body.description === 'string') knowledgeBase.description = body.description
      knowledgeBase.revision += 1
      knowledgeBase.updatedAt = new Date().toISOString()
      const value = { ...knowledgeBaseView(knowledgeBase), request_id: requestId }
      rememberMutation(idempotency, mutation, value, 200, JSON.stringify({ path: request.url, body }))
      send(response, 200, value)
      return
    }
    if (route[2] === 'documents' && route.length === 3 && request.method === 'GET') {
      send(response, 200, { items: knowledgeBase.documents.map(documentView), request_id: requestId })
      return
    }
    if (route[2] === 'documents' && route.length === 4 && request.method === 'POST' && route[3] === 'markdown') {
      const body = await readJson(request)
      const title = typeof body.title === 'string' && body.title.length > 0 ? body.title : '未命名文档'
      const markdown = typeof body.markdown === 'string' ? body.markdown : ''
      if (markdown.length === 0) {
        send(response, 422, { code: 'VALIDATION_ERROR', message: 'Markdown 内容不能为空', request_id: requestId })
        return
      }
      const mutation = beginMutation(request, response, requestId, idempotency, JSON.stringify({ path: request.url, body }))
      if (mutation === undefined || mutation.kind === 'replayed') return
      if (!checkRevision(request, knowledgeBase.revision, body)) {
        send(response, 409, { code: 'REVISION_CONFLICT', message: '知识库已更新，请刷新后重试', request_id: requestId })
        return
      }
      const documentId = `doc-${randomUUID().slice(0, 8)}`
      knowledgeBase.documents.push({
        documentId,
        externalId: `weknora-${documentId}`,
        title,
        source: 'markdown',
        status: 'processing',
        snippet: markdown.replace(/^#+\s*/mu, '').slice(0, 240),
        version: 'v1',
        updatedAt: new Date().toISOString(),
      })
      knowledgeBase.revision += 1
      knowledgeBase.updatedAt = new Date().toISOString()
      const operationId = randomUUID()
      knowledgeOperations.set(operationId, {
        operationId,
        knowledgeBaseId: knowledgeBase.knowledgeBaseId,
        documentId,
        actor: principal,
        operationType: 'document_import',
        status: 'queued',
        idempotencyKey: mutation.key,
      })
      const value = {
        operation_id: operationId,
        operation_type: 'document_import',
        status: 'queued',
        document_id: documentId,
        request_id: requestId,
      }
      rememberMutation(idempotency, mutation, value, 202, JSON.stringify({ path: request.url, body }))
      send(response, 202, value)
      return
    }
    if (route[2] === 'documents' && route.length === 4 && request.method === 'POST' && (route[3] === 'urls' || route[3] === 'files')) {
      const body = await readJson(request)
      const title = typeof body.title === 'string' && body.title.length > 0 ? body.title : route[3] === 'urls' ? 'URL 文档' : '上传文档'
      const source = route[3] === 'urls' ? (typeof body.url === 'string' ? body.url : '') : 'file'
      if (source.length === 0) {
        send(response, 422, { code: 'VALIDATION_ERROR', message: '导入来源不能为空', request_id: requestId })
        return
      }
      const mutation = beginMutation(request, response, requestId, idempotency, JSON.stringify({ path: request.url, body }))
      if (mutation === undefined || mutation.kind === 'replayed') return
      if (!checkRevision(request, knowledgeBase.revision, body)) {
        send(response, 409, { code: 'REVISION_CONFLICT', message: '知识库已更新，请刷新后重试', request_id: requestId })
        return
      }
      const documentId = `doc-${randomUUID().slice(0, 8)}`
      knowledgeBase.documents.push({
        documentId,
        externalId: `weknora-${documentId}`,
        title,
        source,
        status: 'pending',
        snippet: title,
        version: 'v1',
        updatedAt: new Date().toISOString(),
      })
      knowledgeBase.revision += 1
      knowledgeBase.updatedAt = new Date().toISOString()
      const operationId = randomUUID()
      knowledgeOperations.set(operationId, {
        operationId,
        knowledgeBaseId: knowledgeBase.knowledgeBaseId,
        documentId,
        actor: principal,
        operationType: 'document_import',
        status: 'queued',
        idempotencyKey: mutation.key,
      })
      const value = {
        operation_id: operationId,
        operation_type: 'document_import',
        status: 'queued',
        document_id: documentId,
        request_id: requestId,
      }
      rememberMutation(idempotency, mutation, value, 202, JSON.stringify({ path: request.url, body }))
      send(response, 202, value)
      return
    }
    if (route[2] === 'documents' && route.length === 4 && request.method === 'GET') {
      const document = knowledgeBase.documents.find(item => item.documentId === route[3])
      if (document === undefined) {
        notFound(response, requestId)
        return
      }
      send(response, 200, { ...documentView(document), knowledge_base_id: knowledgeBase.knowledgeBaseId, request_id: requestId })
      return
    }
    if (route[2] === 'documents' && route.length === 5 && route[4] === 'preview' && request.method === 'GET') {
      const document = knowledgeBase.documents.find(item => item.documentId === route[3])
      if (document === undefined) {
        notFound(response, requestId)
        return
      }
      send(response, 200, {
        knowledge_base_id: knowledgeBase.knowledgeBaseId,
        document_id: document.documentId,
        title: document.title,
        preview_url: `/v1/knowledge-bases/${encodeURIComponent(knowledgeBase.knowledgeBaseId)}/documents/${encodeURIComponent(document.documentId)}/preview`,
        request_id: requestId,
      })
      return
    }
    if (route[2] === 'documents' && route.length === 5 && route[4] === 'download' && request.method === 'GET') {
      const document = knowledgeBase.documents.find(item => item.documentId === route[3])
      if (document === undefined) {
        notFound(response, requestId)
        return
      }
      response.writeHead(200, {
        'content-type': 'text/markdown; charset=utf-8',
        'content-disposition': `attachment; filename="${encodeURIComponent(document.title)}.md"`,
        'access-control-allow-origin': '*',
      })
      response.end(document.snippet)
      return
    }
    if (route[2] === 'documents' && route.length === 5 && route[4] === 'reparse' && request.method === 'POST') {
      const document = knowledgeBase.documents.find(item => item.documentId === route[3])
      if (document === undefined) {
        notFound(response, requestId)
        return
      }
      const body = await readJson(request)
      if (!checkRevision(request, knowledgeBase.revision, body)) {
        send(response, 409, { code: 'REVISION_CONFLICT', message: '知识库已更新，请刷新后重试', request_id: requestId })
        return
      }
      const mutation = beginMutation(request, response, requestId, idempotency, JSON.stringify({ path: request.url, body }))
      if (mutation === undefined || mutation.kind === 'replayed') return
      document.status = 'processing'
      const operationId = randomUUID()
      knowledgeOperations.set(operationId, {
        operationId,
        knowledgeBaseId: knowledgeBase.knowledgeBaseId,
        documentId: document.documentId,
        actor: principal,
        operationType: 'document_reparse',
        status: 'queued',
        idempotencyKey: mutation.key,
      })
      const value = {
        operation_id: operationId,
        operation_type: 'document_reparse',
        status: 'queued',
        document_id: document.documentId,
        request_id: requestId,
      }
      rememberMutation(idempotency, mutation, value, 202, JSON.stringify({ path: request.url, body }))
      send(response, 202, value)
      return
    }
    if (route[2] === 'documents' && route.length === 4 && route[3] !== undefined && request.method === 'DELETE') {
      const document = knowledgeBase.documents.find(item => item.documentId === route[3])
      if (document === undefined) {
        notFound(response, requestId)
        return
      }
      const body = await readJson(request)
      if (!checkRevision(request, knowledgeBase.revision, body)) {
        send(response, 409, { code: 'REVISION_CONFLICT', message: '知识库已更新，请刷新后重试', request_id: requestId })
        return
      }
      const mutation = beginMutation(request, response, requestId, idempotency, JSON.stringify({ path: request.url, body }))
      if (mutation === undefined || mutation.kind === 'replayed') return
      const operationId = randomUUID()
      document.status = 'processing'
      knowledgeOperations.set(operationId, {
        operationId,
        knowledgeBaseId: knowledgeBase.knowledgeBaseId,
        documentId: document.documentId,
        actor: principal,
        operationType: 'document_delete',
        status: 'queued',
        idempotencyKey: mutation.key,
      })
      const value = {
        operation_id: operationId,
        operation_type: 'document_delete',
        status: 'queued',
        document_id: document.documentId,
        request_id: requestId,
      }
      rememberMutation(idempotency, mutation, value, 202, JSON.stringify({ path: request.url, body }))
      send(response, 202, value)
      return
    }
    if (route[2] === 'faq-items' || route[2] === 'wiki-pages' || route[2] === 'graph') {
      const expected = route[2] === 'faq-items' ? 'faq' : 'wiki'
      if (knowledgeBase.type !== expected && route[2] !== 'graph') {
        send(response, 422, { code: 'VALIDATION_ERROR', message: `知识库类型必须是 ${expected}`, request_id: requestId })
        return
      }
      if (route[2] === 'graph' && knowledgeBase.type !== 'wiki') {
        send(response, 422, { code: 'VALIDATION_ERROR', message: '只有 wiki 知识库支持图谱', request_id: requestId })
        return
      }
      if (request.method === 'GET') {
        send(
          response,
          200,
          route[2] === 'graph' ? { nodes: [], relations: [], request_id: requestId } : { items: [], request_id: requestId },
        )
        return
      }
      const body = await readJson(request)
      if (!checkRevision(request, knowledgeBase.revision, body)) {
        send(response, 409, { code: 'REVISION_CONFLICT', message: '知识库已更新，请刷新后重试', request_id: requestId })
        return
      }
      const mutation = beginMutation(request, response, requestId, idempotency, JSON.stringify({ path: request.url, body }))
      if (mutation === undefined || mutation.kind === 'replayed') return
      knowledgeBase.revision += 1
      const value = { status: 'succeeded', request_id: requestId }
      rememberMutation(idempotency, mutation, value, 200, JSON.stringify({ path: request.url, body }))
      send(response, 200, value)
      return
    }
    notFound(response, requestId)
  }

  async function handleAuthRoute(parts: string[], request: IncomingMessage, response: ServerResponse, requestId: string): Promise<void> {
    if (request.method === 'POST' && parts.length === 1 && parts[0] === 'login') {
      const body = await readJson(request)
      const result = accounts.login(stringField(body, 'username'), stringField(body, 'password'), requestId)
      if (isAccountFailure(result)) {
        send(response, result.status, { code: result.code, message: result.message, request_id: requestId })
        return
      }
      if (result === undefined) {
        send(response, 401, { code: 'INVALID_CREDENTIALS', message: '用户名或密码错误', request_id: requestId })
        return
      }
      send(response, 200, { ...result, request_id: requestId })
      return
    }
    if (request.method === 'POST' && parts.length === 1 && parts[0] === 'refresh') {
      const body = await readJson(request)
      const fingerprint = JSON.stringify({ operation: 'refresh', path: request.url, body })
      const mutation = beginMutation(request, response, requestId, idempotency, fingerprint)
      if (mutation === undefined || mutation.kind === 'replayed') return
      const result = accounts.refresh(stringField(body, 'refresh_token'), requestId)
      if (result === undefined) {
        send(response, 401, { code: 'TOKEN_REVOKED', message: '刷新令牌已失效', request_id: requestId })
        return
      }
      const value = { ...result, request_id: requestId }
      rememberMutation(idempotency, mutation, value, 200, fingerprint)
      send(response, 200, value)
      return
    }
    if (request.method === 'POST' && parts.length === 1 && parts[0] === 'logout') {
      const token = bearerToken(request)
      const fingerprint = JSON.stringify({ operation: 'logout', path: request.url, token })
      const mutation = beginMutation(request, response, requestId, idempotency, fingerprint)
      if (mutation === undefined || mutation.kind === 'replayed') return
      if (token === undefined || authenticate(request, accounts) === undefined) {
        send(response, 401, { code: 'AUTH_REQUIRED', message: '需要有效的 Bearer 令牌', request_id: requestId })
        return
      }
      accounts.logout(token, requestId)
      rememberMutation(idempotency, mutation, undefined, 204, fingerprint)
      send(response, 204, undefined)
      return
    }
    if (request.method === 'POST' && parts.length === 1 && parts[0] === 'change-password') {
      const body = await readJson(request)
      const fingerprint = JSON.stringify({ operation: 'change-password', path: request.url, body, token: bearerToken(request) })
      const mutation = beginMutation(request, response, requestId, idempotency, fingerprint)
      if (mutation === undefined || mutation.kind === 'replayed') return
      const principal = authenticate(request, accounts)
      if (principal === undefined) {
        send(response, 401, { code: 'AUTH_REQUIRED', message: '需要有效的 Bearer 令牌', request_id: requestId })
        return
      }
      const result = accounts.changePassword(
        principal.token,
        stringField(body, 'current_password'),
        stringField(body, 'new_password'),
        requestId,
      )
      if (isAccountFailure(result)) {
        const value = { code: result.code, message: result.message, request_id: requestId }
        rememberMutation(idempotency, mutation, value, result.status, fingerprint)
        send(response, result.status, value)
        return
      }
      const value = { ...result, request_id: requestId }
      rememberMutation(idempotency, mutation, value, 200, fingerprint)
      send(response, 200, value)
      return
    }
    const principal = authenticate(request, accounts)
    if (principal === undefined) {
      send(response, 401, { code: 'AUTH_REQUIRED', message: '需要有效的 Bearer 令牌', request_id: requestId })
      return
    }
    notFound(response, requestId)
  }

  async function handleAccountAdmin(
    parts: string[],
    request: IncomingMessage,
    response: ServerResponse,
    requestId: string,
    principal: Principal,
  ): Promise<boolean> {
    if ((parts[0] === 'organizations' && parts[2] === 'knowledge-bases') || parts[0] === 'knowledge-bases' || parts[0] === 'operations') {
      await handleKnowledgeRoute(parts, request, response, requestId, principal)
      return true
    }
    if (parts[0] === 'projects' && parts[2] === 'knowledge-bases') {
      await handleKnowledgeProjectAdminRoute(parts, request, response, requestId, principal)
      return true
    }
    if (parts[0] === 'knowledge-audits' && request.method === 'GET' && parts.length === 1) {
      if (principal.role === 'member') {
        send(response, 404, { code: 'RESOURCE_NOT_FOUND', message: '知识库审计不存在', request_id: requestId })
        return true
      }
      send(response, 200, { items: [], request_id: requestId })
      return true
    }
    if (parts[0] === 'projects' && parts[2] === 'knowledge-audits' && request.method === 'GET' && parts.length === 3) {
      if (principal.role === 'member') {
        send(response, 404, { code: 'RESOURCE_NOT_FOUND', message: '知识库审计不存在', request_id: requestId })
        return true
      }
      send(response, 200, { items: [], request_id: requestId })
      return true
    }
    if (parts[0] === 'organizations' && request.method === 'GET' && parts.length === 1) {
      sendAccountResult(response, requestId, accounts.listOrganizationsForAdmin(principal))
      return true
    }
    if (parts[0] === 'organizations' && request.method === 'POST' && parts.length === 1) {
      const body = await readJson(request)
      return applyAccountMutation(
        request,
        response,
        requestId,
        'organization-create',
        body,
        () =>
          accounts.createOrganization(
            principal,
            {
              name: stringField(body, 'name'),
              ...(typeof body.manager_user_id === 'string' ? { managerUserId: body.manager_user_id } : {}),
            },
            requestId,
          ),
        201,
      )
    }
    if (parts[0] === 'organizations' && parts.length === 2 && request.method === 'GET') {
      sendAccountResult(response, requestId, accounts.getOrganization(principal, requiredPart(parts, 1)))
      return true
    }
    if (parts[0] === 'organizations' && parts.length === 2 && request.method === 'PATCH') {
      const body = await readJson(request)
      return applyAccountMutation(
        request,
        response,
        requestId,
        'organization-update',
        body,
        () =>
          accounts.updateOrganization(
            principal,
            requiredPart(parts, 1),
            {
              ...(typeof body.name === 'string' ? { name: body.name } : {}),
              ...(body.status === 'active' || body.status === 'archived' ? { status: body.status } : {}),
            },
            headerRevision(request),
            requestId,
          ),
        200,
      )
    }
    if (parts[0] === 'users' && request.method === 'GET' && parts.length === 1) {
      const value = accounts.listUsers(
        principal,
        optionalQuery(request, 'organization_id'),
        parseRole(optionalQuery(request, 'role')),
        parseAccountStatus(optionalQuery(request, 'status')),
        optionalQuery(request, 'query') ?? '',
      )
      sendAccountResult(response, requestId, value)
      return true
    }
    if (parts[0] === 'users' && request.method === 'POST' && parts.length === 1) {
      const body = await readJson(request)
      const organizationIds = Array.isArray(body.organization_ids)
        ? body.organization_ids.filter((value): value is string => typeof value === 'string' && value.length > 0)
        : []
      return applyAccountMutation(
        request,
        response,
        requestId,
        'user-create',
        body,
        () => {
          const role = parseRole(stringField(body, 'global_role'))
          if (role === undefined) return accountFailure(422, 'VALIDATION_ERROR', '角色无效')
          return accounts.createUser(
            principal,
            {
              username: stringField(body, 'username'),
              displayName: stringField(body, 'display_name'),
              organizationIds,
              globalRole: role,
              projectIds: Array.isArray(body.project_ids)
                ? body.project_ids.filter((value): value is string => typeof value === 'string')
                : [],
            },
            requestId,
          )
        },
        201,
      )
    }
    if (parts[0] === 'users' && parts.length === 2 && request.method === 'GET') {
      sendAccountResult(response, requestId, accounts.getUser(principal, requiredPart(parts, 1)))
      return true
    }
    if (parts[0] === 'users' && parts.length === 2 && request.method === 'PATCH') {
      const body = await readJson(request)
      return applyAccountMutation(
        request,
        response,
        requestId,
        'user-update',
        body,
        () =>
          accounts.updateUser(
            principal,
            requiredPart(parts, 1),
            {
              ...(typeof body.display_name === 'string' ? { displayName: body.display_name } : {}),
              ...(body.status === 'active' || body.status === 'suspended' ? { status: body.status } : {}),
            },
            headerRevision(request),
            requestId,
          ),
        200,
      )
    }
    if (parts[0] === 'organizations' && parts.length === 4 && parts[2] === 'members' && request.method === 'PUT') {
      const body = await readJson(request)
      return applyAccountMutation(
        request,
        response,
        requestId,
        'membership-update',
        body,
        () =>
          body.role !== undefined
            ? accountFailure(422, 'VALIDATION_ERROR', '成员关系不接受角色字段')
            : accounts.setMembership(principal, requiredPart(parts, 1), requiredPart(parts, 3), headerRevision(request), requestId),
        200,
      )
    }
    if (parts[0] === 'organizations' && parts.length === 4 && parts[2] === 'members' && request.method === 'DELETE') {
      return applyAccountMutation(
        request,
        response,
        requestId,
        'membership-remove',
        {},
        () => accounts.removeMembership(principal, requiredPart(parts, 1), requiredPart(parts, 3), headerRevision(request), requestId),
        200,
      )
    }
    if (parts[0] === 'roles' && request.method === 'GET' && parts.length === 1) {
      sendAccountResult(response, requestId, accounts.roles(principal))
      return true
    }
    if (parts[0] === 'permissions' && request.method === 'GET' && parts.length === 1) {
      sendAccountResult(response, requestId, accounts.permissions(principal))
      return true
    }
    if (parts[0] === 'projects' && request.method === 'GET' && parts.length === 1) {
      const organizationId = optionalQuery(request, 'organization_id')
      const status = parseProjectStatus(optionalQuery(request, 'status'))
      const name = optionalQuery(request, 'name')
      sendAccountResult(
        response,
        requestId,
        accounts.listProjects(principal, {
          ...(organizationId === undefined ? {} : { organizationId }),
          ...(status === undefined ? {} : { status }),
          ...(name === undefined ? {} : { name }),
        }),
      )
      return true
    }
    if (parts[0] === 'projects' && request.method === 'POST' && parts.length === 1) {
      const body = await readJson(request)
      return applyAccountMutation(
        request,
        response,
        requestId,
        'project-create',
        body,
        () =>
          accounts.createProject(
            principal,
            {
              organizationId: stringField(body, 'organization_id'),
              name: stringField(body, 'name'),
              ...(typeof body.description === 'string' ? { description: body.description } : {}),
            },
            requestId,
          ),
        201,
      )
    }
    if (parts[0] === 'projects' && parts.length === 2 && request.method === 'GET') {
      sendAccountResult(response, requestId, accounts.getProject(principal, requiredPart(parts, 1)))
      return true
    }
    if (parts[0] === 'projects' && parts.length === 2 && requiredPart(parts, 1).endsWith(':activate') && request.method === 'POST') {
      const projectId = requiredPart(parts, 1).slice(0, -':activate'.length)
      return applyAccountMutation(
        request,
        response,
        requestId,
        'project-activate',
        {},
        () => accounts.activateProject(principal, projectId, headerRevision(request), requestId),
        200,
      )
    }
    if (parts[0] === 'projects' && parts.length === 2 && requiredPart(parts, 1).endsWith(':archive') && request.method === 'POST') {
      const projectId = requiredPart(parts, 1).slice(0, -':archive'.length)
      return applyAccountMutation(
        request,
        response,
        requestId,
        'project-archive',
        {},
        () => accounts.archiveProject(principal, projectId, headerRevision(request), requestId),
        200,
      )
    }
    if (parts[0] === 'projects' && parts.length === 2 && request.method === 'PATCH') {
      const body = await readJson(request)
      return applyAccountMutation(
        request,
        response,
        requestId,
        'project-update',
        body,
        () =>
          accounts.updateProject(
            principal,
            requiredPart(parts, 1),
            {
              ...(typeof body.name === 'string' ? { name: body.name } : {}),
              ...(typeof body.description === 'string' ? { description: body.description } : {}),
            },
            headerRevision(request),
            requestId,
          ),
        200,
      )
    }
    if (parts[0] === 'projects' && parts.length === 3 && parts[2] === 'members' && request.method === 'GET') {
      sendAccountResult(response, requestId, accounts.listProjectMembers(principal, requiredPart(parts, 1)))
      return true
    }
    if (parts[0] === 'projects' && parts.length === 4 && parts[2] === 'members' && request.method === 'PUT') {
      const body = await readJson(request)
      return applyAccountMutation(
        request,
        response,
        requestId,
        'project-member-update',
        body,
        () =>
          body.role !== undefined
            ? accountFailure(422, 'VALIDATION_ERROR', '项目成员关系不接受项目角色')
            : accounts.setProjectMember(principal, requiredPart(parts, 1), requiredPart(parts, 3), headerRevision(request), requestId),
        200,
      )
    }
    if (parts[0] === 'projects' && parts.length === 4 && parts[2] === 'members' && request.method === 'DELETE') {
      return applyAccountMutation(
        request,
        response,
        requestId,
        'project-member-remove',
        {},
        () => accounts.removeProjectMember(principal, requiredPart(parts, 1), requiredPart(parts, 3), headerRevision(request), requestId),
        200,
      )
    }
    if (parts[0] === 'authorization-audits' && request.method === 'GET' && parts.length === 1) {
      sendAccountResult(
        response,
        requestId,
        accounts.listAudits(
          principal,
          optionalQuery(request, 'organization_id'),
          optionalQuery(request, 'action'),
          optionalQuery(request, 'project_id'),
        ),
      )
      return true
    }
    if (parts[0] === 'projects' && parts.length === 3 && parts[2] === 'assets' && request.method === 'GET') {
      sendAccountResult(response, requestId, accounts.listProjectAssets(principal, requiredPart(parts, 1)))
      return true
    }
    if (parts[0] === 'projects' && parts.length === 3 && parts[2] === 'assets' && request.method === 'POST') {
      const body = await readJson(request)
      return applyAccountMutation(
        request,
        response,
        requestId,
        'project-asset-add',
        body,
        () => {
          const assetType = parseAssetType(body.asset_type)
          const relationKind = parseRelationKind(body.relation_kind)
          if (assetType === undefined || relationKind === undefined)
            return accountFailure(422, 'VALIDATION_ERROR', '资产类型或关系类型无效')
          const assetId = stringField(body, 'asset_id')
          if (assetType === 'skill') {
            const skill = findSkill(skills, assetId)
            const projectOrganizationId = accounts.organizationIdOfProject(requiredPart(parts, 1))
            if (skill === undefined) return accountFailure(422, 'VALIDATION_ERROR', 'Skill 资产不存在')
            if (projectOrganizationId !== skill.organizationId)
              return accountFailure(403, 'SKILL_ORGANIZATION_FORBIDDEN', 'Skill 不属于项目所在组织')
          }
          return accounts.addProjectAsset(
            principal,
            requiredPart(parts, 1),
            assetType,
            assetId,
            relationKind,
            headerRevision(request),
            requestId,
          )
        },
        201,
      )
    }
    if (parts[0] === 'projects' && parts.length === 5 && parts[2] === 'assets' && request.method === 'PATCH') {
      const body = await readJson(request)
      return applyAccountMutation(
        request,
        response,
        requestId,
        'project-asset-update',
        body,
        () => {
          const assetType = parseAssetType(parts[3])
          const relationKind = parseRelationKind(body.relation_kind)
          return assetType === undefined || relationKind === undefined
            ? accountFailure(422, 'VALIDATION_ERROR', '资产类型或关系类型无效')
            : accounts.updateProjectAsset(
              principal,
              requiredPart(parts, 1),
              assetType,
              requiredPart(parts, 4),
              relationKind,
              headerRevision(request),
              requestId,
            )
        },
        200,
      )
    }
    if (parts[0] === 'projects' && parts.length === 5 && parts[2] === 'assets' && request.method === 'DELETE') {
      return applyAccountMutation(
        request,
        response,
        requestId,
        'project-asset-remove',
        {},
        () => {
          const assetType = parseAssetType(parts[3])
          return assetType === undefined
            ? accountFailure(422, 'VALIDATION_ERROR', '资产类型无效')
            : accounts.removeProjectAsset(
              principal,
              requiredPart(parts, 1),
              assetType,
              requiredPart(parts, 4),
              headerRevision(request),
              requestId,
            )
        },
        200,
      )
    }
    return false
  }

  async function handleKnowledgeProjectAdminRoute(
    route: string[],
    request: IncomingMessage,
    response: ServerResponse,
    requestId: string,
    principal: Principal,
  ): Promise<void> {
    if (principal.role === 'member') {
      send(response, 403, { code: 'FORBIDDEN', message: '知识库管理权限不足', request_id: requestId })
      return
    }
    const projectId = route[1]
    if (projectId === undefined) {
      notFound(response, requestId)
      return
    }
    const project = accounts.getProject(principal, projectId)
    if (isAccountFailure(project)) {
      sendAccountResult(response, requestId, project)
      return
    }
    const projectView = project as { readonly organization_id: string; readonly revision: number }
    if (route.length === 3 && request.method === 'GET') {
      const items = knowledgeIdsFor(projectId)
        .map(id => knowledgeBases.find(item => item.knowledgeBaseId === id))
        .filter((item): item is KnowledgeBaseRecord => item !== undefined && item.organizationId === projectView.organization_id)
        .map(knowledgeBaseView)
      send(response, 200, { items, request_id: requestId })
      return
    }
    if (route.length === 3 && request.method === 'POST') {
      const body = await readJson(request)
      const id = typeof body.knowledge_base_id === 'string' ? body.knowledge_base_id : undefined
      const knowledgeBase = id === undefined ? undefined : knowledgeBases.find(item => item.knowledgeBaseId === id)
      if (knowledgeBase === undefined || knowledgeBase.organizationId !== projectView.organization_id) {
        send(response, 404, { code: 'RESOURCE_NOT_FOUND', message: '知识库不存在', request_id: requestId })
        return
      }
      if (!checkRevision(request, projectView.revision, body)) {
        send(response, 409, { code: 'REVISION_CONFLICT', message: '项目映射已更新，请刷新后重试', request_id: requestId })
        return
      }
      const knowledgeBaseId = knowledgeBase.knowledgeBaseId
      const mutation = beginMutation(request, response, requestId, idempotency, JSON.stringify({ path: request.url, body }))
      if (mutation === undefined || mutation.kind === 'replayed') return
      const current = knowledgeIdsFor(projectId)
      if (!current.includes(knowledgeBaseId)) {
        const linked = accounts.addProjectAsset(principal, projectId, 'knowledge', knowledgeBaseId, 'context', projectView.revision, requestId)
        if (isAccountFailure(linked)) {
          sendAccountResult(response, requestId, linked)
          return
        }
      }
      const value = { project_id: projectId, knowledge_base_id: knowledgeBaseId, status: 'active', request_id: requestId }
      rememberMutation(idempotency, mutation, value, 201, JSON.stringify({ path: request.url, body }))
      send(response, 201, value)
      return
    }
    if (route.length === 4 && request.method === 'DELETE') {
      const id = requiredPart(route, 3)
      const body = await readJson(request)
      if (!checkRevision(request, projectView.revision, body)) {
        send(response, 409, { code: 'REVISION_CONFLICT', message: '项目映射已更新，请刷新后重试', request_id: requestId })
        return
      }
      const mutation = beginMutation(request, response, requestId, idempotency, JSON.stringify({ path: request.url, body }))
      if (mutation === undefined || mutation.kind === 'replayed') return
      const relation = accounts.projectAssetIds(projectId, 'knowledge').includes(id)
      if (relation) {
        const removed = accounts.removeProjectAsset(principal, projectId, 'knowledge', id, projectView.revision, requestId)
        if (isAccountFailure(removed)) {
          sendAccountResult(response, requestId, removed)
          return
        }
      }
      const value = { project_id: projectId, knowledge_base_id: id, status: 'unlinked', request_id: requestId }
      rememberMutation(idempotency, mutation, value, 200, JSON.stringify({ path: request.url }))
      send(response, 200, value)
      return
    }
    notFound(response, requestId)
  }

  function applyAccountMutation(
    request: IncomingMessage,
    response: ServerResponse,
    requestId: string,
    operation: string,
    body: unknown,
    action: () => AccountOperationResult,
    successStatus: number,
  ): boolean {
    const fingerprint = JSON.stringify({ operation, path: request.url, body })
    const mutation = beginMutation(request, response, requestId, idempotency, fingerprint)
    if (mutation === undefined || mutation.kind === 'replayed') return true
    const result = action()
    if (isAccountFailure(result)) {
      const value = { code: result.code, message: result.message, request_id: requestId }
      rememberMutation(idempotency, mutation, value, result.status, fingerprint)
      send(response, result.status, value)
      return true
    }
    const value = { ...(isRecord(result.value) ? result.value : { value: result.value }), request_id: requestId }
    rememberMutation(idempotency, mutation, value, successStatus, fingerprint)
    send(response, successStatus, value)
    return true
  }

  async function handleAdmin(
    parts: string[],
    request: IncomingMessage,
    response: ServerResponse,
    requestId: string,
    principal: Principal,
  ): Promise<void> {
    if (principal.role === 'member') {
      accounts.recordGovernanceDenial(principal, '治理访问拒绝', 'FORBIDDEN', requestId, parts.join('/'))
      send(response, 403, { code: 'FORBIDDEN', message: '需要作者或管理员权限', request_id: requestId })
      return
    }
    const adminOnly =
      parts[0] === 'team-skill-reviews' ||
      parts[0] === 'team-skill-audit-logs' ||
      (parts[0] === 'team-skills' &&
        (parts[2] === 'rollback' || (parts[2] === 'versions' && ['approve', 'reject', 'publish', 'withdraw'].includes(parts[4] ?? ''))))
    if (adminOnly && principal.role !== 'admin') {
      accounts.recordGovernanceDenial(principal, '管理员操作拒绝', 'FORBIDDEN', requestId, parts.join('/'))
      send(response, 403, { code: 'FORBIDDEN', message: '需要管理员权限', request_id: requestId })
      return
    }
    if (request.method === 'GET' && parts.length === 2 && parts[0] === 'directory' && parts[1] === 'users') {
      const query = urlSearch(request)
      sendAccountResult(
        response,
        requestId,
        accounts.organizationDirectory(principal, optionalQuery(request, 'organization_id'), query),
      )
      return
    }
    if (request.method === 'GET' && parts.length === 1 && parts[0] === 'team-skills') {
      send(response, 200, skills.filter(skill => canManageSkillRecord(principal, skill)).map(toAdminSkill))
      return
    }
    if (request.method === 'POST' && parts.length === 1 && parts[0] === 'team-skills') {
      const body = await readJson(request)
      const mutation = beginMutation(request, response, requestId, idempotency, JSON.stringify({ path: request.url, body }))
      if (mutation === undefined || mutation.kind === 'replayed') return
      const requestedOrganizationId =
        typeof body.organization_id === 'string' && body.organization_id.length > 0 ? body.organization_id : undefined
      const organizationId = accounts.authoringOrganization(principal, requestedOrganizationId)
      if (isAccountFailure(organizationId)) {
        sendAccountResult(response, requestId, organizationId)
        return
      }
      const name = stringField(body, 'display_name')
      const id = slug(name)
      if (findSkill(skills, id) !== undefined) {
        send(response, 409, { code: 'IDEMPOTENCY_CONFLICT', message: 'Skill 名称已存在', request_id: requestId })
        return
      }
      const visibility = body.visibility === 'group' || body.visibility === 'people' ? body.visibility : 'organization'
      const peopleIds = parsePeopleIds(body.people_ids, visibility, organizationId, principal)
      if (peopleIds === undefined) {
        send(response, 422, { code: 'VALIDATION_REQUIRED', message: '特定人员必须来自当前组织目录的 active 成员', request_id: requestId })
        return
      }
      const groupId = parseGroupId(body.group_id, visibility, organizationId, principal)
      if (visibility === 'group' && groupId === undefined) {
        send(response, 422, { code: 'VALIDATION_REQUIRED', message: '本组可见必须指定当前组织的有效组', request_id: requestId })
        return
      }
      const skill = draftSkill(
        id,
        organizationId,
        name,
        stringField(body, 'summary'),
        visibility,
        principal,
        typeof body.category === 'string' ? body.category : undefined,
        Array.isArray(body.tags) ? body.tags.filter((value): value is string => typeof value === 'string') : undefined,
        groupId,
        peopleIds,
      )
      skills.push(skill)
      accounts.registerPlatformAsset('skill', id)
      const value = { ...toAdminSkill(skill), request_id: requestId }
      rememberMutation(idempotency, mutation, value, 201, JSON.stringify({ path: request.url, body }))
      send(response, 201, value)
      return
    }
    if (request.method === 'GET' && parts.length === 2 && parts[0] === 'team-skills') {
      const skill = findSkill(skills, parts[1])
      if (skill === undefined || !canManageSkillRecord(principal, skill)) {
        recordSkillDenial(principal, 'Skill 治理详情访问拒绝', 'RESOURCE_NOT_FOUND', requestId, skill, undefined, undefined, parts[1])
        notFound(response, requestId)
        return
      }
      send(response, 200, { skill: toAdminSkill(skill), versions: skill.versions.map(toVersion), request_id: requestId })
      return
    }
    if (request.method === 'PATCH' && parts.length === 2 && parts[0] === 'team-skills') {
      const skill = findSkill(skills, parts[1])
      if (skill === undefined || !canManageSkillRecord(principal, skill)) {
        recordSkillDenial(principal, 'Skill 治理编辑拒绝', 'RESOURCE_NOT_FOUND', requestId, skill, undefined, undefined, parts[1])
        notFound(response, requestId)
        return
      }
      if (skill.status !== 'draft') {
        send(response, 409, { code: 'INVALID_STATUS', message: '只有草稿可以编辑', request_id: requestId })
        return
      }
      if (!checkRevision(request, skill.revision)) {
        send(response, 409, { code: 'REVISION_CONFLICT', message: '资源已更新，请刷新后重试', request_id: requestId })
        return
      }
      const body = await readJson(request)
      const mutation = beginMutation(request, response, requestId, idempotency, JSON.stringify({ path: request.url, body }))
      if (mutation === undefined || mutation.kind === 'replayed') return
      if (typeof body.display_name === 'string' && body.display_name.trim().length > 0) skill.displayName = body.display_name.trim()
      if (typeof body.summary === 'string' && body.summary.trim().length > 0) skill.summary = body.summary.trim()
      if (body.visibility === 'organization' || body.visibility === 'group' || body.visibility === 'people')
        skill.visibility = body.visibility
      if (body.visibility === 'people' || body.people_ids !== undefined) {
        const peopleIds = parsePeopleIds(body.people_ids, skill.visibility, skill.organizationId, principal, skill.peopleIds)
        if (peopleIds === undefined) {
          send(response, 422, { code: 'VALIDATION_REQUIRED', message: '特定人员必须来自当前组织目录的 active 成员', request_id: requestId })
          return
        }
        skill.peopleIds = peopleIds
      }
      if (body.visibility === 'group' || body.group_id !== undefined) {
        const groupId = parseGroupId(body.group_id, skill.visibility, skill.organizationId, principal)
        if (skill.visibility === 'group' && groupId === undefined) {
          send(response, 422, { code: 'VALIDATION_REQUIRED', message: '本组可见必须指定当前组织的有效组', request_id: requestId })
          return
        }
        if (groupId === undefined) delete skill.groupId
        else skill.groupId = groupId
      }
      if (typeof body.category === 'string' && body.category.trim().length > 0) skill.category = body.category.trim()
      if (Array.isArray(body.tags))
        skill.tags = body.tags.filter((tag): tag is string => typeof tag === 'string' && tag.trim().length > 0).map(tag => tag.trim())
      skill.revision += 1
      recordGovernanceAudit(audits, principal, '编辑草稿', skill, latestVersion(skill)?.version ?? '0.1.0', requestId)
      const value = { ...toAdminSkill(skill), request_id: requestId }
      rememberMutation(idempotency, mutation, value, 200, JSON.stringify({ path: request.url, body }))
      send(response, 200, value)
      return
    }
    if (request.method === 'POST' && parts.length === 3 && parts[0] === 'team-skills' && parts[2] === 'versions') {
      const skill = findSkill(skills, parts[1])
      if (skill === undefined || !canManageSkillRecord(principal, skill)) {
        recordSkillDenial(principal, 'Skill 版本创建拒绝', 'RESOURCE_NOT_FOUND', requestId, skill, undefined, undefined, parts[1])
        notFound(response, requestId)
        return
      }
      if (!checkRevision(request, skill.revision)) {
        send(response, 409, { code: 'REVISION_CONFLICT', message: '资源已更新，请刷新后重试', request_id: requestId })
        return
      }
      const body = await readJson(request)
      const mutation = beginMutation(request, response, requestId, idempotency, JSON.stringify({ path: request.url, body }))
      if (mutation === undefined || mutation.kind === 'replayed') return
      const versionNumber = stringField(body, 'version')
      if (skill.versions.some(version => version.version === versionNumber)) {
        send(response, 409, { code: 'IDEMPOTENCY_CONFLICT', message: '版本号已存在', request_id: requestId })
        return
      }
      const version = emptyVersion(skill.skillId, versionNumber, typeof body.release_notes === 'string' ? body.release_notes : '')
      skill.versions.push(version)
      skill.status = 'draft'
      skill.revision += 1
      const value = { skill: toAdminSkill(skill), version: toVersion(version), request_id: requestId }
      rememberMutation(idempotency, mutation, value, 201, JSON.stringify({ path: request.url, body }))
      send(response, 201, value)
      return
    }
    if (request.method === 'PATCH' && parts.length === 4 && parts[0] === 'team-skills' && parts[2] === 'versions') {
      const skill = findSkill(skills, parts[1])
      const version = skill?.versions.find(item => item.version === parts[3])
      if (skill === undefined || version === undefined || !canManageSkillRecord(principal, skill)) {
        recordSkillDenial(principal, 'Skill 版本治理拒绝', 'RESOURCE_NOT_FOUND', requestId, skill, undefined, parts[3], parts[1])
        notFound(response, requestId)
        return
      }
      if (version.status !== 'draft') {
        send(response, 409, { code: 'INVALID_STATUS', message: '只有草稿版本可以编辑', request_id: requestId })
        return
      }
      if (!checkRevision(request, version.revision)) {
        send(response, 409, { code: 'REVISION_CONFLICT', message: '版本已更新，请刷新后重试', request_id: requestId })
        return
      }
      const body = await readJson(request)
      const mutation = beginMutation(request, response, requestId, idempotency, JSON.stringify({ path: request.url, body }))
      if (mutation === undefined || mutation.kind === 'replayed') return
      if (typeof body.release_notes === 'string') version.releaseNotes = body.release_notes
      if (Array.isArray(body.dependencies))
        version.dependencies = body.dependencies.filter((value): value is string => typeof value === 'string')
      if (Array.isArray(body.permissions)) {
        const permissions = body.permissions.filter((value): value is string => typeof value === 'string')
        // The trust card exposes the closed vocabulary; an out-of-vocabulary
        // value is rejected here rather than silently dropped at read time.
        const unknown = permissions.filter(permission => !(TOOL_PERMISSIONS as readonly string[]).includes(permission))
        if (unknown.length > 0) {
          send(response, 422, {
            code: 'VALIDATION_ERROR',
            message: `工具权限必须在闭集内：${TOOL_PERMISSIONS.join('、')}`,
            request_id: requestId,
          })
          return
        }
        version.permissions = permissions
      }
      version.revision += 1
      const value = { skill: toAdminSkill(skill), version: toVersion(version), request_id: requestId }
      rememberMutation(idempotency, mutation, value, 200, JSON.stringify({ path: request.url, body }))
      send(response, 200, value)
      return
    }
    if (
      request.method === 'PUT' &&
      parts.length === 5 &&
      parts[0] === 'team-skills' &&
      parts[2] === 'versions' &&
      parts[4] === 'artifact'
    ) {
      const skill = findSkill(skills, parts[1])
      const version = skill?.versions.find(item => item.version === parts[3])
      if (skill === undefined || version === undefined || !canManageSkillRecord(principal, skill)) {
        recordSkillDenial(principal, 'Skill 制品上传拒绝', 'RESOURCE_NOT_FOUND', requestId, skill, undefined, parts[3], parts[1])
        notFound(response, requestId)
        return
      }
      if (version.status !== 'draft') {
        send(response, 409, { code: 'INVALID_STATUS', message: '只有草稿版本可以上传制品', request_id: requestId })
        return
      }
      if (!checkRevision(request, version.revision)) {
        send(response, 409, { code: 'REVISION_CONFLICT', message: '版本已更新，请刷新后重试', request_id: requestId })
        return
      }
      const artifact = await readBytes(request)
      const fingerprint = JSON.stringify({ path: request.url, artifactSha256: digest(artifact) })
      const mutation = beginMutation(request, response, requestId, idempotency, fingerprint)
      if (mutation === undefined || mutation.kind === 'replayed') return
      const checked = validateArtifact(artifact, skill.runtimeName)
      version.artifact = artifact
      version.artifactSha256 = digest(artifact)
      version.files = checked.files
      version.validation = checked.validation
      version.revision += 1
      const value = { skill: toAdminSkill(skill), version: toVersion(version), request_id: requestId }
      rememberMutation(idempotency, mutation, value, 200, fingerprint)
      send(response, 200, value)
      return
    }
    if (
      request.method === 'POST' &&
      parts.length === 5 &&
      parts[0] === 'team-skills' &&
      parts[2] === 'versions' &&
      parts[4] === 'submit-review'
    ) {
      const skill = findSkill(skills, parts[1])
      const version = skill?.versions.find(item => item.version === parts[3])
      if (skill === undefined || version === undefined || !canManageSkillRecord(principal, skill)) {
        recordSkillDenial(principal, 'Skill 提交审核拒绝', 'RESOURCE_NOT_FOUND', requestId, skill, undefined, parts[3], parts[1])
        notFound(response, requestId)
        return
      }
      if (!checkRevision(request, version.revision) || !checkSkillRevision(request, skill.revision)) {
        send(response, 409, { code: 'REVISION_CONFLICT', message: '资源已更新，请刷新后重试', request_id: requestId })
        return
      }
      const body = await readJson(request)
      const fingerprint = JSON.stringify({ path: request.url, body })
      const mutation = beginMutation(request, response, requestId, idempotency, fingerprint)
      if (mutation === undefined || mutation.kind === 'replayed') return
      if (version.artifact.byteLength === 0 || version.validation.some(item => item.status !== 'passed')) {
        send(response, 422, { code: 'ARTIFACT_VALIDATION_FAILED', message: '制品校验未通过，不能提交审核', request_id: requestId })
        return
      }
      version.status = 'pending_review'
      version.revision += 1
      skill.status = 'pending_review'
      skill.revision += 1
      recordGovernanceAudit(audits, principal, '提交审核', skill, version.version, requestId)
      const value = { skill: toAdminSkill(skill), version: toVersion(version), request_id: requestId }
      rememberMutation(idempotency, mutation, value, 200, fingerprint)
      send(response, 200, value)
      return
    }
    if (request.method === 'GET' && parts.length === 1 && parts[0] === 'team-skill-reviews') {
      send(
        response,
        200,
        skills
          .filter(skill => canManageSkillRecord(principal, skill))
          .flatMap(skill =>
            skill.versions
              .filter(version => version.status === 'pending_review')
              .map(version => ({
                skill: toAdminSkill(skill),
                version: toVersion(version),
                reviewChecks: ['内容与文件', '依赖与权限', '可见范围'].map((label, index) => ({ id: `check-${index + 1}`, label })),
              })),
          ),
      )
      return
    }
    if (request.method === 'GET' && parts.length === 1 && parts[0] === 'team-skill-audit-logs') {
      const visible =
        principal.role === 'admin'
          ? audits
          : audits.filter(
            audit => audit.organizationId !== undefined && accounts.hasActiveMembership(principal.userId, audit.organizationId),
          )
      send(response, 200, visible)
      return
    }
    if (parts[0] === 'team-skills' && parts.length >= 4 && parts[2] === 'versions') {
      const versionName = parts[3]
      if (versionName === undefined) {
        notFound(response, requestId)
        return
      }
      const skill = findSkill(skills, parts[1])
      const version = skill?.versions.find(value => value.version === versionName)
      if (skill === undefined || version === undefined || !canManageSkillRecord(principal, skill)) {
        recordSkillDenial(principal, 'Skill 版本治理拒绝', 'RESOURCE_NOT_FOUND', requestId, skill, undefined, versionName, parts[1])
        notFound(response, requestId)
        return
      }
      await mutateVersion(parts[4], skill, version, request, response, requestId, principal, idempotency)
      return
    }
    if (parts[0] === 'team-skills' && parts.length === 3 && parts[2] === 'rollback' && request.method === 'POST') {
      const skill = findSkill(skills, parts[1])
      if (skill === undefined) {
        recordSkillDenial(principal, 'Skill 回滚拒绝', 'RESOURCE_NOT_FOUND', requestId, skill, undefined, undefined, parts[1])
        notFound(response, requestId)
        return
      }
      const body = await readJson(request)
      const fingerprint = JSON.stringify({ path: request.url, body })
      const mutation = beginMutation(request, response, requestId, idempotency, fingerprint)
      if (mutation === undefined || mutation.kind === 'replayed') return
      const target =
        typeof body.version === 'string'
          ? skill.versions.find(value => value.version === body.version && value.status === 'published')
          : undefined
      if (target === undefined) {
        send(response, 409, { code: 'VERSION_WITHDRAWN', message: '只能回滚到历史已发布版本', request_id: requestId })
        return
      }
      if (!checkRevision(request, skill.revision)) {
        send(response, 409, { code: 'REVISION_CONFLICT', message: '资源已更新，请刷新后重试', request_id: requestId })
        return
      }
      skill.currentVersion = target.version
      skill.status = 'published'
      skill.revision += 1
      recordGovernanceAudit(audits, principal, '回滚', skill, target.version, requestId)
      const value = { skill: toAdminSkill(skill), request_id: requestId }
      rememberMutation(idempotency, mutation, value, 200, fingerprint)
      send(response, 200, value)
      return
    }
    notFound(response, requestId)
  }

  async function mutateVersion(
    action: string | undefined,
    skill: SkillRecord,
    version: VersionRecord,
    request: IncomingMessage,
    response: ServerResponse,
    requestId: string,
    principal: Principal,
    idempotency: Map<string, IdempotentResponse>,
  ): Promise<void> {
    if (request.method !== 'POST') {
      notFound(response, requestId)
      return
    }
    if (!checkRevision(request, version.revision) || !checkSkillRevision(request, skill.revision)) {
      send(response, 409, { code: 'REVISION_CONFLICT', message: '资源已更新，请刷新后重试', request_id: requestId })
      return
    }
    const body = await readJson(request)
    const fingerprint = JSON.stringify({ path: request.url, body })
    const mutation = beginMutation(request, response, requestId, idempotency, fingerprint)
    if (mutation === undefined || mutation.kind === 'replayed') return
    if (action === 'approve') {
      const checks = body.checks
      if (
        typeof checks !== 'object' ||
        checks === null ||
        Object.values(checks as Record<string, unknown>).some(value => value !== 'pass')
      ) {
        send(response, 422, { code: 'VALIDATION_REQUIRED', message: '审核清单未完成', request_id: requestId })
        return
      }
      version.status = 'approved'
      version.revision += 1
      skill.status = 'approved'
      skill.revision += 1
      recordGovernanceAudit(audits, principal, '批准版本', skill, version.version, requestId)
      const value = { skill: toAdminSkill(skill), version: toVersion(version), request_id: requestId }
      rememberMutation(idempotency, mutation, value, 200, fingerprint)
      send(response, 200, value)
      return
    }
    if (action === 'reject') {
      const reason = typeof body.reason === 'string' && body.reason.trim().length > 0 ? body.reason.trim() : undefined
      if (reason === undefined) {
        send(response, 422, { code: 'VALIDATION_REQUIRED', message: '驳回必须填写原因', request_id: requestId })
        return
      }
      version.status = 'draft'
      version.revision += 1
      skill.status = 'draft'
      skill.revision += 1
      recordGovernanceAudit(audits, principal, '驳回版本', skill, version.version, requestId, reason)
      const value = { skill: toAdminSkill(skill), version: toVersion(version), request_id: requestId }
      rememberMutation(idempotency, mutation, value, 200, fingerprint)
      send(response, 200, value)
      return
    }
    if (action === 'publish') {
      if (version.status !== 'approved') {
        send(response, 409, { code: 'INVALID_STATUS', message: '只有已批准版本可以发布', request_id: requestId })
        return
      }
      version.status = 'published'
      version.publishedAt = new Date().toISOString()
      // An unsigned release exists so the trust card can prove it reports the
      // missing signature instead of fabricating signature facts (§11.14).
      if (headerValue(request, 'x-fixture-scenario') !== 'unsigned-release') {
        version.signature = releaseSignature(version)
      }
      skill.status = 'published'
      skill.currentVersion = version.version
      version.revision += 1
      skill.revision += 1
      recordGovernanceAudit(audits, principal, '发布版本', skill, version.version, requestId)
      const value = { skill: toAdminSkill(skill), version: toVersion(version), request_id: requestId }
      rememberMutation(idempotency, mutation, value, 200, fingerprint)
      send(response, 200, value)
      return
    }
    if (action === 'withdraw') {
      const reason = typeof body.reason === 'string' && body.reason.trim().length > 0 ? body.reason.trim() : undefined
      if (reason === undefined) {
        send(response, 422, { code: 'VALIDATION_REQUIRED', message: '下线必须填写原因', request_id: requestId })
        return
      }
      version.status = 'withdrawn'
      version.withdrawnReason = reason
      version.revision += 1
      if (skill.currentVersion === version.version) {
        delete skill.currentVersion
        skill.status = 'withdrawn'
      }
      skill.revision += 1
      recordGovernanceAudit(audits, principal, '下线版本', skill, version.version, requestId, reason)
      const value = { skill: toAdminSkill(skill), version: toVersion(version), request_id: requestId }
      rememberMutation(idempotency, mutation, value, 200, fingerprint)
      send(response, 200, value)
      return
    }
    notFound(response, requestId)
  }

  function listen(): Promise<void> {
    return new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(options.port ?? 4100, options.host ?? '127.0.0.1', () => {
        resolve()
      })
    })
  }
  return { server, listen, skills, operations, audits, workspace }
}

function seedPublishedSkill(): SkillRecord {
  return publishedSkill('code-review', '代码评审', '按团队规范检查风险、测试和变更边界。', '质量', ['质量', '审核'], '1.0.0')
}
function seedReviewSkill(): SkillRecord {
  const skill = draftSkill(
    'api-reliability',
    'org-alpha',
    'API 可靠性检查',
    '检查接口错误处理、超时和幂等策略。',
    'group',
    principalForToken('manager-demo'),
  )
  const version = skill.versions[0]
  if (version === undefined) throw new Error('Seed Skill must include an initial version.')
  version.status = 'pending_review'
  skill.status = 'pending_review'
  return skill
}
function publishedSkill(
  id: string,
  name: string,
  summary: string,
  category: string,
  tags: readonly string[],
  version: string,
): SkillRecord {
  const skill = draftSkill(id, 'org-alpha', name, summary, 'organization', principalForToken('manager-demo'), category, tags)
  const release = skill.versions[0]
  if (release === undefined) throw new Error('Published Skill must include an initial version.')
  release.version = version
  release.status = 'published'
  release.publishedAt = new Date().toISOString()
  skill.status = 'published'
  skill.currentVersion = version
  return skill
}
function draftSkill(
  id: string,
  organizationId: string,
  name: string,
  summary: string,
  visibility: Visibility,
  principal: Principal,
  category = '工程效率',
  tags: readonly string[] = ['团队'],
  groupId?: string,
  peopleIds: readonly string[] = [],
): SkillRecord {
  const runtimeName = `aicp-${id}`
  const content = `---\nname: ${runtimeName}\ndescription: ${summary}\n---\n\n# ${name}\n\n${summary}\n`
  const artifact = zipSync({ 'SKILL.md': strToU8(content) })
  const fileBytes = strToU8(content)
  const version: VersionRecord = {
    skillId: id,
    version: '0.1.0',
    status: 'draft',
    releaseNotes: '首个版本',
    artifact,
    artifactSha256: digest(artifact),
    files: [{ path: 'SKILL.md', sha256: digest(fileBytes) }],
    dependencies: ['DSH >= 0.1.0'],
    permissions: ['read_file'],
    validation: [
      { name: 'DSH 单层目录', status: 'passed' },
      { name: '敏感信息扫描', status: 'passed' },
    ],
    revision: 1,
  }
  return {
    skillId: id,
    organizationId,
    displayName: name,
    summary,
    runtimeName,
    category,
    tags,
    visibility,
    ...(visibility === 'group' ? { groupId: groupId ?? 'platform' } : {}),
    peopleIds: visibility === 'people' ? [...(peopleIds.length > 0 ? peopleIds : [principal.userId])] : [],
    authorId: principal.userId,
    authorName: principal.displayName,
    status: 'draft',
    revision: 1,
    versions: [version],
  }
}
function toCatalogItem(skill: SkillRecord) {
  const version = skill.versions.find(value => value.version === skill.currentVersion)
  if (version === undefined) throw new Error('Published Skill must include its current version.')
  return {
    skill_id: skill.skillId,
    display_name: skill.displayName,
    runtime_name: skill.runtimeName,
    summary: skill.summary,
    version: version.version,
    category: skill.category,
    tags: skill.tags,
    published_at: version.publishedAt ?? new Date().toISOString(),
  }
}
function toVersion(version: VersionRecord) {
  return {
    skillId: version.skillId,
    version: version.version,
    status: version.status,
    releaseNotes: version.releaseNotes,
    artifactSha256: version.artifactSha256,
    artifactSizeBytes: version.artifact.byteLength,
    files: version.files,
    dependencies: version.dependencies,
    permissions: version.permissions,
    validation: version.validation,
    revision: version.revision,
    ...(version.publishedAt === undefined ? {} : { publishedAt: version.publishedAt }),
    ...(version.withdrawnReason === undefined ? {} : { withdrawnReason: version.withdrawnReason }),
  }
}

/** Route suffix identifying the read-only trust-card view of one release (§11.14). */
const TRUST_CARD_SUFFIX = ':trust-card'

/** Declared artifact budget every trust card reports. */
const TRUST_CARD_MAX_FILES = 64
const TRUST_CARD_MAX_BYTES = 8 * 1024 * 1024

/** Hosts a release may reach when it declares network access. */
const TRUST_CARD_NETWORK_HOSTS = ['pkg.example.com'] as const

/**
 * Mint the deterministic signature for one published version. The fingerprint
 * is the immutable artifact digest, so the same artifact always reports the
 * same signature facts.
 * @param version - published version being signed.
 * @returns signature facts reported by the trust card.
 */
function releaseSignature(version: VersionRecord): ReleaseSignature {
  return {
    algorithm: 'sha256-ecdsa',
    keyId: 'fixture-release-key',
    fingerprint: version.artifactSha256,
    signedAt: version.publishedAt ?? new Date().toISOString(),
  }
}

/**
 * Build the trust-card fields for one published release.
 * @param audits - governance audit log to draw recent entries from.
 * @param skill - owning Skill record.
 * @param version - published version described by the card.
 * @param signature - the release signature already proven present by the route.
 * @returns trust-card fields without the response envelope.
 */
function trustCardOf(
  audits: readonly AuditRecord[],
  skill: SkillRecord,
  version: VersionRecord,
  signature: ReleaseSignature,
) {
  // The artifact root is '.' for a flat release; an uploaded artifact always
  // carries at least SKILL.md, so the fallback only covers a release that could
  // not be published through the lifecycle in the first place.
  const roots = [
    ...new Set(
      version.files.map((file) => {
        const slash = file.path.indexOf('/')
        return slash === -1 ? '.' : file.path.slice(0, slash)
      }),
    ),
  ]
  const recent = [...audits]
    .filter(audit => audit.skillName === skill.displayName || audit.resourceId === skill.skillId)
    .sort((left, right) => Date.parse(right.occurredAt) - Date.parse(left.occurredAt))
    .slice(0, 10)
    .map(audit => ({
      at: audit.occurredAt,
      action: audit.action,
      outcome: audit.result === 'succeeded' ? ('succeeded' as const) : ('failed' as const),
      actor_name: audit.actor_name,
      request_id: audit.requestId,
    }))
  const network = version.permissions.includes('web_fetch') || version.permissions.includes('subprocess')
  return {
    skill_id: skill.skillId,
    version: version.version,
    display_name: skill.displayName,
    publisher: { name: skill.authorName, organization_id: skill.organizationId },
    signature: {
      algorithm: signature.algorithm,
      key_id: signature.keyId,
      fingerprint: signature.fingerprint,
      signed_at: signature.signedAt,
    },
    tool_permissions: version.permissions,
    file_scope: {
      roots: roots.length === 0 ? ['.'] : roots,
      max_files: TRUST_CARD_MAX_FILES,
      max_bytes: TRUST_CARD_MAX_BYTES,
    },
    external_access: { network, hosts: network ? [...TRUST_CARD_NETWORK_HOSTS] : [] },
    recent_audits: recent,
  }
}
function authorizedResponse(operation: OperationRecord, requestId: string, address: string) {
  return {
    operation_id: operation.operationId,
    status: 'authorized',
    skill_id: operation.skillId,
    runtime_name: operation.runtimeName,
    version: operation.version,
    artifact: {
      download_url: `${address.replace(/\/$/u, '')}/v1/downloads/${operation.operationId}`,
      expires_at: new Date(Date.now() + 300_000).toISOString(),
      sha256: operation.artifact.artifactSha256,
      size_bytes: operation.artifact.artifact.byteLength,
      files: operation.artifact.files,
    },
    request_id: requestId,
  }
}
function recordAudit(
  audits: AuditRecord[],
  operation: OperationRecord,
  status: string,
  requestId: string,
  body: Record<string, unknown>,
): void {
  audits.push({
    id: randomUUID(),
    occurredAt: new Date().toISOString(),
    actorUserId: operation.actor.userId,
    actor_name: operation.actor.displayName,
    action:
      typeof body.action === 'string'
        ? body.action
        : status === 'succeeded'
          ? '本地安装完成'
          : status === 'cancelled'
            ? '本地安装已取消'
            : '本地安装失败',
    skillName: operation.skillId,
    version: operation.version,
    scope: operation.scope,
    result: status === 'succeeded' ? 'succeeded' : status === 'cancelled' ? 'cancelled' : 'failed',
    requestId,
  })
}

function recordGovernanceAudit(
  audits: AuditRecord[],
  principal: Principal,
  action: string,
  skill: SkillRecord,
  version: string,
  requestId: string,
  detail?: string,
): void {
  audits.push({
    id: randomUUID(),
    occurredAt: new Date().toISOString(),
    actorUserId: principal.userId,
    actor_name: principal.displayName,
    action: detail === undefined ? action : `${action}：${detail}`,
    skillName: skill.displayName,
    version,
    result: 'succeeded',
    requestId,
    organizationId: skill.organizationId,
  })
}

function latestVersion(skill: SkillRecord): VersionRecord | undefined {
  return skill.versions.at(-1)
}

function emptyVersion(skillId: string, version: string, releaseNotes: string): VersionRecord {
  const artifact = new Uint8Array()
  return {
    skillId,
    version,
    status: 'draft',
    releaseNotes,
    artifact,
    artifactSha256: digest(artifact),
    files: [],
    dependencies: [],
    permissions: [],
    validation: [{ name: '制品上传', status: 'failed', detail: '尚未上传平台托管制品' }],
    revision: 1,
  }
}

function validateArtifact(
  artifact: Uint8Array,
  runtimeName: string,
): {
  readonly files: readonly { readonly path: string; readonly sha256: string }[]
  readonly validation: readonly { readonly name: string; readonly status: 'passed' | 'failed'; readonly detail?: string }[]
} {
  if (artifact.byteLength === 0 || artifact.byteLength > 2 * 1024 * 1024)
    return { files: [], validation: [{ name: 'DSH 单层目录', status: 'failed', detail: '制品为空或超过 2 MiB 上限' }] }
  let unpacked: Record<string, Uint8Array>
  try {
    unpacked = unzipSync(artifact)
  } catch {
    return { files: [], validation: [{ name: 'DSH 单层目录', status: 'failed', detail: '制品不是可读取的 ZIP 文件' }] }
  }
  const entries = Object.entries(unpacked).sort(([left], [right]) => left.localeCompare(right))
  if (entries.length === 0 || entries.some(([path]) => !safeArtifactPath(path)))
    return { files: [], validation: [{ name: 'DSH 单层目录', status: 'failed', detail: '制品包含不安全的文件路径' }] }
  const skill = unpacked['SKILL.md']
  const source = skill === undefined ? undefined : new TextDecoder().decode(skill)
  const frontmatter = source === undefined ? undefined : /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(source)?.[1]
  const name = frontmatter === undefined ? undefined : /^name:\s*(.+)$/m.exec(frontmatter)?.[1]?.trim()
  const description = frontmatter === undefined ? undefined : /^description:\s*(.+)$/m.exec(frontmatter)?.[1]?.trim()
  if (name !== runtimeName || description === undefined || description.length === 0)
    return {
      files: [],
      validation: [{ name: 'DSH 单层目录', status: 'failed', detail: 'SKILL.md 必须声明平台分配的 name 和 description' }],
    }
  return {
    files: entries.map(([path, bytes]) => ({ path, sha256: digest(bytes) })),
    validation: [
      { name: 'DSH 单层目录', status: 'passed' },
      { name: '敏感信息扫描', status: 'passed' },
    ],
  }
}

function safeArtifactPath(path: string): boolean {
  return (
    path.length > 0 &&
    !path.includes('\\') &&
    !path.startsWith('/') &&
    !path.includes('\0') &&
    path.split('/').every(part => part.length > 0 && part !== '.' && part !== '..')
  )
}

function findSkill(skills: readonly SkillRecord[], id: string | undefined): SkillRecord | undefined {
  return id === undefined ? undefined : skills.find(skill => skill.skillId === decodeURIComponent(id))
}
function checkRevision(request: IncomingMessage, revision: number, body?: Record<string, unknown>): boolean {
  const header = request.headers['if-match']
  if (typeof header === 'string' && header.length > 0) return Number(header) === revision
  const expected = body?.expected_revision
  return typeof expected === 'number' && Number.isFinite(expected) && expected === revision
}
function checkSkillRevision(request: IncomingMessage, revision: number): boolean {
  const value = request.headers['x-skill-revision']
  return typeof value === 'string' && Number(value) === revision
}
function authenticate(request: IncomingMessage, accounts: AccountStore): Principal | undefined {
  const token = bearerToken(request)
  return token === undefined ? undefined : accounts.authenticate(token)
}
function bearerToken(request: IncomingMessage): string | undefined {
  const value = request.headers.authorization
  return value?.startsWith('Bearer ') === true && value.length > 7 ? value.slice(7) : undefined
}
function principalForToken(token: string): Principal {
  if (token === 'admin-demo')
    return { token, userId: 'admin-1', displayName: '平台管理员', role: 'admin', groups: ['platform'], mustChangePassword: false }
  if (token === 'manager-demo')
    return { token, userId: 'manager-1', displayName: '组织经理', role: 'manager', groups: ['platform'], mustChangePassword: false }
  return { token, userId: 'member-1', displayName: '演示成员', role: 'member', groups: ['platform'], mustChangePassword: false }
}
function requiredIdempotencyKey(request: IncomingMessage, response: ServerResponse, requestId: string): string | undefined {
  const value = request.headers['idempotency-key']
  if (typeof value === 'string' && value.length > 0) return value
  send(response, 400, { code: 'IDEMPOTENCY_KEY_REQUIRED', message: '危险写操作必须提供 Idempotency-Key', request_id: requestId })
  return undefined
}
type MutationState = { readonly kind: 'new'; readonly key: string } | { readonly kind: 'replayed' }
function beginMutation(
  request: IncomingMessage,
  response: ServerResponse,
  requestId: string,
  idempotency: Map<string, IdempotentResponse>,
  fingerprint: string,
): MutationState | undefined {
  const key = requiredIdempotencyKey(request, response, requestId)
  if (key === undefined) return undefined
  const previous = idempotency.get(key)
  if (previous === undefined) return { kind: 'new', key }
  if (previous.fingerprint !== fingerprint) {
    send(response, 409, { code: 'IDEMPOTENCY_CONFLICT', message: '幂等键已用于另一请求', request_id: requestId })
    return { kind: 'replayed' }
  }
  send(response, previous.status, previous.value)
  return { kind: 'replayed' }
}
function rememberMutation(
  idempotency: Map<string, IdempotentResponse>,
  state: MutationState,
  value: unknown,
  status: number,
  fingerprint: string,
): void {
  if (state.kind === 'new') idempotency.set(state.key, { fingerprint, value, status })
}
type OperationStatus = OperationRecord['status']
function parseOperationStatus(value: unknown): OperationStatus | undefined {
  return value === 'downloading' ||
    value === 'verifying' ||
    value === 'writing' ||
    value === 'refreshing' ||
    value === 'succeeded' ||
    value === 'failed' ||
    value === 'cancelled'
    ? value
    : undefined
}
function validOperationTransition(from: OperationStatus, to: OperationStatus): boolean {
  const allowed: Readonly<Record<OperationStatus, readonly OperationStatus[]>> = {
    authorized: ['downloading', 'cancelled'],
    downloading: ['verifying', 'failed', 'cancelled'],
    verifying: ['writing', 'failed', 'cancelled'],
    writing: ['refreshing', 'failed', 'cancelled'],
    refreshing: ['succeeded', 'failed', 'cancelled'],
    succeeded: [],
    failed: [],
    cancelled: [],
  }
  return allowed[from].includes(to)
}
async function readBytes(request: IncomingMessage): Promise<Uint8Array> {
  const chunks: Uint8Array[] = []
  for await (const chunk of request as AsyncIterable<Uint8Array | string>) {
    chunks.push(typeof chunk === 'string' ? new TextEncoder().encode(chunk) : chunk)
  }
  const result = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0))
  let offset = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.byteLength
  }
  return result
}
async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const bytes = await readBytes(request)
  const text = new TextDecoder().decode(bytes)
  if (text.length === 0) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(text) as unknown
  } catch {
    throw new InvalidJsonRequest('请求体必须是有效 JSON')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new InvalidJsonRequest('请求体必须是 JSON 对象')
  return parsed as Record<string, unknown>
}

class InvalidJsonRequest extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidJsonRequest'
  }
}

/** Request-body field failure carrying its stable client-error status and code. */
class RequestValidationError extends Error {
  /**
   * @param status - Stable HTTP status for this class of request error (400 or 422).
   * @param code - Stable machine-readable error code.
   * @param message - Field-level failure description.
   */
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'RequestValidationError'
  }
}
function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}
function stringField(body: Record<string, unknown>, key: string): string {
  const value = body[key]
  if (value === undefined || (typeof value === 'string' && value.length === 0))
    throw new RequestValidationError(422, 'VALIDATION_REQUIRED', `缺少必填字段 ${key}`)
  if (typeof value !== 'string') throw new RequestValidationError(422, 'VALIDATION_ERROR', `字段 ${key} 必须是字符串`)
  return value
}
function numberField(body: Record<string, unknown>, key: string): number {
  const value = body[key]
  if (value === undefined) throw new RequestValidationError(422, 'VALIDATION_REQUIRED', `缺少必填字段 ${key}`)
  if (typeof value !== 'number' || !Number.isFinite(value))
    throw new RequestValidationError(422, 'VALIDATION_ERROR', `字段 ${key} 必须是有限数字`)
  return value
}
function optionalQuery(request: IncomingMessage, key: string): string | undefined {
  const value = new URL(request.url ?? '/', 'http://localhost').searchParams.get(key)
  return value === null || value.length === 0 ? undefined : value
}
function parseRole(value: string | undefined): AccountRole | undefined {
  return value === 'admin' || value === 'manager' || value === 'member' ? value : undefined
}
function parseAccountStatus(value: string | undefined): 'active' | 'suspended' | undefined {
  return value === 'active' || value === 'suspended' ? value : undefined
}
function parseProjectStatus(value: string | undefined): 'draft' | 'active' | 'archived' | undefined {
  return value === 'draft' || value === 'active' || value === 'archived' ? value : undefined
}
function parseAssetType(value: unknown): 'skill' | 'knowledge' | 'memory' | undefined {
  return value === 'skill' || value === 'knowledge' || value === 'memory' ? value : undefined
}
function parseRelationKind(value: unknown): 'reference' | 'context' | undefined {
  return value === 'reference' || value === 'context' ? value : undefined
}
function headerRevision(request: IncomingMessage): number | undefined {
  const value = request.headers['if-match']
  if (typeof value !== 'string' || value.length === 0) return undefined
  const revision = Number(value)
  return Number.isFinite(revision) ? revision : undefined
}
function headerValue(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name]
  return typeof value === 'string' ? value : undefined
}
function requiredPart(parts: readonly string[], index: number): string {
  const value = parts[index]
  if (value === undefined) throw new Error(`路由缺少第 ${index} 段`)
  return value
}
function accountFailure(status: number, code: string, message: string): AccountOperationResult {
  return { ok: false, status, code, message }
}
function isAccountFailure(value: unknown): value is Extract<AccountOperationResult, { readonly ok: false }> {
  return typeof value === 'object' && value !== null && 'ok' in value && (value as { ok?: unknown }).ok === false
}
function isProjectViews(value: AccountOperationResult | readonly ProjectView[]): value is readonly ProjectView[] {
  return Array.isArray(value)
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function sendAccountResult(response: ServerResponse, requestId: string, value: unknown): void {
  if (isAccountFailure(value)) {
    send(response, value.status, { code: value.code, message: value.message, request_id: requestId })
    return
  }
  send(response, 200, { ...(isRecord(value) ? value : { items: value }), request_id: requestId })
}
function slug(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || `skill-${randomUUID().slice(0, 8)}`
  )
}
function digest(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}
function notFound(response: ServerResponse, requestId: string): void {
  send(response, 404, { code: 'NOT_FOUND', message: '资源不存在', request_id: requestId })
}
function send(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  if (status === 204 || value === undefined) {
    response.end()
    return
  }
  const record = isRecord(value) ? value : undefined
  const requestId = typeof record?.request_id === 'string' && record.request_id.length > 0 ? record.request_id : randomUUID()
  const code = typeof record?.code === 'string' || typeof record?.code === 'number' ? record.code : 0
  const message = typeof record?.message === 'string' ? record.message : code === 0 ? 'ok' : '请求失败'
  const data = code === 0
    ? record === undefined
      ? value
      : Object.fromEntries(Object.entries(record).filter(([key]) => key !== 'request_id' && key !== 'code' && key !== 'message'))
    : null
  response.end(JSON.stringify({ code, message, request_id: requestId, data }))
}
function addCors(response: ServerResponse): void {
  response.setHeader('access-control-allow-origin', '*')
  response.setHeader('access-control-allow-headers', 'authorization,content-type,idempotency-key,if-match,x-skill-revision')
  response.setHeader('access-control-allow-methods', 'GET,POST,PATCH,PUT,DELETE,OPTIONS')
}

function urlSearch(request: IncomingMessage): string {
  return new URL(request.url ?? '/', 'http://localhost').searchParams.get('query') ?? ''
}

function seedKnowledgeBases(): KnowledgeBaseRecord[] {
  const now = new Date().toISOString()
  const document = (documentId: string, title: string, snippet: string): KnowledgeDocumentRecord => ({
    documentId,
    externalId: `weknora-${documentId}`,
    title,
    source: 'fixture',
    status: 'completed',
    snippet,
    version: 'v1',
    updatedAt: now,
  })
  return [
    {
      knowledgeBaseId: 'k-1',
      externalId: 'weknora-k-1',
      organizationId: 'org-alpha',
      name: '发布流程',
      description: '平台发布与审核规范',
      type: 'document',
      state: 'active',
      searchable: true,
      revision: 1,
      updatedAt: now,
      documents: [document('doc-release', '发布流程', '提交变更、完成审核后再发布版本。')],
    },
    {
      knowledgeBaseId: 'k-3',
      externalId: 'weknora-k-3',
      organizationId: 'org-alpha',
      name: '工程 FAQ',
      description: '常见工程问题',
      type: 'faq',
      state: 'active',
      searchable: true,
      revision: 1,
      updatedAt: now,
      documents: [],
    },
    {
      knowledgeBaseId: 'k-2',
      externalId: 'weknora-k-2',
      organizationId: 'org-beta',
      name: '接入手册',
      description: '服务接入说明',
      type: 'document',
      state: 'active',
      searchable: true,
      revision: 1,
      updatedAt: now,
      documents: [document('doc-onboarding', '接入手册', '申请凭据并完成环境检查。')],
    },
    {
      knowledgeBaseId: 'k-4',
      externalId: 'weknora-k-4',
      organizationId: 'org-beta',
      name: '运维 Wiki',
      description: '运维知识页面',
      type: 'wiki',
      state: 'active',
      searchable: true,
      revision: 1,
      updatedAt: now,
      documents: [],
    },
  ]
}

function knowledgeBaseView(value: KnowledgeBaseRecord): Record<string, unknown> {
  return {
    knowledge_base_id: value.knowledgeBaseId,
    organization_id: value.organizationId,
    name: value.name,
    description: value.description,
    type: value.type,
    state: value.state,
    searchable: value.searchable,
    updated_at: value.updatedAt,
    revision: value.revision,
    document_count: value.documents.length,
  }
}

function documentView(value: KnowledgeDocumentRecord): Record<string, unknown> {
  return { document_id: value.documentId, title: value.title, source: value.source, status: value.status, snippet: value.snippet }
}

function createFixtureWeKnoraAdapter(resolveKnowledgeBases: () => readonly KnowledgeBaseRecord[]): WeKnoraAdapter {
  return {
    search(request) {
      const records = resolveKnowledgeBases()
      const query = request.query.toLocaleLowerCase()
      const knowledgeBases: WeKnoraSearchStatus[] = []
      const results: WeKnoraSearchResult[] = []
      for (const ref of request.knowledgeBases) {
        const knowledgeBase = records.find(item => item.externalId === ref.externalId)
        if (knowledgeBase === undefined) {
          knowledgeBases.push({ externalId: ref.externalId, status: 'skipped', reason: 'not_found' })
          continue
        }
        const document = knowledgeBase.documents.find(
          item => item.status === 'completed' && `${item.title}${item.snippet}`.toLocaleLowerCase().includes(query),
        )
        if (document === undefined) {
          knowledgeBases.push({ externalId: ref.externalId, status: 'no_hits', reason: null })
          continue
        }
        knowledgeBases.push({ externalId: ref.externalId, status: 'used', reason: null })
        results.push({
          externalKnowledgeBaseId: knowledgeBase.externalId,
          externalKnowledgeId: document.externalId,
          title: document.title,
          snippet: document.snippet,
          score: 0.9,
          sourceUrl: `weknora://knowledge/${encodeURIComponent(knowledgeBase.externalId)}/${encodeURIComponent(document.externalId)}`,
          version: document.version,
          updatedAt: document.updatedAt,
          citation: { page: 1, chunk: `chunk-${document.externalId}` },
        })
      }
      return Promise.resolve({
        knowledgeBases,
        results: typeof request.topK === 'number' ? results.slice(0, Math.max(0, request.topK)) : results,
      })
    },
  }
}

function parseKnowledgeType(value: unknown): KnowledgeBaseType | undefined {
  return value === 'document' || value === 'faq' || value === 'wiki' ? value : undefined
}

if (process.argv[1]?.endsWith('server.ts') === true) {
  const app = createTeamSkillService({ port: Number(process.env.TEAM_SKILL_SERVICE_PORT ?? 4100) })
  void app.listen().then(() => {
    console.log(`Team Skill service listening on http://127.0.0.1:${process.env.TEAM_SKILL_SERVICE_PORT ?? '4100'}`)
  })
}
