import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, rm } from 'fs/promises'
import path from 'path'
import os from 'os'

// ---------------------------------------------------------------------------
// Mock child_process.spawn (non-interactive adapter turns)
// ---------------------------------------------------------------------------

let mockSpawnStdoutCb: ((data: Buffer) => void) | null = null
let mockSpawnCloseCb: ((code: number) => void) | null = null

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>
  return {
    ...actual,
    spawn: vi.fn(() => {
      mockSpawnStdoutCb = null
      mockSpawnCloseCb = null
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

vi.mock('node-pty', () => ({ spawn: vi.fn() }))

// Import AFTER mocks are set up
import { StorageLayer } from './storage.js'
import { SessionManager } from './session-manager.js'
import { StandupService, hashTodos, isSameLocalDay, isStandupDue } from './standup.js'
import { parseStandupTail, matchPersona, matchTodo, buildStandupPrompt } from './standup-protocol.js'
import { registerAdapter, clearAdapters } from './adapters/registry.js'
import type { ICLIAdapter } from './adapters/types.js'
import type { Persona, Project, Todo } from './schemas.js'
import type { PushPayload, PushService } from './push.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const fakeAdapter: ICLIAdapter = {
  provider: 'kiro',
  command: 'fake-cli',
  args: [],
  nonInteractive: true,
  transport: 'oneshot',
  onData: (line) =>
    line.length > 0 ? [{ type: 'chunk', role: 'assistant', content: line }] : [],
  notifyUserInput: () => {},
  notifySystemInput: () => {},
  reset: () => {},
  formatAttachment: () => '',
  getResumeCommand: () => null,
  buildMessageCommand: (text) => ({ command: 'fake-cli', args: [text] }),
  cliSessionDir: null,
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

/** Feed the pending mocked CLI turn with output lines, then close it. */
async function completeTurn(lines: string[]): Promise<void> {
  await vi.waitFor(() => {
    if (!mockSpawnCloseCb) throw new Error('CLI not spawned yet')
  })
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
    await vi.waitFor(() => {
      const s = sessionManager.getSession(session.id)!
      if (!s.messages.some((m) => m.metadata?.personaId === lead.id && m.content === 'Answer one')) {
        throw new Error('turn 1 not routed yet')
      }
    })

    await completeTurn(['More.', '```json', JSON.stringify({ messages: [{ persona: 'Maya', text: 'Answer two' }] }), '```'])
    await vi.waitFor(() => {
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
      await vi.waitFor(async () => {
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
    await vi.waitFor(async () => {
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

  it('runs a standup: routes persona messages, applies proposals, pushes, gates re-runs', async () => {
    const lead = await storage.addPersona({
      name: 'Maya', role: 'Team lead', personality: 'Pragmatic.', provider: 'kiro', isLead: true,
    })
    const dev = await storage.addPersona({
      name: 'Aria', role: 'Backend dev', personality: 'Curious.', provider: 'kiro', isLead: false,
    })
    await storage.updatePersona(lead.id, { avatar: 'maya.png' })

    const todo = await storage.addTodo({ projectId: project.id, text: 'Add retry backoff' })

    const tail = {
      messages: [
        { persona: 'Maya', kind: 'proposal', text: 'We reviewed your idea — plan attached.' },
        { persona: 'aria', kind: 'question', text: 'Should this apply to mobile too?' },
      ],
      proposals: [
        { todoId: todo.id, summary: 'Backoff', approach: 'Exponential, cap 30s', effort: '2h', persona: 'Aria' },
      ],
      user_actions: [
        { persona: 'Aria', text: 'Add STRIPE_SECRET_KEY to the server env', notes: 'Needed for checkout' },
      ],
    }

    // Dispatch returns immediately; the turn completes in the background.
    const result = await standup.runStandup(project.id, { force: false })
    expect(result.ran).toBe(true)
    await completeTurn(['We discussed it.', '```json', JSON.stringify(tail), '```'])

    // State (incl. the team session id) is persisted at dispatch, so a
    // failed turn can never orphan the session or re-dispatch the same day.
    const stateAtDispatch = await storage.getStandupState(project.id)
    expect(stateAtDispatch?.teamSessionId).toBe(result.sessionId)
    expect(stateAtDispatch?.lastRunAt).toBeTruthy()

    // Routing is async after the turn lands — wait for its effects.
    await vi.waitFor(async () => {
      const todos = await storage.listTodos(project.id)
      if (todos[0].status !== 'proposed') throw new Error('not routed yet')
    })

    const [routedTodo] = await storage.listTodos(project.id)
    expect(routedTodo.proposal?.approach).toBe('Exponential, cap 30s')
    expect(routedTodo.proposal?.personaId).toBe(dev.id)

    const session = sessionManager.getSession(result.sessionId!)
    expect(session?.kind).toBe('team')
    const personaMessages = session!.messages.filter((m) => m.metadata?.personaId)
    expect(personaMessages).toHaveLength(2)
    expect(personaMessages[0].metadata?.personaId).toBe(lead.id)
    expect(personaMessages[1].metadata?.personaId).toBe(dev.id)

    // The deliberation is tagged and the JSON tail stripped.
    const deliberation = session!.messages.find((m) => m.metadata?.kind === 'deliberation')
    expect(deliberation).toBeDefined()
    expect(deliberation!.content).not.toContain('```json')

    // Pushes: one per persona message, lead's carries her avatar icon.
    expect(sent).toHaveLength(2)
    expect(sent[0].title).toBe('Maya · demo')
    expect(sent[0].icon).toBe('/api/avatars/maya.png')
    expect(sent[1].title).toBe('Aria · demo')
    expect(sent[1].icon).toBeUndefined()

    // The user action was recorded and attributed.
    const actions = await storage.listActionItems(project.id)
    expect(actions).toHaveLength(1)
    expect(actions[0].status).toBe('open')
    expect(actions[0].personaId).toBe(dev.id)
    expect(actions[0].notes).toBe('Needed for checkout')

    // A second run emitting the same user action does not duplicate it.
    const again = await standup.runStandup(project.id, { force: true })
    expect(again.ran).toBe(true)
    await completeTurn(['Again.', '```json', JSON.stringify(tail), '```'])
    await vi.waitFor(() => {
      const s = sessionManager.getSession(result.sessionId!)
      if ((s?.messages.filter((m) => m.metadata?.personaId).length ?? 0) < 4) {
        throw new Error('second turn not routed yet')
      }
    })
    expect(await storage.listActionItems(project.id)).toHaveLength(1)

    // Unchanged todo list → the next non-forced run is skipped.
    // (The status flip to 'proposed' removed it from the actionable set.)
    const second = await standup.runStandup(project.id, { force: false })
    expect(second.ran).toBe(false)
  })

  it('skips a re-run when leftover todos are unchanged, and rotates the team session when the lead provider changes', async () => {
    registerAdapter('gemini', () => ({ ...fakeAdapter, provider: 'gemini' }))
    const lead = await storage.addPersona({
      name: 'Maya', role: 'Lead', personality: '', provider: 'kiro', isLead: true,
    })
    await storage.addTodo({ projectId: project.id, text: 'Ambiguous idea' })

    // First run: the team discusses but proposes nothing — todo stays actionable.
    const first = await standup.runStandup(project.id, { force: false })
    expect(first.ran).toBe(true)
    await completeTurn(['Hmm.', '```json', JSON.stringify({ messages: [{ persona: 'Maya', text: 'Need more context.' }] }), '```'])
    await vi.waitFor(() => {
      const session = sessionManager.getSession(first.sessionId!)
      if (!session?.messages.some((m) => m.metadata?.personaId)) throw new Error('not routed yet')
    })

    // Same content next time → skipped (status flips don't defeat the gate).
    const second = await standup.runStandup(project.id, { force: false })
    expect(second.ran).toBe(false)
    expect(second.reason).toContain('unchanged')

    // New lead provider → forced run creates a fresh team session on that CLI.
    await storage.updatePersona(lead.id, { provider: 'gemini' })
    const third = await standup.runStandup(project.id, { force: true })
    expect(third.ran).toBe(true)
    expect(third.sessionId).not.toBe(first.sessionId)
    expect(sessionManager.getSession(third.sessionId!)?.provider).toBe('gemini')
    await completeTurn(['ok'])
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

    // A team thread must exist for the completion announcement.
    const teamSession = await sessionManager.createSession('kiro', project.id, { kind: 'team' })
    await storage.setStandupState({ projectId: project.id, teamSessionId: teamSession.id })

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

    // The implementation turn completes → idea ships.
    await completeTurn(['Implemented the backoff in useSession.ts. Tests pass.'])
    mockSpawnStdoutCb = null
    mockSpawnCloseCb = null
    await vi.waitFor(async () => {
      const t = (await storage.listTodos(project.id)).find((x) => x.id === todo.id)!
      if (t.status !== 'done' || !t.completedAt) throw new Error('not shipped yet')
    })

    // The announcement turn runs in the TEAM thread and routes as Aria.
    await completeTurn(['', '```json', JSON.stringify({ messages: [{ persona: 'Aria', text: 'Shipped the backoff — take a look.' }] }), '```'])
    await vi.waitFor(() => {
      const s = sessionManager.getSession(teamSession.id)!
      if (!s.messages.some((m) => m.metadata?.personaId === dev.id && m.content.includes('Shipped'))) {
        throw new Error('announcement not routed yet')
      }
    })
    expect(sent.some((p) => p.title.startsWith('Aria'))).toBe(true)
  })

  it('pings the team thread when a team-raised action item is resolved', async () => {
    const lead = await storage.addPersona({
      name: 'Maya', role: 'Lead', personality: '', provider: 'kiro', isLead: true,
    })
    await storage.addTodo({ projectId: project.id, text: 'Add checkout' })

    // Establish a team thread via a standup.
    const run = await standup.runStandup(project.id, { force: false })
    await completeTurn(['Plan.', '```json', JSON.stringify({ messages: [{ persona: 'Maya', text: 'On it.' }] }), '```'])
    await vi.waitFor(() => {
      const s = sessionManager.getSession(run.sessionId!)
      if (!s?.messages.some((m) => m.metadata?.personaId)) throw new Error('not routed yet')
    })
    const messagesBefore = sessionManager.getSession(run.sessionId!)!.messages.length

    // Resolve a team-raised action item → background ping → persona reply.
    const item = await storage.addActionItem({
      projectId: project.id, text: 'Create the Stripe account', personaId: lead.id,
    })
    const done = await storage.updateActionItem(item.id, { status: 'done' })
    // The ping spawns asynchronously — drop the previous turn's stale
    // callbacks so completeTurn waits for the NEW spawn.
    mockSpawnStdoutCb = null
    mockSpawnCloseCb = null
    const ping = standup.notifyActionResolved(done)
    await completeTurn(['', '```json', JSON.stringify({ messages: [{ persona: 'Maya', text: 'Stripe is unblocked — starting checkout.' }] }), '```'])
    await ping

    await vi.waitFor(() => {
      const s = sessionManager.getSession(run.sessionId!)!
      const lastMsg = s.messages[s.messages.length - 1]
      if (s.messages.length <= messagesBefore || !lastMsg.metadata?.personaId) {
        throw new Error('reply not routed yet')
      }
    })
    const messages = sessionManager.getSession(run.sessionId!)!.messages
    const reply = messages[messages.length - 1]
    expect(reply.metadata?.personaId).toBe(lead.id)
    expect(reply.content).toContain('unblocked')

    // No team thread → no-op, no throw.
    const other = await storage.addProject({ name: 'other', path: tmpDir })
    await expect(
      standup.notifyActionResolved({ ...done, projectId: other.id }),
    ).resolves.toBeUndefined()
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
