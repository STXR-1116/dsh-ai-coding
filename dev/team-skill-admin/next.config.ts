import path from 'node:path'
import type { NextConfig } from 'next'

// Pin the workspace root to the monorepo root: a stray lockfile in a parent
// directory (e.g. Downloads) otherwise makes Next infer the wrong root and
// warn on every build.
const repoRoot = path.resolve(import.meta.dirname, '../..')

const nextConfig: NextConfig = {
  reactStrictMode: true,
  outputFileTracingRoot: repoRoot,
}

export default nextConfig
