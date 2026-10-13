import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, rm } from 'fs/promises'
import path from 'path'
import os from 'os'

// ---------------------------------------------------------------------------
// Mock child_process.spawn (non-interactive adapter turns)
// ---------------------------------------------------------------------------

let mockSpawnStdoutCb: ((data: Buffer) => void) | null = null
let mockSpawnStderrCb: ((data: Buffer) => void) | null = null
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
        stderr: {
          on(event: string, cb: (data: Buffer) => void) {
            if (event === 'data') mockSpawnStderrCb = cb
          },
        },
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
import { parseReviewerOutput, matchPersona, matchTodo, buildStandupPrompt, buildImplementPrompt, trackedActions, RESOLVED_ACTION_WINDOW_MS } from './standup-protocol.js'
import { registerAdapter, clearAdapters } from './adapters/registry.js'
import { AgentToolService } from './agent-tool-registry.js'
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
  // `TOOL <name>` lines stand in for a tool call between chunks of prose.
  onData: (line) =>
    line.startsWith('TOOL ')
      ? [{ type: 'tool_use', tool: line.slice(5), content: line.slice(5) }]
      : line.length > 0 ? [{ type: 'chunk', role: 'assistant', content: line }] : [],
  // Kiro-style: tool calls can also arrive on stderr, mid-reply.
  onStderr: (text) =>
    text.split('\n').filter((l) => l.startsWith('TOOL ')).map((l) => ({ type: 'tool_use' as const, tool: l.slice(5), content: l.slice(5) })),
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

/** Wait until the next CLI turn has spawned, without completing it. */
async function waitForSpawn(): Promise<void> {
  await waitFor(() => {
    if (mockSpawnCount <= consumedSpawns || !mockSpawnCloseCb) throw new Error('next CLI turn not spawned yet')
  })
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

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

  it('finds an unfenced JSON object after prose (fence stripped, bare "json" label)', () => {
    const out = parseReviewerOutput([
      'I have enough grounding. {braces} in prose are fine.',
      'json',
      '{',
      '  "take": "The adapter is the fragile part: no {status} polling.",',
      '  "concerns": ["Tokens expire", "Not idempotent"],',
      '  "effort": "1-2d"',
      '}',
      'Trailing chatter.',
    ].join('\n'))
    expect(out.take).toBe('The adapter is the fragile part: no {status} polling.')
    expect(out.concerns).toEqual(['Tokens expire', 'Not idempotent'])
    expect(out.effort).toBe('1-2d')
  })

  it('is not thrown off by an unclosed brace in the prose', () => {
    const out = parseReviewerOutput('The config looks like { "a": 1 and so on.\n{"take": "Real take."}')
    expect(out.take).toBe('Real take.')
  })

  it('salvages complete fields from a truncated JSON object', () => {
    // What got stored when the whole reply was kept and cut at 2000 chars.
    const out = parseReviewerOutput(
      'Prose first.\njson\n{\n  "take": "Code is done; the \\"real\\" work is ops.",\n  "concerns": [\n    "No connect script",\n    "Tokens in .env, not Secret Man',
    )
    expect(out.take).toBe('Code is done; the "real" work is ops.')
    expect(out.concerns).toEqual(['No connect script'])
    expect(out.effort).toBeUndefined()
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
  it('includes roster, todo ids, and the tool contract', () => {
    const project = { id: 'p', name: 'codepipe', path: '/x' } as Project
    const prompt = buildStandupPrompt(project, [makePersona()], [makeTodo()])
    expect(prompt).toContain('Maya (team lead)')
    expect(prompt).toContain('[11111111-1111-4111-8111-111111111111]')
    expect(prompt).toContain('team protocol v7')
    expect(prompt).not.toContain('```json')
    // The contract asks for execution briefs, typed user actions and the memo.
    for (const tool of ['propose_plan', 'add_action_item', 'resolve_action_item', 'complete_idea', 'save_memo']) {
      expect(prompt).toContain(`\`${tool}\``)
    }
    expect(prompt).toContain('brief')
    expect(prompt).toContain('kind `decision`')
  })

  it('shows the team what is already tracked, and what the user answered', () => {
    const project = { id: 'p', name: 'codepipe', path: '/x' } as Project
    const base = { projectId: 'p', createdAt: 1, updatedAt: 1 }
    const prompt = buildStandupPrompt(project, [makePersona()], [], {
      actions: [
        { ...base, id: '22222222-2222-4222-8222-222222222222', text: 'Pick an auth provider', kind: 'decision', status: 'open' },
        { ...base, id: '44444444-4444-4444-8444-444444444444', text: 'Note the CDN quota', status: 'open', blocking: false },
        { ...base, id: '66666666-6666-4666-8666-666666666666', text: 'Renew the cert', status: 'open', dueDate: '2026-10-01' },
        { ...base, id: '77777777-7777-4777-8777-777777777777', text: 'File taxes', status: 'open', dueDate: '2026-10-09' },
        { ...base, id: '88888888-8888-4888-8888-888888888888', text: 'Order cards', status: 'open', dueDate: '2026-10-20' },
        { ...base, id: '33333333-3333-4333-8333-333333333333', text: 'Pick a DB', kind: 'decision', status: 'done', resolution: 'Postgres' },
        { ...base, id: '55555555-5555-4555-8555-555555555555', text: 'Buy a domain', status: 'dismissed', resolution: 'Using a subdomain' },
      ],
      today: '2026-10-09',
    })
    expect(prompt).toContain('do NOT raise these again')
    expect(prompt).toContain('5 of at most 4')
    expect(prompt).toContain("today's standup (2026-10-09)")
    expect(prompt).toContain('(task, due 2026-10-01 (overdue)) Renew the cert')
    expect(prompt).toContain('(task, due 2026-10-09 (today)) File taxes')
    expect(prompt).toContain('(task, due 2026-10-20) Order cards')
    expect(prompt).toContain('[22222222-2222-4222-8222-222222222222] (decision) Pick an auth provider')
    expect(prompt).toContain('(task, non-blocking) Note the CDN quota')
    expect(prompt).toContain("The user's answer: Postgres")
    expect(prompt).toContain('Declined by the user')
    expect(prompt).toContain('Their reason: Using a subdomain')
    // Resolved items are context, not something to reference by id.
    expect(prompt).not.toContain('33333333-3333-4333-8333-333333333333')
  })

  it('asks for tappable options, and lists planned ideas to check for shipped work', () => {
    const project = { id: 'p', name: 'codepipe', path: '/x' } as Project
    const planned = makeTodo({ status: 'proposed', text: 'Global error toasts' })
    const prompt = buildStandupPrompt(project, [makePersona()], [], { planned: [planned] })
    expect(prompt).toContain('2–4 `options`')
    expect(prompt).toContain('marking your recommendation')
    expect(prompt).toContain('At most 4 items may wait')
    expect(prompt).toContain(`[${planned.id}] (proposed) Global error toasts`)
    expect(prompt).toContain('report it with `complete_idea`')
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
  let tools: AgentToolService
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
    tools = new AgentToolService({
      storage,
      sessionManager,
      onTeamActionClosed: (item) => standup.notifyActionResolved(item),
    })

    project = await storage.addProject({ name: 'demo', path: tmpDir })
  })

  afterEach(async () => {
    // Shutdown rejects any turn still waiting on the fake CLI, which lets
    // the background pipelines finish; then their last writes land before
    // the directory goes away.
    await sessionManager.shutdown()
    await standup.whenIdle(5_000)
    await storage.whenIdle()
    await rm(tmpDir, { recursive: true, force: true })
  })

  /** What the CLI does mid-turn: call one of CodePipe's tools. */
  async function callTool(sessionId: string, name: string, args: Record<string, unknown>) {
    return tools.call(sessionManager.getSession(sessionId)!, name, args)
  }

  it('runTurn resolves with the final assistant message', async () => {
    const session = await sessionManager.createSession('kiro', project.id)
    const turn = sessionManager.runTurn(session.id, 'hello')
    await completeTurn(['Hi there!'])
    const message = await turn
    expect(message?.role).toBe('assistant')
    expect(message?.content).toContain('Hi there!')
  })

  it('a tool call on stderr splits the reply: streamed text before it becomes its own message', async () => {
    const session = await sessionManager.createSession('kiro', project.id)
    const turn = sessionManager.runTurn(session.id, 'hello')
    await waitForSpawn()
    consumedSpawns = mockSpawnCount
    // Kiro streams prose with no newline until the very end.
    mockSpawnStdoutCb?.(Buffer.from('Let me look.'))
    mockSpawnStderrCb?.(Buffer.from('TOOL read\n'))
    mockSpawnStdoutCb?.(Buffer.from('Found it.\n'))
    mockSpawnCloseCb?.(0)
    expect((await turn)?.content).toBe('Found it.')
    expect(sessionManager.getSession(session.id)!.messages.map((m) => `${m.role}:${m.content}`)).toEqual([
      'user:hello', 'assistant:Let me look.', 'tool:read', 'assistant:Found it.',
    ])
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

  it('routes every team turn: the final reply is the lead, the narration before it collapses', async () => {
    const lead = await storage.addPersona({
      name: 'Maya', role: 'Lead', personality: '', provider: 'kiro', isLead: true,
    })
    const session = await sessionManager.createSession('kiro', project.id, { kind: 'team' })

    sessionManager.handleInput(session.id, 'first question')
    sessionManager.handleInput(session.id, 'second question') // queued

    // Turn 1 completes while input 2 is still queued — it must be routed.
    await completeTurn(['Let me check the code.', 'TOOL save_memo', 'Answer one'])
    await waitFor(() => {
      const s = sessionManager.getSession(session.id)!
      if (!s.messages.some((m) => m.metadata?.personaId === lead.id && m.content === 'Answer one')) {
        throw new Error('turn 1 not routed yet')
      }
    })

    await completeTurn(['Answer two'])
    await waitFor(() => {
      const s = sessionManager.getSession(session.id)!
      if (!s.messages.some((m) => m.metadata?.personaId === lead.id && m.content === 'Answer two')) {
        throw new Error('turn 2 not routed yet')
      }
    })

    const messages = sessionManager.getSession(session.id)!.messages
    expect(messages.filter((m) => m.metadata?.kind === 'deliberation').map((m) => m.content)).toEqual([
      'Let me check the code.',
    ])
    expect(sent.map((p) => p.body)).toEqual(['Answer one', 'Answer two'])
  })

  it('runTurn times out when the CLI never finishes, and cancelOnTimeout frees the session', async () => {
    const session = await sessionManager.createSession('kiro', project.id)
    await expect(
      sessionManager.runTurn(session.id, 'hello', { timeoutMs: 50, cancelOnTimeout: true }),
    ).rejects.toThrow(/timed out/)
    // The zombie turn was cancelled — new input dispatches immediately.
    expect(() => sessionManager.handleInput(session.id, 'again')).not.toThrow()
  })

  it('runs the pipeline: reviewer take → synthesis through the tools → routing, memo, and gates', async () => {
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

    // Turn 2: the lead's synthesis — the team acts through the tools.
    await waitForSpawn()
    const synthesis = { idea_id: todo.id, summary: 'Backoff', approach: 'Exponential, cap 30s', effort: '2h', brief: 'Edit useSession.ts: add exponential backoff capped at 30s. Done when reconnects stop hammering.', persona: 'Aria' }
    const stripe = { persona: 'Aria', text: 'Add STRIPE_SECRET_KEY to the server env', notes: 'Needed for checkout', kind: 'task', steps: ['Open the Stripe dashboard → API keys', 'Copy the secret key', 'Add STRIPE_SECRET_KEY=<value> to server/.env'], todo_id: todo.id.slice(0, 8), due_date: '2026-11-30' }
    expect((await callTool(result.sessionId!, 'propose_plan', synthesis)).isError).toBeUndefined()
    expect((await callTool(result.sessionId!, 'add_action_item', stripe)).text).toContain('Added')
    await callTool(result.sessionId!, 'save_memo', { memo: 'Backoff proposed; waiting on Stripe key from the user.' })
    await completeTurn(['We reviewed your idea — plan attached.'])

    await waitFor(() => {
      if (!session!.messages.some((m) => m.metadata?.personaId)) throw new Error('not routed yet')
    })

    // The synthesis prompt carried the reviewer's take, tagged for collapse.
    const promptMessage = session!.messages.find((m) => m.role === 'user')
    expect(promptMessage?.content).toContain('Backoff belongs in useSession.ts')
    expect(promptMessage?.content).toContain('propose_plan')
    expect(promptMessage?.metadata?.kind).toBe('prompt')

    const [routedTodo] = await storage.listTodos(project.id)
    expect(routedTodo.status).toBe('proposed')
    expect(routedTodo.proposal?.brief).toContain('exponential backoff capped at 30s')
    expect(routedTodo.proposal?.personaId).toBe(dev.id)

    // The final reply is the lead's message, pushed under her name and face.
    const personaMessages = session!.messages.filter((m) => m.metadata?.personaId)
    expect(personaMessages).toHaveLength(1)
    expect(personaMessages[0].metadata?.personaId).toBe(lead.id)
    expect(sent).toHaveLength(1)
    expect(sent[0].title).toBe('Maya · demo')
    expect(sent[0].icon).toBe('/api/avatars/maya.png')

    // The memo persisted as the next standup's memory — and since it was
    // saved, no missing-tools warning.
    const state = await storage.getStandupState(project.id)
    expect(state?.memo).toContain('Backoff proposed')
    await new Promise((r) => setTimeout(r, 50))
    expect(session!.messages.some((m) => m.role === 'system' && m.content.includes("didn't load"))).toBe(false)

    // The reviewer session was throwaway compute — deleted after harvest.
    expect(sessionManager.listSessions().filter((s) => s.kind === 'review')).toHaveLength(0)
    expect((await storage.listSessions()).filter((s) => s.kind === 'review')).toHaveLength(0)

    // The user action was recorded, attributed, typed with its guide, linked
    // to the idea it gates, and shown in the thread as a card.
    const actions = await storage.listActionItems(project.id)
    expect(actions).toHaveLength(1)
    expect(actions[0]).toMatchObject({ kind: 'task', dueDate: '2026-11-30', todoId: todo.id, personaId: dev.id })
    expect(actions[0].steps?.[2]).toContain('server/.env')
    expect(session!.messages.some((m) => m.metadata?.kind === 'action' && m.metadata.action?.itemId === actions[0].id)).toBe(true)

    // Forced re-run: no actionable todos left → no reviewer turns, straight
    // to synthesis; the repeated user action does not duplicate.
    const again = await standup.runStandup(project.id, { force: true })
    expect(again.ran).toBe(true)
    expect(again.sessionId).not.toBe(result.sessionId) // ephemeral: new dated session
    await waitForSpawn()
    expect((await callTool(again.sessionId!, 'add_action_item', stripe)).text).toContain('Already tracked')
    await completeTurn(['Again.'])
    await waitFor(() => {
      const s = sessionManager.getSession(again.sessionId!)
      if (!s?.messages.some((m) => m.metadata?.personaId)) throw new Error('second run not routed yet')
    })
    expect(await storage.listActionItems(project.id)).toHaveLength(1)

    // Nothing new (no todos, no agenda) → next non-forced run is skipped.
    const third = await standup.runStandup(project.id, { force: false })
    expect(third.ran).toBe(false)
  })

  it('warns in the thread when a standup ends without saving the memo (tools not loaded)', async () => {
    await storage.addPersona({
      name: 'Maya', role: 'Lead', personality: '', provider: 'kiro', isLead: true,
    })
    await storage.addTodo({ projectId: project.id, text: 'Some idea' })
    const run = await standup.runStandup(project.id, { force: false })
    // A CLI without the tools can only talk.
    await completeTurn(['Here is my plan, in prose only.'])
    await waitFor(() => {
      const s = sessionManager.getSession(run.sessionId!)!
      if (!s.messages.some((m) => m.role === 'system' && m.content.includes("didn't load for Kiro"))) {
        throw new Error('warning not posted yet')
      }
    })
    const warning = sessionManager.getSession(run.sessionId!)!.messages.find((m) => m.content.includes("didn't load"))
    expect(warning?.content).toContain('npm run agent-tool:install')
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
    await completeTurn(['Need more context.'])
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
    const linked = (await storage.listTodos(project.id)).find((t) => t.id === todo.id)!
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

    // The revised proposal is re-saved through the tool, replacing v1.
    await waitForSpawn()
    expect(sessionManager.getSession(teamSession.id)!.messages.find((m) => m.role === 'user')?.content).toContain(`propose_plan\` on idea [${todo.id}]`)
    await callTool(teamSession.id, 'propose_plan', {
      idea_id: todo.id, summary: 'Backoff v2', approach: 'Plan v2', brief: 'Brief v2: cap 10s, test mobile Safari',
    })
    await completeTurn(['Updated — capped at 10s, Safari covered.'])
    await waitFor(() => {
      const s = sessionManager.getSession(teamSession.id)!
      if (!s.messages.some((m) => m.metadata?.personaId === lead.id && m.content.includes('capped at 10s'))) {
        throw new Error('not routed yet')
      }
    })
    const t = (await storage.listTodos(project.id)).find((x) => x.id === todo.id)!
    expect(t.status).toBe('proposed')
    expect(t.proposal).toMatchObject({ summary: 'Backoff v2', brief: 'Brief v2: cap 10s, test mobile Safari' })
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
    await completeTurn(['Stripe is unblocked — nice.'])
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
    await waitForSpawn()
    // A re-raise of the just-answered item (same text) must not duplicate,
    // and the manual item is the user's — the team can't close it.
    expect((await callTool(run.sessionId!, 'add_action_item', { persona: 'Maya', text: 'Pick a  DATABASE', kind: 'decision' })).text).toContain('Already tracked')
    expect((await callTool(run.sessionId!, 'resolve_action_item', { id: pending.id.slice(0, 8) })).isError).toBeUndefined()
    expect((await callTool(run.sessionId!, 'resolve_action_item', { id: manual.id })).text).toContain("user's own")
    expect((await callTool(run.sessionId!, 'resolve_action_item', { id: 'no-such-id' })).isError).toBe(true)
    await completeTurn(['Auth is settled, Clerk it is.'])
    await waitFor(() => {
      const s = sessionManager.getSession(run.sessionId!)
      if (!s?.messages.some((m) => m.metadata?.personaId === lead.id)) throw new Error('not routed yet')
    })

    const prompt = sessionManager.getSession(run.sessionId!)!.messages.find((m) => m.role === 'user')
    expect(prompt?.content).toContain(`[${pending.id}] (decision) Pick an auth provider`)
    expect(prompt?.content).toContain("The user's answer: Postgres")

    const items = await storage.listActionItems(project.id)
    expect(items).toHaveLength(3)
    expect(items.find((a) => a.id === pending.id)?.status).toBe('done')
    expect(items.find((a) => a.id === manual.id)?.status).toBe('open')
    // Closed by the team → no agenda echo back to the team.
    expect((await storage.getStandupState(project.id))?.agenda ?? []).toHaveLength(0)
  })

  it('records options/blocking, caps the queue, and closes ideas that already shipped', async () => {
    const lead = await storage.addPersona({
      name: 'Maya', role: 'Lead', personality: '', provider: 'kiro', isLead: true,
    })
    // An idea that was built by hand — the lead will find it in git.
    const shipped = await storage.addTodo({ projectId: project.id, text: 'Global error toasts' })
    await storage.updateTodo(shipped.id, { status: 'proposed' })
    const prereq = await storage.addActionItem({
      projectId: project.id, text: 'Pick toast position', kind: 'decision', todoId: shipped.id, personaId: lead.id,
    })
    // Three more already waiting → one slot left under the cap of 4.
    for (const text of ['Q1', 'Q2', 'Q3']) {
      await storage.addActionItem({ projectId: project.id, text, kind: 'decision', personaId: lead.id })
    }

    const run = await standup.runStandup(project.id, { force: true })
    await waitForSpawn()
    const prompt = sessionManager.getSession(run.sessionId!)!.messages.find((m) => m.role === 'user')
    expect(prompt?.content).toContain(`[${shipped.id}] (proposed) Global error toasts`)

    // The shipped idea moves to Done and its prerequisite closes with it —
    // freeing the slot the next item takes.
    expect((await callTool(run.sessionId!, 'complete_idea', { idea_id: shipped.id, evidence: 'fc8e0a7' })).text).toContain('1 prerequisite')
    await callTool(run.sessionId!, 'add_action_item', {
      persona: 'Maya', text: 'Which region?', kind: 'decision', blocking: false,
      options: [{ label: 'US', detail: 'Lowest latency', recommended: true }, { label: 'EU' }],
    })
    const overCap = await callTool(run.sessionId!, 'add_action_item', { persona: 'Maya', text: 'One too many', kind: 'decision' })
    expect(overCap.isError).toBe(true)
    expect(overCap.text).toContain('already waiting')
    await completeTurn(['Toasts already shipped.'])

    expect((await storage.listTodos(project.id)).find((x) => x.id === shipped.id)?.status).toBe('done')
    const items = await storage.listActionItems(project.id)
    expect(items.find((a) => a.id === prereq.id)?.status).toBe('done')
    const region = items.find((a) => a.text === 'Which region?')!
    expect(region.blocking).toBe(false)
    expect(region.options).toEqual([
      { label: 'US', detail: 'Lowest latency', recommended: true },
      { label: 'EU' },
    ])
    expect(items.some((a) => a.text === 'One too many')).toBe(false)
    const system = sessionManager.getSession(run.sessionId!)!.messages.filter((m) => m.role === 'system')
    expect(system.some((m) => m.content.includes('already implemented (fc8e0a7)'))).toBe(true)
  })

  it('a chat agent closing a team item tells the next standup; closing the user\'s own does not', async () => {
    const lead = await storage.addPersona({
      name: 'Maya', role: 'Lead', personality: '', provider: 'kiro', isLead: true,
    })
    const teamItem = await storage.addActionItem({ projectId: project.id, text: 'Add the API key', personaId: lead.id })
    const mine = await storage.addActionItem({ projectId: project.id, text: 'Call the bank' })
    const chat = await sessionManager.createSession('kiro', project.id)

    await callTool(chat.id, 'resolve_action_item', { id: teamItem.id, resolution: 'Added it to .env' })
    await callTool(chat.id, 'resolve_action_item', { id: mine.id })
    const agenda = (await storage.getStandupState(project.id))?.agenda ?? []
    expect(agenda).toHaveLength(1)
    expect(agenda[0]).toContain('Add the API key')
    expect(agenda[0]).toContain('Added it to .env')
  })

  it('relays declines and option answers to the next standup', async () => {
    const lead = await storage.addPersona({
      name: 'Maya', role: 'Lead', personality: '', provider: 'kiro', isLead: true,
    })
    const declined = await storage.addActionItem({ projectId: project.id, text: 'Buy a domain', personaId: lead.id })
    await standup.notifyActionResolved(
      await storage.updateActionItem(declined.id, { status: 'dismissed', resolution: 'Using a subdomain' }),
    )
    const picked = await storage.addActionItem({
      projectId: project.id, text: 'Which region?', kind: 'decision', personaId: lead.id,
      options: [{ label: 'US', recommended: true }, { label: 'EU' }],
    })
    await standup.notifyActionResolved(
      await storage.updateActionItem(picked.id, { status: 'done', resolution: 'EU' }),
    )

    const agenda = (await storage.getStandupState(project.id))!.agenda!
    expect(agenda[0]).toContain('declined "Buy a domain"')
    expect(agenda[0]).toContain('Using a subdomain')
    expect(agenda[1]).toContain('answered "Which region?": EU')
    expect(agenda[1]).toContain('US (your recommendation); EU')
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
