/**
 * The proactive team layer ("standup") — the orchestrator.
 *
 * Rework note: standups are EPHEMERAL. There is no persistent team thread —
 * each run is a review pipeline over fresh, bounded contexts, and all
 * continuity lives in explicit state (the board, takes, the memo, the
 * agenda) rather than in a resumed conversation's history:
 *
 *   scheduler / manual run
 *     → fan-out: one throwaway read-only session per reviewer per new idea,
 *       each producing an independent `take` (stored on the todo, session
 *       deleted — the take is the artifact)
 *     → fan-in: one dated 'team' session where the lead synthesizes takes +
 *       agenda + memo into messages, proposals/briefs, user actions, and the
 *       next memo (this is the session the user watches and replies to)
 *
 * Events between standups (resolved action items, shipped builds) queue on
 * the agenda and are acknowledged by the next run — one turn amortizes them
 * all instead of a CLI turn each.
 */

import { createHash } from 'crypto'

import type { IStorageLayer } from './storage.js'
import type { SessionManager } from './session-manager.js'
import type { PushService } from './push.js'
import { PersonaRouter } from './persona-router.js'
import {
  buildStandupPrompt,
  buildReviewerPrompt,
  buildImplementPrompt,
  buildRefinePrompt,
  parseReviewerOutput,
  trackedActions,
} from './standup-protocol.js'
import type { ActionItem, Persona, Project, Todo, TodoTake } from './schemas.js'
import { log } from './logger.js'

/** How often the scheduler checks whether a standup is due. */
const SCHEDULER_TICK_MS = 60_000

/** How long the synthesis turn may run before it is cancelled. */
const STANDUP_TIMEOUT_MS = 15 * 60 * 1000

/** How long a single reviewer turn may run before it is cancelled. */
const REVIEW_TIMEOUT_MS = 10 * 60 * 1000

/** How long an implementation turn may run before it is cancelled. */
const WORK_TIMEOUT_MS = 60 * 60 * 1000

/** Todo statuses the team is asked to work on. */
const ACTIONABLE_STATUSES = new Set(['inbox', 'under_review'])

export interface StandupRunResult {
  /** True when a standup turn was dispatched (it completes in the background). */
  ran: boolean
  reason?: string
  sessionId?: string
}

export function isSameLocalDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  )
}

/**
 * Whether a project's scheduled standup is due. Catch-up semantics: due once
 * the configured hour has PASSED for the day (not only during that hour), so
 * a machine that was asleep at 9 AM runs its 9 AM standup on wake instead of
 * silently skipping the day. The lastRunAt same-day gate keeps it to one
 * dispatch per day regardless of how many ticks see it as due.
 */
export function isStandupDue(
  config: { enabled: boolean; hour: number },
  lastRunAt: number | undefined,
  now: Date,
): boolean {
  if (!config.enabled) return false
  if (now.getHours() < config.hour) return false
  return !lastRunAt || !isSameLocalDay(new Date(lastRunAt), now)
}

/**
 * Stable hash of the actionable todo list, for the unchanged-list gate.
 * Content-only (id/text/notes): status transitions the standup itself causes
 * (inbox → under_review) must not make the list look "changed" the next day.
 */
export function hashTodos(todos: Todo[]): string {
  const canonical = [...todos]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((t) => ({ id: t.id, text: t.text, notes: t.notes ?? '' }))
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex')
}

/** "Sep 2"-style label for dated standup session titles. */
function dayLabel(d: Date): string {
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

export class StandupService {
  private readonly storage: IStorageLayer
  private readonly sessionManager: SessionManager
  private readonly router: PersonaRouter
  private timer: ReturnType<typeof setInterval> | null = null
  /** Projects with a standup currently in flight (re-entry guard). */
  private readonly running = new Set<string>()

  constructor(storage: IStorageLayer, sessionManager: SessionManager, push?: PushService) {
    this.storage = storage
    this.sessionManager = sessionManager
    this.router = new PersonaRouter(storage, sessionManager, push)

    // Register immediately (not in start()) so user replies in standup
    // sessions are persona-routed even when the scheduler isn't running.
    this.sessionManager.onTeamTurn = (session, last) => {
      if (last) void this.router.routeTeamTurn(session, last)
    }
  }

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  start(): void {
    this.timer = setInterval(() => {
      void this.checkSchedule()
    }, SCHEDULER_TICK_MS)
    this.timer.unref?.()
    log.info('standup', 'Standup scheduler started')
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  // -----------------------------------------------------------------------
  // Scheduler
  // -----------------------------------------------------------------------

  private async checkSchedule(): Promise<void> {
    let projects: Project[]
    try {
      projects = await this.storage.listProjects()
    } catch (err) {
      log.error('standup', 'Failed to list projects for schedule check', err)
      return
    }

    const now = new Date()
    for (const project of projects) {
      if (!project.standup) continue

      const state = await this.storage.getStandupState(project.id)
      if (!isStandupDue(project.standup, state?.lastRunAt, now)) continue

      log.info('standup', `Scheduled standup due for project "${project.name}"`)
      void this.runStandup(project.id, { force: false }).catch((err) => {
        log.error('standup', `Scheduled standup failed for project ${project.id}`, err)
      })
    }
  }

  // -----------------------------------------------------------------------
  // Running a standup
  // -----------------------------------------------------------------------

  /**
   * Start a standup for one project. Gates and session setup run inline (so
   * the caller gets an immediate started/skipped answer); the review
   * pipeline and synthesis turn run in the background — results arrive via
   * the onTeamTurn hook and persona push notifications. `force` (the manual
   * "run now" button) bypasses the nothing-new gate but never double-runs.
   */
  async runStandup(projectId: string, opts: { force: boolean }): Promise<StandupRunResult> {
    if (this.running.has(projectId)) {
      return { ran: false, reason: 'A standup is already running for this project' }
    }

    const project = await this.storage.getProject(projectId)
    if (!project) throw new Error('Project not found')

    const personas = await this.storage.listPersonas()
    if (personas.length === 0) {
      return { ran: false, reason: 'No personas configured — add your team in Team settings first' }
    }
    const lead = personas.find((p) => p.isLead) ?? personas[0]

    const todos = (await this.storage.listTodos(projectId)).filter((t) =>
      ACTIONABLE_STATUSES.has(t.status),
    )

    // Nothing-new gate: skip when the ideas are unchanged AND there is no
    // agenda to acknowledge.
    const hash = hashTodos(todos)
    const state = (await this.storage.getStandupState(projectId)) ?? { projectId }
    const agenda = state.agenda ?? []
    if (!opts.force && agenda.length === 0) {
      if (todos.length === 0) {
        return { ran: false, reason: 'No open todos — nothing to review' }
      }
      if (state.lastHash === hash) {
        return { ran: false, reason: 'Todo list unchanged since the last standup' }
      }
    }

    this.running.add(projectId)
    try {
      // The dated synthesis session exists from the start so the user can
      // jump in and watch the run land.
      const session = await this.sessionManager.createSession(lead.provider, project.id, {
        kind: 'team',
        title: `${project.name} standup · ${dayLabel(new Date())}`,
        ...(lead.model ? { model: lead.model } : {}),
      })

      // Persist state BEFORE the pipeline: lastRunAt/lastHash stop the
      // scheduler from re-dispatching after a failure (manual run is the
      // retry path), and the agenda is consumed at dispatch.
      state.teamSessionId = session.id
      state.lastRunAt = Date.now()
      state.lastHash = hash
      state.agenda = []
      await this.storage.setStandupState(state)

      // Mark the todos as picked up before the turn so the UI reflects it.
      for (const todo of todos) {
        if (todo.status === 'inbox') {
          await this.storage.updateTodo(todo.id, { status: 'under_review' })
        }
      }

      log.info('standup', `Standup dispatched for "${project.name}" (${todos.length} todo(s), ${agenda.length} agenda item(s), session ${session.id})`)
      void this.executeStandupPipeline(project, personas, lead, todos, state.memo, agenda, session.id)

      return { ran: true, sessionId: session.id }
    } catch (err) {
      this.running.delete(projectId)
      throw err
    }
  }

  /**
   * The background half of a standup: sequential reviewer fan-out (fresh
   * context per reviewer per idea, takes stored on the todos), then the
   * lead's synthesis turn in the dated session.
   */
  private async executeStandupPipeline(
    project: Project,
    personas: Persona[],
    lead: Persona,
    todos: Todo[],
    memo: string | undefined,
    agenda: string[],
    sessionId: string,
  ): Promise<void> {
    try {
      const reviewers = personas.filter((p) => p.id !== lead.id)

      if (reviewers.length > 0 && todos.length > 0) {
        this.sessionManager.appendSystemMessage(
          sessionId,
          `Reviewing ${todos.length} idea(s): ${reviewers.map((r) => r.name).join(', ')} are taking independent looks…`,
        )
        for (const todo of todos) {
          const takes: TodoTake[] = []
          for (const reviewer of reviewers) {
            const take = await this.reviewTodo(project, reviewer, todo)
            if (take) takes.push(take)
          }
          if (takes.length > 0) {
            await this.storage.updateTodo(todo.id, { takes }).catch((err) => {
              log.warn('standup', `Failed to store takes for todo ${todo.id}: ${err instanceof Error ? err.message : String(err)}`)
            })
          }
        }
      }

      // Re-read so the synthesis prompt carries the freshly stored takes.
      const reviewed = (await this.storage.listTodos(project.id)).filter((t) =>
        todos.some((original) => original.id === t.id),
      )
      const actions = trackedActions(await this.storage.listActionItems(project.id))
      // Planned ideas without a build session: the ones that can silently
      // ship outside CodePipe and sit on the board forever.
      const planned = (await this.storage.listTodos(project.id)).filter(
        (t) => (t.status === 'proposed' || t.status === 'approved') && !t.workSessionId,
      )
      const prompt = buildStandupPrompt(project, personas, reviewed, { memo, agenda, actions, planned })
      await this.sessionManager.runTurn(sessionId, prompt, {
        timeoutMs: STANDUP_TIMEOUT_MS,
        cancelOnTimeout: true,
        internalPrompt: true,
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log.error('standup', `Standup pipeline failed for project ${project.id}: ${message}`)
      this.sessionManager.appendSystemMessage(
        sessionId,
        `Standup failed: ${message}. Run it again from the project's Ideas panel.`,
      )
    } finally {
      this.running.delete(project.id)
    }
  }

  /**
   * One reviewer, one idea, one throwaway read-only session. The take is
   * harvested and the session deleted — ephemeral compute, durable artifact.
   */
  private async reviewTodo(
    project: Project,
    reviewer: Persona,
    todo: Todo,
  ): Promise<TodoTake | null> {
    let sessionId: string | null = null
    try {
      const session = await this.sessionManager.createSession(reviewer.provider, project.id, {
        kind: 'review',
        title: `${reviewer.name} review`,
        ...(reviewer.model ? { model: reviewer.model } : {}),
      })
      sessionId = session.id

      const result = await this.sessionManager.runTurn(
        session.id,
        buildReviewerPrompt(project, reviewer, todo),
        { timeoutMs: REVIEW_TIMEOUT_MS, cancelOnTimeout: true, internalPrompt: true },
      )
      if (!result) return null

      const output = parseReviewerOutput(result.content)
      return {
        personaId: reviewer.id,
        take: output.take.slice(0, 2000),
        ...(output.concerns?.length
          ? { concerns: output.concerns.slice(0, 8).map((c) => c.slice(0, 500)) }
          : {}),
        ...(output.effort ? { effort: output.effort.slice(0, 200) } : {}),
        createdAt: Date.now(),
      }
    } catch (err) {
      log.warn('standup', `Reviewer ${reviewer.name} failed on todo ${todo.id}: ${err instanceof Error ? err.message : String(err)}`)
      return null
    } finally {
      if (sessionId) {
        await this.sessionManager.deleteSession(sessionId).catch(() => {})
      }
    }
  }

  // -----------------------------------------------------------------------
  // Agenda (events acknowledged by the next standup — no per-event turns)
  // -----------------------------------------------------------------------

  /** Queue an event for the next standup to acknowledge. */
  async queueAgenda(projectId: string, entry: string): Promise<void> {
    const state = (await this.storage.getStandupState(projectId)) ?? { projectId }
    const agenda = state.agenda ?? []
    agenda.push(entry.slice(0, 1000))
    state.agenda = agenda.slice(-30)
    await this.storage.setStandupState(state)
  }

  /**
   * The user resolved a team-raised action item. Queued for the next
   * standup's agenda — the team acknowledges it there, standup-style,
   * instead of spending a CLI turn per checkbox. An answered decision
   * carries the answer, plus the options the team offered so a terse reply
   * ("go with your recommendation") still makes sense to a fresh standup.
   * A dismissal carries the user's reason.
   */
  async notifyActionResolved(item: ActionItem): Promise<void> {
    const resolution = item.resolution?.trim()
    if (item.status === 'dismissed') {
      await this.queueAgenda(
        item.projectId,
        `The user declined "${item.text}" (won't do)${resolution ? `: ${resolution}` : ''} — don't raise it again.`,
      )
      return
    }
    if (!resolution) {
      await this.queueAgenda(item.projectId, `The user completed the action item: "${item.text}"`)
      return
    }
    const offered = item.options?.length
      ? item.options.map((o) => `${o.label}${o.recommended ? ' (your recommendation)' : ''}`).join('; ')
      : item.notes?.trim()
    const context = offered ? `\n  (What you had offered: ${offered})` : ''
    await this.queueAgenda(
      item.projectId,
      `The user answered "${item.text}": ${resolution}${context}`,
    )
  }

  // -----------------------------------------------------------------------
  // Refine a proposal from user feedback
  // -----------------------------------------------------------------------

  /**
   * Send the user's feedback on a proposal into a standup session — today's
   * if it is still live, else a fresh dated one. The team revises and
   * re-emits the proposal with the same todoId, which the persona router
   * upserts onto the todo.
   */
  async refineProposal(todoId: string, feedback: string): Promise<StandupRunResult> {
    const todo = (await this.storage.listTodos()).find((t) => t.id === todoId)
    if (!todo) throw new Error('Todo not found')
    if (!todo.proposal) {
      return { ran: false, reason: 'This idea has no proposal to refine yet' }
    }
    if (todo.status === 'done') {
      return { ran: false, reason: 'This idea is already done' }
    }

    const project = await this.storage.getProject(todo.projectId)
    if (!project) throw new Error('Project not found')
    const personas = await this.storage.listPersonas()
    if (personas.length === 0) {
      return { ran: false, reason: 'No personas configured — add your team in Team settings first' }
    }
    const lead = personas.find((p) => p.isLead) ?? personas[0]

    const state = (await this.storage.getStandupState(todo.projectId)) ?? { projectId: todo.projectId }
    let session = state.teamSessionId ? this.sessionManager.getSession(state.teamSessionId) : undefined
    if (!session || session.status !== 'live') {
      session = await this.sessionManager.createSession(lead.provider, project.id, {
        kind: 'team',
        title: `${project.name} standup · ${dayLabel(new Date())}`,
        ...(lead.model ? { model: lead.model } : {}),
      })
      state.teamSessionId = session.id
      await this.storage.setStandupState(state)
    }

    const sessionId = session.id
    const prompt = buildRefinePrompt(todo, personas, feedback)
    log.info('standup', `Proposal refinement dispatched for "${todo.text}" (session ${sessionId})`)
    void this.sessionManager
      .runTurn(sessionId, prompt, {
        timeoutMs: STANDUP_TIMEOUT_MS,
        cancelOnTimeout: true,
        internalPrompt: true,
      })
      .catch((err) => {
        log.warn('standup', `Refine turn failed: ${err instanceof Error ? err.message : String(err)}`)
        this.sessionManager.appendSystemMessage(
          sessionId,
          `Proposal refinement failed: ${err instanceof Error ? err.message : String(err)}. Send your feedback again from the Ideas panel.`,
        )
      })

    return { ran: true, sessionId }
  }

  // -----------------------------------------------------------------------
  // Approve → implement
  // -----------------------------------------------------------------------

  /**
   * Spawn an implementation ('work') session for a proposed/approved idea and
   * dispatch the work as a background turn. The session runs on the PROPOSING
   * persona's provider/model and appears in the sidebar like any chat — the
   * user can open it and watch, or interject. On success the idea moves to
   * Done and the completion joins the next standup's agenda; on failure the
   * work-session link is cleared so the idea can be re-dispatched.
   */
  async implementProposal(todoId: string): Promise<StandupRunResult> {
    const todo = (await this.storage.listTodos()).find((t) => t.id === todoId)
    if (!todo) throw new Error('Todo not found')
    if (!todo.proposal) {
      return { ran: false, reason: 'This idea has no proposal yet — run a standup first' }
    }
    if (todo.status === 'done') {
      return { ran: false, reason: 'This idea is already done' }
    }
    if (todo.workSessionId) {
      return {
        ran: false,
        reason: 'An implementation session already exists for this idea',
        sessionId: todo.workSessionId,
      }
    }

    const project = await this.storage.getProject(todo.projectId)
    if (!project) throw new Error('Project not found')

    const personas = await this.storage.listPersonas()
    if (personas.length === 0) {
      return { ran: false, reason: 'No personas configured — add your team in Team settings first' }
    }
    const lead = personas.find((p) => p.isLead) ?? personas[0]
    const implementer =
      (todo.proposal.personaId
        ? personas.find((p) => p.id === todo.proposal!.personaId)
        : null) ?? lead

    const title = todo.text.length > 44 ? `${todo.text.slice(0, 44)}…` : todo.text
    const session = await this.sessionManager.createSession(implementer.provider, project.id, {
      kind: 'work',
      title: `${implementer.name}: ${title}`,
      ...(implementer.model ? { model: implementer.model } : {}),
    })

    // Approving and linking are persisted BEFORE the turn, mirroring the
    // standup dispatch: state must survive a failed run.
    await this.storage.updateTodo(todo.id, { status: 'approved', workSessionId: session.id })

    const prompt = buildImplementPrompt(project, implementer, todo)
    log.info('standup', `Implementation dispatched for "${todo.text}" (${implementer.name} on ${implementer.provider}, session ${session.id})`)
    void this.executeWorkTurn(todo.id, session.id, implementer, prompt)

    return { ran: true, sessionId: session.id }
  }

  /** The background half of an implementation: drive the turn, then close the loop. */
  private async executeWorkTurn(
    todoId: string,
    sessionId: string,
    implementer: Persona,
    prompt: string,
  ): Promise<void> {
    try {
      const result = await this.sessionManager.runTurn(sessionId, prompt, {
        timeoutMs: WORK_TIMEOUT_MS,
        cancelOnTimeout: true,
        internalPrompt: true,
      })

      // Success: the idea ships (completedAt is stamped by storage), and the
      // completion joins the next standup's agenda. The user is notified by
      // the work session's own turn-complete push; the user can always
      // reopen from the board if the result doesn't hold up.
      const todo = await this.storage.updateTodo(todoId, { status: 'done' })
      const summary = result ? result.content.replace(/\s+/g, ' ').slice(0, 300) : '(no summary)'
      await this.queueAgenda(
        todo.projectId,
        `${implementer.name} shipped "${todo.text}" in a work session. Closing summary: ${summary}`,
      )
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log.error('standup', `Implementation turn failed for todo ${todoId}: ${message}`)
      this.sessionManager.appendSystemMessage(
        sessionId,
        `Implementation failed: ${message}. The idea stays on the board — approve it again to retry, or continue here by hand.`,
      )
      // Unlink so the idea can be re-dispatched (this session stays as history).
      await this.storage
        .updateTodo(todoId, { workSessionId: undefined })
        .catch((e) => log.warn('standup', `Failed to unlink work session: ${e instanceof Error ? e.message : String(e)}`))
    }
  }
}
