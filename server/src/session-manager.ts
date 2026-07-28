import { randomUUID } from 'crypto'
import { readdir, readFile } from 'fs/promises'
import { existsSync } from 'fs'
import { spawn, type ChildProcess } from 'child_process'
import path from 'path'
import * as pty from 'node-pty'
import type { WebSocket } from 'ws'

import type {
  ProviderType,
  Session,
  SessionMeta,
  ChatMessage,
  Attachment,
  ModelState,
  ModelOption,
} from './schemas.js'
import type { IStorageLayer } from './storage.js'
import type { ICLIAdapter } from './adapters/types.js'
import { type AdapterEvent, validateAdapterEvents } from './adapters/types.js'
import { getAdapter } from './adapters/registry.js'
import { stripAnsi } from './adapters/strip-ansi.js'
import { AcpSessionDriver } from './acp/driver.js'
import type { TurnNotifier } from './push.js'
import { log } from './logger.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Internal tracking state for each active (live) session.
 */
export interface SessionContext {
  session: Session
  /** PTY process — only used for interactive (legacy) adapters. */
  pty: pty.IPty | null
  /** Child process — only used for non-interactive adapters (current message). */
  childProcess: ChildProcess | null
  /** ACP driver — only used for adapters with transport === 'acp'. */
  acpDriver: AcpSessionDriver | null
  adapter: ICLIAdapter
  clients: Set<WebSocket>
  currentMessage: ChatMessage | null
  storageDebounceTimer: ReturnType<typeof setTimeout> | null
  pendingMessage: ChatMessage | null
  /** The project path for this session (needed for spawning per-message processes). */
  projectPath: string
  /** True while a CLI turn is in flight (queueable transports only). */
  busy?: boolean
  /** Pending user inputs waiting for the current turn to finish. */
  inputQueue?: QueuedInput[]
  /** Timestamp of the last "dropped events" notice, for throttling. */
  lastDropNoticeAt?: number
  /** ID of the last assistant message we sent a push notification for. */
  lastNotifiedMessageId?: string
  /** Models the provider advertised for this session (ACP). Empty if unknown. */
  availableModels?: ModelOption[]
  /** Model the agent reports it's actually running (vs. the user's selection). */
  currentModel?: string
  /** True when revive couldn't restore CLI context (missing cliSessionId or loadSession failed). */
  contextLost?: boolean
}

interface QueuedInput {
  text: string
  attachments?: Attachment[]
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
  handleInput(sessionId: string, text: string, attachments?: Attachment[]): void
  cancelTurn(sessionId: string): void
  restartSession(sessionId: string): Promise<void>
  setModel(sessionId: string, model: string): void
  getModelState(sessionId: string): ModelState | null
  reviveSession(sessionId: string, archivedSession: Session): Promise<Session>
  shutdown(): Promise<void>
}

// ---------------------------------------------------------------------------
// SessionManager
// ---------------------------------------------------------------------------

/** Storage write debounce interval in milliseconds. */
const STORAGE_DEBOUNCE_MS = 500

/** Delay before sending the system prompt to let the CLI initialize. */
export const SYSTEM_PROMPT_DELAY_MS = 3000

export class SessionManager implements ISessionManager {
  private readonly sessions = new Map<string, SessionContext>()
  private readonly storage: IStorageLayer
  /** Optional notifier invoked when an assistant turn completes (push). */
  private readonly notifier: TurnNotifier | null

  constructor(storage: IStorageLayer, notifier?: TurnNotifier) {
    this.storage = storage
    this.notifier = notifier ?? null
  }

  // -----------------------------------------------------------------------
  // createSession
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

    if (adapter.transport === 'acp') {
      // ACP mode: spawn a persistent `kiro-cli acp` process now and create
      // an ACP session. Output is structured JSON-RPC, parsed by the driver.
      const ctx: SessionContext = {
        session,
        pty: null,
        childProcess: null,
        acpDriver: null,
        adapter,
        clients: new Set(),
        currentMessage: null,
        storageDebounceTimer: null,
        pendingMessage: null,
        projectPath: project.path,
      }

      this.sessions.set(session.id, ctx)
      await this.storage.saveSession(session)
      await this.startAcpDriver(session.id, ctx)

      return session
    }

    if (adapter.nonInteractive) {
      // Non-interactive mode: no process spawned at creation time.
      // Each message will spawn its own short-lived process.
      const ctx: SessionContext = {
        session,
        pty: null,
        childProcess: null,
        acpDriver: null,
        adapter,
        clients: new Set(),
        currentMessage: null,
        storageDebounceTimer: null,
        pendingMessage: null,
        projectPath: project.path,
      }

      this.sessions.set(session.id, ctx)
      await this.storage.saveSession(session)

      return session
    }

    // --- Interactive (PTY) mode — legacy path for future providers ---

    // Snapshot CLI session directory before spawning
    const preSpawnSessionFiles = await this.snapshotCliSessionDir(adapter)

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

    const ctx: SessionContext = {
      session,
      pty: ptyProcess,
      childProcess: null,
      acpDriver: null,
      adapter,
      clients: new Set(),
      currentMessage: null,
      storageDebounceTimer: null,
      pendingMessage: null,
      projectPath: project.path,
    }

    this.sessions.set(session.id, ctx)
    await this.storage.saveSession(session)

    this.wirePtyToSession(session.id, ctx)
    this.scheduleSystemPrompt(session.id, adapter)
    this.detectAndStoreCliSessionId(session.id, adapter, preSpawnSessionFiles, project.path)

    return session
  }

  // -----------------------------------------------------------------------
  // reviveSession
  // -----------------------------------------------------------------------

  async reviveSession(
    sessionId: string,
    archivedSession: Session,
  ): Promise<Session> {
    const existing = this.sessions.get(sessionId)
    if (existing && existing.session.status === 'live') {
      return existing.session
    }

    if (existing) {
      if (existing.storageDebounceTimer) {
        clearTimeout(existing.storageDebounceTimer)
      }
      this.sessions.delete(sessionId)
    }

    const project = await this.storage.getProject(archivedSession.projectId)
    if (!project) {
      throw new Error('Project not found — it may have been removed')
    }

    const adapter = getAdapter(archivedSession.provider)
    if (!adapter) {
      throw new Error(`No adapter registered for provider "${archivedSession.provider}"`)
    }

    const now = Date.now()
    const session: Session = {
      ...archivedSession,
      status: 'live',
      updatedAt: now,
    }

    if (adapter.transport === 'acp') {
      // ACP revive: spawn a fresh agent and load the existing CLI session.
      const ctx: SessionContext = {
        session,
        pty: null,
        childProcess: null,
        acpDriver: null,
        adapter,
        clients: new Set(),
        currentMessage: null,
        storageDebounceTimer: null,
        pendingMessage: null,
        projectPath: project.path,
      }

      this.sessions.set(sessionId, ctx)
      await this.storage.updateSessionStatus(sessionId, 'live')
      await this.startAcpDriver(sessionId, ctx, archivedSession.cliSessionId ?? null)

      return session
    }

    if (adapter.nonInteractive) {
      // Non-interactive: just re-register the session, no process needed
      const ctx: SessionContext = {
        session,
        pty: null,
        childProcess: null,
        acpDriver: null,
        adapter,
        clients: new Set(),
        currentMessage: null,
        storageDebounceTimer: null,
        pendingMessage: null,
        projectPath: project.path,
      }

      this.sessions.set(sessionId, ctx)
      await this.storage.updateSessionStatus(sessionId, 'live')

      return session
    }

    // --- Interactive (PTY) mode ---
    const resumeCmd = adapter.getResumeCommand(archivedSession.cliSessionId ?? null)
    const shell = resumeCmd ? resumeCmd.command : adapter.command
    const args = resumeCmd ? resumeCmd.args : adapter.args
    log.info('session', `Reviving session ${sessionId}: ${shell} ${args.join(' ')} in ${project.path}`)
    const ptyProcess = pty.spawn(shell, args, {
      name: 'xterm-256color',
      cols: 120,
      rows: 40,
      cwd: project.path,
      env: { ...process.env } as Record<string, string>,
    })

    const ctx: SessionContext = {
      session,
      pty: ptyProcess,
      childProcess: null,
      acpDriver: null,
      adapter,
      clients: new Set(),
      currentMessage: null,
      storageDebounceTimer: null,
      pendingMessage: null,
      projectPath: project.path,
    }

    this.sessions.set(sessionId, ctx)
    await this.storage.updateSessionStatus(sessionId, 'live')

    this.wirePtyToSession(sessionId, ctx)
    if (!resumeCmd) {
      this.scheduleSystemPrompt(sessionId, adapter)
    }

    return session
  }

  // -----------------------------------------------------------------------
  // handleInput
  // -----------------------------------------------------------------------

  handleInput(sessionId: string, text: string, attachments?: Attachment[]): void {
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

    log.info('session', `handleInput: session ${sessionId}: "${text}"`)
    if (attachments?.length) {
      log.info('session', `handleInput: ${attachments.length} attachment(s): ${attachments.map(a => a.filename).join(', ')}`)
    }

    // Create and broadcast the user message immediately (even if it will be
    // queued behind an in-flight turn — the user sees their message land).
    const userMessage: ChatMessage = {
      id: randomUUID(),
      role: 'user',
      content: text,
      timestamp: Date.now(),
      status: 'complete',
      ...(attachments?.length ? { attachments } : {}),
    }

    ctx.session.messages.push(userMessage)
    ctx.session.updatedAt = userMessage.timestamp

    this.storage.appendMessage(sessionId, userMessage).catch((err) => {
      log.error('session', `Failed to persist user message for session ${sessionId}`, err)
    })

    this.broadcast(sessionId, { type: 'message', data: userMessage })

    // Legacy interactive PTY path has no per-turn completion signal wired to
    // the queue, so dispatch it directly (preserves prior behavior).
    const queueable = ctx.adapter.transport === 'acp' || ctx.adapter.nonInteractive
    if (!queueable) {
      this.finalizeCurrentMessage(sessionId)
      this.handleInteractiveInput(sessionId, ctx, text, attachments)
      return
    }

    // Queue the input; the pump dispatches one turn at a time so a message
    // sent while the CLI is busy waits instead of killing the in-flight turn.
    ;(ctx.inputQueue ??= []).push({ text, attachments })
    this.pumpQueue(sessionId)
  }

  /**
   * Dispatch the next queued input if the session isn't already mid-turn.
   * Called after each input arrives and whenever a turn completes.
   */
  private pumpQueue(sessionId: string): void {
    const ctx = this.sessions.get(sessionId)
    if (!ctx || ctx.busy) return

    const queue = (ctx.inputQueue ??= [])
    const next = queue.shift()
    if (!next) return

    ctx.busy = true
    this.finalizeCurrentMessage(sessionId)

    if (ctx.adapter.transport === 'acp') {
      this.handleAcpInput(sessionId, ctx, next.text, next.attachments)
    } else {
      this.handleNonInteractiveInput(sessionId, ctx, next.text, next.attachments)
    }
  }

  /** Mark the current turn finished and dispatch the next queued input, if any. */
  private finishTurn(sessionId: string): void {
    const ctx = this.sessions.get(sessionId)
    if (!ctx) return
    ctx.busy = false

    // Notify (push) when a turn produced a fresh assistant message. Dedup by
    // message id so we don't re-notify, and skip when the turn ended in a
    // non-assistant message (e.g. an error) or was cancelled (cancel doesn't
    // call finishTurn). Only notify when nothing else is queued — the user is
    // genuinely waiting on this result.
    if (this.notifier && (!ctx.inputQueue || ctx.inputQueue.length === 0)) {
      const last = ctx.session.messages.findLast((m) => m.role === 'assistant')
      log.info('push', `finishTurn: last assistant msg id=${last?.id ?? 'none'}, lastNotified=${ctx.lastNotifiedMessageId ?? 'none'}`)
      if (last && last.id !== ctx.lastNotifiedMessageId) {
        ctx.lastNotifiedMessageId = last.id
        try {
          this.notifier.notifyTurnComplete(ctx.session, last.content)
        } catch (err) {
          log.warn('session', `notifyTurnComplete failed: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
    }

    this.pumpQueue(sessionId)
  }

  /**
   * Cancel the in-flight turn (the Stop button). Stops the current CLI work,
   * drains any queued inputs, finalizes the streaming message, and returns the
   * session to idle. Safe to call when nothing is running.
   */
  cancelTurn(sessionId: string): void {
    const ctx = this.sessions.get(sessionId)
    if (!ctx) return

    log.info('session', `cancelTurn: session ${sessionId}`)

    // Drop anything queued so cancel means "stop", not "stop then continue".
    ctx.inputQueue = []

    if (ctx.adapter.transport === 'acp') {
      ctx.acpDriver?.cancel()
    } else if (ctx.childProcess) {
      try { ctx.childProcess.kill() } catch { /* already dead */ }
      ctx.childProcess = null
    }

    this.finalizeCurrentMessage(sessionId)
    ctx.currentMessage = null

    // Non-ACP processes emit 'close' which calls finishTurn; for ACP (cancel is
    // a fire-and-forget notification) clear busy now so the UI returns to idle.
    ctx.busy = false
    this.broadcast(sessionId, { type: 'status', data: 'idle' })
  }

  // -----------------------------------------------------------------------
  // restartSession — kill the CLI process and respawn a fresh one
  // -----------------------------------------------------------------------

  async restartSession(sessionId: string): Promise<void> {
    const ctx = this.sessions.get(sessionId)
    if (!ctx) throw new Error(`Session ${sessionId} not found`)

    log.info('session', `Restarting CLI for session ${sessionId}`)

    // 1. Cancel any in-flight work and drain the queue
    ctx.inputQueue = []
    ctx.busy = false

    // 2. Kill the existing process
    if (ctx.adapter.transport === 'acp') {
      if (ctx.acpDriver) {
        try { ctx.acpDriver.dispose() } catch { /* already dead */ }
        ctx.acpDriver = null
      }
    } else if (ctx.childProcess) {
      try { ctx.childProcess.kill() } catch { /* already dead */ }
      ctx.childProcess = null
    } else if (ctx.pty) {
      try { ctx.pty.kill() } catch { /* already dead */ }
      ctx.pty = null
    }

    // Finalize any streaming message
    this.finalizeCurrentMessage(sessionId)
    ctx.currentMessage = null

    // 3. Emit a system message so the user knows what happened
    this.emitSystemMessage(sessionId, ctx, 'CLI restarted.')

    // 4. Respawn
    if (ctx.adapter.transport === 'acp') {
      await this.startAcpDriver(sessionId, ctx, ctx.session.cliSessionId ?? null)
    } else if (ctx.adapter.nonInteractive) {
      // Nothing to spawn — non-interactive adapters spawn per-message
    } else {
      // Interactive (PTY) mode
      const resumeCmd = ctx.adapter.getResumeCommand(ctx.session.cliSessionId ?? null)
      const shell = resumeCmd ? resumeCmd.command : ctx.adapter.command
      const args = resumeCmd ? resumeCmd.args : ctx.adapter.args
      log.info('session', `Respawning PTY: ${shell} ${args.join(' ')} in ${ctx.projectPath}`)
      const ptyProcess = pty.spawn(shell, args, {
        name: 'xterm-256color',
        cols: 120,
        rows: 40,
        cwd: ctx.projectPath,
        env: { ...process.env } as Record<string, string>,
      })
      ctx.pty = ptyProcess
      this.wirePtyToSession(sessionId, ctx)
      if (!resumeCmd) {
        this.scheduleSystemPrompt(sessionId, ctx.adapter)
      }
    }

    // 5. Tell clients we're idle and ready
    this.broadcast(sessionId, { type: 'status', data: 'idle' })
  }

  // -----------------------------------------------------------------------
  // Model selection
  // -----------------------------------------------------------------------

  /** Build the current model state for a session (available list + selection). */
  getModelState(sessionId: string): ModelState | null {
    const ctx = this.sessions.get(sessionId)
    if (!ctx) return null
    // Prefer the dynamically discovered list (ACP); otherwise offer the
    // adapter's suggested aliases (Claude). Current = the user's explicit
    // selection, falling back to whatever the agent reports running.
    const available =
      ctx.availableModels && ctx.availableModels.length > 0
        ? ctx.availableModels
        : ctx.adapter.suggestedModels ?? []
    return { available, current: ctx.session.model ?? ctx.currentModel ?? null }
  }

  /**
   * Select a model for a session. Persists the choice (applied per-message for
   * one-shot adapters like Claude via `--model`) and, for ACP adapters, asks
   * the live agent to switch immediately.
   */
  setModel(sessionId: string, model: string): void {
    const ctx = this.sessions.get(sessionId)
    if (!ctx) throw new Error(`Session ${sessionId} not found`)

    ctx.session.model = model
    this.storage.saveSession(ctx.session).catch((err) => {
      log.error('session', `Failed to persist model for session ${sessionId}`, err)
    })

    if (ctx.adapter.transport === 'acp' && ctx.acpDriver) {
      ctx.acpDriver.setModel(model).catch((err) => {
        const message = err instanceof Error ? err.message : String(err)
        log.warn('session', `setModel failed for session ${sessionId}: ${message}`)
        this.emitSystemMessage(sessionId, ctx, `Couldn't switch model: ${message}`)
      })
    }

    this.broadcastModelState(sessionId)
  }

  private broadcastModelState(sessionId: string): void {
    const state = this.getModelState(sessionId)
    if (state) this.broadcast(sessionId, { type: 'model_state', data: state })
  }

  // -----------------------------------------------------------------------
  // ACP transport (persistent JSON-RPC agent process)
  // -----------------------------------------------------------------------

  /**
   * Create and start an AcpSessionDriver for a session. Wires the driver's
   * structured events back into the same processAdapterEvents pipeline the
   * other transports use. On failure, surfaces a system message.
   */
  private async startAcpDriver(
    sessionId: string,
    ctx: SessionContext,
    resumeSessionId: string | null = null,
  ): Promise<void> {
    const driver = new AcpSessionDriver({
      binary: ctx.adapter.command,
      cwd: ctx.projectPath,
      profile: ctx.adapter.acpProfile,
      callbacks: {
        onEvent: (event) => {
          const valid = validateAdapterEvents([event], (msg) => log.warn('adapter', msg))
          if (valid.length === 0) this.surfaceDroppedEvents(sessionId, ctx, 1)
          else this.processAdapterEvents(sessionId, valid)
        },
        onIdle: () => {
          this.finalizeCurrentMessage(sessionId)
          this.broadcast(sessionId, { type: 'status', data: 'idle' })
          this.finishTurn(sessionId)
        },
        onError: (err) => {
          log.error('session', `ACP driver error for session ${sessionId}`, err)
          this.emitSystemMessage(sessionId, ctx, `CLI error: ${err.message}`)
          this.broadcast(sessionId, { type: 'status', data: 'idle' })
          this.finishTurn(sessionId)
        },
        onSessionId: (id) => {
          ctx.session.cliSessionId = id
          this.storage.saveSession(ctx.session).catch((e) => {
            log.error('session', `Failed to persist CLI session ID for session ${sessionId}`, e)
          })
        },
      },
    })

    ctx.acpDriver = driver

    try {
      await driver.start(resumeSessionId)
      log.info('session', `ACP session ready for ${sessionId} (cliSessionId: ${ctx.session.cliSessionId ?? 'pending'})`)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log.error('session', `Failed to start ACP session for ${sessionId}: ${message}`)
      this.emitSystemMessage(sessionId, ctx, `Failed to start CLI session: ${message}`)
    }
  }

  private handleAcpInput(
    sessionId: string,
    ctx: SessionContext,
    text: string,
    attachments?: Attachment[],
  ): void {
    const driver = ctx.acpDriver
    if (!driver) {
      this.emitSystemMessage(sessionId, ctx, 'CLI session is not ready yet. Try again in a moment.')
      this.finishTurn(sessionId)
      return
    }

    this.broadcast(sessionId, { type: 'status', data: 'typing' })

    const resourcePaths = attachments?.map((a) => a.path) ?? []
    driver.prompt(text, resourcePaths).catch((err) => {
      const message = err instanceof Error ? err.message : String(err)
      log.error('session', `ACP prompt failed for session ${sessionId}: ${message}`)
      this.emitSystemMessage(sessionId, ctx, `CLI error: ${message}`)
      this.broadcast(sessionId, { type: 'status', data: 'idle' })
    })
  }

  /** Append + broadcast a system message (used for ACP errors). */
  private emitSystemMessage(sessionId: string, ctx: SessionContext, content: string): void {
    const msg: ChatMessage = {
      id: randomUUID(),
      role: 'system',
      content,
      timestamp: Date.now(),
      status: 'complete',
    }
    ctx.session.messages.push(msg)
    this.storage.appendMessage(sessionId, msg).catch(() => {})
    this.broadcast(sessionId, { type: 'message', data: msg })
  }

  // -----------------------------------------------------------------------
  // Non-interactive input (spawn per message)
  // -----------------------------------------------------------------------

  private handleNonInteractiveInput(
    sessionId: string,
    ctx: SessionContext,
    text: string,
    attachments?: Attachment[],
  ): void {
    const adapter = ctx.adapter

    if (!adapter.buildMessageCommand) {
      log.error('session', `Adapter for ${adapter.provider} is non-interactive but missing buildMessageCommand`)
      throw new Error('Adapter configuration error')
    }

    // Kill any still-running child process from a previous message
    if (ctx.childProcess) {
      try { ctx.childProcess.kill() } catch { /* already dead */ }
      ctx.childProcess = null
    }

    const isFirstMessage = !ctx.session.cliSessionId

    const attachmentRefs = attachments?.map(a => ({ path: a.path, mimeType: a.mimeType }))
    const { command, args } = adapter.buildMessageCommand!(
      text,
      ctx.session.cliSessionId ?? null,
      attachmentRefs,
      ctx.session.model ?? null,
    )

    log.info('session', `Spawning: ${command} ${args.join(' ')} in ${ctx.projectPath}`)

    const child = spawn(command, args, {
      cwd: ctx.projectPath,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    })

    ctx.childProcess = child

    // Signal typing status
    this.broadcast(sessionId, { type: 'status', data: 'typing' })

    // Buffer for partial lines
    let stdoutBuffer = ''

    child.stdout?.on('data', (data: Buffer) => {
      // Strip ANSI escape codes (CLI still emits colors in non-interactive mode)
      const clean = stripAnsi(data.toString())
      stdoutBuffer += clean

      // Process complete lines, keep the last partial line in the buffer
      const lines = stdoutBuffer.split('\n')
      stdoutBuffer = lines.pop() ?? ''

      for (const line of lines) {
        this.processNonInteractiveLine(sessionId, ctx, line)
      }
    })

    // Capture stderr — parse for credits, log the rest
    child.stderr?.on('data', (data: Buffer) => {
      const text = data.toString()

      // Parse stderr for credits (Kiro CLI sends credits to stderr)
      if (adapter.onStderr) {
        const stderrEvents = adapter.onStderr(text)
        if (stderrEvents.length > 0) {
          const validEvents = validateAdapterEvents(stderrEvents, (msg) => {
            log.warn('adapter', msg)
          })
          if (validEvents.length > 0) {
            this.processAdapterEvents(sessionId, validEvents)
          }
        }
      }

      // Log non-empty stderr for debugging (skip known noise)
      const trimmed = text.trim()
      if (trimmed.length > 0 && !trimmed.includes('Credits:') && !trimmed.includes('trusted')) {
        log.debug('cli-stderr', trimmed)
      }
    })

    child.on('close', (exitCode) => {
      // Process any remaining buffered content
      if (stdoutBuffer.trim().length > 0) {
        this.processNonInteractiveLine(sessionId, ctx, stdoutBuffer)
        stdoutBuffer = ''
      }

      ctx.childProcess = null

      // Finalize the current streaming message
      this.finalizeCurrentMessage(sessionId)

      // Signal idle
      this.broadcast(sessionId, { type: 'status', data: 'idle' })

      log.info('session', `CLI process exited with code ${exitCode} for session ${sessionId}`)

      // Detect CLI session ID after first message — only for adapters that
      // rely on a session-list scrape (Kiro non-interactive). Adapters that
      // report their session ID inline (cli_session event) skip this.
      if (isFirstMessage && ctx.adapter.usesSessionListDetection && !ctx.session.cliSessionId) {
        this.detectCliSessionIdFromList(sessionId, ctx)
      }

      // Turn finished — dispatch the next queued input, if any.
      this.finishTurn(sessionId)
    })

    child.on('error', (err) => {
      log.error('session', `CLI process error for session ${sessionId}`, err)
      ctx.childProcess = null

      // Send error as system message
      const errorMsg: ChatMessage = {
        id: randomUUID(),
        role: 'system',
        content: `CLI error: ${err.message}`,
        timestamp: Date.now(),
        status: 'complete',
      }
      ctx.session.messages.push(errorMsg)
      this.storage.appendMessage(sessionId, errorMsg).catch(() => {})
      this.broadcast(sessionId, { type: 'message', data: errorMsg })
      this.broadcast(sessionId, { type: 'status', data: 'idle' })
      this.finishTurn(sessionId)
    })
  }

  /**
   * Process a single line of stdout from a non-interactive CLI process.
   */
  private processNonInteractiveLine(
    sessionId: string,
    ctx: SessionContext,
    line: string,
  ): void {
    const rawEvents = ctx.adapter.onData(line)
    if (rawEvents.length === 0) return

    const events = validateAdapterEvents(rawEvents, (msg) => {
      log.warn('adapter', msg)
    })

    const dropped = rawEvents.length - events.length
    if (dropped > 0) this.surfaceDroppedEvents(sessionId, ctx, dropped)

    if (events.length === 0) return

    this.processAdapterEvents(sessionId, events)
  }

  /** Throttled per-session notice when the adapter produced events we couldn't validate. */
  private surfaceDroppedEvents(sessionId: string, ctx: SessionContext, dropped: number): void {
    const now = Date.now()
    const DROP_NOTICE_THROTTLE_MS = 10_000
    if (ctx.lastDropNoticeAt && now - ctx.lastDropNoticeAt < DROP_NOTICE_THROTTLE_MS) return
    ctx.lastDropNoticeAt = now
    log.warn('session', `Dropped ${dropped} unparseable event(s) for session ${sessionId}`)
    this.emitSystemMessage(
      sessionId,
      ctx,
      `⚠️ Some CLI output couldn't be parsed and was skipped (${dropped} event${dropped === 1 ? '' : 's'}). The response may be incomplete.`,
    )
  }

  // -----------------------------------------------------------------------
  // Interactive input (legacy PTY mode)
  // -----------------------------------------------------------------------

  private handleInteractiveInput(
    sessionId: string,
    ctx: SessionContext,
    text: string,
    attachments?: Attachment[],
  ): void {
    let cliPrompt = text
    if (attachments?.length) {
      const refs = attachments.map(a => ctx.adapter.formatAttachment(a.path, a.mimeType))
      cliPrompt = refs.join(' ') + ' ' + text
    }

    ctx.adapter.notifyUserInput(cliPrompt)
    ctx.pty!.write(cliPrompt + '\r')
  }

  // -----------------------------------------------------------------------
  // processAdapterEvents
  // -----------------------------------------------------------------------

  processAdapterEvents(sessionId: string, events: AdapterEvent[]): void {
    const ctx = this.sessions.get(sessionId)
    if (!ctx) return

    for (const event of events) {
      switch (event.type) {
        case 'chunk': {
          const needsNewMessage =
            !ctx.currentMessage ||
            ctx.currentMessage.status === 'complete' ||
            ctx.currentMessage.role !== event.role

          if (needsNewMessage) {
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
            ctx.currentMessage!.content += '\n' + event.content
            this.broadcast(sessionId, { type: 'message', data: ctx.currentMessage })
          }

          this.debounceStorageWrite(sessionId, ctx.currentMessage!)
          break
        }

        case 'message_complete': {
          if (ctx.currentMessage && ctx.currentMessage.status === 'streaming') {
            if (event.metadata) {
              ctx.currentMessage.metadata = {
                ...ctx.currentMessage.metadata,
                ...event.metadata,
              }
            }
            this.finalizeCurrentMessage(sessionId)
          }
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
          this.finalizeCurrentMessage(sessionId)
          ctx.currentMessage = null

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
          this.broadcast(sessionId, { type: 'status', data: 'idle' })
          break
        }

        case 'thinking': {
          this.broadcast(sessionId, { type: 'status', data: 'typing' })
          break
        }

        case 'cli_session': {
          // The CLI reported its own session ID inline (e.g. Claude Code
          // stream-json `session_id`). Persist it for resume on reconnect.
          if (ctx.session.cliSessionId !== event.sessionId) {
            ctx.session.cliSessionId = event.sessionId
            this.storage.saveSession(ctx.session).catch((err) => {
              log.error('session', `Failed to persist CLI session ID for session ${sessionId}`, err)
            })
          }
          break
        }

        case 'model_info': {
          // Track what the agent advertises/runs separately from the user's
          // explicit selection (ctx.session.model), so a CLI echoing its
          // default never clobbers a deliberate choice.
          if (event.available) ctx.availableModels = event.available
          if (event.current) ctx.currentModel = event.current
          this.broadcastModelState(sessionId)
          break
        }
      }
    }
  }

  // -----------------------------------------------------------------------
  // attachClient / detachClient
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
  // getSession, listSessions, deleteSession
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
      // Kill pty or child process if still running
      if (ctx.pty) {
        try { ctx.pty.kill() } catch { /* already dead */ }
      }
      if (ctx.childProcess) {
        try { ctx.childProcess.kill() } catch { /* already dead */ }
      }
      if (ctx.acpDriver) {
        try { ctx.acpDriver.dispose() } catch { /* already disposed */ }
      }

      if (ctx.storageDebounceTimer) {
        clearTimeout(ctx.storageDebounceTimer)
      }

      for (const client of ctx.clients) {
        try { client.close() } catch { /* already closed */ }
      }

      this.sessions.delete(sessionId)
    }

    await this.storage.deleteSession(sessionId)
  }

  // -----------------------------------------------------------------------
  // shutdown
  // -----------------------------------------------------------------------

  async shutdown(): Promise<void> {
    const sessionIds = [...this.sessions.keys()]

    for (const sessionId of sessionIds) {
      const ctx = this.sessions.get(sessionId)
      if (!ctx) continue

      if (ctx.storageDebounceTimer) {
        clearTimeout(ctx.storageDebounceTimer)
        ctx.storageDebounceTimer = null
      }

      if (ctx.pendingMessage) {
        try {
          await this.storage.appendMessage(sessionId, ctx.pendingMessage)
        } catch (err) {
          log.error('session', `Failed to flush pending message for session ${sessionId}`, err)
        }
        ctx.pendingMessage = null
      }

      if (ctx.session.status === 'live') {
        if (ctx.pty) {
          try { ctx.pty.kill() } catch { /* already dead */ }
        }
        if (ctx.childProcess) {
          try { ctx.childProcess.kill() } catch { /* already dead */ }
        }
        if (ctx.acpDriver) {
          try { ctx.acpDriver.dispose() } catch { /* already disposed */ }
        }

        ctx.session.status = 'archived'
        try {
          await this.storage.updateSessionStatus(sessionId, 'archived')
        } catch (err) {
          log.error('session', `Failed to archive session ${sessionId} during shutdown`, err)
        }
      }

      for (const client of ctx.clients) {
        try { client.close() } catch { /* already closed */ }
      }
    }

    this.sessions.clear()
  }

  // -----------------------------------------------------------------------
  // PTY wiring (interactive mode only)
  // -----------------------------------------------------------------------

  private wirePtyToSession(sessionId: string, ctx: SessionContext): void {
    const { pty: ptyProcess, adapter } = ctx
    if (!ptyProcess) return

    ptyProcess.onData((data: string) => {
      const cleanText = stripAnsi(data)
      if (cleanText.trim().length === 0) return
      log.debug('pty', `clean: ${JSON.stringify(cleanText).slice(0, 300)}`)
      const rawEvents = adapter.onData(cleanText)
      if (rawEvents.length === 0) return

      const events = validateAdapterEvents(rawEvents, (msg) => {
        log.warn('adapter', msg)
      })

      const dropped = rawEvents.length - events.length
      if (dropped > 0) this.surfaceDroppedEvents(sessionId, ctx, dropped)

      if (events.length === 0) return

      const significantEvents = events.filter(e => e.type !== 'chunk')
      if (significantEvents.length > 0) {
        log.info('adapter', `${significantEvents.map(e => e.type).join(', ')}`)
      }
      this.processAdapterEvents(sessionId, events)
    })

    ptyProcess.onExit(({ exitCode }) => {
      ctx.session.status = 'archived'
      this.finalizeCurrentMessage(sessionId)

      if (ctx.storageDebounceTimer) {
        clearTimeout(ctx.storageDebounceTimer)
        ctx.storageDebounceTimer = null
      }

      this.storage.updateSessionStatus(sessionId, 'archived').catch((err) => {
        log.error('session', `Failed to archive session ${sessionId}`, err)
      })

      const exitMsg: ChatMessage = {
        id: randomUUID(),
        role: 'system',
        content: `CLI process exited with code ${exitCode ?? 'unknown'}`,
        timestamp: Date.now(),
        status: 'complete',
      }
      ctx.session.messages.push(exitMsg)
      this.storage.appendMessage(sessionId, exitMsg).catch((err) => {
        log.error('session', `Failed to persist exit message for session ${sessionId}`, err)
      })

      this.broadcast(sessionId, { type: 'message', data: exitMsg })
      this.broadcast(sessionId, { type: 'status', data: 'exited' })
    })
  }

  private scheduleSystemPrompt(sessionId: string, adapter: ICLIAdapter): void {
    if (!adapter.systemPrompt) return
    const systemPrompt = adapter.systemPrompt
    setTimeout(() => {
      const currentCtx = this.sessions.get(sessionId)
      if (currentCtx && currentCtx.session.status === 'live' && currentCtx.pty) {
        log.info('session', `Sending system prompt for session ${sessionId}`)
        currentCtx.adapter.notifySystemInput(systemPrompt)
        currentCtx.pty.write(systemPrompt + '\r')
      }
    }, SYSTEM_PROMPT_DELAY_MS)
  }

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

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

  private flushPendingMessage(sessionId: string, message: ChatMessage): void {
    const ctx = this.sessions.get(sessionId)
    if (!ctx) return

    if (ctx.storageDebounceTimer) {
      clearTimeout(ctx.storageDebounceTimer)
      ctx.storageDebounceTimer = null
    }

    ctx.pendingMessage = null

    this.storage.appendMessage(sessionId, message).catch((err) => {
      log.error('session', `Failed to persist message for session ${sessionId}`, err)
    })
  }

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
        // Client may have disconnected
      }
    }
  }

  // -----------------------------------------------------------------------
  // CLI session ID detection
  // -----------------------------------------------------------------------

  private async snapshotCliSessionDir(adapter: ICLIAdapter): Promise<Set<string>> {
    const dir = adapter.cliSessionDir
    if (!dir || !existsSync(dir)) return new Set()
    try {
      const files = await readdir(dir)
      return new Set(files.filter(f => f.endsWith('.json')))
    } catch {
      return new Set()
    }
  }

  /**
   * Detect the CLI session ID by running `kiro-cli.exe chat --list-sessions`
   * and parsing the most recent session ID from the output.
   *
   * This is used for non-interactive mode where the CLI doesn't store sessions
   * in a predictable file location we can sniff.
   */
  private detectCliSessionIdFromList(sessionId: string, ctx: SessionContext): void {
    const adapter = ctx.adapter

    const child = spawn(adapter.command, ['chat', '--list-sessions'], {
      cwd: ctx.projectPath,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    })

    let output = ''

    child.stdout?.on('data', (data: Buffer) => {
      output += data.toString()
    })

    child.stderr?.on('data', (data: Buffer) => {
      output += data.toString()
    })

    child.on('close', () => {
      // Strip ANSI escape codes before parsing (CLI emits colors in list output)
      const clean = stripAnsi(output)

      // Parse the first "Chat SessionId: <uuid>" from the output
      const match = /Chat SessionId:\s*([a-f0-9-]+)/i.exec(clean)
      if (match) {
        const cliSessionId = match[1]
        log.info('session', `Detected CLI session ID for session ${sessionId}: ${cliSessionId}`)
        ctx.session.cliSessionId = cliSessionId
        this.storage.saveSession(ctx.session).catch((err) => {
          log.error('session', `Failed to persist CLI session ID for session ${sessionId}`, err)
        })
      } else {
        log.warn('session', `Could not detect CLI session ID for session ${sessionId} from --list-sessions output`)
      }
    })

    child.on('error', (err) => {
      log.error('session', `Failed to run --list-sessions for session ${sessionId}`, err)
    })
  }

  private detectAndStoreCliSessionId(
    sessionId: string,
    adapter: ICLIAdapter,
    preSpawnFiles: Set<string>,
    projectPath: string,
  ): void {
    const dir = adapter.cliSessionDir
    if (!dir) return

    const delays = [2000, 4000, 8000]
    let attempt = 0

    const tryDetect = async () => {
      try {
        if (!existsSync(dir)) return

        const currentFiles = await readdir(dir)
        const newFiles = currentFiles.filter(
          f => f.endsWith('.json') && !preSpawnFiles.has(f),
        )

        if (newFiles.length === 0) {
          attempt++
          if (attempt < delays.length) {
            setTimeout(tryDetect, delays[attempt])
          } else {
            log.warn('session', `Could not detect CLI session ID for session ${sessionId} after ${delays.length} attempts`)
          }
          return
        }

        let cliSessionId: string | null = null

        if (newFiles.length === 1) {
          cliSessionId = newFiles[0].replace('.json', '')
        } else {
          for (const file of newFiles) {
            try {
              const content = await readFile(path.join(dir, file), 'utf-8')
              const data = JSON.parse(content)
              if (data.cwd && path.resolve(data.cwd) === path.resolve(projectPath)) {
                cliSessionId = file.replace('.json', '')
                break
              }
            } catch {
              // Skip unreadable files
            }
          }
          if (!cliSessionId) {
            cliSessionId = newFiles[newFiles.length - 1].replace('.json', '')
          }
        }

        if (cliSessionId) {
          log.info('session', `Detected CLI session ID for session ${sessionId}: ${cliSessionId}`)
          const ctx = this.sessions.get(sessionId)
          if (ctx) {
            ctx.session.cliSessionId = cliSessionId
            this.storage.saveSession(ctx.session).catch((err) => {
              log.error('session', `Failed to persist CLI session ID for session ${sessionId}`, err)
            })
          }
        }
      } catch (err) {
        log.error('session', `Error detecting CLI session ID for session ${sessionId}`, err)
      }
    }

    setTimeout(tryDetect, delays[0])
  }
}
