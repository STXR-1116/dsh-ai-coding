import { describe, expect, it, vi } from 'vitest'
import { TeamSkillHttpClient } from '../src/http.ts'

/**
 * 契约探针：《DSH-平台模块现状与后端API需求.md》§11.15（2026-09-16 冻结）。
 *
 * 异常矩阵：
 * - 缺失：`version` 或 `updated_at` 缺失必须整条拒绝——不得留 `undefined`。
 * - 类型错误：非字符串或空字符串同样拒绝；不得以空串/`0`/当前时间补齐。
 * - 边界：`version` 是文档版本（不透明字符串），不得被解析成数字或知识库 revision。
 * - 并发：无（纯解析）。
 * - 下游失败：4xx envelope 由既有 requestJson 转成 TeamSkillHttpError。
 * - 审计：无。
 */

const VALID_HIT = {
  knowledge_base_id: 'kb-1',
  knowledge_id: 'doc-1',
  title: '发布流程',
  snippet: '提交变更、完成审核后再发布版本。',
  score: 0.93,
  source_url: '/v1/knowledge-bases/kb-1/documents/doc-1/preview',
  version: 'v7',
  updated_at: '2026-09-15T08:00:00.000Z',
}

function response(body: unknown, status = 200): Response {
  const envelope = status >= 400
    ? { code: 'NOT_FOUND', message: '资源不存在', request_id: 'r-1', data: null }
    : { code: 0, message: 'ok', request_id: 'r-1', data: body }
  return new Response(JSON.stringify(envelope), { status, headers: { 'content-type': 'application/json' } })
}

function clientReturning(payload: unknown): TeamSkillHttpClient {
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response(payload))
  return new TeamSkillHttpClient({ apiBaseUrl: 'https://service.example.test/v1', accessToken: 'token-1', fetch })
}

function payloadWith(hit: Record<string, unknown>): unknown {
  return {
    request_id: 'r-1',
    results: [hit],
    knowledge_bases: [{ knowledge_base_id: 'kb-1', status: 'used', reason: null }],
  }
}

const REQUEST = { projectId: 'project-alpha', query: '发布', knowledgeBaseIds: ['kb-1'] }

describe('§11.15 检索结果来源严格解析', () => {
  it('解析版本与更新时间并映射为 camelCase', async () => {
    const result = await clientReturning(payloadWith(VALID_HIT)).knowledgeSearch(REQUEST)

    expect(result.results[0]).toMatchObject({
      knowledgeBaseId: 'kb-1',
      knowledgeId: 'doc-1',
      version: 'v7',
      updatedAt: '2026-09-15T08:00:00.000Z',
    })
  })

  it('缺 version 时整条拒绝，不得留 undefined', async () => {
    const { version: _dropped, ...withoutVersion } = VALID_HIT
    await expect(clientReturning(payloadWith(withoutVersion)).knowledgeSearch(REQUEST)).rejects.toMatchObject({
      code: 'SERVICE_PROTOCOL_ERROR',
    })
  })

  it('缺 updated_at 时整条拒绝', async () => {
    const { updated_at: _dropped, ...withoutUpdatedAt } = VALID_HIT
    await expect(clientReturning(payloadWith(withoutUpdatedAt)).knowledgeSearch(REQUEST)).rejects.toMatchObject({
      code: 'SERVICE_PROTOCOL_ERROR',
    })
  })

  it('空字符串不得被当作有效来源信息', async () => {
    await expect(
      clientReturning(payloadWith({ ...VALID_HIT, version: '' })).knowledgeSearch(REQUEST),
    ).rejects.toMatchObject({ code: 'SERVICE_PROTOCOL_ERROR' })

    await expect(
      clientReturning(payloadWith({ ...VALID_HIT, updated_at: '' })).knowledgeSearch(REQUEST),
    ).rejects.toMatchObject({ code: 'SERVICE_PROTOCOL_ERROR' })
  })

  it('version 按不透明字符串原样传递，不做数字解析', async () => {
    const result = await clientReturning(payloadWith({ ...VALID_HIT, version: '2026.09.15-rc2' })).knowledgeSearch(REQUEST)

    expect(result.results[0]?.version).toBe('2026.09.15-rc2')
  })
})
