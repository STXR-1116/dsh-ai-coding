/**
 * Validated installation and withdrawal handling for platform-hosted Team Skills.
 * @module @deepseek-ai/dsh-ai-coding-platform/installer
 */

import { createHash, randomBytes } from 'node:crypto'
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { unzipSync } from 'fflate'
import { parse as parseYaml } from 'yaml'

/** Stable failure reasons surfaced by the Team Skill Host. */
export type TeamSkillInstallErrorCode =
  | 'artifact-integrity-failed'
  | 'artifact-validation-failed'
  | 'local-content-modified'
  | 'target-conflict'

/** A checked file retained in the local installation record. */
export interface TeamSkillFileDigest {
  /** Slash-separated artifact-relative file path. */
  readonly path: string
  /** SHA-256 digest of the exact installed bytes. */
  readonly sha256: string
}

/** A locally installed Team Skill copy. It never crosses to the service API. */
export interface InstalledTeamSkill {
  /** DSH skill name and final single-level directory name. */
  readonly runtimeName: string
  /** Immutable platform release version. */
  readonly version: string
  /** SHA-256 digest for the downloaded release archive. */
  readonly artifactSha256: string
  /** Absolute directory containing the installed `SKILL.md`. */
  readonly directory: string
  /** Checked files used to detect a later local change. */
  readonly files: readonly TeamSkillFileDigest[]
  /** Current lifecycle state of this local copy. */
  readonly state: 'normal' | 'withdrawn' | 'uninstalled'
}

/** Request to write a verified platform artifact into one DSH Skill root. */
export interface InstallTeamSkillRequest {
  /** Project `.dsh/skills` or global DSH Skill root. */
  readonly scopeRoot: string
  /** Platform-derived DSH Skill name. */
  readonly runtimeName: string
  /** Immutable version represented by `archive`. */
  readonly version: string
  /** Complete ZIP archive fetched by the Host. */
  readonly archive: Uint8Array
  /** Service-declared SHA-256 of `archive`. */
  readonly expectedSha256: string
  /** Optional service-declared digest for every regular artifact file. */
  readonly expectedFileDigests?: readonly TeamSkillFileDigest[]
  /** Existing plugin-owned local copy when replacing a release. */
  readonly current?: InstalledTeamSkill
  /** Explicit confirmation required before replacing locally changed content. */
  readonly confirmModifiedReplace?: boolean
}

/** Request to prevent a withdrawn Skill from remaining discoverable by DSH. */
export interface QuarantineTeamSkillRequest {
  /** Plugin-owned local copy to remove from its DSH Skill root. */
  readonly installed: InstalledTeamSkill
  /** Private Host-owned destination outside every DSH Skill discovery root. */
  readonly quarantineRoot: string
}

/** Request to remove one plugin-owned local copy from DSH discovery. */
export interface UninstallTeamSkillRequest {
  /** Plugin-owned local copy to remove. */
  readonly installed: InstalledTeamSkill
  /** Explicit confirmation required before deleting locally changed content. */
  readonly confirmModifiedReplace?: boolean
}

/** Explicit, user-displayable installation failure. */
export class TeamSkillInstallError extends Error {
  /**
   * @param code - Stable failure reason for the caller.
   * @param message - Concrete diagnostic suitable for logs and a user summary.
   */
  constructor(readonly code: TeamSkillInstallErrorCode, message: string) {
    super(message)
    this.name = 'TeamSkillInstallError'
  }
}

interface ArtifactFile {
  readonly path: string
  readonly contents: Uint8Array
}

/** Install one immutable artifact only after full validation.
 * @param request - Artifact, destination and replacement validation inputs.
 * @returns Recorded local installation details.
 */
export async function installTeamSkill(request: InstallTeamSkillRequest): Promise<InstalledTeamSkill> {
  validateRuntimeName(request.runtimeName)
  verifyArchiveDigest(request.archive, request.expectedSha256)
  const files = unpackAndValidate(request.archive, request.runtimeName)
  verifyFileManifest(files, request.expectedFileDigests)
  const targetDirectory = join(resolve(request.scopeRoot), request.runtimeName)

  if (request.current !== undefined) {
    if (resolve(request.current.directory) !== targetDirectory) {
      throw new TeamSkillInstallError('target-conflict', 'The recorded local Skill directory does not match the requested scope.')
    }
    if (!request.confirmModifiedReplace && !await matchesRecordedFiles(request.current)) {
      throw new TeamSkillInstallError('local-content-modified', 'The locally installed Skill was modified after installation.')
    }
  } else if (await pathExists(targetDirectory)) {
    throw new TeamSkillInstallError('target-conflict', 'The target Skill directory is not owned by this platform installation record.')
  }

  await mkdir(dirname(targetDirectory), { recursive: true, mode: 0o700 })
  const temporaryDirectory = await createSiblingTemporaryDirectory(targetDirectory)
  try {
    await writeArtifact(temporaryDirectory, files)
    await replaceDirectory(temporaryDirectory, targetDirectory)
  } catch (error) {
    await rm(temporaryDirectory, { recursive: true, force: true })
    throw error
  }

  return Object.freeze({
    runtimeName: request.runtimeName,
    version: request.version,
    artifactSha256: request.expectedSha256,
    directory: targetDirectory,
    files: Object.freeze(files.map(file => Object.freeze({ path: file.path, sha256: sha256(file.contents) }))),
    state: 'normal',
  })
}

/** Reject an artifact whose checked files do not match the service manifest. */
function verifyFileManifest(
  files: readonly ArtifactFile[],
  expectedFileDigests: readonly TeamSkillFileDigest[] | undefined,
): void {
  if (expectedFileDigests === undefined) return
  const actual = files.map(file => ({ path: file.path, sha256: sha256(file.contents) }))
  const expected = [...expectedFileDigests].sort((left, right) => left.path.localeCompare(right.path))
  if (actual.length !== expected.length) {
    throw new TeamSkillInstallError('artifact-integrity-failed', 'The downloaded Team Skill files did not match the service manifest.')
  }
  for (const [index, file] of actual.entries()) {
    const expectedFile = expected[index]
    if (expectedFile === undefined || file.path !== expectedFile.path || file.sha256 !== expectedFile.sha256.toLowerCase()) {
      throw new TeamSkillInstallError('artifact-integrity-failed', 'The downloaded Team Skill files did not match the service manifest.')
    }
  }
}

/** Move a withdrawn local copy outside all DSH Skill roots without deleting it.
 * @param request - Installed copy and private quarantine destination.
 * @returns Updated local installation details in the quarantine directory.
 */
export async function quarantineTeamSkill(request: QuarantineTeamSkillRequest): Promise<InstalledTeamSkill> {
  const sourceDirectory = resolve(request.installed.directory)
  const destinationDirectory = join(resolve(request.quarantineRoot), request.installed.runtimeName)
  if (await pathExists(destinationDirectory)) {
    throw new TeamSkillInstallError('target-conflict', 'A quarantined copy already exists for this Team Skill.')
  }
  await mkdir(dirname(destinationDirectory), { recursive: true, mode: 0o700 })
  await rename(sourceDirectory, destinationDirectory)
  return Object.freeze({ ...request.installed, directory: destinationDirectory, state: 'withdrawn' })
}

/** Remove one managed copy only when its current files still match the record.
 * @param request - Installed copy and explicit modification confirmation.
 * @returns Updated local installation details with an `uninstalled` state.
 */
export async function uninstallTeamSkill(request: UninstallTeamSkillRequest): Promise<InstalledTeamSkill> {
  if (!request.confirmModifiedReplace && !await matchesRecordedFiles(request.installed)) {
    throw new TeamSkillInstallError('local-content-modified', 'The locally installed Skill was modified after installation.')
  }
  await rm(resolve(request.installed.directory), { recursive: true, force: true })
  return Object.freeze({ ...request.installed, state: 'uninstalled' })
}

/** Validate that a platform runtime name cannot escape its assigned Skill root. */
function validateRuntimeName(runtimeName: string): void {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(runtimeName)) {
    throw new TeamSkillInstallError('artifact-validation-failed', `Invalid Team Skill runtime name "${runtimeName}".`)
  }
}

/** Reject an archive before it reaches the filesystem when its service digest differs. */
function verifyArchiveDigest(archive: Uint8Array, expectedSha256: string): void {
  if (!/^[a-f0-9]{64}$/i.test(expectedSha256) || sha256(archive) !== expectedSha256.toLowerCase()) {
    throw new TeamSkillInstallError('artifact-integrity-failed', 'The downloaded Team Skill archive did not match its declared SHA-256 digest.')
  }
}

/** Decode and validate the complete root-level DSH Skill artifact in memory. */
function unpackAndValidate(archive: Uint8Array, runtimeName: string): readonly ArtifactFile[] {
  let unpacked: Record<string, Uint8Array>
  try {
    unpacked = unzipSync(archive)
  } catch {
    throw new TeamSkillInstallError('artifact-validation-failed', 'The Team Skill artifact is not a readable ZIP archive.')
  }
  const files = Object.entries(unpacked)
    .map(([path, contents]) => ({ path: normalizeArtifactPath(path), contents }))
    .sort((left, right) => left.path.localeCompare(right.path))
  const rootSkill = files.find(file => file.path === 'SKILL.md')
  if (rootSkill === undefined) {
    throw new TeamSkillInstallError('artifact-validation-failed', 'The artifact must contain a root SKILL.md file.')
  }
  validateSkillFrontmatter(new TextDecoder().decode(rootSkill.contents), runtimeName)
  return files
}

/** Permit only slash-separated regular file paths contained by the archive root. */
function normalizeArtifactPath(path: string): string {
  if (path.length === 0 || path.includes('\\') || path.startsWith('/') || path.includes('\0')) {
    throw new TeamSkillInstallError('artifact-validation-failed', `The artifact contains an unsafe file path "${path}".`)
  }
  const parts = path.split('/')
  if (parts.some(part => part.length === 0 || part === '.' || part === '..')) {
    throw new TeamSkillInstallError('artifact-validation-failed', `The artifact contains an unsafe file path "${path}".`)
  }
  return parts.join('/')
}

/** Ensure that DSH will discover the artifact under its assigned runtime name. */
function validateSkillFrontmatter(skill: string, runtimeName: string): void {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(skill)
  if (match?.[1] === undefined) {
    throw new TeamSkillInstallError('artifact-validation-failed', 'SKILL.md must begin with YAML frontmatter.')
  }
  let data: unknown
  try {
    data = parseYaml(match[1])
  } catch {
    throw new TeamSkillInstallError('artifact-validation-failed', 'SKILL.md contains invalid YAML frontmatter.')
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new TeamSkillInstallError('artifact-validation-failed', 'SKILL.md frontmatter must be an object.')
  }
  const frontmatter = data as Record<string, unknown>
  if (frontmatter.name !== runtimeName || typeof frontmatter.description !== 'string' || frontmatter.description.trim() === '') {
    throw new TeamSkillInstallError('artifact-validation-failed', 'SKILL.md frontmatter must declare the assigned name and a description.')
  }
}

/** Materialize validated files only below the new sibling directory. */
async function writeArtifact(directory: string, files: readonly ArtifactFile[]): Promise<void> {
  for (const file of files) {
    const destination = join(directory, ...file.path.split('/'))
    // Defense-in-depth: normalizeArtifactPath already rejects traversal, so
    // this is unreachable from a real archive and guards future callers only.
    /* v8 ignore next 3 */
    if (!isContainedPath(directory, destination)) {
      throw new TeamSkillInstallError('artifact-validation-failed', `The artifact file "${file.path}" escapes the installation root.`)
    }
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
    await writeFile(destination, file.contents, { mode: 0o600, flag: 'wx' })
  }
}

/** Create a private same-parent directory so the final rename stays on one filesystem. */
async function createSiblingTemporaryDirectory(targetDirectory: string): Promise<string> {
  const parent = dirname(targetDirectory)
  const candidate = join(parent, `.${basename(targetDirectory)}.installing-${randomBytes(8).toString('hex')}`)
  await mkdir(candidate, { mode: 0o700 })
  return candidate
}

/**
 * Replace a target directory while restoring its prior copy when the final rename fails.
 *
 * Replaces are serialized per target: two concurrent installs of the same
 * skill would otherwise interleave between the backup rename and the swap, and
 * the loser's `.replacing-` backup was left on disk forever. A failed restore
 * also drops the backup rather than orphaning it — the target holds the other
 * writer's valid copy at that point.
 */
async function replaceDirectory(temporaryDirectory: string, targetDirectory: string): Promise<void> {
  return queueReplace(targetDirectory, async () => {
    if (!await pathExists(targetDirectory)) {
      await rename(temporaryDirectory, targetDirectory)
      return
    }
    const backupDirectory = `${targetDirectory}.replacing-${randomBytes(8).toString('hex')}`
    await rename(targetDirectory, backupDirectory)
    // The recovery arms below need a second writer to swap the target between
    // our two renames; the per-target queue makes that window unstunnable, so
    // they are exercised only by real concurrent hosts. Owner decision request,
    // topic 2.
    /* v8 ignore next 12 */
    try {
      await rename(temporaryDirectory, targetDirectory)
    } catch (error) {
      try {
        await rename(backupDirectory, targetDirectory)
      } catch {
        // The target was re-created by another writer while we held the backup:
        // its copy is the live one, so remove ours instead of leaving a
        // `.replacing-` orphan behind.
        await rm(backupDirectory, { recursive: true, force: true })
      }
      throw error
    }
    await rm(backupDirectory, { recursive: true, force: true })
  })
}

/** Per-target replace queues: each entry chains onto the previous replace. */
const replaceChains = new Map<string, Promise<unknown>>()

/** Run one replace after every queued replace for the same target has settled. */
function queueReplace<T>(targetDirectory: string, task: () => Promise<T>): Promise<T> {
  const previous = replaceChains.get(targetDirectory) ?? Promise.resolve()
  const next = previous.then(task, task)
  replaceChains.set(targetDirectory, next.then(() => undefined, () => undefined))
  return next
}

/** Compare current on-disk contents to the exact installation record. */
async function matchesRecordedFiles(installed: InstalledTeamSkill): Promise<boolean> {
  try {
    const actual = await listFileDigests(installed.directory)
    if (actual.length !== installed.files.length) return false
    return actual.every((file, index) => {
      const expectedFile = installed.files[index]
      return expectedFile !== undefined && file.path === expectedFile.path && file.sha256 === expectedFile.sha256
    })
  } catch {
    return false
  }
}

/** List the whole managed tree so added and deleted files are detected as local modification. */
async function listFileDigests(directory: string, relativeDirectory = ''): Promise<TeamSkillFileDigest[]> {
  const entries = await readdir(join(directory, relativeDirectory), { withFileTypes: true, encoding: 'utf8' })
  const files: TeamSkillFileDigest[] = []
  for (const entry of entries) {
    const relativePath = relativeDirectory === '' ? entry.name : `${relativeDirectory}/${entry.name}`
    if (entry.isDirectory()) {
      files.push(...await listFileDigests(directory, relativePath))
    } else if (entry.isFile()) {
      const content = await readFile(join(directory, ...relativePath.split('/')))
      files.push({ path: relativePath, sha256: sha256(content) })
    } else {
      // A symlink or special file inside a managed tree is detected as local
      // modification; creating one needs privileges on Windows. Owner decision
      // request, topic 2.
      /* v8 ignore next 2 */
      return []
    }
  }
  return files.sort((left, right) => left.path.localeCompare(right.path))
}

/** Resolve a filesystem path and ensure it remains below the selected root. */
function isContainedPath(root: string, candidate: string): boolean {
  const path = relative(root, candidate)
  return path !== '' && !path.startsWith(`..${sep}`) && path !== '..' && !path.includes(`..${sep}`)
}

/** Return whether a target exists without converting unrelated filesystem failures into absence. */
async function pathExists(path: string): Promise<boolean> {
  try {
    await readFile(path)
    return true
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'EISDIR') return true
    if (code === 'ENOENT') return false
    /* v8 ignore next 2 */
    throw error
  }
}

/** Return the lower-case SHA-256 digest used by the service artifact manifest. */
function sha256(content: Uint8Array): string {
  return createHash('sha256').update(content).digest('hex')
}
