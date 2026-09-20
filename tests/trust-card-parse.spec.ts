import { describe, expect, it, vi } from 'vitest'
import { TeamSkillHttpClient } from '../src/http.ts'

/**
 * 契约探针：《DSH-平台模块现状与后端API需求.md》§11.14（2026-09-16 冻结）。
 *
 * 异常矩阵：
 * - 缺失：签名四字段、publisher、file_scope、recent_audits 任一缺失都必须整条拒绝，
 *   不得留 undefined 或以默认值补齐。
 * - 类型错误：tool_permissions / algorithm / audit outcome 越出闭集必须整条拒绝
 *   （丢弃越界项会低估该版本申请的能力）。
 * - 边界：network=false 时 hosts 必须为空；network=true 时 hosts 必须非空；两者
 *   互为条件，不得由任一侧推断另一侧。
 * - 并发：无（纯解析）。
 * - 下游失败：4xx envelope 由既有 requestJson 转成 TeamSkillHttpError。
 * - 审计：recent_audits 的 snake_case 字段映射到 camelCase，含字面 actor_name。
 */

const VALID_CARD = {
  skill_id: 'skill-1',
  version: '1.0.0',
  display_name: '信任卡探针',
  publisher: { name: '发布者', organization_id: 'org-alpha' },
  signature: {
    algorithm: 'sha256-ecdsa',
    key_id: 'fixture-release-key',
    fingerprint: 'f'.repeat(64),
    signed_at: '2026-09-16T00:00:00.000Z',
  },
  tool_permissions: ['read_file'],
  file_scope: { roots: ['.'], max_files: 64, max_bytes: 8388608 },
  external_access: { network: false, hosts: [] },
  recent_audits: [
    {
      at: '2026-09-16T00:00:00.000Z',
      action: '发布版本',
      outcome: 'succeeded',
      actor_name: '管理员',
      request_id: 'r-1',
    },
  ],
}

function response(body: unknown, status = 200): Response {
  const envelope = status >= 400
    ? { code: 'NOT_FOUND', message: '资源不存在', request_id: 'r-1', data: null }
    : { code: 0, message: 'ok', request_id: 'r-1', data: body }
  return new Response(JSON.stringify(envelope), { status, headers: { 'content-type': 'application/json' } })
}

function clientReturning(body: unknown, status = 200): { readonly client: TeamSkillHttpClient; readonly fetch: ReturnType<typeof vi.fn> } {
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response(body, status))
  return {
    client: new TeamSkillHttpClient({ apiBaseUrl: 'https://service.example.test/v1', accessToken: 'token-1', fetch }),
    fetch,
  }
}

const REQUEST = { skillId: 'skill-1', version: '1.0.0', projectId: 'project-alpha' }

describe('§11.14 信任卡严格解析', () => {
  it('解析完整信任卡并映射为 camelCase，同时带上项目上下文', async () => {
    const { client, fetch } = clientReturning(VALID_CARD)

    const card = await client.trustCard(REQUEST)

    expect(card).toEqual({
      skillId: 'skill-1',
      version: '1.0.0',
      displayName: '信任卡探针',
      publisher: { name: '发布者', organizationId: 'org-alpha' },
      signature: {
        algorithm: 'sha256-ecdsa',
        keyId: 'fixture-release-key',
        fingerprint: 'f'.repeat(64),
        signedAt: '2026-09-16T00:00:00.000Z',
      },
      toolPermissions: ['read_file'],
      fileScope: { roots: ['.'], maxFiles: 64, maxBytes: 8388608 },
      externalAccess: { network: false, hosts: [] },
      recentAudits: [
        {
          at: '2026-09-16T00:00:00.000Z',
          action: '发布版本',
          outcome: 'succeeded',
          actorName: '管理员',
          requestId: 'r-1',
        },
      ],
    })
    const url = String(fetch.mock.calls[0]?.[0])
    expect(url).toContain('/team-skills/skill-1/versions/1.0.0:trust-card')
    expect(url).toContain('project_id=project-alpha')
  })

  it('闭集外的工具权限整条拒绝，不得丢弃越界项', async () => {
    const { client } = clientReturning({ ...VALID_CARD, tool_permissions: ['read_file', 'root_shell'] })

    await expect(client.trustCard(REQUEST)).rejects.toMatchObject({ code: 'SERVICE_PROTOCOL_ERROR' })
  })

  it('闭集外的签名算法整条拒绝', async () => {
    const { client } = clientReturning({
      ...VALID_CARD,
      signature: { ...VALID_CARD.signature, algorithm: 'md5' },
    })

    await expect(client.trustCard(REQUEST)).rejects.toMatchObject({ code: 'SERVICE_PROTOCOL_ERROR' })
  })

  it('network 与 hosts 不一致时整条拒绝', async () => {
    const claimedButEmpty = clientReturning({ ...VALID_CARD, external_access: { network: true, hosts: [] } })
    await expect(claimedButEmpty.client.trustCard(REQUEST)).rejects.toMatchObject({ code: 'SERVICE_PROTOCOL_ERROR' })

    const hostsWithoutNetwork = clientReturning({ ...VALID_CARD, external_access: { network: false, hosts: ['pkg.example.com'] } })
    await expect(hostsWithoutNetwork.client.trustCard(REQUEST)).rejects.toMatchObject({ code: 'SERVICE_PROTOCOL_ERROR' })
  })

  it('签名缺字段或为空时整条拒绝，不得以空字符串补齐', async () => {
    const missingKeyId = clientReturning({
      ...VALID_CARD,
      signature: { algorithm: 'sha256-ecdsa', fingerprint: 'f'.repeat(64), signed_at: '2026-09-16T00:00:00.000Z' },
    })
    await expect(missingKeyId.client.trustCard(REQUEST)).rejects.toMatchObject({ code: 'SERVICE_PROTOCOL_ERROR' })

    const emptyFingerprint = clientReturning({
      ...VALID_CARD,
      signature: { ...VALID_CARD.signature, fingerprint: '' },
    })
    await expect(emptyFingerprint.client.trustCard(REQUEST)).rejects.toMatchObject({ code: 'SERVICE_PROTOCOL_ERROR' })
  })

  it('审计行 outcome 越界或 actor_name 缺失时整条拒绝', async () => {
    const badOutcome = clientReturning({
      ...VALID_CARD,
      recent_audits: [{ ...VALID_CARD.recent_audits[0], outcome: 'maybe' }],
    })
    await expect(badOutcome.client.trustCard(REQUEST)).rejects.toMatchObject({ code: 'SERVICE_PROTOCOL_ERROR' })

    const missingActor = clientReturning({
      ...VALID_CARD,
      recent_audits: [{ at: '2026-09-16T00:00:00.000Z', action: '发布版本', outcome: 'succeeded', request_id: 'r-1' }],
    })
    await expect(missingActor.client.trustCard(REQUEST)).rejects.toMatchObject({ code: 'SERVICE_PROTOCOL_ERROR' })
  })

  it('服务端 404 转为既有 HTTP 错误码，不产生部分信任卡', async () => {
    const { client } = clientReturning({}, 404)

    await expect(client.trustCard(REQUEST)).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('file_scope 计数为负数或非整数时整条拒绝', async () => {
    const negative = clientReturning({ ...VALID_CARD, file_scope: { ...VALID_CARD.file_scope, max_bytes: -1 } })
    await expect(negative.client.trustCard(REQUEST)).rejects.toMatchObject({ code: 'SERVICE_PROTOCOL_ERROR' })

    const fractional = clientReturning({ ...VALID_CARD, file_scope: { ...VALID_CARD.file_scope, max_files: 1.5 } })
    await expect(fractional.client.trustCard(REQUEST)).rejects.toMatchObject({ code: 'SERVICE_PROTOCOL_ERROR' })
  })
})
