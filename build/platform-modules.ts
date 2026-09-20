/**
 * Shared browser platform modules. Seeding, bundling externals, and Vite
 * aliases consume this list so their module identities cannot drift.
 *
 * Re-synced for the npm `@deepseek-ai/*` `0.1.5-rc.2` baseline against the
 * shipped web shell's own seed table (the `by()` factory that builds
 * `staticModules` in `@deepseek-ai/dsh-web-frontend/dist`, the only consumer
 * that can answer a bare `require()` from a plugin factory).
 *
 * Baseline diff, `0.1.1-rc.2` -> `0.1.5-rc.2`:
 *   + `@deepseek-ai/dsh-client-store`       (new platform module: the store engine
 *                                            that used to ride the runtime package)
 *   + `@deepseek-ai/dsh-client-ui-dockkit`  (new platform module: docking surface kit)
 *   - `@deepseek-ai/dsh-client-runtime`     (package withdrawn; see
 *                                            {@link PRELOADED_CLIENT_EXTERNALS})
 */

/** The module specifiers the shell shares into the frozen module table. */
export const PLATFORM_MODULES = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
] as const

/**
 * Client-bundle specifiers whose factories the parser preloads before the shell
 * starts.
 *
 * The `0.1.1-rc.2` mirror carried `@deepseek-ai/dsh-client-runtime/client` here
 * as the documented snapshot-store exemption (runtime was an immediately-tier
 * row whose factory registered before any dependent bundle materialized). The
 * `0.1.5-rc.2` baseline withdrew that package outright: the store engine is now
 * the `@deepseek-ai/dsh-client-store` platform module above, so no bundle
 * specifier needs preloading on this baseline.
 */
export const PRELOADED_CLIENT_EXTERNALS = [] as const

/** One platform module specifier (a seed-table key). */
export type PlatformModule = (typeof PLATFORM_MODULES)[number]
