import { Router } from 'express'

import type { IStorageLayer } from '../storage.js'
import type { StandupService } from '../standup.js'
import { log } from '../logger.js'

/**
 * Create an Express Router for the standup layer: manual runs and state.
 */
export function createStandupRoutes(standup: StandupService, storage: IStorageLayer): Router {
  const router = Router()

  // POST /api/standup/:projectId/run — "Run standup now" (bypasses the
  // unchanged-todos gate, never double-runs). Responds as soon as the turn is
  // dispatched (202) — completion arrives via persona push notifications, so
  // the request never outlives a phone browser or a proxy timeout.
  router.post('/:projectId/run', async (req, res) => {
    try {
      const result = await standup.runStandup(req.params.projectId, { force: true })
      res.status(result.ran ? 202 : 409).json(result)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Standup failed'
      if (message.includes('not found')) {
        res.status(404).json({ error: message })
        return
      }
      log.error('api', `Standup run failed for project ${req.params.projectId}`, err)
      res.status(500).json({ error: message })
    }
  })

  // GET /api/standup/:projectId — standup state (last run, team session id)
  router.get('/:projectId', async (req, res) => {
    try {
      const state = await storage.getStandupState(req.params.projectId)
      res.json(state ?? { projectId: req.params.projectId })
    } catch (err) {
      log.error('api', `Failed to get standup state for project ${req.params.projectId}`, err)
      res.status(500).json({ error: 'Failed to get standup state' })
    }
  })

  return router
}
