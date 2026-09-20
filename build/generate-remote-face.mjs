/**
 * Generates the browser-visible Remote face and writes it to
 * `src/client/remote-face.ts`.
 *
 * ## Why this script exists
 *
 * Upstream, `@deepseek-ai/dsh-typert-generator` emits
 * `lib/typert.remote-client.d.ts` during the tsdown build. That generator cannot
 * run in this repository's layout — its analyzer reads only `projectReferences`
 * from the root face aggregates and hard-filters every candidate package to a
 * root physically under `<root>/packages/**`, and it recognizes an `@Remote`
 * marker only when the marker's declaration resolves to a package literally
 * named `@deepseek-ai/dsh-typert-protocol`, which is never true for a package
 * consumed out of `node_modules`. A single root-level plugin package is not
 * expressible. (Probe runs: `docs/typert-wiring-notes.md`.)
 *
 * The client half still has to *call* those Remotes, and the two host gateways
 * are the single source of truth for their signatures, so this script derives
 * the face from them mechanically. It is the same derivation the upstream
 * generator performs — for every `@Remote` method, the wire endpoint is the
 * decorator's literal name (or the method name), the parameter list crosses
 * unchanged, and the resolved value is the method's own return type wrapped in
 * the protocol's transport envelope `RemoteResult<T>`.
 *
 * The result is checked in so the browser half typechecks without a codegen
 * step, and `tests/remote-face.spec.ts` fails when the checked-in file drifts
 * from what this script would write.
 *
 * Usage: `node build/generate-remote-face.mjs [--check]`
 * `--check` writes nothing and exits non-zero when the file is out of date.
 *
 * @module build/generate-remote-face
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const outPath = join(root, 'src', 'client', 'remote-face.ts')

/** Host gateway modules and the Typert wire namespace each one publishes. */
const FACES = [
  { file: 'src/gateway.ts', className: 'TeamSkillGateway', namespace: 'teamSkills' },
  { file: 'src/workspace-gateway.ts', className: 'WorkspaceGateway', namespace: 'cloudWorkspaces' },
]

/** Decorator that marks one method as a Remote endpoint. */
const REMOTE_DECORATOR = 'Remote'

/** Strip the `Promise<…>` wrapper so the envelope can be applied to the resolved value. */
function resolvedValueText(returnText) {
  const match = /^Promise<([\s\S]*)>$/.exec(returnText.trim())
  return (match ? match[1] : returnText).trim()
}

/** Collapse a multi-line source signature onto one line without changing its meaning. */
function oneLine(text) {
  return text.replace(/\s*\n\s*/g, ' ').replace(/\s{2,}/g, ' ').trim()
}

/**
 * Print one type or parameter node as a self-contained single-line fragment.
 *
 * `getText()` cannot be used here: the sources write inline object types across
 * several lines with no member separators, so collapsing their newlines would
 * produce `{ a: string b: string }`. The printer re-emits the node with the
 * separators a single-line form requires.
 */
function printFragment(printer, node, sourceFile) {
  return printer.printNode(ts.EmitHint.Unspecified, node, sourceFile)
}
/** Read every `export {interface|type|const|class|enum|function} Name` from a module. */
function exportedTypeNames(sourceFile) {
  const names = []
  for (const statement of sourceFile.statements) {
    const modifiers = ts.canHaveModifiers(statement) ? ts.getModifiers(statement) : undefined
    const exported = modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)
    if (!exported) continue
    if (statement.name && ts.isIdentifier(statement.name)) names.push(statement.name.text)
  }
  return [...new Set(names)].sort()
}

/** Collect the Remote endpoints declared by one gateway class, in source order. */
function endpointsOf(sourceText, filePath, className) {
  const sourceFile = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true)
  const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed })
  const endpoints = []
  let found = false
  const visit = node => {
    if (ts.isClassDeclaration(node) && node.name?.text === className) {
      found = true
      for (const member of node.members) {
        if (!ts.isMethodDeclaration(member)) continue
        if (!ts.canHaveDecorators(member)) continue
        const remote = (ts.getDecorators(member) ?? []).find((decorator) => {
          const expression = ts.isCallExpression(decorator.expression) ? decorator.expression.expression : decorator.expression
          return ts.isIdentifier(expression) && expression.text === REMOTE_DECORATOR
        })
        if (remote === undefined) continue
        const call = ts.isCallExpression(remote.expression) ? remote.expression : undefined
        const literal = call?.arguments[0]
        const endpoint = literal !== undefined && ts.isStringLiteralLike(literal) ? literal.text : member.name.getText(sourceFile)
        const parameters = member.parameters.map(parameter => printFragment(printer, parameter, sourceFile)).join(', ')
        const returnText = member.type === undefined ? 'void' : printFragment(printer, member.type, sourceFile)
        endpoints.push({ endpoint, parameters, value: resolvedValueText(returnText) })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  if (!found) throw new Error(`${relative(root, filePath)}: class ${className} not found`)
  if (endpoints.length === 0) throw new Error(`${relative(root, filePath)}: class ${className} declares no @${REMOTE_DECORATOR} methods`)
  const duplicate = endpoints.map(entry => entry.endpoint).find((name, index, all) => all.indexOf(name) !== index)
  if (duplicate !== undefined) throw new Error(`${relative(root, filePath)}: duplicate Remote endpoint '${duplicate}'`)
  return endpoints
}

/** Render the face module. */
function render() {
  const faces = FACES.map((face) => {
    const text = readFileSync(join(root, face.file), 'utf8')
    return { ...face, endpoints: endpointsOf(text, join(root, face.file), face.className) }
  })

  // Every type the gateways may name in a Remote signature. `src/types.ts` owns the
  // Team Skill vocabulary and `src/workspace-types.ts` the workspace vocabulary; a name
  // exported by both is imported once, from the first module that declares it.
  const typeModules = ['types.ts', 'workspace-types.ts']
  const seen = new Set()
  const imports = []
  for (const module of typeModules) {
    const sourceFile = ts.createSourceFile(module, readFileSync(join(root, 'src', module), 'utf8'), ts.ScriptTarget.Latest, true)
    const names = exportedTypeNames(sourceFile).filter((name) => {
      if (seen.has(name)) return false
      seen.add(name)
      return true
    })
    if (names.length > 0) imports.push({ module, names })
  }

  const lines = []
  lines.push('/* Generated by `build/generate-remote-face.mjs` from the host gateways — do not edit.')
  lines.push(' *')
  lines.push(' * Upstream this file is emitted by `@deepseek-ai/dsh-typert-generator` as')
  lines.push(' * `lib/typert.remote-client.d.ts`; that generator cannot run against this repository’s')
  lines.push(' * single root-level package layout. See the script header and')
  lines.push(' * `docs/typert-wiring-notes.md` for the evidence, and `tests/remote-face.spec.ts` for')
  lines.push(' * the drift guard that keeps this file equal to a fresh run. */')
  lines.push("import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'")
  for (const { module, names } of imports) {
    const specifier = module.replace(/\.ts$/, '.ts')
    lines.push('import type {')
    for (const name of names) lines.push(`  ${name},`)
    lines.push(`} from '../${specifier}'`)
  }
  lines.push('')
  lines.push("declare module '@deepseek-ai/dsh-typert-protocol' {")
  for (const face of faces) {
    lines.push(`  /** Wire namespace \`${face.namespace}\`, published by \`${face.className}\`. */`)
    lines.push(`  interface TypertRemoteNamespace$${face.namespace} {`)
    for (const endpoint of face.endpoints) {
      lines.push(`    ${endpoint.endpoint}: (${oneLine(endpoint.parameters)}) => Promise<RemoteResult<${resolvedValueText(oneLine(endpoint.value))}>>`)
    }
    lines.push('  }')
  }
  lines.push('  /** Remote namespaces this plugin contributes to the assembled client face. */')
  lines.push('  interface TypertRemoteNamespaceMap {')
  for (const face of faces) lines.push(`    '${face.namespace}': TypertRemoteNamespace$${face.namespace}`)
  lines.push('  }')
  lines.push('}')
  lines.push('')
  return lines.join('\n')
}

/**
 * Compare content, not checkout line endings.
 *
 * This repository is checked out with `core.autocrlf` on Windows, so the
 * committed LF file lands on disk as CRLF while the generator always writes LF.
 * A byte comparison would report every Windows checkout as stale; normalising to
 * LF keeps the guard about substance.
 */
export const normalizeNewlines = (text) => text?.replace(/\r\n/g, '\n')

/** Read the checked-in face, or `undefined` when it is absent. */
export function readCheckedInFace() {
  try {
    return readFileSync(outPath, 'utf8')
  } catch {
    return undefined
  }
}

/**
 * Render the face module text.
 *
 * Exported so the drift guard can compare in-process. It used to shell out to
 * this file's `--check` mode, which spawns a child `node` with piped stdio from
 * inside a Vitest fork; the suite was seen losing a whole worker
 * (`[vitest-pool]: Worker forks emitted error` / `Worker exited unexpectedly`,
 * taking two tests that had already passed with it) roughly one full run in
 * five, and a captured-stdio child inside a worker is the plausible trigger.
 * The CLI below stays for manual use.
 * @returns the exact text `src/client/remote-face.ts` should contain.
 */
export function renderRemoteFace() {
  return render()
}

// Only run as a CLI. Imported from a test, this module must not touch the disk.
if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const rendered = render()
  const current = readCheckedInFace()

  if (process.argv.includes('--check')) {
    if (normalizeNewlines(current) === normalizeNewlines(rendered)) {
      console.log(`remote face is up to date: ${relative(root, outPath)}`)
      process.exit(0)
    }
    console.error(`remote face is stale: run \`node build/generate-remote-face.mjs\` to regenerate ${relative(root, outPath)}`)
    process.exit(1)
  }

  if (normalizeNewlines(current) === normalizeNewlines(rendered)) {
    console.log(`remote face unchanged: ${relative(root, outPath)}`)
  } else {
    writeFileSync(outPath, rendered)
    console.log(`remote face written: ${relative(root, outPath)}`)
  }
}
