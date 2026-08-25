/**
 * Web Push notifications.
 *
 * When an agent finishes a turn, CodePipe sends a Web Push message to every
 * subscribed browser/device. Installed as a PWA on a phone, this surfaces an
 * OS notification like Slack/WhatsApp — even when the app is backgrounded.
 *
 * Push requires VAPID keys (`VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY`). Generate
 * them once with `npm run gen-vapid`. Without keys, push is disabled and the
 * endpoints report so — the rest of the app is unaffected.
 *
 * The actual sender is injectable so the service is unit-testable without
 * hitting a real push service.
 */

import { readFile, writeFile, mkdir } from 'fs/promises'
import { existsSync } from 'fs'
import path from 'path'
import webpush from 'web-push'

import type { Session } from './schemas.js'
import { log } from './logger.js'

export interface PushSubscriptionJSON {
  endpoint: string
  keys: { p256dh: string; auth: string }
  expirationTime?: number | null
}

export interface PushPayload {
  title: string
  body: string
  sessionId: string
  /** Notification tag — reusing the session ID collapses repeats per session. */
  tag: string
}

/** Sends one notification. Returns/throws like web-push (errors carry statusCode). */
export type PushSender = (sub: PushSubscriptionJSON, payload: string) => Promise<unknown>

/** Implemented by PushService; SessionManager calls it on turn completion. */
export interface TurnNotifier {
  notifyTurnComplete(session: Session, lastAssistantText: string, projectName?: string): void
}

function snippet(text: string): string {
  const s = text.replace(/\s+/g, ' ').trim()
  if (s.length === 0) return 'New response'
  return s.length > 140 ? s.slice(0, 137) + '…' : s
}

export interface PushServiceOptions {
  dataDir: string
  publicKey?: string
  privateKey?: string
  subject?: string
  /** Override the network sender (tests). */
  sender?: PushSender
}

export class PushService implements TurnNotifier {
  private readonly file: string
  private readonly publicKey: string | null
  private readonly enabled: boolean
  private readonly sender: PushSender
  private subscriptions = new Map<string, PushSubscriptionJSON>()
  private loaded = false

  constructor(opts: PushServiceOptions) {
    this.file = path.join(opts.dataDir, 'push-subscriptions.json')
    const pub = opts.publicKey ?? process.env['VAPID_PUBLIC_KEY']
    const priv = opts.privateKey ?? process.env['VAPID_PRIVATE_KEY']
    const subject = opts.subject ?? process.env['VAPID_SUBJECT'] ?? 'mailto:admin@codepipe.local'
    this.enabled = Boolean(pub && priv)
    this.publicKey = pub ?? null

    if (this.enabled && !opts.sender) {
      webpush.setVapidDetails(subject, pub!, priv!)
    }
    this.sender =
      opts.sender ?? ((sub, payload) => webpush.sendNotification(sub as webpush.PushSubscription, payload))

    if (!this.enabled) {
      log.warn('push', 'VAPID keys not set — push notifications disabled. Run `npm run gen-vapid` and set VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY.')
    }
  }

  isEnabled(): boolean {
    return this.enabled
  }

  getPublicKey(): string | null {
    return this.publicKey
  }

  // ----- subscription storage -----

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    if (!existsSync(this.file)) return
    try {
      const raw = await readFile(this.file, 'utf-8')
      const arr = JSON.parse(raw) as PushSubscriptionJSON[]
      if (Array.isArray(arr)) {
        for (const s of arr) {
          if (s && typeof s.endpoint === 'string') this.subscriptions.set(s.endpoint, s)
        }
      }
    } catch (err) {
      log.error('push', 'Failed to read push subscriptions', err)
    }
  }

  private async persist(): Promise<void> {
    try {
      await mkdir(path.dirname(this.file), { recursive: true })
      await writeFile(this.file, JSON.stringify([...this.subscriptions.values()], null, 2), 'utf-8')
    } catch (err) {
      log.error('push', 'Failed to persist push subscriptions', err)
    }
  }

  async addSubscription(sub: PushSubscriptionJSON): Promise<void> {
    await this.ensureLoaded()
    this.subscriptions.set(sub.endpoint, sub)
    await this.persist()
    log.info('push', `Subscription added (${this.subscriptions.size} total)`)
  }

  async removeSubscription(endpoint: string): Promise<void> {
    await this.ensureLoaded()
    if (this.subscriptions.delete(endpoint)) await this.persist()
  }

  async subscriptionCount(): Promise<number> {
    await this.ensureLoaded()
    return this.subscriptions.size
  }

  // ----- sending -----

  notifyTurnComplete(session: Session, lastAssistantText: string, projectName?: string): void {
    if (!this.enabled) return
    const titleParts = [session.title || 'CodePipe']
    if (projectName) titleParts.push(projectName)
    const title = titleParts.join(' · ')
    log.info('push', `Turn complete for "${title}", sending push…`)
    void this.sendToAll({
      title,
      body: snippet(lastAssistantText),
      sessionId: session.id,
      tag: session.id,
    })
  }

  async sendToAll(payload: PushPayload): Promise<void> {
    if (!this.enabled) return
    await this.ensureLoaded()
    log.info('push', `Sending to ${this.subscriptions.size} subscriber(s): "${payload.title}"`)
    const json = JSON.stringify(payload)
    let pruned = false

    for (const sub of [...this.subscriptions.values()]) {
      try {
        await this.sender(sub, json)
      } catch (err) {
        const statusCode = (err as { statusCode?: number })?.statusCode
        if (statusCode === 404 || statusCode === 410) {
          // Subscription is gone — prune it.
          this.subscriptions.delete(sub.endpoint)
          pruned = true
        } else {
          log.warn('push', `Failed to send notification (status ${statusCode ?? 'unknown'})`)
        }
      }
    }

    if (pruned) await this.persist()
  }
}
