import ts from 'typescript'
import { defineConfig } from 'vitest/config'

/**
 * Root test configuration for the single-package `dsh-ai-coding` plugin.
 *
 * Three suites run under `pnpm test` as independent Vitest projects, because
 * each needs a different environment and plugin chain:
 *
 * | Project | Suite | Environment |
 * | --- | --- | --- |
 * | `plugin` | `tests/**` — the 104 ported host/browser specs | `node` (+ 24 per-file `jsdom` pragmas) |
 * | `fixture` | `dev/team-skill-service/tests/**` — the self-contained demo backend | `node` |
 * | `admin` | `dev/team-skill-admin/tests/**` — the Next.js console | `jsdom` |
 *
 * The `plugin` project inherits the reference workspace's two load-bearing
 * settings:
 * - standard TypeScript decorator lowering, because the host gateways declare
 *   their Remotes with `@Remote(...)` and Vite's default parser rejects the
 *   syntax before esbuild sees it;
 * - `--no-webstorage` where Node supports it, so process-wide Web Storage
 *   cannot shadow the jsdom lanes' storage.
 */

const DECORATOR_SYNTAX = /^\s*@[A-Za-z_$][\w$]*/m

/** Key the reference workspace's JSX compile behavior for `apps/**`-era `.tsx` suites. */
const TSX_SUFFIX = /\.tsx$/u

/**
 * Lower standard TypeScript decorators before Vite's default parser sees the file.
 * @returns a pre-enforce Vite plugin (also transpiles `.tsx` so no React plugin is needed for the ported browser specs).
 */
function standardDecoratorPlugin(): {
  name: string
  enforce: 'pre'
  transform: (code: string, id: string) => { code: string; map: string | undefined } | undefined
} {
  return {
    name: 'dsh-standard-decorators',
    enforce: 'pre',
    transform(code: string, id: string) {
      const file = id.split('?', 1)[0] ?? id
      if (!/\.[cm]?tsx?$/.test(file) || !DECORATOR_SYNTAX.test(code)) return
      const result = ts.transpileModule(code, {
        fileName: file,
        compilerOptions: {
          target: ts.ScriptTarget.ES2024,
          module: ts.ModuleKind.ESNext,
          jsx: TSX_SUFFIX.test(file) ? ts.JsxEmit.ReactJSX : undefined,
          sourceMap: true,
        },
      })
      return {
        code: result.outputText.replace(/\n?\/\/# sourceMappingURL=.*$/u, '\n'),
        map: result.sourceMapText,
      }
    },
  }
}

/**
 * Worker arguments that keep process-wide Web Storage from shadowing jsdom storage.
 * Node lists the positive spelling in `allowedNodeEnvironmentFlags` for this negatable flag.
 */
const execArgv = process.allowedNodeEnvironmentFlags.has('--webstorage') ? ['--no-webstorage'] : []

export default defineConfig({
  test: {
    // Run spec files one at a time.
    //
    // Two of the ported suites model real elapsed time in the demo backend and
    // therefore contain wall-clock races that are inherent to the reference
    // implementation, not to this port: `dev/team-skill-service/src/workspace-fixture.ts`
    // advances a freshly created Run out of `preparing` after 40 ms and a started
    // Workspace into `ready` after 200 ms, and the specs assert inside those
    // windows. Under file-level parallelism the HTTP round trips lose that race
    // on a loaded machine — measured, three full runs: 2, 2 and 3 failures,
    // always the same tests (`run-checkpoint.spec.ts` "preparing 不可暂停" and
    // `cloud-workspaces.client.spec.tsx` "…lets the fixture reach ready"); run
    // serially the same suites are 3/3 green.
    //
    // Both the specs and the fixture are byte-identical to the reference
    // (verified with a line diff), so the fix belongs in the runner, not in the
    // tests: changing the fixture's timings would change the demo backend's
    // behaviour, and loosening the assertions would stop testing the window.
    // The reference splits its own timing-sensitive suites into a separate
    // project for the same reason ("timing-sensitive process I/O that worker
    // threads cannot isolate reliably under aggregate gate contention" —
    // `vitest.config.ts`) and pins `fileParallelism: false` on its web lane
    // (`vitest.web.config.ts`).
    fileParallelism: false,
    projects: [
      {
        plugins: [standardDecoratorPlugin()],
        oxc: { jsx: { runtime: 'automatic', importSource: 'react', development: false } },
        test: {
          name: 'plugin',
          // Node 24 has aborted in its CJS lexer from worker threads on every
          // platform; forked workers avoid that shared thread path.
          pool: 'forks',
          execArgv,
          environment: 'node',
          include: ['tests/**/*.spec.ts', 'tests/**/*.spec.tsx'],
          // The published first-party client packages ship CSS beside their JS
          // (`dsh-client-ui-primitives/lib/StateDot.module.css` and friends) and
          // import it from their entry. Vite externalizes `node_modules` by
          // default, which hands the `.css` request to Node's native ESM loader
          // (`TypeError: Unknown file extension ".css"`), so those packages must
          // be inlined and their CSS processed by Vite like first-party source.
          css: true,
          server: { deps: { inline: [/@deepseek-ai\/dsh-client/] } },
        },
      },
      {
        test: {
          name: 'fixture',
          pool: 'forks',
          execArgv,
          environment: 'node',
          include: ['dev/team-skill-service/tests/**/*.spec.ts'],
        },
      },
      {
        plugins: [standardDecoratorPlugin()],
        oxc: { jsx: { runtime: 'automatic', importSource: 'react', development: false } },
        test: {
          name: 'admin',
          pool: 'forks',
          execArgv,
          environment: 'jsdom',
          include: ['dev/team-skill-admin/tests/**/*.spec.ts', 'dev/team-skill-admin/tests/**/*.spec.tsx'],
          // Same first-party client CSS inlining as the `plugin` project: the
          // admin chain renders the real `AgentConfigView`, which imports
          // `@deepseek-ai/dsh-client-ui-primitives`.
          css: true,
          server: { deps: { inline: [/@deepseek-ai\/dsh-client/] } },
        },
      },
    ],
  },
})
