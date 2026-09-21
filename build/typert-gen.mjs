// Drive the typert generator over the staged workspace. Usage:
//   node build/typert-gen.mjs <stage-root>
// Emits typert.host.js/.d.ts (+ remote-client when the face carries one) into
// the staged package's lib/, then the caller copies them back into the repo.
import { WorkspaceTypertGenerator } from 'file:///C:/Users/13588/dev/dsh-ai-coding/node_modules/@deepseek-ai/dsh-typert-generator/lib/index.js'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const root = process.argv[2]
const FACES = ['host']
const generator = new WorkspaceTypertGenerator(root, { checkDiagnostics: false })
const discovered = generator.discover(FACES)
console.log('DISCOVERED=' + JSON.stringify(discovered))
const artifacts = generator.generate(undefined, FACES)
for (const a of artifacts) {
  const out = join(root, a.packageRoot, 'lib')
  mkdirSync(out, { recursive: true })
  writeFileSync(join(out, `typert.${a.face}.js`), a.js)
  writeFileSync(join(out, `typert.${a.face}.d.ts`), a.dts)
  if (a.remote !== undefined) {
    writeFileSync(join(out, 'typert.remote-client.js'), a.remote.js)
    writeFileSync(join(out, 'typert.remote-client.d.ts'), a.remote.dts)
    writeFileSync(join(out, 'typert.remote-client.d.ts.map'), a.remote.dtsMap)
  }
}
console.log('ARTIFACTS=' + JSON.stringify(artifacts.map(a => ({ pkg: a.package, face: a.face, hasRemote: a.remote !== undefined }))))
