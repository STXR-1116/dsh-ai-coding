import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react({ jsxRuntime: 'automatic' })],
  esbuild: { jsx: 'automatic', loader: 'tsx', tsconfigRaw: { compilerOptions: { jsx: 'react-jsx' } } },
  oxc: { jsx: { runtime: 'automatic', importSource: 'react', development: false } },
  test: {
    include: ['tests/**/*.spec.ts', 'tests/**/*.spec.tsx'],
    environment: 'jsdom',
  },
})
