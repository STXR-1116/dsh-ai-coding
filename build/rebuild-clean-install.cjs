/* Clean-build + repack + offline install, driven from one script so nothing is
   quoted through a shell. Fixes the root cause found by the second-pass check:
   the build never cleaned `lib/`, so deleting `src/recall-gate.ts` left
   `lib/recall-gate.js` on disk and `pnpm pack` shipped it. */
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const root = 'C:/Users/13588/dev/dsh-ai-coding'
const home = process.env.USERPROFILE
const profile = path.join(home, '.dsh', 'profiles', 'web')
process.chdir(root)

/** Run a command, inherit stdio, and fail loudly. */
function run(command, args, cwd = root) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', shell: true })
  if (result.status !== 0) { console.log(`FAILED: ${command} ${args.join(' ')} (status ${result.status})`); process.exit(1) }
}

// 1) A dedicated cleaner, so the build script needs no nested quoting.
fs.writeFileSync(path.join(root, 'build', 'clean-lib.mjs'),
  `/** Remove the build output. Needed before every build: a deleted source file\n * otherwise leaves its emitted \`lib/*.js\` behind, and \`pnpm pack\` ships it. */\nimport { rmSync } from 'node:fs'\nrmSync(new URL('../lib', import.meta.url), { recursive: true, force: true })\n`)
console.log('ok  wrote build/clean-lib.mjs')

// 2) package.json: clean script, build runs it first, version bump.
const pkgPath = path.join(root, 'package.json')
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
pkg.scripts.clean = 'node build/clean-lib.mjs'
if (!pkg.scripts.build.startsWith('pnpm run clean')) pkg.scripts.build = `pnpm run clean && ${pkg.scripts.build}`
pkg.version = '0.1.9'
fs.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`)
console.log(`ok  build script -> ${pkg.scripts.build}`)
console.log(`ok  version -> ${pkg.version}`)

// 3) Clean, build, pack.
run('pnpm', ['build'])
const stale = fs.existsSync(path.join(root, 'lib', 'recall-gate.js'))
console.log(`ok  lib/recall-gate.js still present: ${stale}   (must be false)`)
if (stale) process.exit(1)
run('pnpm', ['pack'])

// 4) Point the profile at the new tarball and install offline.
const installed = path.join(profile, 'node_modules', 'dsh-ai-coding')
const tgz = path.join(root, 'dsh-ai-coding-0.1.9.tgz')
if (!fs.existsSync(tgz)) { console.log('FAILED: tarball missing'); process.exit(1) }
const profilePkgPath = path.join(profile, 'package.json')
const profilePkg = JSON.parse(fs.readFileSync(profilePkgPath, 'utf8'))
profilePkg.dependencies['dsh-ai-coding'] = `file:${tgz.replace(/\\/g, '/')}`
fs.writeFileSync(profilePkgPath, `${JSON.stringify(profilePkg, null, 2)}\n`)
run('pnpm', ['install', '--offline'], profile)

// 5) Verify every emitted file, not just the entry point — the shallow check is
//    exactly what let recall-gate.js survive the first removal.
console.log(`ok  installed version: ${JSON.parse(fs.readFileSync(path.join(installed, 'package.json'), 'utf8')).version}`)
const pattern = /typesafe|jev|noul|recall-?gate|systemone/i
let offenders = 0
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) { walk(full); continue }
    if (!entry.name.endsWith('.js')) continue
    const text = fs.readFileSync(full, 'utf8')
    const found = text.match(pattern)
    if (found) { offenders += 1; console.log(`  !! ${path.relative(installed, full)} -> ${found[0]}`) }
  }
}
walk(path.join(installed, 'lib'))
console.log(offenders === 0
  ? 'ok  已安装副本全量扫描：零匹配（host + client 两半，逐文件）'
  : `FAILED: ${offenders} 个文件仍含 Jev/TypeSafe 匹配`)
console.log(`ok  recall-gate.js 存在: ${fs.existsSync(path.join(installed, 'lib', 'recall-gate.js'))}   (must be false)`)
