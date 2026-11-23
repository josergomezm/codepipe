/**
 * The daily brief: when it's due, what the lead is told, how post_brief turns
 * the lead's references into a real brief card, and how a run is recorded.
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
import { AgentToolService } from '../agent-tool-registry.js'
import { registerAdapter, clearAdapters } from '../adapters/registry.js'
import type { ICLIAdapter } from '../adapters/types.js'
import type { ChatMessage, Persona, Session } from '../schemas.js'
import { LeadService, isBriefDue } from './lead-service.js'
import { buildBriefPrompt } from './brief-prompt.js'
import { buildWorkspaceDigest } from './workspace-digest.js'
import { createLeadRoutes } from '../routes/lead.js'

const T = Date.UTC(2026, 10, 20)

describe('isBriefDue', () => {
  const daily = { enabled: true, hour: 9, weekdaysOnly: false }
  // Local times: Monday 2026-11-23 and Sunday 2026-11-22.
  const monday = (h: number) => new Date(2026, 10, 23, h, 30)
  const sunday = new Date(2026, 10, 22, 10, 0)

  it('is due once the hour has passed, until it ran or was attempted that day', () => {
    expect(isBriefDue(daily, undefined, monday(8))).toBe(false)
    expect(isBriefDue(daily, undefined, monday(9))).toBe(true)
    expect(isBriefDue(daily, undefined, monday(15))).toBe(true) // catch-up after sleep
    expect(isBriefDue(daily, monday(9).getTime(), monday(15))).toBe(false)
    expect(isBriefDue(daily, sunday.getTime(), monday(10))).toBe(true)
  })

  it('skips weekends when weekdays-only, and never runs when off', () => {
    expect(isBriefDue({ ...daily, weekdaysOnly: true }, undefined, sunday)).toBe(false)
    expect(isBriefDue({ ...daily, weekdaysOnly: true }, undefined, monday(10))).toBe(true)
    expect(isBriefDue({ ...daily, enabled: false }, undefined, monday(10))).toBe(false)
  })
})

// ---------------------------------------------------------------------------

/** A CLI that answers after a pause — long enough to call tools "during" the turn. */
const slowCli: ICLIAdapter = {
  provider: 'kiro',
  command: process.execPath,
  args: [],
  transport: 'oneshot',
  onData: (line) => (line.trim() ? [{ type: 'chunk', role: 'assistant', content: line.trim() }] : []),
  buildMessageCommand: () => ({ command: process.execPath, args: ['-e', 'setTimeout(() => console.log("Brief is up."), 800)'] }),
}

let dir: string
let storage: StorageLayer
let manager: SessionManager
let lead: LeadService
let tools: AgentToolService

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'codepipe-brief-'))
  storage = new StorageLayer(path.join(dir, 'data'))
  await storage.ensureDataDir()
  manager = new SessionManager(storage)
  lead = new LeadService(storage, manager, path.join(dir, 'data'))
  tools = new AgentToolService({ storage, sessionManager: manager })
  registerAdapter('kiro', () => slowCli)
})

afterEach(async () => {
  await lead.whenIdle()
  await manager.shutdown()
  clearAdapters()
  await storage.whenIdle()
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
})

const msg = (role: ChatMessage['role'], content: string, at: number): ChatMessage =>
  ({ id: randomUUID(), role, content, timestamp: at, status: 'complete' })

async function world() {
  const persona = await storage.addPersona({ name: 'Rimuru', role: 'Chancellor', personality: 'Calm and brief.', provider: 'kiro', isLead: true })
  const partners = await storage.addProject({ name: 'Partners App', path: path.join(dir, 'none') })
  const now = Date.now()
  const chat: Session = {
    id: randomUUID(), provider: 'claude', projectId: partners.id, title: 'Partners MVP', createdAt: now - 3_600_000, updatedAt: now - 60_000, status: 'live',
    messages: [msg('user', 'Ship the partner page', now - 3_600_000), msg('assistant', 'Built.\n\nDo you want me to deploy it?', now - 60_000)],
  }
  await storage.saveSession(chat)
  const item = await storage.addActionItem({ projectId: partners.id, text: 'Pick the commission split' })
  return { persona, partners, chat, item }
}

describe('buildBriefPrompt', () => {
  it('gives the lead the chats, Focus, memo, items and how to report', async () => {
    const { persona, partners, chat, item } = await world()
    const now = Date.now()
    const digest = await buildWorkspaceDigest({ storage }, { since: now - 86_400_000, now })
    const prompt = buildBriefPrompt({
      digest, lead: persona as Persona, projects: await storage.listProjects(),
      focus: [{ id: randomUUID(), label: 'Partners launch', projectId: partners.id }], memo: 'Watching partnerships.', now,
    })
    expect(prompt).toContain('You are Rimuru, Chancellor')
    expect(prompt).toContain('Calm and brief.')
    expect(prompt).toContain('1. Partners launch (Partners App)')
    expect(prompt).toContain('Your memo from the last brief:\nWatching partnerships.')
    expect(prompt).toContain(`[${chat.id.slice(0, 8)}] "Partners MVP" — Partners App`)
    expect(prompt).toContain('ended asking you: "Do you want me to deploy it?"')
    expect(prompt).toContain('Original request: Ship the partner page')
    expect(prompt).toContain(`[${item.id.slice(0, 8)}] Partners App · task`)
    expect(prompt).toContain('`post_brief` exactly once')
    expect(prompt).toContain('You never change code or files.')
  })

  it('says so when there is nothing to report', async () => {
    const persona = await storage.addPersona({ name: 'R', role: 'Lead', personality: '', provider: 'kiro', isLead: true })
    const now = Date.now()
    const digest = await buildWorkspaceDigest({ storage }, { since: now - 86_400_000, now })
    const prompt = buildBriefPrompt({ digest, lead: persona, projects: [], focus: [], now })
    expect(prompt).toContain('No open chats.')
    expect(prompt).toContain('(none set yet')
    expect(prompt).not.toContain('Your memo')
  })
})

describe('post_brief', () => {
  it('posts a brief card with resolved chats, items, projects and computed activity', async () => {
    const { partners, chat, item } = await world()
    const leadSession = (await lead.ensureLeadSession())!
    await tools.call(leadSession, 'update_action_item', { id: item.id.slice(0, 8), progress: 'Discussed 70/30 in Partners MVP', chat: chat.id.slice(0, 8) })
    const res = await tools.call(leadSession, 'post_brief', {
      headline: 'Partners is the day.',
      top3: [
        { text: 'Deploy the partner page', why: 'Top of Focus', chat: chat.id.slice(0, 8) },
        { text: 'Answer the pilot question', why: 'Blocks the launch', item: item.id.slice(0, 8) },
      ],
      waiting_on_you: [{ chat: 'Partners MVP', question: 'Do you want me to deploy it?' }],
      focus_check: { verdict: 'shifted', note: 'All partnerships.', suggestions: [{ kind: 'add', label: 'Partners launch', project: 'partners', why: '3 days running' }] },
      done: [{ text: 'Phase 7 shipped', project: 'Partners App' }],
      clean_up: [{ item: item.id.slice(0, 8), suggestion: 'snooze', why: 'After the pilot' }],
    })
    expect(res.isError).toBeFalsy()
    const card = manager.getSession(leadSession.id)!.messages.find((m) => m.metadata?.kind === 'brief')!
    const brief = card.metadata!.brief!
    expect(brief.top3[0].sessionId).toBe(chat.id)
    expect(brief.top3[1].itemId).toBe(item.id)
    expect(brief.updates).toEqual([expect.objectContaining({ itemId: item.id, text: 'Pick the commission split', change: 'progress: Discussed 70/30 in Partners MVP' })])
    expect(brief.waiting).toEqual([{ sessionId: chat.id, title: 'Partners MVP', projectName: 'Partners App', question: 'Do you want me to deploy it?' }])
    expect(brief.focusCheck.suggestions[0].projectId).toBe(partners.id)
    expect(brief.cleanUp[0]).toMatchObject({ itemId: item.id, text: 'Pick the commission split', projectName: 'Partners App', suggestion: 'snooze' })
    expect(brief.done).toEqual([{ text: 'Phase 7 shipped', projectName: 'Partners App' }])
    expect(brief.activity).toEqual([{ projectId: partners.id, projectName: 'Partners App', mine24: 1, mine7: 1 }])
  })

  it('refuses unknown references instead of posting a half-linked brief', async () => {
    await world()
    const leadSession = (await lead.ensureLeadSession())!
    const res = await tools.call(leadSession, 'post_brief', {
      headline: 'x', focus_check: { verdict: 'on_plan', note: 'ok' },
      top3: [{ text: 'x', why: 'y', item: 'yyyy' }],
      waiting_on_you: [{ chat: 'nope', question: '?' }], clean_up: [{ item: 'zzzz', suggestion: 'close', why: 'x' }],
    })
    expect(res.isError).toBe(true)
    expect(res.text).toContain('chat "nope"')
    expect(res.text).toContain('item "zzzz"')
    expect(res.text).toContain('item "yyyy"')
    expect(manager.getSession(leadSession.id)!.messages.some((m) => m.metadata?.kind === 'brief')).toBe(false)
  })
})

describe('runBrief', () => {
  it('needs a team', async () => {
    expect(await lead.runBrief({ scheduled: false })).toEqual({ ran: false, reason: expect.stringContaining('No team') })
  })

  it('runs one at a time, and records the brief only when one was posted', async () => {
    await world()
    const started = Date.now()
    const first = await lead.runBrief({ scheduled: false })
    expect(first.ran).toBe(true)
    expect((await lead.runBrief({ scheduled: false })).reason).toMatch(/already/)
    expect((await lead.status()).briefRunning).toBe(true)

    // The lead calls post_brief during its turn.
    const leadSession = manager.getSession(first.sessionId!)!
    await vi.waitFor(() => expect(manager.isBusy(leadSession.id)).toBe(true), { timeout: 5_000 })
    await tools.call(leadSession, 'post_brief', { headline: 'Day', top3: [], focus_check: { verdict: 'on_plan', note: 'ok' } })

    await lead.whenIdle()
    const state = await lead.status()
    expect(state.briefRunning).toBe(false)
    expect(state.lastBriefAt).toBeGreaterThanOrEqual(started)
    // The prompt is collapsed as a machine-built message in the thread.
    expect(manager.getSession(leadSession.id)!.messages.some((m) => m.role === 'user' && m.metadata?.kind === 'prompt')).toBe(true)
  }, 20_000)

  it('a turn without post_brief leaves lastBriefAt alone; a scheduled one records the attempt', async () => {
    await world()
    const run = await lead.runBrief({ scheduled: true })
    expect(run.ran).toBe(true)
    await lead.whenIdle()
    const state = await storage.getLeadState()
    expect(state.lastBriefAt).toBeUndefined()
    expect(state.lastAttemptAt).toBeGreaterThan(0)
    // The end is always written, so clients learn the run is over.
    expect(state.lastRunEndedAt).toBeGreaterThan(0)
    expect((await lead.status()).briefRunning).toBe(false)
  }, 20_000)

  it('leaves the lead alone while it is busy in your conversation', async () => {
    await world()
    const thread = (await lead.ensureLeadSession())!
    manager.handleInput(thread.id, 'What should I do first?')
    await vi.waitFor(() => expect(manager.isBusy(thread.id)).toBe(true), { timeout: 5_000 })
    const run = await lead.runBrief({ scheduled: true })
    expect(run).toMatchObject({ ran: false, reason: expect.stringContaining('busy') })
    // Not counted as today's attempt: the next tick tries again.
    expect((await storage.getLeadState()).lastAttemptAt).toBeUndefined()
    await vi.waitFor(() => expect(manager.isBusy(thread.id)).toBe(false), { timeout: 10_000 })
  }, 20_000)
})

describe('lead routes (brief)', () => {
  const app = () => {
    const a = express()
    a.use(express.json())
    a.use('/api/lead', createLeadRoutes(lead))
    return a
  }

  it('GET reports the default schedule; PUT saves one and 400s on a bad one', async () => {
    expect((await request(app()).get('/api/lead')).body).toMatchObject({ schedule: { enabled: true, hour: 9, weekdaysOnly: false }, briefRunning: false })
    const schedule = { enabled: true, hour: 8, weekdaysOnly: true }
    expect((await request(app()).put('/api/lead/schedule').send({ schedule })).body).toEqual({ schedule })
    expect((await request(app()).get('/api/lead')).body.schedule).toEqual(schedule)
    expect((await request(app()).put('/api/lead/schedule').send({ schedule: { enabled: true, hour: 25, weekdaysOnly: false } })).status).toBe(400)
  })

  it('POST /brief answers at once, with why when it can\'t', async () => {
    const res = await request(app()).post('/api/lead/brief')
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ ran: false })
  })

  it('POST /brief starts a run, and a second one while it runs says so', async () => {
    await world()
    const first = await request(app()).post('/api/lead/brief')
    expect(first.body).toMatchObject({ ran: true, sessionId: expect.any(String) })
    const second = await request(app()).post('/api/lead/brief')
    expect(second.body).toMatchObject({ ran: false, reason: expect.stringMatching(/already/) })
    await lead.whenIdle()
  }, 20_000)

  it('GET /digest returns your open chats as the lead reads them', async () => {
    const { chat } = await world()
    const res = await request(app()).get('/api/lead/digest')
    expect(res.status).toBe(200)
    expect(res.body.chats.map((c: { sessionId: string }) => c.sessionId)).toEqual([chat.id])
    expect(res.body.openActions).toHaveLength(1)
  })

  it('PUT /schedule 400s without a full schedule', async () => {
    expect((await request(app()).put('/api/lead/schedule').send({})).status).toBe(400)
    expect((await request(app()).put('/api/lead/schedule').send({ schedule: { enabled: true, hour: 9 } })).status).toBe(400)
  })
})

describe('the scheduler tick', () => {
  // Local Monday 2026-11-23.
  const at = (h: number, m = 0) => new Date(2026, 10, 23, h, m)

  it('runs the default daily brief once, and a failed attempt waits for tomorrow', async () => {
    await world()
    await lead.tick(at(8))
    expect((await storage.getLeadState()).lastAttemptAt).toBeUndefined()

    await lead.tick(at(9, 5))
    const attempted = (await storage.getLeadState()).lastAttemptAt
    expect(attempted).toBeGreaterThan(0)
    await lead.whenIdle() // this turn posts nothing: a failed brief

    // The attempt was stored with the real clock; pretend it happened at 9:05 today.
    await storage.updateLeadState((s) => { s.lastAttemptAt = at(9, 5).getTime() })
    await lead.tick(at(14))
    expect((await storage.getLeadState()).lastAttemptAt).toBe(at(9, 5).getTime())
  }, 20_000)

  it('does not stack a scheduled run on top of a manual one', async () => {
    await world()
    expect((await lead.runBrief({ scheduled: false })).ran).toBe(true)
    await lead.tick(at(10))
    // Skipped while running, and not recorded as an attempt.
    expect((await storage.getLeadState()).lastAttemptAt).toBeUndefined()
    await lead.whenIdle()
  }, 20_000)
})

describe('post_brief grounding', () => {
  const minimal = { headline: 'Day', top3: [], focus_check: { verdict: 'on_plan', note: 'ok' } }

  it('posts one brief per run', async () => {
    await world()
    const thread = (await lead.ensureLeadSession())!
    expect((await tools.call(thread, 'post_brief', minimal)).isError).toBeFalsy()
    const again = await tools.call(thread, 'post_brief', minimal)
    expect(again.isError).toBe(true)
    expect(manager.getSession(thread.id)!.messages.filter((m) => m.metadata?.kind === 'brief')).toHaveLength(1)
  })

  it('refuses unknown top-3 chats, suggestion projects and done projects', async () => {
    await world()
    const thread = (await lead.ensureLeadSession())!
    const res = await tools.call(thread, 'post_brief', {
      headline: 'x',
      top3: [{ text: 't', why: 'w', chat: 'ghost' }],
      focus_check: { verdict: 'shifted', note: 'n', suggestions: [{ kind: 'add', label: 'l', project: 'atlantis', why: 'w' }] },
      done: [{ text: 'd', project: 'lemuria' }],
    })
    expect(res.isError).toBe(true)
    expect(res.text).toContain('chat "ghost"')
    expect(res.text).toContain('project "atlantis"')
    expect(res.text).toContain('project "lemuria"')
  })

  it('points a drop suggestion at a real Focus item, by number or label', async () => {
    const { partners } = await world()
    const focus = [{ id: randomUUID(), label: 'Dirumed release' }, { id: randomUUID(), label: 'Partners launch', projectId: partners.id }]
    await storage.updateLeadState((s) => { s.focus = focus })
    const thread = (await lead.ensureLeadSession())!
    const bad = await tools.call(thread, 'post_brief', { ...minimal, focus_check: { verdict: 'shifted', note: 'n', suggestions: [{ kind: 'drop', label: 'x', focus_item: 7, why: 'w' }] } })
    expect(bad.isError).toBe(true)
    const ok = await tools.call(thread, 'post_brief', {
      ...minimal,
      focus_check: { verdict: 'shifted', note: 'n', suggestions: [{ kind: 'drop', label: 'Dirumed release', focus_item: '1', why: 'untouched' }] },
    })
    expect(ok.isError).toBeFalsy()
    const brief = manager.getSession(thread.id)!.messages.find((m) => m.metadata?.kind === 'brief')!.metadata!.brief!
    expect(brief.focusCheck.suggestions[0].focusItemId).toBe(focus[0].id)
  })

  it('quotes a waiting chat\'s own question rather than the lead\'s paraphrase', async () => {
    const { chat } = await world()
    await storage.setSessionAttention(chat.id, { state: 'waiting_on_you', question: 'Do you want me to deploy it?' })
    const thread = (await lead.ensureLeadSession())!
    await tools.call(thread, 'post_brief', { ...minimal, waiting_on_you: [{ chat: chat.id.slice(0, 8), question: 'Deploy?' }] })
    const brief = manager.getSession(thread.id)!.messages.find((m) => m.metadata?.kind === 'brief')!.metadata!.brief!
    expect(brief.waiting[0].question).toBe('Do you want me to deploy it?')
  })
})

describe('brief runs, end to end', () => {
  it('counts a posted brief even when the turn fails afterwards', async () => {
    await world()
    // This run's CLI exits with an error after a pause (e.g. it timed out saving the memo).
    clearAdapters()
    registerAdapter('kiro', () => ({ ...slowCli, buildMessageCommand: () => ({ command: process.execPath, args: ['-e', 'setTimeout(() => process.exit(3), 800)'] }) }))
    const started = Date.now()
    const run = await lead.runBrief({ scheduled: false })
    const thread = manager.getSession(run.sessionId!)!
    await vi.waitFor(() => expect(manager.isBusy(thread.id)).toBe(true), { timeout: 5_000 })
    await tools.call(thread, 'post_brief', { headline: 'Day', top3: [], focus_check: { verdict: 'on_plan', note: 'ok' } })
    await lead.whenIdle()
    const state = await storage.getLeadState()
    expect(state.lastBriefAt).toBeGreaterThanOrEqual(started)
    expect(state.lastRunEndedAt).toBeGreaterThan(0)
  }, 20_000)

  it('lets the next run post its own brief', async () => {
    await world()
    const post = async () => {
      const run = await lead.runBrief({ scheduled: false })
      const thread = manager.getSession(run.sessionId!)!
      await vi.waitFor(() => expect(manager.isBusy(thread.id)).toBe(true), { timeout: 5_000 })
      const res = await tools.call(thread, 'post_brief', { headline: 'Day', top3: [], focus_check: { verdict: 'on_plan', note: 'ok' } })
      await lead.whenIdle()
      return { res, thread }
    }
    expect((await post()).res.isError).toBeFalsy()
    const second = await post()
    expect(second.res.isError).toBeFalsy()
    expect(manager.getSession(second.thread.id)!.messages.filter((m) => m.metadata?.kind === 'brief')).toHaveLength(2)
  }, 30_000)

  it('stores the brief so the thread loads back from disk', async () => {
    const { chat, item } = await world()
    const thread = (await lead.ensureLeadSession())!
    await tools.call(thread, 'post_brief', {
      headline: 'Day', top3: [{ text: 't', why: 'w', chat: chat.id.slice(0, 8) }],
      waiting_on_you: [{ chat: chat.id.slice(0, 8), question: 'Deploy?' }],
      focus_check: { verdict: 'mixed', note: 'n', question: 'Which first?' },
      clean_up: [{ item: item.id.slice(0, 8), suggestion: 'close', why: 'done' }],
    })
    await storage.whenIdle()
    const reloaded = await new StorageLayer(path.join(dir, 'data')).getSession(thread.id)
    expect(reloaded).not.toBeNull()
    expect(reloaded!.messages.find((m) => m.metadata?.kind === 'brief')?.metadata?.brief?.focusCheck.question).toBe('Which first?')
  })
})
