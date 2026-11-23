import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { execFileSync } from 'child_process'
import os from 'os'
import path from 'path'
import { randomUUID } from 'crypto'

import { StorageLayer } from '../storage.js'
import type { ChatMessage, Session } from '../schemas.js'
import { buildWorkspaceDigest, closedChatFrom, noteClosedChat, refreshAttention } from './workspace-digest.js'

const HOUR = 3_600_000
/** A realistic base time (a chat needs createdAt > 0 to load). */
const T = Date.UTC(2026, 10, 20)
let dir: string
let storage: StorageLayer

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'codepipe-digest-'))
  storage = new StorageLayer(path.join(dir, 'data'))
  await storage.ensureDataDir()
})

afterEach(async () => {
  await storage.whenIdle()
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
})

const msg = (role: ChatMessage['role'], content: string, at: number): ChatMessage =>
  ({ id: randomUUID(), role, content, timestamp: at, status: 'complete' })

function chat(projectId: string, title: string, messages: ChatMessage[], extra: Partial<Session> = {}): Session {
  const at = messages.at(-1)?.timestamp ?? Date.now()
  return { id: randomUUID(), provider: 'claude', projectId, title, createdAt: at - HOUR, updatedAt: at, status: 'live', messages, ...extra }
}

async function repoProject(name: string) {
  const repo = path.join(dir, name)
  execFileSync('git', ['init', '-q', repo])
  await writeFile(path.join(repo, 'a.txt'), 'a\n')
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '.'], { cwd: repo })
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'Ship the partner page'], { cwd: repo })
  return storage.addProject({ name, path: repo })
}

describe('buildWorkspaceDigest', () => {
  it('collects open chats (waiting on you first), activity, repos, closed chats, items and ideas', async () => {
    const now = Date.now()
    const partners = await repoProject('Partners')
    const quiet = await storage.addProject({ name: 'Quiet', path: path.join(dir, 'not-a-repo') })

    const asks = chat(partners.id, 'Partners MVP', [
      msg('user', 'Review partners and ship it', now - 5 * HOUR),
      msg('tool', 'Read src/app.ts', now - 4 * HOUR),
      msg('assistant', 'Built.\n\nDo you want me to deploy it?', now - 4 * HOUR),
    ])
    const recent = chat(quiet.id, 'Notes', [
      msg('user', 'Summarize the notes', now - HOUR),
      msg('assistant', 'Here is the summary.', now - HOUR / 2),
    ])
    const standup = chat(partners.id, 'Standup', [msg('user', 'x', now)], { kind: 'team' })
    for (const s of [asks, recent, standup]) await storage.saveSession(s)

    await storage.addClosedChat({ sessionId: randomUUID(), projectId: partners.id, title: 'Old', request: 'r', lastReply: 'done', closedAt: now - 2 * HOUR })
    await storage.addClosedChat({ sessionId: randomUUID(), projectId: partners.id, title: 'Ancient', request: 'r', lastReply: 'done', closedAt: now - 48 * HOUR })
    await storage.addActionItem({ projectId: partners.id, text: 'Decide the split' })
    await storage.addTodo({ projectId: partners.id, text: 'An idea' })

    const d = await buildWorkspaceDigest({ storage }, { since: now - 24 * HOUR, now })

    expect(d.chats.map((c) => c.title)).toEqual(['Partners MVP', 'Notes'])
    expect(d.chats[0].attention).toEqual({ state: 'waiting_on_you', question: 'Do you want me to deploy it?' })
    expect(d.chats[0].projectName).toBe('Partners')
    expect(d.activity.map((a) => [a.projectName, a.mine24])).toEqual([['Partners', 1], ['Quiet', 1]])
    expect(d.repos.map((r) => [r.projectName, r.activity.commits.map((c) => c.subject)])).toEqual([['Partners', ['Ship the partner page']]])
    expect(d.closed.map((c) => c.title)).toEqual(['Old'])
    expect(d.openActions.map((a) => a.text)).toEqual(['Decide the split'])
    expect(d.ideas).toEqual({ proposed: [], inboxCount: 1 })
    expect(d.trimmed).toBe(false)
  })

  it('shrinks the quietest chats when the digest is over budget', async () => {
    const now = Date.now()
    const p = await storage.addProject({ name: 'Big', path: path.join(dir, 'none') })
    const long = 'word '.repeat(400)
    for (let i = 0; i < 60; i++) {
      await storage.saveSession(chat(p.id, `Chat ${i}`, [
        msg('user', long, now - 3 * HOUR), msg('assistant', long, now - 3 * HOUR),
        msg('user', long, now - 2 * HOUR), msg('assistant', long, now - 2 * HOUR),
        msg('user', long, now - HOUR), msg('assistant', long, now - HOUR),
      ]))
    }
    const d = await buildWorkspaceDigest({ storage }, { since: now - 24 * HOUR, now })
    expect(d.trimmed).toBe(true)
    expect(JSON.stringify(d.chats).length / 4).toBeLessThanOrEqual(40_000)
    expect(d.chats.every((c) => c.firstRequest.length > 0)).toBe(true)
  })
})

describe('which repos make the digest', () => {
  it('keeps repos with unpushed work even without new commits, and drops quiet ones', async () => {
    const run = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, stdio: 'pipe' })
    const old = { ...process.env, GIT_COMMITTER_DATE: '2020-01-01T00:00:00Z', GIT_AUTHOR_DATE: '2020-01-01T00:00:00Z' }
    const origin = path.join(dir, 'origin.git')
    execFileSync('git', ['init', '-q', '--bare', origin])

    // Pushed, clean, nothing new: quiet.
    const quietRepo = path.join(dir, 'quiet')
    execFileSync('git', ['init', '-q', quietRepo])
    await writeFile(path.join(quietRepo, 'a.txt'), 'a\n')
    run(quietRepo, 'add', '.')
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'old'], { cwd: quietRepo, env: old })
    run(quietRepo, 'remote', 'add', 'origin', origin)
    run(quietRepo, 'push', '-q', '-u', 'origin', 'HEAD')

    // An old commit that was never pushed: still waiting on you.
    const aheadRepo = path.join(dir, 'ahead')
    run(dir, 'clone', '-q', origin, aheadRepo)
    await writeFile(path.join(aheadRepo, 'b.txt'), 'b\n')
    run(aheadRepo, 'add', '.')
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'old but unpushed'], { cwd: aheadRepo, env: old })

    await storage.addProject({ name: 'Quiet', path: quietRepo })
    await storage.addProject({ name: 'Ahead', path: aheadRepo })
    const d = await buildWorkspaceDigest({ storage }, { since: Date.now() - 24 * HOUR })
    expect(d.repos.map((r) => [r.projectName, r.activity.commits.length, r.activity.unpushed])).toEqual([['Ahead', 0, 1]])
  })
})

describe('closed chats', () => {
  it('records a user chat being deleted, with its request and last reply', async () => {
    const p = await storage.addProject({ name: 'P', path: dir })
    const s = chat(p.id, 'Fix login', [msg('user', 'Fix the login bug', T), msg('assistant', 'Fixed and deployed.', T + 1)])
    await storage.saveSession(s)
    await noteClosedChat({ storage }, s.id)
    const [entry] = await storage.listClosedChats()
    expect(entry).toMatchObject({ sessionId: s.id, title: 'Fix login', request: 'Fix the login bug', lastReply: 'Fixed and deployed.', attention: { state: 'done' } })
  })

  it('skips sessions that are not your chats, and empty ones', () => {
    const p = randomUUID()
    expect(closedChatFrom(chat(p, 'Review', [msg('user', 'x', 1), msg('assistant', 'y', 2)], { kind: 'review' }))).toBeNull()
    expect(closedChatFrom(chat(p, 'Empty', []))).toBeNull()
  })

  it('prefers the live in-memory copy', async () => {
    const p = await storage.addProject({ name: 'P', path: dir })
    const s = chat(p.id, 'Live', [msg('user', 'old', T)])
    await storage.saveSession(s)
    const live = { ...s, messages: [...s.messages, msg('assistant', 'Newer reply on screen', T + 1)] }
    await noteClosedChat({ storage, liveSession: (id) => (id === s.id ? live : undefined) }, s.id)
    expect((await storage.listClosedChats())[0].lastReply).toBe('Newer reply on screen')
  })
})

describe('refreshAttention', () => {
  it('recomputes how idle chats ended, writing only changes and skipping running ones', async () => {
    const p = await storage.addProject({ name: 'P', path: dir })
    const asks = chat(p.id, 'Asks', [msg('user', 'go', T), msg('assistant', 'Shall I push it?', T + 1)])
    const running = chat(p.id, 'Running', [msg('user', 'go', T), msg('assistant', 'Shall I push it?', T + 1)])
    // Stale: noted by older rules.
    const stale = chat(p.id, 'Stale', [msg('user', 'go', T), msg('assistant', 'Shall I push it?', T + 1)], { attention: { state: 'done' } })
    // Up to date already.
    const current = chat(p.id, 'Current', [msg('user', 'go', T), msg('assistant', 'Shall I push it?', T + 1)], { attention: { state: 'waiting_on_you', question: 'Shall I push it?' } })
    // You sent last (mid-conversation): no hint.
    const yours = chat(p.id, 'Yours', [msg('user', 'go', T), msg('assistant', 'Shall I push it?', T + 1), msg('user', 'yes', T + 2)], { attention: { state: 'waiting_on_you', question: 'Shall I push it?' } })
    for (const s of [asks, running, stale, current, yours]) await storage.saveSession(s)

    const n = await refreshAttention({ storage, liveSession: (id) => (id === running.id ? running : undefined) })
    expect(n).toBe(3)
    const meta = new Map((await storage.listSessions()).map((m) => [m.title, m.attention]))
    expect(meta.get('Asks')).toEqual({ state: 'waiting_on_you', question: 'Shall I push it?' })
    expect(meta.get('Running')).toBeUndefined()
    expect(meta.get('Stale')).toEqual({ state: 'waiting_on_you', question: 'Shall I push it?' })
    expect(meta.get('Current')).toEqual({ state: 'waiting_on_you', question: 'Shall I push it?' })
    expect(meta.get('Yours')).toBeUndefined()
  })
})
