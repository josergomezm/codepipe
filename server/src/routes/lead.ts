import { Router } from 'express'
import type { LeadService } from '../lead/lead-service.js'
import { PutBriefScheduleRequestSchema, PutFocusRequestSchema } from '../schemas.js'
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

  // GET /api/lead/digest — what the lead reads (the Sources sheet)
  router.get('/digest', async (_req, res) => {
    try {
      res.json(await lead.digest())
    } catch (err) {
      log.error('api', 'Failed to build the lead digest', err)
      res.status(500).json({ error: 'Failed to build the digest' })
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

  // POST /api/lead/brief — "Brief me now": starts a brief, answers at once
  // ({ ran, reason?, sessionId? }); the brief lands in the lead's thread.
  router.post('/brief', async (_req, res) => {
    try {
      res.json(await lead.runBrief({ scheduled: false }))
    } catch (err) {
      log.error('api', 'Failed to start the brief', err)
      res.status(500).json({ error: 'Failed to start the brief' })
    }
  })

  // PUT /api/lead/schedule — when the brief runs on its own
  router.put('/schedule', async (req, res) => {
    const parsed = PutBriefScheduleRequestSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.format() })
      return
    }
    try {
      res.json({ schedule: await lead.setSchedule(parsed.data.schedule) })
    } catch (err) {
      log.error('api', 'Failed to save the brief schedule', err)
      res.status(500).json({ error: 'Failed to save the brief schedule' })
    }
  })

  return router
}
