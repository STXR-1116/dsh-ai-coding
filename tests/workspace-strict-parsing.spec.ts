/**
 * P1-05: every cloud workspace DTO, mutation result and stream event is parsed
 * fail-closed. A missing field, a type error, or a member outside a closed enum
 * is `SERVICE_PROTOCOL_ERROR`; no sentinel, empty string, zero, empty object or
 * default enum member may stand in for a value the server did not send.
 *
 * Documented exception (not a fallback): `WorkspaceLifecycleStatus`, `AgentRunStatus`
 * and `WorkspaceStreamEvent.resourceType` carry an explicit `unknown` member in the
 * type contract, so an unrecognized member maps to `unknown` and is displayed as such.
 */

import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import {
  parseAgentProfile,
  parseAgentType,
  parseChanges,
  parseDirectory,
  parseFileContent,
  parsePreview,
  parsePreviewUrlGrant,
  parsePullRequestResult,
  parseRevisionResult,
  parseRun,
  parseStreamEvent,
  parseWorkspace,
} from '../src/workspace-http.ts'
import { WorkspaceHost } from '../src/workspace-host.ts'
import type { WorkspaceSessionProvider } from '../src/workspace-host.ts'

const servers: Server[] = []
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => { resolve() }))
  }
})

/** Serves one canned envelope for every request and records the request URLs. */
async function serveEnvelope(
  data: unknown,
  envelope: { code?: number; message?: string } = {},
): Promise<{ readonly baseUrl: string; readonly urls: string[] }> {
  const urls: string[] = []
  const server = createServer((request, response) => {
    urls.push(request.url ?? '')
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({
      code: envelope.code ?? 0,
      message: envelope.message ?? 'ok',
      request_id: 'req-strict-1',
      data,
    }))
  })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => { resolve() }))
  return { baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, urls }
}

function session(token = 'test-account-token', onClear: () => void = () => undefined): WorkspaceSessionProvider {
  const current = token
  return {
    read: async () => ({ accessToken: current, identity: `identity:${current}` }),
    clear: async (identity: string) => {
      if (`identity:${current}` !== identity) return false
      onClear()
      return true
    },
  }
}

function hostFor(baseUrl: string): WorkspaceHost {
  return new WorkspaceHost({ apiBaseUrl: baseUrl, session: session() })
}

// --- valid baselines ---------------------------------------------------------

const workspace = {
  workspace_id: 'ws-1',
  project_id: 'project-1',
  owner_user_id: 'user-1',
  repository_id: 'repo-1',
  branch: 'main',
  display_name: 'Main branch',
  default_agent_profile_version_id: 'apv-1',
  status: 'ready',
  revision: 3,
  last_error: null,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
}

const agentType = {
  agent_type_id: 'at-1',
  key: 'claude-code',
  name: 'Claude Code',
  capabilities: ['bash'],
  readiness: 'ready',
}

const profile = {
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
  skills: [
    { asset_id: 'skill:a', asset_version_id: 'skill:a@1', name: 'Skill A', required: true, order: 1, readiness: 'ready', unavailable_reason: null },
  ],
  knowledge_bases: [],
  memory: null,
  execution_policy: { permission_mode: 'approval', write_mode: 'write' },
  type_extension_config: { permission_mode: 'approval' },
  readiness: 'ready',
  unavailable_reason: null,
  default: false,
  status: 'published',
  created_by: '平台管理员',
  published_at: '2026-09-01T00:00:00.000Z',
  updated_at: '2026-09-01T00:00:00.000Z',
}

const run = {
  run_id: 'run-1',
  project_id: 'project-1',
  workspace_id: 'ws-1',
  session_id: 'session-1',
  agent_profile_version_id: 'apv-1',
  asset_version_ids: ['asset-1'],
  execution_policy: { permission_mode: 'approval' },
  workspace_revision: 3,
  status: 'running',
  write_mode: 'read_only',
  lease_id: null,
  revision: 4,
  error_code: null,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
}

const directory = {
  path: 'src',
  revision: 3,
  items: [{ path: 'src/index.ts', kind: 'file', size: 42, etag: 'etag-1' }],
}

const fileContent = {
  path: 'src/index.ts',
  content_type: 'text/plain',
  size: 42,
  etag: 'etag-1',
  revision: 3,
  content: 'export {}',
}

const changes = {
  workspace_id: 'ws-1',
  baseline_revision: 1,
  revision: 3,
  files: [{ path: 'src/index.ts', change: 'modified', diff: '@@ -1 +1 @@' }],
}

const preview = {
  path: 'src/index.ts',
  revision: 3,
  etag: 'etag-1',
  kind: 'text',
  content_type: 'text/plain',
  content: 'export {}',
}

const previewGrant = { url: 'https://app.example/ws-1', expires_at: '2026-01-01T00:05:00.000Z', workspace_id: 'ws-1' }

/** Deployment policy the grant is validated against; the clock is fixed so expiry is deterministic. */
const previewGrantPolicy = {
  allowedOrigins: ['https://app.example'],
  workspaceId: 'ws-1',
  now: () => Date.parse('2026-01-01T00:00:00.000Z'),
}

const streamEvent = {
  event_id: 'evt-000001',
  resource_type: 'workspace',
  resource_id: 'ws-1',
  revision: 3,
  event_type: 'workspace.updated',
  occurred_at: '2026-01-01T00:00:00.000Z',
  payload: { workspace_id: 'ws-1' },
}

/** Copies a record without one key, so "missing field" cases stay honest. */
function without(record: Record<string, unknown>, key: string): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([name]) => name !== key))
}

// --- versioned parsers -------------------------------------------------------

describe('P1-05 workspace snapshot parsing is fail-closed', () => {
  it('accepts the complete DTO', () => {
    expect(parseWorkspace(workspace)).toMatchObject({ workspaceId: 'ws-1', displayName: 'Main branch' })
  })

  it('rejects a missing display_name instead of substituting the branch', () => {
    expect(() => parseWorkspace(without(workspace, 'display_name'))).toThrow(/display_name/u)
  })

  it('rejects a mistyped required string', () => {
    expect(() => parseWorkspace({ ...workspace, branch: 7 })).toThrow(/branch/u)
  })

  it('rejects a non-null non-string last_error instead of collapsing it to null', () => {
    expect(() => parseWorkspace({ ...workspace, last_error: 5 })).toThrow(/last_error/u)
  })

  it('maps an unrecognized lifecycle status to the documented unknown member', () => {
    expect(parseWorkspace({ ...workspace, status: 'teleporting' }).status).toBe('unknown')
  })
})

describe('P1-05 agent type parsing is fail-closed', () => {
  it('accepts each declared readiness', () => {
    for (const readiness of ['ready', 'degraded', 'unavailable'] as const) {
      expect(parseAgentType({ ...agentType, readiness }).readiness).toBe(readiness)
    }
  })

  it('rejects an unknown readiness instead of reporting ready', () => {
    expect(() => parseAgentType({ ...agentType, readiness: 'maybe' })).toThrow(/readiness/u)
  })

  it('rejects a missing readiness', () => {
    expect(() => parseAgentType(without(agentType, 'readiness'))).toThrow(/readiness/u)
  })
})

describe('P1-05 agent profile parsing is fail-closed', () => {
  it('accepts a published profile', () => {
    expect(parseAgentProfile(profile)).toMatchObject({ model: 'deepseek-v3.2', reasoning: 'medium' })
  })

  it('rejects a missing model instead of substituting an empty string', () => {
    expect(() => parseAgentProfile(without(profile, 'model'))).toThrow(/model/u)
  })

  it('rejects a missing reasoning instead of substituting an empty string', () => {
    expect(() => parseAgentProfile(without(profile, 'reasoning'))).toThrow(/reasoning/u)
  })

  it('rejects missing structured bindings instead of falling back to asset_version_ids', () => {
    const legacy = { ...without(profile, 'skills'), asset_version_ids: ['asset-1'] }
    expect(() => parseAgentProfile(legacy)).toThrow(/skills/u)
    expect(() => parseAgentProfile(without(profile, 'knowledge_bases'))).toThrow(/knowledge_bases/u)
    expect(() => parseAgentProfile(without(profile, 'memory'))).toThrow(/memory/u)
  })
})

describe('P1-05 run parsing is fail-closed', () => {
  it('accepts both write modes', () => {
    expect(parseRun({ ...run, write_mode: 'write' }).writeMode).toBe('write')
    expect(parseRun({ ...run, write_mode: 'read_only' }).writeMode).toBe('read_only')
  })

  it('rejects an unknown write_mode instead of reporting read_only', () => {
    expect(() => parseRun({ ...run, write_mode: 'append' })).toThrow(/write_mode/u)
  })

  it('rejects a missing write_mode', () => {
    expect(() => parseRun(without(run, 'write_mode'))).toThrow(/write_mode/u)
  })

  it('rejects a non-null non-string lease_id and error_code', () => {
    expect(() => parseRun({ ...run, lease_id: 1 })).toThrow(/lease_id/u)
    expect(() => parseRun({ ...run, error_code: false })).toThrow(/error_code/u)
  })
})

describe('P1-05 directory and file parsing is fail-closed', () => {
  it('accepts a complete listing', () => {
    expect(parseDirectory(directory).items[0]).toMatchObject({ path: 'src/index.ts', size: 42 })
  })

  it('rejects a missing entry size instead of reporting 0', () => {
    const entry = without(directory.items[0]!, 'size')
    expect(() => parseDirectory({ ...directory, items: [entry] })).toThrow(/entry size/u)
  })

  it('rejects an unknown entry kind instead of reporting file', () => {
    expect(() => parseDirectory({
      ...directory,
      items: [{ ...directory.items[0], kind: 'symlink' }],
    })).toThrow(/entry kind/u)
  })

  it('rejects a missing directory path instead of reporting an empty string', () => {
    expect(() => parseDirectory(without(directory, 'path'))).toThrow(/directory path/u)
  })

  it('rejects a missing file size instead of reporting 0', () => {
    expect(() => parseFileContent(without(fileContent, 'size'))).toThrow(/size/u)
  })
})

describe('P1-05 change set parsing is fail-closed', () => {
  it('accepts every declared change kind', () => {
    for (const change of ['added', 'modified', 'deleted'] as const) {
      expect(parseChanges({ ...changes, files: [{ ...changes.files[0], change }] }).files[0]?.change).toBe(change)
    }
  })

  it('rejects an unknown change kind instead of reporting modified', () => {
    expect(() => parseChanges({
      ...changes,
      files: [{ ...changes.files[0], change: 'renamed' }],
    })).toThrow(/change kind/u)
  })

  it('rejects a missing diff instead of reporting an empty diff', () => {
    const entry = without(changes.files[0]!, 'diff')
    expect(() => parseChanges({ ...changes, files: [entry] })).toThrow(/change diff/u)
  })

  it('rejects a missing workspace_id instead of reporting an empty string', () => {
    expect(() => parseChanges(without(changes, 'workspace_id'))).toThrow(/workspace_id/u)
  })
})

describe('P1-05 preview parsing is fail-closed', () => {
  it('accepts a complete preview', () => {
    expect(parsePreview(preview)).toMatchObject({ kind: 'text', etag: 'etag-1' })
  })

  it('rejects a missing etag instead of reporting an empty string', () => {
    expect(() => parsePreview(without(preview, 'etag'))).toThrow(/etag/u)
  })

  it('rejects an unknown preview kind', () => {
    expect(() => parsePreview({ ...preview, kind: 'hologram' })).toThrow(/preview kind/u)
  })
})

describe('P1-05 stream event parsing is fail-closed', () => {
  it('accepts a complete event', () => {
    expect(parseStreamEvent(streamEvent)).toMatchObject({ eventId: 'evt-000001', revision: 3 })
  })

  it('rejects a missing revision instead of reporting 0', () => {
    expect(() => parseStreamEvent(without(streamEvent, 'revision'))).toThrow(/event revision/u)
  })

  it('rejects a missing payload instead of reporting an empty object', () => {
    expect(() => parseStreamEvent(without(streamEvent, 'payload'))).toThrow(/event payload/u)
  })

  it('rejects a mistyped payload', () => {
    expect(() => parseStreamEvent({ ...streamEvent, payload: 'nope' })).toThrow(/event payload/u)
  })

  it('maps an unrecognized resource_type to the documented unknown member', () => {
    expect(parseStreamEvent({ ...streamEvent, resource_type: 'sandbox' }).resourceType).toBe('unknown')
  })
})

describe('P1-05 mutation results are fail-closed', () => {
  it('accepts a revision result and rejects a missing revision instead of reporting 0', () => {
    expect(parseRevisionResult({ revision: 9 })).toEqual({ revision: 9 })
    expect(() => parseRevisionResult({})).toThrow(/mutation revision/u)
    expect(() => parseRevisionResult({ revision: '9' })).toThrow(/mutation revision/u)
  })

  it('accepts a pull request result and rejects a missing id instead of reporting an empty string', () => {
    expect(parsePreviewUrlGrant(previewGrant, previewGrantPolicy)).toMatchObject({ workspaceId: 'ws-1' })
    expect(parsePullRequestResult({ pull_request_id: 'pr-7' })).toEqual({ pullRequestId: 'pr-7' })
    expect(() => parsePullRequestResult({})).toThrow(/pull_request_id/u)
    expect(() => parsePullRequestResult({ pull_request_id: '' })).toThrow(/pull_request_id/u)
  })
})

// --- real HTTP path ----------------------------------------------------------

describe('P1-05 the Host surfaces protocol drift over the real HTTP path', () => {
  it('fails a workspace query whose display_name is absent, without returning a value', async () => {
    const { baseUrl } = await serveEnvelope({ ...without(workspace, 'display_name') })
    const result = await hostFor(baseUrl).workspace('ws-1')
    expect(result.status).toBe('failed')
    expect(result).toMatchObject({ code: 'SERVICE_PROTOCOL_ERROR' })
    expect('value' in result).toBe(false)
  })

  it('fails a run listing whose write_mode is unknown', async () => {
    const { baseUrl } = await serveEnvelope({ items: [{ ...run, write_mode: 'append' }] })
    const result = await hostFor(baseUrl).workspaceRuns('ws-1')
    expect(result).toMatchObject({ status: 'failed', code: 'SERVICE_PROTOCOL_ERROR' })
    expect('value' in result).toBe(false)
  })

  it('fails a commit whose result omits the revision instead of reporting revision 0', async () => {
    const { baseUrl } = await serveEnvelope({ committed: true })
    const result = await hostFor(baseUrl).gitCommit('ws-1', 'message', 3)
    expect(result).toMatchObject({ status: 'failed', code: 'SERVICE_PROTOCOL_ERROR' })
    expect('value' in result).toBe(false)
  })

  it('fails a change set that belongs to another workspace', async () => {
    const { baseUrl } = await serveEnvelope(changes)
    const result = await hostFor(baseUrl).workspaceChanges('ws-other')
    expect(result).toMatchObject({ status: 'failed', code: 'SERVICE_PROTOCOL_ERROR' })
    expect('value' in result).toBe(false)
  })

  it('keeps serving valid snapshots after a protocol failure', async () => {
    const bad = await serveEnvelope({ items: [{ ...run, write_mode: 'append' }] })
    expect((await hostFor(bad.baseUrl).workspaceRuns('ws-1')).status).toBe('failed')
    const good = await serveEnvelope({ items: [run] })
    const recovered = await hostFor(good.baseUrl).workspaceRuns('ws-1')
    expect(recovered.status).toBe('ready')
    expect(recovered.status === 'ready' ? recovered.value[0]?.runId : undefined).toBe('run-1')
  })
})
