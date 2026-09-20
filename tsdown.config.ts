/**
 * tsdown config for this plugin package: the dual-half build.
 *
 * `pnpm build` runs `tsc -p tsconfig.json` (emits JavaScript plus declarations
 * under `lib/types`) and then `tsdown`, which builds BOTH halves from the
 * preset in `./build/tsdown.client.ts`:
 *
 * - the node half from the tsc output (`lib/types/*.js` → `lib/*.js`), and
 * - the browser half from the TypeScript sources
 *   (`src/client/index.ts` → `lib/client.js`), a closure-factory bundle whose
 *   first line hands it to `window.__ModuleLoader__.load`.
 *
 * The entries are spelled here, at the call site, so the package-invariants
 * gate can see `lib/types/invariant.js` in this package's own tsdown config
 * (a preset-side glob would hide it from the mechanical check).
 *
 * @module dsh-ai-coding/tsdown.config
 */
import { clientBundle } from './build/tsdown.client.ts'

/** The package name: the plugin id, the `__ModuleLoader__` registration key, and the boot-graph row id. */
const PACKAGE_NAME = 'dsh-ai-coding'

export default clientBundle(PACKAGE_NAME, [
  // Host half: the Cordis plugin (default export = TeamSkillGateway).
  'lib/types/index.js',
  // Host half: the package-owned invariant companion.
  'lib/types/invariant.js',
  // Host half: the cloud-workspace Remote face mounted as its own row.
  'lib/types/workspace-gateway.js',
  // Merged-in client-package node halves (the former two-package split).
  'lib/types/client-node/index.js',
  'lib/types/client-node/invariant.js',
])
