import { afterEach, describe, expect, it } from 'vitest'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createTeamSkillService } from '../src/server.ts'
import { bodyOf } from './response.ts'

const services: Array<{ readonly server: Server }> = []

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

interface ServiceHandle {
  readonly port: number
  readonly token: string
}

async function start(seed = true): Promise<ServiceHandle> {
  const service = createTeamSkillService({ port: 0, seed })
  services.push(service)
  await service.listen()
  const port = (service.server.address() as AddressInfo).port
  const login = await fetch(`http://127.0.0.1:${port}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin@example.com', password: 'admin-pass' }),
  })
  const token = ((await bodyOf(login)) as { access_token: string }).access_token
  return { port, token }
}

function jsonHeaders(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
}

async function post(handle: ServiceHandle, path: string, body: unknown, idempotencyKey?: string): Promise<Response> {
  return fetch(`http://127.0.0.1:${handle.port}/v1${path}`, {
    method: 'POST',
    headers: {
      ...jsonHeaders(handle.token),
      ...(idempotencyKey === undefined ? {} : { 'idempotency-key': idempotencyKey }),
    },
    body: JSON.stringify(body),
  })
}

describe('request validation errors', () => {
  it('maps missing account and session fields to a stable 422 envelope instead of 500', async () => {
    const handle = await start()
    const missingUsername = await post(handle, '/auth/login', { password: 'admin-pass' })
    expect(missingUsername.status).toBe(422)
    expect(await bodyOf(missingUsername)).toMatchObject({ code: 'VALIDATION_REQUIRED' })
    const typedUsername = await post(handle, '/auth/login', { username: 42, password: 'admin-pass' })
    expect(typedUsername.status).toBe(422)
    expect(await bodyOf(typedUsername)).toMatchObject({ code: 'VALIDATION_ERROR' })
    const emptyPassword = await post(handle, '/auth/login', { username: 'admin@example.com', password: '' })
    expect(emptyPassword.status).toBe(422)
    expect(await bodyOf(emptyPassword)).toMatchObject({ code: 'VALIDATION_REQUIRED' })

    const missingCurrent = await post(handle, '/auth/change-password', { new_password: 'replacement-password' }, 'change-1')
    expect(missingCurrent.status).toBe(422)
    expect(await bodyOf(missingCurrent)).toMatchObject({ code: 'VALIDATION_REQUIRED' })
  })

  it('maps missing account creation and membership fields to stable 422 envelopes', async () => {
    const handle = await start()
    const missingName = await post(
      handle,
      '/admin/users',
      {
        username: 'someone@example.com',
        organization_ids: ['org-alpha'],
        global_role: 'member',
      },
      'user-missing-name',
    )
    expect(missingName.status).toBe(422)
    expect(await bodyOf(missingName)).toMatchObject({ code: 'VALIDATION_REQUIRED' })
    const typedRole = await post(
      handle,
      '/admin/users',
      {
        username: 'someone@example.com',
        display_name: 'Someone',
        organization_ids: ['org-alpha'],
        global_role: 'owner',
      },
      'user-typed-role',
    )
    expect(typedRole.status).toBe(422)
    expect(await bodyOf(typedRole)).toMatchObject({ code: 'VALIDATION_ERROR' })
    const missingAssetId = await post(
      handle,
      '/admin/projects/project-alpha/assets',
      {
        asset_type: 'skill',
        relation_kind: 'reference',
      },
      'asset-missing-id',
    )
    expect(missingAssetId.status).toBe(422)
    expect(await bodyOf(missingAssetId)).toMatchObject({ code: 'VALIDATION_REQUIRED' })
  })

  it('maps missing project creation fields to a stable 422 envelope', async () => {
    const handle = await start()
    const missingName = await post(handle, '/admin/projects', { organization_id: 'org-alpha' }, 'project-missing-name')
    expect(missingName.status).toBe(422)
    expect(await bodyOf(missingName)).toMatchObject({ code: 'VALIDATION_REQUIRED' })
    const typedName = await post(handle, '/admin/projects', { organization_id: 'org-alpha', name: 7 }, 'project-typed-name')
    expect(typedName.status).toBe(422)
    expect(await bodyOf(typedName)).toMatchObject({ code: 'VALIDATION_ERROR' })
  })

  it('maps missing Skill creation and installation fields to stable 422 envelopes', async () => {
    const handle = await start()
    const missingSummary = await post(
      handle,
      '/admin/team-skills',
      { display_name: '缺少摘要的技能', organization_id: 'org-alpha' },
      'skill-missing-summary',
    )
    expect(missingSummary.status).toBe(422)
    expect(await bodyOf(missingSummary)).toMatchObject({ code: 'VALIDATION_REQUIRED' })

    const missingSkillId = await post(handle, '/team-skill-installations', {
      version: '1.0.0',
      project_id: 'project-alpha',
      scope: 'global',
    })
    expect(missingSkillId.status).toBe(422)
    expect(await bodyOf(missingSkillId)).toMatchObject({ code: 'VALIDATION_REQUIRED' })
    const typedVersion = await post(handle, '/team-skill-installations', {
      skill_id: 'code-review',
      version: { major: 1 },
      project_id: 'project-alpha',
      scope: 'global',
    })
    expect(typedVersion.status).toBe(422)
    expect(await bodyOf(typedVersion)).toMatchObject({ code: 'VALIDATION_ERROR' })
    const invalidScope = await post(
      handle,
      '/team-skill-installations',
      { skill_id: 'code-review', version: '1.0.0', project_id: 'project-alpha', scope: 'workspace' },
      'install-invalid-scope',
    )
    expect(invalidScope.status).toBe(422)
    expect(await bodyOf(invalidScope)).toMatchObject({ code: 'VALIDATION_REQUIRED' })
  })

  it('keeps the existing idempotency and revision check order while stabilizing field errors', async () => {
    const handle = await start()
    // Skill creation validates the Idempotency-Key before the body fields.
    const noKey = await fetch(`http://127.0.0.1:${handle.port}/v1/admin/team-skills`, {
      method: 'POST',
      headers: jsonHeaders(handle.token),
      body: JSON.stringify({ display_name: '无幂等键' }),
    })
    expect(noKey.status).toBe(400)
    expect(await bodyOf(noKey)).toMatchObject({ code: 'IDEMPOTENCY_KEY_REQUIRED' })

    // Installation parses body fields before requiring the Idempotency-Key.
    const missingFieldNoKey = await fetch(`http://127.0.0.1:${handle.port}/v1/team-skill-installations`, {
      method: 'POST',
      headers: jsonHeaders(handle.token),
      body: JSON.stringify({ version: '1.0.0', project_id: 'project-alpha', scope: 'global' }),
    })
    expect(missingFieldNoKey.status).toBe(422)
    expect(await bodyOf(missingFieldNoKey)).toMatchObject({ code: 'VALIDATION_REQUIRED' })
  })

  it('still rejects malformed JSON bodies with the stable 400 envelope', async () => {
    const handle = await start()
    const response = await fetch(`http://127.0.0.1:${handle.port}/v1/auth/login`, {
      method: 'POST',
      headers: jsonHeaders(handle.token),
      body: '{not-json',
    })
    expect(response.status).toBe(400)
    expect(await bodyOf(response)).toMatchObject({ code: 'INVALID_JSON' })
  })
})
