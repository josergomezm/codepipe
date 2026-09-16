import { Router } from 'express'

import type { IStorageLayer } from '../storage.js'
import type { StandupService } from '../standup.js'
import { CreateTodoRequestSchema, UpdateTodoRequestSchema, RefineProposalRequestSchema } from '../schemas.js'
import { log } from '../logger.js'

/**
 * Create an Express Router for the per-project todo/ideas list.
 */
export function createTodoRoutes(storage: IStorageLayer, standup?: StandupService): Router {
  const router = Router()

  // POST /api/todos/:id/refine — send feedback on the proposal to the team
  // thread; they revise and the router upserts the updated proposal. 202 at
  // dispatch; the revision arrives via events + a persona push.
  router.post('/:id/refine', async (req, res) => {
    if (!standup) {
      res.status(503).json({ error: 'Team service not available' })
      return
    }
    const parsed = RefineProposalRequestSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.format() })
      return
    }
    try {
      const result = await standup.refineProposal(req.params.id, parsed.data.feedback)
      res.status(result.ran ? 202 : 409).json(result)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Refinement failed'
      if (message.includes('not found')) {
        res.status(404).json({ error: message })
        return
      }
      log.error('api', `Refine dispatch failed for todo ${req.params.id}`, err)
      res.status(500).json({ error: message })
    }
  })

  // POST /api/todos/:id/implement — approve the proposal and spawn a work
  // session for it. Responds as soon as the turn is dispatched (202); the
  // session id lets the client jump straight into the live implementation.
  router.post('/:id/implement', async (req, res) => {
    if (!standup) {
      res.status(503).json({ error: 'Implementation service not available' })
      return
    }
    try {
      const result = await standup.implementProposal(req.params.id)
      res.status(result.ran ? 202 : 409).json(result)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Implementation failed'
      if (message.includes('not found')) {
        res.status(404).json({ error: message })
        return
      }
      log.error('api', `Implementation dispatch failed for todo ${req.params.id}`, err)
      res.status(500).json({ error: message })
    }
  })

  // GET /api/todos?projectId=<id> — list todos (all, or one project's)
  router.get('/', async (req, res) => {
    const projectId = typeof req.query.projectId === 'string' ? req.query.projectId : undefined
    try {
      const todos = await storage.listTodos(projectId)
      todos.sort((a, b) => b.updatedAt - a.updatedAt)
      res.json(todos)
    } catch (err) {
      log.error('api', 'Failed to list todos', err)
      res.status(500).json({ error: 'Failed to list todos' })
    }
  })

  // POST /api/todos — add a todo
  router.post('/', async (req, res) => {
    const parsed = CreateTodoRequestSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.format() })
      return
    }

    try {
      const project = await storage.getProject(parsed.data.projectId)
      if (!project) {
        res.status(404).json({ error: 'Project not found' })
        return
      }
      const todo = await storage.addTodo(parsed.data)
      res.status(201).json(todo)
    } catch (err) {
      log.error('api', 'Failed to add todo', err)
      res.status(500).json({ error: 'Failed to add todo' })
    }
  })

  // PATCH /api/todos/:id — edit text/notes/status
  router.patch('/:id', async (req, res) => {
    const parsed = UpdateTodoRequestSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.format() })
      return
    }

    try {
      const todo = await storage.updateTodo(req.params.id, parsed.data)
      res.json(todo)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to update todo'
      if (message.includes('not found')) {
        res.status(404).json({ error: message })
        return
      }
      log.error('api', `Failed to update todo ${req.params.id}`, err)
      res.status(500).json({ error: 'Failed to update todo' })
    }
  })

  // DELETE /api/todos/:id — linked action items survive but lose the link
  router.delete('/:id', async (req, res) => {
    try {
      await storage.removeTodo(req.params.id)
      await storage.unlinkActionItemsFromTodo(req.params.id)
      res.json({ ok: true })
    } catch (err) {
      log.error('api', `Failed to delete todo ${req.params.id}`, err)
      res.status(500).json({ error: 'Failed to delete todo' })
    }
  })

  return router
}
