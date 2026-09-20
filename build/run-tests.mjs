/**
 * Run the test suite, retrying only when the run failed for infrastructure
 * reasons rather than because a test failed.
 *
 * ## Why this exists
 *
 * On this machine (Windows, Node v24.15.0) roughly half of `vitest run`
 * invocations lose one Vitest worker to
 *
 *     [vitest-pool]: Worker forks emitted error.
 *     Caused by: Error: Worker exited unexpectedly
 *
 * The affected spec is random and always passes on its own; no test asserts
 * anything wrong. The diagnosis is in `docs/ADAPTATION-GOAL.md` §"门禁 2 的现状":
 * a worker that never runs its `process.on('exit')` handler means the parent
 * terminated it, and the same defect is recorded in the reference
 * implementation's own `vitest.config.ts` for Node 24. It is not caused by this
 * repository — pool (`forks`/`threads`/`vmThreads`), isolation, file
 * parallelism, project split and `execArgv` were all varied without effect.
 *
 * Retrying an infrastructure failure is standard CI practice. What matters is
 * that the retry can never hide a real failure, so the classification is
 * deliberately strict: **any** reported test failure, snapshot mismatch or
 * non-zero `Tests … failed` count aborts immediately with no retry.
 *
 * Every attempt's raw summary is printed, so a reader always sees how many
 * attempts were needed and why the earlier ones were retried.
 *
 * Usage: `node build/run-tests.mjs [--max-attempts N] [-- vitest args…]`
 *
 * @module dsh-ai-coding/build/run-tests
 */

import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

const argOf = (name, fallback) => {
  const index = process.argv.indexOf(name)
  return index === -1 ? fallback : Number(process.argv[index + 1])
}
const maxAttempts = argOf('--max-attempts', 3)
const passthrough = process.argv.includes('--') ? process.argv.slice(process.argv.indexOf('--') + 1) : []

/** Infrastructure-only symptoms: the run died without a single assertion failing. */
const INFRASTRUCTURE_PATTERNS = [
  /Worker exited unexpectedly/u,
  /Worker forks emitted error/u,
  /\[vitest-pool\]/u,
]

/**
 * Classify one attempt.
 * @param output - combined stdout/stderr of the run.
 * @param status - the child's exit status.
 * @returns `'green'`, `'test-failure'` (never retried) or `'infrastructure'`.
 */
function classify(output, status) {
  if (status === 0) return 'green'

  // Any real test-level failure wins immediately. Vitest prints one `FAIL` block
  // per failing test and a `Tests … failed` tally; both are checked so a failure
  // can never be reclassified as infrastructure.
  const failedCount = /Tests\s+.*?(\d+)\s+failed/u.exec(output)
  if (failedCount !== null && Number(failedCount[1]) > 0) return 'test-failure'
  if (/^\s*FAIL\s+\|/mu.test(output)) return 'test-failure'
  if (/Snapshot .* mismatched/u.test(output)) return 'test-failure'
  if (/^\s*Test Files\s+.*?\d+\s+failed/mu.test(output)) return 'test-failure'

  return INFRASTRUCTURE_PATTERNS.some(pattern => pattern.test(output)) ? 'infrastructure' : 'test-failure'
}

/** Print only the run's summary lines, so the log stays readable across attempts. */
function summarise(output) {
  return output
    .split('\n')
    .filter(line => /^\s*(Test Files|Tests|Errors|Duration)\s+/u.test(line) || /^\s*SMOKE |Worker exited unexpectedly/u.test(line))
    .map(line => `    ${line.trim()}`)
    .join('\n')
}

for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
  console.log(`\n=== pnpm test — attempt ${attempt}/${maxAttempts} ===`)
  const run = spawnSync('pnpm', ['exec', 'vitest', 'run', ...passthrough], {
    cwd: root,
    encoding: 'utf8',
    shell: true,
    maxBuffer: 64 * 1024 * 1024,
  })
  const output = `${run.stdout ?? ''}${run.stderr ?? ''}`
  process.stdout.write(output)

  const verdict = classify(output, run.status ?? 1)
  if (verdict === 'green') {
    console.log(`\nTEST RESULT: green on attempt ${attempt}/${maxAttempts}`)
    process.exit(0)
  }
  if (verdict === 'test-failure') {
    console.log('\nTEST RESULT: real test failure(s) — not retrying')
    console.log(summarise(output))
    process.exit(run.status ?? 1)
  }

  console.log(`\nTEST RESULT: attempt ${attempt} lost a worker process; no test failed.`)
  console.log(summarise(output))
  if (attempt === maxAttempts) {
    console.log(`\nTEST RESULT: still infrastructure-failing after ${maxAttempts} attempts — see docs/ADAPTATION-GOAL.md §"门禁 2 的现状".`)
    process.exit(run.status ?? 1)
  }
  console.log('  retrying…')
}
