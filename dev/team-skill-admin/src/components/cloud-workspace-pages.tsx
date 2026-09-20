'use client'

/** 云工作空间管理域页面：Agent 配置治理、Workspace 运维、Run 检索与统一审计。 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { classifyAbnormalWorkspaces } from '../lib/workspace-ops'
import { assetHealthRows, mergeAssetHealth } from '../lib/asset-health'
import { RunEvidencePanel } from './run-evidence-panel'
import { CloudWorkspaceStream, type CloudStreamStatus } from '../lib/cloud-workspace-stream.ts'
import type { CloudAgentProfile, CloudAgentProfileVersion, CloudAgentType, CloudAssetCandidate, CloudRun, CloudWorkspace, CloudWorkspaceAudit } from '../lib/team-skill-types'
import type { ApiResult, TeamSkillApi } from '../lib/team-skill-api'
import { capabilityFromResult, type CloudCapability, type CloudCapabilityStatus } from '../lib/cloud-capability'
import { Empty, Loading } from './admin-states'

/** Pages a relation-chain link may jump to along 项目→Profile→Workspace→Run→审计. */
export type CloudRelationTarget = 'cloud-runs' | 'cloud-audits' | 'cloud-profiles' | 'cloud-types' | 'cloud-ops'

/**
 * 关系链跳转携带的对象上下文：操作者当时所在对象的 ID 与筛选条件。
 * 目标页据此直接选中对应行/详情，而不是让操作者重新寻找对象。
 */
export type CloudRelationFocus = {
  readonly workspaceId?: string
  readonly runId?: string
  readonly agentProfileVersionId?: string
  readonly requestId?: string
}

/** 一次关系链跳转：目标页面 + 需要恢复的对象上下文。 */
export type CloudRelationJump = {
  readonly target: CloudRelationTarget
  readonly focus: CloudRelationFocus
}

/** 只保留存在的字段：避免把 `undefined` 写进精确可选属性的对象。 */
function focusOf(
  workspaceId: string | undefined,
  extra: { readonly runId?: string; readonly agentProfileVersionId?: string; readonly requestId?: string } = {},
): CloudRelationFocus {
  return {
    ...(workspaceId === undefined || workspaceId === '' ? {} : { workspaceId }),
    ...(extra.runId === undefined || extra.runId === '' ? {} : { runId: extra.runId }),
    ...(extra.agentProfileVersionId === undefined || extra.agentProfileVersionId === ''
      ? {}
      : { agentProfileVersionId: extra.agentProfileVersionId }),
    ...(extra.requestId === undefined || extra.requestId === '' ? {} : { requestId: extra.requestId }),
  }
}

interface PageProps {
  readonly api: TeamSkillApi
  readonly onAction: (result: ApiResult<unknown>, success: string) => void
  /** Jump along the relation chain; the shell routes the target page and the object context. */
  readonly onNavigate?: (jump: CloudRelationJump) => void
  /** 由 URL 或关系链跳转恢复的对象上下文。 */
  readonly focus?: CloudRelationFocus | undefined
}

/**
 * 关系链来源说明：目标页要能解释「为什么这里已经选中了某个对象」。
 * 没有来源 Workspace 时不渲染。
 */
function RelationContextNote({ focus }: { readonly focus: CloudRelationFocus | undefined }) {
  if (focus === undefined || focus.workspaceId === undefined) return null
  return (
    <p className="relation-context" data-relation-context="true" role="status">
      来自 Workspace {focus.workspaceId}
      {focus.runId === undefined ? '' : ` · Run ${focus.runId}`}
      {focus.agentProfileVersionId === undefined ? '' : ` · Profile Version ${focus.agentProfileVersionId}`}
      {focus.requestId === undefined ? '' : ` · 审计请求 ${focus.requestId}`}
    </p>
  )
}

/**
 * 关系链目标对象不在服务端结果里时的显式失败：越权或对象不存在不得以空列表代替。
 */
function RelationTargetMissing({ focus, message }: { readonly focus: CloudRelationFocus | undefined; readonly message: string }) {
  if (focus === undefined) return null
  return (
    <p className="relation-missing" data-relation-missing="true" role="alert">
      {message}
    </p>
  )
}

function idempotencyKey(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

/** 非成功状态：这些状态下页面不得把空表/空详情当成成功展示。 */
const NON_SUCCESS_STATUSES: ReadonlySet<CloudCapabilityStatus> = new Set(['not-ready', 'failed', 'blocked'])

/**
 * 服务端声明的能力状态条。每个云工作空间功能都要有一行，
 * 状态只来自服务端响应证据（fixture 头 / 业务码 / envelope 协议校验）。
 */
function CapabilityStrip({ capabilities }: { readonly capabilities: readonly CloudCapability[] }) {
  return (
    <table className="admin-table capability-table" aria-label="云工作空间能力状态" data-capability-table="true">
      <caption>服务端声明的能力状态（非生产成功声明）</caption>
      <thead>
        <tr>
          <th>功能</th>
          <th>状态</th>
          <th>服务端声明</th>
        </tr>
      </thead>
      <tbody>
        {capabilities.map(capability => (
          <tr
            key={capability.fn}
            data-capability={capability.fn}
            data-status={capability.status}
            data-empty={capability.empty ? 'true' : 'false'}
          >
            <td>{capability.label}</td>
            <td className="capability-status">能力状态：{capability.text}</td>
            <td>{capability.detail}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

/** 失败/阻塞时的显式提示：空数据不得被读成成功。 */
function CapabilityFailureNote({ capability }: { readonly capability: CloudCapability | undefined }) {
  if (capability === undefined || !NON_SUCCESS_STATUSES.has(capability.status)) return null
  return (
    <p className="capability-failure" data-capability-failure="true" role="alert">
      {capability.label} 未取得可用服务端数据（{capability.text}）：{capability.detail}
    </p>
  )
}

const LIFECYCLE_LABEL: Record<string, string> = {
  draft: '草稿',
  provisioning: '初始化中',
  starting: '启动中',
  ready: 'ready',
  degraded: '降级',
  stopping: '停止中',
  stopped: '已停止',
  failed: '失败',
  archived: '已归档',
  deleting: '删除中',
}

/** Agent 配置治理：卡片列表、筛选、草稿/版本/发布/归档/复制、项目绑定与实时刷新。 */
/** Whether the candidates read succeeded; failures stay visible, never silent. */
type CandidatesState = 'loading' | 'ready' | 'failed'

/** Execution-policy fields the service accepts on drafts and new versions. */
interface PolicyFields {
  readonly permissionMode: string
  readonly writeMode: string
  readonly maxConcurrency: string
  readonly budget: string
  readonly timeoutMs: string
  readonly toolAllowlist: string
}

const EMPTY_POLICY: PolicyFields = { permissionMode: 'approval', writeMode: 'write', maxConcurrency: '2', budget: '200000', timeoutMs: '900000', toolAllowlist: '' }

/** Renders a policy value as form text without relying on default stringification. */
const policyText = (value: unknown, fallback: string): string => {
  if (typeof value === 'string') return value
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return fallback
}

const policyFromFields = (fields: PolicyFields): Record<string, unknown> => {
  const tools = fields.toolAllowlist
    .split(/[,，]/u)
    .map(tool => tool.trim())
    .filter(tool => tool.length > 0)
  return {
    permission_mode: fields.permissionMode,
    write_mode: fields.writeMode,
    tool_allowlist: tools,
    max_concurrency: Number(fields.maxConcurrency),
    budget: Number(fields.budget),
    timeout_ms: Number(fields.timeoutMs),
  }
}

/** One ordered, required-flagged asset selection row inside a form. */
interface AssetSelection {
  readonly assetId: string
  readonly required: boolean
}

const selectionToBindings = (
  skills: readonly AssetSelection[],
  knowledge: readonly AssetSelection[],
  memory: AssetSelection | null,
): Record<string, unknown> => ({
  skills: skills.map((entry, index) => ({ asset_version_id: entry.assetId, required: entry.required, order: index + 1 })),
  knowledge_bases: knowledge.map((entry, index) => ({ asset_version_id: entry.assetId, required: entry.required, order: index + 1 })),
  memory: memory === null ? null : { asset_version_id: memory.assetId, required: memory.required },
})

/** List bindings of one wire version into form selection state. */
const bindingsFromVersion = (version: CloudAgentProfileVersion): {
  readonly skills: AssetSelection[]
  readonly knowledge: AssetSelection[]
  readonly memory: AssetSelection | null
} => ({
  skills: version.asset_bindings.skills.map(entry => ({ assetId: entry.asset_version_id, required: entry.required })),
  knowledge: version.asset_bindings.knowledge_bases.map(entry => ({ assetId: entry.asset_version_id, required: entry.required })),
  memory:
    version.asset_bindings.memory === null
      ? null
      : { assetId: version.asset_bindings.memory.asset_version_id, required: version.asset_bindings.memory.required },
})

/**
 * 草稿编辑器里**尚未保存**的一整套字段。
 *
 * 编辑器不能直接绑定服务端列表里的版本对象：冲突或失败后页面要重读权威列表，
 * 而重读会把对象换掉，操作者尚未保存的输入就随之消失。把未保存状态单独放一份，
 * 重读便只更新「服务端版本」那一侧。
 */
interface DraftEditState {
  readonly model: string
  readonly reasoning: string
  readonly policy: PolicyFields
  readonly skills: readonly AssetSelection[]
  readonly knowledge: readonly AssetSelection[]
  readonly memory: AssetSelection | null
  readonly extensions: Record<string, unknown>
  readonly credentialName: string
  readonly credentialKind: string
}

/** 未保存状态的初值：编辑器的起点是服务端当前草稿版本。 */
const draftEditFrom = (version: CloudAgentProfileVersion): DraftEditState => ({
  model: version.model,
  reasoning: version.reasoning,
  policy: {
    permissionMode: policyText(version.execution_policy.permission_mode, 'approval'),
    writeMode: policyText(version.execution_policy.write_mode, 'write'),
    maxConcurrency: policyText(version.execution_policy.max_concurrency, '2'),
    budget: policyText(version.execution_policy.budget, '200000'),
    timeoutMs: policyText(version.execution_policy.timeout_ms, '900000'),
    toolAllowlist: Array.isArray(version.execution_policy.tool_allowlist) ? version.execution_policy.tool_allowlist.join(', ') : '',
  },
  skills: bindingsFromVersion(version).skills,
  knowledge: bindingsFromVersion(version).knowledge,
  memory: bindingsFromVersion(version).memory,
  extensions: { ...version.type_extension_config },
  credentialName: version.credential_ref?.name ?? '',
  credentialKind: version.credential_ref?.kind ?? 'api_key',
})

/** 未保存状态 → 写请求的资产结构（与新建草稿/新版本同一条契约）。 */
const draftEditBindings = (edit: DraftEditState): Record<string, unknown> =>
  selectionToBindings([...edit.skills], [...edit.knowledge], edit.memory)

/** 未保存状态 → 写请求的执行策略。 */
const draftEditPolicy = (edit: DraftEditState): Record<string, unknown> => policyFromFields(edit.policy)

/**
 * 未保存状态与服务端当前草稿版本的逐字段差异：只列出真正不同的字段，
 * 用于冲突时把「本地未保存的修改」与「服务端现状」并排展示。
 */
const draftEditDiffRows = (
  edit: DraftEditState,
  serverVersion: CloudAgentProfileVersion,
): readonly (readonly [string, string, string])[] => {
  const server = draftEditFrom(serverVersion)
  const rows: (readonly [string, string, string])[] = []
  const text = (value: unknown): string => (typeof value === 'string' ? value : JSON.stringify(value))
  const fields: readonly (readonly [string, unknown, unknown])[] = [
    ['模型', edit.model, server.model],
    ['推理', edit.reasoning, server.reasoning],
    ['策略', edit.policy, server.policy],
    ['Skill 绑定', edit.skills, server.skills],
    ['知识库绑定', edit.knowledge, server.knowledge],
    ['记忆库', edit.memory, server.memory],
    ['类型扩展', edit.extensions, server.extensions],
    ['凭据引用', { name: edit.credentialName, kind: edit.credentialKind }, { name: server.credentialName, kind: server.credentialKind }],
  ]
  for (const [label, local, remote] of fields) {
    if (text(local) !== text(remote)) rows.push([label, text(local), text(remote)])
  }
  return rows
}

/** Shared model/reasoning/policy fields for draft, edit and new-version forms. */
function VersionFields({ model, reasoning, policy, onChange }: {
  model: string
  reasoning: string
  policy: PolicyFields
  onChange: (next: { model?: string; reasoning?: string; policy?: PolicyFields }) => void
}) {
  return (
    <>
      <label className="inline-field">
        模型
        <input aria-label="配置模型" value={model} onChange={(event) => { onChange({ model: event.target.value }) }} />
      </label>
      <label className="inline-field">
        推理档位
        <select
          aria-label="配置推理"
          value={reasoning}
          onChange={(event) => { onChange({ reasoning: event.target.value }) }}
        >
          {['low', 'medium', 'high'].map(level => <option key={level} value={level}>{level}</option>)}
        </select>
      </label>
      <label className="inline-field">
        权限模式
        <select
          aria-label="配置权限模式"
          value={policy.permissionMode}
          onChange={(event) => { onChange({ policy: { ...policy, permissionMode: event.target.value } }) }}
        >
          <option value="approval">approval</option>
          <option value="auto">auto</option>
          <option value="read_only">read_only</option>
        </select>
      </label>
      <label className="inline-field">
        默认写入能力
        <select
          aria-label="配置写入能力"
          value={policy.writeMode}
          onChange={(event) => { onChange({ policy: { ...policy, writeMode: event.target.value } }) }}
        >
          <option value="write">允许写入（write）</option>
          <option value="read_only">只读（read_only）</option>
        </select>
      </label>
      <label className="inline-field">
        最大并发
        <input
          aria-label="配置最大并发"
          type="number"
          min="1"
          value={policy.maxConcurrency}
          onChange={(event) => { onChange({ policy: { ...policy, maxConcurrency: event.target.value } }) }}
        />
      </label>
      <label className="inline-field">
        Token 预算
        <input
          aria-label="配置预算"
          type="number"
          min="1"
          value={policy.budget}
          onChange={(event) => { onChange({ policy: { ...policy, budget: event.target.value } }) }}
        />
      </label>
      <label className="inline-field">
        超时(ms)
        <input
          aria-label="配置超时"
          type="number"
          min="1"
          value={policy.timeoutMs}
          onChange={(event) => { onChange({ policy: { ...policy, timeoutMs: event.target.value } }) }}
        />
      </label>
      <label className="inline-field">
        工具白名单
        <input
          aria-label="配置工具白名单"
          value={policy.toolAllowlist}
          placeholder="逗号分隔，留空表示服务端未声明"
          onChange={(event) => { onChange({ policy: { ...policy, toolAllowlist: event.target.value } }) }}
        />
      </label>
    </>
  )
}

/** 记忆库选择器：第一项固定为"不使用记忆库"，未选择保存为 null，绝不隐式选择默认。 */
function MemoryPicker({ candidates, value, onChange }: {
  candidates: readonly CloudAssetCandidate[]
  value: AssetSelection | null
  onChange: (next: AssetSelection | null) => void
}) {
  const usable = candidates.filter(candidate => candidate.asset_type === 'memory')
  return (
    <label className="inline-field">
      资产-记忆库
      <select
        aria-label="资产-记忆库"
        value={value === null ? '' : value.assetId}
        onChange={(event) => {
          onChange(event.target.value === '' ? null : { assetId: event.target.value, required: true })
        }}
      >
        <option value="">不使用记忆库</option>
        {usable.map(candidate => (
          <option key={candidate.asset_id} value={candidate.asset_id} disabled={!(candidate.authorized && candidate.readiness === 'ready')}>
            {candidate.name}（{candidate.version}）{candidate.authorized && candidate.readiness === 'ready' ? '' : '：不可用'}
          </option>
        ))}
      </select>
    </label>
  )
}

/** Skill 多选（有序、可排序、可标记必需）与知识库多选共用一个候选分组。 */
function OrderedAssetPicker({ candidates, assetType, selected, onToggle, onMove, onToggleRequired }: {
  candidates: readonly CloudAssetCandidate[]
  assetType: 'skill' | 'knowledge'
  selected: readonly AssetSelection[]
  onToggle: (assetId: string) => void
  onMove: (assetId: string, direction: -1 | 1) => void
  onToggleRequired: (assetId: string) => void
}) {
  const usable = candidates.filter(candidate => candidate.asset_type === assetType)
  const selectedIds = new Set(selected.map(entry => entry.assetId))
  const nameOf = (assetId: string): string => usable.find(candidate => candidate.asset_id === assetId)?.name ?? assetId
  const dragSource = useRef<string | null>(null)
  return (
    <div className="asset-group">
      {usable.map((candidate) => {
        const usableRow = candidate.authorized && candidate.readiness === 'ready'
        if (assetType === 'skill') {
          return (
            <label key={candidate.asset_id} className="asset-option" title={candidate.invalid_reason ?? undefined}>
              <input
                type="checkbox"
                aria-label={`资产-${candidate.name}`}
                checked={selectedIds.has(candidate.asset_id)}
                disabled={!usableRow}
                onChange={() => { onToggle(candidate.asset_id) }}
              />
              {candidate.name}（{candidate.version}）
              {!usableRow && <small>{candidate.invalid_reason ?? '不可用'}</small>}
            </label>
          )
        }
        return (
          <button
            key={candidate.asset_id}
            type="button"
            className={selectedIds.has(candidate.asset_id) ? 'asset-chip selected' : 'asset-chip'}
            aria-label={`资产-${candidate.name}`}
            disabled={!usableRow}
            title={candidate.invalid_reason ?? undefined}
            onClick={() => { onToggle(candidate.asset_id) }}
          >
            {candidate.name}（{candidate.version}）{selectedIds.has(candidate.asset_id) ? ' ✓' : ''}
            {!usableRow && <small>{candidate.invalid_reason ?? '不可用'}</small>}
          </button>
        )
      })}
      {selected.length > 0 && (
        <ol className="asset-order">
          {selected.map((entry, index) => (
            <li
              key={entry.assetId}
              draggable
              onDragStart={() => { dragSource.current = entry.assetId }}
              onDragOver={(event) => { event.preventDefault() }}
              onDrop={(event) => {
                event.preventDefault()
                const source = dragSource.current
                dragSource.current = null
                if (source === null || source === entry.assetId) return
                const from = selected.findIndex(item => item.assetId === source)
                onMove(source, from < index ? 1 : -1)
              }}
            >
              <span>{nameOf(entry.assetId)}</span>
              <label className="inline-field">
                必需-{nameOf(entry.assetId)}
                <input
                  type="checkbox"
                  aria-label={`必需-${nameOf(entry.assetId)}`}
                  checked={entry.required}
                  onChange={() => { onToggleRequired(entry.assetId) }}
                />
              </label>
              <button type="button" aria-label={`上移-${nameOf(entry.assetId)}`} disabled={index === 0} onClick={() => { onMove(entry.assetId, -1) }}>上移</button>
              <button type="button" aria-label={`下移-${nameOf(entry.assetId)}`} disabled={index === selected.length - 1} onClick={() => { onMove(entry.assetId, 1) }}>下移</button>
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}

/** Schema-driven type-extension fields: labels, enums and ranges come from the server. */
function ExtensionFields({ agentType, value, onChange }: {
  agentType: CloudAgentType | undefined
  value: Readonly<Record<string, unknown>>
  onChange: (next: Record<string, unknown>) => void
}) {
  if (agentType === undefined) {
    return <p className="fixture-note" data-state="schema-unknown">未知的 Agent 类型：服务未返回该类型的扩展 schema。</p>
  }
  const schema = agentType.schema ?? []
  if (schema.length === 0) return null
  return (
    <div className="extension-fields" aria-label={`扩展字段-${agentType.key}`}>
      {schema.map((field) => {
        const current = value[field.key]
        const set = (next: unknown): void => {
          // Removal rebuilds the object without the key; a bare `delete` on a
          // computed key is both a lint violation and a mutation hazard here.
          const draft: Record<string, unknown> = { ...value }
          if (next === '' || next === undefined) {
            const { [field.key]: _removed, ...rest } = draft
            onChange(rest)
            return
          }
          draft[field.key] = next
          onChange(draft)
        }
        return (
          <label key={field.key} className="inline-field">
            扩展-{field.key}（{field.label}
            {field.required ? '·必填' : ''}
            {field.affects_publish ? '·发布校验' : ''}）
            {field.type === 'enum' ? (
              <select aria-label={`扩展-${field.key}`} value={typeof current === 'string' ? current : ''} onChange={(event) => { set(event.target.value) }}>
                <option value="">未设置</option>
                {(field.enum ?? []).map(option => <option key={option} value={option}>{option}</option>)}
              </select>
            ) : field.type === 'number' ? (
              <input
                aria-label={`扩展-${field.key}`}
                type="number"
                {...(field.min === undefined ? {} : { min: field.min })}
                {...(field.max === undefined ? {} : { max: field.max })}
                value={typeof current === 'number' ? String(current) : ''}
                onChange={(event) => { set(event.target.value === '' ? '' : Number(event.target.value)) }}
              />
            ) : field.type === 'boolean' ? (
              <select aria-label={`扩展-${field.key}`} value={typeof current === 'boolean' ? String(current) : ''} onChange={(event) => { set(event.target.value === '' ? '' : event.target.value === 'true') }}>
                <option value="">未设置</option>
                <option value="true">true</option>
                <option value="false">false</option>
              </select>
            ) : (
              <input aria-label={`扩展-${field.key}`} value={typeof current === 'string' ? current : ''} onChange={(event) => { set(event.target.value) }} />
            )}
          </label>
        )
      })}
    </div>
  )
}

/** 草稿/新版本表单共享的资产、扩展与凭据状态。 */
interface DraftAssetState {
  readonly skills: AssetSelection[]
  readonly knowledge: AssetSelection[]
  readonly memory: AssetSelection | null
  readonly extensions: Record<string, unknown>
  readonly credentialName: string
  readonly credentialKind: string
}

/** 凭据引用的服务端注册表只认这些类型；表单显式显示缺省值而不是留空。 */
const CREDENTIAL_KINDS = ['api_key', 'connection'] as const

/**
 * 一次写请求是否因 revision 竞争被拒绝。
 *
 * 服务端的 409 会以两种形态到达客户端：分类后的 `revision-conflict`，
 * 或带 `REVISION_CONFLICT` 业务码的 service 失败。两者都必须走同一条
 * 「保留本地修改 + 展示服务端差异」的路径，不能有一种被当成普通错误。
 */
const isRevisionConflict = (result: ApiResult<unknown>): boolean =>
  !result.ok
  && (result.error.kind === 'revision-conflict'
    || (result.error.kind === 'service' && result.error.code === 'REVISION_CONFLICT'))

function credentialRefOf(state: Pick<DraftAssetState, 'credentialName' | 'credentialKind'>): Record<string, unknown> | null {
  if (state.credentialName.trim() === '') return null
  return { name: state.credentialName.trim(), kind: state.credentialKind.trim() === '' ? 'api_key' : state.credentialKind.trim() }
}

/**
 * 凭据引用控件。
 *
 * claude_code 等类型在服务端声明 `credential_required`，发布校验会拒绝缺失凭据的版本
 * （CREDENTIAL_NOT_READY）。没有这组控件时，用页面控件创建的草稿永远无法发布——
 * 页面状态里虽有 credentialName/credentialKind，却没有任何入口能写它。
 * 只提交 name/kind：authorized 与 readiness 由服务端凭据注册表拥有，客户端不得断言。
 */
function CredentialFields({ name, kind, nameLabel, kindLabel, onChange }: {
  name: string
  kind: string
  nameLabel: string
  kindLabel: string
  onChange: (next: { name?: string; kind?: string }) => void
}) {
  return (
    <>
      <label className="inline-field">
        凭据引用名称（留空表示该版本不使用凭据）
        <input aria-label={nameLabel} value={name} onChange={(event) => { onChange({ name: event.target.value }) }} />
      </label>
      <label className="inline-field">
        凭据引用类型
        <select aria-label={kindLabel} value={kind} onChange={(event) => { onChange({ kind: event.target.value }) }}>
          {CREDENTIAL_KINDS.map(option => <option key={option} value={option}>{option}</option>)}
        </select>
      </label>
    </>
  )
}

const EMPTY_ASSETS: DraftAssetState = { skills: [], knowledge: [], memory: null, extensions: {}, credentialName: '', credentialKind: 'api_key' }

export function CloudProfilesPage({ api, onAction, focus }: PageProps) {
  const [profiles, setProfiles] = useState<readonly CloudAgentProfile[]>([])
  const [agentTypes, setAgentTypes] = useState<readonly CloudAgentType[]>([])
  const [bindProject, setBindProject] = useState('project-alpha')
  const [candidates, setCandidates] = useState<readonly CloudAssetCandidate[]>([])
  const [candidatesState, setCandidatesState] = useState<CandidatesState>('loading')
  const [diffSelection, setDiffSelection] = useState<Record<string, { base: string; target: string }>>({})
  const [draftName, setDraftName] = useState('')
  const [draftAgentTypeId, setDraftAgentTypeId] = useState('')
  const [draftModel, setDraftModel] = useState('deepseek-v3.2')
  const [draftReasoning, setDraftReasoning] = useState('medium')
  const [draftPolicy, setDraftPolicy] = useState<PolicyFields>(EMPTY_POLICY)
  const [draftAssets, setDraftAssets] = useState<DraftAssetState>(EMPTY_ASSETS)
  interface VersionFormState extends DraftAssetState {
    open: boolean
    summary: string
    model: string
    reasoning: string
    policy: PolicyFields
  }
  const [versionForms, setVersionForms] = useState<Record<string, VersionFormState>>({})
  const [detail, setDetail] = useState<{ profile?: CloudAgentProfile; error?: string }>()
  /**
   * 未解决的写冲突：按 profile 记录消息与「哪一次写失败」。
   *
   * 冲突不做自动收敛——编辑类冲突把服务端现状与本地修改并排展示，由操作者显式选择
   * 「保留本地修改并重试」或「采用服务端版本」；绑定冲突只呈现原因（它没有未保存表单）。
   * 任何一条路径都不静默覆盖。
   */
  const [conflicts, setConflicts] = useState<Record<string, { message: string; attempt: 'draft-edit' | 'new-version' | 'binding' }>>({})
  /**
   * 草稿编辑器的未保存状态，按 profile 记录；没改过时读服务端快照的值。
   * 与 diffSelection 同一套「按 profile 记录、缺省回落到服务端快照」的写法。
   */
  const [draftEdits, setDraftEdits] = useState<Record<string, DraftEditState>>({})
  const draftEditOf = (profileId: string, version: CloudAgentProfileVersion): DraftEditState =>
    draftEdits[profileId] ?? draftEditFrom(version)
  const updateDraftEdit = (profileId: string, version: CloudAgentProfileVersion, next: Partial<DraftEditState>): void => {
    setDraftEdits(previous => ({ ...previous, [profileId]: { ...(previous[profileId] ?? draftEditFrom(version)), ...next } }))
  }
  const clearDraftEdit = (profileId: string): void => {
    setDraftEdits((previous) => {
      const { [profileId]: _cleared, ...rest } = previous
      return rest
    })
  }
  const clearConflict = (profileId: string): void => {
    setConflicts((previous) => {
      const { [profileId]: _cleared, ...rest } = previous
      return rest
    })
  }
  const bindTargets = (): string[] =>
    bindProject
      .split(/[,，;\s]+/u)
      .map(target => target.trim())
      .filter(target => target.length > 0)
  // Server-side filters; every change re-reads the authoritative list.
  const [filters, setFilters] = useState<{
    status: string
    agentTypeId: string
    projectId: string
    readiness: string
    createdBy: string
    updatedAfter: string
  }>({ status: '', agentTypeId: '', projectId: '', readiness: '', createdBy: '', updatedAfter: '' })
  const [loading, setLoading] = useState(true)
  const [capability, setCapability] = useState<CloudCapability | undefined>()

  const reload = useCallback(async (): Promise<void> => {
    setLoading(true)
    const result = await api.cloudAgentProfiles({
      ...(filters.status === '' ? {} : { status: filters.status }),
      ...(filters.agentTypeId === '' ? {} : { agentTypeId: filters.agentTypeId }),
      ...(filters.projectId === '' ? {} : { projectId: filters.projectId }),
      ...(filters.readiness === '' ? {} : { readiness: filters.readiness }),
      ...(filters.createdBy === '' ? {} : { createdBy: filters.createdBy }),
      ...(filters.updatedAfter === '' ? {} : { updatedAfter: filters.updatedAfter }),
    })
    setLoading(false)
    setCapability(capabilityFromResult('agent-profiles', result, result.ok ? result.value.length : undefined))
    if (result.ok) setProfiles(result.value)
    else {
      // 失败、协议错误或无权限时保留显式失败状态，绝不降级成空列表。
      setProfiles([])
      onAction(result, '')
    }
  }, [api, onAction, filters])

  // 文本筛选逐键触发的请求风暴用 250ms 防抖吸收;测试与真实输入都仍在窗口内完成。
  useEffect(() => {
    const timer = setTimeout(() => { void reload() }, 250)
    return () => { clearTimeout(timer) }
  }, [reload])

  // Asset candidates are a service-declared range bound to the project; a
  // failed read stays visible and the forms refuse to offer fabricated ids.
  useEffect(() => {
    const lifetime: { cancelled: boolean } = { cancelled: false }
    void (async () => {
      setCandidatesState('loading')
      const result = await api.cloudAssetCandidates(bindProject)
      if (lifetime.cancelled) return
      if (result.ok) {
        setCandidates(result.value)
        setCandidatesState('ready')
      } else {
        setCandidates([])
        setCandidatesState('failed')
      }
    })()
    return () => { lifetime.cancelled = true }
  }, [api, bindProject])

  useEffect(() => {
    void (async () => {
      const result = await api.cloudAgentTypes()
      if (result.ok) setAgentTypes(result.value)
    })()
  }, [api])

  // agent_profile 事件到达后重新读取权威快照，不把事件 payload 拼成本地状态。
  const reloadRef = useRef(reload)
  reloadRef.current = reload
  useEffect(() => {
    const stream = new CloudWorkspaceStream({
      url: '/admin/events/stream',
      callbacks: {
        onStatus: () => undefined,
        onEvent: () => { void reloadRef.current() },
        onResync: async () => { await reloadRef.current() },
      },
      fetch: input => api.cloudStream(input),
    })
    stream.start()
    return () => { stream.stop() }
  }, [api])

  // 发布校验（§6.5）：发布前先跑配置试运行，逐项列出未授权/未就绪资产；
  // outcome=blocked 或存在 fail 检查时不发起发布。
  const [publishGate, setPublishGate] = useState<Record<string, {
    readonly outcome: 'ready' | 'blocked'
    readonly checks: readonly { readonly check: string; readonly result: string; readonly detail: string }[]
  } | undefined>>()
  const publish = async (profile: CloudAgentProfile, versionId: string): Promise<void> => {
    const dry = await api.dryRunCloudAgentProfileVersion(profile.agent_profile_id, versionId)
    if (!dry.ok) {
      onAction(dry, '发布校验失败')
      return
    }
    const payload = dry.value as { outcome?: unknown; checks?: unknown }
    const outcome = payload.outcome === 'blocked' ? 'blocked' : 'ready'
    const checks = Array.isArray(payload.checks)
      ? payload.checks.map((entry) => {
        const record = entry as { check?: unknown; result?: unknown; detail?: unknown }
        return {
          check: typeof record.check === 'string' ? record.check : JSON.stringify(record.check),
          result: typeof record.result === 'string' ? record.result : JSON.stringify(record.result),
          detail: typeof record.detail === 'string' ? record.detail : JSON.stringify(record.detail),
        }
      })
      : []
    setPublishGate(previous => ({
      ...previous,
      [`${profile.agent_profile_id}-${versionId}`]: { outcome, checks },
    }))
    const blocking = checks.filter(check => check.result === 'fail')
    if (outcome === 'blocked' || blocking.length > 0) {
      onAction(
        { ok: false, error: { kind: 'service', code: 'PUBLISH_BLOCKED', message: `发布被校验阻断：${blocking.map(check => check.detail).join('；') || '存在未通过检查'}` } },
        '',
      )
      return
    }
    const version = profile.versions.find(candidate => candidate.agent_profile_version_id === versionId)
    const confirmMessage = version === undefined
      ? `确认发布版本 ${versionId}？`
      : `确认发布 ${profile.name} 的版本 ${version.version}？\n状态 ${version.status} → published\n模型 ${version.model} / 推理 ${version.reasoning}\n资产 ${version.asset_version_ids.join('、') || '无'}\n试运行全部通过后发布。`
    if (!window.confirm(confirmMessage)) return
    const result = await api.publishCloudAgentProfileVersion(profile.agent_profile_id, versionId, profile.revision, idempotencyKey('publish'))
    onAction(result, `版本 ${versionId} 已发布`)
    await reloadRef.current()
  }
  const archive = async (profile: CloudAgentProfile, versionId: string): Promise<void> => {
    if (!window.confirm(`确认归档版本 ${versionId}？归档后不能被新项目绑定、Workspace 或 Run 选择；历史 Run 保留原快照。`)) return
    const result = await api.archiveCloudAgentProfileVersion(profile.agent_profile_id, versionId, profile.revision, idempotencyKey('archive'))
    onAction(result, `版本 ${versionId} 已归档`)
    await reloadRef.current()
  }
  const cloneProfile = async (profile: CloudAgentProfile): Promise<void> => {
    if (!window.confirm(`确认把 ${profile.name} 复制为新配置？新配置不复制项目绑定与发布状态，需重新发布。`)) return
    const result = await api.cloneCloudAgentProfile(profile.agent_profile_id, idempotencyKey('clone'))
    onAction(result, '已复制为新配置（草稿）')
    await reloadRef.current()
  }
  // 每个目标项目绑定前重读 profile revision——前一次绑定会推进 revision。
  const bind = async (profile: CloudAgentProfile, versionId: string, defaultValue: boolean): Promise<void> => {
    const targets = bindTargets()
    if (targets.length === 0) {
      onAction({ ok: false, error: { kind: 'service', code: 'VALIDATION_ERROR', message: '绑定项目 ID 必填' } }, '')
      return
    }
    if (!window.confirm(defaultValue ? `确认把版本设为项目 ${targets.join('、')} 的默认配置？` : `确认绑定项目 ${targets.join('、')}？`)) return
    for (const projectId of targets) {
      const fresh = await api.cloudAgentProfile(profile.agent_profile_id)
      const revision = fresh.ok ? fresh.value.revision : profile.revision
      const result = await api.bindCloudAgentProfile(
        profile.agent_profile_id,
        projectId,
        revision,
        { agent_profile_version_id: versionId, default: defaultValue },
        idempotencyKey(defaultValue ? `bind-default-${projectId}` : `bind-${projectId}`),
      )
      if (isRevisionConflict(result)) {
        setConflicts(previous => ({
          ...previous,
          [profile.agent_profile_id]: { message: `项目 ${projectId} 绑定冲突：服务端 revision 已推进，请刷新后重试`, attempt: 'binding' },
        }))
        continue
      }
      onAction(result, defaultValue ? `已设为项目 ${projectId} 默认配置（旧默认自动取消）` : `已绑定项目 ${projectId}`)
    }
    await reloadRef.current()
  }
  const unbind = async (profile: CloudAgentProfile): Promise<void> => {
    const targets = bindTargets()
    if (targets.length === 0) return
    if (!window.confirm(`确认解除 ${profile.name} 与项目 ${targets.join('、')} 的绑定？`)) return
    for (const projectId of targets) {
      const fresh = await api.cloudAgentProfile(profile.agent_profile_id)
      const revision = fresh.ok ? fresh.value.revision : profile.revision
      const result = await api.unbindCloudAgentProfile(profile.agent_profile_id, projectId, revision, idempotencyKey(`unbind-${projectId}`))
      onAction(result, `已解除项目 ${projectId} 的绑定`)
    }
    await reloadRef.current()
  }

  const openDetail = async (profile: CloudAgentProfile): Promise<void> => {
    setDetail(undefined)
    const result = await api.cloudAgentProfile(profile.agent_profile_id)
    if (result.ok) setDetail({ profile: result.value })
    else {
      const describe = result.error.kind === 'service'
        ? `${result.error.code}: ${result.error.message}`
        : result.error.kind === 'not-ready'
          ? `NOT_READY: 服务未就绪，缺少 ${result.error.missing.join('、')}`
          : 'TRANSPORT_FAILED: 请求未到达服务'
      setDetail({ error: describe })
    }
  }

  /** 新版本表单的资产选择处理器:直接作用于对应 profile 的表单状态。 */
  const versionAssetHandlers = (profileId: string, field: 'skills' | 'knowledge') => ({
    toggle: (assetId: string): void => {
      setVersionForms((previous) => {
        const form = previous[profileId]
        const list = form[field]
        const exists = list.some(entry => entry.assetId === assetId)
        const next = exists ? list.filter(entry => entry.assetId !== assetId) : [...list, { assetId, required: true }]
        return { ...previous, [profileId]: { ...form, [field]: next } }
      })
    },
    move: (assetId: string, direction: -1 | 1): void => {
      setVersionForms((previous) => {
        const form = previous[profileId]
        const list = [...form[field]]
        const from = list.findIndex(entry => entry.assetId === assetId)
        const to = from + direction
        if (from === -1 || to < 0 || to >= list.length) return previous
        const [moved] = list.splice(from, 1)
        list.splice(to, 0, moved)
        return { ...previous, [profileId]: { ...form, [field]: list } }
      })
    },
    toggleRequired: (assetId: string): void => {
      setVersionForms((previous) => {
        const form = previous[profileId]
        const next = form[field].map(entry => (entry.assetId === assetId ? { ...entry, required: !entry.required } : entry))
        return { ...previous, [profileId]: { ...form, [field]: next } }
      })
    },
  })

  const versionDiffRows = (base: CloudAgentProfileVersion, target: CloudAgentProfileVersion): readonly [string, string, string][] => {
    const basePolicy = base.execution_policy
    const targetPolicy = target.execution_policy
    const fields: readonly [string, string, string][] = [
      ['状态', base.status, target.status],
      ['模型', base.model, target.model],
      ['提示规则', base.reasoning, target.reasoning],
      ['工具', JSON.stringify(basePolicy['tool_allowlist'] ?? []), JSON.stringify(targetPolicy['tool_allowlist'] ?? [])],
      ['权限策略 · permission_mode', typeof basePolicy['permission_mode'] === 'string' ? basePolicy['permission_mode'] : '未设置', typeof targetPolicy['permission_mode'] === 'string' ? targetPolicy['permission_mode'] : '未设置'],
      ['权限策略 · write_mode', typeof basePolicy['write_mode'] === 'string' ? basePolicy['write_mode'] : '未设置', typeof targetPolicy['write_mode'] === 'string' ? targetPolicy['write_mode'] : '未设置'],
      ['资产版本', base.asset_version_ids.join('、'), target.asset_version_ids.join('、')],
      ['扩展配置', JSON.stringify(base.type_extension_config), JSON.stringify(target.type_extension_config)],
      ['凭据引用', base.credential_ref === null ? '无' : `${base.credential_ref.name}（${base.credential_ref.readiness}）`, target.credential_ref === null ? '无' : `${target.credential_ref.name}（${target.credential_ref.readiness}）`],
      ['变更摘要', base.change_summary, target.change_summary],
    ]
    return fields.filter(([, left, right]) => left !== right)
  }

  /**
   * §6.5 资产健康表：Skill/知识库/记忆库候选归一为同一套行（授权+readiness+原因）。
   * 表按页面级候选集渲染（4-5 客户端验收的形状）；`profile` 只表达调用点归属，
   * 不收窄行集——收窄需要服务端给出 profile→候选 的权威关系，未提供前不臆造。
   */
  const renderAssetHealth = (_profile: CloudAgentProfile) => {
    const rows = mergeAssetHealth({
      skills: assetHealthRows('skill', candidates.filter(candidate => candidate.asset_type === 'skill').map(candidate => ({
        assetId: candidate.asset_id, name: candidate.name, version: candidate.version,
        authorized: candidate.authorized, readiness: candidate.readiness === 'ready' ? 'ready' : 'unavailable',
        reason: candidate.invalid_reason,
      }))),
      knowledge: assetHealthRows('knowledge', candidates.filter(candidate => candidate.asset_type === 'knowledge').map(candidate => ({
        assetId: candidate.asset_id, name: candidate.name, version: candidate.version,
        authorized: candidate.authorized, readiness: candidate.readiness === 'ready' ? 'ready' : 'unavailable',
        reason: candidate.invalid_reason,
      }))),
      memory: assetHealthRows('memory', candidates.filter(candidate => candidate.asset_type === 'memory').map(candidate => ({
        assetId: candidate.asset_id, name: candidate.name, version: candidate.version,
        authorized: candidate.authorized, readiness: candidate.readiness === 'ready' ? 'ready' : 'unavailable',
        reason: candidate.invalid_reason,
      }))),
    })
    return (
      <div className="asset-health">
        <div className="workbench-card-head">
          <strong>资产健康表（Skill / 知识库 / 记忆库同一套）</strong>
        </div>
        <table className="admin-table" aria-label="资产健康表">
          <thead>
            <tr><th>类型</th><th>名称</th><th>版本</th><th>授权</th><th>readiness</th><th>健康</th><th>原因</th></tr>
          </thead>
          <tbody>
            {rows.map(row => (
              <tr key={row.assetId} data-healthy={row.healthy ? 'true' : 'false'}>
                <td>{row.assetType}</td>
                <td>{row.name}</td>
                <td>{row.version}</td>
                <td>{row.authorized ? '已授权' : '未授权'}</td>
                <td>{row.readiness}</td>
                <td>{row.healthy ? '健康' : '不健康'}</td>
                <td>{row.reason ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    )
  }

  const renderVersionDiff = (profile: CloudAgentProfile) => {
    if (profile.versions.length < 2) return null
    const selection = diffSelection[profile.agent_profile_id] ?? {
      base: profile.versions[0].agent_profile_version_id,
      target: profile.versions[1].agent_profile_version_id,
    }
    const base = profile.versions.find(version => version.agent_profile_version_id === selection.base)
    const target = profile.versions.find(version => version.agent_profile_version_id === selection.target)
    if (base === undefined || target === undefined) return null
    const rows = versionDiffRows(base, target)
    return (
      <div className="version-diff" aria-label="版本差异">
        <label className="inline-field">
          基准版本
          <select
            aria-label="基准版本"
            value={selection.base}
            onChange={(event) => {
              setDiffSelection(previous => ({
                ...previous,
                [profile.agent_profile_id]: { base: event.target.value, target: selection.target },
              }))
            }}
          >
            {profile.versions.map(version => (
              <option key={version.agent_profile_version_id} value={version.agent_profile_version_id}>{version.version}</option>
            ))}
          </select>
        </label>
        <label className="inline-field">
          对比版本
          <select
            aria-label="对比版本"
            value={selection.target}
            onChange={(event) => {
              setDiffSelection(previous => ({
                ...previous,
                [profile.agent_profile_id]: { base: selection.base, target: event.target.value },
              }))
            }}
          >
            {profile.versions.map(version => (
              <option key={version.agent_profile_version_id} value={version.agent_profile_version_id}>{version.version}</option>
            ))}
          </select>
        </label>
        <table className="admin-table">
          <thead>
            <tr><th>字段</th><th>基准</th><th>对比</th></tr>
          </thead>
          <tbody>
            {rows.map(([field, left, right]) => (
              <tr key={field}><td>{field}</td><td>{left}</td><td>{right}</td></tr>
            ))}
          </tbody>
        </table>
        {rows.length === 0 && <p>两个版本所选字段一致。</p>}
      </div>
    )
  }

  const createDraft = async (): Promise<void> => {
    if (draftName.trim() === '' || draftAgentTypeId === '') {
      onAction({ ok: false, error: { kind: 'service', code: 'VALIDATION_ERROR', message: '名称与 Agent 类型必填' } }, '')
      return
    }
    const result = await api.createCloudAgentProfile(
      {
        name: draftName,
        agent_type_id: draftAgentTypeId,
        model: draftModel,
        reasoning: draftReasoning,
        asset_bindings: selectionToBindings(draftAssets.skills, draftAssets.knowledge, draftAssets.memory),
        execution_policy: policyFromFields(draftPolicy),
        credential_ref: credentialRefOf(draftAssets),
        type_extension_config: draftAssets.extensions,
      },
      idempotencyKey('draft'),
    )
    if (!result.ok) {
      // 失败（403/422/503…）：草稿表单的每一个字段都保持原样，只呈现错误。
      onAction(result, '')
      return
    }
    onAction(result, `草稿 ${draftName} 已创建`)
    await reloadRef.current()
  }

  /** Creates a new draft version with explicitly chosen fields (never inherited silently). */
  /** 新版本表单从服务端最新版本继承的字段；`open` 由调用方决定。 */
  const versionFormSeed = (latest: CloudAgentProfileVersion | undefined): Omit<VersionFormState, 'open'> => {
    const inherited = latest === undefined ? EMPTY_ASSETS : bindingsFromVersion(latest)
    return {
      summary: '',
      model: latest?.model ?? '',
      reasoning: latest?.reasoning ?? 'medium',
      policy: {
        permissionMode: policyText(latest?.execution_policy.permission_mode, 'approval'),
        writeMode: policyText(latest?.execution_policy.write_mode, 'write'),
        maxConcurrency: policyText(latest?.execution_policy.max_concurrency, '2'),
        budget: policyText(latest?.execution_policy.budget, '200000'),
        timeoutMs: policyText(latest?.execution_policy.timeout_ms, '900000'),
        toolAllowlist: Array.isArray(latest?.execution_policy.tool_allowlist) ? latest.execution_policy.tool_allowlist.join(', ') : '',
      },
      skills: inherited.skills,
      knowledge: inherited.knowledge,
      memory: inherited.memory,
      extensions: { ...(latest?.type_extension_config ?? {}) },
      credentialName: latest?.credential_ref?.name ?? '',
      credentialKind: latest?.credential_ref?.kind ?? 'api_key',
    }
  }

  const createVersion = async (profile: CloudAgentProfile): Promise<void> => {
    const form = versionForms[profile.agent_profile_id] as VersionFormState | undefined
    if (form?.open !== true) {
      setVersionForms(previous => ({
        ...previous,
        [profile.agent_profile_id]: { ...versionFormSeed(profile.versions.at(-1)), open: true },
      }))
      return
    }
    const result = await api.createCloudAgentProfileVersion(
      profile.agent_profile_id,
      {
        change_summary: form.summary.trim() === '' ? '后台创建的新草稿版本' : form.summary,
        model: form.model,
        reasoning: form.reasoning,
        asset_bindings: selectionToBindings(form.skills, form.knowledge, form.memory),
        execution_policy: policyFromFields(form.policy),
        credential_ref: credentialRefOf(form),
        type_extension_config: form.extensions,
      },
      // 新版本与其它写操作一样竞争 profile revision。
      profile.revision,
      idempotencyKey('version'),
    )
    if (result.ok) {
      onAction(result, `配置 ${profile.name} 已新增草稿版本`)
      await reloadRef.current()
      setVersionForms(previous => ({ ...previous, [profile.agent_profile_id]: { ...form, open: false } }))
      return
    }
    // 失败：表单保持打开、已填字段原样保留（不关闭、不清空），错误只走父级横幅。
    if (isRevisionConflict(result)) {
      setConflicts(previous => ({
        ...previous,
        [profile.agent_profile_id]: {
          message: '创建新版本时服务端已更新：已重读服务端快照，本地表单内容保留',
          attempt: 'new-version',
        },
      }))
      await reloadRef.current()
      return
    }
    onAction(result, '')
  }

  /** Edits the latest draft in place (PUT); published profiles never offer this. */
  const saveDraftEdit = async (profile: CloudAgentProfile, version: CloudAgentProfileVersion): Promise<void> => {
    const edit = draftEditOf(profile.agent_profile_id, version)
    const result = await api.updateCloudAgentProfile(
      profile.agent_profile_id,
      {
        model: edit.model,
        reasoning: edit.reasoning,
        asset_bindings: draftEditBindings(edit),
        execution_policy: draftEditPolicy(edit),
        type_extension_config: edit.extensions,
        // 与新建草稿/新版本同一条契约：只声明 name/kind，授权与 readiness 由服务端注册表裁决。
        credential_ref: credentialRefOf(edit),
      },
      profile.revision,
      idempotencyKey('draft-edit'),
    )
    if (result.ok) {
      clearConflict(profile.agent_profile_id)
      // 保存成功后未保存状态归零：编辑器回到服务端快照，本地值不再遮盖权威值。
      clearDraftEdit(profile.agent_profile_id)
      onAction(result, `草稿 ${profile.name} 已保存`)
      await reloadRef.current()
      return
    }
    if (isRevisionConflict(result)) {
      // 冲突：重读权威快照用于**并排展示差异**；未保存状态一动不动。
      setConflicts(previous => ({
        ...previous,
        [profile.agent_profile_id]: { message: '已重读服务端快照，请基于最新内容修改后重试', attempt: 'draft-edit' },
      }))
      await reloadRef.current()
      return
    }
    // 503 / 403 / 422 等：保留未提交表单与全部字段，只呈现错误——不重读、不改写本地状态。
    onAction(result, '')
  }

  /**
   * 冲突台账里的差异行：本地未保存状态 vs 服务端当前草稿版本。
   * 服务端一侧来自最近一次权威重读，因此展示的是「现在」而不是发起写入时的样子。
   */
  const conflictRows = (profile: CloudAgentProfile): readonly (readonly [string, string, string])[] => {
    const latest = profile.versions.at(-1)
    if (latest === undefined) return []
    return draftEditDiffRows(draftEditOf(profile.agent_profile_id, latest), latest)
  }

  /**
   * 保留本地修改并重试：先重读权威 revision，再用最新 If-Match 重放同一次写。
   * 重试是**重放本地修改**，不是放弃它；未保存状态原样进入这次重试。
   */
  const retryConflict = async (profile: CloudAgentProfile): Promise<void> => {
    // 冲突台账是稀疏对象：用 hasOwn 判存在，而不是依赖索引类型是否含 undefined。
    if (!Object.hasOwn(conflicts, profile.agent_profile_id)) return
    const conflict = conflicts[profile.agent_profile_id]
    const fresh = await api.cloudAgentProfile(profile.agent_profile_id)
    if (!fresh.ok) {
      onAction(fresh, '')
      return
    }
    clearConflict(profile.agent_profile_id)
    const current = fresh.value
    setProfiles(previous => previous.map(item => (item.agent_profile_id === profile.agent_profile_id ? current : item)))
    if (conflict.attempt === 'new-version') {
      await createVersion(current)
      return
    }
    const latest = current.versions.at(-1)
    if (latest === undefined) return
    await saveDraftEdit(current, latest)
  }

  /**
   * 采用服务端版本：显式丢弃本地未保存修改。
   * 这是唯一会覆盖编辑内容的路径，且只由操作者主动点击触发。
   */
  const adoptServerVersion = (profile: CloudAgentProfile): void => {
    const hadConflict = Object.hasOwn(conflicts, profile.agent_profile_id)
    const conflict = conflicts[profile.agent_profile_id]
    clearConflict(profile.agent_profile_id)
    if (hadConflict && conflict.attempt === 'new-version') {
      const latest = profile.versions.at(-1)
      setVersionForms(previous => ({
        ...previous,
        [profile.agent_profile_id]: { ...previous[profile.agent_profile_id], ...versionFormSeed(latest) },
      }))
      return
    }
    clearDraftEdit(profile.agent_profile_id)
  }

  /**
   * In-place draft edit form.
   *
   * 每个字段都绑定到该 profile 的**未保存状态**，而不是服务端列表里的版本对象：
   * 冲突或失败后的重读因此只更新页面上的「服务端现状」，不会覆盖操作者的输入。
   */
  const renderDraftEditor = (profile: CloudAgentProfile) => {
    const latest = profile.versions.at(-1)
    if (latest === undefined || latest.status !== 'draft') {
      return <p className="fixture-note" data-state="immutable">已发布内容不可原地修改；变更请创建新版本。</p>
    }
    const draftEditorType = agentTypes.find(candidate => candidate.agent_type_id === profile.agent_type_id)
    const profileId = profile.agent_profile_id
    const edit = draftEditOf(profileId, latest)
    return (
      <div className="draft-editor" aria-label={`编辑草稿-${profileId}`}>
        <VersionFields
          model={edit.model}
          reasoning={edit.reasoning}
          policy={edit.policy}
          onChange={(next) => {
            updateDraftEdit(profileId, latest, {
              ...(next.model === undefined ? {} : { model: next.model }),
              ...(next.reasoning === undefined ? {} : { reasoning: next.reasoning }),
              ...(next.policy === undefined ? {} : { policy: next.policy }),
            })
          }}
        />
        <ExtensionFields
          agentType={draftEditorType}
          value={edit.extensions}
          onChange={(extensions) => { updateDraftEdit(profileId, latest, { extensions }) }}
        />
        <OrderedAssetPicker
          assetType="skill"
          candidates={candidates}
          selected={edit.skills}
          onToggle={(assetId) => {
            const exists = edit.skills.some(entry => entry.assetId === assetId)
            updateDraftEdit(profileId, latest, {
              skills: exists
                ? edit.skills.filter(entry => entry.assetId !== assetId)
                : [...edit.skills, { assetId, required: true }],
            })
          }}
          onMove={(assetId, direction) => {
            const index = edit.skills.findIndex(entry => entry.assetId === assetId)
            const target = index + direction
            if (index === -1 || target < 0 || target >= edit.skills.length) return
            const skills = [...edit.skills]
            const [moved] = skills.splice(index, 1)
            skills.splice(target, 0, moved)
            updateDraftEdit(profileId, latest, { skills })
          }}
          onToggleRequired={(assetId) => {
            updateDraftEdit(profileId, latest, {
              skills: edit.skills.map(entry => (entry.assetId === assetId ? { ...entry, required: !entry.required } : entry)),
            })
          }}
        />
        <OrderedAssetPicker
          assetType="knowledge"
          candidates={candidates}
          selected={edit.knowledge}
          onToggle={(assetId) => {
            const exists = edit.knowledge.some(entry => entry.assetId === assetId)
            updateDraftEdit(profileId, latest, {
              knowledge: exists
                ? edit.knowledge.filter(entry => entry.assetId !== assetId)
                : [...edit.knowledge, { assetId, required: true }],
            })
          }}
          onMove={(assetId, direction) => {
            const index = edit.knowledge.findIndex(entry => entry.assetId === assetId)
            const target = index + direction
            if (index === -1 || target < 0 || target >= edit.knowledge.length) return
            const knowledge = [...edit.knowledge]
            const [moved] = knowledge.splice(index, 1)
            knowledge.splice(target, 0, moved)
            updateDraftEdit(profileId, latest, { knowledge })
          }}
          onToggleRequired={(assetId) => {
            updateDraftEdit(profileId, latest, {
              knowledge: edit.knowledge.map(entry => (entry.assetId === assetId ? { ...entry, required: !entry.required } : entry)),
            })
          }}
        />
        <MemoryPicker
          candidates={candidates}
          value={edit.memory}
          onChange={(memory) => { updateDraftEdit(profileId, latest, { memory }) }}
        />
        <CredentialFields
          name={edit.credentialName}
          kind={edit.credentialKind}
          nameLabel={`草稿凭据-${profileId}`}
          kindLabel={`草稿凭据类型-${profileId}`}
          onChange={(next) => {
            updateDraftEdit(profileId, latest, {
              credentialName: next.name ?? edit.credentialName,
              credentialKind: next.kind ?? edit.credentialKind,
            })
          }}
        />
        <button type="button" aria-label={`保存草稿-${profileId}`} onClick={() => void saveDraftEdit(profile, latest)}>保存草稿</button>
      </div>
    )
  }

  const draftType = agentTypes.find(candidate => candidate.agent_type_id === draftAgentTypeId)

  // 关系链跳转携带的 Profile Version：目标页自动打开所属配置详情，而不是
  // 让操作者在列表里重新寻找同一个版本。
  const openDetailRef = useRef(openDetail)
  useEffect(() => {
    openDetailRef.current = openDetail
  }, [openDetail])
  const focusedProfileVersionId = focus?.agentProfileVersionId
  const focusedProfile =
    focusedProfileVersionId === undefined
      ? undefined
      : profiles.find(profile => profile.versions.some(version => version.agent_profile_version_id === focusedProfileVersionId))
  const openedProfileVersion = useRef<string | undefined>(undefined)
  useEffect(() => {
    if (focusedProfileVersionId === undefined || focusedProfile === undefined) return
    if (openedProfileVersion.current === focusedProfileVersionId) return
    openedProfileVersion.current = focusedProfileVersionId
    void openDetailRef.current(focusedProfile)
  }, [focusedProfile, focusedProfileVersionId])
  const focusMissed = !loading && focusedProfileVersionId !== undefined && focusedProfile === undefined

  // 首次加载整页等待；筛选变更引发的刷新保留表单与筛选区，不整页清空。
  if (loading && profiles.length === 0) return <div className="page-loading">加载中…</div>
  return (
    <div className="page-body">
      <div className="page-intro">
        <div>
          <span className="eyebrow">云工作空间治理</span>
          <h2>Agent 配置</h2>
          <p>配置草稿、发布版本与项目绑定。</p>
        </div>
      </div>
      {loading && <p className="fixture-note" data-state="reloading">正在按当前筛选重新读取…</p>}
      <p className="fixture-note" data-fixture-only="true">Agent 配置数据来自本地 fixture 服务（fixture-only），不代表生产治理能力。</p>
      {capability !== undefined && <CapabilityStrip capabilities={[capability]} />}
      <CapabilityFailureNote capability={capability} />
      <RelationContextNote focus={focus} />
      {focusMissed && (
        <RelationTargetMissing
          focus={focus}
          message={`服务端未返回目标 Profile Version ${focusedProfileVersionId}。越权、已删除或对象不存在时不得以空列表代替失败，请核对来源 Workspace 或重新筛选。`}
        />
      )}
      <div className="profile-filters" aria-label="配置筛选">
        <label className="inline-field">
          筛选-状态
          <select aria-label="筛选-状态" value={filters.status} onChange={(event) => { setFilters(previous => ({ ...previous, status: event.target.value })) }}>
            <option value="">全部状态</option>
            <option value="draft">draft</option>
            <option value="published">published</option>
            <option value="archived">archived</option>
          </select>
        </label>
        <label className="inline-field">
          筛选-Agent 类型
          <select aria-label="筛选-Agent 类型" value={filters.agentTypeId} onChange={(event) => { setFilters(previous => ({ ...previous, agentTypeId: event.target.value })) }}>
            <option value="">全部类型</option>
            {agentTypes.map(agentType => (
              <option key={agentType.agent_type_id} value={agentType.agent_type_id}>{agentType.name}</option>
            ))}
          </select>
        </label>
        <label className="inline-field">
          筛选-项目
          <input aria-label="筛选-项目" value={filters.projectId} onChange={(event) => { setFilters(previous => ({ ...previous, projectId: event.target.value })) }} />
        </label>
        <label className="inline-field">
          筛选-readiness
          <select aria-label="筛选-readiness" value={filters.readiness} onChange={(event) => { setFilters(previous => ({ ...previous, readiness: event.target.value })) }}>
            <option value="">全部 readiness</option>
            <option value="ready">ready</option>
            <option value="degraded">degraded</option>
            <option value="unavailable">unavailable</option>
          </select>
        </label>
        <label className="inline-field">
          筛选-创建人
          <input aria-label="筛选-创建人" value={filters.createdBy} onChange={(event) => { setFilters(previous => ({ ...previous, createdBy: event.target.value })) }} />
        </label>
        <label className="inline-field">
          筛选-更新时间
          <input
            aria-label="筛选-更新时间"
            type="datetime-local"
            value={filters.updatedAfter}
            onChange={(event) => { setFilters(previous => ({ ...previous, updatedAfter: event.target.value })) }}
          />
        </label>
      </div>
      <label className="inline-field">
        绑定项目 ID
        <input aria-label="绑定项目 ID" value={bindProject} onChange={(event) => { setBindProject(event.target.value) }} />
      </label>
      {candidatesState === 'failed' && (
        <p role="alert" data-state="candidates-failed">资产候选读取失败，请重试；表单不提供候选之外的资产。</p>
      )}
      <div className="draft-form" aria-label="创建配置草稿">
        <label className="inline-field">
          创建配置名称
          <input aria-label="创建配置名称" value={draftName} onChange={(event) => { setDraftName(event.target.value) }} />
        </label>
        <label className="inline-field">
          创建 Agent 类型
          <select aria-label="创建 Agent 类型" value={draftAgentTypeId} onChange={(event) => { setDraftAgentTypeId(event.target.value) }}>
            <option value="">选择 Agent 类型</option>
            {agentTypes.map(agentType => (
              <option key={agentType.agent_type_id} value={agentType.agent_type_id}>
                {agentType.name}（{agentType.readiness}）
              </option>
            ))}
          </select>
        </label>
        <VersionFields
          model={draftModel}
          reasoning={draftReasoning}
          policy={draftPolicy}
          onChange={(next) => {
            if (next.model !== undefined) setDraftModel(next.model)
            if (next.reasoning !== undefined) setDraftReasoning(next.reasoning)
            if (next.policy !== undefined) setDraftPolicy(next.policy)
          }}
        />
        {draftAgentTypeId !== '' && (
          <ExtensionFields
            agentType={draftType}
            value={draftAssets.extensions}
            onChange={(extensions) => { setDraftAssets(previous => ({ ...previous, extensions })) }}
          />
        )}
        <OrderedAssetPicker
          assetType="skill"
          candidates={candidates}
          selected={draftAssets.skills}
          onToggle={(assetId) => {
            setDraftAssets((previous) => {
              const exists = previous.skills.some(entry => entry.assetId === assetId)
              const skills = exists
                ? previous.skills.filter(entry => entry.assetId !== assetId)
                : [...previous.skills, { assetId, required: true }]
              return { ...previous, skills }
            })
          }}
          onMove={(assetId, direction) => {
            setDraftAssets((previous) => {
              const index = previous.skills.findIndex(entry => entry.assetId === assetId)
              const target = index + direction
              if (index === -1 || target < 0 || target >= previous.skills.length) return previous
              const skills = [...previous.skills]
              const [moved] = skills.splice(index, 1)
              skills.splice(target, 0, moved)
              return { ...previous, skills }
            })
          }}
          onToggleRequired={(assetId) => {
            setDraftAssets(previous => ({
              ...previous,
              skills: previous.skills.map(entry => (entry.assetId === assetId ? { ...entry, required: !entry.required } : entry)),
            }))
          }}
        />
        <OrderedAssetPicker
          assetType="knowledge"
          candidates={candidates}
          selected={draftAssets.knowledge}
          onToggle={(assetId) => {
            setDraftAssets((previous) => {
              const exists = previous.knowledge.some(entry => entry.assetId === assetId)
              const knowledge = exists
                ? previous.knowledge.filter(entry => entry.assetId !== assetId)
                : [...previous.knowledge, { assetId, required: true }]
              return { ...previous, knowledge }
            })
          }}
          onMove={(assetId, direction) => {
            setDraftAssets((previous) => {
              const index = previous.knowledge.findIndex(entry => entry.assetId === assetId)
              const target = index + direction
              if (index === -1 || target < 0 || target >= previous.knowledge.length) return previous
              const knowledge = [...previous.knowledge]
              const [moved] = knowledge.splice(index, 1)
              knowledge.splice(target, 0, moved)
              return { ...previous, knowledge }
            })
          }}
          onToggleRequired={(assetId) => {
            setDraftAssets(previous => ({
              ...previous,
              knowledge: previous.knowledge.map(entry => (entry.assetId === assetId ? { ...entry, required: !entry.required } : entry)),
            }))
          }}
        />
        <MemoryPicker
          candidates={candidates}
          value={draftAssets.memory}
          onChange={(memory) => { setDraftAssets(previous => ({ ...previous, memory })) }}
        />
        <CredentialFields
          name={draftAssets.credentialName}
          kind={draftAssets.credentialKind}
          nameLabel="创建凭据名称"
          kindLabel="创建凭据类型"
          onChange={(next) => {
            setDraftAssets(previous => ({
              ...previous,
              credentialName: next.name ?? previous.credentialName,
              credentialKind: next.kind ?? previous.credentialKind,
            }))
          }}
        />
        <button type="button" onClick={() => void createDraft()}>创建草稿</button>
      </div>
      {profiles.map(profile => (
        <section key={profile.agent_profile_id} className="cloud-profile" data-profile-id={profile.agent_profile_id}>
          <div aria-label={`配置卡片-${profile.agent_profile_id}`} data-readiness={profile.readiness} className="profile-card">
            <h3>
              {profile.name} <small>{profile.agent_profile_id} · {profile.status} · rev {profile.revision}</small>
            </h3>
            <p className="profile-meta">
              描述 {profile.description} · 类型 {profile.agent_type_name}（类型 readiness {profile.agent_type_readiness}）
              · 组织 {profile.organization_id} · readiness {profile.readiness}
              {profile.unavailable_reason === null ? '' : `：${profile.unavailable_reason}`}
            </p>
            <p className="profile-meta">
              Skill {profile.skill_count} 项 · 知识库 {profile.knowledge_count} 项 ·{' '}
              {profile.memory_name === null ? '未使用记忆库' : `记忆库 ${profile.memory_name}`} · 绑定项目 {profile.project_count} 个
              · 创建人 {profile.created_by} · 创建 {profile.created_at} · 更新 {profile.updated_at}
              {profile.versions.some(version => version.status === 'draft') ? ' · 草稿未发布' : ''}
            </p>
            <p className="credential-row">
              凭据引用：
              {profile.versions.map(version => version.credential_ref).filter(ref => ref !== null).length === 0
                ? '无'
                : profile.versions
                  .map(version => version.credential_ref)
                  .filter(ref => ref !== null)
                  .map(ref => `${ref.name}（${ref.kind} · ${ref.authorized ? '已授权' : '未授权'} · ${ref.readiness}）`)
                  .join('，')}
            </p>
            <button type="button" aria-label={`配置详情-${profile.agent_profile_id}`} onClick={() => void openDetail(profile)}>配置详情</button>
            <button type="button" aria-label={`复制为新配置-${profile.agent_profile_id}`} onClick={() => void cloneProfile(profile)}>复制为新配置</button>
          </div>
          {detail?.profile?.agent_profile_id === profile.agent_profile_id && (
            <div className="profile-detail" aria-label={`配置详情快照-${profile.agent_profile_id}`}>
              <div className="detail-head">
                <strong>配置详情（服务端快照）</strong>
                <button type="button" aria-label="关闭详情" onClick={() => { setDetail(undefined) }}>关闭详情</button>
              </div>
              <p>
                组织 {detail.profile.organization_id} · 类型 {detail.profile.agent_type_id} · 状态 {detail.profile.status}
                {' '}
                · readiness {detail.profile.readiness}
                {detail.profile.unavailable_reason === null ? '' : `：${detail.profile.unavailable_reason}`}
              </p>
              <p>
                创建人 {detail.profile.created_by} · 创建 {detail.profile.created_at} · 更新 {detail.profile.updated_at}
                {' '}
                · rev {detail.profile.revision}
              </p>
              <table className="admin-table">
                <thead>
                  <tr><th>版本</th><th>状态</th><th>变更摘要</th><th>扩展配置</th><th>凭据引用</th><th>发布信息</th></tr>
                </thead>
                <tbody>
                  {detail.profile.versions.map(version => (
                    <tr key={version.agent_profile_version_id}>
                      <td>{version.agent_profile_version_id}（{version.version}）</td>
                      <td>{version.status}</td>
                      <td>{version.change_summary}</td>
                      <td><code>{JSON.stringify(version.type_extension_config)}</code></td>
                      <td>
                        {version.credential_ref === null
                          ? '无'
                          : `${version.credential_ref.name}（${version.credential_ref.kind} · ${version.credential_ref.authorized ? '已授权' : '未授权'} · ${version.credential_ref.readiness}）`}
                      </td>
                      <td>
                        {version.published_at === undefined
                          ? '—'
                          : `published_by ${version.published_by ?? '—'} @ ${version.published_at}`}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {detail?.error !== undefined && detail.profile === undefined && (
            <p role="alert" data-state="detail-failed">配置详情读取失败：{detail.error}</p>
          )}
          {Object.hasOwn(conflicts, profile.agent_profile_id) && (
            <div
              role="alert"
              aria-label={`revision 冲突-${profile.agent_profile_id}`}
              data-state="conflict"
              className="capability-failure conflict-panel"
            >
              <p>
                revision 冲突：{conflicts[profile.agent_profile_id].message}
                （服务端 revision 现为 {profile.revision}）
              </p>
              {conflicts[profile.agent_profile_id].attempt !== 'binding' && (
                <>
                  <p>服务端当前快照与本地未保存修改的差异（本地 → 服务端）：</p>
                  <table className="admin-table">
                    <thead>
                      <tr><th>字段</th><th>本地未保存</th><th>服务端</th></tr>
                    </thead>
                    <tbody>
                      {conflictRows(profile).map(([field, local, remote]) => (
                        <tr key={field}><td>{field}</td><td>{local}</td><td>{remote}</td></tr>
                      ))}
                    </tbody>
                  </table>
                  {conflictRows(profile).length === 0 && <p>本地未保存内容与服务端快照一致。</p>}
                  <button
                    type="button"
                    aria-label={`保留本地修改并重试-${profile.agent_profile_id}`}
                    onClick={() => void retryConflict(profile)}
                  >
                    保留本地修改并重试
                  </button>
                  <button
                    type="button"
                    aria-label={`采用服务端版本-${profile.agent_profile_id}`}
                    onClick={() => { adoptServerVersion(profile) }}
                  >
                    采用服务端版本
                  </button>
                </>
              )}
            </div>
          )}
          <table className="admin-table">
            <thead>
              <tr>
                <th>版本</th>
                <th>状态</th>
                <th>模型 / 推理</th>
                <th>资产版本</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {profile.versions.map(version => (
                <tr key={version.agent_profile_version_id}>
                  <td>{version.agent_profile_version_id}（{version.version}）</td>
                  <td>{version.status}</td>
                  <td>{version.model} / {version.reasoning}</td>
                  <td>{version.asset_version_ids.join('、') || '—'}</td>
                  <td>
                    {version.status === 'draft' && (
                      <button
                        type="button"
                        data-version={version.agent_profile_version_id}
                        onClick={() => void publish(profile, version.agent_profile_version_id)}
                      >
                        发布版本
                      </button>
                    )}
                    {publishGate?.[`${profile.agent_profile_id}-${version.agent_profile_version_id}`] !== undefined && (
                      <ul aria-label={`发布校验 ${version.agent_profile_version_id}`} className="publish-checks">
                        {(publishGate[`${profile.agent_profile_id}-${version.agent_profile_version_id}`]?.checks ?? []).map(check => (
                          <li key={check.check}>{`${check.check}（${check.result}）：${check.detail}`}</li>
                        ))}
                      </ul>
                    )}
                    <button type="button" onClick={() => void createVersion(profile)}>创建新版本</button>
                    {version.status === 'published' && (
                      <>
                        <button type="button" onClick={() => void archive(profile, version.agent_profile_version_id)}>归档版本</button>
                        <button type="button" onClick={() => void bind(profile, version.agent_profile_version_id, false)}>
                          绑定项目
                        </button>
                        <button
                          type="button"
                          aria-label={`设为默认-${profile.name}`}
                          onClick={() => void bind(profile, version.agent_profile_version_id, true)}
                        >
                          设为默认
                        </button>
                        <button
                          type="button"
                          disabled={!profile.project_bindings.some(binding => binding.project_id === bindProject)}
                          title={
                            profile.project_bindings.some(binding => binding.project_id === bindProject)
                              ? undefined
                              : '该项目当前没有绑定'
                          }
                          onClick={() => void unbind(profile)}
                        >
                          解除绑定
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {versionForms[profile.agent_profile_id]?.open && (
            <div className="new-version-form" aria-label={`新版本表单-${profile.agent_profile_id}`}>
              <label className="inline-field">
                变更摘要
                <input
                  aria-label={`新版本摘要-${profile.agent_profile_id}`}
                  value={versionForms[profile.agent_profile_id].summary}
                  onChange={(event) => {
                    setVersionForms(previous => ({
                      ...previous,
                      [profile.agent_profile_id]: { ...previous[profile.agent_profile_id], summary: event.target.value },
                    }))
                  }}
                />
              </label>
              <VersionFields
                model={versionForms[profile.agent_profile_id].model}
                reasoning={versionForms[profile.agent_profile_id].reasoning}
                policy={versionForms[profile.agent_profile_id].policy}
                onChange={(next) => {
                  setVersionForms((previous) => {
                    const form = previous[profile.agent_profile_id]
                    return {
                      ...previous,
                      [profile.agent_profile_id]: {
                        ...form,
                        model: next.model ?? form.model,
                        reasoning: next.reasoning ?? form.reasoning,
                        policy: next.policy ?? form.policy,
                      },
                    }
                  })
                }}
              />
              <OrderedAssetPicker
                assetType="skill"
                candidates={candidates}
                selected={versionForms[profile.agent_profile_id].skills}
                onToggle={versionAssetHandlers(profile.agent_profile_id, 'skills').toggle}
                onMove={versionAssetHandlers(profile.agent_profile_id, 'skills').move}
                onToggleRequired={versionAssetHandlers(profile.agent_profile_id, 'skills').toggleRequired}
              />
              <OrderedAssetPicker
                assetType="knowledge"
                candidates={candidates}
                selected={versionForms[profile.agent_profile_id].knowledge}
                onToggle={versionAssetHandlers(profile.agent_profile_id, 'knowledge').toggle}
                onMove={versionAssetHandlers(profile.agent_profile_id, 'knowledge').move}
                onToggleRequired={versionAssetHandlers(profile.agent_profile_id, 'knowledge').toggleRequired}
              />
              <ExtensionFields
                agentType={agentTypes.find(candidate => candidate.agent_type_id === profile.agent_type_id)}
                value={versionForms[profile.agent_profile_id].extensions}
                onChange={(extensions) => {
                  setVersionForms(previous => ({
                    ...previous,
                    [profile.agent_profile_id]: { ...previous[profile.agent_profile_id], extensions },
                  }))
                }}
              />
              <MemoryPicker
                candidates={candidates}
                value={versionForms[profile.agent_profile_id].memory}
                onChange={(memory) => {
                  setVersionForms(previous => ({
                    ...previous,
                    [profile.agent_profile_id]: { ...previous[profile.agent_profile_id], memory },
                  }))
                }}
              />
              <CredentialFields
                name={versionForms[profile.agent_profile_id].credentialName}
                kind={versionForms[profile.agent_profile_id].credentialKind}
                nameLabel={`新版本凭据-${profile.agent_profile_id}`}
                kindLabel={`新版本凭据类型-${profile.agent_profile_id}`}
                onChange={(next) => {
                  setVersionForms((previous) => {
                    const form = previous[profile.agent_profile_id]
                    return {
                      ...previous,
                      [profile.agent_profile_id]: {
                        ...form,
                        credentialName: next.name ?? form.credentialName,
                        credentialKind: next.kind ?? form.credentialKind,
                      },
                    }
                  })
                }}
              />
              <button type="button" onClick={() => void createVersion(profile)}>提交新版本</button>
            </div>
          )}
          {renderDraftEditor(profile)}
          <p className="binding-row">
            项目绑定：
            {profile.project_bindings.length === 0
              ? '无'
              : profile.project_bindings.map(binding => `${binding.project_id}→${binding.agent_profile_version_id}${binding.default ? '（默认）' : ''}`).join('，')}
          </p>
          {renderVersionDiff(profile)}
          {renderAssetHealth(profile)}
        </section>
      ))}
    </div>
  )
}

export function CloudOpsPage({ api, onAction, onNavigate, focus }: PageProps) {
  const [workspaces, setWorkspaces] = useState<readonly CloudWorkspace[]>([])
  const [statusFilter, setStatusFilter] = useState('')
  const [projectFilter, setProjectFilter] = useState('')
  const [ownerFilter, setOwnerFilter] = useState('')
  const [branchFilter, setBranchFilter] = useState('')
  const [streamStatus, setStreamStatus] = useState<CloudStreamStatus>('idle')
  const [detail, setDetail] = useState<
    {
      workspace: CloudWorkspace
      recent_audits: readonly CloudWorkspaceAudit[]
      runs: readonly CloudRun[]
      config_snapshot: Readonly<Record<string, unknown>> | null
      files_summary?: { total: number; directories: readonly string[]; changed: readonly { path: string; change: string }[] }
      changes?: { baseline_revision: number; revision: number; files: readonly { path: string; change: string; diff: string }[] }
      runtime?: { kind: string; state: string; note: string }
    } | undefined
  >()
  const [loading, setLoading] = useState(true)
  const [readFailed, setReadFailed] = useState(false)
  const [listCapability, setListCapability] = useState<CloudCapability | undefined>()
  const [detailCapability, setDetailCapability] = useState<CloudCapability | undefined>()
  /**
   * True once the first read settled; later refreshes update in place.
   *
   * A ref, not state: `reload` is the list's effect dependency and the live
   * subscription's callback, so a state flag written by `reload` itself would
   * change its identity on the first read and rebuild the subscription.
   */
  const loaded = useRef(false)

  /**
   * Guards the list against a response that belongs to a filter the operator
   * has already moved away from: the newer request's answer is the one shown.
   */
  const listRequest = useRef(0)

  const reload = useCallback(async (): Promise<void> => {
    const request = ++listRequest.current
    // Only the first read blanks the page. A live event refreshes the table in
    // place: replacing it with a loading state on every event would make the
    // live view flicker and lose whatever the operator was looking at.
    if (!loaded.current) setLoading(true)
    const result = await api.cloudWorkspaces({
      ...(statusFilter === '' ? {} : { status: statusFilter }),
      ...(projectFilter === '' ? {} : { projectId: projectFilter }),
      ...(ownerFilter === '' ? {} : { ownerUserId: ownerFilter }),
      ...(branchFilter === '' ? {} : { branch: branchFilter }),
    })
    if (request !== listRequest.current) return
    loaded.current = true
    setLoading(false)
    setListCapability(capabilityFromResult('workspaces', result, result.ok ? result.value.length : undefined))
    if (result.ok) {
      setWorkspaces(result.value)
      setReadFailed(false)
    } else {
      setWorkspaces([])
      // 失败保留显式失败状态（CapabilityFailureNote / onAction），空态面板只在真实空列表时出现。
      setReadFailed(true)
      onAction(result, '')
    }
  }, [api, branchFilter, onAction, ownerFilter, projectFilter, statusFilter])

  /** Guards the open detail against a late response for a workspace left behind. */
  const detailRequest = useRef(0)
  const openDetail = async (workspace: CloudWorkspace): Promise<void> => {
    const request = ++detailRequest.current
    const result = await api.cloudWorkspace(workspace.workspace_id)
    if (request !== detailRequest.current) return
    setDetailCapability(capabilityFromResult('workspace-detail', result))
    if (!result.ok) {
      setDetail(undefined)
      onAction(result, '')
      return
    }
    const value = result.value as CloudWorkspace & {
      recent_audits?: readonly CloudWorkspaceAudit[]
      runs?: readonly CloudRun[]
      config_snapshot?: Readonly<Record<string, unknown>> | null
      files_summary?: { total: number; directories: readonly string[]; changed: readonly { path: string; change: string }[] }
      changes?: { baseline_revision: number; revision: number; files: readonly { path: string; change: string; diff: string }[] }
      runtime?: { kind: string; state: string; note: string }
    }
    // cloudWorkspace 已把缺字段判成 INVALID_RESPONSE；这里再守一道，
    // 缺字段时保持空状态，绝不回落成空数组/空详情当成成功。
    if (!Object.hasOwn(value, 'recent_audits') || !Object.hasOwn(value, 'runs') || !Object.hasOwn(value, 'config_snapshot')) {
      setDetail(undefined)
      return
    }
    setDetail({
      workspace: value,
      recent_audits: value.recent_audits as readonly CloudWorkspaceAudit[],
      runs: value.runs as readonly CloudRun[],
      config_snapshot: value.config_snapshot as Readonly<Record<string, unknown>> | null,
      files_summary: value.files_summary,
      changes: value.changes,
      runtime: value.runtime,
    })
  }

  useEffect(() => {
    void reload()
  }, [reload])

  /** The workspace the open detail belongs to, so a live event can target it. */
  const openWorkspaceId = detail?.workspace.workspace_id
  const openWorkspaceIdRef = useRef(openWorkspaceId)
  const reloadRef = useRef(reload)
  // 关系链按钮携带的对象 ID：从已打开的详情里取出，目标页据此直接选中该对象。
  const focusedProfileVersionId =
    detail === undefined ? undefined : (detail.runs[0]?.agent_profile_version_id ?? detail.workspace.default_agent_profile_version_id)
  const focusedRunId = detail?.runs[0]?.run_id
  // 关系链跳转携带的 Workspace：目标页自动打开该 Workspace 的详情。
  const openDetailRef = useRef(openDetail)
  useEffect(() => {
    openDetailRef.current = openDetail
  }, [openDetail])
  const focusedWorkspace =
    focus?.workspaceId === undefined ? undefined : workspaces.find(item => item.workspace_id === focus.workspaceId)
  const openedWorkspace = useRef<string | undefined>(undefined)
  useEffect(() => {
    if (focus?.workspaceId === undefined || focusedWorkspace === undefined) return
    if (openedWorkspace.current === focus.workspaceId) return
    openedWorkspace.current = focus.workspaceId
    void openDetailRef.current(focusedWorkspace)
  }, [focus, focusedWorkspace])
  const focusMissed = !loading && focus?.workspaceId !== undefined && focusedWorkspace === undefined

  /**
   * One live subscription per mount, resuming from its own watermark.
   *
   * The subscription belongs to the page, not to a render: its callbacks reach
   * the newest state through refs, so a list refresh, a filter change or a
   * re-render cannot tear the connection down — which would also discard the
   * replay cursor and make the reader ask for the whole retained window again
   * instead of resuming where it left off. A snapshot it cannot re-read keeps
   * the badge at `resync` rather than pretending to be live.
   */
  const refresh = useCallback(async (): Promise<void> => {
    await reloadRef.current()
    // The Run timeline lives in the detail panel, so an event about the open
    // workspace refreshes it as well: an operator watching a run must not have
    // to reopen the panel to see the next transition.
    const workspaceId = openWorkspaceIdRef.current
    if (workspaceId === undefined) return
    const result = await api.cloudWorkspace(workspaceId)
    if (!result.ok) return
    const value = result.value as CloudWorkspace & {
      recent_audits?: readonly CloudWorkspaceAudit[]
      runs?: readonly CloudRun[]
      config_snapshot?: Readonly<Record<string, unknown>> | null
    }
    if (!Object.hasOwn(value, 'recent_audits') || !Object.hasOwn(value, 'runs') || !Object.hasOwn(value, 'config_snapshot')) return
    setDetail((previous) => {
      if (previous === undefined || previous.workspace.workspace_id !== value.workspace_id) return previous
      return {
        ...previous,
        workspace: value,
        recent_audits: value.recent_audits ?? [],
        runs: value.runs ?? [],
        config_snapshot: value.config_snapshot ?? null,
      }
    })
  }, [api])

  useEffect(() => {
    openWorkspaceIdRef.current = openWorkspaceId
  }, [openWorkspaceId])
  useEffect(() => {
    reloadRef.current = reload
  }, [reload])

  const cloudStream = useCallback(
    (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => api.cloudStream(input, init),
    [api],
  )
  const refreshRef = useRef(refresh)
  useEffect(() => {
    refreshRef.current = refresh
  }, [refresh])

  useEffect(() => {
    const stream = new CloudWorkspaceStream({
      // The API joins this to its own base, so the reader works identically
      // against the same-origin proxy and against a direct service URL.
      url: '/admin/events/stream',
      callbacks: {
        onStatus: (status) => { setStreamStatus(status) },
        onEvent: () => { void refreshRef.current() },
        onResync: () => refreshRef.current(),
      },
      fetch: cloudStream,
    })
    stream.start()
    return () => { stream.stop() }
  }, [cloudStream])

  const stop = async (workspace: CloudWorkspace): Promise<void> => {
    if (!window.confirm(`确认停止 Workspace ${workspace.workspace_id}（rev ${workspace.revision}）？`)) return
    const result = await api.stopCloudWorkspace(workspace.workspace_id, workspace.revision, idempotencyKey('stop'))
    onAction(result, `Workspace ${workspace.workspace_id} 已停止`)
  }
  const start = async (workspace: CloudWorkspace): Promise<void> => {
    const result = await api.startCloudWorkspace(workspace.workspace_id, workspace.revision, idempotencyKey('start'))
    onAction(result, `Workspace ${workspace.workspace_id} 启动中`)
  }

  if (loading) return <Loading />
  return (
    <div className="page-body">
      <div className="page-intro">
        <div>
          <span className="eyebrow">云工作空间治理</span>
          <h2>Workspace 运维</h2>
          <p>工作空间生命周期、状态巡检与治理操作。</p>
        </div>
      </div>
      <p className="fixture-note" data-fixture-only="true">Workspace 运维数据来自本地 fixture 服务（fixture-only），无真实运行实例。</p>
      {!readFailed && workspaces.length === 0 && (
        <Empty text="暂无 Workspace：当前筛选与服务端返回的生命周期列表为空。" />
      )}
      <CapabilityStrip
        capabilities={[listCapability, detailCapability].filter((value): value is CloudCapability => value !== undefined)}
      />
      <CapabilityFailureNote capability={listCapability} />
      <CapabilityFailureNote capability={detailCapability} />
      <RelationContextNote focus={focus} />
      {focusMissed && (
        <RelationTargetMissing
          focus={focus}
          message={`服务端未返回目标 Workspace ${focus.workspaceId}。越权、已删除或对象不存在时不得以空列表代替失败，请核对来源 Run 或重新筛选。`}
        />
      )}
      <p className="cloud-stream-badge" data-stream-status={streamStatus}>
        实时连接：
        {streamStatus === 'live' && '已连接'}
        {streamStatus === 'connecting' && '连接中'}
        {streamStatus === 'reconnecting' && '已断线，重连中'}
        {streamStatus === 'resync' && '事件重同步中'}
        {streamStatus === 'stale' && '事件协议错误，已停止应用该连接并重连'}
        {streamStatus === 'denied' && '授权被拒（请重新登录）'}
        {(streamStatus === 'idle' || streamStatus === 'stopped') && '未连接'}
      </p>
      <label className="inline-field">
        状态筛选
        <select aria-label="状态筛选" value={statusFilter} onChange={(event) =>{  setStatusFilter(event.target.value) }}>
          <option value="">全部</option>
          <option value="ready">ready</option>
          <option value="stopped">已停止</option>
          <option value="failed">失败</option>
          <option value="archived">已归档</option>
        </select>
      </label>
      <label className="inline-field">
        项目检索
        <input aria-label="项目检索" value={projectFilter} onChange={(event) =>{  setProjectFilter(event.target.value) }} />
      </label>
      <label className="inline-field">
        所有者检索
        <input aria-label="所有者检索" value={ownerFilter} onChange={(event) =>{  setOwnerFilter(event.target.value) }} />
        <label className="inline-field">
          分支筛选
          <input aria-label="分支筛选" value={branchFilter} onChange={(event) =>{  setBranchFilter(event.target.value) }} />
        </label>
      </label>
      <button type="button" onClick={() => void reload()}>检索</button>
      {(() => {
        const now = Date.now()
        const abnormalRows = classifyAbnormalWorkspaces(workspaces.map(workspace => ({
          workspaceId: workspace.workspace_id,
          displayName: workspace.display_name,
          status: workspace.status,
          preparingMs: workspace.status === 'preparing' ? Math.max(0, now - Date.parse(workspace.updated_at)) : undefined,
        })))
        if (abnormalRows.length === 0) return null
        return (
          <div role="region" aria-label="异常工作空间" style={{ marginBottom: 12 }}>
            <div className="workbench-card-head"><strong>异常工作空间</strong></div>
            <ul className="workbench-list">
              {abnormalRows.map((row, index) => (
                <li key={`${row.workspaceId}-${index}`}>
                  <strong>{row.displayName}</strong>（{row.workspaceId}）· {row.category} · {row.detail}
                </li>
              ))}
            </ul>
          </div>
        )
      })()}
      <table className="admin-table">
        <thead>
          <tr>
            <th>Workspace</th>
            <th>项目 / 所有者</th>
            <th>分支 / revision</th>
            <th>状态</th>
            <th>最近错误</th>
            <th>最后活动</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          {workspaces.map(workspace => (
            <tr key={workspace.workspace_id}>
              <td>{workspace.workspace_id}</td>
              <td>{workspace.project_id} / {workspace.owner_user_id}</td>
              <td>{workspace.branch} · rev {workspace.revision}</td>
              <td>{LIFECYCLE_LABEL[workspace.status] ?? workspace.status}</td>
              <td>{workspace.last_error ?? '—'}</td>
              <td>{workspace.updated_at}</td>
              <td>
                <button type="button" onClick={() => void openDetail(workspace)}>查看详情</button>
                {['ready', 'starting', 'degraded', 'provisioning'].includes(workspace.status) && (
                  <button type="button" onClick={() => void stop(workspace)}>停止</button>
                )}
                {['stopped', 'failed', 'draft'].includes(workspace.status) && (
                  <button type="button" onClick={() => void start(workspace)}>启动</button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {detail !== undefined && (
        <section className="cloud-detail" aria-label="Workspace 详情">
          <h3>概览：{detail.workspace.workspace_id}</h3>
          <p>
            {detail.workspace.project_id} / {detail.workspace.owner_user_id} · {detail.workspace.branch} · rev {detail.workspace.revision} ·{' '}
            {LIFECYCLE_LABEL[detail.workspace.status] ?? detail.workspace.status}
            {detail.workspace.last_error === null ? '' : ` · ${detail.workspace.last_error}`}
          </p>
          <ol className="relation-chain" aria-label="关系链">
            <li>项目 {detail.workspace.project_id}</li>
            <li>Workspace {detail.workspace.workspace_id}</li>
            <li>
              <button
                type="button"
                onClick={() => {
                  onNavigate?.({
                    target: 'cloud-profiles',
                    focus: focusOf(detail.workspace.workspace_id, { agentProfileVersionId: focusedProfileVersionId }),
                  })
                }}
              >
                Profile Version {focusedProfileVersionId}
              </button>
            </li>
            <li>
              <button
                type="button"
                onClick={() => {
                  onNavigate?.({
                    target: 'cloud-runs',
                    focus: focusOf(detail.workspace.workspace_id, focusedRunId === undefined ? {} : { runId: focusedRunId }),
                  })
                }}
              >
                Run
              </button>
            </li>
            <li>
              <button
                type="button"
                onClick={() => {
                  onNavigate?.({ target: 'cloud-audits', focus: focusOf(detail.workspace.workspace_id) })
                }}
              >
                审计
              </button>
            </li>
          </ol>
          <h4>Agent Runs</h4>
          <ul>
            {detail.runs.length === 0 ? <li>无</li> : detail.runs.map(run => (
              <li key={run.run_id}>
                {run.run_id} · {run.status} · {run.write_mode} · rev {run.workspace_revision} · 配置 {run.agent_profile_version_id}{' '}
                <button
                  type="button"
                  onClick={() => {
                    onNavigate?.({
                      target: 'cloud-runs',
                      focus: focusOf(detail.workspace.workspace_id, {
                        runId: run.run_id,
                        agentProfileVersionId: run.agent_profile_version_id,
                      }),
                    })
                  }}
                >
                  查看 Run {run.run_id}
                </button>
              </li>
            ))}
          </ul>
          <h4>配置快照</h4>
          {detail.config_snapshot === null ? (
            <p>无</p>
          ) : (
            <pre className="cloud-config-snapshot">{JSON.stringify(detail.config_snapshot, null, 2)}</pre>
          )}
          <h4>运行实例</h4>
          <p>
            {detail.runtime === undefined ? 'fixture 未提供运行实例数据' : `kind ${detail.runtime.kind} · state ${detail.runtime.state}`}
            （fixture-only，无真实运行实例）
          </p>
          <h4>文件 / 变更</h4>
          {detail.files_summary === undefined ? (
            <p>无</p>
          ) : (
            <p>
              文件 {detail.files_summary.total} 个 · 目录 {detail.files_summary.directories.join('、') || '—'} · 变更{' '}
              {detail.files_summary.changed.length} 个
              {detail.files_summary.changed.length > 0 && `（${detail.files_summary.changed.map(f => `${f.path} ${f.change}`).join('、')}）`}
            </p>
          )}
          {detail.changes !== undefined && detail.changes.files.length > 0 && (
            <ul>
              {detail.changes.files.map(file => (
                <li key={file.path}>
                  <pre className="cloud-config-snapshot">{file.diff}</pre>
                </li>
              ))}
            </ul>
          )}
          <h4>最近审计</h4>
          <ul>
            {detail.recent_audits.map((row, index) => (
              <li key={`${row.request_id}-${index}`}>
                {row.actor_name} · {row.action} · {row.result} · {row.occurred_at}{' '}
                <button
                  type="button"
                  onClick={() => {
                    onNavigate?.({
                      target: 'cloud-audits',
                      focus: focusOf(detail.workspace.workspace_id, { requestId: row.request_id }),
                    })
                  }}
                >
                  查看审计
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}

/** 全局 Run 检索与配置快照。 */
export function CloudRunsPage({ api, onAction, onNavigate, focus }: PageProps) {
  const [runs, setRuns] = useState<readonly CloudRun[]>([])
  const [projectId, setProjectId] = useState('')
  // 关系链跳转携带的 Workspace：目标页按它筛选并选中对应 Run。
  const [workspaceId, setWorkspaceId] = useState(focus?.workspaceId ?? '')
  const [loading, setLoading] = useState(true)
  /**
   * True once the first read settled; later refreshes update in place.
   *
   * A ref, not state: a state flag written by `reload` itself would change its
   * identity on the first read and rebuild the live subscription (see the ops
   * page for the full reasoning).
   */
  const loaded = useRef(false)
  /** §6.7 证据时间轴：当前展开运行证据面板的 run_id。 */
  const [evidenceRunId, setEvidenceRunId] = useState<string | undefined>()
  const [streamStatus, setStreamStatus] = useState<CloudStreamStatus>('idle')
  const [capability, setCapability] = useState<CloudCapability | undefined>()
  /** Guards the list against a response for a filter the operator has left. */
  const listRequest = useRef(0)

  // 同一页面内关系链上下文变化时同步筛选值（刷新/后退恢复也走这里）。
  useEffect(() => {
    if (focus?.workspaceId !== undefined) setWorkspaceId(focus.workspaceId)
  }, [focus])

  const reload = useCallback(async (): Promise<void> => {
    const request = ++listRequest.current
    // Only the first read blanks the page; a live event refreshes in place.
    if (!loaded.current) setLoading(true)
    const result = await api.cloudRuns(projectId === '' ? {} : { project_id: projectId })
    if (request !== listRequest.current) return
    loaded.current = true
    setLoading(false)
    setCapability(capabilityFromResult('runs', result, result.ok ? result.value.length : undefined))
    if (result.ok) setRuns(result.value)
    else {
      setRuns([])
      onAction(result, '')
    }
  }, [api, onAction, projectId])

  useEffect(() => {
    void reload()
  }, [reload])

  const reloadRef = useRef(reload)
  useEffect(() => {
    reloadRef.current = reload
  }, [reload])
  const cloudStream = useCallback(
    (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => api.cloudStream(input, init),
    [api],
  )

  /**
   * The Run list holds one live subscription of its own, so a run's transitions
   * appear as the service emits them rather than after someone presses 检索.
   * The callbacks read the newest `reload` through a ref, so a refresh or a
   * re-render cannot restart the connection and lose its replay cursor.
   */
  useEffect(() => {
    const stream = new CloudWorkspaceStream({
      url: '/admin/events/stream',
      callbacks: {
        onStatus: (status) => { setStreamStatus(status) },
        onEvent: () => { void reloadRef.current() },
        onResync: () => reloadRef.current(),
      },
      fetch: cloudStream,
    })
    stream.start()
    return () => { stream.stop() }
  }, [cloudStream])

  // 关系链焦点：列表按 Workspace 收敛，并核对目标 Run 是否真的在服务端结果里。
  const visibleRuns = workspaceId === '' ? runs : runs.filter(run => run.workspace_id === workspaceId)
  const focusMissed =
    !loading
    && focus !== undefined
    && (focus.runId !== undefined || focus.workspaceId !== undefined)
    && !runs.some(
      run =>
        (focus.runId === undefined || run.run_id === focus.runId)
        && (focus.workspaceId === undefined || run.workspace_id === focus.workspaceId),
    )

  if (loading) return <div className="page-loading">加载中…</div>
  return (
    <div className="page-body">
      <div className="page-intro">
        <div>
          <span className="eyebrow">云工作空间治理</span>
          <h2>Agent Run</h2>
          <p>全局检索运行记录、实时事件与配置快照。</p>
        </div>
      </div>
      <p className="fixture-note" data-fixture-only="true">Run 数据来自本地 fixture 服务（fixture-only），无真实 Agent 执行。</p>
      <p className="cloud-stream-badge" data-stream-status={streamStatus}>
        实时连接：
        {streamStatus === 'live' && '已连接'}
        {streamStatus === 'connecting' && '连接中'}
        {streamStatus === 'reconnecting' && '已断线，重连中'}
        {streamStatus === 'resync' && '事件重同步中'}
        {streamStatus === 'stale' && '事件协议错误，已停止应用该连接并重连'}
        {streamStatus === 'denied' && '授权被拒（请重新登录）'}
        {(streamStatus === 'idle' || streamStatus === 'stopped') && '未连接'}
      </p>
      {capability !== undefined && <CapabilityStrip capabilities={[capability]} />}
      <CapabilityFailureNote capability={capability} />
      <RelationContextNote focus={focus} />
      {focusMissed && (
        <RelationTargetMissing
          focus={focus}
          message={`服务端未返回目标 Run ${focus.runId ?? focus.workspaceId}。越权、已删除或对象不存在时不得以空列表代替失败，请核对来源 Workspace 或重新检索。`}
        />
      )}
      <label className="inline-field">
        项目 ID
        <input aria-label="Run 项目筛选" value={projectId} onChange={(event) =>{  setProjectId(event.target.value) }} />
      </label>
      <label className="inline-field">
        Workspace ID
        <input aria-label="Run Workspace 筛选" value={workspaceId} onChange={(event) => { setWorkspaceId(event.target.value) }} />
      </label>
      <button type="button" onClick={() => void reload()}>检索</button>
      <table className="admin-table">
        <thead>
          <tr>
            <th>Run</th>
            <th>Workspace / Session</th>
            <th>配置版本快照</th>
            <th>状态 / 模式</th>
            <th>代码 revision</th>
          </tr>
        </thead>
        <tbody>
          {visibleRuns.map(run => (
            <tr
              key={run.run_id}
              aria-current={run.run_id === focus?.runId ? 'true' : undefined}
              data-focused={run.run_id === focus?.runId ? 'true' : undefined}
            >
              <td>{run.run_id}{run.retry_of_run_id === undefined ? '' : `（重试自 ${run.retry_of_run_id}）`}</td>
              <td>{run.workspace_id} / {run.session_id}</td>
              <td>{run.agent_profile_version_id} + {run.asset_version_ids.length} 资产</td>
              <td>{run.status} · {run.write_mode}</td>
              <td>rev {run.workspace_revision}</td>
              <td>
                <button type="button" onClick={() => { setEvidenceRunId(evidenceRunId === run.run_id ? undefined : run.run_id) }}>
                  运行证据
                </button>
                <button
                  type="button"
                  onClick={() => {
                    onNavigate?.({
                      target: 'cloud-audits',
                      focus: focusOf(run.workspace_id, { runId: run.run_id, agentProfileVersionId: run.agent_profile_version_id }),
                    })
                  }}
                >
                  审计
                </button>
                <button
                  type="button"
                  onClick={() => {
                    onNavigate?.({
                      target: 'cloud-ops',
                      focus: focusOf(run.workspace_id, { runId: run.run_id, agentProfileVersionId: run.agent_profile_version_id }),
                    })
                  }}
                >
                  Workspace
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {evidenceRunId !== undefined && visibleRuns.filter(r => r.run_id === evidenceRunId).map(r => (
        <RunEvidencePanel key={r.run_id} api={api} run={r} onClose={() => { setEvidenceRunId(undefined) }} />
      ))}
    </div>
  )
}

/** 统一审计查询：三类审计接口统一展示字面字段 actor_name。 */
export function CloudAuditsPage({ api, onAction, focus }: PageProps) {
  const [audits, setAudits] = useState<readonly CloudWorkspaceAudit[]>([])
  const [workspaceId, setWorkspaceId] = useState(focus?.workspaceId ?? '')
  const [loading, setLoading] = useState(true)
  const [capability, setCapability] = useState<CloudCapability | undefined>()

  // 同一页面内关系链上下文变化时同步筛选值（刷新/后退恢复也走这里）。
  useEffect(() => {
    if (focus?.workspaceId !== undefined) setWorkspaceId(focus.workspaceId)
  }, [focus])

  const reload = useCallback(async (): Promise<void> => {
    setLoading(true)
    const result = await api.cloudAudits(workspaceId === '' ? {} : { workspaceId })
    setLoading(false)
    setCapability(capabilityFromResult('audits', result, result.ok ? result.value.length : undefined))
    if (result.ok) setAudits(result.value)
    else {
      setAudits([])
      onAction(result, '')
    }
  }, [api, onAction, workspaceId])

  useEffect(() => {
    void reload()
  }, [reload])

  // 关系链焦点：核对目标审计是否真的在服务端结果里，越权/不存在不得退化成空表。
  const focusMissed =
    !loading
    && focus !== undefined
    && (focus.requestId !== undefined || focus.workspaceId !== undefined)
    && !audits.some(
      audit =>
        (focus.requestId === undefined || audit.request_id === focus.requestId)
        && (focus.workspaceId === undefined || audit.workspace_id === focus.workspaceId),
    )

  if (loading) return <div className="page-loading">加载中…</div>
  return (
    <div className="page-body">
      <div className="page-intro">
        <div>
          <span className="eyebrow">云工作空间治理</span>
          <h2>审计</h2>
          <p>Workspace、Run 与配置的历史审计记录。</p>
        </div>
      </div>
      <p className="fixture-note" data-fixture-only="true">审计数据来自本地 fixture 服务（fixture-only），不是生产审计证据。</p>
      {capability !== undefined && <CapabilityStrip capabilities={[capability]} />}
      <CapabilityFailureNote capability={capability} />
      <RelationContextNote focus={focus} />
      {focusMissed && (
        <RelationTargetMissing
          focus={focus}
          message={`服务端未返回目标审计 ${focus.requestId ?? focus.workspaceId}。越权、已删除或对象不存在时不得以空列表代替失败，请核对来源 Workspace 或重新查询。`}
        />
      )}
      <label className="inline-field">
        Workspace ID
        <input aria-label="审计 Workspace 筛选" value={workspaceId} onChange={(event) =>{  setWorkspaceId(event.target.value) }} />
      </label>
      <button type="button" onClick={() => void reload()}>查询</button>
      <table className="admin-table">
        <thead>
          <tr>
            <th>操作者</th>
            <th>动作 / 结果</th>
            <th>资源关联</th>
            <th>request_id</th>
            <th>时间</th>
          </tr>
        </thead>
        <tbody>
          {audits.map((audit, index) => (
            <tr
              key={`${audit.request_id}-${index}`}
              aria-current={audit.request_id === focus?.requestId ? 'true' : undefined}
              data-focused={audit.request_id === focus?.requestId ? 'true' : undefined}
            >
              <td>{audit.actor_name}</td>
              <td>{audit.action} · {audit.result}{audit.error_code === null ? '' : ` · ${audit.error_code}`}</td>
              <td>
                {[audit.project_id, audit.workspace_id, audit.session_id, audit.run_id, audit.agent_profile_id]
                  .filter(part => part !== null)
                  .join(' / ') || '—'}
              </td>
              <td>{audit.request_id}</td>
              <td>{audit.occurred_at}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** Agent 执行器类型：只维护服务端返回的元数据与 readiness。 */
export function CloudTypesPage({ api, onAction }: PageProps) {
  const [types, setTypes] = useState<readonly CloudAgentType[]>([])
  const [loading, setLoading] = useState(true)
  const [readFailed, setReadFailed] = useState(false)
  const [capability, setCapability] = useState<CloudCapability | undefined>()

  const reload = useCallback(async (): Promise<void> => {
    setLoading(true)
    const result = await api.cloudAgentTypes()
    setLoading(false)
    setCapability(capabilityFromResult('agent-types', result, result.ok ? result.value.length : undefined))
    if (result.ok) {
      setTypes(result.value)
      setReadFailed(false)
    } else {
      setTypes([])
      // 失败、协议错误或无权限时保留显式失败状态，绝不降级成空列表。
      setReadFailed(true)
      onAction(result, '')
    }
  }, [api, onAction])

  useEffect(() => {
    void reload()
  }, [reload])

  if (loading) return <Loading />
  return (
    <div className="page-body">
      <div className="page-intro">
        <div>
          <span className="eyebrow">云工作空间治理</span>
          <h2>Agent 类型</h2>
          <p>执行器类型与 readiness 状态。</p>
        </div>
      </div>
      <p className="fixture-note" data-fixture-only="true">Agent 类型数据来自本地 fixture 服务（fixture-only），readiness 以服务端返回为准。</p>
      {capability !== undefined && <CapabilityStrip capabilities={[capability]} />}
      <CapabilityFailureNote capability={capability} />
      {!readFailed && types.length === 0 && <Empty text="暂无 Agent 类型：服务端返回的执行器类型列表为空。" />}
      <table className="admin-table">
        <thead>
          <tr>
            <th>类型 ID</th>
            <th>标识</th>
            <th>名称</th>
            <th>能力</th>
            <th>readiness</th>
          </tr>
        </thead>
        <tbody>
          {types.map(agentType => (
            <tr key={agentType.agent_type_id}>
              <td>{agentType.agent_type_id}</td>
              <td>{agentType.key}</td>
              <td>{agentType.name}</td>
              <td>{agentType.capabilities.join('、')}</td>
              <td>{agentType.readiness}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
