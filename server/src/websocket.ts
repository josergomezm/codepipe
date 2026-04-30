import { WebSocketServer, WebSocket } from 'ws'
import type { Server as HttpServer, IncomingMessage } from 'http'
import type { Duplex } from 'stream'

import type { ISessionManager } from './session-manager.js'
import type { IStorageLayer } from './storage.js'
import { WSClientMessageSchema } from './schemas.js'
import { log } from './logger.js'

/**
 * Attach a WebSocket server to an existing HTTP server.
 *
 * Uses `noServer: true` so Express keeps handling normal HTTP requests
 * while WebSocket upgrade requests on `/ws` are routed here.
 */
export function setupWebSocket(
  server: HttpServer,
  sessionManager: ISessionManager,
  storage: IStorageLayer,
): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true })

  server.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(request.url ?? '', 'http://localhost')

    if (url.pathname !== '/ws') {
      socket.destroy()
      return
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request)
    })
  })

  wss.on('connection', (ws: WebSocket, request: IncomingMessage) => {
    const url = new URL(request.url ?? '', 'http://localhost')
    const sessionId = url.searchParams.get('sessionId')

    if (!sessionId) {
      ws.send(JSON.stringify({ type: 'error', data: 'Missing sessionId query parameter' }))
      ws.close()
      return
    }

    handleConnection(ws, sessionId, sessionManager, storage)
  })

  return wss
}

/**
 * Handle a new WebSocket connection for a given session.
 */
function handleConnection(
  ws: WebSocket,
  sessionId: string,
  sessionManager: ISessionManager,
  storage: IStorageLayer,
): void {
  // Check if session is live in SessionManager
  const liveSession = sessionManager.getSession(sessionId)

  if (liveSession) {
    // Live session — attach client, replay history, send current status
    sessionManager.attachClient(sessionId, ws)

    ws.send(JSON.stringify({ type: 'history', data: liveSession.messages }))
    ws.send(JSON.stringify({ type: 'status', data: 'idle' }))

    // Handle incoming messages
    ws.on('message', (raw: Buffer | string) => {
      try {
        const text = raw.toString()
        log.debug('ws', `Received from client for session ${sessionId}`, text)
        const parsed = WSClientMessageSchema.safeParse(JSON.parse(text))
        if (!parsed.success) {
          log.error('ws', 'Invalid message format', parsed.error.format())
          ws.send(JSON.stringify({ type: 'error', data: 'Invalid message format' }))
          return
        }

        const msg = parsed.data
        if (msg.type === 'input') {
          log.debug('ws', `Routing input to handleInput: "${msg.data}"`)
          sessionManager.handleInput(sessionId, msg.data)
        }
      } catch (err) {
        log.error('ws', 'Error processing message', err)
        ws.send(JSON.stringify({ type: 'error', data: 'Invalid message format' }))
      }
    })

    // Handle disconnection
    ws.on('close', () => {
      sessionManager.detachClient(sessionId, ws)
    })

    return
  }

  // Not live — check storage for archived session
  storage.getSession(sessionId).then((archivedSession) => {
    if (archivedSession) {
      // Archived session — replay history and send exited status
      ws.send(JSON.stringify({ type: 'history', data: archivedSession.messages }))
      ws.send(JSON.stringify({ type: 'status', data: 'exited' }))
    } else {
      // Session doesn't exist at all
      ws.send(JSON.stringify({ type: 'error', data: 'Session not found' }))
      ws.close()
    }
  }).catch((err) => {
    log.error('ws', `Failed to load session ${sessionId}`, err)
    ws.send(JSON.stringify({ type: 'error', data: 'Failed to load session' }))
    ws.close()
  })
}
