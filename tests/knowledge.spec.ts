import { describe, expect, it, vi } from 'vitest'
/* oxlint-disable typescript/no-base-to-string -- Fetch spy assertions inspect RequestInfo wire values. */
import { TeamSkillHost } from '../src/host.ts'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import type { CredentialKey, CredentialProvider } from '@deepseek-ai/dsh-credentials'

function json(body: unknown, status = 200): Response {
  const record = typeof body === 'object' && body !== null && !Array.isArray(body) ? body as Record<string, unknown> : undefined
  const error = status >= 400
  return new Response(
    JSON.stringify({
      code: error ? (typeof record?.code === 'string' ? record.code : `HTTP_${status}`) : 0,
      message: error ? (typeof record?.message === 'string' ? record.message : 'failed') : 'ok',
      request_id: 'test-request',
      data: error ? null : body,
    }),
    { status, headers: { 'content-type': 'application/json' } },
  )
}

describe('TeamSkillHost knowledge workflow', () => {
  it('reads the selected project knowledge bases and preserves partial search failures', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        json({
          items: [
            {
              knowledge_base_id: 'k-1',
              name: '发布流程',
              description: '发布规范',
              type: 'document',
              state: 'active',
              searchable: true,
              updated_at: '2026-09-02T00:00:00Z',
              revision: 1,
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        json({
          request_id: 'req-1',
          results: [
            {
              knowledge_base_id: 'k-1',
              knowledge_id: 'doc-1',
              title: '发布流程',
              snippet: '先提交审核',
              score: 0.9,
              source_url: '/preview/doc-1',
              version: 'v3',
              updated_at: '2026-09-14T00:00:00Z',
              citation: { page: 1 },
            },
          ],
          knowledge_bases: [{ knowledge_base_id: 'k-1', status: 'used', reason: null }],
        }),
      )
    const host = new TeamSkillHost({ apiBaseUrl: 'https://service.test/v1', accessToken: 'token', fetch })

    await expect(host.knowledgeBases('project-alpha')).resolves.toMatchObject([{ knowledgeBaseId: 'k-1' }])
    await expect(
      host.knowledgeSearch({ projectId: 'project-alpha', knowledgeBaseIds: ['k-1'], query: '如何发布？' }),
    ).resolves.toMatchObject({
      status: 'ready',
      // §11.15：来源信息必须一路带到 Host，不得在解析层被丢弃。
      response: { results: [{ title: '发布流程', version: 'v3', updatedAt: '2026-09-14T00:00:00Z' }] },
    })
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      'https://service.test/v1/projects/project-alpha/knowledge-search',
      expect.objectContaining({ method: 'POST' }),
    )
  })

  it('rejects an all-skipped search without exposing a local success', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(
        json(
          {
            code: 'SERVICE_UNAVAILABLE',
            message: '所有知识库暂不可用',
            request_id: 'req-2',
            knowledge_bases: [{ knowledge_base_id: 'k-1', status: 'skipped', reason: 'unavailable' }],
          },
          503,
        ),
      )
    const host = new TeamSkillHost({ apiBaseUrl: 'https://service.test/v1', accessToken: 'token', fetch })
    await expect(host.knowledgeSearch({ projectId: 'project-alpha', knowledgeBaseIds: ['k-1'], query: '问题' })).resolves.toMatchObject({
      status: 'failed',
      code: 'SERVICE_UNAVAILABLE',
    })
  })

  it('refreshes a rejected account grant before reading project knowledge', async () => {
    const records = new Map<
      CredentialKey,
      {
        readonly kind: 'grant'
        readonly payload: {
          readonly userId: string
          readonly accessToken: string
          readonly refreshToken: string
          readonly expiresAt: number
        }
      }
    >()
    records.set(credentialKey('dsh-ai-coding-platform', 'account'), {
      kind: 'grant',
      payload: { userId: 'user-1', accessToken: 'expired', refreshToken: 'refresh-1', expiresAt: Date.now() + 60_000 },
    })
    const credentials = {
      readRecord: async (key: CredentialKey) => records.get(key),
      modifyRecord: async (key: CredentialKey, mutate: (current: unknown) => Promise<unknown>) => {
        const next = await mutate(records.get(key))
        if (next !== undefined) records.set(key, next as never)
        return next as never
      },
      deleteRecord: async (key: CredentialKey) => {
        records.delete(key)
      },
    } as unknown as CredentialProvider
    let knowledgeCalls = 0
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const path = String(input)
      if (path.endsWith('/projects/project-alpha/knowledge-bases')) {
        knowledgeCalls += 1
        if (knowledgeCalls === 1) return json({ code: 'TOKEN_EXPIRED', message: '会话已过期' }, 401)
        return json({
          items: [
            {
              knowledge_base_id: 'k-1',
              name: '发布流程',
              description: '规范',
              type: 'document',
              state: 'active',
              searchable: true,
              updated_at: '2026-09-02T00:00:00Z',
              revision: 1,
            },
          ],
        })
      }
      if (path.endsWith('/auth/refresh'))
        return json({
          access_token: 'fresh',
          refresh_token: 'refresh-2',
          expires_in: 3600,
          user: {
            user_id: 'member-1',
            username: 'member@example.com',
            email: 'member@example.com',
            display_name: '成员',
            status: 'active',
            global_role: 'member',
            must_change_password: false,
            revision: 1,
          },
          memberships: [],
          must_change_password: false,
        })
      throw new Error(`unexpected request ${path} ${new Headers(init?.headers).get('authorization')}`)
    })
    const host = new TeamSkillHost({ apiBaseUrl: 'https://service.test/v1', credentials, fetch })
    await expect(host.knowledgeBases('project-alpha')).resolves.toMatchObject([{ knowledgeBaseId: 'k-1' }])
    expect(knowledgeCalls).toBe(2)
  })
})
