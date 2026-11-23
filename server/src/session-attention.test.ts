/**
 * How a chat's turn ended is noted on the session (sidebar chip, lead):
 * set when the turn finishes, cleared as soon as you send again — in memory
 * and on disk. Only your chats get it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, rm } from 'fs/promises'
import os from 'os'
import path from 'path'

import { StorageLayer } from './storage.js'
import { SessionManager } from './session-manager.js'
import { registerAdapter, clearAdapters } from './adapters/registry.js'
import type { ICLIAdapter } from './adapters/types.js'

/** Replies with a fixed line per input: questions for "ask", pending work for "build". */
const cli: ICLIAdapter = {
  provider: 'kiro',
  command: process.execPath,
  args: [],
  transport: 'oneshot',
  onData: (line) => (line.trim() ? [{ type: 'chunk', role: 'assistant', content: line.trim() }] : []),
  buildMessageCommand: (input: string) => ({
    command: process.execPath,
    args: ['-e', `setTimeout(() => console.log(${JSON.stringify(
      input === 'ask' ? 'Built it. Do you want me to deploy it?' : input === 'slow' ? 'Done thinking.' : 'Built it; the changes are uncommitted.',
    )}), ${input === 'slow' ? 1500 : 300})`],
  }),
}

let dir: string
let storage: StorageLayer
let manager: SessionManager

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'codepipe-attention-'))
  storage = new StorageLayer(dir)
  await storage.ensureDataDir()
  manager = new SessionManager(storage)
  registerAdapter('kiro', () => cli)
})

afterEach(async () => {
  await manager.shutdown()
  clearAdapters()
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
})

const onDisk = async (id: string) => (await storage.listSessions()).find((s) => s.id === id)?.attention

describe('chat attention', () => {
  it('is set when a turn ends on a question, and cleared when you send again', async () => {
    const project = await storage.addProject({ name: 'p', path: dir })
    const { id } = await manager.createSession('kiro', project.id)

    manager.handleInput(id, 'ask')
    await vi.waitFor(() => expect(manager.getSession(id)?.attention).toEqual({ state: 'waiting_on_you', question: 'Do you want me to deploy it?' }), { timeout: 10_000 })
    await vi.waitFor(async () => expect(await onDisk(id)).toEqual({ state: 'waiting_on_you', question: 'Do you want me to deploy it?' }), { timeout: 5_000 })

    manager.handleInput(id, 'slow')
    expect(manager.getSession(id)?.attention).toBeUndefined()
    await vi.waitFor(async () => expect(await onDisk(id)).toBeUndefined(), { timeout: 5_000 })

    // A plain ending leaves nothing behind.
    await vi.waitFor(() => expect(manager.isBusy(id)).toBe(false), { timeout: 10_000 })
    expect(manager.getSession(id)?.attention).toBeUndefined()
  }, 30_000)

  it('notes pending work, and only once the queue has drained', async () => {
    const project = await storage.addProject({ name: 'p', path: dir })
    const { id } = await manager.createSession('kiro', project.id)

    manager.handleInput(id, 'ask')
    manager.handleInput(id, 'build') // queued behind the first turn
    await vi.waitFor(() => expect(manager.isBusy(id)).toBe(true), { timeout: 5_000 })
    // First turn ends with a question, but you've already queued more: no chip.
    await vi.waitFor(() => expect(manager.getSession(id)?.messages.some((m) => m.content.includes('deploy it?'))).toBe(true), { timeout: 10_000 })
    expect(manager.getSession(id)?.attention).toBeUndefined()

    await vi.waitFor(() => expect(manager.getSession(id)?.attention).toEqual({ state: 'pending_action' }), { timeout: 10_000 })
    await vi.waitFor(async () => expect(await onDisk(id)).toEqual({ state: 'pending_action' }), { timeout: 5_000 })
  }, 30_000)

  it('is never set on sessions that are not your chats', async () => {
    const project = await storage.addProject({ name: 'p', path: dir })
    const { id } = await manager.createSession('kiro', project.id, { kind: 'review', title: 'r' })
    await manager.runTurn(id, 'ask', { timeoutMs: 10_000 })
    expect(manager.getSession(id)?.attention).toBeUndefined()
  }, 30_000)
})
