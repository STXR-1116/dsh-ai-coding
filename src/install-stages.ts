/** Install-stage evidence vocabulary shared by the Host install flow and the browser. */

/** Closed vocabulary and fixed order of the seven install stages (§11.14). */
export const INSTALL_STAGES = [
  'authorization',
  'precheck',
  'download',
  'verify',
  'write',
  'discovery',
  'rollback',
] as const

/** One install stage name from the closed vocabulary. */
export type TeamSkillInstallStage = (typeof INSTALL_STAGES)[number]

/** Outcome of one install stage. */
export type TeamSkillInstallStageOutcome = 'succeeded' | 'failed' | 'skipped'

/** Evidence for one install stage; all seven always appear, in vocabulary order. */
export interface TeamSkillInstallStageEvidence {
  /** Stage name. */
  readonly stage: TeamSkillInstallStage
  /** Observed outcome; later stages are `skipped` once one has failed. */
  readonly outcome: TeamSkillInstallStageOutcome
  /** Non-empty evidence text for the operator. */
  readonly detail: string
}

/** Whether a failed install may be retried, and how. */
export interface TeamSkillInstallRetry {
  /** True only for failures that a plain retry can clear. */
  readonly retryable: boolean
  /** Operator-facing next step. */
  readonly how: string
}

/** Facts the Host collects while one install attempt runs. */
export interface InstallStageFacts {
  /** Stages that completed successfully, with their evidence text. */
  readonly succeeded: ReadonlyMap<TeamSkillInstallStage, string>
  /** The stage that failed, or null when the attempt succeeded. */
  readonly failedStage: TeamSkillInstallStage | null
  /** Evidence text for the failed stage; empty when nothing failed. */
  readonly failedDetail: string
  /** Outcome of the rollback stage: `skipped`, `succeeded`, or `failed`. */
  readonly rollback: TeamSkillInstallStageOutcome
  /** Rollback evidence text, shown even when rollback was skipped. */
  readonly rollbackDetail: string
}

/**
 * Build the seven-stage evidence list for one install attempt.
 *
 * Every stage in {@link INSTALL_STAGES} appears exactly once, in vocabulary
 * order. A stage is `succeeded` only when it is recorded in `succeeded`; the
 * failed stage is `failed`; every other stage is `skipped`, so a reader can
 * never mistake an unrun stage for a passing one.
 * @param facts - outcomes collected during the attempt.
 * @returns the seven stage entries in vocabulary order.
 */
export function buildInstallStages(facts: InstallStageFacts): readonly TeamSkillInstallStageEvidence[] {
  return INSTALL_STAGES.map((stage) => {
    if (stage === 'rollback') {
      return {
        stage,
        outcome: facts.rollback,
        detail: facts.rollbackDetail.length > 0 ? facts.rollbackDetail : '本次安装未发生回滚。',
      }
    }
    if (facts.failedStage === stage) {
      return { stage, outcome: 'failed' as const, detail: facts.failedDetail }
    }
    const detail = facts.succeeded.get(stage)
    return detail === undefined
      ? { stage, outcome: 'skipped' as const, detail: '前序阶段失败，本阶段未执行。' }
      : { stage, outcome: 'succeeded' as const, detail }
  })
}

/** Classification of one install failure: which stage failed and whether a retry can clear it. */
export interface InstallFailureClass {
  /** Stage the failure is attributed to. */
  readonly stage: Extract<TeamSkillInstallStage, 'authorization' | 'precheck' | 'download' | 'verify' | 'write' | 'discovery'>
  /** Retry guidance for the operator. */
  readonly retryable: TeamSkillInstallRetry
}

/**
 * Classify a failed install by its stable service error code (§11.14).
 *
 * The mapping is fixed and code-driven: authorization denials and hidden
 * resources fail `authorization`, request-validation and idempotency conflicts
 * fail `precheck`, an unavailable dependency also fails `precheck` but stays
 * retryable. Codes outside the mapping are local failures attributed to the
 * stage that was running, never guessed into an earlier stage.
 * @param code - stable error code from the Host or the service.
 * @param runningStage - stage that was executing when the failure surfaced.
 * @returns the failed stage and retry guidance.
 */
export function classifyInstallFailure(
  code: string,
  runningStage: Extract<TeamSkillInstallStage, 'authorization' | 'precheck' | 'download' | 'verify' | 'write' | 'discovery'>,
): InstallFailureClass {
  const authorizationCodes = new Set([
    'SKILL_ORGANIZATION_FORBIDDEN',
    'SKILL_NOT_PROJECT_ASSET',
    'INSTALL_AUTHORIZATION_REVOKED',
    'INSTALL_AUTHORIZATION_REQUIRED',
    'PROJECT_NOT_AUTHORIZED',
    'PROJECT_NOT_MEMBER',
    'PROJECT_CONTEXT_MISMATCH',
    'RESOURCE_NOT_FOUND',
    'NOT_FOUND',
  ])
  if (authorizationCodes.has(code)) {
    return {
      stage: 'authorization',
      retryable: { retryable: false, how: '该账号或项目无权安装此版本；请确认版本已发布并已绑定到当前项目。' },
    }
  }
  const validationCodes = new Set([
    'IDEMPOTENCY_CONFLICT',
    'REVISION_CONFLICT',
    'VALIDATION_ERROR',
    'VALIDATION_REQUIRED',
    'INVALID_STATUS',
  ])
  if (validationCodes.has(code)) {
    return { stage: 'precheck', retryable: { retryable: false, how: '请求与环境未通过校验；请修正后重新发起安装。' } }
  }
  if (code === 'UPSTREAM_UNAVAILABLE' || code === 'SERVICE_UNAVAILABLE' || code === 'UPSTREAM_ERROR') {
    // The service being unavailable says how to retry, not where the attempt stopped.
    // It is attributed to precheck only while the authorization request — which is
    // where the service performs its own validation — is what failed; once the
    // attempt has advanced, the running stage holds the evidence and a download
    // failure must not be reported as a precheck failure.
    return {
      stage: runningStage === 'authorization' ? 'precheck' : runningStage,
      retryable: { retryable: true, how: '依赖服务暂不可用；稍后重试即可。' },
    }
  }
  if (runningStage === 'download') {
    return { stage: 'download', retryable: { retryable: true, how: '制品下载失败；请重试安装。' } }
  }
  if (runningStage === 'verify') {
    return { stage: 'verify', retryable: { retryable: false, how: '制品校验未通过；请联系发布者重新发布该版本。' } }
  }
  return { stage: runningStage, retryable: { retryable: false, how: '本地操作失败；请检查本地安装目录权限后重试。' } }
}
