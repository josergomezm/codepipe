/**
 * The persona layer: turns a completed team turn into what the user sees.
 *
 * Given the final assistant message of a team-session turn, this parses the
 * protocol tail (see standup-protocol.ts) and applies its effects — tagging
 * the deliberation, posting persona-attributed messages, applying proposals
 * to todos, recording user action items (deduplicated), and sending pushes
 * under each persona's name and avatar.
 *
 * Failure is a first-class state, not an exception path: when the tail
 * doesn't parse, the reply is attributed to the lead so the thread stays
 * coherent, and a consecutive-failure streak is persisted in standup state.
 * Past a threshold, one system message surfaces the degradation in the
 * thread — silent protocol drift is the one failure mode this layer refuses
 * to have.
 */

import type { SessionManager } from './session-manager.js'
import type { IStorageLayer } from './storage.js'
import type { PushService } from './push.js'
import { snippet } from './push.js'
import {
  parseStandupTail,
  matchPersona,
  matchTodo,
  normalizeActionText,
} from './standup-protocol.js'
import type { ChatMessage, Persona, Session } from './schemas.js'
import { log } from './logger.js'

/** Consecutive parse failures before the degradation is surfaced in-thread. */
const FAIL_STREAK_WARNING_THRESHOLD = 3

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

      const parsed = parseStandupTail(last.content)

      if (!parsed) {
        // The CLI didn't follow the protocol — attribute the raw reply to the
        // lead so the thread still reads as a person, and notify as them.
        this.sessionManager.amendMessage(session.id, last.id, {
          metadata: { personaId: lead.id },
        })
        this.notifyPersona(lead, project?.name, last.content, session.id)
        await this.recordProtocolFailure(session)
        return
      }

      await this.recordProtocolSuccess(session)

      // Tag the deliberation (raw discussion minus the JSON tail) so the UI
      // can collapse it behind a "transcript" toggle. An empty remainder (the
      // reply was pure JSON) is kept empty — the client hides those bubbles.
      this.sessionManager.amendMessage(session.id, last.id, {
        content: parsed.stripped,
        metadata: { kind: 'deliberation' },
      })

      // Apply proposals to todos.
      const todos = await this.storage.listTodos(session.projectId)
      for (const proposal of parsed.output.proposals ?? []) {
        const todo = matchTodo(todos, proposal.todoId)
        if (!todo) {
          log.warn('standup', `Proposal references unknown todo "${proposal.todoId}" — skipping`)
          continue
        }
        const byPersona = proposal.persona ? matchPersona(personas, proposal.persona) : null
        await this.storage.updateTodo(todo.id, {
          status: 'proposed',
          proposal: {
            summary: proposal.summary,
            approach: proposal.approach,
            ...(proposal.effort ? { effort: proposal.effort } : {}),
            ...(byPersona ? { personaId: byPersona.id } : {}),
          },
        })
      }

      // Record action items — things only the user can do. Dedup against
      // open items so recurring standups don't pile up duplicates.
      if (parsed.output.user_actions?.length) {
        const openItems = await this.storage.listActionItems(session.projectId)
        const openTexts = new Set(
          openItems.filter((a) => a.status === 'open').map((a) => normalizeActionText(a.text)),
        )
        for (const action of parsed.output.user_actions) {
          if (openTexts.has(normalizeActionText(action.text))) continue
          openTexts.add(normalizeActionText(action.text))
          const byPersona = action.persona ? matchPersona(personas, action.persona) : null
          await this.storage.addActionItem({
            projectId: session.projectId,
            text: action.text,
            ...(action.notes ? { notes: action.notes } : {}),
            ...(byPersona ? { personaId: byPersona.id } : {}),
          })
        }
      }

      // Post each outbound message as its persona, and push per persona.
      for (const message of parsed.output.messages) {
        const persona = matchPersona(personas, message.persona) ?? lead
        this.sessionManager.appendAssistantMessage(session.id, message.text, {
          personaId: persona.id,
        })
        this.notifyPersona(persona, project?.name, message.text, session.id)
      }
    } catch (err) {
      log.error('standup', `Failed to route team turn for session ${session.id}`, err)
    }
  }

  // ----- protocol health -----

  private async recordProtocolFailure(session: Session): Promise<void> {
    const state = (await this.storage.getStandupState(session.projectId)) ?? {
      projectId: session.projectId,
    }
    const streak = (state.protocolFailStreak ?? 0) + 1
    state.protocolFailStreak = streak
    await this.storage.setStandupState(state)
    log.warn('standup', `Team turn had no parseable protocol tail (streak: ${streak}) for session ${session.id}`)

    // Surface once when the streak crosses the threshold — not on every
    // failure, or the warning becomes the noise it's meant to prevent.
    if (streak === FAIL_STREAK_WARNING_THRESHOLD) {
      this.sessionManager.appendSystemMessage(
        session.id,
        `The team's structured output failed to parse ${streak} times in a row — replies are being attributed to the lead, and proposals/action items aren't being extracted. The CLI may have lost the protocol instructions; consider running a standup to restate them.`,
      )
    }
  }

  private async recordProtocolSuccess(session: Session): Promise<void> {
    const state = await this.storage.getStandupState(session.projectId)
    if (state?.protocolFailStreak) {
      state.protocolFailStreak = 0
      await this.storage.setStandupState(state)
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
