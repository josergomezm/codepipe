/**
 * Local copy of what the app last saw — session list, projects, and recent
 * conversations — so opening the app shows them instantly while the server
 * refreshes them ("stale while revalidate").
 *
 * IndexedDB (not localStorage): transcripts run to hundreds of KB, and
 * localStorage is synchronous and capped at ~5MB. Everything here is best
 * effort: if storage is unavailable (private window, blocked, quota), reads
 * return null and writes are dropped — the app just loads from the server.
 *
 * The server stays the source of truth; nothing is ever sent from here.
 */
import type { ChatMessage } from '@/api/client'

const DB_NAME = 'codepipe-cache'
const STORE = 'kv'
/** Bump to drop every cached value when their shape changes. */
const VERSION = 1
/** Conversations kept (most recently opened/updated). */
const MAX_CONVERSATIONS = 40

let dbPromise: Promise<IDBDatabase | null> | null = null

function openDb(): Promise<IDBDatabase | null> {
  dbPromise ??= new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, VERSION)
      req.onupgradeneeded = () => {
        const db = req.result
        if (db.objectStoreNames.contains(STORE)) db.deleteObjectStore(STORE)
        db.createObjectStore(STORE)
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => resolve(null)
      req.onblocked = () => resolve(null)
    } catch {
      resolve(null)
    }
  })
  return dbPromise
}

async function run<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T | null> {
  const db = await openDb()
  if (!db) return null
  return new Promise((resolve) => {
    try {
      const req = fn(db.transaction(STORE, mode).objectStore(STORE))
      req.onsuccess = () => resolve(req.result ?? null)
      req.onerror = () => resolve(null)
    } catch {
      resolve(null)
    }
  })
}

export async function cacheGet<T>(key: string): Promise<T | null> {
  return (await run<T>('readonly', (s) => s.get(key) as IDBRequest<T>)) ?? null
}

export async function cacheSet(key: string, value: unknown): Promise<void> {
  // Vue proxies can't be structured-cloned; a JSON round-trip strips them.
  let plain: unknown
  try { plain = JSON.parse(JSON.stringify(value)) } catch { return }
  await run('readwrite', (s) => s.put(plain, key))
}

export async function cacheDelete(key: string): Promise<void> {
  await run('readwrite', (s) => s.delete(key))
}

// --- Conversations ---------------------------------------------------------

const messagesKey = (sessionId: string) => `messages:${sessionId}`
const INDEX_KEY = 'messages:index'

export function getCachedMessages(sessionId: string): Promise<ChatMessage[] | null> {
  return cacheGet<ChatMessage[]>(messagesKey(sessionId))
}

const pending = new Map<string, ReturnType<typeof setTimeout>>()

/**
 * Save a conversation, debounced per session (streaming updates arrive many
 * times a second). Keeps only the MAX_CONVERSATIONS most recent.
 */
export function saveCachedMessages(sessionId: string, messages: ChatMessage[], delayMs = 800): void {
  const prev = pending.get(sessionId)
  if (prev) clearTimeout(prev)
  pending.set(sessionId, setTimeout(() => {
    pending.delete(sessionId)
    void writeConversation(sessionId, messages)
  }, delayMs))
}

/** Index read-modify-writes run one at a time, so concurrent saves can't drop entries. */
let indexChain: Promise<void> = Promise.resolve()

function writeConversation(sessionId: string, messages: ChatMessage[]): Promise<void> {
  indexChain = indexChain.then(async () => {
    await cacheSet(messagesKey(sessionId), messages)
    const index = (await cacheGet<{ id: string; at: number }[]>(INDEX_KEY)) ?? []
    const next = [{ id: sessionId, at: Date.now() }, ...index.filter((e) => e.id !== sessionId)]
    for (const old of next.splice(MAX_CONVERSATIONS)) await cacheDelete(messagesKey(old.id))
    await cacheSet(INDEX_KEY, next)
  }).catch(() => {})
  return indexChain
}

export async function forgetCachedMessages(sessionId: string): Promise<void> {
  const t = pending.get(sessionId)
  if (t) clearTimeout(t)
  pending.delete(sessionId)
  await cacheDelete(messagesKey(sessionId))
}
