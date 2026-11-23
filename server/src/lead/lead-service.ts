/**
 * The lead assistant: the internal Workspace project, the lead's own thread
 * (a persistent, read-only `lead` session), and the daily brief that runs in
 * it — on a schedule or on demand. See docs/lead-assistant-plan.md.
 *
 * The Workspace project lives in CodePipe's data folder (empty — the lead
 * needs no code, it reads through CodePipe's tools) and is hidden from
 * project lists. Action items with no product go there too.
 */
import { mkdir } from 'fs/promises'
import path from 'path'

import type { IStorageLayer } from '../storage.js'
import type { ISessionManager } from '../session-manager.js'
import { DEFAULT_BRIEF_SCHEDULE, type BriefSchedule, type FocusItem, type LeadState, type LeadStatus, type Persona, type Project, type Session } from '../schemas.js'
import { READ_ONLY_SETTINGS } from '../provider-settings.js'
import { isStandupDue } from '../standup.js'
import { log } from '../logger.js'
import { buildWorkspaceDigest, type WorkspaceDigest } from './workspace-digest.js'
import { buildBriefPrompt } from './brief-prompt.js'

const WORKSPACE_PROJECT_NAME = 'Workspace'
const DAY = 86_400_000
/** How often the scheduler checks whether a brief is due. */
const SCHEDULER_TICK_MS = 60_000
/** How long the brief turn may run before it's cancelled. */
const BRIEF_TIMEOUT_MS = 15 * 60_000

/**
 * Whether the scheduled brief is due: once its hour has passed today (catch-up
 * after sleep, like standups), not yet run or attempted today, and — with
 * weekdaysOnly — not on a weekend.
 */
export function isBriefDue(schedule: BriefSchedule, lastRunOrAttemptAt: number | undefined, now: Date): boolean {
  if (schedule.weekdaysOnly && (now.getDay() === 0 || now.getDay() === 6)) return false
  return isStandupDue(schedule, lastRunOrAttemptAt, now)
}

/** The stored schedule, or the default (daily at 9 AM). */
function scheduleOf(state: LeadState): BriefSchedule {
  return state.schedule ?? { ...DEFAULT_BRIEF_SCHEDULE }
}

export interface BriefRunResult {
  ran: boolean
  reason?: string
  sessionId?: string
}

export class LeadService {
  private workspace: Promise<Project> | null = null
  private briefRunning = false
  /** The last reason a scheduled brief was skipped — logged once, not every tick. */
  private lastSkip: string | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  /** Background brief turns, for whenIdle (shutdown, tests). */
  private readonly inflight = new Set<Promise<void>>()

  constructor(
    private readonly storage: IStorageLayer,
    private readonly sessionManager: ISessionManager,
    private readonly dataDir: string,
  ) {}

  /** The internal Workspace project, created on first use. */
  workspaceProject(): Promise<Project> {
    this.workspace ??= this.findOrCreateWorkspace().catch((err) => {
      this.workspace = null
      throw err
    })
    return this.workspace
  }

  private async findOrCreateWorkspace(): Promise<Project> {
    const existing = (await this.storage.listProjects()).find((p) => p.internal)
    if (existing) return existing
    const dir = path.resolve(this.dataDir, 'workspace')
    await mkdir(dir, { recursive: true })
    return this.storage.addProject({ name: WORKSPACE_PROJECT_NAME, path: dir, internal: true })
  }

  /** The persona marked lead, else the first one; null without a team. */
  async leadPersona(): Promise<Persona | null> {
    const personas = await this.storage.listPersonas()
    return personas.find((p) => p.isLead) ?? personas[0] ?? null
  }

  async status(): Promise<LeadStatus> {
    const [state, persona, workspace] = await Promise.all([this.storage.getLeadState(), this.leadPersona(), this.workspaceProject()])
    return {
      leadPersonaId: persona?.id ?? null,
      sessionId: this.threadMatches(state, persona) ? state.sessionId! : null,
      workspaceProjectId: workspace.id,
      focus: state.focus,
      memo: state.memo ?? null,
      lastBriefAt: state.lastBriefAt ?? null,
      schedule: scheduleOf(state),
      briefRunning: this.briefRunning,
    }
  }

  /** What the next brief would read: your open chats now, git and closed chats since the last brief. */
  async digest(): Promise<WorkspaceDigest> {
    const state = await this.storage.getLeadState()
    return buildWorkspaceDigest(
      { storage: this.storage, liveSession: (id) => this.sessionManager.getSession(id) },
      { since: state.lastBriefAt ?? Date.now() - DAY },
    )
  }

  async setSchedule(schedule: BriefSchedule): Promise<BriefSchedule> {
    return (await this.storage.updateLeadState((s) => { s.schedule = schedule })).schedule!
  }

  // -----------------------------------------------------------------------
  // The daily brief
  // -----------------------------------------------------------------------

  /**
   * Start a brief: set up inline (so the caller gets started / skipped at
   * once), then one turn in the lead's thread in the background. The lead
   * posts the brief with post_brief; lastBriefAt moves to this run's start
   * only if it did. A scheduled run records the attempt, so a failure isn't
   * retried until tomorrow. A lead busy in your conversation is left alone —
   * a brief queued behind you could time out and cancel your turn.
   */
  async runBrief(opts: { scheduled: boolean }): Promise<BriefRunResult> {
    if (this.briefRunning) return { ran: false, reason: 'A brief is already being written' }
    this.briefRunning = true
    const startedAt = Date.now()
    const recordAttempt = () =>
      opts.scheduled ? this.storage.updateLeadState((s) => { s.lastAttemptAt = startedAt }).then(() => undefined) : Promise.resolve()
    try {
      const session = await this.ensureLeadSession()
      if (!session) {
        this.briefRunning = false
        return { ran: false, reason: 'No team yet — add a team lead first' }
      }
      const [state, lead, projects] = await Promise.all([this.storage.getLeadState(), this.leadPersona(), this.storage.listProjects()])
      if (this.sessionManager.isBusy(session.id)) {
        this.briefRunning = false
        return { ran: false, reason: `${lead!.name} is busy in your conversation — try again when it's done` }
      }
      await recordAttempt()
      const digest = await buildWorkspaceDigest(
        { storage: this.storage, liveSession: (id) => this.sessionManager.getSession(id) },
        { since: state.lastBriefAt ?? startedAt - DAY, now: startedAt },
      )
      const prompt = buildBriefPrompt({ digest, lead: lead!, projects, focus: state.focus, memo: state.memo, now: startedAt })
      this.track(this.finishBrief(session.id, prompt, startedAt))
      return { ran: true, sessionId: session.id }
    } catch (err) {
      this.briefRunning = false
      log.error('lead', 'Could not start the brief', err)
      // A setup failure (e.g. a provider that can't run read-only) costs
      // nothing, but still counts as today's scheduled attempt.
      await recordAttempt().catch(() => {})
      return { ran: false, reason: err instanceof Error ? err.message : 'Could not start the brief' }
    }
  }

  private async finishBrief(sessionId: string, prompt: string, startedAt: number): Promise<void> {
    try {
      await this.sessionManager.runTurn(sessionId, prompt, { timeoutMs: BRIEF_TIMEOUT_MS, cancelOnTimeout: true, internalPrompt: true })
    } catch (err) {
      log.error('lead', 'The brief turn failed', err)
    } finally {
      // Posted counts even if the turn failed afterwards (e.g. timed out
      // saving its memo) — otherwise the next brief re-reports this window.
      const posted = !!this.sessionManager.getSession(sessionId)?.messages.some(
        (m) => m.metadata?.kind === 'brief' && m.timestamp >= startedAt,
      )
      if (!posted) log.warn('lead', 'The brief turn ended without post_brief — nothing recorded as briefed')
      this.briefRunning = false
      // Always written: its change event is how clients learn the run ended.
      await this.storage
        .updateLeadState((s) => {
          s.lastRunEndedAt = Date.now()
          if (posted) s.lastBriefAt = startedAt
        })
        .catch((err) => log.error('lead', 'Could not record the end of the brief', err))
    }
  }

  /** Check every minute whether the scheduled brief is due. */
  start(): void {
    this.timer = setInterval(() => { this.track(this.tick()) }, SCHEDULER_TICK_MS)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** One scheduler check (exposed so it can be driven with a given time). */
  async tick(now = new Date()): Promise<void> {
    try {
      const state = await this.storage.getLeadState()
      const last = Math.max(state.lastBriefAt ?? 0, state.lastAttemptAt ?? 0) || undefined
      if (!isBriefDue(scheduleOf(state), last, now)) return
      const result = await this.runBrief({ scheduled: true })
      if (result.ran) {
        this.lastSkip = null
        log.info('lead', 'Scheduled brief started')
      } else if (result.reason !== this.lastSkip) {
        this.lastSkip = result.reason ?? null
        log.info('lead', `Scheduled brief not started: ${result.reason}`)
      }
    } catch (err) {
      log.error('lead', 'Brief schedule check failed', err)
    }
  }

  private track(work: Promise<void>): void {
    this.inflight.add(work)
    void work.finally(() => this.inflight.delete(work))
  }

  /** Resolves once every brief turn started so far has settled (or after `timeoutMs`). */
  async whenIdle(timeoutMs?: number): Promise<void> {
    const settled = (async () => { while (this.inflight.size) await Promise.all([...this.inflight]) })()
    if (timeoutMs === undefined) return settled
    let timer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([settled, new Promise<void>((resolve) => { timer = setTimeout(resolve, timeoutMs) })])
    clearTimeout(timer)
  }

  async setFocus(focus: FocusItem[]): Promise<FocusItem[]> {
    return (await this.storage.updateLeadState((s) => { s.focus = focus })).focus
  }

  /**
   * The lead's thread, live and ready for a turn: reused while the same
   * persona leads on the same provider (a different lead or provider starts
   * a fresh thread — old ones stay as history), revived after a restart,
   * and kept on the persona's current model. Null without a team.
   */
  async ensureLeadSession(): Promise<Session | null> {
    const persona = await this.leadPersona()
    if (!persona) return null
    if (!READ_ONLY_SETTINGS[persona.provider]) {
      throw new Error(`${persona.name}'s provider can't run read-only, so it can't lead — pick another provider in team settings.`)
    }
    const state = await this.storage.getLeadState()

    if (this.threadMatches(state, persona)) {
      const live = this.sessionManager.getSession(state.sessionId!)
      const session = live?.status === 'live' ? live : await this.revive(state.sessionId!)
      if (session) {
        if (persona.model && session.model !== persona.model) this.sessionManager.setModel(session.id, persona.model)
        return session
      }
    }

    const workspace = await this.workspaceProject()
    const session = await this.sessionManager.createSession(persona.provider, workspace.id, {
      kind: 'lead',
      title: persona.name,
      personaId: persona.id,
      ...(persona.model ? { model: persona.model } : {}),
    })
    await this.storage.updateLeadState((s) => {
      s.sessionId = session.id
      s.sessionPersonaId = persona.id
      s.sessionProvider = persona.provider
    })
    return session
  }

  private threadMatches(state: LeadState, persona: Persona | null): boolean {
    return !!persona && !!state.sessionId && state.sessionPersonaId === persona.id && state.sessionProvider === persona.provider
  }

  private async revive(sessionId: string): Promise<Session | null> {
    const stored = await this.storage.getSession(sessionId)
    return stored ? this.sessionManager.reviveSession(sessionId, stored) : null
  }
}
