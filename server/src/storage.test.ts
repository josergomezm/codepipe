import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, rm, readdir, readFile, writeFile } from 'fs/promises'
import { existsSync } from 'fs'
import path from 'path'
import os from 'os'
import { randomUUID } from 'crypto'
import fc from 'fast-check'
import { StorageLayer } from './storage.js'
import type { Session, ChatMessage, Project } from './schemas.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeProject(overrides: Partial<Project> = {}): Omit<Project, 'id'> {
  return {
    name: overrides.name ?? 'Test Project',
    path: overrides.path ?? '/tmp/test-project',
  }
}

function makeSession(overrides: Partial<Session> = {}): Session {
  const now = Date.now()
  return {
    id: overrides.id ?? randomUUID(),
    provider: overrides.provider ?? 'kiro',
    projectId: overrides.projectId ?? randomUUID(),
    title: overrides.title ?? 'Test Session',
    createdAt: overrides.createdAt ?? now,
    updatedAt: overrides.updatedAt ?? now,
    status: overrides.status ?? 'live',
    messages: overrides.messages ?? [],
  }
}

function makeMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: overrides.id ?? randomUUID(),
    role: overrides.role ?? 'user',
    content: overrides.content ?? 'hello',
    timestamp: overrides.timestamp ?? Date.now(),
    status: overrides.status ?? 'complete',
    ...(overrides.metadata ? { metadata: overrides.metadata } : {}),
  }
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

let tmpDir: string
let storage: StorageLayer

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), 'storage-test-'))
  storage = new StorageLayer(tmpDir)
  await storage.ensureDataDir()
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

// =========================================================================
// 2.3.1 — Project CRUD
// =========================================================================

describe('Project CRUD', () => {
  it('starts with an empty project list', async () => {
    const projects = await storage.listProjects()
    expect(projects).toEqual([])
  })

  it('adds a project and assigns a UUID id', async () => {
    const project = await storage.addProject(makeProject())
    expect(project.id).toBeDefined()
    expect(project.name).toBe('Test Project')
    expect(project.path).toBe('/tmp/test-project')
  })

  it('lists all added projects', async () => {
    await storage.addProject(makeProject({ name: 'A', path: '/tmp/a' }))
    await storage.addProject(makeProject({ name: 'B', path: '/tmp/b' }))
    const projects = await storage.listProjects()
    expect(projects).toHaveLength(2)
    expect(projects.map((p) => p.name).sort()).toEqual(['A', 'B'])
  })

  it('gets a project by id', async () => {
    const added = await storage.addProject(makeProject())
    const found = await storage.getProject(added.id)
    expect(found).toEqual(added)
  })

  it('returns null for a non-existent project id', async () => {
    const found = await storage.getProject(randomUUID())
    expect(found).toBeNull()
  })

  it('removes a project by id', async () => {
    const added = await storage.addProject(makeProject())
    await storage.removeProject(added.id)
    const found = await storage.getProject(added.id)
    expect(found).toBeNull()
    const all = await storage.listProjects()
    expect(all).toHaveLength(0)
  })

  it('removing a non-existent project does not throw', async () => {
    await storage.addProject(makeProject())
    await expect(storage.removeProject(randomUUID())).resolves.not.toThrow()
    const all = await storage.listProjects()
    expect(all).toHaveLength(1)
  })
})

// =========================================================================
// 2.3.2 — Session CRUD
// =========================================================================

describe('Session CRUD', () => {
  it('saves and retrieves a session', async () => {
    const session = makeSession()
    await storage.saveSession(session)
    const loaded = await storage.getSession(session.id)
    expect(loaded).toEqual(session)
  })

  it('returns null for a non-existent session', async () => {
    const loaded = await storage.getSession(randomUUID())
    expect(loaded).toBeNull()
  })

  it('lists session metadata without messages', async () => {
    const msg = makeMessage()
    const session = makeSession({ messages: [msg] })
    await storage.saveSession(session)

    const metas = await storage.listSessions()
    expect(metas).toHaveLength(1)
    expect(metas[0].id).toBe(session.id)
    expect(metas[0].title).toBe(session.title)
    // SessionMeta should not contain messages
    expect((metas[0] as Record<string, unknown>).messages).toBeUndefined()
  })

  it('lists multiple sessions', async () => {
    const s1 = makeSession()
    const s2 = makeSession()
    await storage.saveSession(s1)
    await storage.saveSession(s2)

    const metas = await storage.listSessions()
    expect(metas).toHaveLength(2)
    const ids = metas.map((m) => m.id).sort()
    expect(ids).toEqual([s1.id, s2.id].sort())
  })

  it('deletes a session', async () => {
    const session = makeSession()
    await storage.saveSession(session)
    await storage.deleteSession(session.id)
    const loaded = await storage.getSession(session.id)
    expect(loaded).toBeNull()
  })

  it('deleting a non-existent session does not throw', async () => {
    await expect(storage.deleteSession(randomUUID())).resolves.not.toThrow()
  })

  it('returns null for a corrupted session JSON file', async () => {
    const sessionId = randomUUID()
    const filePath = path.join(tmpDir, 'sessions', `${sessionId}.json`)
    await writeFile(filePath, 'NOT VALID JSON {{{', 'utf-8')

    const loaded = await storage.getSession(sessionId)
    expect(loaded).toBeNull()
  })

  it('returns null for a session file that fails schema validation', async () => {
    const sessionId = randomUUID()
    const filePath = path.join(tmpDir, 'sessions', `${sessionId}.json`)
    // Valid JSON but missing required fields
    await writeFile(filePath, JSON.stringify({ id: sessionId, bad: true }), 'utf-8')

    const loaded = await storage.getSession(sessionId)
    expect(loaded).toBeNull()
  })
})

// =========================================================================
// 2.3.3 — appendMessage
// =========================================================================

describe('appendMessage', () => {
  it('appends a message to an existing session', async () => {
    const session = makeSession()
    await storage.saveSession(session)

    const msg = makeMessage({ timestamp: session.createdAt + 1000 })
    await storage.appendMessage(session.id, msg)

    const loaded = await storage.getSession(session.id)
    expect(loaded!.messages).toHaveLength(1)
    expect(loaded!.messages[0]).toEqual(msg)
  })

  it('preserves message ordering when appending multiple messages', async () => {
    const baseTime = Date.now()
    const session = makeSession({ createdAt: baseTime, updatedAt: baseTime })
    await storage.saveSession(session)

    const msg1 = makeMessage({ timestamp: baseTime + 1000, content: 'first' })
    const msg2 = makeMessage({ timestamp: baseTime + 2000, content: 'second' })
    const msg3 = makeMessage({ timestamp: baseTime + 3000, content: 'third' })

    await storage.appendMessage(session.id, msg1)
    await storage.appendMessage(session.id, msg2)
    await storage.appendMessage(session.id, msg3)

    const loaded = await storage.getSession(session.id)
    expect(loaded!.messages).toHaveLength(3)
    expect(loaded!.messages[0].content).toBe('first')
    expect(loaded!.messages[1].content).toBe('second')
    expect(loaded!.messages[2].content).toBe('third')
  })

  it('updates updatedAt to the message timestamp', async () => {
    const baseTime = Date.now()
    const session = makeSession({ createdAt: baseTime, updatedAt: baseTime })
    await storage.saveSession(session)

    const msgTimestamp = baseTime + 5000
    const msg = makeMessage({ timestamp: msgTimestamp })
    await storage.appendMessage(session.id, msg)

    const loaded = await storage.getSession(session.id)
    expect(loaded!.updatedAt).toBe(msgTimestamp)
  })

  it('throws when appending to a non-existent session', async () => {
    const msg = makeMessage()
    await expect(storage.appendMessage(randomUUID(), msg)).rejects.toThrow('not found')
  })
})

// =========================================================================
// 2.3.4 — Atomic write behavior
// =========================================================================

describe('Atomic write behavior', () => {
  it('writes session data to a file that exists on disk', async () => {
    const session = makeSession()
    await storage.saveSession(session)

    const sessionsDir = path.join(tmpDir, 'sessions')
    const files = await readdir(sessionsDir)
    expect(files).toContain(`${session.id}.json`)
  })

  it('does not leave temp files after a successful write', async () => {
    const session = makeSession()
    await storage.saveSession(session)

    const sessionsDir = path.join(tmpDir, 'sessions')
    const files = await readdir(sessionsDir)
    const tmpFiles = files.filter((f) => f.includes('.tmp.'))
    expect(tmpFiles).toHaveLength(0)
  })

  it('atomicWrite produces valid JSON content', async () => {
    const session = makeSession()
    await storage.saveSession(session)

    const filePath = path.join(tmpDir, 'sessions', `${session.id}.json`)
    const raw = await readFile(filePath, 'utf-8')
    const parsed = JSON.parse(raw)
    expect(parsed.id).toBe(session.id)
    expect(parsed.title).toBe(session.title)
  })

  it('overwrites existing file atomically (no partial data)', async () => {
    const session = makeSession()
    await storage.saveSession(session)

    // Update the session with a new title and save again
    session.title = 'Updated Title'
    session.updatedAt = session.createdAt + 1
    await storage.saveSession(session)

    const loaded = await storage.getSession(session.id)
    expect(loaded!.title).toBe('Updated Title')

    // Verify no temp files remain
    const sessionsDir = path.join(tmpDir, 'sessions')
    const files = await readdir(sessionsDir)
    const tmpFiles = files.filter((f) => f.includes('.tmp.'))
    expect(tmpFiles).toHaveLength(0)
  })

  it('preserves original file content when writing to a different session', async () => {
    const session1 = makeSession({ title: 'Session One' })
    const session2 = makeSession({ title: 'Session Two' })
    await storage.saveSession(session1)
    await storage.saveSession(session2)

    // Verify both files exist and have correct content
    const loaded1 = await storage.getSession(session1.id)
    const loaded2 = await storage.getSession(session2.id)
    expect(loaded1!.title).toBe('Session One')
    expect(loaded2!.title).toBe('Session Two')
  })

  it('preserves original file when temp file write fails', async () => {
    // Save a valid session first
    const session = makeSession({ title: 'Original Title' })
    await storage.saveSession(session)

    // Verify original is saved
    const before = await storage.getSession(session.id)
    expect(before!.title).toBe('Original Title')

    // Attempt an atomic write that will fail during temp file creation
    // by writing to a non-existent directory path
    const badPath = path.join(tmpDir, 'nonexistent', 'deep', 'file.json')
    await expect(storage.atomicWrite(badPath, { broken: true })).rejects.toThrow()

    // Original session file should be completely untouched
    const after = await storage.getSession(session.id)
    expect(after!.title).toBe('Original Title')
  })

  it('returns empty array for corrupted projects.json', async () => {
    const projectsFile = path.join(tmpDir, 'projects.json')
    await writeFile(projectsFile, '<<<CORRUPTED>>>', 'utf-8')

    const projects = await storage.listProjects()
    expect(projects).toEqual([])
  })
})

// =========================================================================
// 2.3.5 — Property-based test: session round-trip integrity
// =========================================================================

describe('Property-based: session round-trip integrity', () => {
  /**
   * **Validates: Requirements 4.4**
   *
   * Property: For any valid Session object, saving it to storage and loading
   * it back produces an identical object. This verifies that the JSON
   * serialization/deserialization pipeline preserves all data.
   */
  it('save → load round-trip preserves session data', async () => {
    // Arbitrary for ChatMessage
    const arbChatMessage: fc.Arbitrary<ChatMessage> = fc.record({
      id: fc.uuid(),
      role: fc.constantFrom('user' as const, 'assistant' as const, 'system' as const, 'tool' as const),
      content: fc.string(),
      timestamp: fc.integer({ min: 1, max: 2_000_000_000_000 }),
      status: fc.constantFrom('streaming' as const, 'complete' as const),
    })

    // Arbitrary for Session — generate createdAt first, then derive updatedAt >= createdAt
    const arbSession: fc.Arbitrary<Session> = fc
      .record({
        id: fc.uuid(),
        provider: fc.constantFrom('kiro' as const, 'gemini' as const, 'claude' as const, 'codex' as const),
        projectId: fc.uuid(),
        title: fc.string({ minLength: 1, maxLength: 200 }),
        createdAt: fc.integer({ min: 1, max: 1_000_000_000_000 }),
        updatedAtOffset: fc.integer({ min: 0, max: 1_000_000_000 }),
        status: fc.constantFrom('live' as const, 'archived' as const),
        messages: fc.array(arbChatMessage, { minLength: 0, maxLength: 5 }),
      })
      .map((r) => ({
        id: r.id,
        provider: r.provider,
        projectId: r.projectId,
        title: r.title,
        createdAt: r.createdAt,
        updatedAt: r.createdAt + r.updatedAtOffset,
        status: r.status,
        messages: r.messages,
      }))

    await fc.assert(
      fc.asyncProperty(arbSession, async (session) => {
        await storage.saveSession(session)
        const loaded = await storage.getSession(session.id)
        expect(loaded).toEqual(session)
      }),
      { numRuns: 50 },
    )
  })
})
