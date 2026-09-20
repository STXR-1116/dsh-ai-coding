import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { TeamSkillInstallationStore } from '../src/installation-store.ts'
import type { TeamSkillInstallationRecord } from '../src/types.ts'

function record(id: string, overrides: Partial<TeamSkillInstallationRecord> = {}): TeamSkillInstallationRecord {
  return {
    localInstallationId: id,
    skillId: `skill-${id}`,
    projectId: 'project-alpha',
    scope: 'global',
    installed: {
      runtimeName: `runtime-${id}`,
      version: '1.0.0',
      artifactSha256: `sha-${id}`,
      directory: `/tmp/${id}`,
      files: [],
      state: 'normal',
    },
    installedAt: '2026-09-04T00:00:00.000Z',
    ...overrides,
  }
}

describe('TeamSkillInstallationStore', () => {
  it('serializes concurrent upserts so no installation record is lost', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-installation-store-'))
    try {
      const first = new TeamSkillInstallationStore(root)
      const second = new TeamSkillInstallationStore(root)
      await Promise.all([first.upsert(record('one')), second.upsert(record('two'))])
      await expect(first.list()).resolves.toEqual(expect.arrayContaining([record('one'), record('two')]))
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('serializes concurrent remove and upsert against the same file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-installation-store-'))
    try {
      const first = new TeamSkillInstallationStore(root)
      const second = new TeamSkillInstallationStore(root)
      await first.upsert(record('keep'))
      await Promise.all([first.remove('keep'), second.upsert(record('new'))])
      await expect(first.list()).resolves.toEqual([record('new')])
      await expect(readFile(join(root, 'team-skill-installations.json'), 'utf8')).resolves.toContain('skill-new')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('keeps one record per project for the same skill under the same global scope', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-installation-store-'))
    try {
      const store = new TeamSkillInstallationStore(root)
      await store.upsert(record('alpha', { skillId: 'skill-shared', projectId: 'project-alpha' }))
      await store.upsert(record('beta', { skillId: 'skill-shared', projectId: 'project-beta' }))
      const records = await store.list()
      expect(records.map(value => value.projectId).sort()).toEqual(['project-alpha', 'project-beta'])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('keeps one record per project for the same skill, scope and workspace', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-installation-store-'))
    try {
      const store = new TeamSkillInstallationStore(root)
      await store.upsert(
        record('alpha', {
          skillId: 'skill-shared',
          projectId: 'project-alpha',
          scope: 'project',
          workspaceId: 'workspace-1',
        }),
      )
      await store.upsert(
        record('beta', {
          skillId: 'skill-shared',
          projectId: 'project-beta',
          scope: 'project',
          workspaceId: 'workspace-1',
        }),
      )
      const records = await store.list()
      expect(records.map(value => value.projectId).sort()).toEqual(['project-alpha', 'project-beta'])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('returns no records when the state file does not exist yet', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-installation-store-'))
    try {
      const store = new TeamSkillInstallationStore(root)
      await expect(store.list()).resolves.toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects state files that are not valid JSON', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-installation-store-'))
    try {
      const { writeFile } = await import('node:fs/promises')
      await writeFile(join(root, 'team-skill-installations.json'), 'not-json{', 'utf8')
      const store = new TeamSkillInstallationStore(root)
      await expect(store.list()).rejects.toThrow('not valid JSON')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects state files whose top-level shape is not a record list', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-installation-store-'))
    try {
      const { writeFile } = await import('node:fs/promises')
      await writeFile(join(root, 'team-skill-installations.json'), JSON.stringify({ records: 'nope' }), 'utf8')
      const store = new TeamSkillInstallationStore(root)
      await expect(store.list()).rejects.toThrow('invalid record format')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects records with invalid strings, scopes, states and project scope without workspace', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-installation-store-'))
    try {
      const { writeFile } = await import('node:fs/promises')
      const store = new TeamSkillInstallationStore(root)
      const valid = record('ok')
      const cases: unknown[] = [
        { records: [{ ...valid, localInstallationId: '' }] },
        { records: [{ ...valid, skillId: 42 }] },
        { records: [{ ...valid, scope: 'region' }] },
        { records: [{ ...valid, installed: { ...valid.installed, state: 'vanished' } }] },
        { records: [{ ...valid, scope: 'project' }] },
        { records: [{ ...valid, installed: { ...valid.installed, files: [{ path: 'a', sha256: '' }] } }] },
        { records: [{ ...valid, installed: { ...valid.installed, files: ['not-an-object'] } }] },
        { records: [{ ...valid, installed: { ...valid.installed, files: 'not-an-array' } }] },
        { records: ['not-an-object'] },
        { records: [{ ...valid, installed: undefined }] },
        { records: [{ ...valid, installed: { ...valid.installed, runtimeName: null } }] },
      ]
      for (const [index, payload] of cases.entries()) {
        await writeFile(join(root, 'team-skill-installations.json'), JSON.stringify(payload), 'utf8')
        await expect(store.list(), `case ${String(index)} must be rejected`).rejects.toThrow()
      }
      await writeFile(join(root, 'team-skill-installations.json'), JSON.stringify({ records: [{ ...valid, scope: 'project', workspaceId: 'ws-1' }] }), 'utf8')
      await expect(store.list()).resolves.toHaveLength(1)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('cleans the temporary file and rethrows when the destination cannot be replaced', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-installation-store-'))
    try {
      // 目标状态路径被目录占用：rename 必然失败（POSIX EISDIR / Windows EPERM），
      // write 的 catch 必须清掉临时文件后原样抛出。
      await mkdir(join(root, 'team-skill-installations.json'), { recursive: true })
      const store = new TeamSkillInstallationStore(root)
      await expect(store.upsert(record('blocked'))).rejects.toThrow()
      const leftovers = await readdir(root)
      expect(leftovers.filter(name => name.includes('.writing-'))).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('replaces only the same project record when that project reinstalls the same scope', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-installation-store-'))
    try {
      const store = new TeamSkillInstallationStore(root)
      await store.upsert(record('alpha-old', { skillId: 'skill-shared', projectId: 'project-alpha' }))
      await store.upsert(record('beta', { skillId: 'skill-shared', projectId: 'project-beta' }))
      await store.upsert(record('alpha-new', { skillId: 'skill-shared', projectId: 'project-alpha' }))
      const records = await store.list()
      expect(records).toHaveLength(2)
      expect(records.map(value => value.localInstallationId).sort()).toEqual(['alpha-new', 'beta'])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
