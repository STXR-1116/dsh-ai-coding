// workspace-http.ts 逐文件 100% 收官矩阵（终收尾轮·覆盖专项）。
//
// 对 30 个导出解析器建立最小合法样本，并对每个必填字段执行「删除 → 必须抛
// SERVICE_PROTOCOL_ERROR」的变异断言（严格解析器的每个缺失分支都要走到）；
// 枚举、错型、空串与特殊规则（preview 正文/摘要/CSP、lens 抑制原因、记忆
// 身份、审批资产状态、checkpoint 恢复预览）另配代表断言。
//
// 分类：FIXTURE-ONLY。
import { describe, expect, it } from 'vitest'
import {
  normalizePreviewOrigin,
  parseAgentProfile,
  parseAgentType,
  parseAgentTypeSchema,
  parseApproval,
  parseAssetCandidate,
  parseChanges,
  parseCodeSource,
  parseContextLens,
  parseDirectory,
  parseEvidence,
  parseFileContent,
  parsePlan,
  parsePreview,
  parsePreviewUrlGrant,
  parseProfileDryRun,
  parseProfileEditContext,
  parsePulse,
  parsePullRequestResult,
  parseRevisionResult,
  parseRun,
  parseRunAssetSnapshot,
  parseRunCheckpoint,
  parseStreamEvent,
  parseWorkspace,
} from '../src/workspace-http.ts'

const TS = '2026-09-17T00:00:00.000Z'

const EXECUTION_POLICY = {
  permission_mode: 'approval',
  tool_allowlist: ['read', 'write'],
  max_concurrency: 2,
  budget: 1000,
  timeout_ms: 60000,
  write_mode: 'read_only',
}

const WORKSPACE = {
  workspace_id: 'ws-1',
  project_id: 'project-alpha',
  owner_user_id: 'user-1',
  repository_id: 'repo-1',
  branch: 'main',
  display_name: '工作空间',
  default_agent_profile_version_id: 'apv-1',
  revision: 7,
  last_error: null,
  created_at: TS,
  updated_at: TS,
  status: 'ready',
}

const SCHEMA_FIELDS = [
  { key: 'k', label: '标签', type: 'enum', required: true, affects_publish: true, description: '描述', enum: ['a', 'b'], min: 0, max: 9 },
]

const SCHEMA = {
  agent_type_id: 'at-1',
  schema: SCHEMA_FIELDS,
  key: 'at-key',
  schema_version: '1',
  credential_required: false,
}

const AGENT_TYPE = {
  agent_type_id: 'at-1',
  key: 'at-key',
  name: '研发代理',
  readiness: 'ready',
  capabilities: ['plan'],
  description: '默认研发代理',
  credential_ref: null,
}

const CODE_SOURCE = {
  repository_id: 'repo-1',
  branches: ['main', 'dev'],
  default_branch: 'main',
  name: 'harness-web',
  provider: 'gitlab',
}

const BINDING = {
  asset_id: 'k-1',
  asset_version_id: 'k-1@1',
  name: '项目知识库',
  required: false,
  order: 0,
  readiness: 'ready',
  unavailable_reason: null,
}

const PROFILE = {
  status: 'published',
  agent_profile_id: 'ap-1',
  agent_profile_version_id: 'apv-1',
  name: '默认研发代理',
  description: '服务端描述',
  version_label: '1.0.0',
  change_summary: '发布说明',
  agent_type_id: 'at-1',
  agent_type_name: '研发代理',
  agent_type_key: 'at-key',
  agent_type_readiness: 'ready',
  agent_type_capabilities: ['plan'],
  model: 'deepseek-chat',
  reasoning: 'medium',
  skills: [BINDING],
  knowledge_bases: [BINDING],
  memory: BINDING,
  execution_policy: EXECUTION_POLICY,
  readiness: 'ready',
  unavailable_reason: null,
  default: true,
  created_by: 'user-1',
  published_at: TS,
  updated_at: TS,
  type_extension_config: { k: 'v' },
}

const EVIDENCE = {
  request_id: 'req-1',
  outcome: 'succeeded',
  reason: '完成',
  revision: 3,
  audit_id: 'audit-1',
  affected: ['ws-1'],
  next_action: '无',
}

const TIMELINE = [{ status: 'running', at: TS, reason: '开始执行', operator: 'system', policy_version: 'apv-1', revision: 2, trace_id: 't-1' }]

const RUN = {
  run_id: 'run-1',
  project_id: 'project-alpha',
  workspace_id: 'ws-1',
  session_id: 's-1',
  agent_profile_version_id: 'apv-1',
  asset_version_ids: ['skill:review@1.0.0'],
  execution_policy: EXECUTION_POLICY,
  workspace_revision: 6,
  status: 'running',
  write_mode: 'read_only',
  lease_id: null,
  revision: 2,
  error_code: null,
  created_at: TS,
  updated_at: TS,
  events: TIMELINE,
  operator: '演示成员',
  evidence: EVIDENCE,
}

const LENS = {
  workspace_id: 'ws-1',
  revision: 1,
  generated_at: TS,
  entries: [
    {
      source: 'memory',
      title: '记忆条目',
      memory_id: 'm-1',
      permission: 'allowed',
      permission_reason: null,
      selection_reason: '内容匹配',
      injected: true,
      updated_at: TS,
    },
    {
      source: 'knowledge',
      title: '知识条目',
      memory_id: null,
      permission: 'suppressed',
      permission_reason: '未授权',
      selection_reason: '内容匹配',
      injected: false,
      updated_at: TS,
    },
  ],
  permission_decisions: [
    { action: 'terminal.read', decision: 'allowed', code: 'OK', reason: '允许', policy_version: 'p1', at: TS },
  ],
}

const RUN_ASSET_SNAPSHOT = {
  run_id: 'run-1',
  captured_at: TS,
  run_revision: 4,
  assets: [
    {
      asset_type: 'memory',
      asset_id: 'm-1',
      asset_version_id: 'm-1',
      name: '记忆',
      required: false,
      order: 0,
      readiness_at_binding: 'ready',
      unavailable_reason_at_binding: null,
      current_state: 'bound',
      withdrawn_at: null,
      withdrawal_audit_id: null,
    },
    {
      asset_type: 'skill',
      asset_id: 'skill-1',
      asset_version_id: 'skill-1@2',
      name: '技能',
      required: true,
      order: 1,
      readiness_at_binding: 'ready',
      unavailable_reason_at_binding: null,
      current_state: 'withdrawn',
      withdrawn_at: TS,
      withdrawal_audit_id: 'audit-9',
    },
  ],
  governance: [
    { audit_id: 'audit-9', action: 'asset.withdraw', actor_name: '管理员', at: TS, asset_version_id: 'skill-1@2' },
  ],
}

const ASSET_CANDIDATE = {
  asset_id: 'k-1',
  asset_type: 'knowledge',
  version: 'v1',
  name: '项目知识库',
  authorized: true,
  readiness: 'ready',
  invalid_reason: null,
  updated_at: TS,
  purpose: '项目规范',
  source: 'team',
}

const DRY_RUN = {
  dry_run_id: 'dry-1',
  agent_profile_version_id: 'apv-1',
  outcome: 'ready',
  checks: [{ check: '资产就绪', result: 'pass', detail: '全部就绪' }],
  created_at: TS,
}

const EDIT_CONTEXT = {
  agent_profile_id: 'ap-1',
  revision: 5,
  name: '默认研发代理',
  versions: [{ agent_profile_version_id: 'apv-1', version: '1.0.0', status: 'published' }],
}

const PULSE = {
  run_id: 'run-1',
  items: [
    { kind: 'status', at: TS, revision: 1, trace_id: 't-1', summary: '开始', status: 'running', reason: '准备完成', operator: 'system', policy_version: 'apv-1' },
    { kind: 'test', at: TS, revision: 2, trace_id: 't-1', summary: '测试', total: 3, passed: 3, failed: 0 },
  ],
}

const APPROVAL = {
  approval_id: 'appr-1',
  run_id: 'run-1',
  action: 'terminal.write',
  summary: '写入终端',
  affected: ['ws-1'],
  permission: { code: 'OK', allowed: true, reason: '允许', policy_version: 'p1' },
  asset_versions: [{ asset_version_id: 'skill-1@1', status: 'bound', detail: '绑定' }],
  risk: { level: 'low', reason: '低风险' },
  revocable: { revocable: true, how: '再次决策' },
  expires_at: TS,
  created_at: TS,
}

const DIRECTORY = {
  path: '',
  revision: 2,
  items: [{ path: 'README.md', kind: 'file', size: 10, etag: 'e1' }],
}

const FILE_CONTENT = { path: 'README.md', content_type: 'text/plain', size: 10, etag: 'e1', revision: 1, content: '# hi\n' }

const CHANGES = {
  workspace_id: 'ws-1',
  baseline_revision: 5,
  revision: 7,
  files: [{ path: 'src/a.ts', change: 'modified', diff: '@@ -1 +1 @@\n-a\n+b\n' }],
}

const PLAN = {
  plan_id: 'plan-1',
  project_id: 'project-alpha',
  workspace_id: 'ws-1',
  goal: '目标',
  steps: [{ title: '步骤一' }, { title: '步骤二', depends_on: [0] }],
  agent_profile_version_id: 'apv-1',
  asset_version_ids: ['k-1'],
  status: 'confirmed',
  revision: 2,
  created_by: 'member-1',
  created_at: TS,
  updated_at: TS,
  edits: [
    {
      edit_id: 'edit-1',
      editor: 'member-1',
      edited_at: TS,
      change_summary: '修订',
      revision_before: 1,
      revision_after: 2,
      before: { goal: '旧目标', steps: [{ title: '旧步骤' }], agent_profile_version_id: 'apv-1', asset_version_ids: [] },
    },
  ],
}

const STREAM_EVENT = {
  event_id: 'evt-1',
  resource_type: 'workspace',
  resource_id: 'ws-1',
  revision: 1,
  event_type: 'workspace.ready',
  occurred_at: TS,
  payload: { status: 'ready' },
}

const CHECKPOINT = {
  checkpoint_id: 'ckpt-1',
  created_at: TS,
  trace_id: 't-1',
  session_seq: 4,
  tool_results: [{ call_id: 'c-1', tool: 'write_file', result: '已写入' }],
  pending_approval: null,
  completed_steps: [0, 1],
  agent_config: { agent_profile_version_id: 'apv-1', execution_policy: EXECUTION_POLICY },
  asset_version_ids: ['k-1'],
  workspace_revision: 6,
  plan_id: 'plan-1',
  steps: ['步骤一', '步骤二'],
  resume_preview: {
    reuse: [{ kind: 'tool_result', call_id: 'c-1', tool: 'write_file' }],
    replay: [{ title: '步骤二' }],
  },
}

const PREVIEW_HTML = {
  path: 'index.html',
  revision: 1,
  etag: 'e1',
  kind: 'static_html',
  content_type: 'text/html',
  content: '<p>hi</p>',
  sha256: 'abc',
  csp: "default-src 'none'",
  sandbox: ['allow-scripts'],
}

const PREVIEW_DIFF = { path: 'a.ts', revision: 1, etag: 'e1', kind: 'diff', content_type: 'text/diff', diff: '@@ -1 +1 @@' }

const PREVIEW_URL_GRANT = { url: 'https://preview.example.test/app/', workspace_id: 'ws-1', expires_at: '2099-01-01T00:00:00.000Z' }

type Parser = {
  name: string
  run: (v: unknown) => unknown
  valid: () => unknown
  /** 契约上缺失也合法的顶层键（宽松映射或可选成员）：缺失时不得断言必抛。 */
  optionalTop?: readonly string[]
}

export const PARSERS: readonly Parser[] = [
  { name: 'parseAgentTypeSchema', run: parseAgentTypeSchema, valid: () => SCHEMA, optionalTop: ['credential_required'] },
  { name: 'parseWorkspace', run: parseWorkspace, valid: () => WORKSPACE, optionalTop: ['status'] },
  { name: 'parseAgentType', run: parseAgentType, valid: () => AGENT_TYPE, optionalTop: ['description', 'credential_ref'] },
  { name: 'parseCodeSource', run: parseCodeSource, valid: () => CODE_SOURCE },
  { name: 'parseAgentProfile', run: parseAgentProfile, valid: () => PROFILE, optionalTop: ['execution_policy'] },
  { name: 'parseRun', run: parseRun, valid: () => RUN, optionalTop: ['status', 'events', 'operator', 'evidence'] },
  { name: 'parseEvidence', run: parseEvidence, valid: () => EVIDENCE },
  { name: 'parseContextLens', run: parseContextLens, valid: () => LENS },
  { name: 'parseRunAssetSnapshot', run: parseRunAssetSnapshot, valid: () => RUN_ASSET_SNAPSHOT },
  { name: 'parseAssetCandidate', run: parseAssetCandidate, valid: () => ASSET_CANDIDATE },
  { name: 'parseProfileDryRun', run: parseProfileDryRun, valid: () => DRY_RUN },
  { name: 'parseProfileEditContext', run: parseProfileEditContext, valid: () => EDIT_CONTEXT },
  { name: 'parsePulse', run: parsePulse, valid: () => PULSE },
  { name: 'parseApproval', run: parseApproval, valid: () => APPROVAL },
  { name: 'parseDirectory', run: parseDirectory, valid: () => DIRECTORY },
  { name: 'parseFileContent', run: parseFileContent, valid: () => FILE_CONTENT, optionalTop: ['content', 'content_base64'] },
  { name: 'parseChanges', run: parseChanges, valid: () => CHANGES },
  { name: 'parsePreview', run: parsePreview, valid: () => PREVIEW_HTML, optionalTop: ['content'] },
  { name: 'parsePlan', run: parsePlan, valid: () => PLAN, optionalTop: ['status'] },
  { name: 'parseStreamEvent', run: parseStreamEvent, valid: () => STREAM_EVENT, optionalTop: ['resource_type'] },
  { name: 'parseRunCheckpoint', run: parseRunCheckpoint, valid: () => CHECKPOINT, optionalTop: ['checkpoint_id', 'steps'] },
]

function clone(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value))
}

function collectFieldPaths(value: unknown): Set<string> {
  const paths = new Set<string>()
  const walk = (item: unknown, prefix: string): void => {
    if (Array.isArray(item)) {
      item.forEach((entry, index) => {
        walk(entry, prefix === '' ? String(index) : `${prefix}.${String(index)}`)
      })
      return
    }
    if (typeof item === 'object' && item !== null) {
      for (const [key, entry] of Object.entries(item as Record<string, unknown>)) {
        const path = prefix === '' ? key : `${prefix}.${key}`
        paths.add(path)
        walk(entry, path)
      }
    }
  }
  walk(value, '')
  return paths
}

describe('workspace-http 严格解析矩阵（每必填字段缺失必须拒绝）', () => {
  for (const parser of PARSERS) {
    it(`${parser.name}: accepts the valid sample and rejects the deleted top-level required fields`, () => {
      const sample = parser.valid()
      expect(() => parser.run(clone(sample))).not.toThrow()

      // 逐顶层字段剔除（no-dynamic-delete 规则禁 delete，用排除法重建）：
      // required 字段缺失必抛；optionalTop 登记的宽松键缺失时解析成功。
      const optional = new Set(parser.optionalTop ?? [])
      const topFields = [...collectFieldPaths(sample)].filter(path => !path.includes('.'))
      for (const removed of topFields) {
        const payload: Record<string, unknown> = {}
        for (const [key, value] of Object.entries(clone(sample) as Record<string, unknown>)) {
          if (key !== removed) payload[key] = value
        }
        if (optional.has(removed)) continue
        expect(() => parser.run(payload), `${parser.name} 缺少 ${removed} 必须抛出`).toThrow()
      }
    })

    it(`${parser.name}: rejects a non-object payload`, () => {
      expect(() => parser.run(42)).toThrow()
      expect(() => parser.run(null)).toThrow()
      expect(() => parser.run('str')).toThrow()
    })
  }

  it('parseWorkspace rejects wrong-typed required fields and empty strings; unknown lifecycle maps to unknown', () => {
    for (const field of ['workspace_id', 'project_id', 'revision']) {
      const payload = clone(WORKSPACE) as Record<string, unknown>
      payload[field] = typeof WORKSPACE[field as keyof typeof WORKSPACE] === 'number' ? 'x' : 42
      expect(() => parseWorkspace(payload), field).toThrow()
    }
    const unknownLifecycle = clone(WORKSPACE) as Record<string, unknown>
    unknownLifecycle.status = 'materializing'
    expect(parseWorkspace(unknownLifecycle).status).toBe('unknown')
    const emptyString = clone(WORKSPACE) as Record<string, unknown>
    emptyString.branch = ''
    expect(() => parseWorkspace(emptyString)).toThrow()
  })

  it('parseRun maps an unknown run status to the explicit unknown member and rejects a bad write mode', () => {
    const unknownStatus = clone(RUN) as Record<string, unknown>
    unknownStatus.status = 'time-traveling'
    const parsed = parseRun(unknownStatus)
    expect(parsed.status).toBe('unknown')
    const badMode = clone(RUN) as Record<string, unknown>
    badMode.write_mode = 'sometimes'
    expect(() => parseRun(badMode)).toThrow()
  })

  it('parseContextLens enforces the closed source vocabulary and suppression rules', () => {
    const badSource = clone(LENS) as Record<string, unknown>
    badSource.entries = [{ ...(LENS.entries[0] as Record<string, unknown>), source: 'gossip' }]
    expect(() => parseContextLens(badSource)).toThrow('closed vocabulary')
    const suppressedWithoutReason = clone(LENS) as Record<string, unknown>
    suppressedWithoutReason.entries = [
      { source: 'knowledge', title: 't', memory_id: null, permission: 'suppressed', permission_reason: null, selection_reason: 's', injected: false, updated_at: TS },
    ]
    expect(() => parseContextLens(suppressedWithoutReason)).toThrow('permission reason')
    const memoryWithoutIdentity = clone(LENS) as Record<string, unknown>
    memoryWithoutIdentity.entries = [
      { source: 'memory', title: 't', memory_id: null, permission: 'allowed', permission_reason: null, selection_reason: 's', injected: true, updated_at: TS },
    ]
    expect(() => parseContextLens(memoryWithoutIdentity)).toThrow('memory identity')
    const nonMemoryWithIdentity = clone(LENS) as Record<string, unknown>
    nonMemoryWithIdentity.entries = [
      { source: 'knowledge', title: 't', memory_id: 'm-9', permission: 'allowed', permission_reason: null, selection_reason: 's', injected: true, updated_at: TS },
    ]
    expect(() => parseContextLens(nonMemoryWithIdentity)).toThrow('must not carry a memory identity')
  })

  it('parseRunAssetSnapshot keeps withdrawal facts consistent with the current state', () => {
    const inconsistent = clone(RUN_ASSET_SNAPSHOT) as Record<string, unknown>
    inconsistent.assets = [
      { ...(RUN_ASSET_SNAPSHOT.assets[1] as Record<string, unknown>), current_state: 'withdrawn', withdrawn_at: null, withdrawal_audit_id: null },
      { ...(RUN_ASSET_SNAPSHOT.assets[1] as Record<string, unknown>), current_state: 'bound' },
    ]
    expect(() => parseRunAssetSnapshot(inconsistent)).toThrow('withdrawal')
  })

  it('parsePulse rejects a pulse entry outside the closed kind vocabulary', () => {
    const bad = clone(PULSE) as Record<string, unknown>
    bad.items = [{ kind: 'vibes', at: TS, revision: 1, trace_id: 't', summary: 'x' }]
    expect(() => parsePulse(bad)).toThrow('closed vocabulary')
  })

  it('parsePreview enforces the per-kind body, digest, csp and sandbox rules', () => {
    const noBody = clone(PREVIEW_HTML) as Record<string, unknown>
    delete noBody.content
    delete noBody.content_base64
    expect(() => parsePreview(noBody)).toThrow('carries no body')
    const noDiff = clone(PREVIEW_DIFF) as Record<string, unknown>
    delete noDiff.diff
    expect(() => parsePreview(noDiff)).toThrow('carries no diff')
    const missingSha = clone(PREVIEW_HTML) as Record<string, unknown>
    delete missingSha.sha256
    expect(() => parsePreview(missingSha)).toThrow('sha256')
    const missingCsp = clone(PREVIEW_HTML) as Record<string, unknown>
    delete missingCsp.csp
    expect(() => parsePreview(missingCsp)).toThrow('csp')
    const missingSandbox = clone(PREVIEW_HTML) as Record<string, unknown>
    delete missingSandbox.sandbox
    expect(() => parsePreview(missingSandbox)).toThrow('sandbox')
    const unknownKind = clone(PREVIEW_HTML) as Record<string, unknown>
    unknownKind.kind = 'hologram'
    expect(() => parsePreview(unknownKind)).toThrow('unknown preview kind')
    const markdown = clone(PREVIEW_DIFF) as Record<string, unknown>
    markdown.kind = 'markdown'
    markdown.content = '# md'
    expect(() => parsePreview(markdown)).not.toThrow()
  })

  it('normalizePreviewOrigin and parsePreviewUrlGrant enforce the allowlist policy', () => {
    expect(() => normalizePreviewOrigin('ftp://x')).toThrow('http or https')
    expect(() => normalizePreviewOrigin('https://x/path')).toThrow('bare origin')
    expect(normalizePreviewOrigin('https://preview.example.test')).toBe('https://preview.example.test')

    const policy = { allowedOrigins: ['https://preview.example.test'], workspaceId: 'ws-1' } as const
    expect(parsePreviewUrlGrant(clone(PREVIEW_URL_GRANT), policy).url).toContain('preview.example.test')
    const otherOrigin = { ...policy, allowedOrigins: ['https://other.test'] }
    expect(() => parsePreviewUrlGrant(clone(PREVIEW_URL_GRANT), otherOrigin)).toThrow('not allowlisted')
    const otherWorkspace = clone(PREVIEW_URL_GRANT) as Record<string, unknown>
    otherWorkspace.workspace_id = 'ws-2'
    expect(() => parsePreviewUrlGrant(otherWorkspace, policy)).toThrow('belongs to')
    const badTime = clone(PREVIEW_URL_GRANT) as Record<string, unknown>
    badTime.expires_at = 'not-a-date'
    expect(() => parsePreviewUrlGrant(badTime, policy)).toThrow('not a valid timestamp')
    const expired = clone(PREVIEW_URL_GRANT) as Record<string, unknown>
    expired.expires_at = '2000-01-01T00:00:00.000Z'
    expect(() => parsePreviewUrlGrant(expired, policy)).toThrow('expired')
    const badScheme = clone(PREVIEW_URL_GRANT) as Record<string, unknown>
    badScheme.url = 'ftp://preview.example.test/x'
    expect(() => parsePreviewUrlGrant(badScheme, policy)).toThrow('http or https')
  })

  it('parsePlan keeps edit history strict', () => {
    const noBefore = clone(PLAN) as Record<string, unknown>
    const edits = noBefore.edits as Array<Record<string, unknown>>
    const firstEdit = edits[0] as Record<string, unknown>
    if (firstEdit === undefined) throw new Error('fixture edits[0] missing')
    delete firstEdit.before
    expect(() => parsePlan(noBefore)).toThrow('plan edit before')
    const badSteps = clone(PLAN) as Record<string, unknown>
    badSteps.steps = [{ nope: true }]
    expect(() => parsePlan(badSteps)).toThrow('plan steps title')
    const unknownStatus = clone(PLAN) as Record<string, unknown>
    unknownStatus.status = 'vibing'
    expect(parsePlan(unknownStatus).status).toBe('unknown')
  })

  it('parseRunCheckpoint requires the resume preview structure', () => {
    const noPreview = clone(CHECKPOINT) as Record<string, unknown>
    delete noPreview.resume_preview
    expect(() => parseRunCheckpoint(noPreview)).toThrow('resume_preview')
    const noReuse = clone(CHECKPOINT) as Record<string, unknown>
    noReuse.resume_preview = { replay: [] }
    expect(() => parseRunCheckpoint(noReuse)).toThrow('resume_preview reuse')
  })

  it('parseRevisionResult and parsePullRequestResult reject malformed payloads', () => {
    expect(() => parseRevisionResult({ revision: -1 })).toThrow()
    expect(parseRevisionResult({ revision: 3 }).revision).toBe(3)
    expect(() => parsePullRequestResult({ pull_request_id: '' })).toThrow()
    expect(parsePullRequestResult({ pull_request_id: 'pr-1' }).pullRequestId).toBe('pr-1')
  })
})
