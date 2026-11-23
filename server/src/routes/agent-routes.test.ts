import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'fs/promises'
import { randomUUID } from 'crypto'
import path from 'path'
import os from 'os'
import express from 'express'
import request from 'supertest'

import { StorageLayer } from '../storage.js'
import { createAgentRoutes } from './agent.js'
import { createActionRoutes } from './actions.js'
import { AgentToolService } from '../agent-tool-registry.js'
import { recordActionItem } from '../action-items.js'
import { MAX_OPEN_ACTIONS } from '../standup-protocol.js'
import type { SessionManager } from '../session-manager.js'
import { ChatActionCardSchema, type ActionItem, type ChatMessage, type Project, type Session, type SessionKind } from '../schemas.js'

let tmpDir: string
let storage: StorageLayer
let app: express.Express
let project: Project
let session: Session
let teamClosed: ActionItem[]

/** The slice of SessionManager the agent routes and tools use, over one in-memory chat. */
function sessionManagerStub(): SessionManager {
  const append = (role: ChatMessage['role'], content: string, metadata?: ChatMessage['metadata']) => {
    const msg: ChatMessage = { id: randomUUID(), role, content, timestamp: Date.now(), status: 'complete', ...(metadata ? { metadata } : {}) }
    session.messages.push(msg)
    return msg
  }
  return {
    getSession: (id: string) => (id === session.id ? session : undefined),
    appendCard: (_id: string, content: string, metadata: ChatMessage['metadata']) => append('system', content, metadata),
    appendSystemMessage: (_id: string, content: string) => void append('system', content),
    amendMessage: (_id: string, messageId: string, patch: { metadata?: ChatMessage['metadata'] }) => {
      const msg = session.messages.find((m) => m.id === messageId)!
      msg.metadata = { ...msg.metadata, ...patch.metadata }
    },
  } as unknown as SessionManager
}

function useSession(kind: SessionKind) {
  const now = Date.now()
  session = {
    id: randomUUID(), provider: 'claude', projectId: project.id, title: 'chat',
    createdAt: now, updatedAt: now, status: 'live', messages: [], kind,
  } as Session
}

const cards = (kind = 'action') => session.messages.filter((m) => m.metadata?.kind === kind)

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), 'codepipe-agent-'))
  storage = new StorageLayer(tmpDir)
  await storage.ensureDataDir()
  project = await storage.addProject({ name: 'demo', path: tmpDir })
  useSession('chat')
  teamClosed = []

  const sessionManager = sessionManagerStub()
  const tools = new AgentToolService({
    storage,
    sessionManager,
    onTeamActionClosed: async (item) => void teamClosed.push(item),
  })
  app = express()
  app.use(express.json())
  app.use('/api/agent', createAgentRoutes(storage, sessionManager, tools))
  app.use('/api/actions', createActionRoutes(storage))
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

/** Call a tool the way the MCP server does; returns the result text + error flag. */
async function tool(name: string, args: object) {
  const res = await request(app).post(`/api/agent/sessions/${session.id}/tools/${name}`).send({ arguments: args })
  expect(res.status).toBe(200)
  return { text: res.body.content[0].text as string, isError: res.body.isError === true }
}
const cardOp = (messageId: string, op: string) =>
  request(app).post(`/api/agent/sessions/${session.id}/messages/${messageId}/card`).send({ op })

describe('the lead and action items', () => {
  /** The lead's thread lives in this test's project (its Workspace); `other` is a product. */
  async function leadWorld() {
    useSession('lead')
    const rimuru = await storage.addPersona({ name: 'Rimuru', role: 'Chancellor', personality: '', provider: 'claude', isLead: true })
    const other = await storage.addProject({ name: 'Lunanul', path: tmpDir })
    return { rimuru, other }
  }

  it('files a suggestion for another project there when accepted, credited to the lead; undo finds it', async () => {
    const { rimuru, other } = await leadWorld()
    await tool('add_action_item', { text: 'Ship onboarding', user_requested: false, project: 'Lunanul' })
    const card = cards()[0]
    expect(card.metadata?.action).toMatchObject({ state: 'suggested', projectId: other.id, personaId: rimuru.id })

    expect((await cardOp(card.id, 'accept')).status).toBe(200)
    const [item] = await storage.listActionItems(other.id)
    expect(item).toMatchObject({ text: 'Ship onboarding', personaId: rimuru.id })
    expect(await storage.listActionItems(project.id)).toHaveLength(0)

    expect((await cardOp(card.id, 'undo')).status).toBe(200)
    expect(await storage.listActionItems(other.id)).toHaveLength(0)
  })

  it('stops suggesting once the project\'s team queue is full, but what you accept is always added', async () => {
    const { rimuru, other } = await leadWorld()
    await tool('add_action_item', { text: 'Accepted later', user_requested: false, project: 'Lunanul' })
    for (let i = 0; i < MAX_OPEN_ACTIONS; i++) {
      await recordActionItem(storage, other.id, { text: `team item ${i}`, personaId: rimuru.id })
    }
    const refused = await tool('add_action_item', { text: 'One more', user_requested: false, project: 'Lunanul' })
    expect(refused.isError).toBe(true)
    expect(cards()).toHaveLength(1)

    expect((await cardOp(cards()[0].id, 'accept')).status).toBe(200)
    expect(await storage.listActionItems(other.id)).toHaveLength(MAX_OPEN_ACTIONS + 1)
    // What you ask for yourself is yours, not the team's, and never capped.
    expect((await tool('add_action_item', { text: 'My own', user_requested: true, project: 'Lunanul' })).isError).toBe(false)
  })

  it('does not re-suggest what you just settled, and "Add anyway" after dismissing still bypasses a full queue', async () => {
    const { rimuru, other } = await leadWorld()
    const declined = await storage.addActionItem({ projectId: other.id, text: 'Hire a designer' })
    await storage.updateActionItem(declined.id, { status: 'dismissed' })
    expect((await tool('add_action_item', { text: 'Hire a designer', user_requested: false, project: 'Lunanul' })).text).toContain('settled recently')
    expect(cards()).toHaveLength(0)

    await tool('add_action_item', { text: 'Write the FAQ', user_requested: false, project: 'Lunanul' })
    const card = cards()[0]
    expect((await cardOp(card.id, 'dismiss')).status).toBe(200)
    for (let i = 0; i < MAX_OPEN_ACTIONS; i++) {
      await recordActionItem(storage, other.id, { text: `team item ${i}`, personaId: rimuru.id })
    }
    expect((await cardOp(card.id, 'accept')).status).toBe(200)
    expect((await storage.listActionItems(other.id)).find((i) => i.text === 'Write the FAQ')).toMatchObject({ personaId: rimuru.id })

    // Accepting what is already open again reports it rather than claiming an add.
    expect((await cardOp(card.id, 'undo')).status).toBe(200)
    await storage.addActionItem({ projectId: other.id, text: 'Write the FAQ' })
    const dup = await cardOp(card.id, 'accept')
    expect(dup.status).toBe(409)
    expect(dup.body.error).toContain('Already on your list')
  })

  it('logs progress with the chat it happened in, and the card undoes the whole update', async () => {
    const { other } = await leadWorld()
    const chat = { id: randomUUID(), provider: 'claude', projectId: other.id, title: 'Q1 launch copy', createdAt: Date.now(), updatedAt: Date.now(), status: 'live', messages: [] } as Session
    await storage.saveSession(chat)
    const item = await storage.addActionItem({ projectId: other.id, text: 'Review the marketing doc', dueDate: '2026-12-01' })
    const first = { id: randomUUID(), at: 1, text: 'Draft shared' }
    await storage.updateActionItem(item.id, { progress: [first] })

    const res = await tool('update_action_item', {
      id: item.id.slice(0, 8), progress: 'Doc v2 updated; you reviewed sections 1–3.', chat: 'Q1 launch', text: 'Review sections 4–6', due_date: '2026-12-05',
    })
    expect(res.isError).toBe(false)
    const [logged] = await storage.listActionItems(other.id)
    expect(logged.text).toBe('Review sections 4–6')
    expect(logged.progress?.map((p) => p.text)).toEqual(['Draft shared', 'Doc v2 updated; you reviewed sections 1–3.'])
    expect(logged.progress?.at(-1)?.sessionId).toBe(chat.id)
    expect((await tool('list_action_items', {})).text).toContain('Last progress')
    expect((await tool('update_action_item', { id: item.id.slice(0, 8), progress: 'x', chat: 'nope' })).isError).toBe(true)

    const card = cards().at(-1)!
    expect((await cardOp(card.id, 'undo')).status).toBe(200)
    expect(card.metadata?.action?.state).toBe('reverted')
    const [back] = await storage.listActionItems(other.id)
    expect(back).toMatchObject({ text: 'Review the marketing doc', dueDate: '2026-12-01', progress: [first] })
    expect((await cardOp(card.id, 'undo')).status).toBe(409)
  })

  it('undo keeps a later edit, refuses when nothing is left, and 409s on a deleted item', async () => {
    const { other } = await leadWorld()
    const item = await storage.addActionItem({ projectId: other.id, text: 'A', dueDate: '2026-12-01' })
    const id = item.id.slice(0, 8)
    await tool('update_action_item', { id, text: 'B', due_date: '2026-12-02' })
    const card = cards().at(-1)!
    await tool('update_action_item', { id, text: 'C' }) // a later edit of the same field

    expect((await cardOp(card.id, 'undo')).status).toBe(200)
    expect((await storage.listActionItems(other.id))[0]).toMatchObject({ text: 'C', dueDate: '2026-12-01' })

    await tool('update_action_item', { id, text: 'D' })
    const second = cards().at(-1)!
    await storage.updateActionItem(item.id, { text: 'E' })
    expect((await cardOp(second.id, 'undo')).body.error).toContain('changed since')

    await tool('update_action_item', { id, due_date: '2026-12-09' })
    const third = cards().at(-1)!
    await storage.removeActionItem(item.id)
    expect((await cardOp(third.id, 'undo')).body.error).toContain('no longer exists')
  })

  it('clips a long change summary so the thread stays loadable', async () => {
    const { other } = await leadWorld()
    const item = await storage.addActionItem({ projectId: other.id, text: 'x'.repeat(1500) })
    await tool('update_action_item', { id: item.id.slice(0, 8), text: 'y'.repeat(1500), progress: 'p'.repeat(500) })
    expect(ChatActionCardSchema.safeParse(cards().at(-1)!.metadata?.action).success).toBe(true)
  })

  it('during the brief, logs progress and re-dates — but blocking, snooze and notes wait for the user', async () => {
    const { other } = await leadWorld()
    const item = await storage.addActionItem({ projectId: other.id, text: 'Sign the contract' })
    session.messages.push({ id: randomUUID(), role: 'user', content: 'Write the brief', timestamp: Date.now(), status: 'complete', metadata: { kind: 'prompt' } })
    const id = item.id.slice(0, 8)
    expect((await tool('update_action_item', { id, blocking: false })).isError).toBe(true)
    expect((await tool('update_action_item', { id, snooze_until: '2099-01-01' })).isError).toBe(true)
    expect((await tool('update_action_item', { id, notes: 'x' })).isError).toBe(true)
    expect((await tool('resolve_action_item', { id })).isError).toBe(true)
    expect((await storage.listActionItems(other.id))[0].status).toBe('open')
    expect((await tool('update_action_item', { id, progress: 'Lawyer sent comments', due_date: '2026-12-10' })).isError).toBe(false)
  })

  it('update_action_item rewords, dates, marks non-blocking and snoozes — the lead only', async () => {
    const { other } = await leadWorld()
    const item = await storage.addActionItem({ projectId: other.id, text: 'Pick a launch date', dueDate: '2026-12-01' })
    const id = item.id.slice(0, 8)

    const res = await tool('update_action_item', { id, text: 'Pick the launch date', due_date: null, blocking: false, snooze_until: '2099-01-05' })
    expect(res.isError).toBe(false)
    const [updated] = await storage.listActionItems(other.id)
    expect(updated).toMatchObject({ text: 'Pick the launch date', blocking: false, snoozedUntil: new Date('2099-01-05T00:00:00').getTime() })
    expect(updated.dueDate).toBeUndefined()
    expect(cards().at(-1)?.metadata?.action).toMatchObject({ state: 'updated', itemId: item.id, projectId: other.id })

    await tool('update_action_item', { id, blocking: true, snooze_until: null, due_date: '2027-01-10' })
    const [back] = await storage.listActionItems(other.id)
    expect(back).toMatchObject({ dueDate: '2027-01-10' })
    expect(back.blocking).toBeUndefined()
    expect(back.snoozedUntil).toBeUndefined()

    expect((await tool('update_action_item', { id, snooze_until: '2020-01-01' })).isError).toBe(true)
    expect((await tool('update_action_item', { id })).isError).toBe(true)
    // Values it already has change nothing.
    expect((await tool('update_action_item', { id, blocking: true, due_date: '2027-01-10', snooze_until: null })).text).toContain('Nothing to change')
    await storage.updateActionItem(item.id, { status: 'done' })
    expect((await tool('update_action_item', { id, blocking: false })).isError).toBe(true)
    expect((await tool('update_action_item', { id: 'zzzz', blocking: false })).isError).toBe(true)

    useSession('chat')
    expect((await tool('update_action_item', { id, blocking: false })).isError).toBe(true)
  })
})

describe('tool listing', () => {
  it('gives chats the shared tools and standups the team protocol on top', async () => {
    const names = async () =>
      (await request(app).get(`/api/agent/sessions/${session.id}/tools`)).body.tools.map((t: { name: string }) => t.name)
    expect(await names()).toEqual(['add_action_item', 'list_action_items', 'resolve_action_item', 'add_idea'])

    useSession('team')
    expect(await names()).toEqual([
      'add_action_item', 'list_action_items', 'resolve_action_item', 'add_idea',
      'propose_plan', 'complete_idea', 'save_memo',
    ])

    useSession('review')
    expect(await names()).toEqual([])
  })

  it('404s for a chat that is not open, and reports unknown tools as errors', async () => {
    expect((await request(app).get(`/api/agent/sessions/${randomUUID()}/tools`)).status).toBe(404)
    expect((await tool('save_memo', { memo: 'x' })).isError).toBe(true) // team-only, this is a chat
    expect((await tool('no_such_tool', {})).isError).toBe(true)
  })
})

describe('add_action_item', () => {
  it('adds a user-requested item right away, with an "added" card in the chat', async () => {
    const res = await tool('add_action_item', { text: 'Renew the TLS cert', user_requested: true, due_date: '2026-11-01', kind: 'task', steps: ['Open the console'] })
    expect(res.text).toContain('Renew the TLS cert')

    const [item] = await storage.listActionItems(project.id)
    expect(item).toMatchObject({ text: 'Renew the TLS cert', dueDate: '2026-11-01', kind: 'task', steps: ['Open the console'], status: 'open' })
    expect(item.personaId).toBeUndefined()
    expect(cards()[0].metadata?.action).toMatchObject({ state: 'added', itemId: item.id })
  })

  it('only suggests an item the agent volunteered — nothing is recorded until accepted', async () => {
    await tool('add_action_item', { text: 'Pick a pricing tier', user_requested: false, kind: 'decision', options: [{ label: 'Free' }, { label: 'Pro', recommended: true }] })
    expect(await storage.listActionItems(project.id)).toHaveLength(0)

    const card = cards()[0]
    expect(card.metadata?.action?.state).toBe('suggested')
    expect((await cardOp(card.id, 'accept')).status).toBe(200)
    const [item] = await storage.listActionItems(project.id)
    expect(item).toMatchObject({ text: 'Pick a pricing tier', kind: 'decision' })
    expect(card.metadata?.action).toMatchObject({ state: 'added', itemId: item.id })
  })

  it('does not add or suggest what is already open', async () => {
    await recordActionItem(storage, project.id, { text: 'Rotate the Stripe key' })
    expect((await tool('add_action_item', { text: '  rotate the STRIPE key ', user_requested: true })).text).toContain('Already')
    expect((await tool('add_action_item', { text: 'Rotate the Stripe key', user_requested: false })).text).toContain('Already')
    expect(await storage.listActionItems(project.id)).toHaveLength(1)
    expect(cards()).toHaveLength(0)
  })

  it('returns validation errors the agent can read and fix', async () => {
    const bad = await tool('add_action_item', { text: 'x', user_requested: true, due_date: 'next friday' })
    expect(bad.isError).toBe(true)
    expect(bad.text).toContain('due_date')
    expect((await tool('add_action_item', { text: '', user_requested: true })).isError).toBe(true)
    expect((await tool('add_action_item', { text: 'x' })).text).toContain('user_requested')
  })

  it('in a standup, credits the persona, links the idea, and enforces the cap', async () => {
    useSession('team')
    const maya = await storage.addPersona({ name: 'Maya', role: 'Lead', personality: '', provider: 'kiro', isLead: true })
    const aria = await storage.addPersona({ name: 'Aria', role: 'Dev', personality: '', provider: 'kiro', isLead: false })
    const idea = await storage.addTodo({ projectId: project.id, text: 'Checkout' })

    await tool('add_action_item', { text: 'Add the Stripe key', persona: 'aria', todo_id: idea.id.slice(0, 6) })
    await tool('add_action_item', { text: 'Pick a region' })
    const items = await storage.listActionItems(project.id)
    expect(items.find((a) => a.text === 'Add the Stripe key')).toMatchObject({ personaId: aria.id, todoId: idea.id })
    expect(items.find((a) => a.text === 'Pick a region')?.personaId).toBe(maya.id)
    expect((await tool('add_action_item', { text: 'x', todo_id: 'nope' })).isError).toBe(true)

    for (let i = items.length; i < MAX_OPEN_ACTIONS; i++) await tool('add_action_item', { text: `Q${i}` })
    const over = await tool('add_action_item', { text: 'One too many' })
    expect(over.isError).toBe(true)
    expect(over.text).toContain('already waiting')
  })
})

describe('list_action_items / resolve_action_item', () => {
  it('lists open items with ids, and closed ones on request', async () => {
    expect((await tool('list_action_items', {})).text).toContain('Nothing is waiting')
    const open = await recordActionItem(storage, project.id, { text: 'Pick a DB', kind: 'decision', options: [{ label: 'Postgres', recommended: true }], dueDate: '2099-01-01' })
    const closed = await recordActionItem(storage, project.id, { text: 'Buy a domain' })
    if (open.status !== 'added' || closed.status !== 'added') throw new Error('setup')
    await storage.updateActionItem(closed.item.id, { status: 'dismissed', resolution: 'Using a subdomain' })

    const list = (await tool('list_action_items', {})).text
    expect(list).toContain(`[${open.item.id.slice(0, 8)}] (decision, due 2099-01-01, the user's own) Pick a DB`)
    expect(list).toContain('Postgres (recommended)')
    expect(list).not.toContain('Buy a domain')
    expect((await tool('list_action_items', { include_closed: true })).text).toContain('declined: Buy a domain — reason: Using a subdomain')
  })

  it('closes an item with the answer, posts an undo-able card, and tells the team about its items', async () => {
    const lead = await storage.addPersona({ name: 'Maya', role: 'Lead', personality: '', provider: 'kiro', isLead: true })
    const team = await recordActionItem(storage, project.id, { text: 'Add the API key', personaId: lead.id })
    if (team.status !== 'added') throw new Error('setup')

    const res = await tool('resolve_action_item', { id: team.item.id.slice(0, 6), resolution: 'Added to .env' })
    expect(res.isError).toBe(false)
    const [item] = await storage.listActionItems(project.id)
    expect(item).toMatchObject({ status: 'done', resolution: 'Added to .env' })
    expect(teamClosed.map((i) => i.id)).toEqual([item.id])

    // Undo reopens it and clears the answer.
    const card = cards()[0]
    expect(card.metadata?.action).toMatchObject({ state: 'closed', itemId: item.id, resolution: 'Added to .env' })
    expect((await cardOp(card.id, 'undo')).status).toBe(200)
    const [reopened] = await storage.listActionItems(project.id)
    expect(reopened.status).toBe('open')
    expect(reopened.resolution).toBeUndefined()
    expect(card.metadata?.action?.state).toBe('reopened')

    expect((await tool('resolve_action_item', { id: 'zzzz' })).isError).toBe(true)
    await tool('resolve_action_item', { id: item.id, declined: true })
    expect((await storage.listActionItems(project.id))[0].status).toBe('dismissed')
  })
})

describe('add_idea', () => {
  it('puts an idea on the board with an undo-able card, and never twice', async () => {
    const res = await tool('add_idea', { text: 'Dark mode for the terminal', notes: 'xterm theme' })
    expect(res.text).toContain('Ideas board')
    const [idea] = await storage.listTodos(project.id)
    expect(idea).toMatchObject({ text: 'Dark mode for the terminal', notes: 'xterm theme', status: 'inbox' })
    expect((await tool('add_idea', { text: 'dark mode for the  terminal' })).text).toContain('Already on the board')

    const card = cards('idea')[0]
    expect(card.metadata?.idea).toMatchObject({ state: 'added', todoId: idea.id })
    expect((await cardOp(card.id, 'undo')).status).toBe(200)
    expect(await storage.listTodos(project.id)).toHaveLength(0)
    expect(card.metadata?.idea?.state).toBe('undone')

    expect((await cardOp(card.id, 'accept')).status).toBe(200)
    expect(await storage.listTodos(project.id)).toHaveLength(1)
  })

  it('will not undo an idea the team already picked up', async () => {
    await tool('add_idea', { text: 'Retry backoff' })
    const card = cards('idea')[0]
    await storage.updateTodo(card.metadata!.idea!.todoId!, { status: 'under_review' })
    expect((await cardOp(card.id, 'undo')).status).toBe(409)
  })
})

describe('action cards', () => {
  it('undo removes the added item; accepting again re-adds it', async () => {
    await tool('add_action_item', { text: 'Buy the domain', user_requested: true })
    const card = cards()[0]

    expect((await cardOp(card.id, 'undo')).status).toBe(200)
    expect(await storage.listActionItems(project.id)).toHaveLength(0)
    expect(card.metadata?.action).toEqual({ draft: { text: 'Buy the domain' }, state: 'undone' })
    expect((await cardOp(card.id, 'undo')).status).toBe(409)

    await cardOp(card.id, 'accept')
    expect(await storage.listActionItems(project.id)).toHaveLength(1)
  })

  it('will not undo an item the user already closed', async () => {
    await tool('add_action_item', { text: 'Buy the domain', user_requested: true })
    const card = cards()[0]
    await storage.updateActionItem(card.metadata!.action!.itemId!, { status: 'done' })
    expect((await cardOp(card.id, 'undo')).status).toBe(409)
    expect(await storage.listActionItems(project.id)).toHaveLength(1)
  })

  it('dismisses a suggestion without recording anything', async () => {
    await tool('add_action_item', { text: 'Set up Sentry', user_requested: false })
    const card = cards()[0]
    expect((await cardOp(card.id, 'dismiss')).status).toBe(200)
    expect(card.metadata?.action?.state).toBe('dismissed')
    expect(await storage.listActionItems(project.id)).toHaveLength(0)
    expect((await cardOp(card.id, 'bogus')).status).toBe(400)
    expect((await cardOp(randomUUID(), 'accept')).status).toBe(404)
  })
})

describe('team protocol tools', () => {
  beforeEach(async () => {
    useSession('team')
    await storage.addPersona({ name: 'Maya', role: 'Lead', personality: '', provider: 'kiro', isLead: true })
  })

  it('propose_plan saves the proposal and validates the idea id', async () => {
    const idea = await storage.addTodo({ projectId: project.id, text: 'Backoff' })
    const plan = { idea_id: idea.id.slice(0, 8), summary: 'S', approach: 'A', brief: 'B', effort: '2h' }
    expect((await tool('propose_plan', plan)).isError).toBe(false)
    expect((await storage.listTodos(project.id))[0]).toMatchObject({ status: 'proposed', proposal: { summary: 'S', brief: 'B', effort: '2h' } })
    expect((await tool('propose_plan', { ...plan, idea_id: 'nope' })).isError).toBe(true)
    expect((await tool('propose_plan', { idea_id: idea.id, summary: 'S' })).text).toContain('approach')
  })

  it('save_memo stores the memo with a timestamp', async () => {
    await tool('save_memo', { memo: 'Decided on Postgres.' })
    const state = await storage.getStandupState(project.id)
    expect(state?.memo).toBe('Decided on Postgres.')
    expect(state?.memoSavedAt).toBeGreaterThan(0)
  })
})

describe('recordActionItem', () => {
  it('dedups team items against recently closed ones, but lets the user re-add theirs', async () => {
    const personaId = randomUUID()
    const first = await recordActionItem(storage, project.id, { text: 'Add the API key', personaId })
    if (first.status !== 'added') throw new Error('setup')
    await storage.updateActionItem(first.item.id, { status: 'dismissed' })

    expect((await recordActionItem(storage, project.id, { text: 'Add the API key', personaId })).status).toBe('duplicate')
    expect((await recordActionItem(storage, project.id, { text: 'Add the API key' })).status).toBe('added')
  })

  it('caps only team-raised items', async () => {
    const personaId = randomUUID()
    for (let i = 0; i < MAX_OPEN_ACTIONS; i++) {
      expect((await recordActionItem(storage, project.id, { text: `team ${i}`, personaId })).status).toBe('added')
    }
    expect((await recordActionItem(storage, project.id, { text: 'one more', personaId })).status).toBe('over_cap')
    expect((await recordActionItem(storage, project.id, { text: 'mine' })).status).toBe('added')
  })

  it('the manual form returns the open duplicate instead of adding another', async () => {
    const first = await request(app).post('/api/actions').send({ projectId: project.id, text: 'Call the bank' })
    expect(first.status).toBe(201)
    const again = await request(app).post('/api/actions').send({ projectId: project.id, text: 'call the bank' })
    expect(again.status).toBe(200)
    expect(again.body.id).toBe(first.body.id)
  })
})
