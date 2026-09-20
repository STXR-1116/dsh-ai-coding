/* workspace-http 的响应信封、可选成员与闭集词表守卫（覆盖专项：workspace-http 批·续）。
 *
 * 三类：①`errorOf` / `parseEnvelope` 对失败响应与非成功信封的形状判定（非 JSON 错误体、
 * 缺 code、缺 request_id/data、`code !== 0`）；②契约可选成员「存在即为数据」的
 * 两支（content / content_base64 存在时的透传、next_cursor 的类型守卫）；
 * ③闭集词表守卫的拒绝臂（source 层、permission、decision、dry-run check、pulse
 * approval、approval risk / asset status、default_branch 不属于 branches）。
 *
 * 分类：FIXTURE-ONLY（构造载荷，不发真实请求）。
 */
import { describe, expect, it } from 'vitest'
import {
  WorkspaceHttpClient,
  parseAgentProfile,
  parseAgentTypeSchema,
  parseApproval,
  parseCodeSource,
  parseContextLens,
  parseFileContent,
  parsePage,
  parsePreview,
  parsePreviewUrlGrant,
  parseProfileDryRun,
  parsePulse,
} from '../src/workspace-http.ts'

/** A client whose one response is scripted, so the envelope paths run for real. */
function clientReturning(status: number, body: string): WorkspaceHttpClient {
  return new WorkspaceHttpClient('http://service.test', async () =>
    new Response(body, { status, headers: { 'content-type': 'application/json' } }))
}

/** The stable fields of the failure one request must raise. */
interface RaisedFailure {
  readonly code: string
  readonly message: string
  readonly requestId?: string
  readonly httpStatus?: number
}

/** Runs a request that must fail and hands back the raised failure. */
async function raisedBy(client: WorkspaceHttpClient): Promise<RaisedFailure> {
  try {
    await client.request('/x', {}, 't')
  } catch (error) {
    return error as RaisedFailure
  }
  throw new Error('请求本应失败，却成功了')
}

const lensEntry = {
  source: 'memory',
  title: '记忆：协作偏好',
  memory_id: 'mem-1',
  permission: 'allowed',
  permission_reason: null,
  selection_reason: '在有效期内，注入',
  injected: true,
  updated_at: '2026-09-01T00:00:00.000Z',
}

const lensDecision = {
  action: 'workspace.write',
  decision: 'allowed',
  code: 'OK',
  reason: '项目成员具备写入授权',
  policy_version: 'perm-policy@1',
  at: '2026-09-01T00:06:00.000Z',
}

const lens = { workspace_id: 'ws-1', revision: 1, generated_at: 'g', entries: [lensEntry], permission_decisions: [lensDecision] }

/** A published profile DTO that declares no execution policy at all. */
const publishedProfile = {
  agent_profile_id: 'ap-1',
  agent_profile_version_id: 'apv-1',
  name: 'Default',
  description: '默认执行配置',
  version_label: 'v1',
  change_summary: '首个发布版本',
  agent_type_id: 'at-1',
  agent_type_name: 'Claude Code',
  agent_type_key: 'claude_code',
  agent_type_readiness: 'ready',
  agent_type_capabilities: ['bash'],
  model: 'deepseek-v3.2',
  reasoning: 'medium',
  skills: [],
  knowledge_bases: [],
  memory: null,
  type_extension_config: { permission_mode: 'approval' },
  readiness: 'ready',
  unavailable_reason: null,
  default: false,
  status: 'published',
  created_by: '平台管理员',
  published_at: '2026-09-01T00:00:00.000Z',
  updated_at: '2026-09-01T00:00:00.000Z',
}

describe('失败响应与非成功信封', () => {
  it('names an unparsable error body and an error envelope without a code', async () => {
    await expect(clientReturning(500, 'gateway exploded').request('/x', {}, 't'))
      .rejects.toThrow(/invalid JSON error response/u)

    // 有 message 但没有 code：不是可用的错误信封。
    await expect(clientReturning(400, JSON.stringify({ message: '坏了' })).request('/x', {}, 't'))
      .rejects.toThrow(/invalid error envelope/u)
  })

  it('keeps the request id, the status and the details of a well-formed error', async () => {
    const bare = await raisedBy(clientReturning(429, JSON.stringify({ code: 'RATE_LIMITED' })))
    expect(bare.code).toBe('RATE_LIMITED')
    expect(bare.message).toBe('Cloud workspace request failed.')
    expect(bare.requestId).toBeUndefined()
    expect(bare.httpStatus).toBe(429)

    const detailed = await raisedBy(clientReturning(409, JSON.stringify({
      code: 'REVISION_CONFLICT', message: '冲突', request_id: 'req-9', details: { current_revision: 3 },
    })))
    expect(detailed.message).toBe('冲突 {"current_revision":3}')
    expect(detailed.requestId).toBe('req-9')
  })

  it('rejects a 200 envelope that is not an envelope, and one whose code is not zero', async () => {
    await expect(clientReturning(200, JSON.stringify({ code: 0, data: {} })).request('/x', {}, 't'))
      .rejects.toThrow(/invalid envelope/u)

    // 200 但 code 非 0：服务端用成功状态码表达了失败，必须按失败处理。
    const nonZero = await raisedBy(clientReturning(200, JSON.stringify({ code: 'PARTIAL', message: '部分成功', request_id: 'r', data: null })))
    expect(nonZero.code).toBe('PARTIAL')
    expect(nonZero.message).toBe('部分成功')
  })
})

describe('契约可选成员', () => {
  it('passes a present content or content_base64 through and types the cursor', async () => {
    const withContent = parseFileContent({
      path: 'README.md', content_type: 'text/markdown', size: 3, etag: 'e', revision: 1, content: '# a',
    })
    expect(withContent.content).toBe('# a')
    const withBase64 = parseFileContent({
      path: 'logo.png', content_type: 'image/png', size: 4, etag: 'e', revision: 1, content_base64: 'AAAA',
    })
    expect(withBase64.contentBase64).toBe('AAAA')

    const preview = parsePreview({
      path: 'logo.png', revision: 1, etag: 'e', kind: 'image', content_type: 'image/png', content_base64: 'AAAA',
    })
    expect(preview.contentBase64).toBe('AAAA')
    // 空字符串是合法服务端取值，不得被读成「缺字段」。
    const empty = parsePreview({
      path: 'notes.txt', revision: 1, etag: 'e', kind: 'text', content_type: 'text/plain', content: '',
    })
    expect(empty.content).toBe('')
  })
})

describe('闭集词表守卫', () => {
  it('rejects a default branch the service did not publish', () => {
    expect(() => parseCodeSource({
      repository_id: 'r', name: 'n', provider: 'gitlab', default_branch: 'trunk', branches: ['main'],
    })).toThrow(/default_branch is not one of its branches/u)
    expect(parseCodeSource({
      repository_id: 'r', name: 'n', provider: 'gitlab', default_branch: 'main', branches: ['main', 'develop'],
    }).defaultBranch).toBe('main')
  })

  it('rejects lens entries and decisions outside their closed vocabularies', () => {
    expect(() => parseContextLens({ ...lens, entries: [{ ...lensEntry, permission: 'maybe' }] }))
      .toThrow(/permission must be allowed or suppressed/u)
    expect(() => parseContextLens({ ...lens, permission_decisions: [{ ...lensDecision, decision: 'abstain' }] }))
      .toThrow(/decision must be allowed or denied/u)
    expect(() => parseContextLens({ ...lens, entries: [{ ...lensEntry, source: 'telepathy' }] }))
      .toThrow(/closed vocabulary/u)
  })

  it('rejects a dry-run check result, a pulse decision and approval vocabularies outside their sets', () => {
    expect(() => parseProfileDryRun({
      agent_profile_version_id: 'apv-1', outcome: 'ready', created_at: 'a',
      checks: [{ check: 'asset_ready', result: 'unknown', detail: 'd' }],
    })).toThrow(/check result must be pass, warn or fail/u)

    expect(() => parsePulse({
      run_id: 'run-1',
      items: [{ kind: 'approval', at: 'a', revision: 1, trace_id: 't', summary: 's', decision: 'abstain', operator: 'o' }],
    })).toThrow(/approval decision must be approve or reject/u)

    const approval = {
      approval_id: 'ap-1', run_id: 'run-1', action: 'git.commit', summary: '提交', affected: ['ws-1'],
      permission: { code: 'OK', allowed: true, reason: 'r', policy_version: 'perm-policy@1' },
      asset_versions: [{ asset_version_id: 'skill:a@1', status: 'bound', detail: 'd' }],
      risk: { level: 'low', reason: 'r' },
      revocable: { revocable: true, how: '拒绝即可' },
      expires_at: '2026-09-01T00:15:00.000Z', created_at: '2026-09-01T00:00:00.000Z',
    }
    expect(parseApproval(approval).approvalId).toBe('ap-1')
    expect(() => parseApproval({ ...approval, risk: { level: 'extreme', reason: 'r' } }))
      .toThrow(/risk level must be low, medium or high/u)
    expect(() => parseApproval({ ...approval, asset_versions: [{ asset_version_id: 'skill:a@1', status: 'gone', detail: 'd' }] }))
      .toThrow(/asset status must be bound, withdrawn or missing/u)
  })

  it('rejects a preview origin and a preview url grant that are not usable origins', () => {
    expect(() => parsePreviewUrlGrant({ url: 'not a url', workspace_id: 'ws-1', expires_at: '2030-01-01T00:00:00.000Z' }, {
      allowedOrigins: ['https://apps.test'], workspaceId: 'ws-1',
    })).toThrow(/not an absolute URL/u)
  })
})

describe('可选成员的缺省臂', () => {
  it('defaults credential_required to false and a null description to null', () => {
    const schema = parseAgentTypeSchema({
      agent_type_id: 'at-1', key: 'claude_code', schema_version: '1',
      schema: [{
        key: 'permission_mode', label: '权限模式', type: 'enum', required: true, affects_publish: true,
        description: null, enum_values: [],
      }],
    })
    expect(schema.credentialRequired).toBe(false)
    expect(schema.schema[0]?.description).toBeNull()
    expect(parseAgentTypeSchema({
      agent_type_id: 'at-1', key: 'claude_code', credential_required: true, schema_version: '1', schema: [],
    }).credentialRequired).toBe(true)
  })

  it('rejects a content member that is present with the wrong type', () => {
    expect(() => parsePreview({
      path: 'a.txt', revision: 1, etag: 'e', kind: 'text', content_type: 'text/plain', content: 42,
    })).toThrow(/content must be a string/u)
    expect(() => parseFileContent({
      path: 'a.txt', content_type: 'text/plain', size: 1, etag: 'e', revision: 1, content: 42,
    })).toThrow(/content must be a string/u)
  })

  it('keeps a well-formed approval pulse entry and drops an untyped extension policy', () => {
    const pulse = parsePulse({
      run_id: 'run-1',
      items: [{ kind: 'approval', at: 'a', revision: 2, trace_id: 't', summary: '审批通过', decision: 'approve', operator: '演示成员' }],
    })
    expect(pulse.items[0]).toMatchObject({ kind: 'approval', decision: 'approve', operator: '演示成员' })

    // 执行策略整块缺席是合法的「没有声明」：策略解析成空对象，而不是抛错。
    const profile = parseAgentProfile({ ...publishedProfile })
    expect(profile.executionPolicy).toEqual({})
  })

  it('rejects a non-absolute allowlist entry and an untyped next_cursor', () => {
    expect(() => parsePreviewUrlGrant(
      { url: 'https://apps.test/w/1', workspace_id: 'ws-1', expires_at: '2030-01-01T00:00:00.000Z' },
      { allowedOrigins: ['not a url'], workspaceId: 'ws-1' },
    )).toThrow(/preview origin is not an absolute URL/u)

    expect(() => parsePage({ items: [], next_cursor: 7 }, entry => entry, 'list'))
      .toThrow(/next_cursor must be a string or null/u)
    expect(parsePage({ items: [], next_cursor: null }, entry => entry, 'list').nextCursor).toBeNull()
  })

  it('rejects a 200 envelope that carries a non-zero code without a message', async () => {
    const bare = await raisedBy(clientReturning(200, JSON.stringify({ code: 'PARTIAL', request_id: 'r', data: null })))
    expect(bare.code).toBe('PARTIAL')
    expect(bare.message).toBe('Cloud workspace request failed.')
  })
})
