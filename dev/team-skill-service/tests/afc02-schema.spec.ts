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

function sessionHeaders(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` }
}

describe('AFC-02 user-side agent type schema', () => {
  it('serves the full schema to an authenticated member and rejects outsiders/unknown types', async () => {
    const service = createTeamSkillService({ port: 0 })
    services.push(service)
    await service.listen()
    const port = (service.server.address() as AddressInfo).port

    const memberUrl = `http://127.0.0.1:${port}/v1/me/agent-types/at-claude-code/schema`
    const member = await fetch(memberUrl, { headers: sessionHeaders('demo-token') })
    expect(member.status).toBe(200)
    expect(member.headers.get('x-fixture-only')).toBe('true')
    type SchemaFieldWire = {
      key: string
      label: string
      type: string
      required: boolean
      affects_publish: boolean
      enum?: string[]
      min?: number
      max?: number
      default?: unknown
    }
    const schema = (await bodyOf(member)) as {
      agent_type_id: string
      key: string
      credential_required: boolean
      schema_version: string
      schema: SchemaFieldWire[]
    }
    expect(schema).toMatchObject({ agent_type_id: 'at-claude-code', key: 'claude_code', credential_required: true, schema_version: '1' })
    const permission = schema.schema.find(field => field.key === 'permission_mode')
    expect(permission).toMatchObject({ type: 'enum', required: true, affects_publish: true })
    expect(permission?.enum).toContain('approval')

    const outsider = await fetch(`http://127.0.0.1:${port}/v1/me/agent-types/at-claude-code/schema`, { headers: sessionHeaders('outsider-token') })
    expect(outsider.status).toBe(403)
    expect(await outsider.json()).toMatchObject({ code: 'FORBIDDEN', data: null })

    const unknown = await fetch(`http://127.0.0.1:${port}/v1/me/agent-types/at-nope/schema`, { headers: sessionHeaders('demo-token') })
    expect(unknown.status).toBe(404)
    expect(await unknown.json()).toMatchObject({ code: 'RESOURCE_NOT_FOUND', data: null })

    const unauth = await fetch(`http://127.0.0.1:${port}/v1/me/agent-types/at-claude-code/schema`)
    expect(unauth.status).toBe(401)
  })
})
