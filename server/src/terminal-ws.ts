import { WebSocketServer } from 'ws'

import type { IStorageLayer } from './storage.js'
import { TerminalStartError, type TerminalManager } from './terminal-manager.js'
import type { UpgradeHandler } from './websocket.js'
import { log } from './logger.js'

/** Close codes the Terminal tab understands (4000–4999 are app-defined). */
export const TERMINAL_CLOSE = {
  projectNotFound: 4404,
  /** The shell couldn't start; an {type:'error', message} frame precedes it. */
  startFailed: 4500,
} as const

/**
 * Upgrade handler for `/ws/terminal?projectId=<id>`: connects the socket to
 * that project's shell (see TerminalManager for the wire protocol).
 */
export function createTerminalUpgradeHandler(storage: IStorageLayer, terminals: TerminalManager): UpgradeHandler {
  const wss = new WebSocketServer({ noServer: true })

  return (request, socket, head) => {
    const url = new URL(request.url ?? '', 'http://localhost')
    const projectId = url.searchParams.get('projectId')

    wss.handleUpgrade(request, socket, head, (ws) => {
      // Before anything async: an 'error' with no listener would crash the server.
      ws.on('error', (err) => {
        log.warn('terminal', `Terminal socket error for project ${projectId ?? '(none)'}`, err)
      })

      void (async () => {
        const project = projectId ? await storage.getProject(projectId).catch(() => null) : null
        if (!project) {
          log.warn('terminal', `Terminal requested for unknown project ${projectId ?? '(none)'}`)
          ws.close(TERMINAL_CLOSE.projectNotFound, 'Project not found')
          return
        }
        try {
          terminals.attach(project.id, project.path, ws)
        } catch (err) {
          const message = err instanceof TerminalStartError ? err.message : "Couldn't start a shell — see the server log."
          if (!(err instanceof TerminalStartError)) log.error('terminal', `Failed to attach terminal for project ${project.id}`, err)
          if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'error', message }))
          ws.close(TERMINAL_CLOSE.startFailed, 'Shell failed to start')
        }
      })().catch((err) => {
        log.error('terminal', `Terminal connection failed for project ${projectId ?? '(none)'}`, err)
        try { ws.close(1011, 'Internal error') } catch { /* already closed */ }
      })
    })
  }
}
