/**
 * Browser-safe state models for cloud workspaces. These types are the Host→UI
 * vocabulary for the cloud workspace feature and are distinct from the local
 * `WorkspaceRegistry` paths owned by `@deepseek-ai/dsh-workspace`: every resource
 * is identified by an opaque server id and carries no local filesystem location.
 */

/** Server-side workspace lifecycle states; unknown states must map to `unknown`. */
export type WorkspaceLifecycleStatus =
  | 'draft'
  | 'provisioning'
  | 'starting'
  | 'ready'
  | 'degraded'
  | 'stopping'
  | 'stopped'
  | 'failed'
  | 'archived'
  | 'deleting'
  | 'unknown'

/** Run states recognized by the plugin; unknown states must map to `unknown`. */
export type AgentRunStatus =
  | 'preparing'
  | 'awaiting_approval'
  | 'running'
  | 'paused'
  | 'awaiting_user'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'expired'
  | 'unknown'

/** A cloud workspace snapshot as returned by the service. */
export interface CloudWorkspace {
  readonly workspaceId: string
  readonly projectId: string
  readonly ownerUserId: string
  readonly repositoryId: string
  readonly branch: string
  readonly displayName: string
  readonly defaultAgentProfileVersionId: string
  readonly status: WorkspaceLifecycleStatus
  readonly revision: number
  readonly lastError: string | null
  readonly createdAt: string
  readonly updatedAt: string
}

/** One authorized directory or file summary inside a cloud workspace. */
export interface WorkspaceFileEntry {
  readonly path: string
  readonly kind: 'directory' | 'file'
  readonly size: number
  readonly etag: string
}

/**
 * One repository the account may create a cloud workspace from.
 *
 * The list is the service's authorization answer, not a catalogue the
 * workbench may invent: a project whose repositories are not published here has
 * no creatable code source, and the create form must say so rather than picking
 * a placeholder id.
 */
export interface WorkspaceCodeSource {
  readonly repositoryId: string
  readonly name: string
  readonly provider: string
  readonly defaultBranch: string
  readonly branches: readonly string[]
}

/** One directory listing with the workspace revision it reflects. */
export interface WorkspaceDirectory {
  readonly path: string
  readonly revision: number
  readonly items: readonly WorkspaceFileEntry[]
}

/** Restricted file content; binary content arrives base64 encoded. */
export interface WorkspaceFileContent {
  readonly path: string
  readonly contentType: string
  readonly size: number
  readonly etag: string
  readonly revision: number
  readonly content?: string
  readonly contentBase64?: string
}

/** One changed file with its unified diff against the baseline. */
export interface WorkspaceChangeFile {
  readonly path: string
  readonly change: 'added' | 'modified' | 'deleted'
  readonly diff: string
}

/** The workspace change set: baseline revision, current revision, and files. */
export interface WorkspaceChanges {
  readonly workspaceId: string
  readonly baselineRevision: number
  readonly revision: number
  readonly files: readonly WorkspaceChangeFile[]
}

/** A server-authorized preview resource; static HTML carries CSP and sandbox demands. */
export interface WorkspacePreview {
  readonly path: string
  readonly revision: number
  readonly etag: string
  readonly kind: 'text' | 'markdown' | 'json' | 'image' | 'diff' | 'static_html'
  readonly contentType: string
  readonly content?: string
  readonly contentBase64?: string
  readonly diff?: string
  readonly sha256?: string
  readonly csp?: string
  readonly sandbox?: readonly string[]
}

/** A short-lived, single-workspace, single-user web app preview URL. */
export interface WorkspacePreviewUrlGrant {
  readonly url: string
  readonly expiresAt: string
  readonly workspaceId: string
}

/** Agent executor type with its server-declared readiness. */
export interface AgentTypeSummary {
  readonly agentTypeId: string
  readonly key: string
  readonly name: string
  readonly capabilities: readonly string[]
  readonly readiness: 'ready' | 'degraded' | 'unavailable'
}

/** Server-declared execution constraints attached to one profile version. */
export interface AgentExecutionPolicy {
  readonly permission_mode?: string
  readonly tool_allowlist?: readonly string[]
  readonly max_concurrency?: number
  readonly budget?: number
  readonly timeout_ms?: number
  /** The version's declared write capability; a Run's write mode may tighten it, never widen it. */
  readonly write_mode?: 'read_only' | 'write'
}

/** One team-asset binding as the server resolved it: display metadata, never asset content. */
export interface AgentAssetBinding {
  readonly assetId: string
  readonly assetVersionId: string
  readonly name: string
  readonly required: boolean
  /** Server-assigned display position (1-based); the plugin never reorders. */
  readonly order: number
  readonly readiness: 'ready' | 'degraded' | 'unavailable'
  readonly unavailableReason: string | null
}

/** One server-declared type-extension schema field (user-side contract). */
export interface AgentTypeSchemaField {
  readonly key: string
  readonly label: string
  readonly type: 'string' | 'number' | 'boolean' | 'enum'
  readonly required: boolean
  readonly affectsPublish: boolean
  readonly description: string | null
  readonly enum?: readonly string[]
  readonly min?: number
  readonly max?: number
  readonly default?: string | number | boolean
}

/** User-side type schema: fields, version and per-type credential semantics. */
export interface AgentTypeSchema {
  readonly agentTypeId: string
  readonly key: string
  readonly credentialRequired: boolean
  readonly schemaVersion: string
  readonly schema: readonly AgentTypeSchemaField[]
}

/** Published agent profile version selectable for one project. */
export interface AgentProfileSummary {
  readonly agentProfileId: string
  readonly agentProfileVersionId: string
  readonly name: string
  readonly description: string
  readonly versionLabel: string
  readonly changeSummary: string
  readonly agentTypeId: string
  readonly agentTypeName: string
  readonly agentTypeKey: string
  readonly agentTypeReadiness: 'ready' | 'degraded' | 'unavailable'
  readonly agentTypeCapabilities: readonly string[]
  readonly model: string
  readonly reasoning: string
  /** Ordered skill bindings; the wire order is the server's order. */
  readonly skills: readonly AgentAssetBinding[]
  readonly knowledgeBases: readonly AgentAssetBinding[]
  /** The single bound memory library, or null when the version uses none. */
  readonly memory: AgentAssetBinding | null
  readonly executionPolicy: AgentExecutionPolicy
  /** Server-defined scalar type-extension values; displayed generically, never interpreted. */
  readonly typeExtension: Readonly<Record<string, string | number | boolean>>
  /** Extension keys whose values are not scalar; the UI shows them as opaque server extensions. */
  readonly typeExtensionOpaqueKeys: readonly string[]
  readonly readiness: 'ready' | 'degraded' | 'unavailable'
  readonly unavailableReason: string | null
  readonly default: boolean
  readonly status: 'published'
  readonly createdBy: string
  readonly publishedAt: string
  readonly updatedAt: string
}

/** One traceable, cancelable and retryable agent run with its immutable snapshot. */
export interface AgentRunSnapshot {
  readonly runId: string
  readonly projectId: string
  readonly workspaceId: string
  readonly sessionId: string
  readonly agentProfileVersionId: string
  readonly assetVersionIds: readonly string[]
  /** The config's execution policy frozen at run creation; later publishes never change it. */
  readonly executionPolicy: AgentExecutionPolicy
  readonly workspaceRevision: number
  readonly status: AgentRunStatus
  readonly writeMode: 'read_only' | 'write'
  readonly leaseId: string | null
  readonly revision: number
  readonly retryOfRunId?: string
  /** 引用的已确认计划（不可变引用；draft 归 Plan，运行只从 confirmed 计划创建）。 */
  readonly planId?: string
  readonly errorCode: string | null
  readonly createdAt: string
  readonly updatedAt: string
  readonly timeline?: readonly AgentRunTimelineEntry[]
  /** 当前接管持有者（§11.10）；未接管为 null。 */
  readonly operator?: string | null
  /** 写操作响应携带的服务端证据块（§11.10）；仅变更响应存在。 */
  readonly evidence?: RunOperationEvidence
}

/**
 * 写操作响应的服务端证据块（§11.10）：request ID、结果、原因、revision、
 * 审计 ID、影响对象与下一步动作。失败场景的审计 ID 属管理面，不出现在
 * 非管理员证据里（§12 错误 envelope data 为 null）。
 */
export interface RunOperationEvidence {
  readonly requestId: string
  readonly outcome: 'succeeded' | 'partial_success'
  readonly reason: string
  readonly revision: number
  readonly auditId: string
  readonly affected: readonly string[]
  readonly nextAction: string
}

/** 审批实体快照（§11.10）：全部字段来自服务端，客户端不推断。 */
export interface RunApprovalSnapshot {
  readonly approvalId: string
  readonly runId: string
  readonly action: string
  readonly summary: string
  readonly affected: readonly string[]
  readonly permission: {
    readonly code: string
    readonly allowed: boolean
    readonly reason: string
    readonly policyVersion: string
  }
  readonly assetVersions: readonly {
    readonly assetVersionId: string
    readonly status: 'bound' | 'withdrawn' | 'missing'
    readonly detail: string
  }[]
  readonly risk: { readonly level: 'low' | 'medium' | 'high'; readonly reason: string }
  readonly revocable: { readonly revocable: boolean; readonly how: string | null }
  readonly expiresAt: string
  readonly createdAt: string
}

/** One preserved tool result recorded in a checkpoint. */
export interface RunCheckpointToolResult {
  readonly callId: string
  readonly tool: string
  readonly result: string
}

/** 待审批动作的最小约束形状（审批实体在阶段 4 完整落地）。 */
export interface RunPendingApproval {
  readonly action: string
  readonly summary: string
}

/** 恢复预览 reuse 条目：计划步骤或保留的工具结果。 */
export interface RunResumeReuseEntry {
  readonly kind: 'plan_step' | 'tool_result'
  readonly title?: string
  readonly call_id?: string
  readonly tool?: string
}

/**
 * 运行脉搏条目（§11.11）：闭集 kind；重连条目由客户端合成，不来自服务端。
 */
export type RunPulseEntry =
  | { readonly kind: 'status'; readonly at: string; readonly revision: number; readonly traceId: string; readonly summary: string; readonly status: AgentRunStatus; readonly reason: string; readonly operator: string; readonly policyVersion: string }
  | { readonly kind: 'approval'; readonly at: string; readonly revision: number; readonly traceId: string; readonly summary: string; readonly decision: 'approve' | 'reject'; readonly operator: string }
  | { readonly kind: 'tool_call'; readonly at: string; readonly revision: number; readonly traceId: string; readonly summary: string; readonly callId: string; readonly tool: string; readonly result: string }
  | { readonly kind: 'test'; readonly at: string; readonly revision: number; readonly traceId: string; readonly summary: string; readonly total: number; readonly passed: number; readonly failed: number }
  | { readonly kind: 'checkpoint'; readonly at: string; readonly revision: number; readonly traceId: string; readonly summary: string; readonly checkpointId: string; readonly consumed: boolean }

/** 运行脉搏快照（§11.11）。 */
export interface RunPulse {
  readonly runId: string
  readonly items: readonly RunPulseEntry[]
}

/** 资产候选（§11.12）：选择器七要素 + 授权与就绪判定。 */
export interface AssetCandidate {
  readonly assetId: string
  readonly assetType: 'skill' | 'knowledge' | 'memory'
  readonly version: string
  readonly name: string
  readonly authorized: boolean
  readonly readiness: 'ready' | 'unavailable'
  readonly invalidReason: string | null
  readonly updatedAt: string
  readonly purpose: string
  readonly source: 'builtin' | 'team' | 'organization'
}

/** 配置试运行结果（§11.12）：只读装配校验，不改状态。 */
export interface ProfileDryRun {
  readonly dryRunId: string
  readonly agentProfileVersionId: string
  readonly outcome: 'ready' | 'blocked'
  readonly checks: readonly {
    readonly check: string
    readonly result: 'pass' | 'warn' | 'fail'
    readonly detail: string
  }[]
  readonly createdAt: string
}

/** 上下文镜头条目（§11.13）：八层词表之一，被抑制必须携带原因。 */
export interface ContextLensEntry {
  readonly source: 'safety' | 'org-policy' | 'project-policy' | 'agent-config' | 'skill' | 'knowledge' | 'memory' | 'user'
  readonly title: string
  /**
   * Memory identity for `source='memory'` entries, `null` for every other layer
   * (§11.17). Without it the lens cannot name which memory to suppress.
   */
  readonly memoryId: string | null
  readonly permission: 'allowed' | 'suppressed'
  readonly permissionReason: string | null
  readonly selectionReason: string
  readonly injected: boolean
  readonly updatedAt: string
}

/** 权限判定引用（§11.13 镜头小节）。 */
export interface ContextLensDecision {
  readonly action: string
  readonly decision: 'allowed' | 'denied'
  readonly code: string
  readonly reason: string
  readonly policyVersion: string
  readonly at: string
}

/** 上下文镜头快照（§11.13）。 */
export interface ContextLensSnapshot {
  readonly workspaceId: string
  readonly revision: number
  readonly generatedAt: string
  readonly entries: readonly ContextLensEntry[]
  readonly permissionDecisions: readonly ContextLensDecision[]
}

/**
 * 运行绑定的一条资产版本（§11.18 A）。
 *
 * 两组状态刻意分开命名：`readinessAtBinding` 是绑定那一刻的事实，之后任何撤回都
 * 不得改写；`currentState` 是读取那一刻的状态。把它们合成一个字段，就等于允许
 * 「撤回」倒过来篡改历史。
 */
export interface RunAssetSnapshotEntry {
  readonly assetType: 'skill' | 'knowledge' | 'memory'
  readonly assetId: string
  readonly assetVersionId: string
  readonly name: string
  readonly required: boolean
  readonly order: number
  /** 绑定时刻冻结的就绪度。 */
  readonly readinessAtBinding: 'ready' | 'unavailable'
  /** 绑定时刻不可用的原因；当时就绪则为 null（不是缺失）。 */
  readonly unavailableReasonAtBinding: string | null
  /** 读取时刻的资产状态；`withdrawn` 与 `missing` 不可互相顶替。 */
  readonly currentState: 'bound' | 'withdrawn' | 'missing'
  readonly withdrawnAt: string | null
  /** 指向资产模块的治理审计行；未撤回为 null。 */
  readonly withdrawalAuditId: string | null
}

/** 跨模块审计：运行绑定过的资产版本的治理行（§11.18 A）。 */
export interface RunAssetGovernanceEntry {
  readonly auditId: string
  readonly action: string
  readonly actorName: string
  readonly at: string
  readonly assetVersionId: string
}

/** 运行资产版本快照（§11.18 A）：只读，且对同一运行稳定。 */
export interface RunAssetSnapshot {
  readonly runId: string
  readonly capturedAt: string
  readonly runRevision: number
  readonly assets: readonly RunAssetSnapshotEntry[]
  readonly governance: readonly RunAssetGovernanceEntry[]
}

/** 配置编辑上下文（§11.12 编辑流）：配置级 revision 与版本列表。 */
export interface ProfileEditContext {
  readonly profileId: string
  readonly revision: number
  readonly name: string
  readonly versions: readonly {
    readonly agentProfileVersionId: string
    readonly version: string
    readonly status: 'draft' | 'published' | 'archived'
  }[]
}

/**
 * Server-saved checkpoint (§11.8) with its resume preview; §11.11 adds the
 * checkpoint id so history entries stay addressable after newer pauses.
 */
export interface RunCheckpointSnapshot {
  /** 检查点 id（§11.11 检查点历史）：暂停追加、恢复只消费最新、历史保留。 */
  readonly checkpointId?: string
  readonly createdAt: string
  readonly traceId: string
  readonly sessionSeq: number
  readonly toolResults: readonly RunCheckpointToolResult[]
  readonly pendingApproval: RunPendingApproval | null
  readonly completedSteps: readonly number[]
  readonly agentConfig: {
    readonly agentProfileVersionId: string
    readonly executionPolicy: AgentExecutionPolicy
  }
  readonly assetVersionIds: readonly string[]
  readonly workspaceRevision: number
  readonly planId: string | null
  readonly steps?: readonly string[]
  readonly consumed: boolean
  readonly consumedAt: string | null
  readonly resumePreview: {
    readonly reuse: readonly RunResumeReuseEntry[]
    readonly replay: readonly { readonly title: string }[]
    readonly replayNote?: string
  }
  readonly fixtureOnly: boolean
}

/** One plan step with its dependency indices (indices into the same steps array). */
export interface WorkspacePlanStep {
  readonly title: string
  readonly dependsOn: readonly number[]
}

/** One append-only plan edit record; `before` keeps the full previous content. */
export interface WorkspacePlanEdit {
  readonly editId: string
  readonly editor: string
  readonly editedAt: string
  readonly changeSummary: string
  readonly revisionBefore: number
  readonly revisionAfter: number
  readonly before: {
    readonly goal: string
    readonly steps: readonly WorkspacePlanStep[]
    readonly agentProfileVersionId: string
    readonly assetVersionIds: readonly string[]
  }
}

/**
 * The editable execution plan (blueprint §4.1). `draft` belongs to the plan:
 * only a `confirmed` plan may be referenced by a run, and confirming freezes edits.
 */
export interface WorkspacePlan {
  readonly planId: string
  readonly projectId: string
  readonly workspaceId: string
  readonly goal: string
  readonly steps: readonly WorkspacePlanStep[]
  readonly agentProfileVersionId: string
  readonly assetVersionIds: readonly string[]
  readonly status: 'draft' | 'confirmed' | 'unknown'
  readonly revision: number
  readonly createdBy: string
  readonly createdAt: string
  readonly updatedAt: string
  readonly confirmedBy?: string
  readonly confirmedAt?: string
  readonly edits: readonly WorkspacePlanEdit[]
}

/** One observed run status transition with its server metadata (§11.7). */
export interface AgentRunTimelineEntry {
  readonly status: AgentRunStatus
  readonly at: string
  readonly reason: string
  readonly operator: string
  readonly policyVersion: string
  readonly revision: number
  readonly traceId: string
}

/** One replayable stream event; `revision` ordering is owned by the service. */
export interface WorkspaceStreamEvent {
  readonly eventId: string
  readonly resourceType: 'workspace' | 'run' | 'file' | 'changes' | 'agent_profile' | 'stream' | 'unknown'
  readonly resourceId: string
  readonly revision: number
  readonly eventType: string
  readonly occurredAt: string
  readonly payload: Readonly<Record<string, unknown>>
}

/**
 * One stream event as projected across the Remote boundary.
 *
 * The Host-side payload is arbitrary JSON; the Remote boundary rejects
 * unconstrained `unknown`, so the payload crosses as its JSON encoding and the
 * consumer decodes it only when it needs the individual fields.
 */
export interface WorkspaceProjectedStreamEvent {
  readonly eventId: string
  readonly resourceType: WorkspaceStreamEvent['resourceType']
  readonly resourceId: string
  readonly revision: number
  readonly eventType: string
  readonly occurredAt: string
  readonly payloadJson: string
}

/**
 * Events the Host consumed after a caller's watermark.
 *
 * `truncated` is true when the watermark predates the retained replay window, in
 * which case the caller must reconcile from a fresh snapshot instead of applying a
 * partial event list.
 */
export interface WorkspaceStreamEvents {
  readonly events: readonly WorkspaceProjectedStreamEvent[]
  readonly truncated: boolean
}

/** Failed query or write outcome carrying the stable service error code. */
export interface WorkspaceFailure {
  readonly status: 'failed'
  readonly code: string
  readonly message: string
  /** 服务端 envelope 的 request_id（§11.10）；Host 从错误响应捕获。 */
  readonly requestId?: string
  /** 失败响应的 HTTP 状态（§11.10）；Host 从传输层捕获。 */
  readonly httpStatus?: number
}

/**
 * Query outcome union crossing the Host→UI seam; never an exception.
 *
 * A `ready` outcome carries the service's own provenance declaration for the data:
 * `fixtureOnly` is true when the response declared `x-fixture-only: true`. The UI
 * must render that as `fixture-only`, never as production success.
 */
export type WorkspaceQueryResult<T> =
  | { readonly status: 'ready'; readonly value: T; readonly fixtureOnly: boolean }
  | { readonly status: 'signed-out' }
  | { readonly status: 'not-ready'; readonly missing: readonly string[] }
  | WorkspaceFailure

/** Live SSE connection state exposed to the UI. */
export type WorkspaceStreamState =
  | { readonly status: 'idle' }
  | { readonly status: 'connecting' }
  | { readonly status: 'live'; readonly lastEventId: string }
  | { readonly status: 'reconnecting'; readonly attempt: number; readonly lastEventId: string }
  | { readonly status: 'resync'; readonly lastEventId: string }
  /**
   * The stream is connected but the authoritative snapshot could not be
   * re-read, so the replay window cannot be trusted. This is deliberately NOT
   * `live`: a failed resync must never be presented as a healthy live stream.
   */
  | { readonly status: 'stale'; readonly code: string; readonly message: string; readonly lastEventId: string }
  | { readonly status: 'stopped' }

/**
 * One caller's owned SSE subscription.
 *
 * The Host keeps a separate connection, replay window and cursor per
 * subscription, so a second client stopping its own stream can never tear down
 * a subscription another client still holds. `subscriptionId` is opaque and is
 * the only handle a client may pass back to `stopStream` / `streamEventsAfter`.
 */
export interface WorkspaceStreamSubscription {
  readonly subscriptionId: string
  readonly state: WorkspaceStreamState
}
