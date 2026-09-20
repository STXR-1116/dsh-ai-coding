import { describe, expect, it } from 'vitest'
import { parseAgentProfile, parseRun } from '../src/workspace-http.ts'

/**
 * The user-facing profile version payload: the server answers with display-ready
 * asset entries (name/readiness resolved server side) and never credential material.
 */
const profile = {
  agent_profile_id: 'ap-1',
  agent_profile_version_id: 'apv-1',
  name: '默认研发代理',
  description: '面向研发工作空间的默认执行配置',
  version_label: 'v1',
  change_summary: '首个发布版本',
  agent_type_id: 'at-1',
  agent_type_name: 'Claude Code',
  agent_type_key: 'claude_code',
  agent_type_readiness: 'ready',
  agent_type_capabilities: ['terminal', 'files'],
  model: 'deepseek-v3.2',
  reasoning: 'medium',
  skills: [
    {
      asset_id: 'skill:code-review',
      asset_version_id: 'skill:code-review@1.0.0',
      name: '代码评审 Skill',
      required: true,
      order: 1,
      readiness: 'ready',
      unavailable_reason: null,
    },
  ],
  knowledge_bases: [
    {
      asset_id: 'knowledge:k-1',
      asset_version_id: 'knowledge:k-1',
      name: '知识库 k-1',
      required: true,
      order: 1,
      readiness: 'ready',
      unavailable_reason: null,
    },
  ],
  memory: {
    asset_id: 'memory:m-1',
    asset_version_id: 'memory:m-1',
    name: '记忆库 m-1',
    required: true,
    order: 1,
    readiness: 'ready',
    unavailable_reason: null,
  },
  execution_policy: {
    permission_mode: 'approval',
    tool_allowlist: ['read', 'write'],
    max_concurrency: 2,
    budget: 200000,
    timeout_ms: 900000,
    write_mode: 'write',
  },
  type_extension_config: { permission_mode: 'approval', nested: { server: 'value' } },
  readiness: 'ready',
  unavailable_reason: null,
  default: true,
  status: 'published',
  created_by: '平台管理员',
  published_at: '2026-09-01T00:00:00.000Z',
  updated_at: '2026-09-02T00:00:00.000Z',
}

const run = {
  run_id: 'run-1',
  project_id: 'project-1',
  workspace_id: 'ws-1',
  session_id: 'session-1',
  agent_profile_version_id: 'apv-1',
  asset_version_ids: ['asset-1'],
  execution_policy: { permission_mode: 'approval', write_mode: 'write' },
  workspace_revision: 3,
  status: 'running',
  write_mode: 'read_only',
  lease_id: null,
  revision: 4,
  error_code: null,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
}

function without(record: Record<string, unknown>, field: string): Record<string, unknown> {
  const clone: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(record)) {
    if (key !== field) clone[key] = value
  }
  return clone
}

describe('agent profile parsing carries the full read-only card', () => {
  it('parses every card and detail field', () => {
    const parsed = parseAgentProfile(profile)
    expect(parsed).toMatchObject({
      agentProfileId: 'ap-1',
      agentProfileVersionId: 'apv-1',
      name: '默认研发代理',
      description: '面向研发工作空间的默认执行配置',
      versionLabel: 'v1',
      changeSummary: '首个发布版本',
      agentTypeId: 'at-1',
      agentTypeName: 'Claude Code',
      agentTypeKey: 'claude_code',
      agentTypeReadiness: 'ready',
      model: 'deepseek-v3.2',
      reasoning: 'medium',
      readiness: 'ready',
      unavailableReason: null,
      default: true,
      status: 'published',
      createdBy: '平台管理员',
      publishedAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-02T00:00:00.000Z',
    })
    expect(parsed.agentTypeCapabilities).toEqual(['terminal', 'files'])
    expect(parsed.skills).toHaveLength(1)
    expect(parsed.skills[0]).toMatchObject({
      assetId: 'skill:code-review',
      assetVersionId: 'skill:code-review@1.0.0',
      name: '代码评审 Skill',
      required: true,
      order: 1,
      readiness: 'ready',
      unavailableReason: null,
    })
    expect(parsed.knowledgeBases).toHaveLength(1)
    expect(parsed.memory).toMatchObject({ assetId: 'memory:m-1', required: true })
    expect(parsed.executionPolicy).toMatchObject({ permission_mode: 'approval', write_mode: 'write' })
    expect(parsed.typeExtension.permission_mode).toBe('approval')
    // Non-scalar values stay present as opaque keys rather than being dropped.
    expect(parsed.typeExtensionOpaqueKeys).toEqual(['nested'])
  })

  it('accepts memory: null as "no memory library"', () => {
    expect(parseAgentProfile({ ...profile, memory: null }).memory).toBeNull()
  })

  it('rejects a missing skills or knowledge_bases or memory field instead of defaulting', () => {
    expect(() => parseAgentProfile(without(profile, 'skills'))).toThrow(/skills/u)
    expect(() => parseAgentProfile(without(profile, 'knowledge_bases'))).toThrow(/knowledge_bases/u)
    expect(() => parseAgentProfile(without(profile, 'memory'))).toThrow(/memory/u)
  })

  it('rejects a binding entry without an explicit required flag', () => {
    const entry = { asset_id: 's', asset_version_id: 's@1', name: 'S', order: 1, readiness: 'ready', unavailable_reason: null }
    expect(() => parseAgentProfile({ ...profile, skills: [entry] })).toThrow(/required/u)
    expect(() => parseAgentProfile({ ...profile, skills: [{ ...entry, required: 'yes' }] })).toThrow(/required/u)
  })

  it('rejects unknown readiness or unavailable type readiness values', () => {
    expect(() => parseAgentProfile({ ...profile, readiness: 'green' })).toThrow(/readiness/u)
    expect(() => parseAgentProfile({ ...profile, agent_type_readiness: 'wip' })).toThrow(/readiness/u)
    expect(() => parseAgentProfile({ ...profile, skills: [{ ...profile.skills[0], readiness: 'partial' }] })).toThrow(/readiness/u)
  })

  it('rejects a non-object type_extension_config but keeps scalar values verbatim', () => {
    expect(() => parseAgentProfile({ ...profile, type_extension_config: 'approval' })).toThrow(/type_extension_config/u)
    expect(() => parseAgentProfile({ ...profile, type_extension_config: [1] })).toThrow(/type_extension_config/u)
    const parsed = parseAgentProfile(profile)
    expect(parsed.typeExtension.permission_mode).toBe('approval')
    expect(parsed.typeExtension.nested).toBeUndefined()
    expect(parsed.typeExtensionOpaqueKeys).toContain('nested')
  })

  it('rejects missing card metadata fields', () => {
    for (const field of ['description', 'version_label', 'change_summary', 'agent_type_name', 'agent_type_key', 'created_by', 'published_at', 'updated_at', 'unavailable_reason'] as const) {
      expect(() => parseAgentProfile(without(profile, field))).toThrow(new RegExp(field, 'u'))
    }
  })

  it('still rejects non-published versions', () => {
    expect(() => parseAgentProfile({ ...profile, status: 'draft' })).toThrow(/non-published/u)
  })
})

describe('run parsing carries the immutable policy snapshot', () => {
  it('parses the execution policy snapshot', () => {
    expect(parseRun(run).executionPolicy).toMatchObject({ permission_mode: 'approval', write_mode: 'write' })
  })

  it('rejects a missing execution policy instead of assuming one', () => {
    expect(() => parseRun(without(run, 'execution_policy'))).toThrow(/execution_policy/u)
  })

  it('rejects an unknown policy write_mode', () => {
    expect(() => parseRun({ ...run, execution_policy: { write_mode: 'append' } })).toThrow(/write_mode/u)
  })
})
