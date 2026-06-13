import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Only run TypeScript sources. Without this, vitest can also pick up
    // stale compiled `*.test.js` files under dist/ from a previous build.
    include: ['src/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
  },
})
