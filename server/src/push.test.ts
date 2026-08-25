import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, rm, readFile } from 'fs/promises'
import { existsSync } from 'fs'
import path from 'path'
import os from 'os'
import { PushService, type PushSubscriptionJSON, type PushSender } from './push.js'
import type { Session } from './schemas.js'

let tmpDir: string

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), 'push-test-'))
})
afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

function sub(endpoint: string): PushSubscriptionJSON {
  return { endpoint, keys: { p256dh: 'p', auth: 'a' } }
}

function makeService(sender: PushSender) {
  return new PushService({
    dataDir: tmpDir,
    publicKey: 'test-public',
    privateKey: 'test-private',
    sender,
  })
}

function makeSession(overrides: Partial<Session> = {}): Session {
  const now = Date.now()
  return {
    id: 'sess-1',
    provider: 'claude',
    projectId: 'p1',
    title: 'My session',
    createdAt: now,
    updatedAt: now,
    status: 'live',
    messages: [],
    ...overrides,
  }
}

describe('PushService enablement', () => {
  let savedPub: string | undefined
  let savedPriv: string | undefined

  beforeEach(() => {
    savedPub = process.env['VAPID_PUBLIC_KEY']
    savedPriv = process.env['VAPID_PRIVATE_KEY']
    delete process.env['VAPID_PUBLIC_KEY']
    delete process.env['VAPID_PRIVATE_KEY']
  })
  afterEach(() => {
    if (savedPub !== undefined) process.env['VAPID_PUBLIC_KEY'] = savedPub
    else delete process.env['VAPID_PUBLIC_KEY']
    if (savedPriv !== undefined) process.env['VAPID_PRIVATE_KEY'] = savedPriv
    else delete process.env['VAPID_PRIVATE_KEY']
  })

  it('is disabled without VAPID keys', () => {
    const svc = new PushService({ dataDir: tmpDir })
    expect(svc.isEnabled()).toBe(false)
    expect(svc.getPublicKey()).toBeNull()
  })

  it('is enabled and exposes the public key when keys are provided', () => {
    const svc = makeService(async () => {})
    expect(svc.isEnabled()).toBe(true)
    expect(svc.getPublicKey()).toBe('test-public')
  })

  it('does not send when disabled', async () => {
    const sender = vi.fn(async () => {})
    const svc = new PushService({ dataDir: tmpDir, sender }) // no keys → disabled
    await svc.addSubscription(sub('https://x/1'))
    await svc.sendToAll({ title: 't', body: 'b', sessionId: 's', tag: 's' })
    expect(sender).not.toHaveBeenCalled()
  })
})

describe('subscription storage', () => {
  it('persists subscriptions to disk and reloads them', async () => {
    const svc = makeService(async () => {})
    await svc.addSubscription(sub('https://push/1'))
    await svc.addSubscription(sub('https://push/2'))
    expect(existsSync(path.join(tmpDir, 'push-subscriptions.json'))).toBe(true)

    const reloaded = makeService(async () => {})
    expect(await reloaded.subscriptionCount()).toBe(2)
  })

  it('dedupes by endpoint', async () => {
    const svc = makeService(async () => {})
    await svc.addSubscription(sub('https://push/1'))
    await svc.addSubscription(sub('https://push/1'))
    expect(await svc.subscriptionCount()).toBe(1)
  })

  it('removes a subscription by endpoint', async () => {
    const svc = makeService(async () => {})
    await svc.addSubscription(sub('https://push/1'))
    await svc.removeSubscription('https://push/1')
    expect(await svc.subscriptionCount()).toBe(0)
  })
})

describe('sendToAll', () => {
  it('sends the payload to every subscription', async () => {
    const calls: Array<{ endpoint: string; payload: string }> = []
    const svc = makeService(async (s, payload) => {
      calls.push({ endpoint: s.endpoint, payload })
    })
    await svc.addSubscription(sub('https://push/1'))
    await svc.addSubscription(sub('https://push/2'))

    await svc.sendToAll({ title: 'T', body: 'B', sessionId: 'sx', tag: 'sx' })
    expect(calls).toHaveLength(2)
    expect(JSON.parse(calls[0]!.payload)).toMatchObject({ title: 'T', body: 'B', sessionId: 'sx' })
  })

  it('prunes subscriptions that return 410 Gone', async () => {
    const svc = makeService(async (s) => {
      if (s.endpoint === 'https://push/dead') {
        throw Object.assign(new Error('gone'), { statusCode: 410 })
      }
    })
    await svc.addSubscription(sub('https://push/live'))
    await svc.addSubscription(sub('https://push/dead'))

    await svc.sendToAll({ title: 'T', body: 'B', sessionId: 's', tag: 's' })
    expect(await svc.subscriptionCount()).toBe(1)
  })

  it('keeps subscriptions on transient (non-410) errors', async () => {
    const svc = makeService(async () => {
      throw Object.assign(new Error('boom'), { statusCode: 500 })
    })
    await svc.addSubscription(sub('https://push/1'))
    await svc.sendToAll({ title: 'T', body: 'B', sessionId: 's', tag: 's' })
    expect(await svc.subscriptionCount()).toBe(1)
  })
})

describe('notifyTurnComplete', () => {
  it('builds a notification with the session title and a body snippet', async () => {
    const calls: string[] = []
    const svc = makeService(async (_s, payload) => {
      calls.push(payload)
    })
    await svc.addSubscription(sub('https://push/1'))

    svc.notifyTurnComplete(makeSession({ title: 'Refactor auth' }), '  Done!  I updated three files.  ')
    await vi.waitFor(() => expect(calls).toHaveLength(1))

    const payload = JSON.parse(calls[0]!)
    expect(payload.title).toBe('Refactor auth')
    expect(payload.body).toBe('Done! I updated three files.')
    expect(payload.sessionId).toBe('sess-1')
  })

  it('appends the project name to the title when provided', async () => {
    const calls: string[] = []
    const svc = makeService(async (_s, payload) => {
      calls.push(payload)
    })
    await svc.addSubscription(sub('https://push/1'))

    svc.notifyTurnComplete(makeSession({ title: 'Refactor auth' }), 'Done!', 'CodePipe App')
    await vi.waitFor(() => expect(calls).toHaveLength(1))

    expect(JSON.parse(calls[0]!).title).toBe('Refactor auth · CodePipe App')
  })

  it('truncates long bodies', async () => {
    const calls: string[] = []
    const svc = makeService(async (_s, payload) => {
      calls.push(payload)
    })
    await svc.addSubscription(sub('https://push/1'))
    svc.notifyTurnComplete(makeSession(), 'x'.repeat(500))
    await vi.waitFor(() => expect(calls).toHaveLength(1))
    expect(JSON.parse(calls[0]!).body.length).toBeLessThanOrEqual(140)
  })
})
