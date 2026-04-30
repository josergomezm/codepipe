import { Router } from 'express'

import type { ISessionManager } from '../session-manager.js'
import type { IStorageLayer } from '../storage.js'
import { CreateSessionRequestSchema } from '../schemas.js'
import type { SessionMeta } from '../schemas.js'
import { log } from '../logger.js'

/**
 * Create an Express Router for session CRUD endpoints.
 */
export function createSessionRoutes(
  sessionManager: ISessionManager,
  storage: IStorageLayer,
): Router {
  const router = Router()

  // GET /api/sessions — list all sessions (live + archived), sorted by updatedAt desc
  router.get('/', async (_req, res) => {
    try {
      // Get live sessions from SessionManager
      const liveMetas = sessionManager.listSessions()
      const liveIds = new Set(liveMetas.map((m) => m.id))

      // Get archived sessions from storage
      const storedMetas = await storage.listSessions()

      // Merge: live sessions take precedence, add archived ones that aren't live
      const merged: SessionMeta[] = [...liveMetas]
      for (const stored of storedMetas) {
        if (!liveIds.has(stored.id)) {
          merged.push(stored)
        }
      }

      // Sort by updatedAt descending
      merged.sort((a, b) => b.updatedAt - a.updatedAt)

      res.json(merged)
    } catch (err) {
      log.error('api', 'Failed to list sessions', err)
      res.status(500).json({ error: 'Failed to list sessions' })
    }
  })

  // POST /api/sessions — create a new session
  router.post('/', async (req, res) => {
    const parsed = CreateSessionRequestSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.format() })
      return
    }

    try {
      const session = await sessionManager.createSession(
        parsed.data.provider,
        parsed.data.projectId,
      )
      res.status(201).json(session)
    } catch (err) {
      log.error('api', 'Session creation failed', err)
      const message = err instanceof Error ? err.message : 'Failed to create session'
      res.status(400).json({ error: message })
    }
  })

  // GET /api/sessions/:id — get session detail (with messages)
  router.get('/:id', async (req, res) => {
    const { id } = req.params

    // Check live sessions first
    const liveSession = sessionManager.getSession(id)
    if (liveSession) {
      res.json(liveSession)
      return
    }

    // Fall back to storage
    try {
      const storedSession = await storage.getSession(id)
      if (storedSession) {
        res.json(storedSession)
        return
      }

      res.status(404).json({ error: 'Session not found' })
    } catch (err) {
      log.error('api', `Failed to get session ${id}`, err)
      res.status(500).json({ error: 'Failed to get session' })
    }
  })

  // DELETE /api/sessions/:id
  router.delete('/:id', async (req, res) => {
    const { id } = req.params

    try {
      await sessionManager.deleteSession(id)
      res.json({ ok: true })
    } catch (err) {
      log.error('api', `Failed to delete session ${id}`, err)
      res.status(500).json({ error: 'Failed to delete session' })
    }
  })

  return router
}
