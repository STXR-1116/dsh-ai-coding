/** Remove the build output. Needed before every build: a deleted source file
 * otherwise leaves its emitted `lib/*.js` behind, and `pnpm pack` ships it. */
import { rmSync } from 'node:fs'
rmSync(new URL('../lib', import.meta.url), { recursive: true, force: true })
