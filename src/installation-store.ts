/** Private durable state for Team Skill copies managed on this DSH host. */

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { withFileLock } from '@deepseek-ai/dsh-atomic-write'
import type { TeamSkillInstallationRecord, TeamSkillScope } from './types.ts'

const STATE_FILE = 'team-skill-installations.json'

/** Durable installation-store operations consumed by the Host state machine. */
export interface TeamSkillInstallationStoreLike {
  list(): Promise<readonly TeamSkillInstallationRecord[]>
  upsert(next: TeamSkillInstallationRecord): Promise<void>
  remove(localInstallationId: string): Promise<void>
}

/** Read and atomically update Host-only Team Skill installation records. */
export class TeamSkillInstallationStore implements TeamSkillInstallationStoreLike {
  constructor(private readonly stateDirectory: string) {}

  /** Read every durable installation record owned by this Host.
   * @returns Every durable installation record owned by this Host.
   */
  async list(): Promise<readonly TeamSkillInstallationRecord[]> {
    const path = this.path()
    let source: string
    try {
      source = await readFile(path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return Object.freeze([])
      throw error
    }
    return parseRecords(source)
  }

  /** Replace the record for one exact project authorization scope.
   * The record identity is `(skillId, scope, workspaceId, projectId)`: two projects never
   * overwrite each other's authorization record for the same local Skill copy scope.
   * @param next - New record for the local installation scope.
   */
  async upsert(next: TeamSkillInstallationRecord): Promise<void> {
    await this.withLock(async () => {
      const records = await this.list()
      const updated = [...records.filter(record => !sameInstallation(record, next)), next]
      await this.write(updated)
    })
  }

  /** Remove one exact locally managed copy from durable state.
   * @param localInstallationId - Host-generated local installation identity.
   */
  async remove(localInstallationId: string): Promise<void> {
    await this.withLock(async () => {
      const records = await this.list()
      await this.write(records.filter(record => record.localInstallationId !== localInstallationId))
    })
  }

  private async withLock<T>(operation: () => Promise<T>): Promise<T> {
    const destination = this.path()
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
    return withFileLock(destination, operation, { waitMs: 10_000 })
  }

  private path(): string {
    return join(this.stateDirectory, STATE_FILE)
  }

  private async write(records: readonly TeamSkillInstallationRecord[]): Promise<void> {
    const destination = this.path()
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
    const temporary = `${destination}.writing-${randomUUID()}`
    try {
      await writeFile(temporary, `${JSON.stringify({ records })}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
      await rename(temporary, destination)
    } finally {
      // 成功路径的 rm 是无害空操作；失败路径（磁盘耗尽等）在 finally 清理后
      // 原样抛出。finally 结构天然可覆盖，优于此前注入不可达的 catch。
      await rm(temporary, { force: true })
    }
  }
}

function sameInstallation(left: TeamSkillInstallationRecord, right: TeamSkillInstallationRecord): boolean {
  return (
    left.skillId === right.skillId &&
    left.scope === right.scope &&
    left.workspaceId === right.workspaceId &&
    left.projectId === right.projectId
  )
}

function parseRecords(source: string): readonly TeamSkillInstallationRecord[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(source)
  } catch {
    throw new Error('AI Coding platform local Team Skill state is not valid JSON.')
  }
  const record = recordOf(parsed)
  if (record === undefined || !Array.isArray(record.records)) {
    throw new Error('AI Coding platform local Team Skill state has an invalid record format.')
  }
  return Object.freeze(record.records.map(parseRecord))
}

function parseRecord(value: unknown): TeamSkillInstallationRecord {
  const record = recordOf(value)
  const installed = record === undefined ? undefined : recordOf(record.installed)
  if (record === undefined || installed === undefined) throw new Error('AI Coding platform local Team Skill record is invalid.')
  const scope = requireScope(record.scope)
  const workspaceId = optionalString(record.workspaceId)
  if (scope === 'project' && workspaceId === undefined) throw new Error('A project Team Skill record requires a workspace id.')
  return Object.freeze({
    localInstallationId: requireString(record.localInstallationId),
    skillId: requireString(record.skillId),
    projectId: requireString(record.projectId),
    scope,
    ...(workspaceId === undefined ? {} : { workspaceId }),
    installed: Object.freeze({
      runtimeName: requireString(installed.runtimeName),
      version: requireString(installed.version),
      artifactSha256: requireString(installed.artifactSha256),
      directory: requireString(installed.directory),
      files: Object.freeze(
        requireArray(installed.files).map((file) => {
          const digest = recordOf(file)
          if (digest === undefined) throw new Error('A local Team Skill file digest is invalid.')
          return Object.freeze({ path: requireString(digest.path), sha256: requireString(digest.sha256) })
        }),
      ),
      state: requireInstalledState(installed.state),
    }),
    installedAt: requireString(record.installedAt),
  })
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

function requireString(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error('A local Team Skill record contains an invalid string.')
  return value
}

function optionalString(value: unknown): string | undefined {
  if (value === undefined) return undefined
  return requireString(value)
}

function requireArray(value: unknown): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error('A local Team Skill record contains an invalid array.')
  return value
}

function requireScope(value: unknown): TeamSkillScope {
  if (value === 'project' || value === 'global') return value
  throw new Error('A local Team Skill record contains an invalid scope.')
}

function requireInstalledState(value: unknown): 'normal' | 'withdrawn' | 'uninstalled' {
  if (value === 'normal' || value === 'withdrawn' || value === 'uninstalled') return value
  throw new Error('A local Team Skill record contains an invalid state.')
}
