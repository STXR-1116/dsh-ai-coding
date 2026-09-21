/**
 * Bump the pinned `@deepseek-ai/*` baseline across this repository's
 * manifests: every `0.1.5-rc.2` pin in `package.json` (dependencies,
 * devDependencies) moves to the requested version, and `dsh.plugin.json`'s
 * engines floor moves with it.
 *
 * Usage: `node build/bump-baseline.mjs <version>`
 *
 * @module dsh-ai-coding/build/bump-baseline
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const version = process.argv[2]
if (version === undefined || !/^\d+\.\d+\.\d+/.test(version)) {
  console.error('usage: node build/bump-baseline.mjs <version>')
  process.exit(1)
}

const root = dirname(fileURLToPath(import.meta.url)) + '/..'
const previous = '0.1.5-rc.2'

const manifestPath = join(root, 'package.json')
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
let changed = 0
for (const section of ['dependencies', 'devDependencies', 'peerDependencies']) {
  const entries = manifest[section]
  if (entries === undefined) continue
  for (const [name, specifier] of Object.entries(entries)) {
    if (specifier === previous) {
      entries[name] = version
      changed += 1
    }
  }
}
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)

const pluginJsonPath = join(root, 'dsh.plugin.json')
try {
  const pluginJson = JSON.parse(readFileSync(pluginJsonPath, 'utf8'))
  const text = JSON.stringify(pluginJson, null, 2).replaceAll(previous, version)
  if (text !== JSON.stringify(pluginJson, null, 2)) {
    writeFileSync(pluginJsonPath, `${text}\n`)
    changed += 1
  }
} catch {
  // The metadata file is optional; nothing to bump when it is absent.
}

console.log(`bumped ${changed} pinned specifiers from ${previous} to ${version}`)
if (changed === 0) {
  console.error(`no ${previous} pins found — is the baseline already ${version}?`)
  process.exit(1)
}
