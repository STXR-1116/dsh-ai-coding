/* oxlint-disable typescript/no-base-to-string -- Fetch spy assertions inspect RequestInfo wire values. */
import { afterEach, describe, expect, it } from 'vitest'
import type { AddressInfo } from 'node:net'
import { createTeamSkillService } from '../dev/team-skill-service/src/server.ts'
import { WorkspaceHost } from '../src/workspace-host.ts'
import type { WorkspaceSessionProvider } from '../src/workspace-host.ts'

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

async function boot(): Promise<string> {
  const service = createTeamSkillService({ port: 0 })
  services.push(service)
  await service.listen()
  return `http://127.0.0.1:${(service.server.address() as AddressInfo).port}`
}

export interface CapturedRequest {
  readonly url: string
  readonly method: string
  readonly headers: Record<string, string>
  readonly body?: unknown
}

function recordingFetch(captured: CapturedRequest[]): typeof globalThis.fetch {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const headers: Record<string, string> = {}
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = value
    })
    captured.push({
      url: String(input),
      method: init?.method ?? 'GET',
      headers,
      ...(typeof init?.body === 'string' ? { body: JSON.parse(init.body) as unknown } : {}),
    })
    return globalThis.fetch(input, init)
  }
}

function staticSession(token: string, onClear: () => void | Promise<void> = () => undefined): WorkspaceSessionProvider {
  let current = token
  return {
    read: async () => (current.length === 0 ? undefined : { accessToken: current, identity: `identity:${current}` }),
    clear: async (identity: string) => {
      // Mirrors the real provider: a 401 only clears the credential it was
      // issued under, and an empty token is signed-out rather than a failure.
      if (current.length === 0 || `identity:${current}` !== identity) return false
      current = ''
      await onClear()
      return true
    },
  }
}

async function untilWorkspaceReady(host: WorkspaceHost, workspaceId: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const snapshot = await host.workspace(workspaceId)
    if (snapshot.status === 'ready' && snapshot.value.status === 'ready') return
    if (snapshot.status === 'failed') throw new Error(`workspace query failed: ${snapshot.code}`)
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error('workspace did not become ready')
}

function waitForEvent(
  host: WorkspaceHost,
  predicate: (payload: { eventType: string; resourceId: string }) => boolean,
): Promise<{ eventType: string; resourceId: string }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('timed out waiting for stream event'))
    }, 5000)
    const dispose = host.onStreamEvent((_subscriptionId, event) => {
      if (!predicate(event)) return
      clearTimeout(timer)
      dispose()
      resolve(event)
    })
  })
}

describe('WorkspaceHost over the real workspace fixture', () => {
  it('maps missing credentials and rejected tokens to signed-out and clears the session', async () => {
    const baseUrl = await boot()
    let cleared = 0
    const unsigned = new WorkspaceHost({ apiBaseUrl: baseUrl, session: staticSession('', () => { cleared += 1 }) })
    await expect(unsigned.agentTypes()).resolves.toMatchObject({ status: 'signed-out' })

    const rejected = new WorkspaceHost({
      apiBaseUrl: baseUrl,
      session: staticSession('invalid-token', () => {
        cleared += 1
      }),
    })
    await expect(rejected.agentTypes()).resolves.toMatchObject({ status: 'signed-out' })
    expect(cleared).toBeGreaterThan(0)
  })

  it('produces not-ready results without an API base URL', async () => {
    const host = new WorkspaceHost({ session: staticSession('demo-token') })
    await expect(host.agentTypes()).resolves.toMatchObject({ status: 'not-ready' })
  })

  it('reads server snapshots: agent types, published project profiles and workspace list', async () => {
    const baseUrl = await boot()
    const host = new WorkspaceHost({ apiBaseUrl: baseUrl, session: staticSession('demo-token') })
    const types = await host.agentTypes()
    expect(types.status).toBe('ready')
    if (types.status === 'ready') {
      expect(types.value.map(item => item.key)).toEqual(['claude_code', 'hermes', 'legacy_shell'])
    }
    const profiles = await host.agentProfiles('project-alpha')
    expect(profiles.status).toBe('ready')
    if (profiles.status === 'ready') {
      expect(profiles.value.map(item => item.agentProfileId).sort()).toEqual([
        'ap-code-default',
        'ap-legacy-shell',
        'ap-review-lite',
      ])
      const mainline = profiles.value.find(item => item.agentProfileId === 'ap-code-default')
      expect(mainline).toMatchObject({
        agentProfileVersionId: 'apv-1',
        status: 'published',
        default: true,
        readiness: 'ready',
      })
      expect(mainline?.skills.map(skill => skill.assetVersionId)).toEqual(['skill:code-review@1.0.0'])
      expect(mainline?.memory).toMatchObject({ assetVersionId: 'memory:m-1' })
      expect(mainline?.executionPolicy.write_mode).toBe('write')
      const degraded = profiles.value.find(item => item.agentProfileId === 'ap-review-lite')
      expect(degraded?.readiness).toBe('degraded')
      // 真实服务的用户面载荷字段齐全（卡片与详情的全部词汇），且不含凭据字段。
      const raw = await fetch(`${baseUrl}/v1/me/agent-profiles?project_id=project-alpha`, {
        headers: { authorization: 'Bearer demo-token' },
      })
      expect(raw.status).toBe(200)
      const rawBody = (await raw.json()) as { data: { items: Array<Record<string, unknown>> } }
      const rawMainline = rawBody.data.items.find(item => item.agent_profile_id === 'ap-code-default') as Record<string, unknown>
      for (const field of [
        'description', 'version_label', 'change_summary', 'agent_type_name', 'agent_type_key',
        'agent_type_readiness', 'agent_type_capabilities', 'skills', 'knowledge_bases', 'memory',
        'execution_policy', 'type_extension_config', 'readiness', 'unavailable_reason', 'default',
        'created_by', 'published_at', 'updated_at',
      ]) {
        expect(Object.hasOwn(rawMainline, field)).toBe(true)
      }
      expect(JSON.stringify(rawBody)).not.toContain('credential_ref')
    }
    const workspaces = await host.workspaces('project-alpha')
    expect(workspaces.status).toBe('ready')
    if (workspaces.status === 'ready') {
      const ready = workspaces.value.find(item => item.workspaceId === 'ws-alpha-1')
      expect(ready).toMatchObject({
        projectId: 'project-alpha',
        branch: 'main',
        status: 'ready',
        revision: 7,
        defaultAgentProfileVersionId: 'apv-1',
      })
      expect(workspaces.value.some(item => item.workspaceId === 'ws-beta-1')).toBe(false)
    }
  })

  it('creates a workspace with an idempotency key and observes ready through the SSE stream', async () => {
    const baseUrl = await boot()
    const captured: CapturedRequest[] = []
    const host = new WorkspaceHost({
      apiBaseUrl: baseUrl,
      session: staticSession('demo-token'),
      fetch: recordingFetch(captured),
      idempotencyKey: () => 'idem-create-ws',
    })
    const created = await host.createWorkspace({
      projectId: 'project-alpha',
      repositoryId: 'repo-1',
      branch: 'feature/host-loop',
      agentProfileVersionId: 'apv-1',
      displayName: 'Host 闭环',
    })
    expect(created.status).toBe('ready')
    if (created.status !== 'ready') return
    expect(created.value.status).toBe('provisioning')
    const createRequest = captured.find(item => item.url.endsWith('/v1/projects/project-alpha/workspaces'))
    expect(createRequest).toBeDefined()
    expect(createRequest?.headers['idempotency-key']).toBe('idem-create-ws')
    expect(createRequest?.body).toMatchObject({
      repository_id: 'repo-1',
      branch: 'feature/host-loop',
      agent_profile_version_id: 'apv-1',
    })

    host.startStream({ projectId: 'project-alpha' })
    try {
      // Lifecycle advance is read-driven in the fixture: poll while collecting events.
      const readyEventPromise = waitForEvent(
        host,
        event => event.eventType === 'workspace.ready' && event.resourceId === created.value.workspaceId,
      )
      await untilWorkspaceReady(host, created.value.workspaceId)
      const readyEvent = await readyEventPromise
      expect(readyEvent.resourceId).toBe(created.value.workspaceId)
      expect(host.streamState().status).toBe('live')
    } finally {
      host.stopStream()
    }
    expect(host.streamState().status).toBe('idle')
  })

  it('creates a write run with revision guard, reports WORKSPACE_BUSY, then cancels and retries', async () => {
    const baseUrl = await boot()
    const captured: CapturedRequest[] = []
    const host = new WorkspaceHost({
      apiBaseUrl: baseUrl,
      session: staticSession('demo-token'),
      fetch: recordingFetch(captured),
      idempotencyKey: () => `idem-${captured.length}`,
    })
    const run = await host.createRun({
      workspaceId: 'ws-alpha-1',
      sessionId: 'sess-host-1',
      writeMode: 'write',
      expectedWorkspaceRevision: 7,
    })
    expect(run.status).toBe('ready')
    if (run.status !== 'ready') return
    expect(run.value).toMatchObject({
      status: 'preparing',
      writeMode: 'write',
      agentProfileVersionId: 'apv-1',
      workspaceRevision: 7,
    })
    expect(run.value.leaseId).toBeTruthy()
    expect(run.value.assetVersionIds).toContain('skill:code-review@1.0.0')
    const runRequest = captured.find(item => item.url.endsWith('/v1/workspaces/ws-alpha-1/runs'))
    expect(runRequest?.headers['idempotency-key']).toMatch(/^idem-/)
    expect(runRequest?.body).toMatchObject({
      session_id: 'sess-host-1',
      write_mode: 'write',
      expected_workspace_revision: 7,
    })

    const busy = await host.createRun({
      workspaceId: 'ws-alpha-1',
      sessionId: 'sess-host-2',
      writeMode: 'write',
      expectedWorkspaceRevision: 7,
    })
    expect(busy).toMatchObject({ status: 'failed', code: 'WORKSPACE_BUSY' })

    const conflict = await host.createRun({
      workspaceId: 'ws-alpha-1',
      sessionId: 'sess-host-3',
      writeMode: 'read_only',
      expectedWorkspaceRevision: 6,
    })
    expect(conflict).toMatchObject({ status: 'failed', code: 'REVISION_CONFLICT' })

    const canceled = await host.cancelRun(run.value.runId)
    expect(canceled.status).toBe('ready')
    if (canceled.status === 'ready') expect(canceled.value.status).toBe('cancelled')

    const retried = await host.retryRun(run.value.runId, 7)
    expect(retried.status).toBe('ready')
    if (retried.status !== 'ready') return
    expect(retried.value.runId).not.toBe(run.value.runId)
    expect(retried.value.retryOfRunId).toBe(run.value.runId)
    expect(retried.value.agentProfileVersionId).toBe('apv-1')
  })

  it('reads changes and previews, discards changes and maps stale commits to REVISION_CONFLICT', async () => {
    const baseUrl = await boot()
    const captured: CapturedRequest[] = []
    const host = new WorkspaceHost({
      apiBaseUrl: baseUrl,
      session: staticSession('demo-token'),
      fetch: recordingFetch(captured),
      idempotencyKey: () => `idem-changes-${captured.length}`,
    })
    const changes = await host.workspaceChanges('ws-alpha-1')
    expect(changes.status).toBe('ready')
    if (changes.status === 'ready') {
      expect(changes.value).toMatchObject({ baselineRevision: 5, revision: 7 })
      expect(changes.value.files.length).toBeGreaterThan(0)
      expect(changes.value.files[0]?.diff).toContain('---')
    }
    const preview = await host.workspacePreview('ws-alpha-1', 'index.html')
    expect(preview.status).toBe('ready')
    if (preview.status === 'ready') {
      expect(preview.value.kind).toBe('static_html')
      expect(preview.value.csp).toContain('default-src')
      expect(preview.value.sandbox).toContain('allow-scripts')
    }
    const denied = await host.workspacePreview('ws-alpha-1', '../secret')
    expect(denied).toMatchObject({ status: 'failed', code: 'PREVIEW_DENIED' })

    const discarded = await host.discardChanges('ws-alpha-1', 7)
    expect(discarded.status).toBe('ready')
    if (discarded.status === 'ready') expect(discarded.value.revision).toBe(8)

    const staleCommit = await host.gitCommit('ws-alpha-1', '陈旧提交', 7)
    expect(staleCommit).toMatchObject({ status: 'failed', code: 'REVISION_CONFLICT' })
    const commit = await host.gitCommit('ws-alpha-1', '同步目录整理', 8)
    expect(commit.status).toBe('ready')
    if (commit.status === 'ready') expect(commit.value.revision).toBe(9)
    const commitRequest = captured.filter(item => item.url.endsWith('/v1/workspaces/ws-alpha-1/git/commit')).at(-1)
    expect(commitRequest?.headers['idempotency-key']).toBeTruthy()
    expect(commitRequest?.body).toMatchObject({ message: '同步目录整理', expected_workspace_revision: 8 })
  })

  it('surfaces downstream SERVICE_UNAVAILABLE as a stable failed result', async () => {
    const service = createTeamSkillService({ port: 0 })
    services.push(service)
    await service.listen()
    const port = (service.server.address() as AddressInfo).port
    const scenarioFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const headers = new Headers(init?.headers)
      headers.set('x-fixture-scenario', 'workspace-downstream-failure')
      return globalThis.fetch(input, { ...init, headers })
    }
    const host = new WorkspaceHost({
      apiBaseUrl: `http://127.0.0.1:${port}`,
      session: staticSession('demo-token'),
      fetch: scenarioFetch,
    })
    await expect(host.workspaces('project-alpha')).resolves.toMatchObject({
      status: 'failed',
      code: 'SERVICE_UNAVAILABLE',
    })
  })

  it('carries preview.revoked on the stream when the workspace stops', async () => {
    const baseUrl = await boot()
    const host = new WorkspaceHost({
      apiBaseUrl: baseUrl,
      session: staticSession('demo-token'),
      idempotencyKey: () => 'idem-revoke',
    })
    host.startStream({ workspaceId: 'ws-alpha-1' })
    const revoked = waitForEvent(host, event => event.eventType === 'preview.revoked')
    const stopped = await host.workspaceAction('ws-alpha-1', 'stop', 7)
    expect(stopped.status).toBe('ready')
    if (stopped.status === 'ready') expect(stopped.value.status).toBe('stopped')
    await expect(revoked).resolves.toMatchObject({ eventType: 'preview.revoked', resourceId: 'ws-alpha-1' })
    host.stopStream()
  })

  it('maps TOKEN_EXPIRED to signed-out with the session cleared', async () => {
    const baseUrl = await boot()
    let cleared = 0
    const scenarioFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const headers = new Headers(init?.headers)
      headers.set('x-fixture-scenario', 'workspace-expired-token')
      return globalThis.fetch(input, { ...init, headers })
    }
    const host = new WorkspaceHost({
      apiBaseUrl: baseUrl,
      session: staticSession('demo-token', () => {
        cleared += 1
      }),
      fetch: scenarioFetch,
    })
    await expect(host.agentTypes()).resolves.toMatchObject({ status: 'signed-out' })
    expect(cleared).toBeGreaterThan(0)
  })

  it('issues a controlled preview URL and surfaces PREVIEW_DENIED for arbitrary targets', async () => {
    const baseUrl = await boot()
    const host = new WorkspaceHost({
      apiBaseUrl: baseUrl,
      session: staticSession('demo-token'),
      // A grant is only usable on an allowlisted origin; the local fixture is
      // that origin here, and nothing else is permitted.
      previewOrigins: ['https://workspace-app.fixture.internal'],
      idempotencyKey: (() => {
        let counter = 0
        return () => `idem-preview-${counter += 1}`
      })(),
    })
    const grant = await host.issuePreviewUrl('ws-alpha-1', 3000)
    expect(grant.status).toBe('ready')
    if (grant.status === 'ready') {
      expect(grant.value.url).toContain('/ws-alpha-1/')
      expect(Number.isNaN(Date.parse(grant.value.expiresAt))).toBe(false)
    }
    await expect(host.issuePreviewUrl('ws-alpha-1', 9999)).resolves.toMatchObject({
      status: 'failed',
      code: 'PREVIEW_DENIED',
    })
  })
})
