import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, readFile, rm, utimes, writeFile, readdir } from 'fs/promises'
import os from 'os'
import path from 'path'

import { fitForCommandLine, MAX_INLINE_INPUT_CHARS, SPILLED_NOTE } from './long-input.js'
import { StorageLayer } from './storage.js'
import { SessionManager } from './session-manager.js'
import { registerAdapter, clearAdapters } from './adapters/registry.js'
import type { ICLIAdapter } from './adapters/types.js'

let dir: string
beforeEach(async () => { dir = await mkdtemp(path.join(os.tmpdir(), 'codepipe-long-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }) })

describe('fitForCommandLine', () => {
  it('passes short input through untouched', async () => {
    const input = { text: 'hello', attachments: [{ path: '/a.png', mimeType: 'image/png' }] }
    expect(await fitForCommandLine(input, dir)).toBe(input)
  })

  it('moves long input into a file attachment, keeping existing attachments', async () => {
    const text = 'x'.repeat(MAX_INLINE_INPUT_CHARS + 1)
    const out = await fitForCommandLine({ text, attachments: [{ path: '/a.png', mimeType: 'image/png' }] }, dir)
    expect(out.text).toBe(SPILLED_NOTE)
    expect(out.attachments).toHaveLength(2)
    expect(out.attachments![0].path).toBe('/a.png')
    expect(await readFile(out.attachments![1].path, 'utf-8')).toBe(text)
  })

  it('clears spilled files older than a day', async () => {
    const old = path.join(dir, 'old.md')
    await writeFile(old, 'stale')
    const twoDaysAgo = new Date(Date.now() - 2 * 86_400_000)
    await utimes(old, twoDaysAgo, twoDaysAgo)
    await fitForCommandLine({ text: 'y'.repeat(MAX_INLINE_INPUT_CHARS + 1) }, dir)
    expect(await readdir(dir)).not.toContain('old.md')
  })
})

describe('a long message reaching a one-shot CLI', () => {
  it('goes as a file; the transcript keeps your text', async () => {
    const seen: { text: string; attachments?: { path: string }[] }[] = []
    const cli: ICLIAdapter = {
      provider: 'kiro',
      command: process.execPath,
      args: [],
      transport: 'oneshot',
      onData: (line) => (line.trim() ? [{ type: 'chunk', role: 'assistant', content: line.trim() }] : []),
      buildMessageCommand: (text, _id, attachments) => {
        seen.push({ text, attachments })
        return { command: process.execPath, args: ['-e', 'console.log("ok")'] }
      },
    }
    registerAdapter('kiro', () => cli)
    const storage = new StorageLayer(path.join(dir, 'data'))
    await storage.ensureDataDir()
    const manager = new SessionManager(storage)
    try {
      const project = await storage.addProject({ name: 'p', path: dir })
      const { id } = await manager.createSession('kiro', project.id)
      const long = 'A pasted log line\n'.repeat(2000)
      manager.handleInput(id, long)
      await vi.waitFor(() => expect(seen).toHaveLength(1), { timeout: 10_000 })
      expect(seen[0].text).toBe(SPILLED_NOTE)
      expect(await readFile(seen[0].attachments!.at(-1)!.path, 'utf-8')).toBe(long)
      expect(manager.getSession(id)!.messages[0].content).toBe(long)
      await vi.waitFor(() => expect(manager.isBusy(id)).toBe(false), { timeout: 10_000 })
    } finally {
      await manager.shutdown()
      clearAdapters()
      await storage.whenIdle()
    }
  }, 20_000)
})
