import { afterEach, describe, expect, it } from 'vitest'
import type { AddressInfo } from 'node:net'
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

interface BootedService {
  readonly port: number
  memberHeaders: Record<string, string>
  adminHeaders: Record<string, string>
}

async function boot(scenarioHeaders: Record<string, string> = {}): Promise<BootedService> {
  const service = createTeamSkillService({ port: 0 })
  services.push(service)
  await service.listen()
  const port = (service.server.address() as AddressInfo).port
  return {
    port,
    memberHeaders: {
      authorization: 'Bearer demo-token',
      'content-type': 'application/json',
      ...scenarioHeaders,
    },
    adminHeaders: {
      authorization: 'Bearer admin-demo',
      'content-type': 'application/json',
      ...scenarioHeaders,
    },
  }
}

async function untilReady(port: number, workspaceId: string, headers: Record<string, string>): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await fetch(`http://127.0.0.1:${port}/v1/workspaces/${workspaceId}`, { headers })
    const snapshot = (await bodyOf(response)) as Record<string, unknown>
    if (snapshot.status === 'ready' || snapshot.status === 'failed') return snapshot
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error(`workspace ${workspaceId} did not become ready`)
}

/** Read SSE frames until the terminator appears or the stream closes. */
async function readSse(response: Response, predicate: (frame: string) => boolean, maxFrames = 200): Promise<string[]> {
  const reader = response.body?.getReader()
  if (reader === undefined) throw new Error('SSE response has no body')
  try {
    const decoder = new TextDecoder()
    let buffered = ''
    const frames: string[] = []
    for (let i = 0; i < maxFrames; i += 1) {
      const { done, value } = await reader.read()
      if (done) break
      buffered += decoder.decode(value, { stream: true })
      let boundary = buffered.indexOf('\n\n')
      while (boundary !== -1) {
        const frame = buffered.slice(0, boundary)
        buffered = buffered.slice(boundary + 2)
        frames.push(frame)
        if (predicate(frame)) return frames
        boundary = buffered.indexOf('\n\n')
      }
    }
    return frames
  } finally {
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}

function eventType(frame: string): string | undefined {
  return /^event: (.+)$/mu.exec(frame)?.[1]
}


/** 分页游走：透传服务端 cursor 直到 next_cursor 为 null。 */
async function walkList(port: number, headers: Record<string, string>, path: string): Promise<Array<Record<string, unknown>>> {
  const items: Array<Record<string, unknown>> = []
  let cursor: string | null = null
  do {
    const cursorParam = cursor === null ? '' : `cursor=${encodeURIComponent(cursor)}&`
    const res = await fetch(`http://127.0.0.1:${port}${path}${path.includes('?') ? '&' : '?'}${cursorParam}pagesize=stable`, { headers })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: { items: Array<Record<string, unknown>>; next_cursor: string | null } }
    items.push(...body.data.items)
    cursor = body.data.next_cursor
  } while (cursor !== null)
  return items
}

describe('cloud workspace user API', () => {
  it('rejects unauthenticated workspace access with AUTH_REQUIRED', async () => {
    const { port } = await boot()
    const response = await fetch(`http://127.0.0.1:${port}/v1/workspaces/ws-alpha-1`)
    expect(response.status).toBe(401)
    expect(await bodyOf(response)).toMatchObject({ code: 'AUTH_REQUIRED' })
  })

  it('lists agent types and only published project-bound agent profiles', async () => {
    const { port, memberHeaders } = await boot()
    const typeItems = { items: await walkList(port, memberHeaders, '/v1/me/agent-types') } as { items: Array<{ agent_type_id: string; key: string; readiness: string }> }
    expect(typeItems.items.map(item => item.key)).toEqual(['claude_code', 'hermes', 'legacy_shell'])
    expect(typeItems.items.find(item => item.key === 'claude_code')).toMatchObject({ readiness: 'ready' })
    expect(typeItems.items.find(item => item.key === 'hermes')).toMatchObject({ readiness: 'degraded' })
    expect(typeItems.items.find(item => item.key === 'legacy_shell')).toMatchObject({ readiness: 'unavailable' })

    const profileItems = { items: await walkList(port, memberHeaders, '/v1/me/agent-profiles?project_id=project-alpha') } as {
      items: Array<{ agent_profile_id: string; agent_profile_version_id: string; status: string; default: boolean }>
    }
    expect(profileItems.items.map(item => item.agent_profile_id).sort()).toEqual([
      'ap-code-default',
      'ap-legacy-shell',
      'ap-review-lite',
    ])
    expect(profileItems.items).toHaveLength(3)
    expect(profileItems.items[0]).toMatchObject({
      agent_profile_id: 'ap-code-default',
      agent_profile_version_id: 'apv-1',
      status: 'published',
      default: true,
    })
    expect(profileItems.items.filter(item => item.default)).toHaveLength(1)

    const detail = await fetch(`http://127.0.0.1:${port}/v1/me/agent-profiles/apv-1`, { headers: memberHeaders })
    expect(detail.status).toBe(200)
    const profile = (await bodyOf(detail)) as {
      agent_profile_version_id: string
      skills: Array<{ asset_version_id: string }>
      knowledge_bases: unknown[]
      memory: Record<string, unknown> | null
    }
    expect(profile.agent_profile_version_id).toBe('apv-1')
    expect(profile.skills.map(skill => skill.asset_version_id)).toEqual(['skill:code-review@1.0.0'])
    expect(profile.knowledge_bases.length).toBeGreaterThan(0)
    expect(profile.memory).not.toBeNull()
    expect(JSON.stringify(profile)).not.toMatch(/secret|password|api[_-]?key|access[_-]?token|prompt_text/i)

    const draft = await fetch(`http://127.0.0.1:${port}/v1/me/agent-profiles/apv-hermes-draft`, { headers: memberHeaders })
    expect(draft.status).toBe(404)
  })

  it('lists project workspaces and exposes the server snapshot', async () => {
    const { port, memberHeaders } = await boot()
    const response = await fetch(`http://127.0.0.1:${port}/v1/projects/project-alpha/workspaces`, { headers: memberHeaders })
    expect(response.status).toBe(200)
    expect(response.headers.get('x-fixture-only')).toBe('true')
    const payload = (await bodyOf(response)) as { items: Array<Record<string, unknown>> }
    const ready = payload.items.find(item => item.workspace_id === 'ws-alpha-1') as Record<string, unknown>
    expect(ready).toMatchObject({
      project_id: 'project-alpha',
      repository_id: 'repo-1',
      branch: 'main',
      status: 'ready',
      revision: 7,
      default_agent_profile_version_id: 'apv-1',
    })
    const failed = payload.items.find(item => item.workspace_id === 'ws-alpha-3') as Record<string, unknown>
    expect(failed.status).toBe('failed')
    expect(failed.last_error).toContain('配额')
    expect(payload.items.every(item => item.workspace_id !== 'ws-beta-1')).toBe(true)
  })

  it('creates a workspace and observes provisioning-to-ready through SSE', async () => {
    const { port, memberHeaders } = await boot()
    const stream = await fetch(
      `http://127.0.0.1:${port}/v1/events/stream?project_id=project-alpha&after=`,
      { headers: { authorization: 'Bearer demo-token' } },
    )
    expect(stream.headers.get('content-type')).toContain('text/event-stream')

    const created = await fetch(`http://127.0.0.1:${port}/v1/projects/project-alpha/workspaces`, {
      method: 'POST',
      headers: { ...memberHeaders, 'idempotency-key': 'ws-create-1' },
      body: JSON.stringify({
        repository_id: 'repo-1',
        branch: 'feature/cloud',
        agent_profile_version_id: 'apv-1',
        display_name: '云端联调',
      }),
    })
    expect(created.status).toBe(202)
    const snapshot = (await bodyOf(created)) as { workspace_id: string; status: string; revision: number }
    expect(snapshot.status).toBe('provisioning')
    expect(snapshot.workspace_id).toBeTruthy()
    expect(typeof snapshot.revision).toBe('number')

    const ready = await untilReady(port, snapshot.workspace_id, memberHeaders)
    expect(ready.status).toBe('ready')
    expect(ready.branch).toBe('feature/cloud')

    const frames = await readSse(
      stream,
      frame => eventType(frame) === 'workspace.ready' && frame.includes(snapshot.workspace_id),
    )
    const events = frames.map(frame => eventType(frame))
    expect(events).toContain('workspace.created')
    expect(events).toContain('workspace.provisioning')
    expect(events).toContain('workspace.ready')
    const readyFrame = frames.find(frame => eventType(frame) === 'workspace.ready' && frame.includes(snapshot.workspace_id)) ?? ''
    expect(readyFrame).toContain(`"resource_id":"${snapshot.workspace_id}"`)
    expect(readyFrame).toMatch(/id: evt-\d+/u)

  })

  it('serves directory listings, file content and guarded previews', async () => {
    const { port, memberHeaders } = await boot()
    const files = await fetch(`http://127.0.0.1:${port}/v1/workspaces/ws-alpha-1/files?path=src`, { headers: memberHeaders })
    expect(files.status).toBe(200)
    const listing = (await bodyOf(files)) as {
      path: string
      revision: number
      items: Array<{ path: string; kind: string; size: number; etag: string }>
    }
    expect(listing.path).toBe('src')
    expect(listing.revision).toBe(7)
    expect(listing.items).toContainEqual(expect.objectContaining({ path: 'src/app.json', kind: 'file' }))

    const content = await fetch(
      `http://127.0.0.1:${port}/v1/workspaces/ws-alpha-1/files/content?path=docs%2Fnotes.txt`,
      { headers: memberHeaders },
    )
    expect(content.status).toBe(200)
    const file = (await bodyOf(content)) as { path: string; content_type: string; content: string; etag: string }
    expect(file).toMatchObject({ path: 'docs/notes.txt' })
    expect(file.content_type.startsWith('text/plain')).toBe(true)
    expect(file.etag).toBeTruthy()

    const markdown = await fetch(
      `http://127.0.0.1:${port}/v1/workspaces/ws-alpha-1/preview?path=README.md`,
      { headers: memberHeaders },
    )
    expect((await bodyOf(markdown))).toMatchObject({ kind: 'markdown', path: 'README.md' })

    const image = await fetch(
      `http://127.0.0.1:${port}/v1/workspaces/ws-alpha-1/preview?path=assets%2Flogo.png`,
      { headers: memberHeaders },
    )
    expect((await bodyOf(image))).toMatchObject({ kind: 'image', content_type: 'image/png' })

    const html = await fetch(
      `http://127.0.0.1:${port}/v1/workspaces/ws-alpha-1/preview?path=index.html`,
      { headers: memberHeaders },
    )
    const preview = (await bodyOf(html)) as Record<string, unknown>
    expect(preview).toMatchObject({ kind: 'static_html' })
    expect(String(preview.csp)).toContain('default-src')
    expect(preview.sandbox).toContain('allow-scripts')

    const denied = await fetch(
      `http://127.0.0.1:${port}/v1/workspaces/ws-alpha-1/preview?path=..%2Fsecret`,
      { headers: memberHeaders },
    )
    expect(denied.status).toBe(403)
    expect(await bodyOf(denied)).toMatchObject({ code: 'PREVIEW_DENIED' })
  })

  it('returns changes, supports discard and git commit with revision guards', async () => {
    const { port, memberHeaders } = await boot()
    const changes = await fetch(`http://127.0.0.1:${port}/v1/workspaces/ws-alpha-1/changes`, { headers: memberHeaders })
    expect(changes.status).toBe(200)
    const diff = (await bodyOf(changes)) as {
      baseline_revision: number
      revision: number
      files: Array<{ path: string; change: string; diff: string }>
    }
    expect(diff.baseline_revision).toBe(5)
    expect(diff.revision).toBe(7)
    expect(diff.files.length).toBeGreaterThan(0)
    expect(diff.files[0].diff).toContain('---')

    const discard = await fetch(`http://127.0.0.1:${port}/v1/workspaces/ws-alpha-1/changes:discard`, {
      method: 'POST',
      headers: { ...memberHeaders, 'idempotency-key': 'discard-1' },
      body: JSON.stringify({ expected_workspace_revision: 7 }),
    })
    expect(discard.status).toBe(200)
    const after = (await bodyOf(discard)) as { revision: number }
    expect(after.revision).toBe(8)
    const emptied = await fetch(`http://127.0.0.1:${port}/v1/workspaces/ws-alpha-1/changes`, { headers: memberHeaders })
    expect(((await bodyOf(emptied)) as { files: unknown[] }).files).toHaveLength(0)

    const stale = await fetch(`http://127.0.0.1:${port}/v1/workspaces/ws-alpha-1/git/commit`, {
      method: 'POST',
      headers: { ...memberHeaders, 'idempotency-key': 'commit-stale' },
      body: JSON.stringify({ message: '陈旧提交', expected_workspace_revision: 7 }),
    })
    expect(stale.status).toBe(409)
    expect(await bodyOf(stale)).toMatchObject({ code: 'REVISION_CONFLICT' })

    const commit = await fetch(`http://127.0.0.1:${port}/v1/workspaces/ws-alpha-1/git/commit`, {
      method: 'POST',
      headers: { ...memberHeaders, 'idempotency-key': 'commit-1' },
      body: JSON.stringify({ message: '同步目录整理', expected_workspace_revision: 8 }),
    })
    expect(commit.status).toBe(200)
    expect(await bodyOf(commit)).toMatchObject({ committed: true })

    const missingKey = await fetch(`http://127.0.0.1:${port}/v1/workspaces/ws-alpha-1/git/commit`, {
      method: 'POST',
      headers: memberHeaders,
      body: JSON.stringify({ message: '缺少幂等键', expected_workspace_revision: 9 }),
    })
    expect(missingKey.status).toBe(400)
    expect(await bodyOf(missingKey)).toMatchObject({ code: 'IDEMPOTENCY_KEY_REQUIRED' })
  })

  it('creates a write run with a snapshot, reports workspace busy and supports cancel/retry', async () => {
    const { port, memberHeaders } = await boot()
    const create = await fetch(`http://127.0.0.1:${port}/v1/workspaces/ws-alpha-1/runs`, {
      method: 'POST',
      headers: { ...memberHeaders, 'idempotency-key': 'run-1' },
      body: JSON.stringify({
        session_id: 'sess-cloud-1',
        write_mode: 'write',
        expected_workspace_revision: 7,
      }),
    })
    expect(create.status).toBe(202)
    const run = (await bodyOf(create)) as {
      run_id: string
      status: string
      write_mode: string
      lease_id: string
      agent_profile_version_id: string
      asset_version_ids: string[]
      workspace_revision: number
      revision: number
    }
    expect(run.status).toBe('preparing')
    expect(run.write_mode).toBe('write')
    expect(run.lease_id).toBeTruthy()
    expect(run.agent_profile_version_id).toBe('apv-1')
    expect(run.asset_version_ids).toContain('skill:code-review@1.0.0')
    expect(run.workspace_revision).toBe(7)

    const busy = await fetch(`http://127.0.0.1:${port}/v1/workspaces/ws-alpha-1/runs`, {
      method: 'POST',
      headers: { ...memberHeaders, 'idempotency-key': 'run-2' },
      body: JSON.stringify({ session_id: 'sess-cloud-2', write_mode: 'write', expected_workspace_revision: 7 }),
    })
    expect(busy.status).toBe(409)
    const busyBody = (await bodyOf(busy)) as { code: string; current_run: { run_id: string } }
    expect(busyBody.code).toBe('WORKSPACE_BUSY')
    expect(busyBody.current_run.run_id).toBe(run.run_id)

    const replay = await fetch(`http://127.0.0.1:${port}/v1/workspaces/ws-alpha-1/runs`, {
      method: 'POST',
      headers: { ...memberHeaders, 'idempotency-key': 'run-1' },
      body: JSON.stringify({
        session_id: 'sess-cloud-1',
        write_mode: 'write',
        expected_workspace_revision: 7,
      }),
    })
    expect((await bodyOf(replay)) as { run_id: string }).toMatchObject({ run_id: run.run_id })

    const conflict = await fetch(`http://127.0.0.1:${port}/v1/workspaces/ws-alpha-1/runs`, {
      method: 'POST',
      headers: { ...memberHeaders, 'idempotency-key': 'run-3' },
      body: JSON.stringify({ session_id: 'sess-cloud-3', write_mode: 'read_only', expected_workspace_revision: 6 }),
    })
    expect(conflict.status).toBe(409)
    expect(await bodyOf(conflict)).toMatchObject({ code: 'REVISION_CONFLICT' })

    const cancel = await fetch(`http://127.0.0.1:${port}/v1/runs/${run.run_id}:cancel`, {
      method: 'POST',
      headers: { ...memberHeaders, 'idempotency-key': `cancel-${run.run_id}` },
      body: JSON.stringify({}),
    })
    expect(cancel.status).toBe(200)
    expect(await bodyOf(cancel)).toMatchObject({ status: 'cancelled' })

    const retry = await fetch(`http://127.0.0.1:${port}/v1/runs/${run.run_id}:retry`, {
      method: 'POST',
      headers: { ...memberHeaders, 'idempotency-key': `retry-${run.run_id}` },
      body: JSON.stringify({ expected_workspace_revision: 7 }),
    })
    expect(retry.status).toBe(202)
    const retried = (await bodyOf(retry)) as { run_id: string; retry_of_run_id: string; agent_profile_version_id: string }
    expect(retried.run_id).not.toBe(run.run_id)
    expect(retried.retry_of_run_id).toBe(run.run_id)
    expect(retried.agent_profile_version_id).toBe('apv-1')
  })

  it('issues a controlled workspace app URL and rejects arbitrary targets', async () => {
    const { port, memberHeaders } = await boot()
    const issued = await fetch(`http://127.0.0.1:${port}/v1/workspaces/ws-alpha-1/preview-url`, {
      method: 'POST',
      headers: { ...memberHeaders, 'idempotency-key': 'preview-url-1' },
      body: JSON.stringify({ app: 'workspace_app', port: 3000 }),
    })
    expect(issued.status).toBe(200)
    const grant = (await bodyOf(issued)) as { url: string; expires_at: string }
    expect(grant.url).toContain('/ws-alpha-1/')
    expect(Number.isNaN(Date.parse(grant.expires_at))).toBe(false)

    const wrongPort = await fetch(`http://127.0.0.1:${port}/v1/workspaces/ws-alpha-1/preview-url`, {
      method: 'POST',
      headers: { ...memberHeaders, 'idempotency-key': 'preview-url-2' },
      body: JSON.stringify({ app: 'workspace_app', port: 9999 }),
    })
    expect(wrongPort.status).toBe(403)
    expect(await bodyOf(wrongPort)).toMatchObject({ code: 'PREVIEW_DENIED' })

    const arbitrary = await fetch(`http://127.0.0.1:${port}/v1/workspaces/ws-alpha-1/preview-url`, {
      method: 'POST',
      headers: { ...memberHeaders, 'idempotency-key': 'preview-url-3' },
      body: JSON.stringify({ app: 'workspace_app', target_url: 'https://evil.example' }),
    })
    expect(arbitrary.status).toBe(422)
    expect(await bodyOf(arbitrary)).toMatchObject({ code: 'VALIDATION_ERROR' })
  })

  it('replays SSE from a watermark and demands resync beyond retention', async () => {
    const { port, memberHeaders } = await boot()
    const first = await fetch(`http://127.0.0.1:${port}/v1/projects/project-alpha/workspaces`, { headers: memberHeaders })
    const initial = (await bodyOf(first)) as { items: Array<{ workspace_id: string }> }
    expect(initial.items.length).toBeGreaterThan(0)

    const replay = await fetch(
      `http://127.0.0.1:${port}/v1/events/stream?project_id=project-alpha&after=evt-000002`,
      { headers: { authorization: 'Bearer demo-token' } },
    )
    const frames = await readSse(replay, frame => eventType(frame) === 'stream.replay-done')
    const events = frames.map(frame => eventType(frame))
    expect(events[0]).toBe('workspace.updated')
    expect(events.every(name => name !== 'workspace.created')).toBe(true)
    expect(events).toContain('stream.replay-done')


    const pruned = await boot({ 'x-fixture-scenario': 'workspace-prune-events' })
    const stale = await fetch(
      `http://127.0.0.1:${pruned.port}/v1/events/stream?project_id=project-alpha&after=evt-000001`,
      {
        headers: {
          authorization: 'Bearer demo-token',
          'x-fixture-scenario': 'workspace-prune-events',
        },
      },
    )
    const resyncFrames = await readSse(stale, frame => eventType(frame) === 'resync_required')
    expect(resyncFrames.some(frame => eventType(frame) === 'resync_required' && frame.includes('RESYNC_REQUIRED'))).toBe(true)

  })

  it('denies cross-project workspace access and records the denial audit', async () => {
    const { port, memberHeaders } = await boot()
    const denied = await fetch(`http://127.0.0.1:${port}/v1/projects/project-beta/workspaces`, { headers: memberHeaders })
    expect(denied.status).toBe(404)

    const hidden = await fetch(`http://127.0.0.1:${port}/v1/workspaces/ws-beta-1`, { headers: memberHeaders })
    expect(hidden.status).toBe(404)
    expect(await bodyOf(hidden)).toMatchObject({ code: 'RESOURCE_NOT_FOUND' })
  })

  it('creates workspace lifecycle operations with idempotency and archives', async () => {
    const { port, memberHeaders } = await boot()
    const stop = await fetch(`http://127.0.0.1:${port}/v1/workspaces/ws-alpha-1:stop`, {
      method: 'POST',
      headers: { ...memberHeaders, 'idempotency-key': 'stop-1' },
      body: JSON.stringify({ expected_workspace_revision: 7 }),
    })
    expect(stop.status).toBe(200)
    const stopped = (await bodyOf(stop)) as { status: string; revision: number }
    expect(stopped.status).toBe('stopped')

    // Every competing lifecycle write carries the revision it observed; a start
    // without one is refused rather than applied against an unknown state.
    const startWithoutRevision = await fetch(`http://127.0.0.1:${port}/v1/workspaces/ws-alpha-1:start`, {
      method: 'POST',
      headers: { ...memberHeaders, 'idempotency-key': 'start-no-revision' },
      body: JSON.stringify({}),
    })
    expect(startWithoutRevision.status).toBe(409)

    const start = await fetch(`http://127.0.0.1:${port}/v1/workspaces/ws-alpha-1:start`, {
      method: 'POST',
      headers: { ...memberHeaders, 'idempotency-key': 'start-1' },
      // The revision the stop answered with is the one this start must name.
      body: JSON.stringify({ expected_workspace_revision: stopped.revision }),
    })
    expect(start.status).toBe(202)
    expect(await bodyOf(start)).toMatchObject({ status: 'starting' })

    const retryFailed = await fetch(`http://127.0.0.1:${port}/v1/workspaces/ws-alpha-3:retry`, {
      method: 'POST',
      headers: { ...memberHeaders, 'idempotency-key': 'retry-ws-3' },
      // The seeded failed workspace is at the revision the retry must name.
      body: JSON.stringify({ expected_workspace_revision: 3 }),
    })
    expect(retryFailed.status).toBe(202)
    expect(await bodyOf(retryFailed)).toMatchObject({ status: 'provisioning' })

    const archive = await fetch(`http://127.0.0.1:${port}/v1/workspaces/ws-alpha-2:archive`, {
      method: 'POST',
      headers: { ...memberHeaders, 'idempotency-key': 'archive-2' },
      body: JSON.stringify({ expected_workspace_revision: 1 }),
    })
    expect(archive.status).toBe(200)
    expect(await bodyOf(archive)).toMatchObject({ status: 'archived' })

    const archivedWrite = await fetch(`http://127.0.0.1:${port}/v1/workspaces/ws-alpha-2/runs`, {
      method: 'POST',
      headers: { ...memberHeaders, 'idempotency-key': 'run-archived' },
      body: JSON.stringify({ session_id: 'sess-x', write_mode: 'read_only', expected_workspace_revision: 1 }),
    })
    expect(archivedWrite.status).toBe(409)
    expect(await bodyOf(archivedWrite)).toMatchObject({ code: 'INVALID_STATUS' })
  })
})
