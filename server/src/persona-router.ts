/**
 * The persona layer: turns a completed team turn into what the user sees.
 *
 * Given the final assistant message of a team-session turn, this parses the
 * protocol tail (see standup-protocol.ts) and applies its effects — tagging
 * the deliberation, posting persona-attributed messages, applying proposals
 * to todos, recording user action items (deduplicated) and closing the ones
 * the team reports as settled, and sending pushes
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
  matchById,
  normalizeActionText,
  trackedActions,
  MAX_OPEN_ACTIONS,
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

      // Persist the team's handoff note — the next standup's only memory.
      if (parsed.output.memo?.trim()) {
        const state = (await this.storage.getStandupState(session.projectId)) ?? {
          projectId: session.projectId,
        }
        state.memo = parsed.output.memo.trim().slice(0, 4000)
        await this.storage.setStandupState(state)
      }

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
            ...(proposal.brief ? { brief: proposal.brief } : {}),
            ...(byPersona ? { personaId: byPersona.id } : {}),
          },
        })
      }

      // Ideas the lead verified already shipped (built outside CodePipe's
      // implement flow) move to Done, and their open prerequisites go with
      // them. Visible in the thread with the evidence, so a wrong call is
      // easy to spot and reopen.
      const completedRefs = new Set<string>()
      for (const done of parsed.output.completed_todos ?? []) {
        const todo = matchTodo(todos.filter((t) => t.status !== 'done'), done.todoId)
        if (!todo) {
          log.warn('standup', `completed_todos references unknown/done todo "${done.todoId}" — skipping`)
          continue
        }
        completedRefs.add(todo.id)
        await this.storage.updateTodo(todo.id, { status: 'done' })
        this.sessionManager.appendSystemMessage(
          session.id,
          `Moved "${todo.text}" to Done — the team found it already implemented${done.evidence ? ` (${done.evidence})` : ''}.`,
        )
      }

      // Close tracked items the team reports as settled (answered in the
      // thread, or made moot) — and prerequisites of ideas that just
      // shipped. Only team-raised ones: the user's own manual items are
      // theirs to close. No agenda entry — the team already knows.
      if (parsed.output.resolved_actions?.length || completedRefs.size > 0) {
        const open = (await this.storage.listActionItems(session.projectId)).filter(
          (a) => a.status === 'open' && a.personaId,
        )
        for (const item of open.filter((a) => a.todoId && completedRefs.has(a.todoId))) {
          await this.storage.updateActionItem(item.id, { status: 'done' })
        }
        for (const ref of parsed.output.resolved_actions ?? []) {
          const item = matchById(open, ref)
          if (!item) {
            log.warn('standup', `resolved_actions references unknown/closed item "${ref}" — skipping`)
            continue
          }
          await this.storage.updateActionItem(item.id, { status: 'done' })
        }
      }

      // Record action items — things only the user can do. The prompt shows
      // the team what is already tracked, and this dedup is the backstop:
      // against open items AND recently resolved ones, so a fresh standup
      // can't re-raise what the user just did. The key includes the gated
      // idea: the same text may legitimately gate two different ideas.
      //
      // The queue is capped per project (team-raised items): past the cap
      // new items are discarded and the thread says so — the team was told
      // the limit, so this only bites when it ignores it.
      if (parsed.output.user_actions?.length) {
        const tracked = trackedActions(await this.storage.listActionItems(session.projectId))
        const dedupKey = (text: string, todoId: string | undefined) =>
          `${todoId ?? ''}:${normalizeActionText(text)}`
        const openKeys = new Set(tracked.map((a) => dedupKey(a.text, a.todoId)))
        let openCount = tracked.filter((a) => a.status === 'open' && a.personaId).length
        let overCap = 0
        for (const action of parsed.output.user_actions) {
          const byPersona = action.persona ? matchPersona(personas, action.persona) : null
          const gatedTodo = action.todoId ? matchTodo(todos, action.todoId) : null
          const key = dedupKey(action.text, gatedTodo?.id)
          if (openKeys.has(key)) continue
          if (openCount >= MAX_OPEN_ACTIONS) {
            overCap++
            continue
          }
          openKeys.add(key)
          openCount++
          // Trim to the schema's caps rather than dropping the whole item.
          const options = action.options
            ?.slice(0, 6)
            .map((o) => ({
              label: o.label.slice(0, 200),
              ...(o.detail ? { detail: o.detail.slice(0, 1000) } : {}),
              ...(o.recommended ? { recommended: true } : {}),
            }))
          await this.storage.addActionItem({
            projectId: session.projectId,
            text: action.text,
            ...(gatedTodo ? { todoId: gatedTodo.id } : {}),
            ...(action.notes ? { notes: action.notes } : {}),
            ...(action.kind ? { kind: action.kind } : {}),
            ...(action.steps?.length
              ? { steps: action.steps.slice(0, 12).map((s) => s.slice(0, 1000)) }
              : {}),
            ...(options?.length ? { options } : {}),
            ...(action.blocking === false ? { blocking: false } : {}),
            ...(action.dueDate ? { dueDate: action.dueDate } : {}),
            ...(byPersona ? { personaId: byPersona.id } : {}),
          })
        }
        if (overCap > 0) {
          log.warn('standup', `Discarded ${overCap} action item(s) over the ${MAX_OPEN_ACTIONS}-item cap for project ${session.projectId}`)
          this.sessionManager.appendSystemMessage(
            session.id,
            `The team raised ${overCap} more action item(s), but ${MAX_OPEN_ACTIONS} are already waiting on you — they were not added. Answering or declining waiting items makes room.`,
          )
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
