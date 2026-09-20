import type { TeamSkillInstallStageEvidence, TeamSkillTrustCard } from '../../types.ts'

/** One labelled row of the trust card, ready to render. */
export interface TrustCardRow {
  /** Stable row key. */
  readonly key: string
  /** Chinese label shown to the user. */
  readonly label: string
  /** Display value; never empty — absence is spelled out instead. */
  readonly value: string
}

/** One section of the trust card. */
export interface TrustCardSection {
  /** Stable section key. */
  readonly key: string
  /** Chinese section title. */
  readonly title: string
  /** Rows in display order. */
  readonly rows: readonly TrustCardRow[]
}

/** Labels for the closed tool-permission vocabulary. */
const TOOL_PERMISSION_LABELS: Readonly<Record<string, string>> = Object.freeze({
  bash: '执行命令',
  read_file: '读取文件',
  write_file: '写入文件',
  web_fetch: '访问网络',
  subprocess: '启动子进程',
})

/** Labels for the closed install-stage vocabulary. */
const INSTALL_STAGE_LABELS: Readonly<Record<string, string>> = Object.freeze({
  authorization: '授权',
  precheck: '预检',
  download: '下载',
  verify: '校验',
  write: '写入',
  discovery: '运行时发现',
  rollback: '回滚',
})

/** Labels for stage outcomes. */
const STAGE_OUTCOME_LABELS: Readonly<Record<string, string>> = Object.freeze({
  succeeded: '已完成',
  failed: '失败',
  skipped: '未执行',
})

/**
 * Build the trust-card sections shown before an install.
 *
 * Every field of the card appears: a release that requests no tool permission
 * says so, rather than showing an empty section that reads as missing data.
 * @param card - Server trust card for one published release.
 * @returns sections in display order.
 */
export function trustCardSections(card: TeamSkillTrustCard): readonly TrustCardSection[] {
  const permissions = card.toolPermissions.length === 0
    ? '不申请任何工具权限'
    : card.toolPermissions.map(permission => TOOL_PERMISSION_LABELS[permission] ?? permission).join('、')
  const hosts = card.externalAccess.network
    ? card.externalAccess.hosts.join('、')
    : '不访问外部网络'
  return Object.freeze([
    {
      key: 'publisher',
      title: '发布者',
      rows: Object.freeze([
        { key: 'name', label: '发布者', value: card.publisher.name },
        { key: 'organization', label: '组织', value: card.publisher.organizationId },
        { key: 'version', label: '版本', value: `${card.displayName} · ${card.version}` },
      ]),
    },
    {
      key: 'signature',
      title: '签名',
      rows: Object.freeze([
        { key: 'algorithm', label: '算法', value: card.signature.algorithm },
        { key: 'key', label: '密钥', value: card.signature.keyId },
        { key: 'fingerprint', label: '指纹', value: card.signature.fingerprint },
        { key: 'signed_at', label: '签名时间', value: card.signature.signedAt },
      ]),
    },
    {
      key: 'scope',
      title: '权限与范围',
      rows: Object.freeze([
        { key: 'permissions', label: '工具权限', value: permissions },
        { key: 'roots', label: '文件范围', value: `${card.fileScope.roots.join('、')}（最多 ${card.fileScope.maxFiles} 个文件 / ${card.fileScope.maxBytes} 字节）` },
        { key: 'external', label: '外部访问', value: hosts },
      ]),
    },
    {
      key: 'audits',
      title: '最近审计',
      rows: card.recentAudits.length === 0
        ? Object.freeze([{ key: 'none', label: '最近审计', value: '暂无可显示的治理审计记录' }])
        : Object.freeze(
          card.recentAudits.map((audit, index) => ({
            key: `audit-${String(index)}`,
            label: audit.action,
            value: `${audit.outcome === 'succeeded' ? '成功' : '失败'} · ${audit.actorName} · ${audit.at} · ${audit.requestId}`,
          })),
        ),
    },
  ])
}

/** One install-stage row ready to render. */
export interface InstallStageRow {
  /** Stage name from the closed vocabulary. */
  readonly stage: string
  /** Chinese stage label. */
  readonly label: string
  /** Outcome label; a skipped stage is never shown as completed. */
  readonly outcome: string
  /** Raw outcome, so renderers can key stable attributes off the wire value. */
  readonly rawOutcome: 'succeeded' | 'failed' | 'skipped'
  /** Evidence text for this stage. */
  readonly detail: string
}

/**
 * Project the seven install stages into display rows.
 *
 * The rows come straight from the Host evidence, in its order; this function
 * never reorders, drops or promotes a stage, so what the user reads is exactly
 * what was recorded.
 * @param stages - Stage evidence attached to one install result.
 * @returns one row per stage, in the order received.
 */
export function installStageRows(stages: readonly TeamSkillInstallStageEvidence[]): readonly InstallStageRow[] {
  return Object.freeze(
    stages.map(stage => ({
      stage: stage.stage,
      label: INSTALL_STAGE_LABELS[stage.stage] ?? stage.stage,
      outcome: STAGE_OUTCOME_LABELS[stage.outcome] ?? stage.outcome,
      rawOutcome: stage.outcome,
      detail: stage.detail,
    })),
  )
}

/** User-visible state of one locally installed release. */
export type InstalledStateLabel = '已安装' | '需要更新' | '已撤销' | '已卸载'

/**
 * Derive the user-visible state of one installed release.
 *
 * A quarantined copy is reported as 已撤销 even when the catalog still lists the
 * same version, and an outdated copy as 需要更新 — both must be distinguishable
 * from a healthy install, which is why neither collapses into a generic state.
 * @param localState - Local copy state recorded by the Host.
 * @param installedVersion - Version written on disk.
 * @param publishedVersion - Version the catalog currently offers, when known.
 * @returns the state label for the installation list.
 */
export function installedStateLabel(
  localState: 'normal' | 'withdrawn' | 'uninstalled',
  installedVersion: string,
  publishedVersion: string | undefined,
): InstalledStateLabel {
  if (localState === 'withdrawn') return '已撤销'
  if (localState === 'uninstalled') return '已卸载'
  if (publishedVersion !== undefined && publishedVersion !== installedVersion) return '需要更新'
  return '已安装'
}
