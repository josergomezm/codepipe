/**
 * Messages sent while a turn is running wait in the queue — out of the
 * transcript — and join it only when their own turn starts, so they never
 * get buried above the reply that was still streaming.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, rm } from 'fs/promises'
import os from 'os'
import path from 'path'
import type { WebSocket } from 'ws'

import { StorageLayer } from './storage.js'
import { SessionManager } from './session-manager.js'
import { registerAdapter, clearAdapters } from './adapters/registry.js'
import type { ICLIAdapter } from './adapters/types.js'

/** Replies "reply to <input>" after a pause. */
const slowCli: ICLIAdapter = {
  provider: 'kiro',
  command: process.execPath,
  args: [],
  transport: 'oneshot',
  onData: (line) => (line.trim() ? [{ type: 'chunk', role: 'assistant', content: line.trim() }] : []),
  buildMessageCommand: (input: string) => ({
    command: process.execPath,
    args: ['-e', `setTimeout(() => console.log(${JSON.stringify(`reply to ${input}`)}), 700)`],
  }),
}

let tmpDir: string
let storage: StorageLayer
let manager: SessionManager

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), 'codepipe-queue-'))
  storage = new StorageLayer(tmpDir)
  await storage.ensureDataDir()
  manager = new SessionManager(storage)
  registerAdapter('kiro', () => slowCli)
})

afterEach(async () => {
  await manager.shutdown()
  clearAdapters()
  await rm(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
})

/** A fake socket that records what the session broadcasts. */
function listen(id: string) {
  const sent: { type: string; data: unknown; dropped?: unknown }[] = []
  const socket = { readyState: 1, OPEN: 1, send: (raw: string) => sent.push(JSON.parse(raw)), on: () => {} } as unknown as WebSocket
  manager.attachClient(id, socket)
  return sent
}

async function newSession() {
  const project = await storage.addProject({ name: 'p', path: tmpDir })
  return (await manager.createSession('kiro', project.id)).id
}

const transcript = (id: string) => manager.getSession(id)!.messages.map((m) => `${m.role}: ${m.content}`)

describe('queued input', () => {
  it('stays out of the transcript until its turn starts, then lands after the reply it waited on', async () => {
    const id = await newSession()
    const sent = listen(id)

    manager.handleInput(id, 'first')
    manager.handleInput(id, 'second')

    // "second" is queued: not in the transcript, announced as queued.
    expect(transcript(id)).toEqual(['user: first'])
    expect(manager.getQueuedMessages(id).map((m) => m.content)).toEqual(['second'])
    expect(sent.filter((m) => m.type === 'queue').at(-1)).toMatchObject({ data: [{ content: 'second' }] })

    await vi.waitFor(() => expect(transcript(id)).toEqual([
      'user: first', 'assistant: reply to first', 'user: second', 'assistant: reply to second',
    ]), { timeout: 10_000 })
    expect(manager.getQueuedMessages(id)).toEqual([])
    expect(sent.filter((m) => m.type === 'queue').at(-1)).toMatchObject({ data: [] })

    // Same order on disk.
    await vi.waitFor(async () => {
      expect((await storage.getSession(id))!.messages.map((m) => m.content)).toEqual([
        'first', 'reply to first', 'second', 'reply to second',
      ])
    }, { timeout: 5_000 })
  }, 20_000)

  it('can be removed before it runs', async () => {
    const id = await newSession()
    manager.handleInput(id, 'first')
    manager.handleInput(id, 'oops')
    const queued = manager.getQueuedMessages(id)[0]

    expect(manager.unqueueInput(id, queued.id)).toBe(true)
    expect(manager.getQueuedMessages(id)).toEqual([])

    await vi.waitFor(() => expect(manager.isBusy(id)).toBe(false), { timeout: 10_000 })
    expect(transcript(id)).toEqual(['user: first', 'assistant: reply to first'])
  }, 20_000)

  it('Stop drops the queue and hands the dropped messages back', async () => {
    const id = await newSession()
    const sent = listen(id)
    manager.handleInput(id, 'first')
    manager.handleInput(id, 'later')

    manager.cancelTurn(id)

    expect(manager.getQueuedMessages(id)).toEqual([])
    expect(sent.filter((m) => m.type === 'queue').at(-1)).toMatchObject({ data: [], dropped: [{ content: 'later' }] })
    expect(transcript(id)).not.toContain('user: later')
  })
})
