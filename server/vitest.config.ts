import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Only run TypeScript sources. Without this, vitest can also pick up
    // stale compiled `*.test.js` files under dist/ from a previous build.
    include: ['src/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    // Several suites do real work — a git repo with 1000+ files, property-based
    // storage round-trips, real shells. On a busy Windows machine (Defender
    // scanning new files, a console host per child process) the 5 s default
    // flakes even though nothing is wrong.
    testTimeout: 20_000,
  },
})
