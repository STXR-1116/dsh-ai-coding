/* Exhaustive audit: is any Jev/TypeSafe code left where it could run?
 *
 * Written because two earlier passes were too shallow to be trusted: the first
 * grepped four strings in the entry bundle, the second found a stale
 * `lib/recall-gate.js` that the first had missed. This one scans every file in
 * every place the plugin is built, packed, installed or composed from, and
 * separates "code that could execute" from "prose that merely mentions it" —
 * because only the first is what the owner asked to be removed.
 */
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, relative } from 'node:path'

const repo = 'C:/Users/13588/dev/dsh-ai-coding'
const profile = join(homedir(), '.dsh', 'profiles', 'web')
const installed = join(profile, 'node_modules', 'dsh-ai-coding')
const tarball = join(repo, 'dsh-ai-coding-0.1.9.tgz')

/** Everything that would indicate the model, its API, or the gate. */
const CODE_PATTERN = /typesafe|type_safe|api\.typesafe|jev-1|jev-latest|\bnoul\b|systemone|system_one|recall-?gate/iu
/** Files that need not be read (binary, huge, or not code). */
const SKIP_EXT = /\.(png|jpg|jpeg|gif|webp|ico|zip|gz|zst|zstd|woff2?|ttf|exe|dll|node|map|tsbuildinfo)$/iu

let totalHits = 0

/** Walk every file under `dir`, skipping the named subdirectories. */
function* walk(dir, skip = []) {
  let entries
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
  for (const entry of entries) {
    if (skip.includes(entry.name)) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) yield* walk(full, skip)
    else if (entry.isFile()) yield full
  }
}

/** Scan one area; report hits with the matching token only.
 *  `counts` marks an area as shipping/running code: only those feed the verdict,
 *  so the audit's own tooling mentioning the pattern cannot make it cry wolf. */
function scan(label, roots, { skip = [], skipExt = SKIP_EXT, counts = true } = {}) {
  const hits = []
  let files = 0
  for (const root of roots) {
    if (!existsSync(root)) { hits.push({ file: `${root} — 不存在`, token: 'n/a' }); continue }
    for (const file of walk(root, skip)) {
      if (skipExt.test(file)) continue
      files += 1
      let text
      try { text = readFileSync(file, 'utf8') } catch { continue }
      const match = CODE_PATTERN.exec(text)
      if (match) hits.push({ file: relative(root, file) || file, token: match[0], root })
      CODE_PATTERN.lastIndex = 0
    }
  }
  if (counts) totalHits += hits.length
  console.log(`\n## ${label}`)
  console.log(`   扫描文件: ${files}   命中: ${hits.length}${counts ? '' : '   （工具脚本，不发布、不参与结论）'}`)
  for (const hit of hits.slice(0, 40)) console.log(`   !! ${hit.root === undefined ? hit.file : `${relative(hit.root, hit.file)}  [${hit.token}]`}`)
  if (hits.length > 40) console.log(`   … 另有 ${hits.length - 40} 处`)
  return hits
}

console.log('=== Jev / TypeSafe 全量审计 ===')
console.log(`正则: ${String(CODE_PATTERN)}`)

// A. Source that ships or is executed.
scan('A. 仓库源码 src/ (会被构建的东西)', [join(repo, 'src')])
// B. Tests and dev fixture — not shipped, but code.
scan('B. 仓库 tests/ 与 dev/ (不发布，但是代码)', [join(repo, 'tests'), join(repo, 'dev')])
// C. Build tooling — not shipped (package.json `files` is lib + patch), but repo code.
scan('C. 仓库 build/ (工具脚本，不发布)', [join(repo, 'build')], { counts: false })
// D. Build output in the repo.
scan('D. 仓库构建产物 lib/', [join(repo, 'lib')])
// E. The tarball: extract and scan what actually ships.
console.log('\n## E. 打包产物 dsh-ai-coding-0.1.9.tgz（实际发布内容）')
if (existsSync(tarball)) {
  const staging = mkdtempSync(join(tmpdir(), 'dsh-tgz-'))
  execFileSync('tar', ['-xzf', tarball, '-C', staging])
  const packed = join(staging, 'package')
  const files = [...walk(packed)]
  let hits = 0
  for (const file of files) {
    if (SKIP_EXT.test(file)) continue
    const match = CODE_PATTERN.exec(readFileSync(file, 'utf8'))
    if (match) { hits += 1; console.log(`   !! ${relative(packed, file)}  [${match[0]}]`) }
    CODE_PATTERN.lastIndex = 0
  }
  totalHits += hits
  console.log(`   包内文件总数: ${files.length}   命中: ${hits}`)
  console.log(`   包内含 recall-gate.js: ${existsSync(join(packed, 'lib', 'recall-gate.js'))}`)
  rmSync(staging, { recursive: true, force: true })
} else { console.log('   tarball 不存在'); totalHits += 1 }

// F. The installed copy — what the running host loads.
scan('F. 已安装副本（host + client 两半）', [join(installed, 'lib')])
// G. Repo node_modules: any TypeSafe SDK pulled in?
console.log('\n## G. 仓库 node_modules 中的 typesafe 包')
const mods = join(repo, 'node_modules')
const sdk = existsSync(mods) ? readdirSync(mods).filter(name => /typesafe/iu.test(name)) : []
console.log(`   @typesafe* / typesafe*: ${sdk.length === 0 ? '无' : sdk.join(', ')}`)
const scope = join(mods, '@typesafe')
console.log(`   @typesafe 作用域目录: ${existsSync(scope)}`)

// H. How the plugin is composed and declared.
console.log('\n## H. 组合与声明')
const repoPkg = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'))
const deps = { ...repoPkg.dependencies, ...repoPkg.devDependencies, ...repoPkg.peerDependencies }
console.log(`   repo 依赖含 typesafe: ${Object.keys(deps).filter(name => /typesafe/iu.test(name)).join(', ') || '无'}`)
console.log(`   repo files 字段: ${JSON.stringify(repoPkg.files)}`)
const profilePkg = JSON.parse(readFileSync(join(profile, 'package.json'), 'utf8'))
console.log(`   profile 依赖含 typesafe: ${Object.keys(profilePkg.dependencies ?? {}).filter(name => /typesafe/iu.test(name)).join(', ') || '无'}`)
console.log(`   profile bundles: ${(profilePkg.dsh?.profile?.bundles ?? []).join(', ')}`)
for (const [label, file] of [['仓库 patch', join(repo, 'cordis.patch.yml')], ['已安装 patch', join(installed, 'cordis.patch.yml')], ['profile patch', join(profile, 'cordis.patch.yml')]]) {
  if (!existsSync(file)) { console.log(`   ${label}: 不存在`); continue }
  const text = readFileSync(file, 'utf8')
  const match = CODE_PATTERN.exec(text)
  if (match) { totalHits += 1; console.log(`   !! ${label} 含 [${match[0]}]`) } else { console.log(`   ${label}: 零匹配`) }
  CODE_PATTERN.lastIndex = 0
}

// I. git: history keeps the removed commits (normal), the tree must not.
console.log('\n## I. git 状态')
// `git grep` exits 1 when nothing matches — that is the answer we want, not an error.
let headHits = ''
try {
  headHits = execFileSync('git', ['grep', '-Iil', '-E', 'typesafe|jev-1|noul|systemone|recall-gate', 'HEAD', '--', 'src', 'tests'], { cwd: repo, encoding: 'utf8' }).trim()
} catch (error) {
  headHits = error.status === 1 ? '' : `git grep 失败: ${error.message}`
}
console.log(`   git grep HEAD (src, tests): ${headHits === '' ? '零匹配' : headHits}`)
const history = execFileSync('git', ['log', '--oneline', '--all', '--', 'src/recall-gate.ts'], { cwd: repo, encoding: 'utf8' }).trim()
console.log(`   历史中仍可检出 src/recall-gate.ts 的提交:`)
for (const line of history.split('\n')) console.log(`     ${line}`)
console.log('   （历史保留已删除的提交是正常的：发布内容由 E 区、运行内容由 F 区决定）')

// J. What remains on purpose.
console.log('\n## J. 有意保留的提及（文档，不是代码）')
for (const file of ['docs/typesafe-recall-gate.md', 'AGENTS.md', 'docs/dsh-docs-index.md']) {
  const full = join(repo, file)
  if (!existsSync(full)) { console.log(`   ${file}: 不存在`); continue }
  const text = readFileSync(full, 'utf8')
  const count = (text.match(new RegExp(CODE_PATTERN.source, 'giu')) ?? []).length
  console.log(`   ${file}: ${count} 处提及，${statSync(full).size} 字节`)
}

console.log(`\n=== 合计命中（A–H，即可能执行的代码与组合声明）: ${totalHits} ==="`)
console.log(totalHits === 0 ? '结论：插件中不存在任何 Jev/TypeSafe 代码。' : '结论：仍有命中，见上。')
