/**
 * The lead assistant's home: the internal Workspace project and the lead's
 * own thread (a persistent, read-only `lead` session). See
 * docs/lead-assistant-plan.md, "Where the lead runs".
 *
 * The Workspace project lives in CodePipe's data folder (empty — the lead
 * needs no code, it reads through CodePipe's tools) and is hidden from
 * project lists. Action items with no product go there too.
 */
import { mkdir } from 'fs/promises'
import path from 'path'

import type { IStorageLayer } from '../storage.js'
import type { ISessionManager } from '../session-manager.js'
import type { FocusItem, LeadState, LeadStatus, Persona, Project, Session } from '../schemas.js'
import { READ_ONLY_SETTINGS } from '../provider-settings.js'

const WORKSPACE_PROJECT_NAME = 'Workspace'

export class LeadService {
  private workspace: Promise<Project> | null = null

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
    }
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
