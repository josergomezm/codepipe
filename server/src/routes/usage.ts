import { Router } from 'express'
import type { UsageService } from '../usage.js'
import { log } from '../logger.js'

/**
 * Plan usage per provider, from each CLI's `/usage` command:
 * GET /api/usage            → cached readings (refreshed every few minutes)
 * GET /api/usage?refresh=1  → re-read anything older than a few seconds
 */
export function createUsageRoutes(usage: UsageService): Router {
  const router = Router()

  router.get('/', async (req, res) => {
    try {
      const refresh = req.query['refresh'] === '1' || req.query['refresh'] === 'true'
      res.json({ providers: await usage.getAll({ refresh }) })
    } catch (err) {
      log.error('api', 'Failed to read provider usage', err)
      res.status(500).json({ error: 'Failed to read usage' })
    }
  })

  return router
}
