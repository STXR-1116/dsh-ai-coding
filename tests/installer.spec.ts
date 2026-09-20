import { createHash } from 'node:crypto'
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { strToU8, zipSync } from 'fflate'
import { afterEach, describe, expect, it } from 'vitest'
import {
  installTeamSkill,
  quarantineTeamSkill,
  uninstallTeamSkill,
} from '../src/installer.ts'
import type { InstallTeamSkillRequest } from '../src/installer.ts'

const runtimeName = 'aicp-skill-01jabc'
const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function archive(files: Record<string, string>): Uint8Array {
  return zipSync(Object.fromEntries(Object.entries(files).map(([path, content]) => [path, strToU8(content)])))
}

async function root(): Promise<string> {
  const next = await mkdtemp(join(tmpdir(), 'dsh-team-skill-'))
  roots.push(next)
  return next
}

function validArchive(name = runtimeName): Uint8Array {
  return archive({
    'SKILL.md': `---\nname: ${name}\ndescription: Team-reviewed skill\n---\n\nUse the team procedure.\n`,
    'references/checklist.md': '# Checklist\n',
  })
}

describe('installTeamSkill', () => {
  it('rejects a mismatched archive digest without creating the target directory', async () => {
    const scopeRoot = await root()
    const bytes = validArchive()

    await expect(installTeamSkill({
      scopeRoot,
      runtimeName,
      version: '1.0.0',
      archive: bytes,
      expectedSha256: '0'.repeat(64),
    })).rejects.toMatchObject({ code: 'artifact-integrity-failed' })

    await expect(access(join(scopeRoot, runtimeName))).rejects.toThrow()
  })

  it('rejects a mismatched file manifest without creating the target directory', async () => {
    const scopeRoot = await root()
    const bytes = validArchive()
    const request = {
      scopeRoot,
      runtimeName,
      version: '1.0.0',
      archive: bytes,
      expectedSha256: sha256(bytes),
      expectedFileDigests: [{ path: 'SKILL.md', sha256: '0'.repeat(64) }],
    } as InstallTeamSkillRequest & {
      readonly expectedFileDigests: readonly { readonly path: string; readonly sha256: string }[]
    }

    await expect(installTeamSkill(request)).rejects.toMatchObject({
      code: 'artifact-integrity-failed',
    })

    await expect(access(join(scopeRoot, runtimeName))).rejects.toThrow()
  })

  it('rejects a package without a root SKILL.md without creating the target directory', async () => {
    const scopeRoot = await root()
    const bytes = archive({ 'references/only.md': '# Missing root skill\n' })

    await expect(installTeamSkill({
      scopeRoot,
      runtimeName,
      version: '1.0.0',
      archive: bytes,
      expectedSha256: sha256(bytes),
    })).rejects.toMatchObject({ code: 'artifact-validation-failed' })

    await expect(access(join(scopeRoot, runtimeName))).rejects.toThrow()
  })

  it('writes a verified package into one DSH-native directory and returns its local record', async () => {
    const scopeRoot = await root()
    const bytes = validArchive()

    const installed = await installTeamSkill({
      scopeRoot,
      runtimeName,
      version: '1.0.0',
      archive: bytes,
      expectedSha256: sha256(bytes),
    })

    expect(installed).toMatchObject({
      runtimeName,
      version: '1.0.0',
      artifactSha256: sha256(bytes),
      state: 'normal',
    })
    expect(await readFile(join(scopeRoot, runtimeName, 'SKILL.md'), 'utf8')).toContain(`name: ${runtimeName}`)
    expect(await readFile(join(scopeRoot, runtimeName, 'references', 'checklist.md'), 'utf8')).toBe('# Checklist\n')
  })

  it('refuses an update when a managed local file changed without explicit confirmation', async () => {
    const scopeRoot = await root()
    const first = validArchive()
    const installed = await installTeamSkill({
      scopeRoot,
      runtimeName,
      version: '1.0.0',
      archive: first,
      expectedSha256: sha256(first),
    })
    await writeFile(join(scopeRoot, runtimeName, 'SKILL.md'), 'local change\n')
    const second = validArchive()

    await expect(installTeamSkill({
      scopeRoot,
      runtimeName,
      version: '1.1.0',
      archive: second,
      expectedSha256: sha256(second),
      current: installed,
    })).rejects.toMatchObject({ code: 'local-content-modified' })
  })

  it('moves a managed directory into the private quarantine root after a release is withdrawn', async () => {
    const scopeRoot = await root()
    const quarantineRoot = join(scopeRoot, '.ai-coding-platform-quarantine')
    const bytes = validArchive()
    const installed = await installTeamSkill({
      scopeRoot,
      runtimeName,
      version: '1.0.0',
      archive: bytes,
      expectedSha256: sha256(bytes),
    })

    const quarantined = await quarantineTeamSkill({ installed, quarantineRoot })

    expect(quarantined).toMatchObject({ state: 'withdrawn', runtimeName })
    await expect(access(join(scopeRoot, runtimeName))).rejects.toThrow()
    expect(await readFile(join(quarantineRoot, runtimeName, 'SKILL.md'), 'utf8')).toContain(`name: ${runtimeName}`)
  })

  it('removes an unchanged managed directory during uninstall', async () => {
    const scopeRoot = await root()
    const bytes = validArchive()
    const installed = await installTeamSkill({
      scopeRoot,
      runtimeName,
      version: '1.0.0',
      archive: bytes,
      expectedSha256: sha256(bytes),
    })

    const removed = await uninstallTeamSkill({ installed })

    expect(removed).toMatchObject({ state: 'uninstalled', runtimeName })
    await expect(access(join(scopeRoot, runtimeName))).rejects.toThrow()
  })

  it('refuses uninstall when a managed directory contains local changes', async () => {
    const scopeRoot = await root()
    const bytes = validArchive()
    const installed = await installTeamSkill({
      scopeRoot,
      runtimeName,
      version: '1.0.0',
      archive: bytes,
      expectedSha256: sha256(bytes),
    })
    await writeFile(join(scopeRoot, runtimeName, 'SKILL.md'), 'local change\n')

    await expect(uninstallTeamSkill({ installed })).rejects.toMatchObject({
      code: 'local-content-modified',
    })
  })
})
