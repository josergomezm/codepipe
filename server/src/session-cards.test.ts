/**
 * Where tool-posted cards land in a chat, against a real child process:
 * a suggestion waits for the turn to end and lands under the final reply;
 * an immediate card lands after the text that preceded it — in memory and
 * on disk.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, rm } from 'fs/promises'
import os from 'os'
import path from 'path'

import { StorageLayer } from './storage.js'
import { SessionManager } from './session-manager.js'
import { registerAdapter, clearAdapters } from './adapters/registry.js'
import type { ICLIAdapter } from './adapters/types.js'

/** Says "before", pauses (when the test posts its cards), then "after". */
const twoPartCli: ICLIAdapter = {
  provider: 'kiro',
  command: process.execPath,
  args: [],
  transport: 'oneshot',
  onData: (line) => (line.trim() ? [{ type: 'chunk', role: 'assistant', content: line }] : []),
  buildMessageCommand: () => ({
    command: process.execPath,
    args: ['-e', "console.log('before'); setTimeout(() => console.log('after'), 1500)"],
  }),
}

let tmpDir: string
let storage: StorageLayer
let manager: SessionManager

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), 'codepipe-cards-'))
  storage = new StorageLayer(tmpDir)
  await storage.ensureDataDir()
  manager = new SessionManager(storage)
})

afterEach(async () => {
  await manager.shutdown()
  clearAdapters()
  await rm(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
})

const draft = (text: string) => ({ kind: 'action' as const, action: { draft: { text }, state: 'suggested' as const } })
const order = (messages: { role: string; content: string }[]) =>
  messages.filter((m) => m.role !== 'user').map((m) => m.content)

describe('chat cards', () => {
  it('holds a suggestion until the turn ends; posts an immediate card after the preceding text', async () => {
    registerAdapter('kiro', () => twoPartCli)
    const project = await storage.addProject({ name: 'p', path: tmpDir })
    const { id } = await manager.createSession('kiro', project.id)
    manager.handleInput(id, 'go')

    const live = () => manager.getSession(id)?.messages ?? []
    await vi.waitFor(() => expect(live().some((m) => m.content === 'before')).toBe(true), { timeout: 10_000 })

    manager.appendCard(id, 'suggested', draft('suggested'), { atTurnEnd: true })
    manager.appendCard(id, 'added', { kind: 'action', action: { draft: { text: 'added' }, state: 'added' } })
    // Not shown mid-turn.
    expect(live().some((m) => m.content === 'suggested')).toBe(false)

    await vi.waitFor(() => expect(live().some((m) => m.content === 'suggested')).toBe(true), { timeout: 10_000 })
    expect(order(live())).toEqual(['before', 'added', 'after', 'suggested'])

    // Same order after a reload from disk.
    await vi.waitFor(async () => {
      expect(order((await storage.getSession(id))!.messages)).toEqual(['before', 'added', 'after', 'suggested'])
    }, { timeout: 5_000 })
  }, 20_000)

  it('posts a suggestion right away when no turn is running', async () => {
    registerAdapter('kiro', () => twoPartCli)
    const project = await storage.addProject({ name: 'p', path: tmpDir })
    const { id } = await manager.createSession('kiro', project.id)
    manager.appendCard(id, 'suggested', draft('suggested'), { atTurnEnd: true })
    expect(order(manager.getSession(id)!.messages)).toEqual(['suggested'])
  })
})
