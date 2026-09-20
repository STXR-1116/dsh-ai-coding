import { strToU8, zipSync } from 'fflate'
import { afterEach, describe, expect, it } from 'vitest'
import type { AddressInfo } from 'node:net'
import { createTeamSkillService } from '../src/server.ts'
import { bodyOf } from './response.ts'

/**
 * 契约探针：《DSH-平台模块现状与后端API需求.md》§11.14（2026-09-16 冻结）。
 *
 * 异常矩阵：
 * - 缺失：未发布版本 / 未绑定项目 / 未签名版本三类不可见或不可用状态，均不得以
 *   空对象、占位签名或空数组冒充可用。
 * - 类型错误：tool_permissions 越出闭集、file_scope.roots 非数组、recent_audits
 *   越界或非倒序、actor_name 缺失——契约要求客户端严格解析拒绝整条记录。
 * - 边界：recent_audits 上限 10 条；network=false 时 hosts 必须为空数组。
 * - 并发：无（只读端点）。
 * - 下游失败：非 published 一律 404，不泄露存在性。
 * - 审计：recent_audits 携带字面 actor_name 与 request_id。
 */

const services: ReturnType<typeof createTeamSkillService>[] = []
let nextKey = 1
let nextPortLabel = 0

afterEach(async () => {
  for (const service of services.splice(0)) {
    service.server.closeAllConnections()
    await new Promise<void>((resolve) => {
      service.server.close(() => {
        resolve()
      })
    })
  }
})

function apiHeaders(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
}

function uniqueKey(prefix: string): string {
  return `${prefix}-${nextKey++}-${nextPortLabel}`
}

async function loginAs(port: number, username: string, password: string): Promise<string> {
  const response = await fetch(`http://127.0.0.1:${port}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  })
  expect(response.status).toBe(200)
  return ((await bodyOf(response)) as { access_token: string }).access_token
}

async function startService(): Promise<{ readonly port: number }> {
  nextPortLabel += 1
  const service = createTeamSkillService({ port: 0, seed: false })
  services.push(service)
  await service.listen()
  const address = service.server.address() as AddressInfo
  return { port: address.port }
}

async function projectRevision(port: number, token: string, projectId: string): Promise<number> {
  const response = await fetch(`http://127.0.0.1:${port}/v1/admin/projects/${projectId}`, {
    headers: apiHeaders(token),
  })
  expect(response.status).toBe(200)
  return ((await bodyOf(response)) as { revision: number }).revision
}

interface DraftSkill {
  readonly skillId: string
  readonly skillRevision: number
  readonly versionRevision: number
}

/** create → version → artifact；版本停留在 draft。 */
async function createDraftSkill(port: number, adminToken: string, name: string): Promise<DraftSkill> {
  const created = await fetch(`http://127.0.0.1:${port}/v1/admin/team-skills`, {
    method: 'POST',
    headers: { ...apiHeaders(adminToken), 'idempotency-key': uniqueKey('create') },
    body: JSON.stringify({
      display_name: name,
      summary: '信任卡契约探针',
      visibility: 'organization',
      organization_id: 'org-alpha',
    }),
  })
  expect(created.status).toBe(201)
  const skill = (await bodyOf(created)) as { skillId: string; revision: number }
  const versioned = await fetch(`http://127.0.0.1:${port}/v1/admin/team-skills/${skill.skillId}/versions`, {
    method: 'POST',
    headers: {
      ...apiHeaders(adminToken),
      'if-match': String(skill.revision),
      'x-skill-revision': String(skill.revision),
      'idempotency-key': uniqueKey('version'),
    },
    body: JSON.stringify({ version: '1.0.0', release_notes: '信任卡契约探针版本' }),
  })
  expect(versioned.status).toBe(201)
  const version = (await bodyOf(versioned)) as { version: { revision: number }; skill: { revision: number } }
  const artifact = zipSync({
    'SKILL.md': strToU8(`---\nname: aicp-${skill.skillId}\ndescription: 信任卡契约探针\n---\n\n# ${name}\n`),
  })
  const uploaded = await fetch(
    `http://127.0.0.1:${port}/v1/admin/team-skills/${skill.skillId}/versions/1.0.0/artifact`,
    {
      method: 'PUT',
      headers: {
        ...apiHeaders(adminToken),
        'if-match': String(version.version.revision),
        'x-skill-revision': String(version.skill.revision),
        'idempotency-key': uniqueKey('artifact'),
        'content-type': 'application/zip',
      },
      body: new Uint8Array(artifact),
    },
  )
  expect(uploaded.status).toBe(200)
  const uploadedBody = (await bodyOf(uploaded)) as { version: { revision: number }; skill: { revision: number } }
  return {
    skillId: skill.skillId,
    skillRevision: uploadedBody.skill.revision,
    versionRevision: uploadedBody.version.revision,
  }
}

/** draft → pending_review → approved → published；可选 unsigned 场景。 */
async function publishDraftSkill(
  port: number,
  adminToken: string,
  draft: DraftSkill,
  options: { readonly unsigned?: boolean } = {},
): Promise<void> {
  let revisions = { skillRevision: draft.skillRevision, versionRevision: draft.versionRevision }
  const submitted = await fetch(
    `http://127.0.0.1:${port}/v1/admin/team-skills/${draft.skillId}/versions/1.0.0/submit-review`,
    {
      method: 'POST',
      headers: {
        ...apiHeaders(adminToken),
        'if-match': String(revisions.versionRevision),
        'x-skill-revision': String(revisions.skillRevision),
        'idempotency-key': uniqueKey('submit'),
      },
      body: '{}',
    },
  )
  expect(submitted.status).toBe(200)
  const submittedBody = (await bodyOf(submitted)) as { version: { revision: number }; skill: { revision: number } }
  revisions = { skillRevision: submittedBody.skill.revision, versionRevision: submittedBody.version.revision }

  const approved = await fetch(
    `http://127.0.0.1:${port}/v1/admin/team-skills/${draft.skillId}/versions/1.0.0/approve`,
    {
      method: 'POST',
      headers: {
        ...apiHeaders(adminToken),
        'if-match': String(revisions.versionRevision),
        'x-skill-revision': String(revisions.skillRevision),
        'idempotency-key': uniqueKey('approve'),
      },
      body: JSON.stringify({ checks: { 'check-1': 'pass' } }),
    },
  )
  expect(approved.status).toBe(200)
  const approvedBody = (await bodyOf(approved)) as { version: { revision: number }; skill: { revision: number } }
  revisions = { skillRevision: approvedBody.skill.revision, versionRevision: approvedBody.version.revision }

  const published = await fetch(
    `http://127.0.0.1:${port}/v1/admin/team-skills/${draft.skillId}/versions/1.0.0/publish`,
    {
      method: 'POST',
      headers: {
        ...apiHeaders(adminToken),
        'if-match': String(revisions.versionRevision),
        'x-skill-revision': String(revisions.skillRevision),
        'idempotency-key': uniqueKey('publish'),
        ...(options.unsigned === true ? { 'x-fixture-scenario': 'unsigned-release' } : {}),
      },
      body: '{}',
    },
  )
  expect(published.status).toBe(200)
}

async function bindSkillAsset(port: number, adminToken: string, projectId: string, skillId: string): Promise<void> {
  const revision = await projectRevision(port, adminToken, projectId)
  const bound = await fetch(`http://127.0.0.1:${port}/v1/admin/projects/${projectId}/assets`, {
    method: 'POST',
    headers: {
      ...apiHeaders(adminToken),
      'if-match': String(revision),
      'idempotency-key': uniqueKey('bind'),
    },
    body: JSON.stringify({ asset_type: 'skill', asset_id: skillId, relation_kind: 'reference' }),
  })
  expect(bound.status).toBe(201)
}

interface TrustCard {
  readonly skill_id: string
  readonly version: string
  readonly display_name: string
  readonly publisher: { readonly name: string; readonly organization_id: string }
  readonly signature: { readonly algorithm: string; readonly key_id: string; readonly fingerprint: string; readonly signed_at: string }
  readonly tool_permissions: readonly string[]
  readonly file_scope: { readonly roots: readonly string[]; readonly max_files: number; readonly max_bytes: number }
  readonly external_access: { readonly network: boolean; readonly hosts: readonly string[] }
  readonly recent_audits: readonly {
    readonly at: string
    readonly action: string
    readonly outcome: 'succeeded' | 'failed'
    readonly actor_name: string
    readonly request_id: string
  }[]
}

async function readTrustCard(
  port: number,
  token: string,
  skillId: string,
  version: string,
  projectId = 'project-alpha',
): Promise<Response> {
  const query = new URLSearchParams({ project_id: projectId })
  return fetch(`http://127.0.0.1:${port}/v1/team-skills/${skillId}/versions/${version}:trust-card?${query}`, {
    headers: apiHeaders(token),
  })
}

const TOOL_PERMISSIONS = ['bash', 'read_file', 'write_file', 'web_fetch', 'subprocess'] as const

describe('§11.14 Skill 信任卡', () => {
  it('published 且已绑定的版本返回完整信任卡字段', async () => {
    const { port } = await startService()
    const adminToken = await loginAs(port, 'admin@example.com', 'admin-pass')
    const memberToken = await loginAs(port, 'member@example.com', 'member-pass')
    const draft = await createDraftSkill(port, adminToken, '信任卡探针')
    await publishDraftSkill(port, adminToken, draft)
    await bindSkillAsset(port, adminToken, 'project-alpha', draft.skillId)

    const response = await readTrustCard(port, memberToken, draft.skillId, '1.0.0')
    expect(response.status).toBe(200)
    const card = (await bodyOf(response)) as TrustCard

    expect(card.skill_id).toBe(draft.skillId)
    expect(card.version).toBe('1.0.0')
    expect(card.display_name).toBe('信任卡探针')

    // 发布者只含展示名与组织标识，不含内部账号 ID 或凭据。
    expect(card.publisher.name.length).toBeGreaterThan(0)
    expect(card.publisher.organization_id).toBe('org-alpha')

    // 签名四字段必填非空，算法在闭集内。
    expect(['sha256-rsa', 'sha256-ecdsa']).toContain(card.signature.algorithm)
    expect(card.signature.key_id.length).toBeGreaterThan(0)
    expect(card.signature.fingerprint.length).toBeGreaterThan(0)
    expect(Number.isNaN(Date.parse(card.signature.signed_at))).toBe(false)

    // 工具权限在闭集内；空数组合法，字段本身不得省略。
    expect(Array.isArray(card.tool_permissions)).toBe(true)
    for (const permission of card.tool_permissions) expect(TOOL_PERMISSIONS).toContain(permission)

    // 文件范围：roots 非空且为 artifact 相对路径。
    expect(card.file_scope.roots.length).toBeGreaterThan(0)
    for (const root of card.file_scope.roots) expect(root.startsWith('/')).toBe(false)
    expect(card.file_scope.max_files).toBeGreaterThan(0)
    expect(card.file_scope.max_bytes).toBeGreaterThan(0)

    // 外部访问：network=false 时 hosts 必须为空数组。
    if (!card.external_access.network) expect(card.external_access.hosts).toEqual([])

    // 最近审计：最多 10 条、按 at 倒序、字面 actor_name 与 request_id。
    expect(card.recent_audits.length).toBeLessThanOrEqual(10)
    const times = card.recent_audits.map(item => Date.parse(item.at))
    expect([...times].sort((a, b) => b - a)).toEqual(times)
    for (const audit of card.recent_audits) {
      expect(['succeeded', 'failed']).toContain(audit.outcome)
      expect(audit.actor_name.length).toBeGreaterThan(0)
      expect(audit.request_id.length).toBeGreaterThan(0)
    }
  })

  it('未发布版本返回 404，不泄露存在性', async () => {
    const { port } = await startService()
    const adminToken = await loginAs(port, 'admin@example.com', 'admin-pass')
    const memberToken = await loginAs(port, 'member@example.com', 'member-pass')
    const draft = await createDraftSkill(port, adminToken, '未发布信任卡')
    await bindSkillAsset(port, adminToken, 'project-alpha', draft.skillId)

    const response = await readTrustCard(port, memberToken, draft.skillId, '1.0.0')
    expect(response.status).toBe(404)
    const body = (await bodyOf(response)) as { code: string; data: null }
    expect(body.code).toBe('NOT_FOUND')
    expect(body.data).toBeNull()

    // 同一端点、同一版本号，发布后必须转为 200：证明上面的 404 是版本状态
    // 判定，而不是路由缺失落到兜底 404（否则该用例对旧实现无判别力）。
    await publishDraftSkill(port, adminToken, draft)
    const afterPublish = await readTrustCard(port, memberToken, draft.skillId, '1.0.0')
    expect(afterPublish.status).toBe(200)
  })

  it('未绑定到该项目的 published 版本返回 404，不泄露存在性', async () => {
    const { port } = await startService()
    const adminToken = await loginAs(port, 'admin@example.com', 'admin-pass')
    const memberToken = await loginAs(port, 'member@example.com', 'member-pass')
    const draft = await createDraftSkill(port, adminToken, '未绑定信任卡')
    await publishDraftSkill(port, adminToken, draft)

    const response = await readTrustCard(port, memberToken, draft.skillId, '1.0.0')
    expect(response.status).toBe(404)
    const body = (await bodyOf(response)) as { code: string; data: null }
    expect(body.code).toBe('NOT_FOUND')
    expect(body.data).toBeNull()

    // 绑定项目资产后同一请求必须转为 200，证明 404 由项目授权判定产生。
    await bindSkillAsset(port, adminToken, 'project-alpha', draft.skillId)
    const afterBind = await readTrustCard(port, memberToken, draft.skillId, '1.0.0')
    expect(afterBind.status).toBe(200)
  })

  it('未签名版本返回 404 SIGNATURE_NOT_AVAILABLE，不得冒充已签名', async () => {
    const { port } = await startService()
    const adminToken = await loginAs(port, 'admin@example.com', 'admin-pass')
    const memberToken = await loginAs(port, 'member@example.com', 'member-pass')
    const draft = await createDraftSkill(port, adminToken, '未签名信任卡')
    await publishDraftSkill(port, adminToken, draft, { unsigned: true })
    await bindSkillAsset(port, adminToken, 'project-alpha', draft.skillId)

    const response = await readTrustCard(port, memberToken, draft.skillId, '1.0.0')
    expect(response.status).toBe(404)
    const body = (await bodyOf(response)) as { code: string; data: null; message: string }
    expect(body.code).toBe('SIGNATURE_NOT_AVAILABLE')
    expect(body.data).toBeNull()
    expect(body.message.length).toBeGreaterThan(0)
  })
})
