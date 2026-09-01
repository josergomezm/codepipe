/**
 * The proactive team layer ("standup") — the orchestrator.
 *
 * Composed from three single-purpose parts:
 *   - standup-protocol.ts — the prompt/JSON contract with the CLI (pure)
 *   - team-session.ts     — which session a team turn runs on (lifecycle)
 *   - persona-router.ts   — what happens to a completed team turn (effects)
 *
 * This service owns only scheduling and dispatch: WHEN a standup runs (daily
 * gate + unchanged-todos gate), kicking off the background turn, and pinging
 * the team when the user resolves an action item. Turn results never come
 * back here — the session manager's onTeamTurn hook feeds every completed
 * team turn (standup or user reply alike) to the PersonaRouter.
 */

import { createHash } from 'crypto'

import type { IStorageLayer } from './storage.js'
import type { SessionManager } from './session-manager.js'
import type { PushService } from './push.js'
import { TeamSessionManager } from './team-session.js'
import { PersonaRouter } from './persona-router.js'
import { buildStandupPrompt, buildImplementPrompt, buildWorkCompletePrompt } from './standup-protocol.js'
import type { ActionItem, ChatMessage, Persona, Project, Todo } from './schemas.js'
import { log } from './logger.js'

/** How often the scheduler checks whether a standup is due. */
const SCHEDULER_TICK_MS = 60_000

/** How long a standup turn may run before it is cancelled. */
const STANDUP_TIMEOUT_MS = 15 * 60 * 1000

/** How long an action-resolved ping may run before it is cancelled. */
const PING_TIMEOUT_MS = 5 * 60 * 1000

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

export class StandupService {
  private readonly storage: IStorageLayer
  private readonly sessionManager: SessionManager
  private readonly teamSessions: TeamSessionManager
  private readonly router: PersonaRouter
  private timer: ReturnType<typeof setInterval> | null = null
  /** Projects with a standup currently in flight (re-entry guard). */
  private readonly running = new Set<string>()

  constructor(storage: IStorageLayer, sessionManager: SessionManager, push?: PushService) {
    this.storage = storage
    this.sessionManager = sessionManager
    this.teamSessions = new TeamSessionManager(storage, sessionManager)
    this.router = new PersonaRouter(storage, sessionManager, push)

    // Register immediately (not in start()) so user replies in team sessions
    // are persona-routed even when the scheduler isn't running.
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
   * the caller gets an immediate started/skipped answer); the CLI turn itself
   * runs in the background — its results arrive via the onTeamTurn hook and
   * persona push notifications. `force` (the manual "run now" button)
   * bypasses the unchanged-todos gate but never double-runs concurrently.
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

    // Wastefulness gate: skip when there's nothing new to talk about.
    const hash = hashTodos(todos)
    const state = (await this.storage.getStandupState(projectId)) ?? { projectId }
    if (!opts.force) {
      if (todos.length === 0) {
        return { ran: false, reason: 'No open todos — nothing to review' }
      }
      if (state.lastHash === hash) {
        return { ran: false, reason: 'Todo list unchanged since the last standup' }
      }
    }

    this.running.add(projectId)
    try {
      const session = await this.teamSessions.ensure(project, state.teamSessionId, lead)

      // Persist state BEFORE the turn: the session id survives a failed run
      // (no orphan/duplicate team sessions), and lastRunAt/lastHash stop the
      // scheduler from re-dispatching the same standup after a failure — a
      // manual "Run standup" is the retry path.
      state.teamSessionId = session.id
      state.lastRunAt = Date.now()
      state.lastHash = hash
      await this.storage.setStandupState(state)

      // Mark the todos as picked up before the turn so the UI reflects it.
      for (const todo of todos) {
        if (todo.status === 'inbox') {
          await this.storage.updateTodo(todo.id, { status: 'under_review' })
        }
      }

      const prompt = buildStandupPrompt(project, personas, todos)
      log.info('standup', `Standup dispatched for "${project.name}" (${todos.length} todo(s), session ${session.id})`)

      // Fire-and-forget: routing/notification happens in the onTeamTurn hook
      // when the turn lands. `running` clears when the turn settles so the
      // re-entry guard covers the whole background run.
      void this.executeStandupTurn(projectId, session.id, prompt)

      return { ran: true, sessionId: session.id }
    } catch (err) {
      this.running.delete(projectId)
      throw err
    }
  }

  /** The background half of a standup run: drive the turn, surface failures. */
  private async executeStandupTurn(projectId: string, sessionId: string, prompt: string): Promise<void> {
    try {
      await this.sessionManager.runTurn(sessionId, prompt, {
        timeoutMs: STANDUP_TIMEOUT_MS,
        cancelOnTimeout: true,
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log.error('standup', `Standup turn failed for project ${projectId}: ${message}`)
      this.sessionManager.appendSystemMessage(
        sessionId,
        `Standup failed: ${message}. Run it again from the project's Ideas panel.`,
      )
    } finally {
      this.running.delete(projectId)
    }
  }

  // -----------------------------------------------------------------------
  // Approve → implement
  // -----------------------------------------------------------------------

  /**
   * Spawn an implementation ('work') session for a proposed/approved idea and
   * dispatch the work as a background turn. The session runs on the PROPOSING
   * persona's provider/model (this is where per-persona providers become
   * real) and appears in the sidebar like any chat — the user can open it and
   * watch, or interject. On success the idea moves to Done and the team
   * announces it in their thread; on failure the work-session link is cleared
   * so the idea can be re-dispatched.
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
    let result: ChatMessage | null = null
    try {
      result = await this.sessionManager.runTurn(sessionId, prompt, {
        timeoutMs: WORK_TIMEOUT_MS,
        cancelOnTimeout: true,
      })
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
      return
    }

    // Success: the idea ships (completedAt is stamped by storage) and the
    // team announces it in their thread. The user can always reopen from the
    // board if the result doesn't hold up.
    const todo = await this.storage
      .updateTodo(todoId, { status: 'done' })
      .catch((e) => {
        log.warn('standup', `Failed to mark todo ${todoId} done: ${e instanceof Error ? e.message : String(e)}`)
        return null
      })
    if (todo) void this.announceWorkComplete(todo, implementer, result)
  }

  /** Ping the team thread so the implementer announces the shipped work. */
  private async announceWorkComplete(
    todo: Todo,
    implementer: Persona,
    result: ChatMessage | null,
  ): Promise<void> {
    try {
      const state = await this.storage.getStandupState(todo.projectId)
      if (!state?.teamSessionId) return
      const project = await this.storage.getProject(todo.projectId)
      const personas = await this.storage.listPersonas()
      if (!project || personas.length === 0) return
      const lead = personas.find((p) => p.isLead) ?? personas[0]

      const session = await this.teamSessions.ensure(project, state.teamSessionId, lead)
      if (session.id !== state.teamSessionId) {
        state.teamSessionId = session.id
        await this.storage.setStandupState(state)
      }

      await this.sessionManager.runTurn(session.id, buildWorkCompletePrompt(implementer, todo, result), {
        timeoutMs: PING_TIMEOUT_MS,
        cancelOnTimeout: true,
      })
    } catch (err) {
      log.warn('standup', `Work-complete announcement failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  // -----------------------------------------------------------------------
  // Action-resolved pings
  // -----------------------------------------------------------------------

  /**
   * The user resolved an action item the team raised — tell the team thread
   * so they can acknowledge and pick up whatever it was blocking. Runs as a
   * background turn; the reply arrives like any persona message. No-op when
   * the project has no team thread yet.
   */
  async notifyActionResolved(item: ActionItem): Promise<void> {
    const state = await this.storage.getStandupState(item.projectId)
    if (!state?.teamSessionId) return

    const project = await this.storage.getProject(item.projectId)
    const personas = await this.storage.listPersonas()
    if (!project || personas.length === 0) return
    const lead = personas.find((p) => p.isLead) ?? personas[0]

    const session = await this.teamSessions.ensure(project, state.teamSessionId, lead)
    if (session.id !== state.teamSessionId) {
      state.teamSessionId = session.id
      await this.storage.setStandupState(state)
    }

    const raisedBy = item.personaId
      ? personas.find((p) => p.id === item.personaId)?.name ?? 'the team'
      : 'the team'
    const prompt = [
      `The user just completed an action item ${raisedBy} raised: "${item.text}".`,
      item.notes ? `Context: ${item.notes}` : '',
      'Briefly acknowledge and say what this unblocks or what happens next — one short message from the most relevant team member. End with the same ```json block as always.',
    ]
      .filter(Boolean)
      .join('\n')

    log.info('standup', `Action item resolved for "${project.name}" — pinging team session ${session.id}`)
    try {
      await this.sessionManager.runTurn(session.id, prompt, {
        timeoutMs: PING_TIMEOUT_MS,
        cancelOnTimeout: true,
      })
    } catch (err) {
      log.warn('standup', `Action-resolved ping failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
}
