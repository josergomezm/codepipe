/**
 * Change-notification bus.
 *
 * The storage layer publishes a collection name whenever it commits a
 * mutation (change data capture at the single write point), and WebSocket
 * subscribers receive `{ type: 'changed', collection }` hints. Events are
 * deliberately notifications, not data: clients refetch through the normal
 * REST reads, so there is no second consistency model to reason about — the
 * store of record stays the JSON files, and a missed event degrades to
 * "slightly stale until the next fetch", never to wrong data.
 *
 * Bursts are coalesced per collection (a streaming turn persists the session
 * file many times) so subscribers see one hint per quiet period.
 */

import { log } from './logger.js'

export type ChangedCollection =
  | 'projects'
  | 'sessions'
  | 'todos'
  | 'actions'
  | 'personas'
  | 'standup'

export interface EventSubscriber {
  send(payload: string): void
}

/** Quiet period before a collection's change hint is broadcast. */
const COALESCE_MS = 250

export class EventBus {
  private readonly subscribers = new Set<EventSubscriber>()
  private readonly pending = new Map<ChangedCollection, ReturnType<typeof setTimeout>>()

  subscribe(subscriber: EventSubscriber): () => void {
    this.subscribers.add(subscriber)
    return () => {
      this.subscribers.delete(subscriber)
    }
  }

  subscriberCount(): number {
    return this.subscribers.size
  }

  /** Publish a change hint for a collection (coalesced per collection). */
  publish(collection: ChangedCollection): void {
    if (this.pending.has(collection)) return
    const timer = setTimeout(() => {
      this.pending.delete(collection)
      this.broadcast(collection)
    }, COALESCE_MS)
    timer.unref?.()
    this.pending.set(collection, timer)
  }

  private broadcast(collection: ChangedCollection): void {
    if (this.subscribers.size === 0) return
    const payload = JSON.stringify({ type: 'changed', collection })
    for (const subscriber of this.subscribers) {
      try {
        subscriber.send(payload)
      } catch (err) {
        log.debug('events', `Subscriber send failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }
}
