import { randomUUID } from 'crypto'
import * as pty from 'node-pty'
import type { WebSocket } from 'ws'

import type {
  ProviderType,
  Session,
  SessionMeta,
  ChatMessage,
} from './schemas.js'
import type { IStorageLayer } from './storage.js'
import type { ICLIAdapter } from './adapters/types.js'
import { type AdapterEvent, validateAdapterEvents } from './adapters/types.js'
import { getAdapter } from './adapters/registry.js'
import { stripAnsi } from './adapters/strip-ansi.js'
import { log } from './logger.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Internal tracking state for each active (live) session.
 */
export interface SessionContext {
  session: Session
  pty: pty.IPty
  adapter: ICLIAdapter
  clients: Set<WebSocket>
  currentMessage: ChatMessage | null
  storageDebounceTimer: ReturnType<typeof setTimeout> | null
  pendingMessage: ChatMessage | null
}

/**
 * Public interface for the SessionManager.
 */
export interface ISessionManager {
  createSession(provider: ProviderType, projectId: string): Promise<Session>
  getSession(sessionId: string): Session | undefined
  listSessions(): SessionMeta[]
  deleteSession(sessionId: string): Promise<void>
  attachClient(sessionId: string, socket: WebSocket): void
  detachClient(sessionId: string, socket: WebSocket): void
  handleInput(sessionId: string, text: string): void
  shutdown(): Promise<void>
}

// ---------------------------------------------------------------------------
// SessionManager
// ---------------------------------------------------------------------------

/** Storage write debounce interval in milliseconds. */
const STORAGE_DEBOUNCE_MS = 500

/** Delay before sending the system prompt to let the CLI initialize. */
const SYSTEM_PROMPT_DELAY_MS = 3000

export class SessionManager implements ISessionManager {
  private readonly sessions = new Map<string, SessionContext>()
  private readonly storage: IStorageLayer

  constructor(storage: IStorageLayer) {
    this.storage = storage
  }

  // -----------------------------------------------------------------------
  // 4.1.2 — createSession
  // -----------------------------------------------------------------------

  async createSession(
    provider: ProviderType,
    projectId: string,
  ): Promise<Session> {
    // Validate project exists
    const project = await this.storage.getProject(projectId)
    if (!project) {
      throw new Error('Project not found')
    }

    // Resolve CLI adapter for provider
    const adapter = getAdapter(provider)
    if (!adapter) {
      throw new Error(`No adapter registered for provider "${provider}"`)
    }

    // Create session record
    const now = Date.now()
    const session: Session = {
      id: randomUUID(),
      provider,
      projectId,
      title: `New ${provider} session`,
      createdAt: now,
      updatedAt: now,
      status: 'live',
      messages: [],
    }

    // Spawn pty process
    const shell = adapter.command
    const args = adapter.args
    log.info('session', `Spawning: ${shell} ${args.join(' ')} in ${project.path}`)
    const ptyProcess = pty.spawn(shell, args, {
      name: 'xterm-256color',
      cols: 120,
      rows: 40,
      cwd: project.path,
      env: { ...process.env } as Record<string, string>,
    })

    // Build session context
    const ctx: SessionContext = {
      session,
      pty: ptyProcess,
      adapter,
      clients: new Set(),
      currentMessage: null,
      storageDebounceTimer: null,
      pendingMessage: null,
    }

    this.sessions.set(session.id, ctx)

    // Persist session to storage BEFORE wiring events
    await this.storage.saveSession(session)

    // Wire pty output → strip ANSI → adapter.onData → validate → process events
    ptyProcess.onData((data: string) => {
      const cleanText = stripAnsi(data)
      if (cleanText.trim().length === 0) return
      log.debug('pty', `clean: ${JSON.stringify(cleanText).slice(0, 300)}`)
      const rawEvents = adapter.onData(cleanText)
      if (rawEvents.length === 0) return

      // Validate events at the boundary — drop malformed ones
      const events = validateAdapterEvents(rawEvents, (msg) => {
        log.warn('adapter', msg)
      })
      if (events.length === 0) return

      // Only log non-chunk events at info level
      const significantEvents = events.filter(e => e.type !== 'chunk')
      if (significantEvents.length > 0) {
        log.info('adapter', `${significantEvents.map(e => e.type).join(', ')}`)
      }
      this.processAdapterEvents(session.id, events)
    })

    // Handle pty exit
    ptyProcess.onExit(({ exitCode }) => {
      ctx.session.status = 'archived'

      // Finalize any in-progress streaming message
      this.finalizeCurrentMessage(session.id)

      // Clear any pending timers
      if (ctx.storageDebounceTimer) {
        clearTimeout(ctx.storageDebounceTimer)
        ctx.storageDebounceTimer = null
      }

      // Persist archived status
      this.storage.updateSessionStatus(session.id, 'archived').catch((err) => {
        log.error('session', `Failed to archive session ${session.id}`, err)
      })

      // Append system message about exit
      const exitMsg: ChatMessage = {
        id: randomUUID(),
        role: 'system',
        content: `CLI process exited with code ${exitCode ?? 'unknown'}`,
        timestamp: Date.now(),
        status: 'complete',
      }
      ctx.session.messages.push(exitMsg)
      this.storage.appendMessage(session.id, exitMsg).catch((err) => {
        log.error('session', `Failed to persist exit message for session ${session.id}`, err)
      })

      this.broadcast(session.id, { type: 'message', data: exitMsg })
      this.broadcast(session.id, { type: 'status', data: 'exited' })
    })

    // Send system prompt after a delay to let the CLI initialize
    if (adapter.systemPrompt) {
      const systemPrompt = adapter.systemPrompt
      setTimeout(() => {
        // Only send if session is still live
        const currentCtx = this.sessions.get(session.id)
        if (currentCtx && currentCtx.session.status === 'live') {
          log.info('session', `Sending system prompt for session ${session.id}`)
          currentCtx.adapter.notifySystemInput(systemPrompt)
          currentCtx.pty.write(systemPrompt + '\r')
        }
      }, SYSTEM_PROMPT_DELAY_MS)
    }

    return session
  }

  // -----------------------------------------------------------------------
  // 4.1.3 — handleInput
  // -----------------------------------------------------------------------

  handleInput(sessionId: string, text: string): void {
    const ctx = this.sessions.get(sessionId)
    if (!ctx) {
      log.error('session', `handleInput: Session ${sessionId} not found in active sessions`)
      throw new Error(`Session ${sessionId} not found`)
    }
    if (ctx.session.status !== 'live') {
      log.error('session', `handleInput: Session ${sessionId} is not live (status: ${ctx.session.status})`)
      throw new Error(`Session ${sessionId} is not live`)
    }
    if (!text || text.length === 0) {
      throw new Error('Input text must be non-empty')
    }

    log.info('session', `handleInput: Writing to pty for session ${sessionId}: "${text}"`)
    log.debug('session', `handleInput: Attached clients: ${ctx.clients.size}`)

    // Finalize any in-progress streaming message before starting new input
    this.finalizeCurrentMessage(sessionId)

    // Create user message
    const userMessage: ChatMessage = {
      id: randomUUID(),
      role: 'user',
      content: text,
      timestamp: Date.now(),
      status: 'complete',
    }

    // Add to in-memory session
    ctx.session.messages.push(userMessage)
    ctx.session.updatedAt = userMessage.timestamp

    // Persist to storage
    this.storage.appendMessage(sessionId, userMessage).catch((err) => {
      log.error('session', `Failed to persist user message for session ${sessionId}`, err)
    })

    // Broadcast to all attached clients
    this.broadcast(sessionId, { type: 'message', data: userMessage })

    // Notify the adapter that user input is being sent (state machine transition)
    ctx.adapter.notifyUserInput(text)

    // Write to pty stdin (\r is carriage return — what terminals send on Enter)
    ctx.pty.write(text + '\r')
  }

  // -----------------------------------------------------------------------
  // 4.1.4 — processAdapterEvents
  // -----------------------------------------------------------------------

  processAdapterEvents(sessionId: string, events: AdapterEvent[]): void {
    const ctx = this.sessions.get(sessionId)
    if (!ctx) return

    for (const event of events) {
      switch (event.type) {
        case 'chunk': {
          if (!ctx.currentMessage || ctx.currentMessage.status === 'complete') {
            // Start a new streaming message
            ctx.currentMessage = {
              id: randomUUID(),
              role: event.role,
              content: event.content,
              timestamp: Date.now(),
              status: 'streaming',
            }
            ctx.session.messages.push(ctx.currentMessage)
            this.broadcast(sessionId, { type: 'message', data: ctx.currentMessage })
            this.broadcast(sessionId, { type: 'status', data: 'typing' })
          } else if (ctx.currentMessage.role !== event.role) {
            // Role changed (e.g., tool output interrupted assistant text) —
            // finalize the old message and start a new one
            this.finalizeCurrentMessage(sessionId)
            ctx.currentMessage = {
              id: randomUUID(),
              role: event.role,
              content: event.content,
              timestamp: Date.now(),
              status: 'streaming',
            }
            ctx.session.messages.push(ctx.currentMessage)
            this.broadcast(sessionId, { type: 'message', data: ctx.currentMessage })
            this.broadcast(sessionId, { type: 'status', data: 'typing' })
          } else {
            // APPEND to existing streaming message (same role)
            ctx.currentMessage.content += event.content
            // Broadcast the updated message so the frontend can replace
            this.broadcast(sessionId, {
              type: 'message',
              data: ctx.currentMessage,
            })
          }

          // Debounce storage write for streaming chunks
          this.debounceStorageWrite(sessionId, ctx.currentMessage)
          break
        }

        case 'message_complete': {
          if (ctx.currentMessage && ctx.currentMessage.status === 'streaming') {
            // Attach credits/time metadata if present
            if (event.metadata) {
              ctx.currentMessage.metadata = {
                ...ctx.currentMessage.metadata,
                ...event.metadata,
              }
            }
            this.finalizeCurrentMessage(sessionId)
          }
          // Even if currentMessage is null (already finalized by tool_use flow),
          // clear it to ensure clean state for the next message
          ctx.currentMessage = null
          break
        }

        case 'prompt_detected': {
          this.finalizeCurrentMessage(sessionId)
          ctx.currentMessage = null
          this.broadcast(sessionId, { type: 'status', data: 'idle' })
          break
        }

        case 'tool_use': {
          // If there's an in-progress assistant message, finalize it first.
          // Tool output is a separate message — it should NOT bleed into
          // the assistant's content.
          if (ctx.currentMessage && ctx.currentMessage.status === 'streaming') {
            this.finalizeCurrentMessage(sessionId)
            ctx.currentMessage = null
          }

          const toolMsg: ChatMessage = {
            id: randomUUID(),
            role: 'tool',
            content: event.content,
            timestamp: Date.now(),
            status: 'complete',
            metadata: { toolName: event.tool },
          }
          ctx.session.messages.push(toolMsg)
          this.storage.appendMessage(sessionId, toolMsg).catch((err) => {
            log.error('session', `Failed to persist tool message for session ${sessionId}`, err)
          })
          this.broadcast(sessionId, { type: 'message', data: toolMsg })
          break
        }

        case 'interactive_prompt': {
          // Finalize any in-progress message
          this.finalizeCurrentMessage(sessionId)
          ctx.currentMessage = null

          // Create a system message showing the prompt
          const promptMsg: ChatMessage = {
            id: randomUUID(),
            role: 'system',
            content: event.content + (event.options ? ` [${event.options.join('/')}]` : ''),
            timestamp: Date.now(),
            status: 'complete',
          }
          ctx.session.messages.push(promptMsg)
          this.storage.appendMessage(sessionId, promptMsg).catch((err) => {
            log.error('session', `Failed to persist interactive prompt for session ${sessionId}`, err)
          })
          this.broadcast(sessionId, { type: 'message', data: promptMsg })
          // Signal that the CLI is waiting for user input
          this.broadcast(sessionId, { type: 'status', data: 'idle' })
          break
        }

        case 'thinking': {
          // Thinking blocks are transient — broadcast typing status instead of a message
          this.broadcast(sessionId, { type: 'status', data: 'typing' })
          break
        }
      }
    }
  }

  // -----------------------------------------------------------------------
  // 4.1.5 — attachClient / detachClient
  // -----------------------------------------------------------------------

  attachClient(sessionId: string, socket: WebSocket): void {
    const ctx = this.sessions.get(sessionId)
    if (!ctx) {
      throw new Error(`Session ${sessionId} not found`)
    }
    ctx.clients.add(socket)
  }

  detachClient(sessionId: string, socket: WebSocket): void {
    const ctx = this.sessions.get(sessionId)
    if (!ctx) return
    ctx.clients.delete(socket)
  }

  // -----------------------------------------------------------------------
  // 4.1.6 — getSession, listSessions, deleteSession
  // -----------------------------------------------------------------------

  getSession(sessionId: string): Session | undefined {
    return this.sessions.get(sessionId)?.session
  }

  listSessions(): SessionMeta[] {
    const metas: SessionMeta[] = []
    for (const ctx of this.sessions.values()) {
      const { messages: _, ...meta } = ctx.session
      metas.push(meta)
    }
    return metas
  }

  async deleteSession(sessionId: string): Promise<void> {
    const ctx = this.sessions.get(sessionId)
    if (ctx) {
      // Kill pty if still running
      if (ctx.session.status === 'live') {
        try {
          ctx.pty.kill()
        } catch {
          // pty may already be dead
        }
      }

      // Clear timers
      if (ctx.storageDebounceTimer) {
        clearTimeout(ctx.storageDebounceTimer)
      }

      // Close all attached clients
      for (const client of ctx.clients) {
        try {
          client.close()
        } catch {
          // client may already be closed
        }
      }

      // Remove from in-memory map
      this.sessions.delete(sessionId)
    }

    // Delete from storage
    await this.storage.deleteSession(sessionId)
  }

  // -----------------------------------------------------------------------
  // 4.1.7 — shutdown
  // -----------------------------------------------------------------------

  async shutdown(): Promise<void> {
    const sessionIds = [...this.sessions.keys()]

    for (const sessionId of sessionIds) {
      const ctx = this.sessions.get(sessionId)
      if (!ctx) continue

      // Clear timers
      if (ctx.storageDebounceTimer) {
        clearTimeout(ctx.storageDebounceTimer)
        ctx.storageDebounceTimer = null
      }

      // Flush any pending storage writes
      if (ctx.pendingMessage) {
        try {
          await this.storage.appendMessage(sessionId, ctx.pendingMessage)
        } catch (err) {
          log.error('session', `Failed to flush pending message for session ${sessionId}`, err)
        }
        ctx.pendingMessage = null
      }

      // Kill pty
      if (ctx.session.status === 'live') {
        try {
          ctx.pty.kill()
        } catch {
          // pty may already be dead
        }

        // Archive the session
        ctx.session.status = 'archived'
        try {
          await this.storage.updateSessionStatus(sessionId, 'archived')
        } catch (err) {
          log.error('session', `Failed to archive session ${sessionId} during shutdown`, err)
        }
      }

      // Close all attached clients
      for (const client of ctx.clients) {
        try {
          client.close()
        } catch {
          // client may already be closed
        }
      }
    }

    this.sessions.clear()
  }

  // -----------------------------------------------------------------------
  // Finalize streaming message helper
  // -----------------------------------------------------------------------

  /**
   * If there's an in-progress streaming message, mark it complete,
   * flush to storage, and broadcast the final state.
   * Returns the finalized message, or null if there was nothing to finalize.
   */
  private finalizeCurrentMessage(sessionId: string): ChatMessage | null {
    const ctx = this.sessions.get(sessionId)
    if (!ctx?.currentMessage || ctx.currentMessage.status !== 'streaming') return null

    ctx.currentMessage.status = 'complete'
    this.flushPendingMessage(sessionId, ctx.currentMessage)
    this.broadcast(sessionId, { type: 'message', data: ctx.currentMessage })
    const finalized = ctx.currentMessage
    ctx.currentMessage = null
    return finalized
  }

  // -----------------------------------------------------------------------
  // Storage write debouncing (500ms or on message completion)
  // -----------------------------------------------------------------------

  /**
   * Debounce storage writes for streaming messages. Buffers the pending
   * message and sets a 500ms timer. On timer fire, flushes to disk.
   * On message_complete, flushPendingMessage is called directly for
   * immediate persistence.
   */
  private debounceStorageWrite(sessionId: string, message: ChatMessage): void {
    const ctx = this.sessions.get(sessionId)
    if (!ctx) return

    ctx.pendingMessage = message

    if (ctx.storageDebounceTimer) {
      clearTimeout(ctx.storageDebounceTimer)
    }

    ctx.storageDebounceTimer = setTimeout(() => {
      ctx.storageDebounceTimer = null
      if (ctx.pendingMessage) {
        this.storage.appendMessage(sessionId, ctx.pendingMessage).catch((err) => {
          log.error('session', `Failed to flush debounced message for session ${sessionId}`, err)
        })
        ctx.pendingMessage = null
      }
    }, STORAGE_DEBOUNCE_MS)
  }

  /**
   * Immediately flush a pending message to storage, cancelling any
   * debounce timer. Called on message_complete and prompt_detected.
   */
  private flushPendingMessage(sessionId: string, message: ChatMessage): void {
    const ctx = this.sessions.get(sessionId)
    if (!ctx) return

    // Cancel any pending debounce timer
    if (ctx.storageDebounceTimer) {
      clearTimeout(ctx.storageDebounceTimer)
      ctx.storageDebounceTimer = null
    }

    ctx.pendingMessage = null

    this.storage.appendMessage(sessionId, message).catch((err) => {
      log.error('session', `Failed to persist message for session ${sessionId}`, err)
    })
  }

  // -----------------------------------------------------------------------
  // Broadcast helper
  // -----------------------------------------------------------------------

  /**
   * Send a JSON message to all WebSocket clients attached to a session.
   */
  private broadcast(
    sessionId: string,
    message: { type: string; data: unknown },
  ): void {
    const ctx = this.sessions.get(sessionId)
    if (!ctx) return

    const payload = JSON.stringify(message)
    for (const client of ctx.clients) {
      try {
        client.send(payload)
      } catch {
        // Client may have disconnected; will be cleaned up on close event
      }
    }
  }
}
