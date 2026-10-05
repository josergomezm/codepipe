/**
 * The stuck-turn watchdog and Stop, against a real (silent) child process.
 * The notice threshold is lowered to ~1 s for the test.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

vi.hoisted(() => {
  process.env['CLI_STUCK_NOTICE_MINUTES'] = '0.02' // 1.2 s
})

import { mkdtemp, rm } from 'fs/promises'
import { spawnSync } from 'child_process'
import os from 'os'
import path from 'path'

import { StorageLayer } from './storage.js'
import { SessionManager } from './session-manager.js'
import { registerAdapter, clearAdapters } from './adapters/registry.js'
import type { ICLIAdapter } from './adapters/types.js'

/**
 * A CLI that prints nothing for 20 s — optionally after starting a grandchild
 * that prints its pid. The grandchild is `detached` because Node puts its own
 * children in a job object that dies with it; native CLIs like Kiro don't, so
 * their children survive a plain kill — which is what this has to model.
 */
function silentCli(withGrandchild = false): ICLIAdapter {
  const script = withGrandchild
    ? `const g = require('child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore', windowsHide: true, detached: true }); g.unref(); process.stderr.write('grandchild=' + g.pid + '\\n'); setTimeout(() => {}, 20000)`
    : 'setTimeout(() => {}, 20000)'
  return {
    provider: 'kiro',
    command: process.execPath,
    args: [],
    transport: 'oneshot',
    onData: (line) => (line.trim() ? [{ type: 'chunk', role: 'assistant', content: line }] : []),
    buildMessageCommand: () => ({ command: process.execPath, args: ['-e', script] }),
  }
}

let tmpDir: string
let storage: StorageLayer
let manager: SessionManager

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), 'codepipe-watchdog-'))
  storage = new StorageLayer(tmpDir)
  await storage.ensureDataDir()
  manager = new SessionManager(storage)
})

afterEach(async () => {
  await manager.shutdown()
  clearAdapters()
  await rm(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
})

async function startSilentTurn(adapter: ICLIAdapter) {
  registerAdapter('kiro', () => adapter)
  const project = await storage.addProject({ name: 'p', path: tmpDir })
  const session = await manager.createSession('kiro', project.id)
  manager.handleInput(session.id, 'run the tests')
  return session.id
}

const systemTexts = (sessionId: string) =>
  (manager.getSession(sessionId)?.messages ?? []).filter((m) => m.role === 'system').map((m) => m.content)

describe('stuck-turn watchdog', () => {
  it('tells the user when a CLI goes silent, and Stop is not reported as a failure', async () => {
    const id = await startSilentTurn(silentCli())
    await vi.waitFor(() => {
      expect(systemTexts(id).some((t) => t.includes("hasn't produced any output"))).toBe(true)
    }, { timeout: 15_000, interval: 100 })
    // Exactly one notice per turn.
    await new Promise((r) => setTimeout(r, 2000))
    expect(systemTexts(id).filter((t) => t.includes("hasn't produced any output"))).toHaveLength(1)

    manager.cancelTurn(id)
    await new Promise((r) => setTimeout(r, 1000))
    expect(systemTexts(id).some((t) => t.includes('exited unexpectedly'))).toBe(false)
  })
})

describe.runIf(process.platform === 'win32')('Stop ends the whole CLI process tree (Windows)', () => {
  it('kills what the CLI started, not just the CLI', async () => {
    const adapter = silentCli(true)
    let grandchild = 0
    // Capture the grandchild pid the fake CLI reports on stderr.
    const origStderr = adapter.onStderr
    adapter.onStderr = (text) => {
      const m = /grandchild=(\d+)/.exec(text)
      if (m) grandchild = Number(m[1])
      return origStderr ? origStderr(text) : []
    }
    const id = await startSilentTurn(adapter)
    await vi.waitFor(() => expect(grandchild).toBeGreaterThan(0), { timeout: 10_000 })
    manager.cancelTurn(id)
    await new Promise((r) => setTimeout(r, 1000))
    const alive = spawnSync('tasklist', ['/FI', `PID eq ${grandchild}`, '/NH'], { encoding: 'utf8', windowsHide: true }).stdout.includes(String(grandchild))
    expect(alive).toBe(false)
  })
})
