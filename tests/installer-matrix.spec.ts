// installer.ts 校验矩阵的行为用例（终收尾轮·覆盖缺口关闭）：
// 路径安全、frontmatter 与 runtimeName 校验、服务清单（含大写摘要归一）、
// 目标归属冲突、显式确认替换、隔离冲突、显式确认卸载与同目标并发替换。
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { strToU8, zipSync } from 'fflate'
import { afterEach, describe, expect, it } from 'vitest'
import { installTeamSkill, quarantineTeamSkill, uninstallTeamSkill } from '../src/installer.ts'

const runtimeName = 'aicp-skill-01jxyz'

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

function frontmatter(name: string): string {
  return `---\nname: ${name}\ndescription: Team-reviewed skill\n---\n\nUse the team procedure.\n`
}

function validArchive(name = runtimeName): Uint8Array {
  return archive({
    'SKILL.md': frontmatter(name),
    'references/checklist.md': '# Checklist\n',
  })
}

async function root(): Promise<string> {
  const next = await mkdtemp(join(tmpdir(), 'dsh-team-skill-matrix-'))
  roots.push(next)
  return next
}

describe('installer validation matrix', () => {
  it('rejects non-ZIP artifacts before touching the filesystem', async () => {
    const scopeRoot = await root()
    await expect(
      installTeamSkill({
        scopeRoot,
        runtimeName,
        version: '1.0.0',
        archive: strToU8('definitely not a zip'),
        expectedSha256: sha256(strToU8('definitely not a zip')),
      }),
    ).rejects.toMatchObject({ code: 'artifact-validation-failed' })
    await expect(mkdir(join(scopeRoot, runtimeName))).resolves.toBeUndefined()
  })

  it('rejects a declared digest that is not 64 hex digits', async () => {
    const scopeRoot = await root()
    const bytes = validArchive()
    await expect(
      installTeamSkill({ scopeRoot, runtimeName, version: '1.0.0', archive: bytes, expectedSha256: 'deadbeef' }),
    ).rejects.toMatchObject({ code: 'artifact-integrity-failed' })
    await expect(mkdir(join(scopeRoot, runtimeName))).resolves.toBeUndefined()
  })

  it('rejects traversal, absolute, backslash, empty-segment and dot artifact paths', async () => {
    const cases: Record<string, string>[] = [
      { 'SKILL.md': frontmatter(runtimeName), 'references/../../escape.md': 'x' },
      { 'SKILL.md': frontmatter(runtimeName), '/absolute.md': 'x' },
      { 'SKILL.md': frontmatter(runtimeName), 'back\\slash.md': 'x' },
      { 'SKILL.md': frontmatter(runtimeName), 'double//slash.md': 'x' },
      { 'SKILL.md': frontmatter(runtimeName), './dot.md': 'x' },
    ]
    for (const [index, files] of cases.entries()) {
      const scopeRoot = await root()
      const bytes = archive(files)
      await expect(
        installTeamSkill({ scopeRoot, runtimeName, version: '1.0.0', archive: bytes, expectedSha256: sha256(bytes) }),
        `case ${String(index)} must reject the unsafe path`,
      ).rejects.toMatchObject({ code: 'artifact-validation-failed' })
    }
  })

  it('rejects an invalid runtime name and mismatched or malformed frontmatter', async () => {
    const scopeRoot = await root()
    const bytes = validArchive('Bad_Name')
    await expect(
      installTeamSkill({ scopeRoot, runtimeName: 'Bad_Name', version: '1.0.0', archive: bytes, expectedSha256: sha256(bytes) }),
    ).rejects.toMatchObject({ code: 'artifact-validation-failed' })

    const wrongName = archive({ 'SKILL.md': frontmatter('other-name') })
    await expect(
      installTeamSkill({ scopeRoot, runtimeName, version: '1.0.0', archive: wrongName, expectedSha256: sha256(wrongName) }),
    ).rejects.toMatchObject({ code: 'artifact-validation-failed' })

    const noDescription = archive({ 'SKILL.md': `---\nname: ${runtimeName}\n---\n\nbody\n` })
    await expect(
      installTeamSkill({ scopeRoot, runtimeName, version: '1.0.0', archive: noDescription, expectedSha256: sha256(noDescription) }),
    ).rejects.toMatchObject({ code: 'artifact-validation-failed' })

    const brokenYaml = archive({ 'SKILL.md': '---\nname: [unclosed\n---\n\nbody\n' })
    await expect(
      installTeamSkill({ scopeRoot, runtimeName, version: '1.0.0', archive: brokenYaml, expectedSha256: sha256(brokenYaml) }),
    ).rejects.toMatchObject({ code: 'artifact-validation-failed' })

    const arrayFrontmatter = archive({ 'SKILL.md': '---\n- a\n- b\n---\n\nbody\n' })
    await expect(
      installTeamSkill({ scopeRoot, runtimeName, version: '1.0.0', archive: arrayFrontmatter, expectedSha256: sha256(arrayFrontmatter) }),
    ).rejects.toMatchObject({ code: 'artifact-validation-failed' })
  })

  it('enforces the service file manifest including uppercase digest normalization', async () => {
    const scopeRoot = await root()
    const bytes = validArchive()
    const upperDigests = [
      { path: 'SKILL.md', sha256: sha256(strToU8(frontmatter(runtimeName))).toUpperCase() },
      { path: 'references/checklist.md', sha256: sha256(strToU8('# Checklist\n')).toUpperCase() },
    ]
    const installed = await installTeamSkill({
      scopeRoot,
      runtimeName,
      version: '1.0.0',
      archive: bytes,
      expectedSha256: sha256(bytes),
      expectedFileDigests: upperDigests,
    })
    expect(installed.files).toHaveLength(2)

    const otherRoot = await root()
    const wrongCount = await installTeamSkill({
      scopeRoot: otherRoot,
      runtimeName,
      version: '1.0.0',
      archive: bytes,
      expectedSha256: sha256(bytes),
      expectedFileDigests: upperDigests.slice(0, 1),
    }).catch((error: unknown) => error)
    expect(wrongCount).toMatchObject({ code: 'artifact-integrity-failed' })

    const otherRoot2 = await root()
    const wrongDigest = await installTeamSkill({
      scopeRoot: otherRoot2,
      runtimeName,
      version: '1.0.0',
      archive: bytes,
      expectedSha256: sha256(bytes),
      expectedFileDigests: [{ path: 'SKILL.md', sha256: sha256(strToU8('different')) }],
    }).catch((error: unknown) => error)
    expect(wrongDigest).toMatchObject({ code: 'artifact-integrity-failed' })
  })

  it('refuses an unowned target directory and a mismatched recorded directory', async () => {
    const scopeRoot = await root()
    await mkdir(join(scopeRoot, runtimeName), { recursive: true })
    const bytes = validArchive()
    await expect(
      installTeamSkill({ scopeRoot, runtimeName, version: '1.0.0', archive: bytes, expectedSha256: sha256(bytes) }),
    ).rejects.toMatchObject({ code: 'target-conflict' })

    const otherScope = await root()
    const installed = await installTeamSkill({
      scopeRoot: otherScope,
      runtimeName,
      version: '1.0.0',
      archive: bytes,
      expectedSha256: sha256(bytes),
    })
    await expect(
      installTeamSkill({
        scopeRoot,
        runtimeName,
        version: '1.1.0',
        archive: bytes,
        expectedSha256: sha256(bytes),
        current: { ...installed, directory: join(scopeRoot, 'elsewhere', runtimeName) },
      }),
    ).rejects.toMatchObject({ code: 'target-conflict' })
  })

  it('replaces locally modified content only with explicit confirmation', async () => {
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

    const replaced = await installTeamSkill({
      scopeRoot,
      runtimeName,
      version: '1.1.0',
      archive: validArchive(),
      expectedSha256: sha256(validArchive()),
      current: installed,
      confirmModifiedReplace: true,
    })
    expect(replaced.version).toBe('1.1.0')
    await expect(readFile(join(scopeRoot, runtimeName, 'SKILL.md'), 'utf8')).resolves.toContain('Team-reviewed skill')
  })

  it('refuses quarantine when the destination already exists', async () => {
    const scopeRoot = await root()
    const quarantineRoot = await root()
    const bytes = validArchive()
    const installed = await installTeamSkill({
      scopeRoot,
      runtimeName,
      version: '1.0.0',
      archive: bytes,
      expectedSha256: sha256(bytes),
    })
    await quarantineTeamSkill({ installed, quarantineRoot })
    await expect(quarantineTeamSkill({ installed, quarantineRoot })).rejects.toMatchObject({ code: 'target-conflict' })
  })

  it('uninstalls locally modified content with explicit confirmation', async () => {
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
    const removed = await uninstallTeamSkill({ installed, confirmModifiedReplace: true })
    expect(removed.state).toBe('uninstalled')
    await expect(mkdir(join(scopeRoot, runtimeName))).resolves.toBeUndefined()
  })

  it('serializes concurrent replaces of the same target and leaves no replacing backup', async () => {
    const scopeRoot = await root()
    const bytes = validArchive()
    const installed = await installTeamSkill({
      scopeRoot,
      runtimeName,
      version: '1.0.0',
      archive: bytes,
      expectedSha256: sha256(bytes),
    })
    const [first, second] = await Promise.all([
      installTeamSkill({
        scopeRoot,
        runtimeName,
        version: '1.1.0',
        archive: validArchive(),
        expectedSha256: sha256(validArchive()),
        current: installed,
      }),
      installTeamSkill({
        scopeRoot,
        runtimeName,
        version: '1.2.0',
        archive: validArchive(),
        expectedSha256: sha256(validArchive()),
        current: installed,
        confirmModifiedReplace: true,
      }),
    ])
    const entries = await readdir(scopeRoot)
    expect(entries.filter(name => name.includes('.replacing-'))).toEqual([])
    expect([first.version, second.version].sort()).toEqual(['1.1.0', '1.2.0'])
  })

  it('refuses an install whose target path is occupied by a plain file', async () => {
    const scopeRoot = await root()
    // 目标被同名普通文件占用：pathExists 走 readFile 成功路径（true），
    // install 必须以 target-conflict 拒绝而不是覆盖用户文件。
    await writeFile(join(scopeRoot, runtimeName), 'a user file happened here\n')
    const bytes = validArchive()
    await expect(
      installTeamSkill({ scopeRoot, runtimeName, version: '1.0.0', archive: bytes, expectedSha256: sha256(bytes) }),
    ).rejects.toMatchObject({ code: 'target-conflict' })
  })

  it('accepts an unconfirmed replace when the recorded copy matches exactly', async () => {
    const scopeRoot = await root()
    const bytes = validArchive()
    const installed = await installTeamSkill({
      scopeRoot,
      runtimeName,
      version: '1.0.0',
      archive: bytes,
      expectedSha256: sha256(bytes),
    })
    // 无本地改动 + 无显式确认：matchesRecordedFiles 的逐文件比对全走 true 路径。
    const replaced = await installTeamSkill({
      scopeRoot,
      runtimeName,
      version: '1.1.0',
      archive: validArchive(),
      expectedSha256: sha256(validArchive()),
      current: installed,
    })
    expect(replaced.version).toBe('1.1.0')
  })

  it('rejects a pre-step artifact without YAML frontmatter', async () => {
    const scopeRoot = await root()
    const bytes = archive({ 'SKILL.md': 'plain body without frontmatter\n' })
    await expect(
      installTeamSkill({ scopeRoot, runtimeName, version: '1.0.0', archive: bytes, expectedSha256: sha256(bytes) }),
    ).rejects.toMatchObject({ code: 'artifact-validation-failed' })
  })

  it('cleans the temporary directory when an artifact file cannot be written', async () => {
    const scopeRoot = await root()
    // 300-char file name exceeds the 255-byte name limit on both Windows and
    // Linux, so writeArtifact fails mid-write and the temporary directory must
    // be removed before the error surfaces.
    const overflowPath = `${'x'.repeat(300)}.md`
    const bytes = archive({ 'SKILL.md': frontmatter(runtimeName), [overflowPath]: 'overflow' })
    await expect(
      installTeamSkill({ scopeRoot, runtimeName, version: '1.0.0', archive: bytes, expectedSha256: sha256(bytes) }),
    ).rejects.toThrow()
    const entries = await readdir(scopeRoot)
    expect(entries.filter(name => name.includes('.installing-'))).toEqual([])
  })

  it('rejects a manifest with the same file count but different paths', async () => {
    const scopeRoot = await root()
    const bytes = validArchive()
    const shifted = [
      { path: 'references/checklist.md', sha256: sha256(strToU8(frontmatter(runtimeName))) },
      { path: 'SKILL.md', sha256: sha256(strToU8('# Checklist\n')) },
    ]
    await expect(
      installTeamSkill({
        scopeRoot,
        runtimeName,
        version: '1.0.0',
        archive: bytes,
        expectedSha256: sha256(bytes),
        expectedFileDigests: shifted,
      }),
    ).rejects.toMatchObject({ code: 'artifact-integrity-failed' })
  })

  it('reports local modification when the recorded directory has been deleted', async () => {
    const scopeRoot = await root()
    const bytes = validArchive()
    const installed = await installTeamSkill({
      scopeRoot,
      runtimeName,
      version: '1.0.0',
      archive: bytes,
      expectedSha256: sha256(bytes),
    })
    await rm(join(scopeRoot, runtimeName), { recursive: true, force: true })
    await expect(
      installTeamSkill({
        scopeRoot,
        runtimeName,
        version: '1.1.0',
        archive: validArchive(),
        expectedSha256: sha256(validArchive()),
        current: installed,
      }),
    ).rejects.toMatchObject({ code: 'local-content-modified' })
  })
})
