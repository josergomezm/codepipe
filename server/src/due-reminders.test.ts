import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'fs/promises'
import path from 'path'
import os from 'os'

import { StorageLayer } from './storage.js'
import { DueReminderService, buildReminder, dueItems } from './due-reminders.js'
import type { PushPayload } from './push.js'
import type { ActionItem } from './schemas.js'

let tmpDir: string
let storage: StorageLayer
let projectId: string
let sent: PushPayload[]
let now: Date
const push = {
  enabled: true,
  isEnabled() {
    return this.enabled
  },
  async sendToAll(payload: PushPayload) {
    sent.push(payload)
  },
}

function service(): DueReminderService {
  return new DueReminderService(storage, push, { dataDir: tmpDir, hour: 9, now: () => now })
}

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), 'codepipe-reminders-'))
  storage = new StorageLayer(tmpDir)
  await storage.ensureDataDir()
  projectId = (await storage.addProject({ name: 'demo', path: tmpDir })).id
  sent = []
  push.enabled = true
  now = new Date(2026, 9, 9, 9, 30) // Oct 9, 09:30 local
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

describe('dueItems', () => {
  const base = { projectId: 'p', createdAt: 1, updatedAt: 1 } as const
  const mk = (id: string, extra: Partial<ActionItem>): ActionItem => ({ id, text: id, status: 'open', ...base, ...extra })

  it('keeps open, unsnoozed items due today or earlier, most overdue first', () => {
    const nowMs = Date.now()
    const items = [
      mk('today', { dueDate: '2026-10-09' }),
      mk('late', { dueDate: '2026-10-01' }),
      mk('future', { dueDate: '2026-10-10' }),
      mk('none', {}),
      mk('done', { dueDate: '2026-10-01', status: 'done' }),
      mk('snoozed', { dueDate: '2026-10-01', snoozedUntil: nowMs + 60_000 }),
      mk('snooze-over', { dueDate: '2026-10-02', snoozedUntil: nowMs - 60_000 }),
    ]
    expect(dueItems(items, '2026-10-09', nowMs).map((a) => a.id)).toEqual(['late', 'snooze-over', 'today'])
  })
})

describe('buildReminder', () => {
  it('counts due today and overdue, and opens the Actions page', () => {
    const items = [
      { text: 'Rotate keys', dueDate: '2026-10-01' },
      { text: 'Renew cert', dueDate: '2026-10-09' },
    ] as ActionItem[]
    const payload = buildReminder(items, '2026-10-09')
    expect(payload.title).toBe('1 due today · 1 overdue')
    expect(payload.body).toBe('Rotate keys · Renew cert')
    expect(payload.url).toBe('/actions')
    expect(payload.sessionId).toBeUndefined()
  })
})

describe('DueReminderService', () => {
  it('sends once a day, after the hour, only when something is due', async () => {
    await storage.addActionItem({ projectId, text: 'Renew cert', dueDate: '2026-10-09' })

    now = new Date(2026, 9, 9, 8, 59)
    expect(await service().check()).toBe(false) // before 9:00

    now = new Date(2026, 9, 9, 9, 0)
    const svc = service()
    expect(await svc.check()).toBe(true)
    expect(sent).toHaveLength(1)
    expect(await svc.check()).toBe(false) // already today

    // Survives a restart: a fresh service reads the persisted date.
    expect(await service().check()).toBe(false)
    expect(sent).toHaveLength(1)

    now = new Date(2026, 9, 10, 9, 0) // next day, still overdue
    expect(await service().check()).toBe(true)
    expect(sent[1].title).toBe('1 overdue')
  })

  it('sends nothing on a day with nothing due, but picks up items that become due later', async () => {
    const svc = service()
    expect(await svc.check()).toBe(false)
    await storage.addActionItem({ projectId, text: 'Pay invoice', dueDate: '2026-10-09' })
    expect(await svc.check()).toBe(true)
  })

  it('does nothing when push is disabled', async () => {
    push.enabled = false
    await storage.addActionItem({ projectId, text: 'Renew cert', dueDate: '2026-10-09' })
    expect(await service().check()).toBe(false)
    expect(sent).toHaveLength(0)
  })
})
