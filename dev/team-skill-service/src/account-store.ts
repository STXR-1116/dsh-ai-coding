import { randomUUID } from 'node:crypto'

export type AccountRole = 'admin' | 'manager' | 'member'
export type AccountStatus = 'active' | 'suspended'

export interface AccountPrincipal {
  readonly token: string
  readonly userId: string
  readonly displayName: string
  readonly role: AccountRole
  readonly groups: readonly string[]
  readonly mustChangePassword: boolean
}

export interface AccountUserView {
  readonly user_id: string
  readonly username: string
  readonly email: string
  readonly display_name: string
  readonly status: AccountStatus
  readonly global_role: AccountRole
  readonly must_change_password: boolean
  readonly revision: number
  readonly memberships?: readonly MembershipView[]
}

export interface MembershipView {
  readonly organization_id: string
  readonly organization_name: string
  readonly status: AccountStatus
  readonly revision: number
}

export interface OrganizationView {
  readonly organization_id: string
  readonly name: string
  readonly status: 'active' | 'archived'
  readonly revision: number
}

export interface ProjectView {
  readonly project_id: string
  readonly organization_id: string
  readonly organization_name: string
  readonly name: string
  readonly description: string
  readonly status: 'draft' | 'active' | 'archived'
  readonly created_by: string
  readonly created_at: string
  readonly updated_at: string
  readonly revision: number
  readonly member_count: number
  readonly asset_count: number
}

export interface ProjectMemberView {
  readonly project_id: string
  readonly organization_id: string
  readonly user_id: string
  readonly display_name: string
  readonly status: 'active' | 'removed'
  readonly joined_at: string
  readonly updated_at: string
  readonly revision: number
}

export interface ProjectAssetRelationView {
  readonly project_id: string
  readonly asset_type: 'skill' | 'knowledge' | 'memory'
  readonly asset_id: string
  readonly name: string
  readonly relation_kind: 'reference' | 'context'
  readonly created_at: string
  readonly updated_at: string
  readonly revision: number
}

/** Directory entry for one active organization member, served to Skill governance surfaces. */
export interface DirectoryUserView {
  readonly user_id: string
  readonly display_name: string
  readonly email: string
  readonly organization_id: string
  readonly groups: readonly string[]
}

export interface AuthorizationAudit {
  readonly id: string
  readonly occurred_at: string
  readonly actor_user_id: string
  readonly actor_name: string
  readonly organization_id?: string
  readonly target_user_id?: string
  readonly project_id?: string
  readonly action: string
  readonly result: 'succeeded' | 'failed'
  readonly error_code?: string
  readonly request_id: string
}

export interface LoginResult {
  readonly access_token: string
  readonly refresh_token: string
  readonly expires_in: number
  readonly user: AccountUserView
  readonly memberships: readonly MembershipView[]
  readonly must_change_password: boolean
}

interface AssetView {
  readonly asset_id: string
  readonly asset_type: 'project' | 'skill' | 'knowledge' | 'memory'
  readonly name: string
  readonly visibility: 'platform' | 'organization' | 'project' | 'account'
  readonly organization_id?: string
  readonly project_id?: string
}

export interface AccessSummaryView {
  readonly organizations: readonly OrganizationView[]
  readonly projects: readonly ProjectView[]
  readonly assets: readonly AssetView[]
  readonly management_organization_ids: readonly string[]
  readonly management_project_ids: readonly string[]
  readonly revision: number
}

interface MembershipRecord {
  status: AccountStatus
  revision: number
}

interface UserRecord {
  readonly userId: string
  username: string
  email: string
  displayName: string
  status: AccountStatus
  globalRole: AccountRole
  password: string
  mustChangePassword: boolean
  revision: number
  readonly memberships: Map<string, MembershipRecord>
}

interface OrganizationRecord {
  readonly organizationId: string
  name: string
  status: 'active' | 'archived'
  revision: number
}

interface ProjectMemberRecord {
  status: 'active' | 'removed'
  createdAt: string
  updatedAt: string
  revision: number
}

interface ProjectAssetRelationRecord {
  readonly assetType: 'skill' | 'knowledge' | 'memory'
  readonly assetId: string
  relationKind: 'reference' | 'context'
  readonly createdAt: string
  updatedAt: string
  revision: number
}

interface ProjectRecord {
  readonly projectId: string
  readonly organizationId: string
  organizationName: string
  name: string
  description: string
  readonly createdBy: string
  readonly createdAt: string
  updatedAt: string
  status: 'draft' | 'active' | 'archived'
  revision: number
  readonly members: Map<string, ProjectMemberRecord>
  readonly assets: Map<string, ProjectAssetRelationRecord>
}

interface GroupRecord {
  readonly groupId: string
  readonly organizationId: string
  name: string
  readonly memberUserIds: Set<string>
  revision: number
}

interface SessionRecord {
  readonly accessToken: string
  readonly refreshToken: string
  readonly userId: string
  readonly expiresAt: number
  revoked: boolean
}

export interface CreateUserInput {
  readonly username: string
  readonly displayName: string
  readonly organizationIds: readonly string[]
  readonly globalRole: AccountRole
  readonly projectIds: readonly string[]
}

export interface UpdateUserInput {
  readonly displayName?: string
  readonly status?: AccountStatus
}

export interface UpdateOrganizationInput {
  readonly name?: string
  readonly status?: 'active' | 'archived'
}

export interface CreateOrganizationInput {
  readonly name: string
  readonly managerUserId?: string
}

export interface CreateProjectInput {
  readonly organizationId: string
  readonly name: string
  readonly description?: string
}

export interface UpdateProjectInput {
  readonly name?: string
  readonly description?: string
}

export type AccountOperationResult =
  | {
    readonly ok: true
    readonly value: unknown
  }
  | {
    readonly ok: false
    readonly status: number
    readonly code: string
    readonly message: string
  }

/** Failure-only variant used by reads whose success type carries the actual resource. */
export type AccountStoreFailure = Extract<AccountOperationResult, { readonly ok: false }>

interface SessionTokens {
  readonly access_token: string
  readonly refresh_token: string
  readonly expires_in: number
}

/** In-memory identity, organization, project-membership and session authority for local integration. */
export class AccountStore {
  private readonly users = new Map<string, UserRecord>()
  private readonly organizationRecords = new Map<string, OrganizationRecord>()
  private readonly projects = new Map<string, ProjectRecord>()
  private readonly groups = new Map<string, GroupRecord>()
  private readonly sessions = new Map<string, SessionRecord>()
  private readonly platformAssets = new Set<string>()
  private readonly audits: AuthorizationAudit[] = []
  private readonly denialAuditRequests = new Set<string>()


  constructor(seed = true) {
    if (seed) this.seed()
  }

  get authorizationAudits(): readonly AuthorizationAudit[] {
    return this.audits
  }

  /**
   * 为权限模拟（§11.19）构造目标用户的评估主体：无会话（token 为占位），
   * 仅用于以该用户身份执行只读决策评估。
   */
  principalForUser(userId: string): AccountPrincipal | undefined {
    const user = this.users.get(userId)
    if (user === undefined || user.status !== 'active') return undefined
    return {
      token: 'simulate-only',
      userId: user.userId,
      displayName: user.displayName,
      role: this.globalRole(user),
      groups: ['platform'],
      mustChangePassword: user.mustChangePassword,
    }
  }

  authenticate(token: string): AccountPrincipal | undefined {
    const session = this.sessions.get(token)
    if (session === undefined || session.revoked || session.expiresAt < Date.now()) return undefined
    const user = this.users.get(session.userId)
    if (user === undefined || user.status !== 'active') return undefined
    const role = this.globalRole(user)
    return {
      token,
      userId: user.userId,
      displayName: user.displayName,
      role,
      groups: ['platform'],
      mustChangePassword: user.mustChangePassword,
    }
  }

  login(username: string, password: string, requestId: string): LoginResult | AccountOperationResult | undefined {
    const user = [...this.users.values()].find(value => value.username === username || value.email === username)
    if (user?.status === 'suspended') {
      this.recordAudit(user.userId, user.displayName, '登录失败', 'failed', 'ACCOUNT_SUSPENDED', requestId, this.auditOrganizationId(user))
      return this.failure(403, 'ACCOUNT_SUSPENDED', '账号已停用')
    }
    if (user === undefined || user.password !== password) {
      if (user !== undefined)
        this.recordAudit(
          user.userId,
          user.displayName,
          '登录失败',
          'failed',
          'INVALID_CREDENTIALS',
          requestId,
          this.auditOrganizationId(user),
        )
      return undefined
    }
    const session = this.createSession(user.userId)
    this.recordAudit(user.userId, user.displayName, '登录成功', 'succeeded', undefined, requestId, this.auditOrganizationId(user))
    return { ...session, user: this.userView(user), memberships: this.membershipsView(user), must_change_password: user.mustChangePassword }
  }

  refresh(refreshToken: string, requestId: string): LoginResult | undefined {
    const session = [...this.sessions.values()].find(value => value.refreshToken === refreshToken && !value.revoked)
    if (session === undefined || session.expiresAt < Date.now()) return undefined
    const user = this.users.get(session.userId)
    if (user === undefined || user.status !== 'active') return undefined
    session.revoked = true
    const next = this.createSession(user.userId)
    this.recordAudit(user.userId, user.displayName, '令牌刷新', 'succeeded', undefined, requestId, this.auditOrganizationId(user))
    return { ...next, user: this.userView(user), memberships: this.membershipsView(user), must_change_password: user.mustChangePassword }
  }

  logout(token: string, requestId: string): boolean {
    const session = this.sessions.get(token)
    if (session === undefined) return true
    session.revoked = true
    const user = this.users.get(session.userId)
    if (user !== undefined)
      this.recordAudit(user.userId, user.displayName, '退出登录', 'succeeded', undefined, requestId, this.auditOrganizationId(user))
    return true
  }

  changePassword(token: string, currentPassword: string, newPassword: string, requestId: string): LoginResult | AccountOperationResult {
    const principal = this.authenticate(token)
    if (principal === undefined) return this.failure(401, 'TOKEN_REVOKED', '会话已失效')
    const user = this.users.get(principal.userId)
    if (user === undefined || user.password !== currentPassword) return this.failure(401, 'INVALID_CREDENTIALS', '当前密码不正确')
    if (newPassword.length < 8) return this.failure(422, 'VALIDATION_ERROR', '新密码至少需要 8 个字符')
    user.password = newPassword
    user.mustChangePassword = false
    user.revision += 1
    this.revokeUserSessions(user.userId)
    const next = this.createSession(user.userId)
    this.recordAudit(user.userId, user.displayName, '密码修改', 'succeeded', undefined, requestId, this.auditOrganizationId(user))
    return { ...next, user: this.userView(user), memberships: this.membershipsView(user), must_change_password: false }
  }

  me(principal: AccountPrincipal): { readonly user: AccountUserView; readonly memberships: readonly MembershipView[] } | undefined {
    const user = this.users.get(principal.userId)
    return user === undefined ? undefined : { user: this.userView(user), memberships: this.membershipsView(user) }
  }

  /** Organizations visible to the caller: active organizations filtered by membership
   * (non-admin) or returned in full for admin governance reads. Archived organizations
   * are hidden from regular aggregation so their projects cannot leak into summaries. */
  organizationsVisibleTo(principal: AccountPrincipal, options: { readonly includeArchived?: boolean } = {}): readonly OrganizationView[] {
    return [...this.organizationRecords.values()]
      .filter(org => (options.includeArchived === true || org.status === 'active') && (principal.role === 'admin' || this.membership(principal.userId, org.organizationId)?.status === 'active'))
      .map(organizationView)
  }

  organizations(principal: AccountPrincipal): readonly OrganizationView[] {
    return this.organizationsVisibleTo(principal)
  }

  accessSummary(principal: AccountPrincipal): AccessSummaryView {
    const organizations = this.organizations(principal)
    const organizationIds = new Set(organizations.map(organization => organization.organization_id))
    const projectRecords = [...this.projects.values()]
      .filter(project => project.status === 'active' && organizationIds.has(project.organizationId))
      .filter(project => principal.role !== 'member' || project.members.get(principal.userId)?.status === 'active')
    const projects = projectRecords.map(projectView)
    const assets = projectRecords.flatMap((project) => {
      const projectSummary = projectView(project)
      return [
        {
          asset_id: projectSummary.project_id,
          asset_type: 'project' as const,
          name: projectSummary.name,
          visibility: 'project' as const,
          organization_id: projectSummary.organization_id,
          project_id: projectSummary.project_id,
        },
        ...this.projectAssetsView(project, principal).map(item => ({
          asset_id: item.asset_id,
          asset_type: item.asset_type,
          name: item.name,
          visibility: 'project' as const,
          organization_id: projectSummary.organization_id,
          project_id: projectSummary.project_id,
        })),
      ]
    })
    const managementProjects = principal.role === 'member' ? [] : projects.map(project => project.project_id)
    return {
      organizations,
      projects,
      assets,
      management_organization_ids: organizations.map(item => item.organization_id),
      management_project_ids: managementProjects,
      revision: Math.max(1, ...organizations.map(item => item.revision), ...projects.map(item => item.revision)),
    }
  }

  /** Record one failed governance/authorization denial as a `failed` audit entry.
   * Deduplicated per (user, action, request_id): a single request that trips the same
   * check repeatedly produces one audit, while independent requests each leave one. */
  recordGovernanceDenial(
    principal: AccountPrincipal,
    action: string,
    code: string,
    requestId: string,
    target?: string,
  ): void {
    const dedupeKey = `${principal.userId}|${action}|${requestId}`
    if (this.denialAuditRequests.has(dedupeKey)) return
    this.denialAuditRequests.add(dedupeKey)
    this.recordAudit(
      principal.userId,
      principal.displayName,
      action,
      'failed',
      code,
      requestId,
      undefined,
      undefined,
      target,
    )
  }

  /** Authorize one active project for a caller without exposing inaccessible projects.
   * Denied project reads are recorded as failed authorization audits (one per request)
   * so security investigations can trace refused access without leaking the resource. */
  /** Raw project asset authorization keys (`type:id`); undefined when absent. */
  projectAssetKeys(projectId: string): readonly string[] | undefined {
    const project = this.projects.get(projectId)
    if (project === undefined) return undefined
    return [...project.assets.keys()]
  }

  /** The organization a project belongs to; undefined when the project is absent. */
  projectOrganization(projectId: string): string | undefined {
    return this.projects.get(projectId)?.organizationId
  }

  /** 项目生命周期状态;不存在时 undefined。绑定类治理只接受 active 项目。 */
  projectStatus(projectId: string): 'draft' | 'active' | 'archived' | undefined {
    return this.projects.get(projectId)?.status
  }

  authorizeProject(principal: AccountPrincipal, projectId: string, requestId?: string): ProjectView | AccountStoreFailure {
    const project = this.projects.get(projectId)
    if (project === undefined || project.status !== 'active') {
      this.recordAudit(
        principal.userId,
        principal.displayName,
        '项目访问拒绝',
        'failed',
        'RESOURCE_NOT_FOUND',
        requestId ?? 'no-request-id',
        project?.organizationId,
        undefined,
        projectId,
      )
      return this.failure(404, 'RESOURCE_NOT_FOUND', '项目不存在')
    }
    const organization = this.organizationRecords.get(project.organizationId)
    if (organization === undefined || organization.status !== 'active') {
      this.recordAudit(
        principal.userId,
        principal.displayName,
        '项目访问拒绝',
        'failed',
        'RESOURCE_NOT_FOUND',
        requestId ?? 'no-request-id',
        project.organizationId,
        undefined,
        projectId,
      )
      return this.failure(404, 'RESOURCE_NOT_FOUND', '项目不存在')
    }
    const organizationMembership = this.membership(principal.userId, project.organizationId)
    const allowed =
      principal.role === 'admin' ||
      (organizationMembership?.status === 'active' && principal.role === 'manager') ||
      (organizationMembership?.status === 'active' &&
        principal.role === 'member' &&
        project.members.get(principal.userId)?.status === 'active')
    if (!allowed) {
      this.recordAudit(
        principal.userId,
        principal.displayName,
        '项目访问拒绝',
        'failed',
        'PROJECT_NOT_MEMBER',
        requestId ?? 'no-request-id',
        project.organizationId,
        undefined,
        projectId,
      )
      return this.failure(404, 'PROJECT_NOT_MEMBER', '用户不是该项目成员')
    }
    return projectView(project)
  }

  listOrganizationsForAdmin(principal: AccountPrincipal): readonly OrganizationView[] | AccountOperationResult {
    if (principal.role === 'member') return this.failure(403, 'FORBIDDEN', '需要管理员权限')
    // 治理路由必须能看到 archived 组织（恢复入口），聚合读取则只返回 active。
    return this.organizationsVisibleTo(principal, { includeArchived: true })
  }

  createOrganization(principal: AccountPrincipal, input: CreateOrganizationInput, requestId: string): AccountOperationResult {
    if (principal.role !== 'admin') return this.failure(403, 'FORBIDDEN', '需要管理员权限')
    const name = input.name.trim()
    if (name.length === 0) return this.failure(422, 'VALIDATION_ERROR', '组织名称不能为空')
    const manager = input.managerUserId === undefined ? undefined : this.users.get(input.managerUserId)
    if (input.managerUserId !== undefined && (manager === undefined || manager.status !== 'active' || manager.globalRole !== 'manager'))
      return this.failure(422, 'VALIDATION_ERROR', 'manager 用户不存在、已停用或角色不匹配')
    const organizationId = `org-${randomUUID().slice(0, 8)}`
    const organizationRecord: OrganizationRecord = { organizationId, name, status: 'active', revision: 1 }
    this.organizationRecords.set(organizationId, organizationRecord)
    if (manager !== undefined) {
      manager.memberships.set(organizationId, { status: 'active', revision: 1 })
      manager.revision += 1
    }
    this.recordAudit(principal.userId, principal.displayName, '组织创建', 'succeeded', undefined, requestId, organizationId)
    return { ok: true, value: organizationView(organizationRecord) }
  }

  getOrganization(principal: AccountPrincipal, organizationId: string): OrganizationView | AccountOperationResult {
    const organization = this.organizationRecords.get(organizationId)
    if (
      organization === undefined ||
      (principal.role !== 'admin' && this.membership(principal.userId, organizationId)?.status !== 'active')
    )
      return this.failure(404, 'RESOURCE_NOT_FOUND', '组织不存在')
    return organizationView(organization)
  }

  updateOrganization(
    principal: AccountPrincipal,
    organizationId: string,
    input: UpdateOrganizationInput,
    expectedRevision: number | undefined,
    requestId: string,
  ): AccountOperationResult {
    if (principal.role !== 'admin') return this.failure(403, 'FORBIDDEN', '需要管理员权限')
    const organization = this.organizationRecords.get(organizationId)
    if (organization === undefined) return this.failure(404, 'RESOURCE_NOT_FOUND', '组织不存在')
    if (expectedRevision !== organization.revision) return this.failure(409, 'REVISION_CONFLICT', '组织已更新，请刷新后重试')
    if (input.name !== undefined && input.name.trim().length > 0) {
      organization.name = input.name.trim()
      // 组织重命名必须同步所有项目投影，否则项目列表/详情/聚合在同一个响应周期内
      // 返回旧组织名称。
      for (const project of this.projects.values()) {
        if (project.organizationId !== organizationId) continue
        project.organizationName = organization.name
        project.revision += 1
      }
    }
    if (input.status !== undefined) organization.status = input.status
    organization.revision += 1
    this.recordAudit(principal.userId, principal.displayName, '组织更新', 'succeeded', undefined, requestId, organizationId)
    return { ok: true, value: organizationView(organization) }
  }

  listUsers(
    principal: AccountPrincipal,
    organizationId: string | undefined,
    role: AccountRole | undefined,
    status: AccountStatus | undefined,
    query: string,
  ): readonly AccountUserView[] | AccountOperationResult {
    if (principal.role === 'member') return this.failure(403, 'FORBIDDEN', '需要管理员权限')
    const visibleOrganizationIds = this.visibleOrganizationIds(principal)
    if (organizationId !== undefined && visibleOrganizationIds !== undefined && !visibleOrganizationIds.has(organizationId))
      return this.failure(404, 'RESOURCE_NOT_FOUND', '组织不存在')
    return [...this.users.values()]
      .filter(user => visibleOrganizationIds === undefined || [...user.memberships.keys()].some(id => visibleOrganizationIds.has(id)))
      .filter(user => organizationId === undefined || user.memberships.has(organizationId))
      .filter(user => role === undefined || user.globalRole === role)
      .filter(user => status === undefined || user.status === status)
      .filter(
        user =>
          query.length === 0 || `${user.username}${user.email}${user.displayName}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
      )
      .map(user => this.adminUserView(user, visibleOrganizationIds))
  }

  createUser(principal: AccountPrincipal, input: CreateUserInput, requestId: string): AccountOperationResult {
    if (input.globalRole === 'admin') return this.failure(422, 'VALIDATION_ERROR', '不能通过账号创建接口新增 admin')
    if (input.organizationIds.length === 0) return this.failure(422, 'VALIDATION_ERROR', '至少需要加入一个组织')
    const organizations = input.organizationIds.map(id => this.organizationRecords.get(id))
    if (organizations.some(organization => organization === undefined || organization.status !== 'active'))
      return this.failure(404, 'RESOURCE_NOT_FOUND', '组织不存在')
    const principalUser = this.users.get(principal.userId)
    if (principalUser === undefined) return this.failure(401, 'UNAUTHORIZED', '需要有效的 Bearer 令牌')
    const managerOrganizations = new Set(this.membershipsView(principalUser).map(item => item.organization_id))
    if (principal.role !== 'admin' && (input.globalRole !== 'member' || input.organizationIds.some(id => !managerOrganizations.has(id))))
      return this.failure(403, 'FORBIDDEN', 'manager 只能在本组织创建 member')
    if ([...this.users.values()].some(user => user.username === input.username || user.email === input.username))
      return this.failure(409, 'VALIDATION_ERROR', '用户名已存在')
    if (
      input.projectIds.some((projectId) => {
        const project = this.projects.get(projectId)
        return project === undefined || !input.organizationIds.includes(project.organizationId)
      })
    )
      return this.failure(422, 'VALIDATION_ERROR', '项目必须属于目标组织')
    const userId = `user-${randomUUID().slice(0, 8)}`
    const initialPassword = `dsh-${randomUUID().replaceAll('-', '').slice(0, 12)}`
    const user: UserRecord = {
      userId,
      username: input.username,
      email: input.username,
      displayName: input.displayName,
      status: 'active',
      globalRole: input.globalRole,
      password: initialPassword,
      mustChangePassword: true,
      revision: 1,
      memberships: new Map(input.organizationIds.map(organizationId => [organizationId, { status: 'active', revision: 1 }] as const)),
    }
    this.users.set(userId, user)
    const now = new Date().toISOString()
    for (const projectId of input.projectIds)
      this.projects.get(projectId)?.members.set(userId, { status: 'active', createdAt: now, updatedAt: now, revision: 1 })
    this.recordAudit(
      principal.userId,
      principal.displayName,
      '账号创建',
      'succeeded',
      undefined,
      requestId,
      input.organizationIds[0],
      userId,
    )
    return { ok: true, value: { user: this.userView(user), initial_password: initialPassword } }
  }

  getUser(principal: AccountPrincipal, userId: string): AccountUserView | AccountOperationResult {
    const user = this.users.get(userId)
    if (user === undefined || !this.canManageUser(principal, user)) return this.failure(404, 'RESOURCE_NOT_FOUND', '用户不存在')
    return this.adminUserView(user, this.visibleOrganizationIds(principal))
  }

  updateUser(
    principal: AccountPrincipal,
    userId: string,
    input: UpdateUserInput,
    expectedRevision: number | undefined,
    requestId: string,
  ): AccountOperationResult {
    const user = this.users.get(userId)
    if (user === undefined || !this.canManageUser(principal, user)) {
      if (user !== undefined)
        this.recordAudit(
          principal.userId,
          principal.displayName,
          '账号访问拒绝',
          'failed',
          'RESOURCE_NOT_FOUND',
          requestId,
          [...user.memberships.keys()].find(orgId => this.membership(principal.userId, orgId)?.status === 'active'),
          userId,
        )
      return this.failure(404, 'RESOURCE_NOT_FOUND', '用户不存在')
    }
    // Manager 的写权限限于本组织成员关系；display name 与 status 是全局属性，
    // 跨组织 member 的这些字段只有 admin 能改，防止越过组织边界影响其他组织。
    if (
      principal.role === 'manager' &&
      (input.displayName !== undefined || input.status !== undefined) &&
      [...user.memberships.keys()].some(orgId => this.membership(principal.userId, orgId)?.status !== 'active')
    ) {
      const organizationId = [...user.memberships.keys()].find(
        orgId => this.membership(principal.userId, orgId)?.status === 'active',
      )
      const denialKey = `${principal.userId}|账号更新拒绝|${requestId}`
      if (!this.denialAuditRequests.has(denialKey)) {
        this.denialAuditRequests.add(denialKey)
        this.recordAudit(
          principal.userId,
          principal.displayName,
          '账号更新拒绝',
          'failed',
          'FORBIDDEN',
          requestId,
          organizationId,
          userId,
        )
      }
      return this.failure(403, 'FORBIDDEN', 'manager 不能修改属于其他组织的账号全局属性')
    }
    if (expectedRevision !== user.revision) return this.failure(409, 'REVISION_CONFLICT', '用户已更新，请刷新后重试')
    if (input.status === 'suspended' && user.userId === 'admin-1') return this.failure(422, 'VALIDATION_ERROR', '不能停用初始 admin')
    if (input.status === 'suspended' && this.hasActiveAdminMembership(user) && this.adminMembershipCount() <= 1)
      return this.failure(422, 'VALIDATION_ERROR', '不能停用平台最后一个 admin')
    if (input.displayName !== undefined && input.displayName.trim().length > 0) user.displayName = input.displayName.trim()
    if (input.status !== undefined) {
      user.status = input.status
      if (input.status === 'suspended') this.revokeUserSessions(user.userId)
    }
    user.revision += 1
    this.recordAudit(
      principal.userId,
      principal.displayName,
      input.status === 'suspended' ? '账号停用' : input.status === 'active' ? '账号恢复' : '账号更新',
      'succeeded',
      undefined,
      requestId,
      undefined,
      userId,
    )
    return { ok: true, value: this.userView(user) }
  }

  setMembership(
    principal: AccountPrincipal,
    organizationId: string,
    userId: string,
    expectedRevision: number | undefined,
    requestId: string,
  ): AccountOperationResult {
    const organization = this.organizationRecords.get(organizationId)
    const user = this.users.get(userId)
    if (organization === undefined || user === undefined) return this.failure(404, 'RESOURCE_NOT_FOUND', '组织或用户不存在')
    if (organization.status !== 'active') return this.failure(409, 'ORGANIZATION_ARCHIVED', '组织已归档，不能新增或变更成员')
    if (
      principal.role !== 'admin' &&
      (this.membership(principal.userId, organizationId)?.status !== 'active' || user.globalRole !== 'member')
    )
      return this.failure(403, 'FORBIDDEN', 'manager 只能配置本组织 member')
    const current = user.memberships.get(organizationId)
    if (current !== undefined && expectedRevision !== current.revision)
      return this.failure(409, 'REVISION_CONFLICT', '成员关系已更新，请刷新后重试')
    user.memberships.set(organizationId, { status: 'active', revision: (current?.revision ?? 0) + 1 })
    user.revision += 1
    this.recordAudit(principal.userId, principal.displayName, '组织成员变更', 'succeeded', undefined, requestId, organizationId, userId)
    return { ok: true, value: this.userView(user) }
  }

  removeMembership(
    principal: AccountPrincipal,
    organizationId: string,
    userId: string,
    expectedRevision: number | undefined,
    requestId: string,
  ): AccountOperationResult {
    const user = this.users.get(userId)
    const membership = user?.memberships.get(organizationId)
    if (user === undefined || membership === undefined) return this.failure(404, 'RESOURCE_NOT_FOUND', '成员关系不存在')
    if (
      principal.role !== 'admin' &&
      (this.membership(principal.userId, organizationId)?.status !== 'active' || user.globalRole !== 'member')
    )
      return this.failure(403, 'FORBIDDEN', 'manager 只能移除本组织 member')
    if (expectedRevision !== membership.revision) return this.failure(409, 'REVISION_CONFLICT', '成员关系已更新，请刷新后重试')
    user.memberships.delete(organizationId)
    user.revision += 1
    for (const project of this.projects.values()) if (project.organizationId === organizationId) project.members.delete(userId)
    this.recordAudit(principal.userId, principal.displayName, '组织成员移除', 'succeeded', undefined, requestId, organizationId, userId)
    return { ok: true, value: this.userView(user) }
  }

  roles(principal: AccountPrincipal): readonly Record<string, unknown>[] | AccountOperationResult {
    if (principal.role === 'member') return this.failure(403, 'FORBIDDEN', '需要管理员权限')
    return [
      { role: 'admin', scope: 'platform', description: '管理平台全部组织、账号和项目' },
      { role: 'manager', scope: 'organization', description: '管理自己组织内的账号和项目' },
      { role: 'member', scope: 'assigned', description: '使用被分配的组织、项目和资源' },
    ]
  }

  permissions(principal: AccountPrincipal): readonly Record<string, unknown>[] | AccountOperationResult {
    if (principal.role === 'member') return this.failure(403, 'FORBIDDEN', '需要管理员权限')
    return [
      { key: 'organization.read', admin: true, manager: true, member: false },
      { key: 'user.manage', admin: true, manager: 'organization', member: false },
      { key: 'project.manage', admin: true, manager: 'organization', member: false },
      { key: 'authorization_audit.read', admin: true, manager: 'organization', member: false },
    ]
  }

  listProjects(
    principal: AccountPrincipal,
    options: { readonly organizationId?: string; readonly status?: 'draft' | 'active' | 'archived'; readonly name?: string } = {},
  ): readonly ProjectView[] | AccountOperationResult {
    if (principal.role === 'member') return this.failure(403, 'FORBIDDEN', '需要管理员权限')
    const visibleOrganizationIds = this.visibleOrganizationIds(principal)
    if (options.organizationId !== undefined && visibleOrganizationIds !== undefined && !visibleOrganizationIds.has(options.organizationId))
      return this.failure(404, 'RESOURCE_NOT_FOUND', '组织不存在')
    return [...this.projects.values()]
      .filter(project => visibleOrganizationIds === undefined || visibleOrganizationIds.has(project.organizationId))
      .filter(project => this.organizationRecords.get(project.organizationId)?.status === 'active')
      .filter(project => options.organizationId === undefined || project.organizationId === options.organizationId)
      .filter(project => (options.status === undefined ? project.status !== 'archived' : project.status === options.status))
      .filter(project => options.name === undefined || project.name.toLocaleLowerCase().includes(options.name.toLocaleLowerCase()))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.projectId.localeCompare(right.projectId))
      .map(projectView)
  }

  listMemberProjects(principal: AccountPrincipal): readonly ProjectView[] {
    return [...this.projects.values()]
      .filter((project) => {
        const result = this.authorizeProject(principal, project.projectId)
        return !isFailure(result)
      })
      .map(projectView)
  }

  getProject(principal: AccountPrincipal, projectId: string): ProjectView | AccountOperationResult {
    const project = this.projects.get(projectId)
    if (
      project === undefined ||
      principal.role === 'member' ||
      this.organizationRecords.get(project.organizationId)?.status !== 'active' ||
      (principal.role !== 'admin' && this.membership(principal.userId, project.organizationId)?.status !== 'active')
    )
      return this.failure(404, 'RESOURCE_NOT_FOUND', '项目不存在')
    return projectView(project)
  }

  getProjectDetail(
    principal: AccountPrincipal,
    projectId: string,
  ): { readonly project: ProjectView; readonly assets: readonly ProjectAssetRelationView[] } | AccountOperationResult {
    const project = this.projects.get(projectId)
    if (project === undefined || project.status !== 'active' || isFailure(this.authorizeProject(principal, projectId)))
      return this.failure(404, 'PROJECT_NOT_MEMBER', '项目不存在或当前账号无权访问')
    return { project: projectView(project), assets: this.projectAssetsView(project, principal) }
  }

  /** Read the server-owned asset ids currently related to one project. */
  projectAssetIds(projectId: string, assetType: 'skill' | 'knowledge' | 'memory'): readonly string[] {
    const project = this.projects.get(projectId)
    if (project === undefined) return []
    return [...project.assets.values()].filter(relation => relation.assetType === assetType).map(relation => relation.assetId)
  }

  /** Attach a fixture-created asset to its project without bypassing the relation store. */
  registerProjectAsset(
    projectId: string,
    assetType: 'skill' | 'knowledge' | 'memory',
    assetId: string,
    relationKind: 'reference' | 'context',
  ): void {
    const project = this.projects.get(projectId)
    if (project === undefined || project.assets.has(`${assetType}:${assetId}`)) return
    const now = new Date().toISOString()
    project.assets.set(`${assetType}:${assetId}`, { assetType, assetId, relationKind, createdAt: now, updatedAt: now, revision: 1 })
    project.updatedAt = now
    project.revision += 1
  }

  /** Remove one fixture-created asset relation from its project. */
  unregisterProjectAsset(projectId: string, assetType: 'skill' | 'knowledge' | 'memory', assetId: string): void {
    const project = this.projects.get(projectId)
    if (project?.assets.delete(`${assetType}:${assetId}`) !== true) return
    project.updatedAt = new Date().toISOString()
    project.revision += 1
  }

  /** Move one asset relation between same-organization projects and record the change. */
  moveProjectAsset(
    principal: AccountPrincipal,
    assetType: 'skill' | 'knowledge' | 'memory',
    assetId: string,
    sourceProjectId: string,
    targetProjectId: string,
    requestId: string,
  ): AccountOperationResult {
    const source = this.projects.get(sourceProjectId)
    const target = this.projects.get(targetProjectId)
    const relation = source?.assets.get(`${assetType}:${assetId}`)
    if (
      source === undefined
      || target === undefined
      || relation === undefined
      || !this.canManageProject(principal, source)
      || !this.canManageProject(principal, target)
    )
      return this.failure(404, 'RESOURCE_NOT_FOUND', '资产关联不存在')
    if (source.organizationId !== target.organizationId) return this.failure(403, 'MEMORY_SCOPE_FORBIDDEN', '资产只能移动到同组织项目')
    if (source.status === 'archived' || target.status === 'archived') return this.failure(409, 'VALIDATION_ERROR', '归档项目只读')
    const now = new Date().toISOString()
    source.assets.delete(`${assetType}:${assetId}`)
    source.updatedAt = now
    source.revision += 1
    target.assets.set(`${assetType}:${assetId}`, { ...relation, updatedAt: now, revision: relation.revision + 1 })
    target.updatedAt = now
    target.revision += 1
    this.recordAudit(
      principal.userId,
      principal.displayName,
      '项目资产范围移动',
      'succeeded',
      undefined,
      requestId,
      target.organizationId,
      undefined,
      targetProjectId,
    )
    return { ok: true, value: projectView(target) }
  }

  /** Remove an asset relation from every project after its backing resource is deleted. */
  detachAssetEverywhere(assetType: 'skill' | 'knowledge' | 'memory', assetId: string): void {
    for (const project of this.projects.values()) {
      if (!project.assets.delete(`${assetType}:${assetId}`)) continue
      project.updatedAt = new Date().toISOString()
      project.revision += 1
    }
  }

  /** Register a fixture-created platform asset so project relations can reference it. */
  registerPlatformAsset(assetType: 'skill' | 'knowledge' | 'memory', assetId: string): void {
    this.platformAssets.add(`${assetType}:${assetId}`)
  }

  /** Whether the user currently holds an active membership in the organization. */
  hasActiveMembership(userId: string, organizationId: string): boolean {
    return this.membership(userId, organizationId)?.status === 'active' && this.users.get(userId)?.status === 'active'
  }

  /** Group ids of one user inside one organization; groups are organization-scoped. */
  userGroupIds(userId: string, organizationId: string): readonly string[] {
    return [...this.groups.values()]
      .filter(group => group.organizationId === organizationId && group.memberUserIds.has(userId))
      .map(group => group.groupId)
  }

  /** Whether the group id exists inside the organization. */
  isOrganizationGroup(organizationId: string, groupId: string): boolean {
    return this.groups.get(groupId)?.organizationId === organizationId
  }

  /** User ids of every active member of the organization; suspended users are excluded. */
  activeMemberUserIds(organizationId: string): readonly string[] {
    return [...this.users.values()]
      .filter(user => user.status === 'active' && user.memberships.get(organizationId)?.status === 'active')
      .map(user => user.userId)
  }

  /** Resolve the authoring organization for a new platform Skill.
   * @param principal - Caller requesting the authoring organization.
   * @param requestedOrganizationId - Optional explicit organization; must be an active membership.
   * @returns The resolved organization id or a validation failure when ambiguous or unauthorized.
   */
  authoringOrganization(principal: AccountPrincipal, requestedOrganizationId?: string): string | AccountStoreFailure {
    const activeOrganizationIds = [...this.organizationRecords.keys()].filter(organizationId =>
      this.hasActiveMembership(principal.userId, organizationId),
    )
    if (requestedOrganizationId !== undefined) {
      if (!activeOrganizationIds.includes(requestedOrganizationId))
        return this.failure(422, 'VALIDATION_ERROR', '组织不存在或当前账号不是其 active 成员')
      return requestedOrganizationId
    }
    const [only] = activeOrganizationIds
    if (activeOrganizationIds.length !== 1 || only === undefined)
      return this.failure(422, 'VALIDATION_ERROR', '账号属于多个组织，创建 Skill 必须显式指定 organization_id')
    return only
  }

  /** Serve the governance people directory from the account store, one entry per active membership.
   * @param principal - Caller; managers are limited to their active organizations.
   * @param organizationId - Optional organization filter; must be visible to the caller.
   * @param query - Case-insensitive substring filter on display name, email and groups.
   */
  organizationDirectory(
    principal: AccountPrincipal,
    organizationId: string | undefined,
    query: string,
  ): readonly DirectoryUserView[] | AccountStoreFailure {
    if (principal.role === 'member') return this.failure(403, 'FORBIDDEN', '需要管理员权限')
    const visibleOrganizationIds = this.visibleOrganizationIds(principal)
    if (organizationId !== undefined && visibleOrganizationIds !== undefined && !visibleOrganizationIds.has(organizationId))
      return this.failure(404, 'RESOURCE_NOT_FOUND', '组织不存在')
    const normalized = query.trim().toLocaleLowerCase()
    return [...this.users.values()]
      .filter(user => user.status === 'active')
      .flatMap((user) => {
        const organizationIds = [...user.memberships.entries()]
          .filter(([id, membership]) => membership.status === 'active' && this.organizationRecords.get(id)?.status === 'active')
          .filter(([id]) => organizationId === undefined || id === organizationId)
          .filter(([id]) => visibleOrganizationIds === undefined || visibleOrganizationIds.has(id))
          .map(([id]) => id)
        return organizationIds.map((id) => {
          const groups = this.userGroupIds(user.userId, id)
          return {
            user_id: user.userId,
            display_name: user.displayName,
            email: user.email,
            organization_id: id,
            groups,
          }
        })
      })
      .filter(
        user =>
          normalized.length === 0 ||
          `${user.display_name}${user.email}${user.groups.join('')}`.toLocaleLowerCase().includes(normalized),
      )
  }

  /** Owning organization id of one project, or undefined when the project does not exist. */
  organizationIdOfProject(projectId: string): string | undefined {
    return this.projects.get(projectId)?.organizationId
  }

  /** Project ids currently related to one platform asset. */
  projectIdsForAsset(assetType: 'skill' | 'knowledge' | 'memory', assetId: string): readonly string[] {
    return [...this.projects.values()]
      .filter(project => project.assets.has(`${assetType}:${assetId}`))
      .map(project => project.projectId)
  }

  createProject(principal: AccountPrincipal, input: CreateProjectInput, requestId: string): AccountOperationResult {
    const organization = this.organizationRecords.get(input.organizationId)
    if (organization === undefined || organization.status !== 'active') return this.failure(404, 'RESOURCE_NOT_FOUND', '组织不存在')
    if (!this.canManageOrganization(principal, input.organizationId)) return this.failure(403, 'FORBIDDEN', '无权管理该组织项目')
    const name = normalizeProjectName(input.name)
    if (name === undefined) return this.failure(422, 'VALIDATION_ERROR', '项目名称必须为 1-80 个字符且不能包含路径分隔符')
    const description = input.description?.trim() ?? ''
    if (description.length > 2000) return this.failure(422, 'VALIDATION_ERROR', '项目描述不能超过 2000 个字符')
    if (
      [...this.projects.values()].some(
        project => project.organizationId === input.organizationId && project.name.toLocaleLowerCase() === name.toLocaleLowerCase(),
      )
    )
      return this.failure(422, 'VALIDATION_ERROR', '项目名称已存在')
    const projectId = `project-${randomUUID().slice(0, 8)}`
    const now = new Date().toISOString()
    const project: ProjectRecord = {
      projectId,
      organizationId: input.organizationId,
      organizationName: organization.name,
      name,
      description,
      createdBy: principal.userId,
      createdAt: now,
      updatedAt: now,
      status: 'draft',
      revision: 1,
      members: new Map(),
      assets: new Map(),
    }
    this.projects.set(projectId, project)
    this.recordAudit(
      principal.userId,
      principal.displayName,
      '项目创建',
      'succeeded',
      undefined,
      requestId,
      input.organizationId,
      undefined,
      projectId,
    )
    return { ok: true, value: projectView(project) }
  }

  updateProject(
    principal: AccountPrincipal,
    projectId: string,
    input: UpdateProjectInput,
    expectedRevision: number | undefined,
    requestId: string,
  ): AccountOperationResult {
    const project = this.projects.get(projectId)
    if (project === undefined || !this.canManageProject(principal, project)) return this.failure(404, 'RESOURCE_NOT_FOUND', '项目不存在')
    if (project.status === 'archived') return this.failure(409, 'VALIDATION_ERROR', '归档项目只读')
    if (expectedRevision !== project.revision) return this.failure(409, 'REVISION_CONFLICT', '项目已更新，请刷新后重试')
    if (input.name !== undefined) {
      const name = normalizeProjectName(input.name)
      if (name === undefined) return this.failure(422, 'VALIDATION_ERROR', '项目名称必须为 1-80 个字符且不能包含路径分隔符')
      if (
        [...this.projects.values()].some(
          candidate =>
            candidate.projectId !== projectId &&
            candidate.organizationId === project.organizationId &&
            candidate.name.toLocaleLowerCase() === name.toLocaleLowerCase(),
        )
      )
        return this.failure(422, 'VALIDATION_ERROR', '项目名称已存在')
      project.name = name
    }
    if (input.description !== undefined) {
      const description = input.description.trim()
      if (description.length > 2000) return this.failure(422, 'VALIDATION_ERROR', '项目描述不能超过 2000 个字符')
      project.description = description
    }
    project.updatedAt = new Date().toISOString()
    project.revision += 1
    this.recordAudit(
      principal.userId,
      principal.displayName,
      '项目编辑',
      'succeeded',
      undefined,
      requestId,
      project.organizationId,
      undefined,
      projectId,
    )
    return { ok: true, value: projectView(project) }
  }

  activateProject(
    principal: AccountPrincipal,
    projectId: string,
    expectedRevision: number | undefined,
    requestId: string,
  ): AccountOperationResult {
    return this.transitionProject(principal, projectId, 'draft', 'active', expectedRevision, requestId, '项目激活')
  }
  archiveProject(
    principal: AccountPrincipal,
    projectId: string,
    expectedRevision: number | undefined,
    requestId: string,
  ): AccountOperationResult {
    return this.transitionProject(principal, projectId, 'active', 'archived', expectedRevision, requestId, '项目归档')
  }

  listProjectMembers(principal: AccountPrincipal, projectId: string): readonly ProjectMemberView[] | AccountOperationResult {
    const project = this.projects.get(projectId)
    if (project === undefined || !this.canManageProject(principal, project)) return this.failure(404, 'RESOURCE_NOT_FOUND', '项目不存在')
    return [...project.members.entries()].flatMap(([userId, membership]) => {
      const user = this.users.get(userId)
      return user === undefined
        ? []
        : [
          {
            project_id: project.projectId,
            organization_id: project.organizationId,
            user_id: userId,
            display_name: user.displayName,
            status: membership.status,
            joined_at: membership.createdAt,
            updated_at: membership.updatedAt,
            revision: membership.revision,
          },
        ]
    })
  }

  setProjectMember(
    principal: AccountPrincipal,
    projectId: string,
    userId: string,
    expectedRevision: number | undefined,
    requestId: string,
  ): AccountOperationResult {
    const project = this.projects.get(projectId)
    const user = this.users.get(userId)
    if (project === undefined || user === undefined || !this.canManageProject(principal, project))
      return this.failure(404, 'RESOURCE_NOT_FOUND', '项目或用户不存在')
    const organization = this.organizationRecords.get(project.organizationId)
    if (organization?.status !== 'active') return this.failure(409, 'ORGANIZATION_ARCHIVED', '组织已归档，不能变更项目成员')
    if (project.status === 'archived') return this.failure(409, 'VALIDATION_ERROR', '归档项目只读')
    if (user.status !== 'active') return this.failure(422, 'ACCOUNT_SUSPENDED', '账号已停用，不能授权项目成员')
    if (this.membership(userId, project.organizationId)?.status !== 'active' || user.globalRole !== 'member')
      return this.failure(422, 'VALIDATION_ERROR', '只能授权本组织 active member')
    const current = project.members.get(userId)
    if (expectedRevision !== (current?.revision ?? project.revision))
      return this.failure(409, 'REVISION_CONFLICT', '项目成员关系或项目已更新，请刷新后重试')
    const now = new Date().toISOString()
    project.members.set(userId, {
      status: 'active',
      createdAt: current?.createdAt ?? now,
      updatedAt: now,
      revision: (current?.revision ?? 0) + 1,
    })
    project.updatedAt = now
    project.revision += 1
    this.recordAudit(
      principal.userId,
      principal.displayName,
      current?.status === 'removed' ? '项目成员恢复' : '项目成员添加',
      'succeeded',
      undefined,
      requestId,
      project.organizationId,
      userId,
      projectId,
    )
    return { ok: true, value: projectView(project) }
  }

  removeProjectMember(
    principal: AccountPrincipal,
    projectId: string,
    userId: string,
    expectedRevision: number | undefined,
    requestId: string,
  ): AccountOperationResult {
    const project = this.projects.get(projectId)
    const current = project?.members.get(userId)
    if (project === undefined || !this.canManageProject(principal, project) || current === undefined)
      return this.failure(404, 'RESOURCE_NOT_FOUND', '项目成员关系不存在')
    if (project.status === 'archived') return this.failure(409, 'VALIDATION_ERROR', '归档项目只读')
    if (expectedRevision !== current.revision) return this.failure(409, 'REVISION_CONFLICT', '项目成员关系已更新，请刷新后重试')
    const now = new Date().toISOString()
    project.members.set(userId, { ...current, status: 'removed', updatedAt: now, revision: current.revision + 1 })
    project.updatedAt = now
    project.revision += 1
    this.recordAudit(
      principal.userId,
      principal.displayName,
      '项目成员移除',
      'succeeded',
      undefined,
      requestId,
      project.organizationId,
      userId,
      projectId,
    )
    return { ok: true, value: projectView(project) }
  }

  listProjectAssets(principal: AccountPrincipal, projectId: string): readonly ProjectAssetRelationView[] | AccountOperationResult {
    const project = this.projects.get(projectId)
    if (project === undefined || !this.canManageProject(principal, project)) return this.failure(404, 'RESOURCE_NOT_FOUND', '项目不存在')
    return this.projectAssetsView(project, principal)
  }

  addProjectAsset(
    principal: AccountPrincipal,
    projectId: string,
    assetType: 'skill' | 'knowledge' | 'memory',
    assetId: string,
    relationKind: 'reference' | 'context',
    expectedRevision: number | undefined,
    requestId: string,
  ): AccountOperationResult {
    const project = this.projects.get(projectId)
    if (project === undefined || !this.canManageProject(principal, project)) return this.failure(404, 'RESOURCE_NOT_FOUND', '项目不存在')
    if (project.status === 'archived') return this.failure(409, 'VALIDATION_ERROR', '归档项目只读')
    if (!this.assetCanBeManaged(project, principal, assetType, assetId))
      return this.failure(422, 'VALIDATION_ERROR', '资产不存在或当前操作者无权关联')
    const key = `${assetType}:${assetId}`
    if (project.assets.has(key)) return this.failure(409, 'VALIDATION_ERROR', '资产已关联')
    if (expectedRevision !== project.revision) return this.failure(409, 'REVISION_CONFLICT', '项目已更新，请刷新后重试')
    const now = new Date().toISOString()
    project.assets.set(key, { assetType, assetId, relationKind, createdAt: now, updatedAt: now, revision: 1 })
    project.updatedAt = now
    project.revision += 1
    this.recordAudit(
      principal.userId,
      principal.displayName,
      '项目资产关联添加',
      'succeeded',
      undefined,
      requestId,
      project.organizationId,
      undefined,
      projectId,
    )
    const asset = this.projectAssetsView(project, principal).find(item => item.asset_type === assetType && item.asset_id === assetId)
    if (asset === undefined) return this.failure(500, 'INTERNAL_ERROR', '资产关联已创建但无法读取')
    return { ok: true, value: asset }
  }

  updateProjectAsset(
    principal: AccountPrincipal,
    projectId: string,
    assetType: 'skill' | 'knowledge' | 'memory',
    assetId: string,
    relationKind: 'reference' | 'context',
    expectedRevision: number | undefined,
    requestId: string,
  ): AccountOperationResult {
    const project = this.projects.get(projectId)
    const relation = project?.assets.get(`${assetType}:${assetId}`)
    if (project === undefined || relation === undefined || !this.canManageProject(principal, project))
      return this.failure(404, 'RESOURCE_NOT_FOUND', '资产关联不存在')
    if (project.status === 'archived') return this.failure(409, 'VALIDATION_ERROR', '归档项目只读')
    if (expectedRevision !== relation.revision) return this.failure(409, 'REVISION_CONFLICT', '资产关联已更新，请刷新后重试')
    relation.relationKind = relationKind
    relation.updatedAt = new Date().toISOString()
    relation.revision += 1
    this.recordAudit(
      principal.userId,
      principal.displayName,
      '项目资产关联编辑',
      'succeeded',
      undefined,
      requestId,
      project.organizationId,
      undefined,
      projectId,
    )
    const asset = this.projectAssetsView(project, principal).find(item => item.asset_type === assetType && item.asset_id === assetId)
    if (asset === undefined) return this.failure(500, 'INTERNAL_ERROR', '资产关联已更新但无法读取')
    return { ok: true, value: asset }
  }

  removeProjectAsset(
    principal: AccountPrincipal,
    projectId: string,
    assetType: 'skill' | 'knowledge' | 'memory',
    assetId: string,
    expectedRevision: number | undefined,
    requestId: string,
  ): AccountOperationResult {
    const project = this.projects.get(projectId)
    const relation = project?.assets.get(`${assetType}:${assetId}`)
    if (project === undefined || relation === undefined || !this.canManageProject(principal, project))
      return this.failure(404, 'RESOURCE_NOT_FOUND', '资产关联不存在')
    if (project.status === 'archived') return this.failure(409, 'VALIDATION_ERROR', '归档项目只读')
    if (expectedRevision !== relation.revision) return this.failure(409, 'REVISION_CONFLICT', '资产关联已更新，请刷新后重试')
    project.assets.delete(`${assetType}:${assetId}`)
    project.updatedAt = new Date().toISOString()
    project.revision += 1
    this.recordAudit(
      principal.userId,
      principal.displayName,
      '项目资产关联移除',
      'succeeded',
      undefined,
      requestId,
      project.organizationId,
      undefined,
      projectId,
    )
    return { ok: true, value: projectView(project) }
  }

  listAudits(
    principal: AccountPrincipal,
    organizationId: string | undefined,
    action: string | undefined,
    projectId: string | undefined,
  ): readonly AuthorizationAudit[] | AccountOperationResult {
    if (principal.role === 'member') return this.failure(403, 'FORBIDDEN', '需要管理员权限')
    const visible = this.visibleOrganizationIds(principal)
    if (organizationId !== undefined && visible !== undefined && !visible.has(organizationId))
      return this.failure(404, 'RESOURCE_NOT_FOUND', '组织不存在')
    if (projectId !== undefined) {
      const project = this.projects.get(projectId)
      if (project === undefined || !this.canManageProject(principal, project)) return this.failure(404, 'RESOURCE_NOT_FOUND', '项目不存在')
    }
    return this.audits.filter(
      item =>
        (visible === undefined || (item.organization_id !== undefined && visible.has(item.organization_id))) &&
        (organizationId === undefined || item.organization_id === organizationId) &&
        (action === undefined || item.action === action) &&
        (projectId === undefined || item.project_id === projectId),
    )
  }

  private transitionProject(
    principal: AccountPrincipal,
    projectId: string,
    from: ProjectRecord['status'],
    to: ProjectRecord['status'],
    expectedRevision: number | undefined,
    requestId: string,
    action: string,
  ): AccountOperationResult {
    const project = this.projects.get(projectId)
    if (project === undefined || !this.canManageProject(principal, project)) return this.failure(404, 'RESOURCE_NOT_FOUND', '项目不存在')
    if (project.status !== from) return this.failure(422, 'VALIDATION_ERROR', `项目只能从 ${from} 转为 ${to}`)
    if (expectedRevision !== project.revision) return this.failure(409, 'REVISION_CONFLICT', '项目已更新，请刷新后重试')
    project.status = to
    project.updatedAt = new Date().toISOString()
    project.revision += 1
    this.recordAudit(
      principal.userId,
      principal.displayName,
      action,
      'succeeded',
      undefined,
      requestId,
      project.organizationId,
      undefined,
      projectId,
    )
    return { ok: true, value: projectView(project) }
  }

  private canManageOrganization(principal: AccountPrincipal, organizationId: string): boolean {
    return (
      principal.role === 'admin' || (principal.role === 'manager' && this.membership(principal.userId, organizationId)?.status === 'active')
    )
  }

  private projectAssetsView(project: ProjectRecord, principal: AccountPrincipal): readonly ProjectAssetRelationView[] {
    return [...project.assets.values()]
      .filter(
        relation => this.canManageProject(principal, project)
          || this.assetIsVisible(project, principal, relation.assetType, relation.assetId),
      )
      .map(relation => ({
        project_id: project.projectId,
        asset_type: relation.assetType,
        asset_id: relation.assetId,
        name: relation.assetId,
        relation_kind: relation.relationKind,
        created_at: relation.createdAt,
        updated_at: relation.updatedAt,
        revision: relation.revision,
      }))
  }

  private assetCanBeManaged(
    project: ProjectRecord,
    principal: AccountPrincipal,
    assetType: 'skill' | 'knowledge' | 'memory',
    assetId: string,
  ): boolean {
    if (!this.canManageProject(principal, project)) return false
    return (
      this.platformAssets.has(`${assetType}:${assetId}`) ||
      [...this.projects.values()].some(project => project.assets.has(`${assetType}:${assetId}`))
    )
  }

  private assetIsVisible(
    project: ProjectRecord,
    principal: AccountPrincipal,
    assetType: 'skill' | 'knowledge' | 'memory',
    assetId: string,
  ): boolean {
    const authorized = this.authorizeProject(principal, project.projectId)
    if (isFailure(authorized)) return false
    return this.projects.get(project.projectId)?.assets.has(`${assetType}:${assetId}`) === true
  }

  private seed(): void {
    this.organizationRecords.set('org-alpha', { organizationId: 'org-alpha', name: '星河 AI 平台', status: 'active', revision: 1 })
    this.organizationRecords.set('org-beta', { organizationId: 'org-beta', name: '星河数据平台', status: 'active', revision: 1 })
    const now = new Date().toISOString()
    this.projects.set('project-alpha', {
      projectId: 'project-alpha',
      organizationId: 'org-alpha',
      organizationName: '星河 AI 平台',
      name: '协作台前端',
      description: '第一方 AI Coding 协作项目',
      createdBy: 'admin-1',
      createdAt: now,
      updatedAt: now,
      status: 'active',
      revision: 1,
      members: new Map([['member-1', { status: 'active', createdAt: now, updatedAt: now, revision: 1 }]]),
      assets: new Map([
        [
          'skill:code-review',
          { assetType: 'skill', assetId: 'code-review', relationKind: 'reference', createdAt: now, updatedAt: now, revision: 1 },
        ],
        ['knowledge:k-1', { assetType: 'knowledge', assetId: 'k-1', relationKind: 'context', createdAt: now, updatedAt: now, revision: 1 }],
        [
          'knowledge:k-3',
          { assetType: 'knowledge', assetId: 'k-3', relationKind: 'reference', createdAt: now, updatedAt: now, revision: 1 },
        ],
        ['memory:m-1', { assetType: 'memory', assetId: 'm-1', relationKind: 'context', createdAt: now, updatedAt: now, revision: 1 }],
        ['memory:m-2', { assetType: 'memory', assetId: 'm-2', relationKind: 'reference', createdAt: now, updatedAt: now, revision: 1 }],
      ]),
    })
    this.projects.set('project-beta', {
      projectId: 'project-beta',
      organizationId: 'org-beta',
      organizationName: '星河数据平台',
      name: '数据服务',
      description: '数据服务协作项目',
      createdBy: 'admin-1',
      createdAt: now,
      updatedAt: now,
      status: 'active',
      revision: 1,
      members: new Map(),
      assets: new Map([
        [
          'knowledge:k-2',
          { assetType: 'knowledge', assetId: 'k-2', relationKind: 'reference', createdAt: now, updatedAt: now, revision: 1 },
        ],
        ['knowledge:k-4', { assetType: 'knowledge', assetId: 'k-4', relationKind: 'context', createdAt: now, updatedAt: now, revision: 1 }],
        ['memory:m-3', { assetType: 'memory', assetId: 'm-3', relationKind: 'reference', createdAt: now, updatedAt: now, revision: 1 }],
        ['memory:m-4', { assetType: 'memory', assetId: 'm-4', relationKind: 'context', createdAt: now, updatedAt: now, revision: 1 }],
      ]),
    })
    this.users.set('admin-1', {
      userId: 'admin-1',
      username: 'admin@example.com',
      email: 'admin@example.com',
      displayName: '平台管理员',
      status: 'active',
      globalRole: 'admin',
      password: 'admin-pass',
      mustChangePassword: false,
      revision: 1,
      memberships: new Map([
        ['org-alpha', { status: 'active', revision: 1 }],
        ['org-beta', { status: 'active', revision: 1 }],
      ]),
    })
    this.users.set('manager-1', {
      userId: 'manager-1',
      username: 'manager@example.com',
      email: 'manager@example.com',
      displayName: '组织经理',
      status: 'active',
      globalRole: 'manager',
      password: 'manager-pass',
      mustChangePassword: false,
      revision: 1,
      memberships: new Map([['org-alpha', { status: 'active', revision: 1 }]]),
    })
    this.users.set('member-1', {
      userId: 'member-1',
      username: 'member@example.com',
      email: 'member@example.com',
      displayName: '演示成员',
      status: 'active',
      globalRole: 'member',
      password: 'member-pass',
      mustChangePassword: false,
      revision: 1,
      memberships: new Map([['org-alpha', { status: 'active', revision: 1 }]]),
    })
    this.groups.set('platform', {
      groupId: 'platform',
      organizationId: 'org-alpha',
      name: '平台工程组',
      memberUserIds: new Set(['admin-1', 'manager-1', 'member-1']),
      revision: 1,
    })
    this.groups.set('data-platform', {
      groupId: 'data-platform',
      organizationId: 'org-beta',
      name: '数据平台组',
      memberUserIds: new Set(['admin-1']),
      revision: 1,
    })
    // 无任何组织成员关系的账号：用于证明组织级授权边界（如用户侧 schema 403）。
    this.users.set('outsider-1', {
      userId: 'outsider-1',
      username: 'outsider@example.com',
      email: 'outsider@example.com',
      displayName: '外部账号',
      status: 'active',
      globalRole: 'member',
      password: 'outsider-pass',
      mustChangePassword: false,
      revision: 1,
      memberships: new Map(),
    })
    this.addStaticSession('admin-demo', 'admin-refresh', 'admin-1')
    this.addStaticSession('manager-demo', 'manager-refresh', 'manager-1')
    this.addStaticSession('demo-token', 'member-refresh', 'member-1')
    this.addStaticSession('outsider-token', 'outsider-refresh', 'outsider-1')
  }

  private addStaticSession(accessToken: string, refreshToken: string, userId: string): void {
    this.sessions.set(accessToken, { accessToken, refreshToken, userId, expiresAt: Number.MAX_SAFE_INTEGER, revoked: false })
  }

  private createSession(userId: string): SessionTokens {
    const accessToken = `access-${randomUUID()}`
    const refreshToken = `refresh-${randomUUID()}`
    const expiresIn = 900
    this.sessions.set(accessToken, { accessToken, refreshToken, userId, expiresAt: Date.now() + expiresIn * 1000, revoked: false })
    return { access_token: accessToken, refresh_token: refreshToken, expires_in: expiresIn }
  }

  private revokeUserSessions(userId: string): void {
    for (const session of this.sessions.values()) if (session.userId === userId) session.revoked = true
  }

  private globalRole(user: UserRecord): AccountRole {
    return user.globalRole
  }

  private membershipsView(user: UserRecord, visibleOrganizationIds?: ReadonlySet<string>): readonly MembershipView[] {
    return [...user.memberships.entries()].flatMap(([organizationId, membership]) => {
      const organization = this.organizationRecords.get(organizationId)
      return organization === undefined || (visibleOrganizationIds !== undefined && !visibleOrganizationIds.has(organizationId))
        ? []
        : [
          {
            organization_id: organizationId,
            organization_name: organization.name,
            status: membership.status,
            revision: membership.revision,
          },
        ]
    })
  }

  private userView = (user: UserRecord): AccountUserView => ({
    user_id: user.userId,
    username: user.username,
    email: user.email,
    display_name: user.displayName,
    status: user.status,
    global_role: user.globalRole,
    must_change_password: user.mustChangePassword,
    revision: user.revision,
  })

  private adminUserView = (user: UserRecord, visibleOrganizationIds?: ReadonlySet<string>): AccountUserView => ({
    ...this.userView(user),
    memberships: this.membershipsView(user, visibleOrganizationIds),
  })

  private membership(userId: string, organizationId: string): MembershipRecord | undefined {
    return this.users.get(userId)?.memberships.get(organizationId)
  }

  private visibleOrganizationIds(principal: AccountPrincipal): ReadonlySet<string> | undefined {
    if (principal.role === 'admin') return undefined
    const user = this.users.get(principal.userId)
    return new Set(
      user === undefined
        ? []
        : [...user.memberships.entries()]
          .filter(([, membership]) => membership.status === 'active')
          .map(([organizationId]) => organizationId),
    )
  }

  private auditOrganizationId(user: UserRecord): string | undefined {
    const organizationIds = [...user.memberships.keys()]
    return organizationIds.length === 1 ? organizationIds[0] : undefined
  }

  private adminMembershipCount(): number {
    return [...this.users.values()].filter(user => user.globalRole === 'admin' && user.status === 'active').length
  }

  private hasActiveAdminMembership(user: UserRecord): boolean {
    return user.globalRole === 'admin' && user.status === 'active'
  }

  private canManageUser(principal: AccountPrincipal, user: UserRecord): boolean {
    return (
      principal.role === 'admin' ||
      (principal.role === 'manager' &&
        user.globalRole === 'member' &&
        [...user.memberships.keys()].some(organizationId => this.membership(principal.userId, organizationId)?.status === 'active'))
    )
  }

  private canManageProject(principal: AccountPrincipal, project: ProjectRecord): boolean {
    return (
      principal.role === 'admin' ||
      (principal.role === 'manager' && this.membership(principal.userId, project.organizationId)?.status === 'active')
    )
  }

  private recordAudit(
    actorUserId: string,
    actorName: string,
    action: string,
    result: AuthorizationAudit['result'],
    errorCode: string | undefined,
    requestId: string,
    organizationId?: string,
    targetUserId?: string,
    projectId?: string,
  ): void {
    this.audits.push({
      id: randomUUID(),
      occurred_at: new Date().toISOString(),
      actor_user_id: actorUserId,
      actor_name: actorName,
      ...(organizationId === undefined ? {} : { organization_id: organizationId }),
      ...(targetUserId === undefined ? {} : { target_user_id: targetUserId }),
      ...(projectId === undefined ? {} : { project_id: projectId }),
      action,
      result,
      ...(errorCode === undefined ? {} : { error_code: errorCode }),
      request_id: requestId,
    })
  }

  private failure(status: number, code: string, message: string): Extract<AccountOperationResult, { readonly ok: false }> {
    return { ok: false, status, code, message }
  }
}

function organizationView(organization: OrganizationRecord): OrganizationView {
  return {
    organization_id: organization.organizationId,
    name: organization.name,
    status: organization.status,
    revision: organization.revision,
  }
}
function projectView(project: ProjectRecord): ProjectView {
  return {
    project_id: project.projectId,
    organization_id: project.organizationId,
    organization_name: project.organizationName,
    name: project.name,
    description: project.description,
    status: project.status,
    created_by: project.createdBy,
    created_at: project.createdAt,
    updated_at: project.updatedAt,
    revision: project.revision,
    member_count: [...project.members.values()].filter(member => member.status === 'active').length,
    asset_count: project.assets.size,
  }
}
function normalizeProjectName(value: string): string | undefined {
  const name = value.trim()
  return name.length >= 1 && name.length <= 80 && !/[\u0000-\u001f\\/]/u.test(name) ? name : undefined
}
function isFailure(value: unknown): value is Extract<AccountOperationResult, { readonly ok: false }> {
  return typeof value === 'object' && value !== null && 'ok' in value && (value as { readonly ok?: unknown }).ok === false
}
