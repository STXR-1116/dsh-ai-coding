/** Client-safe data vocabulary for platform-hosted local DSH Team Skills. */

import type { InstalledTeamSkill, TeamSkillFileDigest } from './installer.ts'
import type {
  TeamSkillInstallRetry,
  TeamSkillInstallStage,
  TeamSkillInstallStageEvidence,
} from './install-stages.ts'

// Re-exported so the browser client can consume the install-stage vocabulary
// through this package's public `./types` entry without reaching into src.
export type {
  TeamSkillInstallRetry,
  TeamSkillInstallStage,
  TeamSkillInstallStageEvidence,
  TeamSkillInstallStageOutcome,
} from './install-stages.ts'

/** Closed vocabulary of tool permissions a release may request (§11.14). */
export type TeamSkillToolPermission = 'bash' | 'read_file' | 'write_file' | 'web_fetch' | 'subprocess'

/** Release signature facts; all four fields are required and non-empty. */
export interface TeamSkillSignature {
  /** Closed vocabulary of accepted signing algorithms. */
  readonly algorithm: 'sha256-rsa' | 'sha256-ecdsa'
  /** Opaque signing-key identity. */
  readonly keyId: string
  /** Certificate fingerprint displayed in the trust card. */
  readonly fingerprint: string
  /** Signing timestamp. */
  readonly signedAt: string
}

/** One recent governance audit row shown on the trust card. */
export interface TeamSkillTrustAudit {
  /** Audit timestamp. */
  readonly at: string
  /** Audited action. */
  readonly action: string
  /** Audit outcome; failures are shown as prominently as successes. */
  readonly outcome: 'succeeded' | 'failed'
  /** Literal `actor_name` from the service (§12); never an alias. */
  readonly actorName: string
  /** Request identity for evidence lookup. */
  readonly requestId: string
}

/** One immutable release's trust card; display metadata, never asset content. */
export interface TeamSkillTrustCard {
  /** Stable opaque server Skill identity. */
  readonly skillId: string
  /** Immutable release version described by this card. */
  readonly version: string
  /** Human-facing name. */
  readonly displayName: string
  /** Publisher display name and owning organization identity. */
  readonly publisher: { readonly name: string; readonly organizationId: string }
  /** Release signature facts. */
  readonly signature: TeamSkillSignature
  /** Requested tool permissions; an empty array means none are requested. */
  readonly toolPermissions: readonly TeamSkillToolPermission[]
  /** Declared file scope of the release artifact. */
  readonly fileScope: { readonly roots: readonly string[]; readonly maxFiles: number; readonly maxBytes: number }
  /** Declared external access; `hosts` is empty when `network` is false. */
  readonly externalAccess: { readonly network: boolean; readonly hosts: readonly string[] }
  /** Most recent governance audits, newest first (at most ten). */
  readonly recentAudits: readonly TeamSkillTrustAudit[]
}

/** Installation root selected by the user. */
export type TeamSkillScope = 'project' | 'global'

/** Account roles returned by the authoritative user service. */
export type TeamSkillAccountRole = 'admin' | 'manager' | 'member'

/** Audit-record roles; system operations are recorded as 'system'. */
export type TeamSkillAuditRole = 'admin' | 'manager' | 'member' | 'system'

/** Account status returned by the authoritative user service. */
export type TeamSkillAccountStatus = 'active' | 'suspended'

/** Browser-safe account summary returned by the Host. */
export interface TeamSkillAccountUser {
  /** Stable opaque account identity. */
  readonly userId: string
  /** Login name or organization email. */
  readonly username: string
  /** Organization email displayed by the account drawer. */
  readonly email: string
  /** Human-facing display name. */
  readonly displayName: string
  /** Current service-side account state. */
  readonly status: TeamSkillAccountStatus
  /** Single account-wide role used for management scope. */
  readonly globalRole: TeamSkillAccountRole
  /** Whether the first-login password flow is still required. */
  readonly mustChangePassword: boolean
  /** Service-side user revision. */
  readonly revision: number
}

/** Browser-safe organization membership summary. */
export interface TeamSkillAccountMembership {
  /** Organization identity. */
  readonly organizationId: string
  /** Organization display name. */
  readonly organizationName: string
  /** Membership state. */
  readonly status: TeamSkillAccountStatus
  /** Service-side membership revision. */
  readonly revision: number
}

/** Browser-safe organization visible to the current account. */
export interface TeamSkillOrganization {
  /** Organization identity. */
  readonly organizationId: string
  /** Organization display name. */
  readonly name: string
  /** Organization lifecycle state. */
  readonly status: 'active' | 'archived'
  /** Service-side organization revision. */
  readonly revision: number
}

/** Browser-safe project visible to the current account. */
export interface TeamSkillProject {
  /** Project identity. */
  readonly projectId: string
  /** Owning organization identity. */
  readonly organizationId: string
  /** Owning organization display name. */
  readonly organizationName: string
  /** Project display name. */
  readonly name: string
  /** Non-sensitive project description. */
  readonly description: string
  /** Project lifecycle state. */
  readonly status: 'draft' | 'active' | 'archived'
  /** Server timestamps and governance counters. */
  readonly createdBy: string
  readonly createdAt: string
  readonly updatedAt: string
  readonly memberCount: number
  readonly assetCount: number
  /** Service-side project revision. */
  readonly revision: number
}

/** Asset relation summary returned for an active project. */
export interface TeamSkillProjectAsset {
  readonly projectId: string
  readonly assetType: 'skill' | 'knowledge' | 'memory'
  readonly assetId: string
  readonly name: string
  readonly relationKind: 'reference' | 'context'
  readonly createdAt: string
  readonly updatedAt: string
  readonly revision: number
}

/** Project detail returned after project-level authorization. */
export interface TeamSkillProjectDetail {
  readonly project: TeamSkillProject
  readonly assets: readonly TeamSkillProjectAsset[]
}

/** Asset visibility scope returned by the service. */
export type TeamSkillAssetVisibility = 'platform' | 'organization' | 'project' | 'account'

/** Browser-safe asset summary returned by the service. */
export interface TeamSkillAsset {
  /** Stable opaque asset identity. */
  readonly assetId: string
  /** Module-owned asset type. */
  readonly assetType: 'project' | 'skill' | 'knowledge' | 'memory'
  /** Human-facing name. */
  readonly name: string
  /** Matched authorization scope. */
  readonly visibility: TeamSkillAssetVisibility
  /** Owning organization when applicable. */
  readonly organizationId?: string
  /** Owning project when applicable. */
  readonly projectId?: string
}

/** Browser-safe service-authoritative access summary across all organizations. */
export interface TeamSkillAccessSummary {
  /** Organizations currently visible to the account. */
  readonly organizations: readonly TeamSkillOrganization[]
  /** Projects currently visible to the account. */
  readonly projects: readonly TeamSkillProject[]
  /** Assets currently visible to the account. */
  readonly assets: readonly TeamSkillAsset[]
  /** Organization and project identifiers the account may manage. */
  readonly management: { readonly organizationIds: readonly string[]; readonly projectIds: readonly string[] }
  /** Revision for the access summary. */
  readonly revision: number
}

/** Browser-safe authentication state. */
export type TeamSkillAccountState =
  | { readonly status: 'signed-out' }
  | {
    readonly status: 'authenticated'
    readonly user: TeamSkillAccountUser
    readonly memberships: readonly TeamSkillAccountMembership[]
    readonly mustChangePassword: boolean
  }

/** Login request accepted by the Host. */
export interface TeamSkillLoginRequest {
  /** Username or organization email. */
  readonly username: string
  /** Password supplied by the user. */
  readonly password: string
}

/** First-login or account password change request. */
export interface TeamSkillChangePasswordRequest {
  /** Current password supplied by the user. */
  readonly currentPassword: string
  /** New password supplied by the user. */
  readonly newPassword: string
}

/** Account operation result projected through the typed Remote. */
export type TeamSkillAccountResult<T> = T | { readonly status: 'signed-out' } | TeamSkillNotReady | TeamSkillFailed

/** Knowledge base type owned by the external WeKnora data plane. */
export type TeamSkillKnowledgeBaseType = 'document' | 'faq' | 'wiki'

/** Platform lifecycle state for one knowledge base. */
export type TeamSkillKnowledgeBaseState = 'active' | 'unavailable' | 'deleting'

/** Browser-safe project knowledge base summary. */
export interface TeamSkillKnowledgeBaseSummary {
  readonly knowledgeBaseId: string
  readonly name: string
  readonly description: string
  readonly type: TeamSkillKnowledgeBaseType
  readonly state: TeamSkillKnowledgeBaseState
  readonly searchable: boolean
  readonly updatedAt: string
  readonly revision: number
}

/** Citation location returned with an authorized search result. */
export interface TeamSkillKnowledgeCitation {
  readonly page?: number
  readonly chunk?: string
}

/** One constrained, model-visible knowledge result. */
export interface TeamSkillKnowledgeSearchResult {
  readonly knowledgeBaseId: string
  readonly knowledgeId: string
  readonly title: string
  readonly snippet: string
  readonly score: number
  readonly sourceUrl: string
  /** Immutable version of the document this hit came from (§11.15). */
  readonly version: string
  /** Last content update of that document (§11.15). */
  readonly updatedAt: string
  readonly citation?: TeamSkillKnowledgeCitation
}

/** Per-knowledge-base status for a search request. */
export interface TeamSkillKnowledgeSearchStatus {
  readonly knowledgeBaseId: string
  readonly status: 'used' | 'no_hits' | 'skipped'
  readonly reason?: 'processing' | 'unavailable' | 'forbidden' | 'not_found' | 'timeout' | 'external_error' | null
}

/** Platform search response preserving per-KB status. */
export interface TeamSkillKnowledgeSearchResponse {
  readonly requestId: string
  readonly results: readonly TeamSkillKnowledgeSearchResult[]
  readonly knowledgeBases: readonly TeamSkillKnowledgeSearchStatus[]
}

/** Request for one explicit project-scoped knowledge search. */
export interface TeamSkillKnowledgeSearchRequest {
  readonly projectId: string
  readonly knowledgeBaseIds: readonly string[]
  readonly query: string
  readonly topK?: number
  readonly traceId?: string
}

/** Session-only knowledge bases selected for one live native DSH agent. */
export interface TeamSkillKnowledgeSelection {
  readonly projectId: string
  readonly knowledgeBaseIds: readonly string[]
}

/** Minimal authorized document preview link. */
export interface TeamSkillKnowledgePreview {
  readonly knowledgeBaseId: string
  readonly documentId: string
  readonly title: string
  readonly previewUrl: string
}

/** Governance tier of one memory; `layer` is the unrelated storage layer (§11.16). */
export type TeamSkillMemoryTier = 'project_candidate' | 'project_confirmed' | 'team'

/** Service-authoritative project memory record visible to the current caller. */
export interface TeamSkillMemory {
  readonly memoryId: string
  readonly teamId: string
  readonly projectId: string
  readonly content: string
  readonly layer: 'L1'
  /** Governance tier; distinct from `layer`, the storage layer (§11.16). */
  readonly tier: TeamSkillMemoryTier
  /** Session event that produced this memory; opaque (§11.16). */
  readonly sourceEventId: string
  /** Candidate expiry, or `null` when it never expires (§11.16). */
  readonly expiresAt: string | null
  /** Whether this memory may ever be promoted to a team memory (§11.16). */
  readonly scope: 'project_only' | 'shared'
  readonly capturedByUserId: string
  readonly createdAt: string
  readonly updatedAt: string
  readonly revision: number
  readonly status: 'ACTIVE' | 'DELETED'
  readonly importance: number
  readonly recallCount: number
  readonly lastRecalledAt: string | null
  readonly sourceKind: 'agent_turn'
}

/** Search result returned by project-memory recall. */
export interface TeamSkillMemoryRecallItem {
  readonly memoryId: string
  readonly content: string
  readonly score: number
  readonly layer: 'L1'
  /** Why this memory was recalled; a stable reason, not a log line (§11.16). */
  readonly recallReason: string
  /** Run that produced the memory, or `null` for a non-run source (§11.16). */
  readonly sourceRunId: string | null
  /** Last content update of the memory (§11.16). */
  readonly updatedAt: string
  /** Server-computed confidence, distinct from `importance` (§11.16). */
  readonly confidence: number
}

/** Server state for one project-memory recall request. */
export type TeamSkillMemoryRecallStatus = 'READY' | 'PARTIAL' | 'UNAVAILABLE' | 'PROJECT_REQUIRED'

/** Project-memory recall response; failure states are not empty success responses. */
export interface TeamSkillMemoryRecallResponse {
  readonly status: TeamSkillMemoryRecallStatus
  readonly items: readonly TeamSkillMemoryRecallItem[]
  readonly contextText: string
  readonly strategy: string
  readonly effectivePolicy: { readonly topK: number; readonly relevanceThreshold: number; readonly tokenBudget: number }
}

/** Cursor page for project-memory list and search. */
export interface TeamSkillMemoryPage {
  readonly items: readonly TeamSkillMemory[]
  readonly nextCursor: string | null
  readonly totalEstimate: number
}

/** Accepted asynchronous memory mutation. */
export interface TeamSkillMemoryMutation {
  readonly memory?: TeamSkillMemory
  readonly eventId: string
  readonly jobId: string
  readonly status: 'PENDING' | 'INDEX_PENDING'
  readonly acceptedCount?: number
  readonly cleanupStatus?: 'PENDING' | 'FAILED'
}

/** Project-memory job visible to the current caller. */
export interface TeamSkillMemoryJob {
  readonly jobId: string
  readonly eventId: string
  readonly kind: 'CAPTURE' | 'INDEX_REFRESH' | 'DELETE_CLEANUP' | 'PROJECT_PROVISION' | 'POLICY_UPDATE' | 'PROJECT_PURGE'
  readonly teamId: string
  readonly projectId: string
  readonly requestedByUserId: string
  readonly status: 'PENDING' | 'SUCCEEDED' | 'FAILED'
  readonly retryable: boolean
  readonly retryCount: number
  readonly createdAt: string
  readonly finishedAt: string | null
  readonly errorCode: string | null
  readonly revision: number
}

/** Project-memory audit record without source transcript content. */
export interface TeamSkillMemoryAudit {
  readonly auditId: string
  readonly operation: string
  readonly operatedByUserId: string
  readonly role: TeamSkillAuditRole
  readonly memoryId: string | null
  readonly projectId: string
  readonly result: string
  readonly eventId: string
}

/** Server-controlled publication state of a Team Skill version. */
export type TeamSkillReleaseState = 'published' | 'withdrawn'

/** Minimal server-authoritative Team Skill list item. */
export interface TeamSkillCatalogItem {
  /** Stable opaque server identity. */
  readonly skillId: string
  /** Human-facing Chinese or localized name. */
  readonly displayName: string
  /** Server-generated DSH runtime name. */
  readonly runtimeName: string
  /** Short purpose statement. */
  readonly summary: string
  /** Current recommended immutable release version. */
  readonly version: string
  /** Catalog classification. */
  readonly category: string
  /** Searchable server-controlled tags. */
  readonly tags: readonly string[]
  /** Current release timestamp. */
  readonly publishedAt: string
}

/** Page returned by the visible Team Skill catalog. */
export interface TeamSkillCatalog {
  /** Skills visible to the authenticated user only. */
  readonly items: readonly TeamSkillCatalogItem[]
  /** Opaque next-page cursor, when additional items exist. */
  readonly nextCursor?: string
}

/** Server-authoritative release state for one locally installed version. */
export interface TeamSkillReleaseStatusItem {
  /** Stable server Skill identity. */
  readonly skillId: string
  /** Immutable installed version. */
  readonly version: string
  /** Opaque project identity used for server-side release authorization. */
  readonly projectId: string
  /** Current server release state. */
  readonly status: TeamSkillReleaseState
}

/** Environment facts used only for dependency preflight. */
export interface TeamSkillEnvironment {
  /** Running DSH version. */
  readonly dshVersion: string
  /** Tool names available to the local DSH profile. */
  readonly availableTools: readonly string[]
  /** Locally registered MCP server names. */
  readonly availableMcpServers: readonly string[]
  /** Present environment variable names; values are never reported. */
  readonly presentEnvironmentVariableNames: readonly string[]
}

/** Browser request for one host-owned installation operation. */
export interface TeamSkillInstallRequest {
  /** Stable server Skill identity. */
  readonly skillId: string
  /** Immutable release version selected from server data. */
  readonly version: string
  /** Opaque project identity used for server-side resource authorization. */
  readonly projectId: string
  /** Local DSH installation root. */
  readonly scope: TeamSkillScope
  /** Opaque DSH workspace identity required only for project scope. */
  readonly workspaceId?: string
  /** Local preflight facts that contain no values or paths. */
  readonly environment: TeamSkillEnvironment
  /** Explicit user confirmation when replacing a modified managed copy. */
  readonly confirmModifiedReplace?: boolean
}

/** Short-lived service authorization for one immutable release artifact. */
export interface TeamSkillAuthorizedArtifact {
  /** Download URL authorized for this user, Skill and version. */
  readonly downloadUrl: string
  /** Download authorization expiry. */
  readonly expiresAt: string
  /** Archive SHA-256 from the server artifact record. */
  readonly sha256: string
  /** Expected ZIP size in bytes. */
  readonly sizeBytes: number
  /** Every allowed regular file and its digest. */
  readonly files: readonly TeamSkillFileDigest[]
}

/** Authorized installation operation returned before local writing begins. */
export interface TeamSkillAuthorizedOperation {
  /** Service-issued lifecycle operation identity. */
  readonly operationId: string
  /** Platform Skill identity. */
  readonly skillId: string
  /** Server-owned DSH runtime name. */
  readonly runtimeName: string
  /** Immutable target release version. */
  readonly version: string
  /** Download and integrity information. */
  readonly artifact: TeamSkillAuthorizedArtifact
}

/** One locally persisted, plugin-owned installation record. */
export interface TeamSkillInstallationRecord {
  /** Host-generated local installation identity; never contains a path. */
  readonly localInstallationId: string
  /** Server Team Skill identity. */
  readonly skillId: string
  /** Opaque server project identity used to authorize release status checks. */
  readonly projectId: string
  /** Install root selection. */
  readonly scope: TeamSkillScope
  /** Owning local workspace for project scope only. */
  readonly workspaceId?: string
  /** Private on-device file record. */
  readonly installed: InstalledTeamSkill
  /** ISO timestamp of the most recent successful local write. */
  readonly installedAt: string
}

/** Browser-safe summary of one locally managed Team Skill copy. */
export interface TeamSkillInstallationView {
  /** Host-generated local installation identity. */
  readonly localInstallationId: string
  /** Server Team Skill identity. */
  readonly skillId: string
  /** Opaque server project identity that authorized this local copy. */
  readonly projectId: string
  /** Install root selection. */
  readonly scope: TeamSkillScope
  /** Owning local workspace for project scope only. */
  readonly workspaceId?: string
  /** DSH runtime name. */
  readonly runtimeName: string
  /** Installed immutable release version. */
  readonly version: string
  /** Installed release archive digest. */
  readonly artifactSha256: string
  /** Current Host lifecycle state. */
  readonly state: InstalledTeamSkill['state']
  /** ISO timestamp of the most recent successful local write. */
  readonly installedAt: string
}

/** Action stage carried to the service audit trail without local paths. */
export type TeamSkillOperationStatus = 'downloading' | 'verifying' | 'writing' | 'refreshing' | 'succeeded' | 'failed' | 'cancelled'

/** User-displayable Host status when service configuration is incomplete. */
export interface TeamSkillNotReady {
  readonly status: 'not-ready'
  /** Missing configuration field names, never secret values. */
  readonly missing: readonly string[]
}

/** User-displayable Host failure. */
export interface TeamSkillFailed {
  readonly status: 'failed'
  /** Stable error code from the service or Host. */
  readonly code: string
  /** Safe action summary. */
  readonly message: string
  /** Service request id behind a service-reported failure, when it supplied one. */
  readonly requestId?: string
}

/** Result of a Team Skill catalog request. */
export type TeamSkillCatalogResult =
  | { readonly status: 'ready'; readonly catalog: TeamSkillCatalog }
  | TeamSkillNotReady
  | TeamSkillFailed
  | { readonly status: 'signed-out' }

/** A failed install; unlike a bare `TeamSkillFailed` it always explains the stage. */
export interface TeamSkillInstallFailure extends TeamSkillFailed {
  /** All seven stage entries, in vocabulary order. */
  readonly stages: readonly TeamSkillInstallStageEvidence[]
  /** Stage the install stopped at. */
  readonly failedStage: TeamSkillInstallStage
  /** Whether a plain retry can clear the failure, and how. */
  readonly retryable: TeamSkillInstallRetry
}

/** Result of an installation request; stage evidence accompanies both outcomes. */
export type TeamSkillInstallResult =
  | {
    readonly status: 'succeeded'
    readonly installation: TeamSkillInstallationView
    /** All seven stage entries, in vocabulary order. */
    readonly stages: readonly TeamSkillInstallStageEvidence[]
    /** No stage failed on a successful install. */
    readonly failedStage: null
    /** Retry guidance; a successful install is never retryable. */
    readonly retryable: TeamSkillInstallRetry
  }
  | TeamSkillInstallFailure
  | TeamSkillNotReady
  | { readonly status: 'signed-out' }

/** Request to remove one Host-managed local copy. */
export interface TeamSkillUninstallRequest {
  /** Host-generated local installation identity. */
  readonly localInstallationId: string
  /** Explicit confirmation when local files were changed. */
  readonly confirmModifiedReplace?: boolean
}

/** Result of a Host-managed uninstall. */
export type TeamSkillUninstallResult =
  | { readonly status: 'succeeded'; readonly installation: TeamSkillInstallationView }
  | TeamSkillNotReady
  | TeamSkillFailed

/** Browser-safe structured observability event vocabulary for the AI Coding collector. */

/** Current structured-event schema version accepted by the service. */
export const TELEMETRY_SCHEMA_VERSION = 1

/** The fixed first-phase event kinds; the service rejects every other kind. */
export type TelemetryEventKind =
  | 'session.started'
  | 'session.finished'
  | 'turn.started'
  | 'turn.finished'
  | 'step.started'
  | 'step.finished'
  | 'llm.request'
  | 'llm.response'
  | 'tool.call'
  | 'tool.result'
  | 'approval.requested'
  | 'approval.resolved'
  | 'compaction.completed'
  | 'agent.error'
  | 'delivery.gap'

/** Provable end states for runtime work; absent means the source proved none. */
export type TelemetryOutcome = 'success' | 'error' | 'interrupted' | 'cancelled' | 'blocked' | 'max_tokens'

/** Provider-reported token counts only; `totalTokens` stays null unless the provider stated it. */
export interface TelemetryTokenUsage {
  readonly inputTokens: number | null
  readonly outputTokens: number | null
  readonly totalTokens: number | null
}

/** Cleaned, length-limited error facts; never an exception object or stack. */
export interface TelemetryErrorDetail {
  readonly name: string
  readonly code?: string
  readonly summary?: string
}

/** The single approval decision vocabulary mapped from `approval/decided`. */
export interface TelemetryApprovalDetail {
  readonly decision?: 'allowed_once' | 'rejected' | 'cancelled' | 'unavailable'
}

/** Compaction label without any summary content. */
export interface TelemetryCompactionDetail {
  readonly kind?: string
}

/** Why observed data has a hole; gaps are events, never silent drops. */
export interface TelemetryGapDetail {
  readonly reason: 'overflow' | 'expired' | 'rejected' | 'manual_clear' | 'authorization_revoked'
  readonly count: number
  readonly firstEventId?: string
  readonly lastEventId?: string
}

/**
 * One versioned whitelist event. Fields not observed by the source are
 * omitted or null — never `0`, empty strings, or invented defaults. No
 * prompt, assistant reply, tool argument, tool result, command, file
 * content, absolute path, URL, credential, or raw exception value has a
 * field here by construction.
 */
export interface TelemetryEventDto {
  readonly schemaVersion: 1
  /** Stable logical identity; the service dedupes on it. */
  readonly eventId: string
  /** Host-persisted installation identity generated on first collector enablement. */
  readonly installationId: string
  /** Opaque active project the session was bound to. */
  readonly projectId: string
  /** DSH session id; null only for a cross-session delivery gap. */
  readonly sessionId: string | null
  readonly kind: TelemetryEventKind
  /** ISO 8601 UTC instant of the source fact. */
  readonly occurredAt: string
  /** DSH source event type or ops source label. */
  readonly sourceType: string
  readonly sourceSeq?: number
  readonly turn?: number
  readonly step?: number
  readonly durationMs?: number | null
  readonly outcome?: TelemetryOutcome
  readonly provider?: string | null
  readonly model?: string | null
  readonly toolName?: string | null
  readonly toolCategory?: string | null
  readonly callId?: string | null
  readonly approvalId?: string | null
  readonly compactionId?: string | null
  readonly retryable?: boolean | null
  readonly retryCount?: number | null
  readonly tokenUsage?: TelemetryTokenUsage
  readonly error?: TelemetryErrorDetail
  readonly approval?: TelemetryApprovalDetail
  readonly compaction?: TelemetryCompactionDetail
  readonly gap?: TelemetryGapDetail
}

/** One per-event classification returned by the batch endpoint. */
export type TelemetryEventAck =
  | { readonly eventId: string; readonly status: 'accepted' }
  | { readonly eventId: string; readonly status: 'duplicate' }
  | { readonly eventId: string; readonly status: 'retryable'; readonly retryAfterSeconds: number; readonly reason: string }
  | { readonly eventId: string; readonly status: 'rejected'; readonly reason: string }

/** Parsed batch response; unknown payload shapes fail parsing instead of passing as success. */
export interface TelemetryBatchResult {
  readonly batchId: string
  readonly serverReceivedAt: string
  readonly serverCheckpoint: string
  readonly results: readonly TelemetryEventAck[]
}

/** Collector operating mode reported to the plugin page. */
export type CollectorMode =
  | 'active'
  | 'paused'
  | 'not-ready'
  | 'signed-out'
  | 'authorization-revoked'
  | 'storage-error'
  | 'failed'

/** Authorization state of the currently bound project. */
export type CollectorAuthorizationState = 'authorized' | 'revoked' | 'unknown'

/** Restricted last-failure facts: codes, stage, time, and a bounded summary. */
export interface CollectorFailure {
  readonly stage: 'enqueue' | 'send' | 'parse' | 'storage'
  readonly code: string
  readonly at: string
  readonly summary: string
}

/** Browser-safe collector pipeline status returned through the Remote. */
export interface CollectorStatus {
  readonly mode: CollectorMode
  /** Currently selected collector project, when any. */
  readonly projectId: string | null
  readonly queueEventCount: number
  readonly queueByteCount: number
  readonly lastAcceptedAt: string | null
  readonly lastFailure: CollectorFailure | null
  readonly gapCount: number
  readonly authorizationState: CollectorAuthorizationState
  /** Records received at the collector entry for bound sessions, regardless
   * of account state. */
  readonly receivedEventCount: number
  /** Records that reached the collector for a bound session while no account
   * partition was publishable (authentication pending/isolated or signed
   * out) and were therefore not written to any partition. */
  readonly isolatedEventCount: number
  /** Set when the local queue could not be opened or migrated; sending stops. */
  readonly storageError: string | null
}

/** Result wrapper for collector control operations — failures are explicit, never void. */
export type CollectorResult<T> =
  | { readonly status: 'ready'; readonly value: T }
  | { readonly status: 'not-ready'; readonly missing: readonly string[] }
  | { readonly status: 'failed'; readonly code: string; readonly message: string }

/** Deployment-tunable collector queue settings, validated at Host load. */
export interface TelemetryQueueSettings {
  /** Maximum queued events across all account partitions. */
  readonly maxEvents: number
  /** Maximum queued payload bytes across all account partitions. */
  readonly maxBytes: number
  /** Maximum events in one outgoing batch. */
  readonly batchMaxEvents: number
  /** Maximum payload bytes in one outgoing batch. */
  readonly batchMaxBytes: number
  /** Idle interval before the reporter flushes pending events. */
  readonly flushIntervalMs: number
  /** Per-request HTTP timeout for batch delivery. */
  readonly httpTimeoutMs: number
  /** Send attempts per event before it becomes an `expired` gap. */
  readonly maxAttempts: number
  /** How long a batch claim (in-flight lease) stays valid before another queue handle may recover it. */
  readonly claimTimeoutMs: number
  /** How long unconfirmed events stay queued before an `expired` gap. */
  readonly retentionMs: number
}

/** One outgoing batch body for `POST /v1/telemetry/batches`. */
export interface TelemetryBatchRequest {
  readonly schemaVersion: 1
  readonly batchId: string
  readonly projectId: string
  readonly clientSentAt: string
  readonly events: readonly TelemetryEventDto[]
}

/** Collector control results merge the reporter state with queue totals. */
export type CollectorSnapshot = CollectorResult<CollectorStatus>

export * from './workspace-types.ts'
