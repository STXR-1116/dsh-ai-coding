import { afterEach, describe, expect, it } from 'vitest'
import type { AddressInfo } from 'node:net'
/* oxlint-disable typescript/no-unsafe-assignment -- Response.json() is narrowed at assertion boundaries. */
import { createTeamSkillService } from '../src/server.ts'
import { bodyOf } from './response.ts'

const services: ReturnType<typeof createTeamSkillService>[] = []
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

describe('knowledge HTTP fixture', () => {
  it('routes search through an injected WeKnora adapter without exposing external ids', async () => {
    const calls: Array<{ readonly knowledgeBases: readonly { readonly platformId: string; readonly externalId: string }[] }> = []
    const service = createTeamSkillService({
      port: 0,
      weknora: {
        search: async (request) => {
          calls.push({ knowledgeBases: request.knowledgeBases })
          return {
            knowledgeBases: [{ externalId: 'weknora-k-1', status: 'used' as const }],
            results: [
              {
                externalKnowledgeBaseId: 'weknora-k-1',
                externalKnowledgeId: 'weknora-doc-release',
                title: '外部发布规范',
                snippet: '外部检索结果',
                score: 0.97,
                sourceUrl: 'https://weknora.invalid/doc',
                version: 'v7',
                updatedAt: '2026-09-15T08:00:00.000Z',
                citation: { page: 2 },
              },
            ],
          }
        },
      },
    })
    services.push(service)

    await service.listen()

    const port = (service.server.address() as AddressInfo).port
    const response = await fetch(`http://127.0.0.1:${port}/v1/projects/project-alpha/knowledge-search`, {
      method: 'POST',
      headers: { authorization: 'Bearer demo-token', 'content-type': 'application/json' },
      body: JSON.stringify({ query: '发布', knowledge_base_ids: ['k-1'] }),
    })
    expect(response.status).toBe(200)
    const body = (await bodyOf(response)) as { results: Array<Record<string, unknown>> }
    expect(calls).toEqual([{ knowledgeBases: [{ platformId: 'k-1', externalId: 'weknora-k-1', type: 'document' }] }])
    expect(body.results[0]).toMatchObject({ knowledge_base_id: 'k-1', knowledge_id: 'doc-release', title: '外部发布规范' })
    expect(JSON.stringify(body)).not.toContain('weknora-')
  })

  it('keeps one external knowledge-base failure as skipped while another succeeds', async () => {
    const service = createTeamSkillService({
      port: 0,
      weknora: {
        search: async () => ({
          knowledgeBases: [
            { externalId: 'weknora-k-1', status: 'used' as const },
            { externalId: 'weknora-k-3', status: 'skipped' as const, reason: 'timeout' as const },
          ],
          results: [
            {
              externalKnowledgeBaseId: 'weknora-k-1',
              externalKnowledgeId: 'weknora-doc-release',
              title: '发布流程',
              snippet: '命中',
              score: 0.8,
              sourceUrl: 'https://weknora.invalid/doc',
            },
          ],
        }),
      },
    })
    services.push(service)

    await service.listen()

    const port = (service.server.address() as AddressInfo).port
    const response = await fetch(`http://127.0.0.1:${port}/v1/projects/project-alpha/knowledge-search`, {
      method: 'POST',
      headers: { authorization: 'Bearer demo-token', 'content-type': 'application/json' },
      body: JSON.stringify({ query: '发布', knowledge_base_ids: ['k-1', 'k-3'] }),
    })
    expect(response.status).toBe(200)
    expect(await bodyOf(response)).toMatchObject({
      knowledge_bases: expect.arrayContaining([
        expect.objectContaining({ knowledge_base_id: 'k-1', status: 'used' }),
        expect.objectContaining({ knowledge_base_id: 'k-3', status: 'skipped', reason: 'timeout' }),
      ]),
    })
  })

  it('authorizes project knowledge bases and reports partial multi-KB results', async () => {
    const service = createTeamSkillService({ port: 4340 })
    services.push(service)

    await service.listen()

    const port = (service.server.address() as AddressInfo).port
    const headers = { authorization: 'Bearer demo-token', 'content-type': 'application/json' }
    const list = await fetch(`http://127.0.0.1:${port}/v1/projects/project-alpha/knowledge-bases`, { headers })
    expect(list.status).toBe(200)
    expect(await bodyOf(list)).toMatchObject({ items: expect.arrayContaining([expect.objectContaining({ knowledge_base_id: 'k-1' })]) })
    const search = await fetch(`http://127.0.0.1:${port}/v1/projects/project-alpha/knowledge-search`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ query: '发布', knowledge_base_ids: ['k-1', 'k-3'] }),
    })
    expect(search.status).toBe(200)
    expect(await bodyOf(search)).toMatchObject({
      knowledge_bases: expect.arrayContaining([
        expect.objectContaining({ status: 'used' }),
        expect.objectContaining({ status: 'no_hits' }),
      ]),
    })
  })

  it('returns asynchronous markdown import state and enforces manager scope', async () => {
    const service = createTeamSkillService({ port: 4341 })
    services.push(service)

    await service.listen()

    const port = (service.server.address() as AddressInfo).port
    const manager = {
      authorization: 'Bearer manager-demo',
      'content-type': 'application/json',
      'idempotency-key': 'kb-import-1',
      'if-match': '1',
    }
    const imported = await fetch(`http://127.0.0.1:${port}/v1/knowledge-bases/k-1/documents/markdown`, {
      method: 'POST',
      headers: manager,
      body: JSON.stringify({ title: '联调说明', markdown: '# 内容' }),
    })
    expect(imported.status).toBe(202)
    const importedBody = (await bodyOf(imported)) as { operation_id: string; status: string }
    expect(importedBody).toMatchObject({ operation_id: expect.any(String), status: 'queued' })
    const replay = await fetch(`http://127.0.0.1:${port}/v1/knowledge-bases/k-1/documents/markdown`, {
      method: 'POST',
      headers: manager,
      body: JSON.stringify({ title: '联调说明', markdown: '# 内容' }),
    })
    expect(replay.status).toBe(202)
    expect(((await bodyOf(replay)) as { operation_id: string }).operation_id).toBe(importedBody.operation_id)
    const forbidden = await fetch(`http://127.0.0.1:${port}/v1/organizations/org-beta/knowledge-bases`, {
      headers: { authorization: 'Bearer manager-demo' },
    })
    expect(forbidden.status).toBe(403)
  })

  it('keeps imported documents processing until operation polling completes', async () => {
    const service = createTeamSkillService({ port: 4342 })
    services.push(service)

    await service.listen()

    const port = (service.server.address() as AddressInfo).port
    const headers = {
      authorization: 'Bearer manager-demo',
      'content-type': 'application/json',
      'idempotency-key': 'kb-import-2',
      'if-match': '1',
    }
    const imported = await fetch(`http://127.0.0.1:${port}/v1/knowledge-bases/k-1/documents/urls`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ url: 'https://example.test/guide', title: '指南' }),
    })
    expect(imported.status).toBe(202)
    const operation = (await bodyOf(imported)) as { operation_id: string; document_id: string }
    const documents = await fetch(`http://127.0.0.1:${port}/v1/knowledge-bases/k-1/documents`, { headers })
    expect(
      ((await bodyOf(documents)) as { items: Array<{ document_id: string; status: string }> }).items.find(
        item => item.document_id === operation.document_id,
      )?.status,
    ).toBe('pending')
    const first = await fetch(`http://127.0.0.1:${port}/v1/operations/${operation.operation_id}`, { headers })
    expect(await bodyOf(first)).toMatchObject({ status: 'running' })
    const second = await fetch(`http://127.0.0.1:${port}/v1/operations/${operation.operation_id}`, { headers })
    expect(await bodyOf(second)).toMatchObject({ status: 'succeeded' })
    const detail = await fetch(`http://127.0.0.1:${port}/v1/knowledge-bases/k-1/documents/${operation.document_id}`, { headers })
    expect(await bodyOf(detail)).toMatchObject({ status: 'completed' })
  })

  it('returns delete impact and rejects mismatched knowledge-base types', async () => {
    const service = createTeamSkillService({ port: 4343 })
    services.push(service)

    await service.listen()

    const port = (service.server.address() as AddressInfo).port
    const headers = { authorization: 'Bearer admin-demo', 'content-type': 'application/json' }
    const impact = await fetch(`http://127.0.0.1:${port}/v1/knowledge-bases/k-1/delete-impact`, { headers })
    expect(await bodyOf(impact)).toMatchObject({
      knowledge_base_id: 'k-1',
      affected_projects: expect.arrayContaining([expect.objectContaining({ project_id: 'project-alpha' })]),
    })
    const mismatch = await fetch(`http://127.0.0.1:${port}/v1/knowledge-bases/k-1/faq-items`, { headers })
    expect(mismatch.status).toBe(422)
  })

  // §11.15（2026-09-16 冻结）：检索结果必须带来源、版本与更新时间。
  // 异常矩阵：缺字段/空串 → 协议错误（由平台严格解析拒绝，见 trust-card-parse 同款探针）；
  // 边界 → 版本是文档版本而非知识库 revision；更新时间是文档内容时间，
  // 导入完成后必须被刷新，不能停留在创建时刻。
  it('每个检索命中都带非空的文档版本与更新时间', async () => {
    const service = createTeamSkillService({ port: 0 })
    services.push(service)

    await service.listen()

    const port = (service.server.address() as AddressInfo).port
    const response = await fetch(`http://127.0.0.1:${port}/v1/projects/project-alpha/knowledge-search`, {
      method: 'POST',
      headers: { authorization: 'Bearer demo-token', 'content-type': 'application/json' },
      body: JSON.stringify({ query: '发布', knowledge_base_ids: ['k-1'] }),
    })
    expect(response.status).toBe(200)
    const body = (await bodyOf(response)) as { results: Array<Record<string, unknown>> }
    expect(body.results.length).toBeGreaterThan(0)

    for (const hit of body.results) {
      expect(typeof hit.version).toBe('string')
      expect(String(hit.version).length).toBeGreaterThan(0)
      expect(typeof hit.updated_at).toBe('string')
      expect(Number.isNaN(Date.parse(String(hit.updated_at)))).toBe(false)
      // 文档版本，不是知识库 revision（后者是裸整数）。
      expect(hit.version).toBe('v1')
    }
  })

  it('导入完成后刷新文档更新时间，命中不再停留在创建时刻', async () => {
    const service = createTeamSkillService({ port: 0 })
    services.push(service)

    await service.listen()

    const port = (service.server.address() as AddressInfo).port
    const adminHeaders = {
      authorization: 'Bearer manager-demo',
      'content-type': 'application/json',
      'idempotency-key': 'kb-provenance-1',
      'if-match': '1',
    }
    const beforeImport = new Date().toISOString()
    const imported = await fetch(`http://127.0.0.1:${port}/v1/knowledge-bases/k-1/documents/urls`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ url: 'https://example.test/provenance', title: '溯源指南' }),
    })
    expect(imported.status).toBe(202)

    // 两跳操作：queued → running → succeeded，完成即成为可检索内容。
    const operation = (await bodyOf(imported)) as { operation_id: string }
    const poll = { authorization: 'Bearer manager-demo', 'content-type': 'application/json' }
    await fetch(`http://127.0.0.1:${port}/v1/operations/${operation.operation_id}`, { headers: poll })
    expect(
      await bodyOf(await fetch(`http://127.0.0.1:${port}/v1/operations/${operation.operation_id}`, { headers: poll })),
    ).toMatchObject({ status: 'succeeded' })

    const response = await fetch(`http://127.0.0.1:${port}/v1/projects/project-alpha/knowledge-search`, {
      method: 'POST',
      headers: { authorization: 'Bearer demo-token', 'content-type': 'application/json' },
      body: JSON.stringify({ query: '溯源指南', knowledge_base_ids: ['k-1'] }),
    })
    expect(response.status).toBe(200)
    const body = (await bodyOf(response)) as { results: Array<Record<string, unknown>> }
    const hit = body.results.find(item => item.title === '溯源指南')
    expect(hit).toBeDefined()
    expect(hit?.version).toBe('v1')
    expect(Date.parse(String(hit?.updated_at))).toBeGreaterThanOrEqual(Date.parse(beforeImport))
  })
})
