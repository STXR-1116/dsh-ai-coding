import { strToU8, zipSync } from 'fflate'
import { afterEach, describe, expect, it } from 'vitest'
import type { AddressInfo } from 'node:net'
import { createTeamSkillService } from '../src/server.ts'
import { bodyOf } from './response.ts'

const services: ReturnType<typeof createTeamSkillService>[] = []
let nextKey = 1
let nextPortLabel = 0

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

function apiHeaders(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
}

function uniqueKey(prefix: string): string {
  return `${prefix}-${nextKey++}-${nextPortLabel}`
}

async function loginAs(port: number, username: string, password: string): Promise<string> {
  const response = await fetch(`http://127.0.0.1:${port}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  })
  expect(response.status).toBe(200)
  return ((await bodyOf(response)) as { access_token: string }).access_token
}

interface StartedService {
  readonly port: number
  readonly service: ReturnType<typeof createTeamSkillService>
}

/** Start one fixture service on a dynamic port with the Skill seed disabled. */
async function startService(): Promise<StartedService> {
  nextPortLabel += 1
  const service = createTeamSkillService({ port: 0, seed: false })
  services.push(service)
  await service.listen()
  const address = service.server.address() as AddressInfo
  return { port: address.port, service }
}

async function projectRevision(port: number, token: string, projectId: string): Promise<number> {
  const response = await fetch(`http://127.0.0.1:${port}/v1/admin/projects/${projectId}`, {
    headers: apiHeaders(token),
  })
  expect(response.status).toBe(200)
  return ((await bodyOf(response)) as { revision: number }).revision
}

/** Draft lifecycle helper: create → version → artifact; leaves the version in `draft`. */
async function createDraftSkill(
  port: number,
  adminToken: string,
  input: { readonly name: string; readonly summary: string },
): Promise<{ readonly skillId: string; readonly version: string; readonly skillRevision: number; readonly versionRevision: number }> {
  const created = await fetch(`http://127.0.0.1:${port}/v1/admin/team-skills`, {
    method: 'POST',
    headers: { ...apiHeaders(adminToken), 'idempotency-key': uniqueKey('create') },
    body: JSON.stringify({
      display_name: input.name,
      summary: input.summary,
      visibility: 'organization',
      organization_id: 'org-alpha',
    }),
  })
  expect(created.status).toBe(201)
  const skill = (await bodyOf(created)) as { skillId: string; revision: number }
  const versioned = await fetch(`http://127.0.0.1:${port}/v1/admin/team-skills/${skill.skillId}/versions`, {
    method: 'POST',
    headers: {
      ...apiHeaders(adminToken),
      'if-match': String(skill.revision),
      'x-skill-revision': String(skill.revision),
      'idempotency-key': uniqueKey('version'),
    },
    body: JSON.stringify({ version: '1.0.0', release_notes: '测试版本' }),
  })
  expect(versioned.status).toBe(201)
  const version = (await bodyOf(versioned)) as { version: { revision: number }; skill: { revision: number } }
  const artifact = zipSync({
    'SKILL.md': strToU8(`---\nname: aicp-${skill.skillId}\ndescription: ${input.summary}\n---\n\n# ${input.name}\n`),
  })
  const uploaded = await fetch(`http://127.0.0.1:${port}/v1/admin/team-skills/${skill.skillId}/versions/1.0.0/artifact`, {
    method: 'PUT',
    headers: {
      ...apiHeaders(adminToken),
      'if-match': String(version.version.revision),
      'x-skill-revision': String(version.skill.revision),
      'idempotency-key': uniqueKey('artifact'),
      'content-type': 'application/zip',
    },
    body: new Uint8Array(artifact),
  })
  expect(uploaded.status).toBe(200)
  const uploadedBody = (await bodyOf(uploaded)) as { version: { revision: number }; skill: { revision: number } }
  return {
    skillId: skill.skillId,
    version: '1.0.0',
    skillRevision: uploadedBody.skill.revision,
    versionRevision: uploadedBody.version.revision,
  }
}

async function submitForReview(
  port: number,
  adminToken: string,
  skillId: string,
  revisions: { readonly skillRevision: number; readonly versionRevision: number },
): Promise<{ readonly skillRevision: number; readonly versionRevision: number }> {
  const submitted = await fetch(`http://127.0.0.1:${port}/v1/admin/team-skills/${skillId}/versions/1.0.0/submit-review`, {
    method: 'POST',
    headers: {
      ...apiHeaders(adminToken),
      'if-match': String(revisions.versionRevision),
      'x-skill-revision': String(revisions.skillRevision),
      'idempotency-key': uniqueKey('submit'),
    },
    body: '{}',
  })
  expect(submitted.status).toBe(200)
  const submittedBody = (await bodyOf(submitted)) as { version: { revision: number }; skill: { revision: number } }
  return { skillRevision: submittedBody.skill.revision, versionRevision: submittedBody.version.revision }
}

async function approveVersion(
  port: number,
  adminToken: string,
  skillId: string,
  revisions: { readonly skillRevision: number; readonly versionRevision: number },
): Promise<{ readonly skillRevision: number; readonly versionRevision: number }> {
  const approved = await fetch(`http://127.0.0.1:${port}/v1/admin/team-skills/${skillId}/versions/1.0.0/approve`, {
    method: 'POST',
    headers: {
      ...apiHeaders(adminToken),
      'if-match': String(revisions.versionRevision),
      'x-skill-revision': String(revisions.skillRevision),
      'idempotency-key': uniqueKey('approve'),
    },
    body: JSON.stringify({ checks: { 'check-1': 'pass', 'check-2': 'pass', 'check-3': 'pass' } }),
  })
  expect(approved.status).toBe(200)
  const approvedBody = (await bodyOf(approved)) as { version: { revision: number }; skill: { revision: number } }
  return { skillRevision: approvedBody.skill.revision, versionRevision: approvedBody.version.revision }
}

async function publishVersion(
  port: number,
  adminToken: string,
  skillId: string,
  revisions: { readonly skillRevision: number; readonly versionRevision: number },
): Promise<{ readonly skillRevision: number; readonly versionRevision: number }> {
  const published = await fetch(`http://127.0.0.1:${port}/v1/admin/team-skills/${skillId}/versions/1.0.0/publish`, {
    method: 'POST',
    headers: {
      ...apiHeaders(adminToken),
      'if-match': String(revisions.versionRevision),
      'x-skill-revision': String(revisions.skillRevision),
      'idempotency-key': uniqueKey('publish'),
    },
    body: '{}',
  })
  expect(published.status).toBe(200)
  const publishedBody = (await bodyOf(published)) as { version: { revision: number }; skill: { revision: number } }
  return { skillRevision: publishedBody.skill.revision, versionRevision: publishedBody.version.revision }
}

async function bindSkillAsset(port: number, adminToken: string, projectId: string, skillId: string): Promise<void> {
  const revision = await projectRevision(port, adminToken, projectId)
  const bound = await fetch(`http://127.0.0.1:${port}/v1/admin/projects/${projectId}/assets`, {
    method: 'POST',
    headers: {
      ...apiHeaders(adminToken),
      'if-match': String(revision),
      'idempotency-key': uniqueKey('bind'),
    },
    body: JSON.stringify({ asset_type: 'skill', asset_id: skillId, relation_kind: 'reference' }),
  })
  expect(bound.status).toBe(201)
}

/** Push the current Skill/version into the requested lifecycle status. */
async function moveSkillToStatus(
  port: number,
  adminToken: string,
  skillId: string,
  status: 'draft' | 'pending_review' | 'approved' | 'withdrawn',
  current: { readonly skillRevision: number; readonly versionRevision: number; readonly version: string },
): Promise<void> {
  let revisions = { skillRevision: current.skillRevision, versionRevision: current.versionRevision }
  if (status === 'pending_review') {
    revisions = await submitForReview(port, adminToken, skillId, revisions)
    return
  }
  if (status === 'approved') {
    revisions = await submitForReview(port, adminToken, skillId, revisions)
    await approveVersion(port, adminToken, skillId, revisions)
    return
  }
  if (status === 'withdrawn') {
    revisions = await submitForReview(port, adminToken, skillId, revisions)
    revisions = await approveVersion(port, adminToken, skillId, revisions)
    revisions = await publishVersion(port, adminToken, skillId, revisions)
    const withdrawn = await fetch(`http://127.0.0.1:${port}/v1/admin/team-skills/${skillId}/versions/1.0.0/withdraw`, {
      method: 'POST',
      headers: {
        ...apiHeaders(adminToken),
        'if-match': String(revisions.versionRevision),
        'x-skill-revision': String(revisions.skillRevision),
        'idempotency-key': uniqueKey('withdraw'),
      },
      body: JSON.stringify({ reason: '二次复核下线验证' }),
    })
    expect(withdrawn.status).toBe(200)
    return
  }
}

async function installSkill(
  port: number,
  token: string,
  input: { readonly skillId: string; readonly version: string; readonly projectId: string },
): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/v1/team-skill-installations`, {
    method: 'POST',
    headers: { ...apiHeaders(token), 'idempotency-key': uniqueKey('install') },
    body: JSON.stringify({
      skill_id: input.skillId,
      version: input.version,
      project_id: input.projectId,
      scope: 'global',
      local_installation_id: uniqueKey('local'),
      environment: { dsh_version: '0.1.1', available_tools: [], available_mcp_servers: [], present_environment_variable_names: [] },
    }),
  })
}

const NON_PUBLISHED_STATUSES = ['draft', 'pending_review', 'approved', 'withdrawn'] as const

describe('unpublished bound skills are invisible to regular users (P0-R06/R07/R08)', () => {
  for (const status of NON_PUBLISHED_STATUSES) {
    it(`keeps a bound ${status} skill out of the member catalog, detail, release-status and installation`, async () => {
      const { port } = await startService()
      const admin = await loginAs(port, 'admin@example.com', 'admin-pass')
      const member = await loginAs(port, 'member@example.com', 'member-pass')

      const draft = await createDraftSkill(port, admin, { name: `未发布技能-${status}`, summary: '已绑定未发布技能' })
      await moveSkillToStatus(port, admin, draft.skillId, status, {
        skillRevision: draft.skillRevision,
        versionRevision: draft.versionRevision,
        version: draft.version,
      })
      await bindSkillAsset(port, admin, 'project-alpha', draft.skillId)

      const catalog = await fetch(`http://127.0.0.1:${port}/v1/team-skills?project_id=project-alpha`, {
        headers: apiHeaders(member),
      })
      expect(catalog.status).toBe(200)
      expect(
        ((await bodyOf(catalog)) as { items: Array<{ skill_id: string }> }).items.map(item => item.skill_id),
      ).not.toContain(draft.skillId)

      const detail = await fetch(`http://127.0.0.1:${port}/v1/team-skills/${draft.skillId}?project_id=project-alpha`, {
        headers: apiHeaders(member),
      })
      expect(detail.status).toBe(404)
      const detailText = JSON.stringify(await bodyOf(detail))
      expect(detailText).not.toContain(draft.skillId)
      expect(detailText).not.toContain(inputSummaryOf(status))

      const releaseStatus = await fetch(`http://127.0.0.1:${port}/v1/team-skills/release-status`, {
        method: 'POST',
        headers: apiHeaders(member),
        body: JSON.stringify({
          items: [{ skill_id: draft.skillId, version: draft.version, project_id: 'project-alpha' }],
        }),
      })
      expect(releaseStatus.status).toBe(200)
      const releaseBody = (await bodyOf(releaseStatus)) as { items: Array<Record<string, unknown>> }
      expect(releaseBody.items.map(item => item.skill_id)).not.toContain(draft.skillId)
      expect(JSON.stringify(releaseBody)).not.toContain(draft.skillId)

      const install = await installSkill(port, member, {
        skillId: draft.skillId,
        version: draft.version,
        projectId: 'project-alpha',
      })
      expect([403, 404, 409]).toContain(install.status)
      const installText = JSON.stringify(await bodyOf(install))
      expect(installText).not.toContain('download_url')
    })
  }

  it('rejects a member release-status query after a published version is withdrawn and hides the withdrawn record', async () => {
    const { port } = await startService()
    const admin = await loginAs(port, 'admin@example.com', 'admin-pass')
    const member = await loginAs(port, 'member@example.com', 'member-pass')
    const published = await createDraftSkill(port, admin, { name: '先发布后下线', summary: '下线后状态查询' })
    const revisions = await submitForReview(port, admin, published.skillId, {
      skillRevision: published.skillRevision,
      versionRevision: published.versionRevision,
    })
    const approved = await approveVersion(port, admin, published.skillId, revisions)
    await publishVersion(port, admin, published.skillId, approved)
    await bindSkillAsset(port, admin, 'project-alpha', published.skillId)

    const before = await fetch(`http://127.0.0.1:${port}/v1/team-skills/release-status`, {
      method: 'POST',
      headers: apiHeaders(member),
      body: JSON.stringify({
        items: [{ skill_id: published.skillId, version: '1.0.0', project_id: 'project-alpha' }],
      }),
    })
    expect(before.status).toBe(200)
    expect(
      ((await bodyOf(before)) as { items: Array<{ skill_id: string; status: string }> }).items,
    ).toEqual([{ skill_id: published.skillId, version: '1.0.0', project_id: 'project-alpha', status: 'published' }])

    // Withdraw the published version; the member must get an empty result, not a forged withdrawn record.
    await withdrawPublishedVersion(port, admin, published.skillId)
    const after = await fetch(`http://127.0.0.1:${port}/v1/team-skills/release-status`, {
      method: 'POST',
      headers: apiHeaders(member),
      body: JSON.stringify({
        items: [{ skill_id: published.skillId, version: '1.0.0', project_id: 'project-alpha' }],
      }),
    })
    expect(after.status).toBe(200)
    const afterBody = (await bodyOf(after)) as { items: Array<Record<string, unknown>> }
    expect(JSON.stringify(afterBody)).not.toContain(published.skillId)
    expect(afterBody.items).toEqual([])

    const detail = await fetch(`http://127.0.0.1:${port}/v1/team-skills/${published.skillId}?project_id=project-alpha`, {
      headers: apiHeaders(member),
    })
    expect(detail.status).toBe(404)
  })

  it('fails an existing download operation after the installed version is withdrawn or unbound (P0-R08)', async () => {
    const { port } = await startService()
    const admin = await loginAs(port, 'admin@example.com', 'admin-pass')
    const member = await loginAs(port, 'member@example.com', 'member-pass')
    const published = await createDraftSkill(port, admin, { name: '下线后下载失效', summary: '既有下载地址撤销' })
    const revisions = await submitForReview(port, admin, published.skillId, {
      skillRevision: published.skillRevision,
      versionRevision: published.versionRevision,
    })
    const approved = await approveVersion(port, admin, published.skillId, revisions)
    await publishVersion(port, admin, published.skillId, approved)
    await bindSkillAsset(port, admin, 'project-alpha', published.skillId)

    const installed = await installSkill(port, member, {
      skillId: published.skillId,
      version: '1.0.0',
      projectId: 'project-alpha',
    })
    expect(installed.status).toBe(201)
    const operation = (await bodyOf(installed)) as { operation_id: string; artifact: { download_url: string } }

    // Baseline: the freshly authorized download serves the artifact.
    const beforeWithdraw = await fetch(operation.artifact.download_url, { headers: apiHeaders(member) })
    expect(beforeWithdraw.status).toBe(200)

    await withdrawPublishedVersion(port, admin, published.skillId)
    const afterWithdraw = await fetch(operation.artifact.download_url, { headers: apiHeaders(member) })
    expect(afterWithdraw.status).toBe(403)
    expect(await bodyOf(afterWithdraw)).toMatchObject({ code: 'INSTALL_AUTHORIZATION_REVOKED' })

    // Re-publish is not enough while the version stays withdrawn; unbinding also revokes.
    await bindSkillAssetRemoval(port, admin, 'project-alpha', published.skillId)
    const afterUnbind = await fetch(operation.artifact.download_url, { headers: apiHeaders(member) })
    expect(afterUnbind.status).toBe(403)
    expect(await bodyOf(afterUnbind)).toMatchObject({ code: 'INSTALL_AUTHORIZATION_REVOKED' })
  })

  it('fails an existing download operation after the skill version moves back to draft', async () => {
    const { port } = await startService()
    const admin = await loginAs(port, 'admin@example.com', 'admin-pass')
    const member = await loginAs(port, 'member@example.com', 'member-pass')
    const published = await createDraftSkill(port, admin, { name: '回退草稿下载失效', summary: '版本回到 draft' })
    const revisions = await submitForReview(port, admin, published.skillId, {
      skillRevision: published.skillRevision,
      versionRevision: published.versionRevision,
    })
    const approved = await approveVersion(port, admin, published.skillId, revisions)
    const publishedRevisions = await publishVersion(port, admin, published.skillId, approved)
    await bindSkillAsset(port, admin, 'project-alpha', published.skillId)

    const installed = await installSkill(port, member, {
      skillId: published.skillId,
      version: '1.0.0',
      projectId: 'project-alpha',
    })
    expect(installed.status).toBe(201)
    const operation = (await bodyOf(installed)) as { artifact: { download_url: string } }

    // A new draft version turns the Skill (and its released record) back to draft.
    const versioned = await fetch(`http://127.0.0.1:${port}/v1/admin/team-skills/${published.skillId}/versions`, {
      method: 'POST',
      headers: {
        ...apiHeaders(admin),
        'if-match': String(publishedRevisions.skillRevision),
        'x-skill-revision': String(publishedRevisions.skillRevision),
        'idempotency-key': uniqueKey('version2'),
      },
      body: JSON.stringify({ version: '1.1.0', release_notes: '新草稿版本' }),
    })
    expect(versioned.status).toBe(201)

    const afterDraft = await fetch(operation.artifact.download_url, { headers: apiHeaders(member) })
    expect(afterDraft.status).toBe(403)
    expect(await bodyOf(afterDraft)).toMatchObject({ code: 'INSTALL_AUTHORIZATION_REVOKED' })
  })

  it('rejects installation of the old published version after a new draft version turns the skill back to draft (P0-R10)', async () => {
    const { port } = await startService()
    const admin = await loginAs(port, 'admin@example.com', 'admin-pass')
    const member = await loginAs(port, 'member@example.com', 'member-pass')
    const published = await createDraftSkill(port, admin, { name: '新草稿后旧版本安装', summary: '版本级检查不是 Skill 级授权' })
    const revisions = await submitForReview(port, admin, published.skillId, {
      skillRevision: published.skillRevision,
      versionRevision: published.versionRevision,
    })
    const approved = await approveVersion(port, admin, published.skillId, revisions)
    const publishedRevisions = await publishVersion(port, admin, published.skillId, approved)
    await bindSkillAsset(port, admin, 'project-alpha', published.skillId)

    // Baseline: the current published version installs while the Skill is published.
    const before = await installSkill(port, member, {
      skillId: published.skillId,
      version: '1.0.0',
      projectId: 'project-alpha',
    })
    expect(before.status).toBe(201)

    // Adding a draft version flips the Skill back to draft; the old published
    // version record alone must not authorize new installations.
    const versioned = await fetch(`http://127.0.0.1:${port}/v1/admin/team-skills/${published.skillId}/versions`, {
      method: 'POST',
      headers: {
        ...apiHeaders(admin),
        'if-match': String(publishedRevisions.skillRevision),
        'x-skill-revision': String(publishedRevisions.skillRevision),
        'idempotency-key': uniqueKey('version-draft2'),
      },
      body: JSON.stringify({ version: '1.1.0', release_notes: '新草稿版本' }),
    })
    expect(versioned.status).toBe(201)

    const oldInstall = await installSkill(port, member, {
      skillId: published.skillId,
      version: '1.0.0',
      projectId: 'project-alpha',
    })
    expect([403, 404, 409]).toContain(oldInstall.status)
    expect(JSON.stringify(await bodyOf(oldInstall))).not.toContain('download_url')

    // The governance path still shows the skill so a manager can resume the flow.
    const managerDetail = await fetch(`http://127.0.0.1:${port}/v1/admin/team-skills/${published.skillId}`, {
      headers: apiHeaders(admin),
    })
    expect(managerDetail.status).toBe(200)
  })

  it('rejects installation of every old version while the skill sits in pending_review, approved or withdrawn (P0-R10)', async () => {
    const { port } = await startService()
    const admin = await loginAs(port, 'admin@example.com', 'admin-pass')
    const member = await loginAs(port, 'member@example.com', 'member-pass')
    const published = await createDraftSkill(port, admin, { name: '治理态旧版本安装', summary: '非 published Skill 的旧版本' })
    const revisions = await submitForReview(port, admin, published.skillId, {
      skillRevision: published.skillRevision,
      versionRevision: published.versionRevision,
    })
    const approved = await approveVersion(port, admin, published.skillId, revisions)
    await publishVersion(port, admin, published.skillId, approved)
    await bindSkillAsset(port, admin, 'project-alpha', published.skillId)

    for (const status of ['pending_review', 'approved', 'withdrawn'] as const) {
      // Push the published skill into the requested governance status through the
      // live revisions from the admin detail; 1.0.0 stays a published version record
      // for pending_review/approved, and becomes withdrawn for the last case.
      const detail = await fetch(`http://127.0.0.1:${port}/v1/admin/team-skills/${published.skillId}`, {
        headers: apiHeaders(admin),
      })
      const body = (await bodyOf(detail)) as {
        skill: { revision: number; status: string }
        versions: Array<{ version: string; status: string; revision: number }>
      }
      const release = body.versions.find(item => item.version === '1.0.0')
      expect(release).toBeDefined()
      if (status === 'pending_review') {
        const submitted = await fetch(
          `http://127.0.0.1:${port}/v1/admin/team-skills/${published.skillId}/versions/1.0.0/submit-review`,
          {
            method: 'POST',
            headers: {
              ...apiHeaders(admin),
              'if-match': String(release?.revision),
              'x-skill-revision': String(body.skill.revision),
              'idempotency-key': uniqueKey('re-submit'),
            },
            body: '{}',
          },
        )
        expect(submitted.status).toBe(200)
      } else if (status === 'approved') {
        const submitted = await fetch(
          `http://127.0.0.1:${port}/v1/admin/team-skills/${published.skillId}/versions/1.0.0/submit-review`,
          {
            method: 'POST',
            headers: {
              ...apiHeaders(admin),
              'if-match': String(release?.revision),
              'x-skill-revision': String(body.skill.revision),
              'idempotency-key': uniqueKey('re-submit2'),
            },
            body: '{}',
          },
        )
        expect(submitted.status).toBe(200)
        const detail2 = await fetch(`http://127.0.0.1:${port}/v1/admin/team-skills/${published.skillId}`, {
          headers: apiHeaders(admin),
        })
        const body2 = (await bodyOf(detail2)) as {
          skill: { revision: number }
          versions: Array<{ version: string; status: string; revision: number }>
        }
        const release2 = body2.versions.find(item => item.version === '1.0.0')
        const approvedResponse = await fetch(
          `http://127.0.0.1:${port}/v1/admin/team-skills/${published.skillId}/versions/1.0.0/approve`,
          {
            method: 'POST',
            headers: {
              ...apiHeaders(admin),
              'if-match': String(release2?.revision),
              'x-skill-revision': String(body2.skill.revision),
              'idempotency-key': uniqueKey('re-approve'),
            },
            body: JSON.stringify({ checks: { 'check-1': 'pass', 'check-2': 'pass', 'check-3': 'pass' } }),
          },
        )
        expect(approvedResponse.status).toBe(200)
      } else {
        const withdrawn = await fetch(
          `http://127.0.0.1:${port}/v1/admin/team-skills/${published.skillId}/versions/1.0.0/withdraw`,
          {
            method: 'POST',
            headers: {
              ...apiHeaders(admin),
              'if-match': String(release?.revision),
              'x-skill-revision': String(body.skill.revision),
              'idempotency-key': uniqueKey('re-withdraw'),
            },
            body: JSON.stringify({ reason: '二次复核 P0-R10' }),
          },
        )
        expect(withdrawn.status).toBe(200)
      }

      const install = await installSkill(port, member, {
        skillId: published.skillId,
        version: '1.0.0',
        projectId: 'project-alpha',
      })
      expect([403, 404, 409]).toContain(install.status)
      expect(JSON.stringify(await bodyOf(install))).not.toContain('download_url')
    }
  })

  it('keeps the old download revoked and old-version installs rejected across draft, pending_review and approved skill states (P1-R11)', async () => {
    const { port, service } = await startService()
    const admin = await loginAs(port, 'admin@example.com', 'admin-pass')
    const manager = await loginAs(port, 'manager@example.com', 'manager-pass')
    const member = await loginAs(port, 'member@example.com', 'member-pass')
    const published = await createDraftSkill(port, admin, { name: '状态组合回归', summary: 'P1-R11 下载与安装矩阵' })
    const revisions = await submitForReview(port, admin, published.skillId, {
      skillRevision: published.skillRevision,
      versionRevision: published.versionRevision,
    })
    const approved = await approveVersion(port, admin, published.skillId, revisions)
    const publishedRevisions = await publishVersion(port, admin, published.skillId, approved)
    await bindSkillAsset(port, admin, 'project-alpha', published.skillId)

    // published 正向基线：安装 201、下载为有效 ZIP 制品。
    const baselineInstall = await installSkill(port, member, {
      skillId: published.skillId,
      version: '1.0.0',
      projectId: 'project-alpha',
    })
    expect(baselineInstall.status).toBe(201)
    const operation = (await bodyOf(baselineInstall)) as { artifact: { download_url: string } }
    const baselineDownload = await fetch(operation.artifact.download_url, { headers: apiHeaders(member) })
    expect(baselineDownload.status).toBe(200)
    expect(baselineDownload.headers.get('content-type')).toBe('application/zip')
    expect((await baselineDownload.arrayBuffer()).byteLength).toBeGreaterThan(30)
    const operationsBefore = service.operations.size

    // 创建并上传 1.1.0：Skill 立即回到 draft，1.0.0 的版本记录仍是 published。
    const versioned = await fetch(`http://127.0.0.1:${port}/v1/admin/team-skills/${published.skillId}/versions`, {
      method: 'POST',
      headers: {
        ...apiHeaders(admin),
        'if-match': String(publishedRevisions.skillRevision),
        'x-skill-revision': String(publishedRevisions.skillRevision),
        'idempotency-key': uniqueKey('version-11'),
      },
      body: JSON.stringify({ version: '1.1.0', release_notes: 'P1-R11 新版本' }),
    })
    expect(versioned.status).toBe(201)
    const versionedBody = (await bodyOf(versioned)) as { version: { revision: number }; skill: { revision: number } }
    const artifact = zipSync({
      'SKILL.md': strToU8(`---
name: aicp-${published.skillId}
description: P1-R11 新版本
---

# 1.1.0
`),
    })
    const uploaded = await fetch(
      `http://127.0.0.1:${port}/v1/admin/team-skills/${published.skillId}/versions/1.1.0/artifact`,
      {
        method: 'PUT',
        headers: {
          ...apiHeaders(admin),
          'if-match': String(versionedBody.version.revision),
          'x-skill-revision': String(versionedBody.skill.revision),
          'idempotency-key': uniqueKey('artifact-11'),
          'content-type': 'application/zip',
        },
        body: new Uint8Array(artifact),
      },
    )
    expect(uploaded.status).toBe(200)
    const uploadedBody = (await bodyOf(uploaded)) as { version: { revision: number }; skill: { revision: number } }

    // draft（创建 1.1.0 后的初始治理状态）：断言状态组合、旧下载 403、旧安装 404。
    const assertState = async (
      skillStatus: string,
      newVersionStatus: string,
    ): Promise<void> => {
      const detail = await fetch(`http://127.0.0.1:${port}/v1/admin/team-skills/${published.skillId}`, {
        headers: apiHeaders(admin),
      })
      expect(detail.status).toBe(200)
      const body = (await bodyOf(detail)) as {
        skill: { status: string }
        versions: Array<{ version: string; status: string }>
      }
      expect(body.skill.status).toBe(skillStatus)
      expect(body.versions.find(item => item.version === '1.1.0')?.status).toBe(newVersionStatus)
      expect(body.versions.find(item => item.version === '1.0.0')?.status).toBe('published')
    }

    const assertOldDownloadRevoked = async (): Promise<void> => {
      const response = await fetch(operation.artifact.download_url, { headers: apiHeaders(member) })
      expect(response.status).toBe(403)
      expect(response.headers.get('content-type')).toContain('application/json')
      const raw = JSON.stringify(await response.json())
      expect(raw).toContain('INSTALL_AUTHORIZATION_REVOKED')
      expect(raw).toContain('"data":null')
      expect(response.headers.get('content-type')).not.toBe('application/zip')
    }

    const assertOldInstallRejected = async (): Promise<void> => {
      const install = await installSkill(port, member, {
        skillId: published.skillId,
        version: '1.0.0',
        projectId: 'project-alpha',
      })
      expect(install.status).toBe(404)
      const raw = JSON.stringify(await bodyOf(install))
      expect(raw).toContain('RESOURCE_NOT_FOUND')
      expect(raw).not.toContain('operation_id')
      expect(raw).not.toContain('download_url')
      expect(service.operations.size).toBe(operationsBefore)
    }

    await assertState('draft', 'draft')
    await assertOldDownloadRevoked()
    await assertOldInstallRejected()

    // pending_review：治理 HTTP 推进 1.1.0，旧 1.0.0 保持 published。
    const submitted = await fetch(
      `http://127.0.0.1:${port}/v1/admin/team-skills/${published.skillId}/versions/1.1.0/submit-review`,
      {
        method: 'POST',
        headers: {
          ...apiHeaders(admin),
          'if-match': String(uploadedBody.version.revision),
          'x-skill-revision': String(uploadedBody.skill.revision),
          'idempotency-key': uniqueKey('submit-11'),
        },
        body: '{}',
      },
    )
    expect(submitted.status).toBe(200)
    const submittedBody = (await bodyOf(submitted)) as { version: { revision: number }; skill: { revision: number } }
    await assertState('pending_review', 'pending_review')
    await assertOldDownloadRevoked()
    await assertOldInstallRejected()

    // approved：继续推进 1.1.0。
    const approvedNew = await fetch(
      `http://127.0.0.1:${port}/v1/admin/team-skills/${published.skillId}/versions/1.1.0/approve`,
      {
        method: 'POST',
        headers: {
          ...apiHeaders(admin),
          'if-match': String(submittedBody.version.revision),
          'x-skill-revision': String(submittedBody.skill.revision),
          'idempotency-key': uniqueKey('approve-11'),
        },
        body: JSON.stringify({ checks: { 'check-1': 'pass', 'check-2': 'pass', 'check-3': 'pass' } }),
      },
    )
    expect(approvedNew.status).toBe(200)
    await assertState('approved', 'approved')
    await assertOldDownloadRevoked()
    await assertOldInstallRejected()

    // 管理端（manager 与 admin）仍可读取治理详情并推进治理流程。
    const managerDetail = await fetch(`http://127.0.0.1:${port}/v1/admin/team-skills/${published.skillId}`, {
      headers: apiHeaders(manager),
    })
    expect(managerDetail.status).toBe(200)
  })

  it('keeps the published minimal user detail working while the manager reads governance detail', async () => {
    const { port } = await startService()
    const admin = await loginAs(port, 'admin@example.com', 'admin-pass')
    const manager = await loginAs(port, 'manager@example.com', 'manager-pass')
    const member = await loginAs(port, 'member@example.com', 'member-pass')
    const published = await createDraftSkill(port, admin, { name: '发布与管理读取', summary: '两条读取路径并存' })
    const revisions = await submitForReview(port, admin, published.skillId, {
      skillRevision: published.skillRevision,
      versionRevision: published.versionRevision,
    })
    const approved = await approveVersion(port, admin, published.skillId, revisions)
    await publishVersion(port, admin, published.skillId, approved)
    await bindSkillAsset(port, admin, 'project-alpha', published.skillId)

    const memberDetail = await fetch(
      `http://127.0.0.1:${port}/v1/team-skills/${published.skillId}?project_id=project-alpha`,
      { headers: apiHeaders(member) },
    )
    expect(memberDetail.status).toBe(200)
    const memberBody = (await bodyOf(memberDetail)) as { skill: Record<string, unknown> }
    expect(memberBody.skill).toMatchObject({ skillId: published.skillId, currentVersion: '1.0.0' })
    expect(Object.hasOwn(memberBody.skill, 'project_ids')).toBe(false)

    const managerDetail = await fetch(`http://127.0.0.1:${port}/v1/admin/team-skills/${published.skillId}`, {
      headers: apiHeaders(manager),
    })
    expect(managerDetail.status).toBe(200)
    const managerBody = (await bodyOf(managerDetail)) as { skill: { skillId: string; project_ids?: readonly string[] } }
    expect(managerBody.skill.skillId).toBe(published.skillId)
    expect(managerBody.skill.project_ids).toContain('project-alpha')

    const adminDetail = await fetch(`http://127.0.0.1:${port}/v1/admin/team-skills/${published.skillId}`, {
      headers: apiHeaders(admin),
    })
    expect(adminDetail.status).toBe(200)
  })
})

/** Withdraw the currently published 1.0.0 of a skill, reading live revisions from the admin detail. */
async function withdrawPublishedVersion(port: number, adminToken: string, skillId: string): Promise<void> {
  const detail = await fetch(`http://127.0.0.1:${port}/v1/admin/team-skills/${skillId}`, {
    headers: apiHeaders(adminToken),
  })
  expect(detail.status).toBe(200)
  const body = (await bodyOf(detail)) as {
    skill: { revision: number }
    versions: Array<{ version: string; status: string; revision: number }>
  }
  const release = body.versions.find(item => item.version === '1.0.0')
  expect(release?.status).toBe('published')
  const withdrawn = await fetch(`http://127.0.0.1:${port}/v1/admin/team-skills/${skillId}/versions/1.0.0/withdraw`, {
    method: 'POST',
    headers: {
      ...apiHeaders(adminToken),
      'if-match': String(release?.revision),
      'x-skill-revision': String(body.skill.revision),
      'idempotency-key': uniqueKey('withdraw-live'),
    },
    body: JSON.stringify({ reason: '二次复核下线验证' }),
  })
  expect(withdrawn.status).toBe(200)
}

/** Remove a skill asset relation from a project. */
async function bindSkillAssetRemoval(port: number, adminToken: string, projectId: string, skillId: string): Promise<void> {
  const relations = await fetch(`http://127.0.0.1:${port}/v1/admin/projects/${projectId}/assets`, {
    headers: apiHeaders(adminToken),
  })
  expect(relations.status).toBe(200)
  const items = ((await bodyOf(relations)) as { items: Array<{ asset_id: string; revision: number }> }).items
  const target = items.find(item => item.asset_id === skillId)
  expect(target).toBeDefined()
  const removed = await fetch(`http://127.0.0.1:${port}/v1/admin/projects/${projectId}/assets/skill/${skillId}`, {
    method: 'DELETE',
    headers: {
      ...apiHeaders(adminToken),
      'if-match': String(target?.revision),
      'idempotency-key': uniqueKey('unbind'),
    },
  })
  expect(removed.status).toBe(200)
}

function inputSummaryOf(_status: string): string {
  return '已绑定未发布技能'
}
