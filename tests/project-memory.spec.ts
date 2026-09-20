import { describe, expect, it, vi } from 'vitest'
/* oxlint-disable typescript/no-unsafe-assignment -- Vitest asymmetric matchers are typed as any. */
import { TeamSkillHost } from '../src/host.ts'
import { TeamSkillHttpClient } from '../src/http.ts'

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

describe('project memory Host API', () => {
  it('sends project memory mutation headers and parses server records', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        json(
          { code: 0, message: 'accepted', request_id: 'r1', data: { event_id: 'e1', job_id: 'j1', status: 'PENDING', accepted_count: 1 } },
          202,
        ),
      )
      .mockResolvedValueOnce(
        json({
          code: 0,
          message: 'ok',
          request_id: 'r2',
          data: {
            memory: {
              memory_id: 'm-1',
              content: 'updated',
              revision: 2,
              project_id: 'p1',
              team_id: 't1',
              layer: 'L1',
              tier: 'project_confirmed',
              source_event_id: 'e1',
              expires_at: null,
              scope: 'shared',
              captured_by_user_id: 'u1',
              created_at: '2026-09-02T00:00:00Z',
              updated_at: '2026-09-02T00:00:00Z',
              status: 'ACTIVE',
              importance: 0.5,
              recall_count: 0,
              last_recalled_at: null,
              source_kind: 'agent_turn',
            },
            event_id: 'e2',
            job_id: 'j2',
            status: 'INDEX_PENDING',
          },
        }),
      )
      .mockResolvedValueOnce(
        json(
          {
            code: 0,
            message: 'accepted',
            request_id: 'r3',
            data: { event_id: 'e3', job_id: 'j3', status: 'PENDING', cleanup_status: 'PENDING' },
          },
          202,
        ),
      )
    const client = new TeamSkillHttpClient({ apiBaseUrl: 'https://service.test/v3', accessToken: 'token', fetch })
    await expect(
      client.memoryCapture({ projectId: 'p1', sessionId: 's1', messages: [{ role: 'user', content: 'fact' }] }, 'capture-1'),
    ).resolves.toMatchObject({ jobId: 'j1' })
    await expect(client.memoryUpdate({ memoryId: 'm-1', content: 'updated', expectedRevision: 1 }, 'update-1')).resolves.toMatchObject({
      memory: { content: 'updated', revision: 2 },
    })
    await expect(client.memoryDelete({ memoryId: 'm-1', expectedRevision: 2 }, 'delete-1')).resolves.toMatchObject({ jobId: 'j3' })
    expect(fetch).toHaveBeenNthCalledWith(
      1,
      'https://service.test/v3/project-memory/capture',
      expect.objectContaining({ method: 'POST', headers: expect.objectContaining({ 'idempotency-key': 'capture-1' }) }),
    )
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      'https://service.test/v3/project-memory/update',
      // update 与 capture/delete 同等要求幂等键：请求必须同时携带 If-Match 与 Idempotency-Key。
      expect.objectContaining({ headers: expect.objectContaining({ 'if-match': '1', 'idempotency-key': 'update-1' }) }),
    )
    expect(fetch).toHaveBeenNthCalledWith(
      3,
      'https://service.test/v3/project-memory/delete',
      expect.objectContaining({ headers: expect.objectContaining({ 'if-match': '2', 'idempotency-key': 'delete-1' }) }),
    )
  })

  it('keeps service-unavailable as an explicit Host failure', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(json({ code: 'MEMORY_SERVICE_UNAVAILABLE', message: 'down', request_id: 'r3', data: null }, 503))
    const host = new TeamSkillHost({ apiBaseUrl: 'https://service.test/v3', accessToken: 'token', fetch })
    await expect(host.memoryRecall({ projectId: 'p1', query: 'fact' })).resolves.toMatchObject({
      status: 'failed',
      code: 'MEMORY_SERVICE_UNAVAILABLE',
    })
  })

  it('classifies malformed memory JSON as a protocol failure', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response('{not-json', { status: 200, headers: { 'content-type': 'application/json' } }),
    )
    const client = new TeamSkillHttpClient({ apiBaseUrl: 'https://service.test/v3', accessToken: 'token', fetch })
    await expect(client.memoryList({ projectId: 'p1' })).rejects.toMatchObject({ code: 'SERVICE_PROTOCOL_ERROR' })
  })
})
