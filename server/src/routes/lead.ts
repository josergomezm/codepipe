import { Router } from 'express'
import type { LeadService } from '../lead/lead-service.js'
import { PutFocusRequestSchema } from '../schemas.js'
import { log } from '../logger.js'

/** The lead assistant: /api/lead */
export function createLeadRoutes(lead: LeadService): Router {
  const router = Router()

  // GET /api/lead — who leads, their thread, your Focus list, the memo
  router.get('/', async (_req, res) => {
    try {
      res.json(await lead.status())
    } catch (err) {
      log.error('api', 'Failed to read the lead status', err)
      res.status(500).json({ error: 'Failed to read the lead status' })
    }
  })

  // PUT /api/lead/focus — replace your Focus list (ranked, up to 5)
  router.put('/focus', async (req, res) => {
    const parsed = PutFocusRequestSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.format() })
      return
    }
    try {
      res.json({ focus: await lead.setFocus(parsed.data.focus) })
    } catch (err) {
      log.error('api', 'Failed to save the Focus list', err)
      res.status(500).json({ error: 'Failed to save the Focus list' })
    }
  })

  return router
}
