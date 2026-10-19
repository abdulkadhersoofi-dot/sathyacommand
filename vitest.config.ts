import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: { include: ['packages/*/test/**/*.test.ts', 'server/test/**/*.test.ts'] },
})
