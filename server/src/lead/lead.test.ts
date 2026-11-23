/**
 * The lead's home and tools: the Workspace project, the lead's read-only
 * thread, its tools over your chats / items / Focus, the lead routes, and
 * prompts it drafts into project chats.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, rm } from 'fs/promises'
import { randomUUID } from 'crypto'
import os from 'os'
import path from 'path'
import express from 'express'
import request from 'supertest'

import { StorageLayer } from '../storage.js'
import { SessionManager } from '../session-manager.js'
import { AgentToolService, matchProject } from '../agent-tool-registry.js'
import { registerAdapter, clearAdapters } from '../adapters/registry.js'
import type { ICLIAdapter } from '../adapters/types.js'
import type { ChatMessage, Session } from '../schemas.js'
import { LeadService } from './lead-service.js'
import { createLeadRoutes } from '../routes/lead.js'
import { createProjectRoutes } from '../routes/projects.js'
import type { DevServerManager } from '../dev-server-manager.js'
import type { ServiceManager } from '../service-manager.js'

const T = Date.UTC(2026, 10, 20)
/** A CLI that answers every message with "ok". */
const cli = (provider: 'kiro' | 'claude'): ICLIAdapter => ({
  provider,
  command: process.execPath,
  args: [],
  transport: 'oneshot',
  onData: (line) => (line.trim() ? [{ type: 'chunk', role: 'assistant', content: line.trim() }] : []),
  buildMessageCommand: () => ({ command: process.execPath, args: ['-e', 'console.log("ok")'] }),
})

let dir: string
let storage: StorageLayer
let manager: SessionManager
let lead: LeadService
let tools: AgentToolService

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'codepipe-lead-'))
  storage = new StorageLayer(path.join(dir, 'data'))
  await storage.ensureDataDir()
  manager = new SessionManager(storage)
  lead = new LeadService(storage, manager, path.join(dir, 'data'))
  tools = new AgentToolService({ storage, sessionManager: manager })
  registerAdapter('kiro', () => cli('kiro'))
  registerAdapter('claude', () => cli('claude'))
})

afterEach(async () => {
  await manager.shutdown()
  clearAdapters()
  await storage.whenIdle()
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
})

const msg = (role: ChatMessage['role'], content: string, at: number): ChatMessage =>
  ({ id: randomUUID(), role, content, timestamp: at, status: 'complete' })

async function addPersona(provider: 'kiro' | 'claude' | 'codex' = 'kiro', isLead = true) {
  return storage.addPersona({ name: 'Rimuru', role: 'Chancellor', personality: '', provider, isLead })
}

async function addChat(projectId: string, title: string, messages: ChatMessage[]): Promise<Session> {
  const s: Session = { id: randomUUID(), provider: 'claude', projectId, title, createdAt: T, updatedAt: messages.at(-1)?.timestamp ?? T, status: 'live', messages }
  await storage.saveSession(s)
  return s
}

describe('LeadService', () => {
  it('creates the Workspace project once, even when asked concurrently, and hides it as internal', async () => {
    const [a, b] = await Promise.all([lead.workspaceProject(), lead.workspaceProject()])
    expect(a.id).toBe(b.id)
    expect(a).toMatchObject({ name: 'Workspace', internal: true })
    expect((await storage.listProjects()).filter((p) => p.internal)).toHaveLength(1)
    // A fresh service (restart) finds it instead of making another.
    expect((await new LeadService(storage, manager, path.join(dir, 'data')).workspaceProject()).id).toBe(a.id)
  })

  it('has no thread without a team', async () => {
    expect(await lead.ensureLeadSession()).toBeNull()
    expect((await lead.status()).leadPersonaId).toBeNull()
  })

  it('creates one read-only lead thread and reuses it', async () => {
    const persona = await addPersona('kiro')
    const first = await lead.ensureLeadSession()
    expect(first).toMatchObject({ kind: 'lead', personaId: persona.id, provider: 'kiro' })
    expect((await lead.ensureLeadSession())!.id).toBe(first!.id)
    expect((await lead.status()).sessionId).toBe(first!.id)
    // Its launch settings are pinned read-only.
    expect(await manager.resolveLaunchSettings(first!)).toMatchObject({ trustAllTools: false, trustTools: ['fs_read', 'glob', 'grep', '@codepipe'] })
  })

  it('starts a fresh thread when the lead changes provider, and revives after a restart', async () => {
    const persona = await addPersona('kiro')
    const kiroThread = await lead.ensureLeadSession()
    await storage.updatePersona(persona.id, { provider: 'claude' })
    const claudeThread = await lead.ensureLeadSession()
    expect(claudeThread!.id).not.toBe(kiroThread!.id)
    expect(claudeThread!.provider).toBe('claude')

    // Restart: a new manager has nothing in memory; the stored thread revives.
    await manager.shutdown()
    manager = new SessionManager(storage)
    const revived = await new LeadService(storage, manager, path.join(dir, 'data')).ensureLeadSession()
    expect(revived!.id).toBe(claudeThread!.id)
    expect(manager.getSession(revived!.id)?.status).toBe('live')
  })

  it('pins reviewer sessions read-only too, but not your chats', async () => {
    const project = await storage.addProject({ name: 'p', path: dir })
    const review = await manager.createSession('claude', project.id, { kind: 'review', title: 'r' })
    const chat = await manager.createSession('claude', project.id)
    expect(await manager.resolveLaunchSettings(review)).toMatchObject({ permissionMode: 'dontAsk' })
    expect(await manager.resolveLaunchSettings(chat)).toMatchObject({ permissionMode: 'auto' })
  })

  it('refuses a provider that cannot run read-only', async () => {
    await addPersona('codex')
    await expect(lead.ensureLeadSession()).rejects.toThrow(/read-only/)
  })
})

describe('lead tools', () => {
  async function setup() {
    await addPersona('kiro')
    const leadSession = (await lead.ensureLeadSession())!
    const partners = await storage.addProject({ name: 'Partners App', path: dir })
    const dirumed = await storage.addProject({ name: 'Dirumed App', path: dir })
    const chat = await addChat(partners.id, 'Partners MVP', [
      msg('user', 'Review partners and ship it', T),
      msg('assistant', 'Reviewed.', T + 1),
      msg('user', 'Phase 7 please', T + 2),
      msg('assistant', 'Built phase 7. Do you want me to deploy it?', T + 3),
    ])
    return { leadSession, partners, dirumed, chat }
  }
  const call = (session: Session, name: string, args: Record<string, unknown> = {}) => tools.call(session, name, args)

  it('are listed for the lead only', async () => {
    const { leadSession, partners } = await setup()
    const names = tools.listTools(leadSession).map((t) => t.name)
    expect(names).toEqual(expect.arrayContaining(['list_open_chats', 'read_chat', 'search_chat', 'update_focus', 'open_project_chat', 'save_memo', 'add_action_item']))
    const chat = await manager.createSession('kiro', partners.id)
    expect(tools.listTools(chat).map((t) => t.name)).not.toContain('read_chat')
  })

  it('list and read your chats by id prefix or title', async () => {
    const { leadSession, chat } = await setup()
    expect((await call(leadSession, 'list_open_chats')).text).toContain(`[${chat.id.slice(0, 8)}] "Partners MVP" (Partners App`)
    const end = await call(leadSession, 'read_chat', { chat: 'partners mvp', turns: 1 })
    expect(end.text).toContain('turns 2–2 of 2')
    expect(end.text).toContain('Do you want me to deploy it?')
    const start = await call(leadSession, 'read_chat', { chat: chat.id.slice(0, 8), from: 'start', turns: 1 })
    expect(start.text).toContain('You: Review partners and ship it')
    expect((await call(leadSession, 'read_chat', { chat: 'nope' })).isError).toBe(true)
  })

  it('list only your chats — not the lead\'s thread or reviewer sessions', async () => {
    const { leadSession, partners } = await setup()
    await manager.createSession('kiro', partners.id, { kind: 'review', title: 'Souei review' })
    const list = (await call(leadSession, 'list_open_chats')).text
    expect(list).toContain('Partners MVP')
    expect(list).not.toContain('Souei review')
    expect(list).not.toContain(leadSession.title)
  })

  it('search a chat', async () => {
    const { leadSession } = await setup()
    expect((await call(leadSession, 'search_chat', { chat: 'Partners MVP', query: 'phase 7' })).text).toContain('1 matching turn')
    expect((await call(leadSession, 'search_chat', { chat: 'Partners MVP', query: 'invoice' })).text).toContain('No turn')
  })

  it('replace your Focus list, matching projects by name', async () => {
    const { leadSession, partners } = await setup()
    const res = await call(leadSession, 'update_focus', { focus: [{ label: 'Partners launch', project: 'partners' }, { label: 'Hiring' }] })
    expect(res.isError).toBeFalsy()
    const { focus } = await lead.status()
    expect(focus.map((f) => [f.label, f.projectId])).toEqual([['Partners launch', partners.id], ['Hiring', undefined]])
    expect((await call(leadSession, 'update_focus', { focus: [{ label: 'x', project: 'nowhere' }] })).isError).toBe(true)
  })

  it('see and close items across projects, and file new ones to Workspace by default', async () => {
    const { leadSession, partners, dirumed } = await setup()
    await storage.addActionItem({ projectId: partners.id, text: 'Approve the deploy' })
    const other = await storage.addActionItem({ projectId: dirumed.id, text: 'Pick a pharmacist flow' })
    const list = (await call(leadSession, 'list_action_items')).text
    expect(list).toContain('(Partners App, task')
    expect(list).toContain('(Dirumed App, task')

    await call(leadSession, 'add_action_item', { text: 'Write partnership goals', user_requested: true })
    await call(leadSession, 'add_action_item', { text: 'Fix pharmacy copy', user_requested: true, project: 'dirumed' })
    const items = await storage.listActionItems()
    const workspaceId = (await lead.workspaceProject()).id
    expect(items.find((i) => i.text === 'Write partnership goals')?.projectId).toBe(workspaceId)
    expect(items.find((i) => i.text === 'Fix pharmacy copy')?.projectId).toBe(dirumed.id)

    expect((await call(leadSession, 'resolve_action_item', { id: other.id.slice(0, 8), resolution: 'flow B' })).isError).toBeFalsy()
    expect((await storage.listActionItems(dirumed.id)).find((i) => i.id === other.id)?.status).toBe('done')
  })

  it('refuse an unknown project for a new item', async () => {
    const { leadSession } = await setup()
    const res = await call(leadSession, 'add_action_item', { text: 'x', user_requested: true, project: 'nowhere' })
    expect(res.isError).toBe(true)
    expect(res.text).toContain('Partners App')
  })

  it('keep their own memo', async () => {
    const { leadSession } = await setup()
    await call(leadSession, 'save_memo', { memo: 'Partnerships 3 days running.' })
    expect((await lead.status()).memo).toBe('Partnerships 3 days running.')
  })

  it('open a project chat with the prompt waiting unsent, which clears once you send', async () => {
    const { leadSession, partners } = await setup()
    const res = await call(leadSession, 'open_project_chat', { project: 'Partners App', title: 'Deploy partners', prompt: 'Run npm run deploy in mtmcya-dashboard.' })
    expect(res.isError).toBeFalsy()
    const opened = (await storage.listSessions()).find((s) => s.title === 'Deploy partners')!
    // Your last provider in that project (the chat above is Claude).
    expect(opened).toMatchObject({ projectId: partners.id, provider: 'claude', draft: 'Run npm run deploy in mtmcya-dashboard.' })
    expect(manager.getSession(opened.id)?.messages ?? []).toEqual([])

    manager.handleInput(opened.id, 'Run npm run deploy in mtmcya-dashboard.')
    expect(manager.getSession(opened.id)?.draft).toBeUndefined()
    await vi.waitFor(async () => expect((await storage.listSessions()).find((s) => s.id === opened.id)?.draft).toBeUndefined(), { timeout: 5_000 })
  }, 20_000)

  it('send the prompt right away on your go-ahead — never inside the brief', async () => {
    const { leadSession, partners } = await setup()
    const res = await call(leadSession, 'open_project_chat', { project: 'Partners App', title: 'Deploy now', prompt: 'Deploy it.', send: true })
    expect(res.isError).toBeFalsy()
    const opened = (await storage.listSessions()).find((s) => s.title === 'Deploy now')!
    expect(opened.draft).toBeUndefined()
    expect(manager.getSession(opened.id)!.messages[0]).toMatchObject({ role: 'user', content: 'Deploy it.' })
    await vi.waitFor(() => expect(manager.isBusy(opened.id)).toBe(false), { timeout: 10_000 })

    // The brief's own turn (an internal prompt) can't send.
    manager.getSession(leadSession.id)!.messages.push({ ...msg('user', 'Write the brief', Date.now()), metadata: { kind: 'prompt' } })
    const refused = await call(leadSession, 'open_project_chat', { project: partners.id, title: 'Sneaky', prompt: 'x', send: true })
    expect(refused.isError).toBe(true)
    expect((await storage.listSessions()).some((s) => s.title === 'Sneaky')).toBe(false)
  }, 20_000)

  it('list board ideas and refine or implement one on your word', async () => {
    const { leadSession, partners } = await setup()
    const idea = await storage.addTodo({ projectId: partners.id, text: 'Partner referral links' })
    const ran: string[] = []
    const boardTools = new AgentToolService({
      storage, sessionManager: manager,
      ideas: {
        refine: async (id, feedback) => { ran.push(`refine ${id} ${feedback}`); return { ran: true } },
        implement: async (id) => { ran.push(`implement ${id}`); return { ran: false, reason: 'This idea has no proposal yet' } },
      },
    })
    expect((await boardTools.call(leadSession, 'list_ideas', {})).text).toContain(`[${idea.id.slice(0, 8)}] Partner referral links — in the inbox`)
    expect((await boardTools.call(leadSession, 'run_idea', { idea: idea.id.slice(0, 8), action: 'refine' })).isError).toBe(true) // needs feedback
    expect((await boardTools.call(leadSession, 'run_idea', { idea: idea.id.slice(0, 8), action: 'refine', feedback: 'Smaller scope' })).isError).toBeFalsy()
    const impl = await boardTools.call(leadSession, 'run_idea', { idea: idea.id.slice(0, 8), action: 'implement' })
    expect(impl.isError).toBe(true)
    expect(impl.text).toContain('no proposal yet')
    expect(ran).toEqual([`refine ${idea.id} Smaller scope`, `implement ${idea.id}`])

    manager.getSession(leadSession.id)!.messages.push({ ...msg('user', 'Write the brief', Date.now()), metadata: { kind: 'prompt' } })
    expect((await boardTools.call(leadSession, 'run_idea', { idea: idea.id.slice(0, 8), action: 'refine', feedback: 'x' })).isError).toBe(true)
    expect(ran).toHaveLength(2)
  })

  it('cannot open a chat in the Workspace project', async () => {
    const { leadSession } = await setup()
    expect((await call(leadSession, 'open_project_chat', { project: 'Workspace', title: 'x', prompt: 'y' })).isError).toBe(true)
  })
})

describe('lead routes', () => {
  function app() {
    const a = express()
    a.use(express.json())
    a.use('/api/lead', createLeadRoutes(lead))
    a.use('/api/projects', createProjectRoutes(
      storage,
      { getStatus: () => null, listRunning: () => [], stop: async () => {} } as unknown as DevServerManager,
      { listRunning: () => [] } as unknown as ServiceManager,
    ))
    return a
  }

  it('GET /api/lead reports the lead, thread, Workspace and Focus', async () => {
    const persona = await addPersona('kiro')
    const res = await request(app()).get('/api/lead')
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ leadPersonaId: persona.id, sessionId: null, focus: [], memo: null, lastBriefAt: null })
    expect(res.body.workspaceProjectId).toBe((await lead.workspaceProject()).id)
  })

  it('PUT /api/lead/focus saves a valid list and 400s on a bad one', async () => {
    const focus = [{ id: randomUUID(), label: 'Partners launch' }]
    const ok = await request(app()).put('/api/lead/focus').send({ focus })
    expect(ok.status).toBe(200)
    expect(ok.body.focus).toEqual(focus)
    expect((await lead.status()).focus).toEqual(focus)
    const tooMany = Array.from({ length: 6 }, (_, i) => ({ id: randomUUID(), label: `p${i}` }))
    expect((await request(app()).put('/api/lead/focus').send({ focus: tooMany })).status).toBe(400)
    expect((await request(app()).put('/api/lead/focus').send({ focus: [{ id: 'x', label: '' }] })).status).toBe(400)
  })

  it('refuses to delete the Workspace project', async () => {
    const workspace = await lead.workspaceProject()
    expect((await request(app()).delete(`/api/projects/${workspace.id}`)).status).toBe(400)
    expect(await storage.getProject(workspace.id)).not.toBeNull()
  })
})

describe('matchProject', () => {
  const p = (name: string, id: string, internal = false) => ({ id, name, path: '/x', ...(internal ? { internal } : {}) })
  const projects = [
    p('Teremu App', 'aaaa1111-0000-4000-8000-000000000000'),
    p('Teremu Website', 'aaaa2222-0000-4000-8000-000000000000'),
    p('Dirumed App', 'bbbb1111-0000-4000-8000-000000000000'),
    p('Workspace', 'cccc1111-0000-4000-8000-000000000000', true),
  ]

  it('matches by id prefix, exact name, or a unique partial name', () => {
    expect(matchProject(projects, 'bbbb')?.name).toBe('Dirumed App')
    expect(matchProject(projects, 'teremu app')?.name).toBe('Teremu App')
    expect(matchProject(projects, 'dirumed')?.name).toBe('Dirumed App')
  })

  it('returns nothing when ambiguous, and Workspace only by its exact name', () => {
    expect(matchProject(projects, 'teremu')).toBeNull()
    expect(matchProject(projects, 'aaaa')).toBeNull()
    expect(matchProject(projects, 'work')).toBeNull()
    expect(matchProject(projects, 'Workspace')?.internal).toBe(true)
  })
})
