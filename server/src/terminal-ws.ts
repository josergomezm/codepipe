import { WebSocketServer } from 'ws'

import type { IStorageLayer } from './storage.js'
import type { TerminalManager } from './terminal-manager.js'
import type { UpgradeHandler } from './websocket.js'
import { log } from './logger.js'

/**
 * Upgrade handler for `/ws/terminal?projectId=<id>`: connects the socket to
 * that project's shell (see TerminalManager for the wire protocol).
 */
export function createTerminalUpgradeHandler(storage: IStorageLayer, terminals: TerminalManager): UpgradeHandler {
  const wss = new WebSocketServer({ noServer: true })

  return (request, socket, head) => {
    const url = new URL(request.url ?? '', 'http://localhost')
    const projectId = url.searchParams.get('projectId')

    wss.handleUpgrade(request, socket, head, async (ws) => {
      const project = projectId ? await storage.getProject(projectId).catch(() => null) : null
      if (!project) {
        ws.close(4404, 'Project not found')
        return
      }
      try {
        terminals.attach(project.id, project.path, ws)
      } catch (err) {
        log.error('terminal', `Failed to start terminal for project ${project.id}`, err)
        ws.close(1011, 'Failed to start shell')
      }
    })
  }
}
