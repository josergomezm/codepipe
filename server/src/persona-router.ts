/**
 * The persona layer: turns a completed team turn into what the user sees.
 *
 * The team acts through CodePipe's tools while it works (proposals, action
 * items, the memo — see agent-tool-registry.ts), so what's left to route is
 * the conversation itself: the turn's final reply is the lead speaking to
 * the user — attributed to them and pushed under their name and avatar —
 * and the narration before it (investigating, calling tools) is tagged as
 * deliberation, which the UI collapses behind a toggle.
 */

import type { SessionManager } from './session-manager.js'
import type { IStorageLayer } from './storage.js'
import type { PushService } from './push.js'
import { snippet } from './push.js'
import type { ChatMessage, Persona, Session } from './schemas.js'
import { log } from './logger.js'

export class PersonaRouter {
  private readonly storage: IStorageLayer
  private readonly sessionManager: SessionManager
  private readonly push: PushService | null

  constructor(storage: IStorageLayer, sessionManager: SessionManager, push?: PushService) {
    this.storage = storage
    this.sessionManager = sessionManager
    this.push = push ?? null
  }

  async routeTeamTurn(session: Session, last: ChatMessage): Promise<void> {
    try {
      const personas = await this.storage.listPersonas()
      if (personas.length === 0) return
      const lead = personas.find((p) => p.isLead) ?? personas[0]
      const project = await this.storage.getProject(session.projectId)

      // This turn = everything after the input that started it. Its earlier
      // assistant messages are the lead thinking out loud between tool calls.
      const messages = session.messages
      const lastIndex = messages.findIndex((m) => m.id === last.id)
      let start = lastIndex
      while (start > 0 && messages[start - 1].role !== 'user') start--
      for (const m of messages.slice(start, Math.max(lastIndex, start))) {
        if (m.role === 'assistant' && !m.metadata?.kind && !m.metadata?.personaId) {
          this.sessionManager.amendMessage(session.id, m.id, { metadata: { kind: 'deliberation' } })
        }
      }

      this.sessionManager.amendMessage(session.id, last.id, { metadata: { personaId: lead.id } })
      if (last.content.trim()) this.notifyPersona(lead, project?.name, last.content, session.id)
    } catch (err) {
      log.error('standup', `Failed to route team turn for session ${session.id}`, err)
    }
  }

  // ----- notifications -----

  private notifyPersona(
    persona: Persona,
    projectName: string | undefined,
    text: string,
    sessionId: string,
  ): void {
    if (!this.push?.isEnabled()) return
    const title = projectName ? `${persona.name} · ${projectName}` : persona.name
    void this.push.sendToAll({
      title,
      body: snippet(text),
      sessionId,
      // Tag per persona+session so one persona's messages collapse together
      // but different personas surface as separate notifications.
      tag: `${sessionId}:${persona.id}`,
      ...(persona.avatar ? { icon: `/api/avatars/${persona.avatar}` } : {}),
    })
  }
}
