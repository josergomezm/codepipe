import { describe, it, expect } from 'vitest'
import { firebasePortParser } from './firebase-detector.js'
import { normalizeStartCommand, stripAnsi, type ServiceState } from '../service-manager.js'
import type { ProjectServiceConfig } from '../schemas.js'

function feed(lines: string[]): ServiceState {
  const state: ServiceState = { status: 'running', ports: {}, logs: [] }
  for (const raw of lines) {
    const line = stripAnsi(raw).replace(/\r$/, '').trimEnd()
    if (line) firebasePortParser(line, state)
  }
  return state
}

// Verbatim shape of what `firebase emulators:start` writes to stdout, colors included.
const EMULATOR_OUTPUT = [
  '\x1b[90m┌─────────────────────────────────────────────────────────────┐\x1b[39m',
  '\x1b[90m│\x1b[39m \x1b[36mi\x1b[39m  View Emulator UI at \x1b[4m\x1b[1mhttp://127.0.0.1:4000/\x1b[22m\x1b[24m               \x1b[90m│\x1b[39m',
  '\x1b[90m└─────────────────────────────────────────────────────────────┘\x1b[39m',
  '\x1b[90m│\x1b[39m Authentication \x1b[90m│\x1b[39m 127.0.0.1:9099 \x1b[90m│\x1b[39m \x1b[4mhttp://127.0.0.1:4000/auth\x1b[24m      \x1b[90m│\x1b[39m',
  '\x1b[90m│\x1b[39m Functions      \x1b[90m│\x1b[39m 127.0.0.1:5001 \x1b[90m│\x1b[39m \x1b[4mhttp://127.0.0.1:4000/functions\x1b[24m \x1b[90m│\x1b[39m',
  '\x1b[90m│\x1b[39m Firestore      \x1b[90m│\x1b[39m 127.0.0.1:8080 \x1b[90m│\x1b[39m \x1b[4mhttp://127.0.0.1:4000/firestore\x1b[24m \x1b[90m│\x1b[39m',
  '\x1b[90m  Emulator Hub host: 127.0.0.1 port: 4400\x1b[39m',
  '\x1b[90m  Other reserved ports:\x1b[39m 4500, 9150',
]

describe('firebasePortParser', () => {
  it('reads the port table through ANSI coloring', () => {
    const state = feed(EMULATOR_OUTPUT)
    expect(state.ports).toMatchObject({
      authentication: { host: '127.0.0.1', port: 9099 },
      functions: { host: '127.0.0.1', port: 5001 },
      firestore: { host: '127.0.0.1', port: 8080 },
      hub: { host: '127.0.0.1', port: 4400 },
    })
  })

  it('captures the emulator UI url without trailing escape codes', () => {
    expect(feed(EMULATOR_OUTPUT).uiUrl).toBe('http://127.0.0.1:4000/')
  })

  it('ignores the reserved-ports summary line', () => {
    expect(feed(EMULATOR_OUTPUT).ports).not.toHaveProperty('other-reserved-ports')
  })
})

describe('normalizeStartCommand', () => {
  const base: ProjectServiceConfig = {
    id: '00000000-0000-0000-0000-000000000000',
    type: 'firebase-emulators',
    label: 'Firebase Emulators',
    startCommand: 'npm run emulators',
  }

  it('drops a --prefix flag that only repeats the cwd', () => {
    expect(normalizeStartCommand({
      ...base,
      startCommand: 'npm run emulators --prefix firebase',
      cwd: 'firebase',
    })).toBe('npm run emulators')
  })

  it('drops a --cwd flag that only repeats the cwd', () => {
    expect(normalizeStartCommand({
      ...base,
      startCommand: 'pnpm run emulators --cwd firebase',
      cwd: 'firebase',
    })).toBe('pnpm run emulators')
  })

  it('keeps a --prefix pointing somewhere else', () => {
    expect(normalizeStartCommand({
      ...base,
      startCommand: 'npm run build --prefix functions',
      cwd: 'firebase',
    })).toBe('npm run build --prefix functions')
  })

  it('leaves commands without a cwd alone', () => {
    expect(normalizeStartCommand({ ...base, startCommand: 'npm run emulators --prefix firebase' }))
      .toBe('npm run emulators --prefix firebase')
  })
})
