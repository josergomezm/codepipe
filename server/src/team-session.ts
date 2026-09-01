/**
 * Team-session lifecycle: find, revive, rotate, or create the per-project
 * 'team' session the personas live in. Owns exactly one policy — WHICH
 * session a team turn should run on — and nothing about what runs on it.
 */

import type { SessionManager } from './session-manager.js'
import type { IStorageLayer } from './storage.js'
import type { Persona, Project, Session } from './schemas.js'
import { log } from './logger.js'

export function isSameLocalMonth(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth()
}

export class TeamSessionManager {
  private readonly storage: IStorageLayer
  private readonly sessionManager: SessionManager

  constructor(storage: IStorageLayer, sessionManager: SessionManager) {
    this.storage = storage
    this.sessionManager = sessionManager
  }

  /**
   * Resolve the project's team session. A fresh session is started when none
   * exists, when the lead's provider changed (the thread must run on the
   * lead's CLI), or on a new calendar month (rotation keeps the resumed CLI
   * context from growing without bound). Old threads stay in the sidebar as
   * history.
   */
  async ensure(
    project: Project,
    knownSessionId: string | undefined,
    lead: Persona,
  ): Promise<Session> {
    if (knownSessionId) {
      const existing =
        this.sessionManager.getSession(knownSessionId) ??
        (await this.storage.getSession(knownSessionId))

      if (existing) {
        const providerChanged = existing.provider !== lead.provider
        const stale = !isSameLocalMonth(new Date(existing.createdAt), new Date())

        if (providerChanged || stale) {
          log.info(
            'standup',
            `Rotating team session for "${project.name}" (${providerChanged ? `lead provider changed to ${lead.provider}` : 'monthly rotation'})`,
          )
        } else {
          const session =
            existing.status === 'live' && this.sessionManager.getSession(knownSessionId)
              ? existing
              : await this.reviveOrNull(knownSessionId, existing)
          if (session) {
            // Follow the lead's model selection without recreating the thread.
            if (lead.model && session.model !== lead.model) {
              try {
                this.sessionManager.setModel(session.id, lead.model)
              } catch { /* non-fatal — next message uses the stored model */ }
            }
            return session
          }
        }
      }
    }

    return this.sessionManager.createSession(lead.provider, project.id, {
      kind: 'team',
      title: `${project.name} team`,
      ...(lead.model ? { model: lead.model } : {}),
    })
  }

  private async reviveOrNull(sessionId: string, archived: Session): Promise<Session | null> {
    try {
      return await this.sessionManager.reviveSession(sessionId, archived)
    } catch (err) {
      log.warn('standup', `Failed to revive team session ${sessionId}, creating a new one: ${err instanceof Error ? err.message : String(err)}`)
      return null
    }
  }
}
