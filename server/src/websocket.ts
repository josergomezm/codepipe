import { WebSocketServer, WebSocket } from 'ws'
import type { Server as HttpServer, IncomingMessage } from 'http'
import type { Duplex } from 'stream'

import type { ISessionManager } from './session-manager.js'
import type { IStorageLayer } from './storage.js'
import { WSClientMessageSchema } from './schemas.js'
import type { Session, Attachment } from './schemas.js'
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
 * Create the standard message handler for a live session WebSocket.
 * Returned as a named function so it can be removed with removeListener.
 */
function createMessageHandler(
  ws: WebSocket,
  sessionId: string,
  sessionManager: ISessionManager,
): (raw: Buffer | string) => void {
  return (raw: Buffer | string) => {
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
        try {
          sessionManager.handleInput(sessionId, msg.data, msg.attachments)
        } catch (inputErr) {
          log.error('ws', `handleInput failed for session ${sessionId}`, inputErr)
          const message = inputErr instanceof Error ? inputErr.message : 'Failed to send message'
          ws.send(JSON.stringify({ type: 'error', data: message }))
        }
      }
    } catch (err) {
      log.error('ws', 'Error processing message', err)
      ws.send(JSON.stringify({ type: 'error', data: 'Failed to process message' }))
    }
  }
}

/**
 * Attach the standard live-session handlers (message + close) to a WebSocket.
 */
function attachLiveHandlers(
  ws: WebSocket,
  sessionId: string,
  sessionManager: ISessionManager,
): void {
  ws.on('message', createMessageHandler(ws, sessionId, sessionManager))
  ws.on('close', () => {
    sessionManager.detachClient(sessionId, ws)
  })
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

  if (liveSession && liveSession.status === 'live') {
    // Live session — attach client, replay history, send current status
    sessionManager.attachClient(sessionId, ws)

    ws.send(JSON.stringify({ type: 'history', data: liveSession.messages }))
    ws.send(JSON.stringify({ type: 'status', data: 'idle' }))

    attachLiveHandlers(ws, sessionId, sessionManager)
    return
  }

  // Not live — check in-memory (pty exited but still in map) then storage
  const inMemoryArchived = liveSession && liveSession.status !== 'live' ? liveSession : null
  const archivePromise = inMemoryArchived
    ? Promise.resolve(inMemoryArchived)
    : storage.getSession(sessionId)

  archivePromise.then((archivedSession) => {
    if (archivedSession) {
      // Archived session — replay history and send exited status
      ws.send(JSON.stringify({ type: 'history', data: archivedSession.messages }))
      ws.send(JSON.stringify({ type: 'status', data: 'exited' }))

      // Handle messages on archived sessions — attempt to revive the session
      const archivedHandler = (raw: Buffer | string) => {
        try {
          const text = raw.toString()
          log.debug('ws', `Received from client for archived session ${sessionId}`, text)
          const parsed = WSClientMessageSchema.safeParse(JSON.parse(text))
          if (!parsed.success) {
            log.error('ws', 'Invalid message format', parsed.error.format())
            ws.send(JSON.stringify({ type: 'error', data: 'Invalid message format' }))
            return
          }

          const msg = parsed.data
          if (msg.type === 'input') {
            // Try to revive the session by creating a new pty with the same config
            reviveSession(ws, sessionId, archivedSession, archivedHandler, msg.data, msg.attachments, sessionManager)
          }
        } catch (err) {
          log.error('ws', 'Error processing message on archived session', err)
          ws.send(JSON.stringify({ type: 'error', data: 'Failed to process message' }))
        }
      }
      ws.on('message', archivedHandler)
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

/**
 * Revive an archived session by spawning a new pty process and
 * re-attaching the WebSocket client. The session keeps its original ID
 * and message history — it just gets a fresh CLI process.
 */
async function reviveSession(
  ws: WebSocket,
  sessionId: string,
  archivedSession: Session,
  archivedHandler: (raw: Buffer | string) => void,
  inputText: string,
  attachments: Attachment[] | undefined,
  sessionManager: ISessionManager,
): Promise<void> {
  try {
    log.info('ws', `Reviving archived session ${sessionId} (provider: ${archivedSession.provider})`)

    // Revive the session — this spawns a new pty and re-registers it in the SessionManager
    await sessionManager.reviveSession(sessionId, archivedSession)

    // Remove only the archived-session handler, then attach the live-session ones
    ws.removeListener('message', archivedHandler)

    // Attach the client to the now-live session
    sessionManager.attachClient(sessionId, ws)

    // Send updated status to the client
    ws.send(JSON.stringify({ type: 'status', data: 'idle' }))

    // Set up the standard live-session handlers
    attachLiveHandlers(ws, sessionId, sessionManager)

    // Send the user's original input that triggered the revival.
    // Non-interactive adapters can handle input immediately.
    // Interactive (PTY) adapters need time for the CLI to initialize.
    // TODO: When interactive adapters are added, detect adapter type and
    // use SYSTEM_PROMPT_DELAY_MS + 500 for PTY-based sessions.
    try {
      sessionManager.handleInput(sessionId, inputText, attachments)
    } catch (err) {
      log.error('ws', `Failed to send initial input after revival for session ${sessionId}`, err)
      ws.send(JSON.stringify({ type: 'error', data: 'Session revived but failed to send message. Try sending again.' }))
    }

  } catch (err) {
    log.error('ws', `Failed to revive session ${sessionId}`, err)
    const message = err instanceof Error ? err.message : 'Failed to restart session'
    ws.send(JSON.stringify({ type: 'error', data: `Could not restart session: ${message}` }))
  }
}
