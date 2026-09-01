import { Router } from 'express'

import type { ISessionManager } from '../session-manager.js'
import type { IStorageLayer } from '../storage.js'
import { CreateSessionRequestSchema, RenameSessionRequestSchema, RunTurnRequestSchema } from '../schemas.js'
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

  // POST /api/sessions/:id/run — headless turn: send input, await the final
  // assistant message. This is the orchestration primitive: no WebSocket
  // client needed, the response is the turn's result.
  router.post('/:id/run', async (req, res) => {
    const { id } = req.params
    const parsed = RunTurnRequestSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.format() })
      return
    }

    try {
      const message = await sessionManager.runTurn(id, parsed.data.text, {
        ...(parsed.data.timeoutMs ? { timeoutMs: parsed.data.timeoutMs } : {}),
      })
      res.json({ message })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Turn failed'
      if (message.includes('not found')) {
        res.status(404).json({ error: message })
        return
      }
      if (message.includes('timed out')) {
        res.status(504).json({ error: message })
        return
      }
      log.error('api', `Headless run failed for session ${id}`, err)
      res.status(500).json({ error: message })
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

  // PATCH /api/sessions/:id — rename a session
  router.patch('/:id', async (req, res) => {
    const { id } = req.params
    const parsed = RenameSessionRequestSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.format() })
      return
    }

    try {
      // Update in-memory live session if present
      const liveSession = sessionManager.getSession(id)
      if (liveSession) {
        liveSession.title = parsed.data.title
      }
      // Persist to storage
      await storage.renameSession(id, parsed.data.title)
      res.json({ ok: true, title: parsed.data.title })
    } catch (err) {
      log.error('api', `Failed to rename session ${id}`, err)
      res.status(500).json({ error: 'Failed to rename session' })
    }
  })

  return router
}
