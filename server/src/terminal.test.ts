/**
 * Terminal failure paths, against a real HTTP server, real WebSocket clients
 * and real shells. Each case must leave the server running: an exception
 * escaping a socket or pty event handler would crash the whole backend.
 *
 * `npm test` runs this file in its own pass. Alongside other test files in
 * parallel Vitest workers, node-pty on Windows occasionally takes its worker
 * process down while shells are torn down (a test-runner interaction — the
 * same kill sequences are stable in a normal Node process).
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { createServer, type Server } from 'http'
import type { AddressInfo } from 'net'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import WebSocket from 'ws'

import { TerminalManager } from './terminal-manager.js'
import { createTerminalUpgradeHandler, TERMINAL_CLOSE } from './terminal-ws.js'

interface Frame { type: string; message?: string; data?: string; shellId?: string; code?: number }

let server: Server
let port: number
let terminals: TerminalManager
const projectDir = mkdtempSync(path.join(tmpdir(), 'codepipe-term-'))
const projects: Record<string, string> = {
  ok: projectDir,
  gone: path.join(projectDir, 'deleted-folder'),
}

beforeAll(async () => {
  terminals = new TerminalManager()
  const storage = { getProject: async (id: string) => (projects[id] ? { id, path: projects[id] } : null) }
  const handler = createTerminalUpgradeHandler(storage as never, terminals)
  server = createServer((_req, res) => res.end('alive'))
  server.on('upgrade', (req, socket, head) => handler(req, socket, head))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  port = (server.address() as AddressInfo).port
})

afterEach(() => {
  delete process.env['CODEPIPE_SHELL']
  terminals.killAll('test cleanup')
})

afterAll(async () => {
  terminals.killAll('test cleanup')
  // On Windows a shell that's still exiting holds a lock on its folder, and
  // node-pty's output-reader threads need a moment to wind down: a process
  // that exits while they're still running can crash at the native level.
  await waitFor(() => terminals.shellCount() === 0).catch(() => {})
  await new Promise((r) => setTimeout(r, 1500))
  await new Promise((r) => server.close(r))
  rmSync(projectDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
})

/** Open a terminal socket and collect frames until it closes or `until` matches. */
function connect(projectId: string) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/terminal?projectId=${projectId}`)
  const frames: Frame[] = []
  ws.on('message', (m) => frames.push(JSON.parse(m.toString())))
  const closed = new Promise<{ code: number }>((resolve) => ws.on('close', (code) => resolve({ code })))
  const opened = new Promise<void>((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject) })
  return { ws, frames, closed, opened }
}

async function waitFor(check: () => boolean, ms = 25_000) {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 50))
  }
}

async function serverStillWorks() {
  const res = await fetch(`http://127.0.0.1:${port}/`)
  expect(await res.text()).toBe('alive')
}

// Real shells: PowerShell can take a few seconds to start on a busy machine.
describe('terminal error handling', { timeout: 30_000 }, () => {
  it('reports a missing project folder instead of retrying forever', async () => {
    const c = connect('gone')
    const { code } = await c.closed
    expect(code).toBe(TERMINAL_CLOSE.startFailed)
    expect(c.frames).toContainEqual({ type: 'error', message: expect.stringContaining("doesn't exist") })
    await serverStillWorks()
  })

  it('reports a shell that cannot start, with a hint about CODEPIPE_SHELL', async () => {
    process.env['CODEPIPE_SHELL'] = 'definitely-not-a-shell-xyz'
    const c = connect('ok')
    const { code } = await c.closed
    expect(code).toBe(TERMINAL_CLOSE.startFailed)
    expect(c.frames[0]).toMatchObject({ type: 'error', message: expect.stringContaining('CODEPIPE_SHELL') })
    await serverStillWorks()
  })

  it('closes unknown projects with 4404', async () => {
    const c = connect('nope')
    expect((await c.closed).code).toBe(TERMINAL_CLOSE.projectNotFound)
  })

  it('survives input and resizes sent to a shell that just exited', async () => {
    const c = connect('ok')
    await c.opened
    await waitFor(() => c.frames.some((f) => f.type === 'snapshot'))
    c.ws.send(JSON.stringify({ type: 'input', data: 'exit\r' }))
    // Race the exit with a burst of writes and resizes.
    for (let i = 0; i < 50; i++) {
      c.ws.send(JSON.stringify({ type: 'input', data: 'echo hi\r' }))
      c.ws.send(JSON.stringify({ type: 'resize', cols: 40 + (i % 20), rows: 20 }))
    }
    await waitFor(() => c.frames.some((f) => f.type === 'exit'))
    c.ws.close()
    await serverStillWorks()
  })

  it('logs a malformed frame instead of crashing', async () => {
    const c = connect('ok')
    await c.opened
    await waitFor(() => c.frames.some((f) => f.type === 'snapshot'))
    // RSV1 set without a negotiated extension: the server's ws parser emits
    // 'error' on its socket. Unhandled, that would throw.
    const raw = (c.ws as unknown as { _socket: { write(b: Buffer): void } })._socket
    raw.write(Buffer.from([0xc1, 0x80, 0x00, 0x00, 0x00, 0x00]))
    await c.closed
    await serverStillWorks()
  })

  it("guards every shell against node-pty's re-thrown socket errors", async () => {
    const c = connect('ok')
    await c.opened
    await waitFor(() => terminals.isRunning('ok'))
    const term = (terminals as unknown as { terminals: Map<string, { pty: { listeners(e: string): unknown[] } }> }).terminals.get('ok')!
    // node-pty throws unless at least two 'error' listeners exist.
    expect(term.pty.listeners('error').length).toBeGreaterThanOrEqual(2)
    // End the shell normally. Force-killing it during teardown runs
    // node-pty's forked kill helper inside Vitest's worker, which can take
    // the worker down (outside Vitest it's harmless — see the commit notes).
    c.ws.send(JSON.stringify({ type: 'input', data: 'exit\r' }))
    await waitFor(() => c.frames.some((f) => f.type === 'exit'))
    c.ws.close()
  })
})
