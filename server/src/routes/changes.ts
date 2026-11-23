import { Router } from 'express'
import type { IStorageLayer } from '../storage.js'
import { countChanges, getChanges, getFileDiff } from '../git-changes.js'
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

/**
 * Uncommitted file counts for every project, for the sidebar badges:
 * GET /api/change-counts → { counts: { [projectId]: number | null } }
 * (null = not a git repo).
 */
export function createChangeCountsRoutes(storage: IStorageLayer): Router {
  const router = Router()

  router.get('/', async (_req, res) => {
    try {
      // The internal Workspace folder lives inside CodePipe's own checkout —
      // its "changes" would be CodePipe's.
      const projects = (await storage.listProjects()).filter((p) => !p.internal)
      const entries = await Promise.all(projects.map(async (p) => [p.id, await countChanges(p.path)] as const))
      res.json({ counts: Object.fromEntries(entries) })
    } catch (err) {
      log.error('api', 'Failed to count project changes', err)
      res.status(500).json({ error: 'Failed to count changes' })
    }
  })

  return router
}
