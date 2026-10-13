import { Router } from 'express'

import type { IStorageLayer } from '../storage.js'
import type { StandupService } from '../standup.js'
import { CreateActionItemRequestSchema, UpdateActionItemRequestSchema } from '../schemas.js'
import { log } from '../logger.js'
import { buildActionItemsCalendar } from '../action-calendar.js'
import { recordActionItem } from '../action-items.js'

/**
 * Create an Express Router for action items — tasks only the user can do
 * (secrets, accounts, purchases), raised by the team or added manually.
 * When a team-raised item is completed, the standup service pings the team
 * thread so the resolution triggers a conversation.
 */
export function createActionRoutes(storage: IStorageLayer, standup?: StandupService): Router {
  const router = Router()

  // GET /api/actions?projectId=<id> — list action items (all, or one project's)
  router.get('/', async (req, res) => {
    const projectId = typeof req.query.projectId === 'string' ? req.query.projectId : undefined
    try {
      const items = await storage.listActionItems(projectId)
      // Open items first, newest activity first within each group.
      items.sort((a, b) =>
        a.status === b.status ? b.updatedAt - a.updatedAt : a.status === 'open' ? -1 : 1,
      )
      res.json(items)
    } catch (err) {
      log.error('api', 'Failed to list action items', err)
      res.status(500).json({ error: 'Failed to list action items' })
    }
  })

  // GET /api/actions/calendar.ics?projectId=<id> — open tasks with deadlines
  // as an importable calendar (stable UIDs: re-importing doesn't duplicate)
  router.get('/calendar.ics', async (req, res) => {
    const projectId = typeof req.query.projectId === 'string' ? req.query.projectId : undefined
    try {
      const [items, projects] = await Promise.all([storage.listActionItems(projectId), storage.listProjects()])
      res
        .type('text/calendar; charset=utf-8')
        .attachment('codepipe-tasks.ics')
        .send(buildActionItemsCalendar(items, projects))
    } catch (err) {
      log.error('api', 'Failed to export action items calendar', err)
      res.status(500).json({ error: 'Failed to export calendar' })
    }
  })

  // POST /api/actions — add an action item manually (an identical open item
  // is returned instead of duplicated)
  router.post('/', async (req, res) => {
    const parsed = CreateActionItemRequestSchema.safeParse(req.body)
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
      const { projectId, ...draft } = parsed.data
      const result = await recordActionItem(storage, projectId, draft)
      if (result.status === 'over_cap') throw new Error('Unexpected cap on a manual item')
      res.status(result.status === 'added' ? 201 : 200).json(result.item)
    } catch (err) {
      log.error('api', 'Failed to add action item', err)
      res.status(500).json({ error: 'Failed to add action item' })
    }
  })

  // PATCH /api/actions/:id — edit text/notes, resolve (done + answer),
  // dismiss (won't do + reason), reopen, snooze/un-snooze, or set/clear the deadline
  router.patch('/:id', async (req, res) => {
    const parsed = UpdateActionItemRequestSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.format() })
      return
    }

    try {
      const before = (await storage.listActionItems()).find((a) => a.id === req.params.id)
      // null un-snoozes / clears the deadline: an undefined key is dropped
      // when the file is written.
      const { snoozedUntil, dueDate, ...rest } = parsed.data
      const item = await storage.updateActionItem(req.params.id, {
        ...rest,
        ...(snoozedUntil !== undefined ? { snoozedUntil: snoozedUntil ?? undefined } : {}),
        ...(dueDate !== undefined ? { dueDate: dueDate ?? undefined } : {}),
      })
      res.json(item)

      // Closing a team-raised item (answered, done, or declined) is news the
      // team should react to.
      if (standup && item.personaId && before?.status === 'open' && item.status !== 'open') {
        standup.notifyActionResolved(item).catch((err) => {
          log.warn('api', `Action-resolved notification failed: ${err instanceof Error ? err.message : String(err)}`)
        })
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to update action item'
      if (message.includes('not found')) {
        res.status(404).json({ error: message })
        return
      }
      log.error('api', `Failed to update action item ${req.params.id}`, err)
      res.status(500).json({ error: 'Failed to update action item' })
    }
  })

  // DELETE /api/actions/:id
  router.delete('/:id', async (req, res) => {
    try {
      await storage.removeActionItem(req.params.id)
      res.json({ ok: true })
    } catch (err) {
      log.error('api', `Failed to delete action item ${req.params.id}`, err)
      res.status(500).json({ error: 'Failed to delete action item' })
    }
  })

  return router
}
