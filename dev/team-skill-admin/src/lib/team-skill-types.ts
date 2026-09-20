type SkillStatus = 'draft' | 'pending_review' | 'approved' | 'published' | 'withdrawn'

export interface TeamSkill {
  readonly skillId: string
  /** Owning organization the Skill was authored under. */
  readonly organizationId?: string
  readonly displayName: string
  readonly summary: string
  readonly runtimeName: string
  readonly category: string
  readonly tags: readonly string[]
  readonly currentVersion?: string
  /** Most recent version, including an approved draft awaiting publication. */
  readonly latestVersion?: string
  /** Revision of the latest version, used with `If-Match` for governance writes. */
  readonly latestVersionRevision?: number
  /** Published versions available as rollback targets. */
  readonly publishedVersions?: readonly string[]
  readonly status: SkillStatus
  readonly visibility: 'organization' | 'group' | 'people'
  readonly groupId?: string
  readonly peopleIds?: readonly string[]
  /** Server-authoritative project asset bindings; a published Skill without bindings is not discoverable in any project. */
  readonly projectIds?: readonly string[]
  readonly revision: number
  readonly authorName?: string
  readonly publishedAt?: string
}

export interface DirectoryUser {
  readonly userId: string
  readonly displayName: string
  readonly email: string
  readonly groups: readonly string[]
}

export interface SkillVersion {
  readonly skillId: string
  readonly version: string
  readonly status: SkillStatus
  readonly releaseNotes: string
  readonly artifactSha256?: string
  readonly artifactSizeBytes?: number
  readonly dependencies: readonly string[]
  readonly permissions: readonly string[]
  readonly validation: readonly { readonly name: string; readonly status: 'passed' | 'failed'; readonly detail?: string }[]
  readonly revision: number
  readonly publishedAt?: string
  readonly withdrawnReason?: string
}

export interface AuditLogEntry {
  readonly id: string
  readonly occurredAt: string
  readonly actor_name: string
  readonly action: string
  readonly skillName: string
  readonly version: string
  readonly scope?: 'project' | 'global'
  readonly result: 'succeeded' | 'failed' | 'cancelled'
  readonly requestId: string
}

export interface ReviewItem {
  readonly skill: TeamSkill
  readonly version: SkillVersion
  readonly reviewChecks: readonly { readonly id: string; readonly label: string; readonly decision?: 'pass' | 'fail' | 'na' }[]
}

export type AccountRole = 'admin' | 'manager' | 'member'
type AccountStatus = 'active' | 'suspended'

export interface AdminOrganization {
  readonly organization_id: string
  readonly name: string
  readonly status: 'active' | 'archived'
  readonly revision: number
}

export interface AdminUser {
  readonly user_id: string
  readonly username: string
  readonly email: string
  readonly display_name: string
  readonly status: AccountStatus
  readonly global_role: AccountRole
  readonly must_change_password: boolean
  readonly revision: number
  readonly memberships?: readonly {
    readonly organization_id: string
    readonly organization_name: string
    readonly status: AccountStatus
    readonly revision: number
  }[]
}

export interface AdminProject {
  readonly project_id: string
  readonly organization_id: string
  readonly organization_name?: string
  readonly name: string
  readonly description?: string
  readonly status: 'draft' | 'active' | 'archived'
  readonly created_by?: string
  readonly created_at?: string
  readonly updated_at?: string
  readonly member_count?: number
  readonly asset_count?: number
  readonly revision: number
}

export interface AdminProjectMember {
  readonly project_id: string
  readonly organization_id: string
  readonly user_id: string
  readonly display_name: string
  readonly status: 'active' | 'removed'
  readonly joined_at?: string
  readonly updated_at?: string
  readonly revision: number
}

export interface AdminProjectAsset {
  readonly project_id: string
  readonly asset_type: 'skill' | 'knowledge' | 'memory'
  readonly asset_id: string
  readonly name: string
  readonly relation_kind: 'reference' | 'context'
  readonly created_at?: string
  readonly updated_at?: string
  readonly revision: number
}

export interface RoleDefinition {
  readonly role: AccountRole
  readonly scope: string
  readonly description: string
}

export interface PermissionDefinition {
  readonly key: string
  readonly admin: boolean
  readonly manager: boolean | 'organization'
  readonly member: boolean
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

type AdminKnowledgeBaseType = 'document' | 'faq' | 'wiki'
type AdminKnowledgeBaseState = 'active' | 'unavailable' | 'deleting'

export interface AdminKnowledgeBase {
  readonly knowledge_base_id: string
  readonly organization_id: string
  readonly name: string
  readonly description: string
  readonly type: AdminKnowledgeBaseType
  readonly state: AdminKnowledgeBaseState
  readonly searchable: boolean
  readonly updated_at: string
  readonly revision: number
  readonly document_count?: number
}

export interface AdminKnowledgeDocument {
  readonly document_id: string
  readonly title: string
  readonly source: string
  readonly status: 'pending' | 'processing' | 'completed' | 'failed'
  readonly snippet?: string
}

export interface AdminKnowledgeOperation {
  readonly operation_id: string
  readonly operation_type?: string
  readonly status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'
  readonly document_id?: string
  readonly knowledge_base?: AdminKnowledgeBase
}

export interface AdminKnowledgeDeleteImpact {
  readonly knowledge_base_id: string
  readonly revision: number
  readonly affected_projects: readonly {
    readonly project_id: string
    readonly name: string
    readonly status: 'draft' | 'active' | 'archived'
  }[]
}

export interface AdminKnowledgeGraph {
  readonly nodes: readonly Record<string, unknown>[]
  readonly relations: readonly Record<string, unknown>[]
}

export interface AdminMemoryRecord {
  readonly memory_id: string
  readonly team_id: string
  readonly project_id: string
  readonly content: string
  readonly layer: 'L1'
  readonly captured_by_user_id: string
  readonly created_at: string
  readonly updated_at: string
  readonly revision: number
  readonly status: 'ACTIVE' | 'DELETED'
  readonly importance: number
  readonly recall_count: number
  readonly last_recalled_at: string | null
  readonly source_kind: 'agent_turn'
}

export interface AdminMemoryList {
  readonly items: readonly AdminMemoryRecord[]
  readonly next_cursor: string | null
  readonly total_estimate: number
}

export interface AdminMemoryMutation {
  readonly memory?: AdminMemoryRecord
  readonly event_id: string
  readonly job_id: string
  readonly status: 'PENDING' | 'INDEX_PENDING'
  readonly accepted_count?: number
  readonly cleanup_status?: 'PENDING' | 'FAILED'
}

export interface AdminMemoryJobList {
  readonly items: readonly AdminMemoryJob[]
  readonly next_cursor: string | null
}

export interface AdminMemoryAuditList {
  readonly items: readonly AdminMemoryAudit[]
  readonly next_cursor: string | null
}

export interface AdminMemoryPolicy {
  readonly scope_type: 'project'
  readonly scope_id: string
  readonly revision: number
  readonly values: { readonly top_k: number; readonly relevance_threshold: number; readonly token_budget: number }
  readonly inherited_from: 'organization' | null
}

export interface AdminMemoryJob {
  readonly job_id: string
  readonly event_id: string
  readonly kind: 'CAPTURE' | 'INDEX_REFRESH' | 'DELETE_CLEANUP' | 'PROJECT_PROVISION' | 'POLICY_UPDATE' | 'PROJECT_PURGE'
  readonly team_id: string
  readonly project_id: string
  readonly requested_by_user_id: string
  readonly status: 'PENDING' | 'SUCCEEDED' | 'FAILED'
  readonly retryable: boolean
  readonly retry_count: number
  readonly created_at: string
  readonly finished_at: string | null
  readonly error_code: string | null
  readonly revision: number
}

export interface AdminMemoryAudit {
  readonly audit_id: string
  readonly operation: string
  /** 审计字段契约（API 需求 §7.3）：字面 actor_name，与授权/Skill/Workspace 审计一致。 */
  readonly actor_name: string
  readonly operated_by_user_id: string
  readonly role: AccountRole
  readonly memory_id: string | null
  readonly project_id: string
  readonly result: string
  readonly event_id: string
}

export interface TelemetryTokenUsage {
  readonly input_tokens: number | null
  readonly output_tokens: number | null
  readonly total_tokens: number | null
}

export interface TelemetryErrorDetail {
  readonly name: string
  readonly code: string | null
  readonly summary: string | null
}

export interface TelemetryApprovalDetail {
  readonly decision: 'allowed_once' | 'rejected' | 'cancelled' | 'unavailable' | null
}

export interface TelemetryCompactionDetail {
  readonly kind: string | null
}

export interface TelemetryGapDetail {
  readonly reason: 'overflow' | 'expired' | 'rejected' | 'manual_clear' | 'authorization_revoked'
  readonly count: number
  readonly first_event_id: string | null
  readonly last_event_id: string | null
}

export interface TelemetryEventItem {
  readonly event_id: string
  readonly installation_id: string
  readonly project_id: string
  readonly session_id: string | null
  readonly kind: string
  readonly occurred_at: string
  readonly received_at: string
  readonly source_type: string
  readonly source_seq: number | null
  readonly turn: number | null
  readonly step: number | null
  readonly duration_ms: number | null
  readonly outcome: string | null
  readonly provider: string | null
  readonly model: string | null
  readonly tool_name: string | null
  readonly tool_category: string | null
  readonly call_id: string | null
  readonly approval_id: string | null
  readonly compaction_id: string | null
  readonly retryable: boolean | null
  readonly retry_count: number | null
  readonly token_usage: TelemetryTokenUsage | null
  readonly error: TelemetryErrorDetail | null
  readonly approval: TelemetryApprovalDetail | null
  readonly compaction: TelemetryCompactionDetail | null
  readonly gap: TelemetryGapDetail | null
}

export interface TelemetryEventPage {
  readonly project_id: string
  readonly items: readonly TelemetryEventItem[]
  readonly next_cursor: string | null
  readonly has_more: boolean
  readonly retention_days: number
}

export interface TelemetryWindowCounts {
  readonly total: number
  readonly completed: number
  readonly errors: number
  readonly interrupted: number
  readonly cancelled: number
}

/** 汇总口径（overview 顶层、时间桶、项目摘要共用）；delivery 与各响应的
 * 顶层 delivery 同源同参折叠 ACK 台账，逐字段一致。 */
export interface TelemetrySummary {
  readonly sessions: TelemetryWindowCounts
  readonly turns: {
    readonly total: number
    readonly completed: number
    readonly errors: number
    readonly blocked: number
    readonly max_tokens: number
    readonly interrupted: number
    readonly cancelled: number
    readonly p50_duration_ms: number | null
    readonly p95_duration_ms: number | null
  }
  readonly steps: {
    readonly started: number
    readonly finished: number
    readonly p50_duration_ms: number | null
    readonly p95_duration_ms: number | null
  }
  readonly llm: {
    readonly requests: number
    readonly retries: number
    readonly input_tokens: number
    readonly output_tokens: number
    readonly total_tokens: number | null
    readonly token_sample_size: number
    readonly input_token_samples: number
    readonly output_token_samples: number
    readonly total_token_samples: number
  }
  readonly tools: {
    readonly calls: number
    readonly errors: number
    readonly p50_duration_ms: number | null
    readonly p95_duration_ms: number | null
  }
  readonly approvals: {
    readonly requested: number
    readonly allowed_once: number
    readonly rejected: number
    readonly cancelled: number
    readonly unavailable: number
  }
  readonly compactions: number
  readonly delivery: TelemetryDelivery
}

export interface TelemetryOverview {
  readonly from: string
  readonly to: string
  readonly has_data: boolean
  readonly summary: TelemetrySummary
  readonly buckets: readonly TelemetryBucket[]
  readonly retention_days: number
}

export interface TelemetryBucket extends TelemetrySummary {
  readonly bucket_start: string
}

export interface TelemetryProjectSummary {
  readonly project_id: string
  readonly from: string
  readonly to: string
  readonly has_data: boolean
  readonly summary: TelemetrySummary
  readonly models: readonly TelemetryModelUsage[]
  readonly tools: readonly TelemetryToolUsage[]
  readonly delivery: TelemetryDelivery
  readonly retention_days: number
}

export interface TelemetryModelUsage {
  readonly provider: string
  readonly model: string
  readonly requests: number
  readonly input_tokens: number
  readonly output_tokens: number
  readonly total_tokens: number | null
  readonly input_token_samples: number
  readonly output_token_samples: number
  readonly total_token_samples: number
}

export interface TelemetryToolUsage {
  readonly tool_name: string
  readonly calls: number
  readonly errors: number
  readonly p50_duration_ms: number | null
  readonly p95_duration_ms: number | null
}

/** 服务端交付分类快照：accepted/duplicate/retryable/rejected 为累计逐事件
 * ACK 结果，queued 为服务端当前积压快照（fixture 同步聚合恒为 0，仅
 * fixture-only 口径），gaps 为已见缺口事件数。 */
export interface TelemetryDelivery {
  readonly accepted: number
  readonly duplicate: number
  readonly retryable: number
  readonly rejected: number
  readonly queued: number
  readonly gaps: number
}

/** 云工作空间 Agent 执行器类型（服务端声明能力与 readiness）。 */
/** Service-declared asset candidate metadata for the profile governance forms. */
export interface CloudAssetCandidate {
  readonly asset_id: string
  readonly asset_type: 'skill' | 'knowledge' | 'memory'
  readonly version: string
  readonly name: string
  readonly authorized: boolean
  readonly readiness: 'ready' | 'unavailable'
  readonly invalid_reason: string | null
  readonly updated_at: string
}

export interface CloudAgentType {
  readonly agent_type_id: string
  readonly key: string
  readonly name: string
  readonly capabilities: readonly string[]
  readonly readiness: 'ready' | 'degraded' | 'unavailable'
  readonly schema_version?: string
  readonly schema?: readonly CloudAgentSchemaField[]
}

/** 类型扩展 schema 字段：表单渲染与发布校验的唯一来源。 */
export interface CloudAgentSchemaField {
  readonly key: string
  readonly label: string
  readonly type: 'string' | 'number' | 'boolean' | 'enum'
  readonly required: boolean
  readonly affects_publish: boolean
  readonly description: string | null
  readonly enum?: readonly string[]
  readonly min?: number
  readonly max?: number
  readonly default?: string | number | boolean
}

/** 一个结构化资产绑定（写请求与版本快照共用）。 */
export interface CloudAgentAssetBinding {
  readonly asset_version_id: string
  readonly required: boolean
  readonly order?: number
}

/** 版本的结构化资产绑定集合；memory 为 null 表示未使用记忆库。 */
export interface CloudAgentAssetBindings {
  readonly skills: readonly CloudAgentAssetBinding[]
  readonly knowledge_bases: readonly CloudAgentAssetBinding[]
  readonly memory: CloudAgentAssetBinding | null
}

/** 凭据引用摘要：只有连接名称、类型、授权状态与 readiness，绝无凭据正文。 */
export interface CloudAgentCredentialRef {
  readonly name: string
  readonly kind: string
  readonly authorized: boolean
  readonly readiness: 'ready' | 'degraded' | 'unavailable'
}

/** 云工作空间 Agent 配置的不可变版本。 */
export interface CloudAgentProfileVersion {
  readonly agent_profile_version_id: string
  readonly version: string
  readonly status: 'draft' | 'published' | 'archived'
  readonly model: string
  readonly reasoning: string
  readonly asset_bindings: CloudAgentAssetBindings
  readonly asset_version_ids: readonly string[]
  readonly execution_policy: Readonly<Record<string, unknown>>
  readonly type_extension_config: Readonly<Record<string, unknown>>
  readonly credential_ref: CloudAgentCredentialRef | null
  readonly change_summary: string
  readonly published_at?: string
  readonly published_by?: string
}

/** 云工作空间 Agent 配置与项目的授权绑定。 */
export interface CloudAgentProjectBinding {
  readonly project_id: string
  readonly agent_profile_version_id: string
  readonly default: boolean
  readonly revision: number
}

/** 云工作空间 Agent 配置（草稿/发布/归档治理对象）。 */
export interface CloudAgentProfile {
  readonly agent_profile_id: string
  readonly organization_id: string
  readonly name: string
  readonly description: string
  readonly agent_type_id: string
  readonly agent_type_name: string
  readonly agent_type_readiness: 'ready' | 'degraded' | 'unavailable'
  readonly skill_count: number
  readonly knowledge_count: number
  readonly memory_name: string | null
  readonly project_count: number
  readonly status: 'draft' | 'published' | 'archived'
  readonly readiness: 'ready' | 'degraded' | 'unavailable'
  readonly unavailable_reason: string | null
  readonly created_by: string
  readonly created_at: string
  readonly updated_at: string
  readonly revision: number
  readonly versions: readonly CloudAgentProfileVersion[]
  readonly project_bindings: readonly CloudAgentProjectBinding[]
}

/** 云工作空间快照（workspace_id 为不透明 ID，不含物理路径）。 */
export interface CloudWorkspace {
  readonly workspace_id: string
  readonly project_id: string
  readonly owner_user_id: string
  readonly repository_id: string
  readonly branch: string
  readonly display_name: string
  readonly default_agent_profile_version_id: string
  readonly status: string
  readonly revision: number
  readonly last_error: string | null
  readonly created_at: string
  readonly updated_at: string
}

/** 云工作空间 Agent Run（含不可变配置快照）。 */
export interface CloudRun {
  readonly run_id: string
  readonly project_id: string
  readonly workspace_id: string
  readonly session_id: string
  readonly agent_profile_version_id: string
  readonly asset_version_ids: readonly string[]
  readonly workspace_revision: number
  readonly status: string
  readonly write_mode: 'read_only' | 'write'
  readonly lease_id: string | null
  readonly revision: number
  readonly retry_of_run_id?: string
  readonly error_code: string | null
  readonly created_at: string
  readonly updated_at: string
  readonly trace_id?: string
  /** §11.7 状态转移时间线（服务端 toRunDto 附带）；证据时间轴的审批/状态来源。 */
  readonly timeline?: readonly {
    readonly status: string
    readonly at: string
    readonly reason: string
    readonly operator: string
    readonly policy_version: string
    readonly revision: number
    readonly trace_id: string
  }[]
}

/** 云工作空间统一审计行：三类审计接口统一返回字面字段 actor_name。 */
export interface CloudWorkspaceAudit {
  readonly occurred_at: string
  readonly actor_user_id: string
  readonly actor_name: string
  readonly request_id: string
  readonly organization_id: string | null
  readonly project_id: string | null
  readonly workspace_id: string | null
  readonly session_id: string | null
  readonly run_id: string | null
  readonly agent_profile_id: string | null
  readonly agent_profile_version_id: string | null
  readonly asset_version_ids: readonly string[] | null
  readonly revision: number | null
  readonly action: string
  readonly result: 'succeeded' | 'failed'
  readonly error_code: string | null
}
