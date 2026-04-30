import { Router } from 'express'
import { existsSync } from 'fs'
import path from 'path'

import type { IStorageLayer } from '../storage.js'
import { CreateProjectRequestSchema } from '../schemas.js'
import { log } from '../logger.js'

/**
 * Create an Express Router for project CRUD endpoints.
 */
export function createProjectRoutes(storage: IStorageLayer): Router {
  const router = Router()

  // GET /api/projects — list all projects
  router.get('/', async (_req, res) => {
    try {
      const projects = await storage.listProjects()
      res.json(projects)
    } catch (err) {
      log.error('api', 'Failed to list projects', err)
      res.status(500).json({ error: 'Failed to list projects' })
    }
  })

  // POST /api/projects — add a project
  router.post('/', async (req, res) => {
    const parsed = CreateProjectRequestSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.format() })
      return
    }

    const { name, path: projectPath } = parsed.data

    // Path traversal check: reject paths containing '..'
    if (projectPath.includes('..')) {
      res.status(400).json({ error: 'Path must not contain ".."' })
      return
    }

    // Validate path is absolute (works on both POSIX and Windows)
    if (!path.isAbsolute(projectPath)) {
      res.status(400).json({ error: 'Path must be absolute' })
      return
    }

    // Validate path exists on disk
    if (!existsSync(projectPath)) {
      res.status(400).json({ error: 'Path does not exist on disk' })
      return
    }

    try {
      const project = await storage.addProject({ name, path: projectPath })
      res.status(201).json(project)
    } catch (err) {
      log.error('api', 'Failed to add project', err)
      res.status(500).json({ error: 'Failed to add project' })
    }
  })

  // DELETE /api/projects/:id — remove a project
  router.delete('/:id', async (req, res) => {
    const { id } = req.params

    try {
      const project = await storage.getProject(id)
      if (!project) {
        res.status(404).json({ error: 'Project not found' })
        return
      }

      await storage.removeProject(id)
      res.json({ ok: true })
    } catch (err) {
      log.error('api', `Failed to remove project ${id}`, err)
      res.status(500).json({ error: 'Failed to remove project' })
    }
  })

  return router
}
