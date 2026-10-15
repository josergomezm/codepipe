import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  firebasePortParser,
  detectFirebaseEmulators,
  buildFirebaseServiceConfig,
  applyFirebasePorts,
} from './firebase-detector.js'
import { normalizeStartCommand, stripAnsi, type ServiceState } from '../service-manager.js'
import type { ProjectServiceConfig } from '../schemas.js'

describe('detectFirebaseEmulators', () => {
  let dir: string
  const write = (emulators: Record<string, unknown>) => {
    writeFileSync(join(dir, 'firebase.json'), JSON.stringify({ emulators }))
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      scripts: { emulators: 'firebase emulators:start' },
    }))
  }

  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'codepipe-firebase-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('stores the explicit ports from firebase.json on the service config', async () => {
    write({
      auth: { port: 9199 },
      firestore: { port: 8180, websocketPort: 9250 },
      ui: { port: 4100 },
      hub: { port: 4500 },
      logging: { port: 4600 },
    })
    const config = buildFirebaseServiceConfig(await detectFirebaseEmulators(dir))
    expect(config?.ports).toEqual({
      auth: 9199, firestore: 8180, firestoreWebsocket: 9250, ui: 4100, hub: 4500, logging: 4600,
    })
  })

  it('falls back to Firebase defaults for emulators without a port', async () => {
    write({ auth: { port: 9199 }, firestore: {}, ui: { enabled: true } })
    const config = buildFirebaseServiceConfig(await detectFirebaseEmulators(dir))
    expect(config?.ports).toEqual({
      auth: 9199, firestore: 8080, firestoreWebsocket: 9150, ui: 4000, hub: 4400, logging: 4500,
    })
  })

  it('leaves out a UI the config disables', async () => {
    write({ auth: { port: 9199 }, ui: { enabled: false } })
    const detection = await detectFirebaseEmulators(dir)
    expect(detection.defaultPorts).toEqual({ auth: 9199, hub: 4400, logging: 4500 })
  })

  it('takes the emulator ports from ports.json when the repo has one', async () => {
    write({ auth: { port: 9099 } })
    writeFileSync(join(dir, 'ports.json'), JSON.stringify({
      app: { vite: 5180 },
      emulators: { auth: 10103, hub: 10101, firestoreWebsocket: 10106 },
    }))
    const detection = await detectFirebaseEmulators(dir)
    expect(detection.portsSource).toBe('ports.json')
    expect(detection.defaultPorts).toEqual({ auth: 10103, hub: 10101, firestoreWebsocket: 10106 })
  })

  it('falls back to firebase.json when ports.json is malformed', async () => {
    write({ auth: { port: 9199 } })
    writeFileSync(join(dir, 'ports.json'), '{ "emulators": { "auth": "nope" } }')
    const detection = await detectFirebaseEmulators(dir)
    expect(detection.portsSource).toBe('firebase.json')
    expect(detection.defaultPorts['auth']).toBe(9199)
  })

  it('refreshes stored ports on an existing service only when they changed', async () => {
    write({ firestore: { port: 8180 } })
    const detection = await detectFirebaseEmulators(dir)
    const svc: ProjectServiceConfig = {
      id: '00000000-0000-0000-0000-000000000000',
      type: 'firebase-emulators',
      label: 'Firebase Emulators',
      startCommand: 'npm run emulators',
    }
    const updated = applyFirebasePorts([svc], detection)
    expect(updated?.[0].ports).toEqual({
      firestore: 8180, firestoreWebsocket: 9150, ui: 4000, hub: 4400, logging: 4500,
    })
    expect(applyFirebasePorts(updated!, detection)).toBeNull()
  })
})

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
