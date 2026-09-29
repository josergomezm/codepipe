import { Router } from 'express'
import type { IStorageLayer } from '../storage.js'
import { getChanges, getFileDiff } from '../git-changes.js'
import { log } from '../logger.js'

// TypeScript doesn't reflect mergeParams at the type level, so we cast params
// explicitly in each handler.
type P = { id: string }

/** Uncommitted git changes for a project: /api/projects/:id/changes */
export function createChangesRoutes(storage: IStorageLayer): Router {
  const router = Router({ mergeParams: true })

  // GET /api/projects/:id/changes — changed files with +/- counts
  router.get('/', async (req, res) => {
    const { id } = req.params as unknown as P
    try {
      const project = await storage.getProject(id)
      if (!project) { res.status(404).json({ error: 'Project not found' }); return }
      res.json(await getChanges(project.path))
    } catch (err) {
      log.error('api', `Failed to list changes for project ${id}`, err)
      res.status(500).json({ error: 'Failed to list changes' })
    }
  })

  // GET /api/projects/:id/changes/diff?path=<file> — unified diff for one file
  router.get('/diff', async (req, res) => {
    const { id } = req.params as unknown as P
    const path = req.query['path']
    if (typeof path !== 'string' || path.length === 0) {
      res.status(400).json({ error: 'path query parameter is required' })
      return
    }
    try {
      const project = await storage.getProject(id)
      if (!project) { res.status(404).json({ error: 'Project not found' }); return }
      const diff = await getFileDiff(project.path, path)
      if (!diff) { res.status(404).json({ error: 'File has no uncommitted changes' }); return }
      res.json(diff)
    } catch (err) {
      log.error('api', `Failed to diff ${path} for project ${id}`, err)
      res.status(500).json({ error: 'Failed to load diff' })
    }
  })

  return router
}
