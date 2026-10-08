import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, rm } from 'fs/promises'
import path from 'path'
import os from 'os'

// ---------------------------------------------------------------------------
// Mock child_process.spawn (non-interactive adapter turns)
// ---------------------------------------------------------------------------

let mockSpawnStdoutCb: ((data: Buffer) => void) | null = null
let mockSpawnCloseCb: ((code: number) => void) | null = null
/** Total spawns so far — completeTurn() consumes one spawn per call. */
let mockSpawnCount = 0
let consumedSpawns = 0

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>
  return {
    ...actual,
    spawn: vi.fn(() => {
      mockSpawnStdoutCb = null
      mockSpawnCloseCb = null
      mockSpawnCount++
      return {
        stdout: {
          on(event: string, cb: (data: Buffer) => void) {
            if (event === 'data') mockSpawnStdoutCb = cb
          },
        },
        stderr: { on() { /* no-op */ } },
        on(event: string, cb: (...args: unknown[]) => void) {
          if (event === 'close') mockSpawnCloseCb = cb as (code: number) => void
        },
        kill() { /* no-op */ },
        pid: 4242,
      }
    }),
  }
})

// Import AFTER mocks are set up
import { StorageLayer } from './storage.js'
import { SessionManager } from './session-manager.js'
import { StandupService, hashTodos, isSameLocalDay, isStandupDue } from './standup.js'
import { parseStandupTail, parseReviewerOutput, matchPersona, matchTodo, buildStandupPrompt, buildImplementPrompt, trackedActions, RESOLVED_ACTION_WINDOW_MS } from './standup-protocol.js'
import { registerAdapter, clearAdapters } from './adapters/registry.js'
import type { ICLIAdapter } from './adapters/types.js'
import type { Persona, Project, Todo } from './schemas.js'
import type { PushPayload, PushService } from './push.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * vi.waitFor with room to breathe: these tests run real (fake-CLI) child
 * processes, and on a busy Windows machine a few turns can take longer than
 * vi.waitFor's 1 s default.
 */
function waitFor<T>(check: () => T | Promise<T>): Promise<T> {
  return vi.waitFor(check, { timeout: 10_000, interval: 50 })
}

const fakeAdapter: ICLIAdapter = {
  provider: 'kiro',
  command: 'fake-cli',
  args: [],
  transport: 'oneshot',
  onData: (line) =>
    line.length > 0 ? [{ type: 'chunk', role: 'assistant', content: line }] : [],
  buildMessageCommand: (text) => ({ command: 'fake-cli', args: [text] }),
}

function makeTodo(overrides: Partial<Todo> = {}): Todo {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    projectId: '22222222-2222-4222-8222-222222222222',
    text: 'Fix the websocket retry storm',
    status: 'inbox',
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

function makePersona(overrides: Partial<Persona> = {}): Persona {
  return {
    id: '33333333-3333-4333-8333-333333333333',
    name: 'Maya',
    role: 'Team lead',
    personality: 'Pragmatic, concise.',
    provider: 'kiro',
    isLead: true,
    ...overrides,
  }
}

/**
 * Feed the NEXT unconsumed CLI turn with output lines, then close it. Waits
 * for a spawn newer than the last consumed one, so background pipelines that
 * spawn asynchronously (reviewers, synthesis) can't race a stale callback.
 */
async function completeTurn(lines: string[]): Promise<void> {
  await waitFor(() => {
    if (mockSpawnCount <= consumedSpawns || !mockSpawnCloseCb) {
      throw new Error('next CLI turn not spawned yet')
    }
  })
  consumedSpawns = mockSpawnCount
  mockSpawnStdoutCb?.(Buffer.from(lines.join('\n') + '\n'))
  mockSpawnCloseCb?.(0)
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe('parseStandupTail', () => {
  const validOutput = {
    messages: [{ persona: 'Maya', kind: 'proposal', text: 'We reviewed your list.' }],
    proposals: [{ todoId: 'abc', summary: 'Do it', approach: 'Carefully' }],
  }

  it('parses a fenced json tail and strips it from the content', () => {
    const content = `Team discussion here.\n\n\`\`\`json\n${JSON.stringify(validOutput)}\n\`\`\``
    const parsed = parseStandupTail(content)
    expect(parsed).not.toBeNull()
    expect(parsed!.output.messages[0].persona).toBe('Maya')
    expect(parsed!.stripped).toBe('Team discussion here.')
  })

  it('uses the LAST fenced block when several exist', () => {
    const content = [
      'Some code:',
      '```json\n{"not": "the tail"}\n```',
      'More discussion.',
      `\`\`\`json\n${JSON.stringify(validOutput)}\n\`\`\``,
    ].join('\n')
    const parsed = parseStandupTail(content)
    expect(parsed).not.toBeNull()
    expect(parsed!.stripped).toContain('{"not": "the tail"}')
  })

  it('accepts a bare trailing JSON object', () => {
    const content = `Discussion.\n${JSON.stringify(validOutput)}`
    const parsed = parseStandupTail(content)
    expect(parsed).not.toBeNull()
    expect(parsed!.stripped).toBe('Discussion.')
  })

  it('returns null when there is no valid tail', () => {
    expect(parseStandupTail('Just prose, no JSON.')).toBeNull()
    expect(parseStandupTail('```json\n{"messages": "wrong shape"}\n```')).toBeNull()
  })
})

describe('parseReviewerOutput', () => {
  it('parses a fenced JSON take', () => {
    const out = parseReviewerOutput('Thinking…\n```json\n{"take": "Small change.", "concerns": ["Safari"], "effort": "2h"}\n```')
    expect(out.take).toBe('Small change.')
    expect(out.concerns).toEqual(['Safari'])
    expect(out.effort).toBe('2h')
  })

  it('degrades raw prose to the take instead of losing it', () => {
    const out = parseReviewerOutput('I looked at the code and this is fine.')
    expect(out.take).toBe('I looked at the code and this is fine.')
    expect(out.concerns).toBeUndefined()
  })
})

describe('hashTodos', () => {
  it('is stable across ordering and changes only when content changes', () => {
    const a = makeTodo()
    const b = makeTodo({ id: '99999999-9999-4999-8999-999999999999', text: 'Other' })
    expect(hashTodos([a, b])).toBe(hashTodos([b, a]))
    expect(hashTodos([a])).not.toBe(hashTodos([makeTodo({ text: 'Changed' })]))
    // Status and updatedAt must NOT change the hash — the standup itself
    // flips statuses, and that must not defeat the unchanged-list gate.
    expect(hashTodos([a])).toBe(hashTodos([makeTodo({ status: 'under_review', updatedAt: 999 })]))
  })
})

describe('matchPersona / matchTodo', () => {
  it('matches personas by id and case-insensitive name', () => {
    const p = makePersona()
    expect(matchPersona([p], p.id)).toBe(p)
    expect(matchPersona([p], 'maya')).toBe(p)
    expect(matchPersona([p], 'nobody')).toBeNull()
  })

  it('matches todos by id or unambiguous prefix', () => {
    const t1 = makeTodo({ id: 'aaaaaaaa-1111-4111-8111-111111111111' })
    const t2 = makeTodo({ id: 'aaaaaaaa-2222-4222-8222-222222222222' })
    expect(matchTodo([t1, t2], t1.id)).toBe(t1)
    expect(matchTodo([t1, t2], 'aaaaaaaa-1111')).toBe(t1)
    expect(matchTodo([t1, t2], 'aaaaaaaa')).toBeNull() // ambiguous
  })
})

describe('isSameLocalDay', () => {
  it('compares calendar days, not 24h windows', () => {
    expect(isSameLocalDay(new Date(2026, 7, 31, 1), new Date(2026, 7, 31, 23))).toBe(true)
    expect(isSameLocalDay(new Date(2026, 7, 31, 23), new Date(2026, 8, 1, 1))).toBe(false)
  })
})

describe('isStandupDue', () => {
  const nineAm = { enabled: true, hour: 9 }
  const day = (hour: number) => new Date(2026, 8, 1, hour)

  it('is not due before the configured hour, due from it onward (catch-up)', () => {
    expect(isStandupDue(nineAm, undefined, day(8))).toBe(false)
    expect(isStandupDue(nineAm, undefined, day(9))).toBe(true)
    // The machine slept through 9 AM — still due at 14:00 the same day.
    expect(isStandupDue(nineAm, undefined, day(14))).toBe(true)
  })

  it('runs at most once per day, and resets the next day', () => {
    const ranAtNine = day(9).getTime()
    expect(isStandupDue(nineAm, ranAtNine, day(10))).toBe(false)
    expect(isStandupDue(nineAm, ranAtNine, new Date(2026, 8, 2, 9))).toBe(true)
    // A run late yesterday doesn't satisfy today.
    expect(isStandupDue(nineAm, new Date(2026, 7, 31, 23).getTime(), day(9))).toBe(true)
  })

  it('is never due when disabled', () => {
    expect(isStandupDue({ enabled: false, hour: 9 }, undefined, day(9))).toBe(false)
  })
})

describe('buildStandupPrompt', () => {
  it('includes roster, todo ids, and the JSON contract', () => {
    const project = { id: 'p', name: 'codepipe', path: '/x' } as Project
    const prompt = buildStandupPrompt(project, [makePersona()], [makeTodo()])
    expect(prompt).toContain('Maya (team lead)')
    expect(prompt).toContain('[11111111-1111-4111-8111-111111111111]')
    expect(prompt).toContain('```json')
    // The contract asks for execution briefs and typed user actions.
    expect(prompt).toContain('brief')
    expect(prompt).toContain('decision | task')
    expect(prompt).toContain('resolved_actions')
  })

  it('shows the team what is already tracked, and what the user answered', () => {
    const project = { id: 'p', name: 'codepipe', path: '/x' } as Project
    const base = { projectId: 'p', createdAt: 1, updatedAt: 1 }
    const prompt = buildStandupPrompt(project, [makePersona()], [], undefined, undefined, [
      { ...base, id: '22222222-2222-4222-8222-222222222222', text: 'Pick an auth provider', kind: 'decision', status: 'open' },
      { ...base, id: '33333333-3333-4333-8333-333333333333', text: 'Pick a DB', kind: 'decision', status: 'done', resolution: 'Postgres' },
    ])
    expect(prompt).toContain('do NOT raise these again')
    expect(prompt).toContain('[22222222-2222-4222-8222-222222222222] (decision) Pick an auth provider')
    expect(prompt).toContain("The user's answer: Postgres")
    // Resolved items are context, not something to reference by id.
    expect(prompt).not.toContain('33333333-3333-4333-8333-333333333333')
  })
})

describe('trackedActions', () => {
  it('keeps open items and recently resolved ones, drops old resolved ones', () => {
    const now = Date.now()
    const base = { projectId: 'p', text: 'x', createdAt: 1 }
    const items = [
      { ...base, id: 'a', status: 'open' as const, updatedAt: now - 90 * 86_400_000 },
      { ...base, id: 'b', status: 'done' as const, updatedAt: now - 86_400_000 },
      { ...base, id: 'c', status: 'done' as const, updatedAt: now - RESOLVED_ACTION_WINDOW_MS - 1 },
    ]
    expect(trackedActions(items, now).map((a) => a.id)).toEqual(['a', 'b'])
  })
})

describe('buildImplementPrompt', () => {
  const project = { id: 'p', name: 'codepipe', path: '/x' } as Project

  it('uses the tuned brief when the proposal has one, superseding the approach', () => {
    const todo = makeTodo({
      status: 'approved',
      proposal: {
        summary: 'Do it',
        approach: 'Human-readable plan',
        brief: 'Read docs/pos.md first. Goal: X. Do not touch auth. Done when tests pass.',
      },
    })
    const prompt = buildImplementPrompt(project, makePersona(), todo)
    expect(prompt).toContain('Read docs/pos.md first')
    expect(prompt).not.toContain('Planned approach: Human-readable plan')
  })

  it('falls back to the approach when no brief exists', () => {
    const todo = makeTodo({
      status: 'approved',
      proposal: { summary: 'Do it', approach: 'Human-readable plan' },
    })
    const prompt = buildImplementPrompt(project, makePersona(), todo)
    expect(prompt).toContain('Planned approach: Human-readable plan')
  })

  it('is team-free: no persona lore reaches the executing CLI', () => {
    const persona = makePersona() // Maya, with a personality string
    const todo = makeTodo({
      status: 'approved',
      proposal: { summary: 'Do it', approach: 'Plan', brief: 'The brief.' },
    })
    const prompt = buildImplementPrompt(project, persona, todo)
    expect(prompt).not.toContain('Maya')
    expect(prompt).not.toContain(persona.personality)
    expect(prompt.toLowerCase()).not.toContain('team')
    expect(prompt.toLowerCase()).not.toContain('proposal')
  })
})

// ---------------------------------------------------------------------------
// Storage: todos, personas, standup state
// ---------------------------------------------------------------------------

describe('StorageLayer todos/personas/standup state', () => {
  let tmpDir: string
  let storage: StorageLayer

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'codepipe-standup-'))
    storage = new StorageLayer(tmpDir)
    await storage.ensureDataDir()
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  it('todo CRUD round-trips and filters by project', async () => {
    const project = await storage.addProject({ name: 'p1', path: tmpDir })
    const other = await storage.addProject({ name: 'p2', path: tmpDir })

    const todo = await storage.addTodo({ projectId: project.id, text: 'Idea one', notes: 'ctx' })
    await storage.addTodo({ projectId: other.id, text: 'Elsewhere' })

    expect(todo.status).toBe('inbox')
    expect(await storage.listTodos(project.id)).toHaveLength(1)
    expect(await storage.listTodos()).toHaveLength(2)

    const updated = await storage.updateTodo(todo.id, {
      status: 'proposed',
      proposal: { summary: 's', approach: 'a' },
    })
    expect(updated.status).toBe('proposed')
    expect(updated.proposal?.summary).toBe('s')

    await storage.removeTodo(todo.id)
    expect(await storage.listTodos(project.id)).toHaveLength(0)
  })

  it('stamps completedAt when a todo reaches done and clears it on reopen', async () => {
    const project = await storage.addProject({ name: 'p1', path: tmpDir })
    const todo = await storage.addTodo({ projectId: project.id, text: 'Ship it' })
    expect(todo.completedAt).toBeUndefined()

    const done = await storage.updateTodo(todo.id, { status: 'done' })
    expect(done.completedAt).toBeTruthy()

    // A non-status edit keeps the stamp; reopening clears it.
    const edited = await storage.updateTodo(todo.id, { notes: 'shipped in v2' })
    expect(edited.completedAt).toBe(done.completedAt)
    const reopened = await storage.updateTodo(todo.id, { status: 'inbox' })
    expect(reopened.completedAt).toBeUndefined()
  })

  it('persona CRUD enforces a single lead', async () => {
    const first = await storage.addPersona({ ...makePersona(), isLead: true } as Omit<Persona, 'id'>)
    const second = await storage.addPersona({
      name: 'Aria', role: 'Backend', personality: '', provider: 'kiro', isLead: true,
    })

    let personas = await storage.listPersonas()
    expect(personas.find((p) => p.id === first.id)?.isLead).toBe(false)
    expect(personas.find((p) => p.id === second.id)?.isLead).toBe(true)

    await storage.updatePersona(first.id, { isLead: true })
    personas = await storage.listPersonas()
    expect(personas.find((p) => p.id === first.id)?.isLead).toBe(true)
    expect(personas.find((p) => p.id === second.id)?.isLead).toBe(false)
  })

  it('serializes concurrent read-modify-writes — no lost updates', async () => {
    const project = await storage.addProject({ name: 'p1', path: tmpDir })
    const todos = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        storage.addTodo({ projectId: project.id, text: `Idea ${i}` }),
      ),
    )
    expect(await storage.listTodos(project.id)).toHaveLength(10)

    await Promise.all(todos.map((t) => storage.updateTodo(t.id, { status: 'approved' })))
    const all = await storage.listTodos(project.id)
    expect(all.filter((t) => t.status === 'approved')).toHaveLength(10)
  })

  it('publishes one change hint per committed mutation', async () => {
    const changes: string[] = []
    const capturing = new StorageLayer(tmpDir, (collection) => changes.push(collection))
    await capturing.ensureDataDir()

    const project = await capturing.addProject({ name: 'cdc', path: tmpDir })
    const todo = await capturing.addTodo({ projectId: project.id, text: 'x' })
    await capturing.updateTodo(todo.id, { status: 'done' })
    await capturing.addActionItem({ projectId: project.id, text: 'y' })
    await capturing.addPersona({ name: 'M', role: 'r', personality: '', provider: 'kiro', isLead: true })
    await capturing.setStandupState({ projectId: project.id })

    expect(changes).toEqual(['projects', 'todos', 'todos', 'actions', 'personas', 'standup'])
  })

  it('self-heals index entries whose session file is gone', async () => {
    const project = await storage.addProject({ name: 'p1', path: tmpDir })
    const now = Date.now()
    const sessionId = '55555555-5555-4555-8555-555555555555'
    await storage.saveSession({
      id: sessionId, provider: 'kiro', projectId: project.id, title: 'ghost-to-be',
      createdAt: now, updatedAt: now, status: 'live', messages: [],
    })
    expect(await storage.listSessions()).toHaveLength(1)

    // Simulate external cleanup: the file vanishes behind the index's back.
    await rm(path.join(tmpDir, 'sessions', `${sessionId}.json`), { force: true })

    expect(await storage.getSession(sessionId)).toBeNull()
    expect(await storage.listSessions()).toHaveLength(0)
  })

  it('refuses to read or modify a corrupt collection file (no wipe-on-corrupt)', async () => {
    const project = await storage.addProject({ name: 'p1', path: tmpDir })
    await storage.addTodo({ projectId: project.id, text: 'Precious idea' })

    // Corrupt the file behind the storage layer's back.
    const { writeFileSync, readFileSync } = await import('fs')
    const todosFile = path.join(tmpDir, 'todos.json')
    writeFileSync(todosFile, '{"not": "an array"', 'utf-8')

    await expect(storage.listTodos(project.id)).rejects.toThrow(/not valid JSON/)
    await expect(
      storage.addTodo({ projectId: project.id, text: 'New idea' }),
    ).rejects.toThrow(/not valid JSON/)
    // The corrupt file was NOT overwritten with an empty/new list.
    expect(readFileSync(todosFile, 'utf-8')).toBe('{"not": "an array"')
  })

  it('unlinks action items when their gating todo is deleted (items survive)', async () => {
    const project = await storage.addProject({ name: 'p1', path: tmpDir })
    const todo = await storage.addTodo({ projectId: project.id, text: 'Shorts pipeline' })
    const item = await storage.addActionItem({
      projectId: project.id, text: 'Enable the YouTube API', todoId: todo.id,
    })

    await storage.removeTodo(todo.id)
    await storage.unlinkActionItemsFromTodo(todo.id)

    const [survivor] = await storage.listActionItems(project.id)
    expect(survivor.id).toBe(item.id)
    expect(survivor.todoId).toBeUndefined()
  })

  it('standup state upserts per project', async () => {
    const projectId = '44444444-4444-4444-8444-444444444444'
    expect(await storage.getStandupState(projectId)).toBeNull()
    await storage.setStandupState({ projectId, lastHash: 'h1' })
    await storage.setStandupState({ projectId, lastHash: 'h2', lastRunAt: 123 })
    const state = await storage.getStandupState(projectId)
    expect(state?.lastHash).toBe('h2')
    expect(state?.lastRunAt).toBe(123)
  })
})

// ---------------------------------------------------------------------------
// runTurn + StandupService end-to-end (mocked CLI)
// ---------------------------------------------------------------------------

describe('runTurn and StandupService', () => {
  let tmpDir: string
  let storage: StorageLayer
  let sessionManager: SessionManager
  let sent: PushPayload[]
  let standup: StandupService
  let project: Project

  beforeEach(async () => {
    // Stale callbacks from a previous test's unfinished spawn must not leak.
    mockSpawnStdoutCb = null
    mockSpawnCloseCb = null
    mockSpawnCount = 0
    consumedSpawns = 0

    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'codepipe-standup-'))
    storage = new StorageLayer(tmpDir)
    await storage.ensureDataDir()

    clearAdapters()
    registerAdapter('kiro', () => fakeAdapter)

    sessionManager = new SessionManager(storage)
    sent = []
    const pushStub = {
      isEnabled: () => true,
      sendToAll: async (p: PushPayload) => { sent.push(p) },
    } as unknown as PushService
    standup = new StandupService(storage, sessionManager, pushStub)

    project = await storage.addProject({ name: 'demo', path: tmpDir })
  })

  afterEach(async () => {
    await sessionManager.shutdown()
    await rm(tmpDir, { recursive: true, force: true })
  })

  it('runTurn resolves with the final assistant message', async () => {
    const session = await sessionManager.createSession('kiro', project.id)
    const turn = sessionManager.runTurn(session.id, 'hello')
    await completeTurn(['Hi there!'])
    const message = await turn
    expect(message?.role).toBe('assistant')
    expect(message?.content).toContain('Hi there!')
  })

  it('correlates queued runTurns with their own turns', async () => {
    const session = await sessionManager.createSession('kiro', project.id)
    const turnA = sessionManager.runTurn(session.id, 'first')
    const turnB = sessionManager.runTurn(session.id, 'second') // queued behind A

    await completeTurn(['reply A'])
    expect((await turnA)?.content).toContain('reply A')

    // A's completion dispatched B; drive B's turn to completion.
    await completeTurn(['reply B'])
    expect((await turnB)?.content).toContain('reply B')
  })

  it('routes every team turn, even with more input queued behind it', async () => {
    const lead = await storage.addPersona({
      name: 'Maya', role: 'Lead', personality: '', provider: 'kiro', isLead: true,
    })
    const session = await sessionManager.createSession('kiro', project.id, { kind: 'team' })

    sessionManager.handleInput(session.id, 'first question')
    sessionManager.handleInput(session.id, 'second question') // queued

    // Turn 1 completes while input 2 is still queued — it must be routed.
    await completeTurn(['Thinking.', '```json', JSON.stringify({ messages: [{ persona: 'Maya', text: 'Answer one' }] }), '```'])
    await waitFor(() => {
      const s = sessionManager.getSession(session.id)!
      if (!s.messages.some((m) => m.metadata?.personaId === lead.id && m.content === 'Answer one')) {
        throw new Error('turn 1 not routed yet')
      }
    })

    await completeTurn(['More.', '```json', JSON.stringify({ messages: [{ persona: 'Maya', text: 'Answer two' }] }), '```'])
    await waitFor(() => {
      const s = sessionManager.getSession(session.id)!
      if (!s.messages.some((m) => m.metadata?.personaId === lead.id && m.content === 'Answer two')) {
        throw new Error('turn 2 not routed yet')
      }
    })

    // Both raw replies were tagged as deliberation, neither kept its JSON tail.
    const deliberations = sessionManager
      .getSession(session.id)!
      .messages.filter((m) => m.metadata?.kind === 'deliberation')
    expect(deliberations).toHaveLength(2)
    for (const d of deliberations) expect(d.content).not.toContain('```json')
  })

  it('tracks a protocol fail streak, surfaces it at the threshold, and resets on success', async () => {
    const lead = await storage.addPersona({
      name: 'Maya', role: 'Lead', personality: '', provider: 'kiro', isLead: true,
    })
    const session = await sessionManager.createSession('kiro', project.id, { kind: 'team' })

    // Three consecutive turns with no parseable tail.
    for (let i = 1; i <= 3; i++) {
      sessionManager.handleInput(session.id, `question ${i}`)
      await completeTurn([`plain reply ${i}, no protocol tail`])
      await waitFor(async () => {
        const state = await storage.getStandupState(project.id)
        if ((state?.protocolFailStreak ?? 0) !== i) throw new Error('streak not recorded yet')
      })
    }

    // The degradation is surfaced once, in-thread, at the threshold.
    const messages = sessionManager.getSession(session.id)!.messages
    const warnings = messages.filter((m) => m.role === 'system' && m.content.includes('failed to parse'))
    expect(warnings).toHaveLength(1)
    // Fallback attribution kept the thread coherent throughout.
    expect(messages.filter((m) => m.metadata?.personaId === lead.id)).toHaveLength(3)

    // A compliant turn resets the streak.
    sessionManager.handleInput(session.id, 'question 4')
    await completeTurn(['Back on protocol.', '```json', JSON.stringify({ messages: [{ persona: 'Maya', text: 'Fixed.' }] }), '```'])
    await waitFor(async () => {
      const state = await storage.getStandupState(project.id)
      if (state?.protocolFailStreak !== 0) throw new Error('streak not reset yet')
    })
  })

  it('runTurn times out when the CLI never finishes, and cancelOnTimeout frees the session', async () => {
    const session = await sessionManager.createSession('kiro', project.id)
    await expect(
      sessionManager.runTurn(session.id, 'hello', { timeoutMs: 50, cancelOnTimeout: true }),
    ).rejects.toThrow(/timed out/)
    // The zombie turn was cancelled — new input dispatches immediately.
    expect(() => sessionManager.handleInput(session.id, 'again')).not.toThrow()
  })

  it('runs the pipeline: reviewer take → synthesis → routing, memo, and gates', async () => {
    registerAdapter('gemini', () => ({ ...fakeAdapter, provider: 'gemini' }))
    const lead = await storage.addPersona({
      name: 'Maya', role: 'Team lead', personality: 'Pragmatic.', provider: 'kiro', isLead: true,
    })
    // The reviewer runs on her OWN provider — independence includes the model.
    const dev = await storage.addPersona({
      name: 'Aria', role: 'Backend dev', personality: 'Curious.', provider: 'gemini', isLead: false,
    })
    await storage.updatePersona(lead.id, { avatar: 'maya.png' })

    const todo = await storage.addTodo({ projectId: project.id, text: 'Add retry backoff' })

    // Dispatch returns immediately with the dated synthesis session.
    const result = await standup.runStandup(project.id, { force: false })
    expect(result.ran).toBe(true)
    const session = sessionManager.getSession(result.sessionId!)
    expect(session?.kind).toBe('team')
    expect(session?.title).toContain('standup ·')

    // State is persisted at dispatch — a failed run can't re-dispatch today.
    const stateAtDispatch = await storage.getStandupState(project.id)
    expect(stateAtDispatch?.teamSessionId).toBe(result.sessionId)
    expect(stateAtDispatch?.lastRunAt).toBeTruthy()

    // Turn 1: Aria's throwaway reviewer session (on gemini).
    await completeTurn(['```json', JSON.stringify({ take: 'Backoff belongs in useSession.ts — small change.', concerns: ['Mind mobile Safari reconnects'], effort: '2h' }), '```'])
    await waitFor(async () => {
      const [t] = await storage.listTodos(project.id)
      if (!t.takes?.length) throw new Error('take not stored yet')
    })
    const [reviewedTodo] = await storage.listTodos(project.id)
    expect(reviewedTodo.takes![0].personaId).toBe(dev.id)
    expect(reviewedTodo.takes![0].concerns).toHaveLength(1)

    // Turn 2: the lead's synthesis in the dated session.
    const tail = {
      messages: [
        { persona: 'Maya', kind: 'proposal', text: 'We reviewed your idea — plan attached.' },
        { persona: 'aria', kind: 'question', text: 'Should this apply to mobile too?' },
      ],
      proposals: [
        { todoId: todo.id, summary: 'Backoff', approach: 'Exponential, cap 30s', effort: '2h', brief: 'Edit useSession.ts: add exponential backoff capped at 30s. Done when reconnects stop hammering.', persona: 'Aria' },
      ],
      user_actions: [
        { persona: 'Aria', text: 'Add STRIPE_SECRET_KEY to the server env', notes: 'Needed for checkout', kind: 'task', steps: ['Open the Stripe dashboard → API keys', 'Copy the secret key', 'Add STRIPE_SECRET_KEY=<value> to server/.env'], todoId: todo.id },
      ],
      memo: 'Backoff proposed; waiting on Stripe key from the user.',
    }
    await completeTurn(['We discussed it.', '```json', JSON.stringify(tail), '```'])

    // Routing is async after the turn lands — wait for its effects.
    await waitFor(async () => {
      const todos = await storage.listTodos(project.id)
      if (todos[0].status !== 'proposed') throw new Error('not routed yet')
    })

    // The synthesis prompt carried the reviewer's take, tagged for collapse.
    const promptMessage = session!.messages.find((m) => m.role === 'user')
    expect(promptMessage?.content).toContain('Backoff belongs in useSession.ts')
    expect(promptMessage?.metadata?.kind).toBe('prompt')

    const [routedTodo] = await storage.listTodos(project.id)
    expect(routedTodo.proposal?.brief).toContain('exponential backoff capped at 30s')
    expect(routedTodo.proposal?.personaId).toBe(dev.id)

    const personaMessages = session!.messages.filter((m) => m.metadata?.personaId)
    expect(personaMessages).toHaveLength(2)
    expect(personaMessages[0].metadata?.personaId).toBe(lead.id)
    expect(personaMessages[1].metadata?.personaId).toBe(dev.id)

    // The memo persisted as the next standup's memory.
    await waitFor(async () => {
      const state = await storage.getStandupState(project.id)
      if (!state?.memo?.includes('Backoff proposed')) throw new Error('memo not saved yet')
    })

    // Pushes: one per persona message, none for the reviewer session.
    expect(sent).toHaveLength(2)
    expect(sent[0].title).toBe('Maya · demo')
    expect(sent[0].icon).toBe('/api/avatars/maya.png')

    // The reviewer session was throwaway compute — deleted after harvest.
    expect(sessionManager.listSessions().filter((s) => s.kind === 'review')).toHaveLength(0)
    expect((await storage.listSessions()).filter((s) => s.kind === 'review')).toHaveLength(0)

    // The user action was recorded, attributed, typed with its guide, and
    // linked to the idea it gates.
    const actions = await storage.listActionItems(project.id)
    expect(actions).toHaveLength(1)
    expect(actions[0].kind).toBe('task')
    expect(actions[0].steps?.[2]).toContain('server/.env')
    expect(actions[0].todoId).toBe(todo.id)

    // Forced re-run: no actionable todos left → no reviewer turns, straight
    // to synthesis; the repeated user action does not duplicate.
    const again = await standup.runStandup(project.id, { force: true })
    expect(again.ran).toBe(true)
    expect(again.sessionId).not.toBe(result.sessionId) // ephemeral: new dated session
    await completeTurn(['Again.', '```json', JSON.stringify(tail), '```'])
    await waitFor(() => {
      const s = sessionManager.getSession(again.sessionId!)
      if (!s?.messages.some((m) => m.metadata?.personaId)) throw new Error('second run not routed yet')
    })
    expect(await storage.listActionItems(project.id)).toHaveLength(1)

    // Nothing new (no todos, no agenda) → next non-forced run is skipped.
    const third = await standup.runStandup(project.id, { force: false })
    expect(third.ran).toBe(false)
  })

  it('skips a re-run when leftover todos are unchanged (status flips don\'t defeat the gate)', async () => {
    await storage.addPersona({
      name: 'Maya', role: 'Lead', personality: '', provider: 'kiro', isLead: true,
    })
    await storage.addTodo({ projectId: project.id, text: 'Ambiguous idea' })

    // Solo-lead team: no reviewers, synthesis only. The team proposes
    // nothing — the todo stays actionable.
    const first = await standup.runStandup(project.id, { force: false })
    expect(first.ran).toBe(true)
    await completeTurn(['Hmm.', '```json', JSON.stringify({ messages: [{ persona: 'Maya', text: 'Need more context.' }] }), '```'])
    await waitFor(() => {
      const session = sessionManager.getSession(first.sessionId!)
      if (!session?.messages.some((m) => m.metadata?.personaId)) throw new Error('not routed yet')
    })

    const second = await standup.runStandup(project.id, { force: false })
    expect(second.ran).toBe(false)
    expect(second.reason).toContain('unchanged')
  })

  it('implements an approved proposal on the proposer\'s provider and closes the loop', async () => {
    registerAdapter('gemini', () => ({ ...fakeAdapter, provider: 'gemini' }))
    await storage.addPersona({
      name: 'Maya', role: 'Lead', personality: '', provider: 'kiro', isLead: true,
    })
    const dev = await storage.addPersona({
      name: 'Aria', role: 'Backend dev', personality: '', provider: 'gemini', isLead: false,
    })

    const todo = await storage.addTodo({ projectId: project.id, text: 'Add retry backoff' })
    await storage.updateTodo(todo.id, {
      status: 'proposed',
      proposal: { summary: 'Backoff', approach: 'Exponential, cap 30s', personaId: dev.id },
    })

    // No proposal / already-linked gates.
    const bare = await storage.addTodo({ projectId: project.id, text: 'No proposal yet' })
    expect((await standup.implementProposal(bare.id)).reason).toContain('no proposal')

    const result = await standup.implementProposal(todo.id)
    expect(result.ran).toBe(true)

    // The work session runs on the PROPOSER's provider, titled after them.
    const work = sessionManager.getSession(result.sessionId!)
    expect(work?.kind).toBe('work')
    expect(work?.provider).toBe('gemini')
    expect(work?.title).toContain('Aria')

    // Approved + linked before the turn ran; duplicate dispatch is refused.
    let linked = (await storage.listTodos(project.id)).find((t) => t.id === todo.id)!
    expect(linked.status).toBe('approved')
    expect(linked.workSessionId).toBe(result.sessionId)
    const dup = await standup.implementProposal(todo.id)
    expect(dup.ran).toBe(false)
    expect(dup.sessionId).toBe(result.sessionId)

    // The implementation turn completes → idea ships, and the completion
    // joins the next standup's agenda instead of costing an announcement turn.
    await completeTurn(['Implemented the backoff in useSession.ts. Tests pass.'])
    await waitFor(async () => {
      const t = (await storage.listTodos(project.id)).find((x) => x.id === todo.id)!
      if (t.status !== 'done' || !t.completedAt) throw new Error('not shipped yet')
    })
    await waitFor(async () => {
      const state = await storage.getStandupState(project.id)
      if (!state?.agenda?.some((a) => a.includes('Aria shipped'))) throw new Error('agenda not queued yet')
    })
    const state = await storage.getStandupState(project.id)
    expect(state!.agenda![0]).toContain('useSession.ts')
    // No extra CLI turn was spent on the announcement.
    expect(mockSpawnCount).toBe(consumedSpawns)
  })

  it('refines a proposal from user feedback via the team thread', async () => {
    const lead = await storage.addPersona({
      name: 'Maya', role: 'Lead', personality: '', provider: 'kiro', isLead: true,
    })
    const todo = await storage.addTodo({ projectId: project.id, text: 'Add retry backoff' })
    await storage.updateTodo(todo.id, {
      status: 'proposed',
      proposal: { summary: 'Backoff', approach: 'Plan v1', brief: 'Brief v1', personaId: lead.id },
    })
    const teamSession = await sessionManager.createSession('kiro', project.id, { kind: 'team' })
    await storage.setStandupState({ projectId: project.id, teamSessionId: teamSession.id })

    // No-proposal gate.
    const bare = await storage.addTodo({ projectId: project.id, text: 'Bare idea' })
    expect((await standup.refineProposal(bare.id, 'feedback')).reason).toContain('no proposal')

    const result = await standup.refineProposal(todo.id, 'Cap at 10s instead, and cover mobile Safari')
    expect(result.ran).toBe(true)
    expect(result.sessionId).toBe(teamSession.id)

    // The revised proposal flows back through the normal router.
    const revised = {
      messages: [{ persona: 'Maya', text: 'Updated — capped at 10s, Safari covered.' }],
      proposals: [{ todoId: todo.id, summary: 'Backoff v2', approach: 'Plan v2', brief: 'Brief v2: cap 10s, test mobile Safari' }],
    }
    await completeTurn(['Discussing the feedback.', '```json', JSON.stringify(revised), '```'])
    await waitFor(async () => {
      const t = (await storage.listTodos(project.id)).find((x) => x.id === todo.id)!
      if (t.proposal?.brief !== 'Brief v2: cap 10s, test mobile Safari') throw new Error('not revised yet')
    })
    const t = (await storage.listTodos(project.id)).find((x) => x.id === todo.id)!
    expect(t.status).toBe('proposed')
    expect(t.proposal?.summary).toBe('Backoff v2')
    expect(
      sessionManager.getSession(teamSession.id)!.messages.some(
        (m) => m.metadata?.personaId === lead.id && m.content.includes('capped at 10s'),
      ),
    ).toBe(true)
  })

  it('queues resolved actions on the agenda, and the next standup consumes them', async () => {
    const lead = await storage.addPersona({
      name: 'Maya', role: 'Lead', personality: '', provider: 'kiro', isLead: true,
    })

    // Resolving a team-raised item costs ZERO turns — it queues.
    const item = await storage.addActionItem({
      projectId: project.id, text: 'Create the Stripe account', personaId: lead.id,
    })
    const done = await storage.updateActionItem(item.id, { status: 'done' })
    await standup.notifyActionResolved(done)
    expect(mockSpawnCount).toBe(0)

    let state = await storage.getStandupState(project.id)
    expect(state?.agenda).toHaveLength(1)
    expect(state?.agenda?.[0]).toContain('Create the Stripe account')

    // An agenda alone makes the next standup due, even with no open todos.
    const run = await standup.runStandup(project.id, { force: false })
    expect(run.ran).toBe(true)

    // The agenda is consumed at dispatch and lands in the synthesis prompt.
    state = await storage.getStandupState(project.id)
    expect(state?.agenda).toHaveLength(0)
    await completeTurn(['Noted.', '```json', JSON.stringify({ messages: [{ persona: 'Maya', text: 'Stripe is unblocked — nice.' }], memo: 'Stripe account exists now.' }), '```'])
    await waitFor(() => {
      const s = sessionManager.getSession(run.sessionId!)
      if (!s?.messages.some((m) => m.metadata?.personaId === lead.id)) throw new Error('not routed yet')
    })
    const prompt = sessionManager.getSession(run.sessionId!)!.messages.find((m) => m.role === 'user')
    expect(prompt?.content).toContain('Since the last standup')
    expect(prompt?.content).toContain('Create the Stripe account')
  })

  it('relays a decision answer with the options the team offered', async () => {
    const lead = await storage.addPersona({
      name: 'Maya', role: 'Lead', personality: '', provider: 'kiro', isLead: true,
    })
    const item = await storage.addActionItem({
      projectId: project.id, text: 'Which auth provider?', kind: 'decision',
      notes: 'Options: Clerk or Auth0. We recommend Clerk.', personaId: lead.id,
    })
    const done = await storage.updateActionItem(item.id, {
      status: 'done', resolution: 'Go with your recommendation.',
    })
    await standup.notifyActionResolved(done)

    const [entry] = (await storage.getStandupState(project.id))!.agenda!
    expect(entry).toContain('The user answered "Which auth provider?": Go with your recommendation.')
    expect(entry).toContain('We recommend Clerk')
  })

  it('tells the standup what is tracked, closes settled items, and never re-raises', async () => {
    const lead = await storage.addPersona({
      name: 'Maya', role: 'Lead', personality: '', provider: 'kiro', isLead: true,
    })
    const pending = await storage.addActionItem({
      projectId: project.id, text: 'Pick an auth provider', kind: 'decision', personaId: lead.id,
    })
    const manual = await storage.addActionItem({ projectId: project.id, text: 'Renew the domain' })
    const answered = await storage.addActionItem({
      projectId: project.id, text: 'Pick a database', kind: 'decision', personaId: lead.id,
    })
    await storage.updateActionItem(answered.id, { status: 'done', resolution: 'Postgres' })

    const run = await standup.runStandup(project.id, { force: true })
    expect(run.ran).toBe(true)
    await completeTurn(['Sorted.', '```json', JSON.stringify({
      messages: [{ persona: 'Maya', text: 'Auth is settled, Clerk it is.' }],
      // A re-raise of the just-answered item (same text) must not duplicate,
      // and the manual item is the user's — the team can't close it.
      user_actions: [{ persona: 'Maya', text: 'Pick a  DATABASE', kind: 'decision' }],
      resolved_actions: [pending.id.slice(0, 8), manual.id, 'no-such-id'],
    }), '```'])
    await waitFor(async () => {
      const item = (await storage.listActionItems(project.id)).find((a) => a.id === pending.id)
      if (item?.status !== 'done') throw new Error('not routed yet')
    })

    const prompt = sessionManager.getSession(run.sessionId!)!.messages.find((m) => m.role === 'user')
    expect(prompt?.content).toContain(`[${pending.id}] (decision) Pick an auth provider`)
    expect(prompt?.content).toContain("The user's answer: Postgres")

    const items = await storage.listActionItems(project.id)
    expect(items).toHaveLength(3)
    expect(items.find((a) => a.id === manual.id)?.status).toBe('open')
    // Closed by the team → no agenda echo back to the team.
    expect((await storage.getStandupState(project.id))?.agenda ?? []).toHaveLength(0)
  })

  it('skips when there are no personas or no todos', async () => {
    const noPersonas = await standup.runStandup(project.id, { force: true })
    expect(noPersonas.ran).toBe(false)
    expect(noPersonas.reason).toContain('personas')

    await storage.addPersona({
      name: 'Maya', role: 'Lead', personality: '', provider: 'kiro', isLead: true,
    })
    const noTodos = await standup.runStandup(project.id, { force: false })
    expect(noTodos.ran).toBe(false)
    expect(noTodos.reason).toContain('todo')
  })
})
