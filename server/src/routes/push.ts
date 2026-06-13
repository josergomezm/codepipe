import { Router } from 'express'
import { z } from 'zod'

import type { PushService } from '../push.js'
import { log } from '../logger.js'

const SubscriptionSchema = z.object({
  endpoint: z.string().url(),
  keys: z.object({ p256dh: z.string().min(1), auth: z.string().min(1) }),
  expirationTime: z.number().nullable().optional(),
})

const UnsubscribeSchema = z.object({ endpoint: z.string().url() })

/**
 * Routes for Web Push subscription management.
 *
 *   GET  /api/push/vapid-public-key  → { enabled, publicKey }
 *   POST /api/push/subscribe         → register a PushSubscription
 *   POST /api/push/unsubscribe       → remove a subscription by endpoint
 */
export function createPushRoutes(push: PushService): Router {
  const router = Router()

  router.get('/vapid-public-key', (_req, res) => {
    res.json({ enabled: push.isEnabled(), publicKey: push.getPublicKey() })
  })

  router.post('/subscribe', async (req, res) => {
    if (!push.isEnabled()) {
      res.status(503).json({ error: 'Push notifications are not configured on the server' })
      return
    }
    const parsed = SubscriptionSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.format() })
      return
    }
    try {
      await push.addSubscription(parsed.data)
      res.status(201).json({ ok: true })
    } catch (err) {
      log.error('api', 'Failed to add push subscription', err)
      res.status(500).json({ error: 'Failed to add subscription' })
    }
  })

  router.post('/unsubscribe', async (req, res) => {
    const parsed = UnsubscribeSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.format() })
      return
    }
    try {
      await push.removeSubscription(parsed.data.endpoint)
      res.json({ ok: true })
    } catch (err) {
      log.error('api', 'Failed to remove push subscription', err)
      res.status(500).json({ error: 'Failed to remove subscription' })
    }
  })

  return router
}
