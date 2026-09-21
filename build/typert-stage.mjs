// Build a shadow workspace that satisfies the typert generator's three hard
// assumptions (packages/** layout, projectReferences, protocol package
// literally named dsh-typert-protocol reachable under <root>/packages).
// Recipe from docs/typert-wiring-notes.md §2.8. Usage:
//   node build/typert-stage.mjs <stage-root>
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const repo = 'C:/Users/13588/dev/dsh-ai-coding'
const stage = process.argv[2]
if (stage === undefined) { console.error('stage root required'); process.exit(1) }
rmSync(stage, { recursive: true, force: true })
const pkgDir = join(stage, 'packages', 'dsh-ai-coding')
mkdirSync(pkgDir, { recursive: true })
cpSync(join(repo, 'src'), join(pkgDir, 'src'), { recursive: true })
for (const file of ['tsconfig.json', 'tsconfig.base.json']) cpSync(join(repo, file), join(pkgDir, file))
const manifest = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'))
manifest.files = ['lib/typert.host.js', 'lib/typert.host.d.ts', 'lib/typert.remote-client.js', 'lib/typert.remote-client.d.ts']
writeFileSync(join(pkgDir, 'package.json'), JSON.stringify(manifest, null, 2) + '\n')
// A2: every @deepseek-ai/* package the plugin's remote signatures can reach is
// staged as a workspace package under <root>/packages, so the analyzer can name
// the owning package of every referenced type (its ownership model is
// <root>/packages/**). dereference:true — cpSync otherwise copies pnpm's
// symlink and realpathSync stays inside .pnpm.
const protoSrc = join(repo, 'node_modules', '@deepseek-ai', 'dsh-typert-protocol')
cpSync(protoSrc, join(stage, 'packages', 'typert-protocol'), {
  recursive: true, dereference: true,
  filter: (p) => !p.slice(protoSrc.length).includes('node_modules'),
})
writeFileSync(join(stage, 'packages', 'typert-protocol', 'tsconfig.json'), JSON.stringify({ compilerOptions: { noEmit: true } }, null, 2) + '\n')

const manifestDeps = {
  ...manifest.dependencies, ...manifest.peerDependencies,
}
const staged = new Set(['typert-protocol'])
for (const [name] of Object.entries(manifestDeps)) {
  if (!name.startsWith('@deepseek-ai/')) continue
  const short = name.slice('@deepseek-ai/'.length).replace(/^dsh-/, '')
  if (staged.has(short)) continue
  const src = join(repo, 'node_modules', name)
  const dst = join(stage, 'packages', short)
  cpSync(src, dst, { recursive: true, dereference: true, filter: (p) => !p.slice(src.length).includes('node_modules') })
  writeFileSync(join(dst, 'tsconfig.json'), JSON.stringify({ compilerOptions: { noEmit: true, skipLibCheck: true } }, null, 2) + '\n')
  staged.add(short)
  console.log('staged peer:', name, '->', short)
}
// Staged node_modules for the package: junctions, with every staged peer
// pointing at its staged copy so imports resolve inside <root>/packages.
const nm = join(pkgDir, 'node_modules')
mkdirSync(nm, { recursive: true })
const link = (target, at) => symlinkSync(target, at, 'junction')
for (const entry of readdirSync(join(repo, 'node_modules'))) {
  if (entry.startsWith('.')) continue
  const from = join(repo, 'node_modules', entry)
  if (entry.startsWith('@')) {
    const scoped = join(nm, entry)
    mkdirSync(scoped, { recursive: true })
    for (const inner of readdirSync(from)) {
      if (entry === '@deepseek-ai' && staged.has(inner.replace(/^dsh-/, ''))) continue
      link(join(from, inner), join(scoped, inner))
    }
  } else link(from, join(nm, entry))
}
for (const short of staged) {
  mkdirSync(join(nm, '@deepseek-ai'), { recursive: true })
  const target = short === 'cordis' || short === 'schemastery'
    ? join(stage, 'packages', short)
    : join(stage, 'packages', short)
  link(target, join(nm, '@deepseek-ai', short === 'cordis' || short === 'schemastery' ? short : `dsh-${short}`))
}
link(join(repo, 'node_modules'), join(stage, 'node_modules'))
mkdirSync(join(pkgDir, 'lib'), { recursive: true })
const refs = [...staged].map((s) => ({ path: s === 'cordis' || s === 'schemastery' ? `./packages/${s}` : `./packages/${s}` }))
writeFileSync(join(stage, 'tsconfig.host.json'), JSON.stringify({
  extends: './packages/dsh-ai-coding/tsconfig.json',
  compilerOptions: { noEmit: true, rewriteRelativeImportExtensions: false },
  references: [{ path: './packages/dsh-ai-coding' }, ...refs],
}, null, 2) + '\n')
console.log('STAGE BUILT')
