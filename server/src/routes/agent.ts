import { Router } from 'express'

import type { IStorageLayer } from '../storage.js'
import type { SessionManager } from '../session-manager.js'
import type { AgentToolService } from '../agent-tool-registry.js'
import {
  AgentToolCallRequestSchema,
  CardOpRequestSchema,
  type ChatActionCard,
  type ChatIdeaCard,
} from '../schemas.js'
import { recordActionItem } from '../action-items.js'
import { log } from '../logger.js'

/**
 * Routes behind CodePipe's agent tools, plus the user's side of what they
 * produce.
 *
 *   GET  /api/agent/sessions/:sessionId/tools
 *   POST /api/agent/sessions/:sessionId/tools/:name   { arguments }
 *     What the MCP server (mcp/codepipe-mcp.mjs) lists and forwards. The
 *     registry decides which tools a session gets; results are MCP-shaped.
 *
 *   POST /api/agent/sessions/:sessionId/messages/:messageId/card   { op }
 *     The user acting on a card a tool posted: accept or dismiss a suggested
 *     action item, undo an added one, reopen one the agent closed, or undo
 *     an added idea. Card state lives on the message, so it survives reloads.
 */
export function createAgentRoutes(
  storage: IStorageLayer,
  sessionManager: SessionManager,
  tools: AgentToolService,
): Router {
  const router = Router()

  router.get('/sessions/:sessionId/tools', (req, res) => {
    const session = sessionManager.getSession(req.params.sessionId)
    if (!session) {
      res.status(404).json({ error: 'This chat is not open in CodePipe' })
      return
    }
    res.json({ tools: tools.listTools(session) })
  })

  router.post('/sessions/:sessionId/tools/:name', async (req, res) => {
    const session = sessionManager.getSession(req.params.sessionId)
    if (!session) {
      res.status(404).json({ error: 'This chat is not open in CodePipe' })
      return
    }
    const parsed = AgentToolCallRequestSchema.safeParse(req.body ?? {})
    if (!parsed.success) {
      res.status(400).json({ error: 'Body must be { arguments: {...} }' })
      return
    }
    try {
      const result = await tools.call(session, req.params.name, parsed.data.arguments ?? {})
      res.json({ content: [{ type: 'text', text: result.text }], ...(result.isError ? { isError: true } : {}) })
    } catch (err) {
      log.error('api', `Agent tool ${req.params.name} failed for session ${session.id}`, err)
      res.status(500).json({ error: `${req.params.name} failed` })
    }
  })

  router.post('/sessions/:sessionId/messages/:messageId/card', async (req, res) => {
    const session = sessionManager.getSession(req.params.sessionId)
    const message = session?.messages.find((m) => m.id === req.params.messageId)
    const meta = message?.metadata
    const actionCard = meta?.kind === 'action' ? meta.action : undefined
    const ideaCard = meta?.kind === 'idea' ? meta.idea : undefined
    if (!session || !message || (!actionCard && !ideaCard)) {
      res.status(404).json({ error: 'Card not found' })
      return
    }
    const parsed = CardOpRequestSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.format() })
      return
    }
    const { op } = parsed.data

    try {
      if (ideaCard) {
        const next = await ideaCardOp(ideaCard, op)
        if ('error' in next) {
          res.status(409).json({ error: next.error })
          return
        }
        sessionManager.amendMessage(session.id, message.id, { metadata: { kind: 'idea', idea: next } })
        res.json(next)
        return
      }

      const next = await actionCardOp(actionCard!, op)
      if ('error' in next) {
        res.status(409).json({ error: next.error })
        return
      }
      sessionManager.amendMessage(session.id, message.id, { metadata: { kind: 'action', action: next } })
      res.json(next)
    } catch (err) {
      log.error('api', `Card ${op} failed for message ${message.id}`, err)
      res.status(500).json({ error: 'Failed to update the card' })
    }

    async function actionCardOp(card: ChatActionCard, op: 'accept' | 'dismiss' | 'undo'): Promise<ChatActionCard | { error: string }> {
      const item = card.itemId
        ? (await storage.listActionItems(session!.projectId)).find((a) => a.id === card.itemId)
        : undefined
      switch (op) {
        case 'accept': {
          if (card.state === 'added') return card
          if (card.state !== 'suggested' && card.state !== 'dismissed' && card.state !== 'undone') {
            return { error: 'Nothing to add' }
          }
          const result = await recordActionItem(storage, session!.projectId, card.draft)
          if (result.status === 'over_cap') return { error: 'Unexpected cap on a user-accepted item' }
          return { draft: card.draft, state: 'added', itemId: result.item.id }
        }
        case 'dismiss':
          if (card.state !== 'suggested') return { error: 'Only a suggestion can be dismissed' }
          return { draft: card.draft, state: 'dismissed' }
        case 'undo': {
          if (card.state === 'closed') {
            // Reopen what the agent closed (if it still exists and is closed).
            if (!item) return { error: 'That item no longer exists' }
            if (item.status === 'open') return { draft: card.draft, state: 'reopened', itemId: item.id }
            await storage.updateActionItem(item.id, { status: 'open', resolution: undefined })
            return { draft: card.draft, state: 'reopened', itemId: item.id }
          }
          if (card.state !== 'added' || !card.itemId) return { error: 'Nothing to undo' }
          if (item && item.status !== 'open') {
            return { error: 'That item is already closed — reopen or delete it from Action items' }
          }
          if (item) await storage.removeActionItem(item.id)
          return { draft: card.draft, state: 'undone' }
        }
      }
    }

    async function ideaCardOp(card: ChatIdeaCard, op: 'accept' | 'dismiss' | 'undo'): Promise<ChatIdeaCard | { error: string }> {
      if (op === 'undo') {
        if (card.state !== 'added' || !card.todoId) return { error: 'Nothing to undo' }
        const todo = (await storage.listTodos(session!.projectId)).find((t) => t.id === card.todoId)
        if (todo && todo.status !== 'inbox') {
          return { error: 'The team already picked this idea up — remove it from the Ideas board instead' }
        }
        if (todo) {
          await storage.removeTodo(todo.id)
          await storage.unlinkActionItemsFromTodo(todo.id)
        }
        return { text: card.text, ...(card.notes ? { notes: card.notes } : {}), state: 'undone' }
      }
      if (op === 'accept') {
        if (card.state === 'added') return card
        const todo = await storage.addTodo({
          projectId: session!.projectId,
          text: card.text,
          ...(card.notes ? { notes: card.notes } : {}),
        })
        return { text: card.text, ...(card.notes ? { notes: card.notes } : {}), state: 'added', todoId: todo.id }
      }
      return { error: 'An idea card cannot be dismissed' }
    }
  })

  return router
}
