/**
 * Daily deadline reminder: once a day, after a set local hour, one push
 * notification summarizing open action items that are due today or overdue
 * ("2 due today · 1 overdue"). Tapping it opens the Actions page.
 *
 * At most one reminder per day: the date it last fired is persisted, so a
 * server restart doesn't repeat it. A day with nothing due sends nothing —
 * and if something becomes due later that day, the next tick picks it up.
 */

import { readFile, writeFile, mkdir } from 'fs/promises'
import path from 'path'

import type { IStorageLayer } from './storage.js'
import type { ActionItem } from './schemas.js'
import type { PushPayload } from './push.js'
import { log } from './logger.js'

/** How often to check whether the reminder is due. */
const TICK_MS = 5 * 60_000

/** Local hour (0–23) from which the day's reminder may go out. */
const DEFAULT_HOUR = 9

/** What the reminder needs from the push service. */
export interface ReminderPush {
  isEnabled(): boolean
  sendToAll(payload: PushPayload): Promise<void>
}

export interface DueReminderOptions {
  dataDir: string
  /** Defaults to DUE_REMINDER_HOUR, else 9. */
  hour?: number
  /** Clock override (tests). */
  now?: () => Date
}

/** A Date's local calendar day, YYYY-MM-DD. */
export function localDay(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** Open, unsnoozed items due on or before `today`, most overdue first. */
export function dueItems(items: ActionItem[], today: string, nowMs: number): ActionItem[] {
  return items
    .filter(
      (a) =>
        a.status === 'open' &&
        !!a.dueDate &&
        a.dueDate <= today &&
        !(a.snoozedUntil && a.snoozedUntil > nowMs),
    )
    .sort((a, b) => a.dueDate!.localeCompare(b.dueDate!))
}

export function buildReminder(items: ActionItem[], today: string): PushPayload {
  const overdue = items.filter((a) => a.dueDate! < today).length
  const dueToday = items.length - overdue
  const title = [dueToday && `${dueToday} due today`, overdue && `${overdue} overdue`].filter(Boolean).join(' · ')
  const body = items.map((a) => a.text.replace(/\s+/g, ' ').trim()).join(' · ')
  return {
    title,
    body: body.length > 140 ? body.slice(0, 137) + '…' : body,
    // One reminder per day replaces the previous one.
    tag: 'due-reminder',
    url: '/actions',
  }
}

export class DueReminderService {
  private readonly file: string
  private readonly hour: number
  private readonly now: () => Date
  private timer: ReturnType<typeof setInterval> | null = null
  private lastRemindedOn: string | null | undefined
  private checking = false

  constructor(
    private readonly storage: IStorageLayer,
    private readonly push: ReminderPush,
    opts: DueReminderOptions,
  ) {
    this.file = path.join(opts.dataDir, 'due-reminders.json')
    const envHour = Number(process.env['DUE_REMINDER_HOUR'])
    this.hour = opts.hour ?? (Number.isInteger(envHour) && envHour >= 0 && envHour <= 23 ? envHour : DEFAULT_HOUR)
    this.now = opts.now ?? (() => new Date())
  }

  start(): void {
    if (!this.push.isEnabled()) return
    void this.check()
    this.timer = setInterval(() => void this.check(), TICK_MS)
    this.timer.unref?.()
    log.info('reminders', `Due-date reminders on (daily from ${this.hour}:00)`)
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  /** Send today's reminder if it's time and hasn't gone out. Returns whether it sent. */
  async check(): Promise<boolean> {
    if (this.checking || !this.push.isEnabled()) return false
    this.checking = true
    try {
      const now = this.now()
      if (now.getHours() < this.hour) return false
      const today = localDay(now)
      if ((await this.loadLast()) === today) return false

      const due = dueItems(await this.storage.listActionItems(), today, now.getTime())
      if (due.length === 0) return false

      await this.push.sendToAll(buildReminder(due, today))
      await this.saveLast(today)
      log.info('reminders', `Sent due-date reminder (${due.length} item(s))`)
      return true
    } catch (err) {
      log.warn('reminders', `Due-date reminder failed: ${err instanceof Error ? err.message : String(err)}`)
      return false
    } finally {
      this.checking = false
    }
  }

  private async loadLast(): Promise<string | null> {
    if (this.lastRemindedOn !== undefined) return this.lastRemindedOn
    try {
      const data = JSON.parse(await readFile(this.file, 'utf8')) as { lastRemindedOn?: unknown }
      this.lastRemindedOn = typeof data.lastRemindedOn === 'string' ? data.lastRemindedOn : null
    } catch {
      this.lastRemindedOn = null
    }
    return this.lastRemindedOn
  }

  private async saveLast(day: string): Promise<void> {
    this.lastRemindedOn = day
    await mkdir(path.dirname(this.file), { recursive: true })
    await writeFile(this.file, JSON.stringify({ lastRemindedOn: day }, null, 2))
  }
}
