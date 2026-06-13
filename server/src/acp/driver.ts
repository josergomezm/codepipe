/**
 * AcpSessionDriver — owns one persistent `kiro-cli acp` process and exposes a
 * simple prompt/cancel/dispose API that emits CodePipe `AdapterEvent`s.
 *
 * This is the structured-protocol replacement for the spawn-per-message +
 * regex-scrape path in `SessionManager`. The hard parts that used to be
 * guessed — message boundaries, tool calls, session IDs — are now read
 * directly from the protocol.
 *
 * `spawn` is injectable so the whole lifecycle can be unit-tested with an
 * in-memory fake process (see driver.test.ts), no real binary required.
 */

import { spawn as nodeSpawn } from 'child_process'

import type { AdapterEvent } from '../adapters/types.js'
import { AcpClient } from './client.js'
import { LineBuffer } from './jsonrpc.js'
import { translateSessionUpdate, isEndOfTurnResult, parseAcpModels } from './protocol.js'
import type { JsonRpcRequest } from './jsonrpc.js'
import { SPEC_ACP_PROFILE, type AcpProfile } from './profile.js'
import { log } from '../logger.js'

// ── Minimal child-process surface (so tests can fake it) ──────────────────

export interface AcpChildLike {
  stdin: { write(data: string): void } | null
  stdout: NodeJS.EventEmitter | null
  stderr: NodeJS.EventEmitter | null
  on(event: 'close', cb: (code: number | null) => void): void
  on(event: 'error', cb: (err: Error) => void): void
  kill(): void
}

export type AcpSpawnFn = (command: string, args: string[], cwd: string) => AcpChildLike

const defaultSpawn: AcpSpawnFn = (command, args, cwd) =>
  nodeSpawn(command, args, {
    cwd,
    env: { ...process.env },
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: false,
  }) as unknown as AcpChildLike

export interface AcpDriverCallbacks {
  /** Emit a normalized event for the SessionManager to process. */
  onEvent: (event: AdapterEvent) => void
  /** The agent's turn finished (idle). */
  onIdle?: () => void
  /** Fatal error (process error, init failure). */
  onError?: (err: Error) => void
  /** The CLI's own session ID became known (persist for resume). */
  onSessionId?: (id: string) => void
}

export interface AcpDriverOptions {
  binary: string
  cwd: string
  callbacks: AcpDriverCallbacks
  /** Provider ACP dialect (method names, launch args, post-session hook). */
  profile?: AcpProfile
  spawn?: AcpSpawnFn
  protocolVersion?: number
  clientName?: string
  clientVersion?: string
}

/** Pick an "allow" option from an ACP permission request, falling back to the first. */
export function choosePermissionOption(params: unknown): { optionId?: unknown } {
  const options =
    params && typeof params === 'object' && Array.isArray((params as { options?: unknown }).options)
      ? ((params as { options: unknown[] }).options)
      : []
  const allow = options.find(
    (o) => o && typeof o === 'object' && typeof (o as { kind?: unknown }).kind === 'string' &&
      ((o as { kind: string }).kind).toLowerCase().startsWith('allow'),
  ) as { optionId?: unknown } | undefined
  const chosen = allow ?? (options[0] as { optionId?: unknown } | undefined)
  return chosen && typeof chosen === 'object' ? { optionId: chosen.optionId } : {}
}

export class AcpSessionDriver {
  private child: AcpChildLike | null = null
  private client: AcpClient | null = null
  private readonly lineBuffer = new LineBuffer()
  private sessionId: string | null = null
  private readonly opts: Required<Pick<AcpDriverOptions, 'binary' | 'cwd' | 'callbacks'>> & AcpDriverOptions
  private readonly spawnFn: AcpSpawnFn
  private readonly profile: AcpProfile

  constructor(options: AcpDriverOptions) {
    this.opts = options
    this.spawnFn = options.spawn ?? defaultSpawn
    this.profile = options.profile ?? SPEC_ACP_PROFILE
  }

  getSessionId(): string | null {
    return this.sessionId
  }

  /**
   * Spawn the agent, initialize the protocol, and create (or load) a session.
   * @param resumeSessionId — if provided, load an existing CLI session.
   */
  async start(resumeSessionId?: string | null): Promise<void> {
    const { methods } = this.profile
    const child = this.spawnFn(this.opts.binary, this.profile.args, this.opts.cwd)
    this.child = child

    const client = new AcpClient({ write: (frame) => child.stdin?.write(frame) })
    this.client = client

    client.onNotification((n) => {
      // Any notification carrying an `update` is a session update. Kiro
      // extension notifications (_kiro.dev/*) translate to [] and are ignored.
      for (const event of translateSessionUpdate((n.params as { update?: unknown }) ?? {})) {
        this.opts.callbacks.onEvent(event)
      }
    })

    client.onRequest((req: JsonRpcRequest) => {
      if (req.method.toLowerCase().includes('permission')) {
        return { outcome: { outcome: 'selected', ...choosePermissionOption(req.params) } }
      }
      throw new Error(`Unsupported ACP request: ${req.method}`)
    })

    child.stdout?.on('data', (data: Buffer | string) => {
      for (const line of this.lineBuffer.push(data.toString())) {
        client.handleLine(line)
      }
    })

    child.on('error', (err: Error) => {
      this.opts.callbacks.onError?.(err)
      this.dispose()
    })

    child.on('close', () => {
      const tail = this.lineBuffer.flush()
      if (tail) client.handleLine(tail)
      client.dispose('ACP process closed')
    })

    await client.request(methods.initialize, {
      protocolVersion: this.opts.protocolVersion ?? 1,
      // Advertise no fs/terminal client capabilities — we don't implement them,
      // so the agent uses its own tools and asks permission (which we
      // auto-approve) rather than proxying file ops through us.
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: this.opts.clientName ?? 'codepipe', version: this.opts.clientVersion ?? '0.1.0' },
    })

    if (resumeSessionId) {
      const result = await client.request(methods.loadSession, { sessionId: resumeSessionId, cwd: this.opts.cwd, mcpServers: [] })
      this.sessionId = resumeSessionId
      this.emitModels(result)
    } else {
      const result = (await client.request(methods.newSession, { cwd: this.opts.cwd, mcpServers: [] })) as
        | { sessionId?: string; session?: { id?: string } }
        | undefined
      const id = result?.sessionId ?? result?.session?.id
      if (typeof id === 'string' && id.length > 0) {
        this.sessionId = id
        this.opts.callbacks.onSessionId?.(id)
      }
      this.emitModels(result)
    }

    // Provider-specific post-session setup (e.g. Gemini auto-approve mode).
    if (this.profile.afterSession && this.sessionId) {
      try {
        await this.profile.afterSession({
          request: (m, p) => client.request(m, p),
          notify: (m, p) => client.notify(m, p),
          sessionId: this.sessionId,
        })
      } catch (err) {
        log.warn('acp', `afterSession hook failed (continuing): ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }

  /** Send a user prompt. Resolves when the agent's turn ends. */
  async prompt(text: string, resourcePaths: string[] = []): Promise<void> {
    if (!this.client || !this.sessionId) throw new Error('ACP session not started')

    const blocks: unknown[] = [{ type: 'text', text }]
    for (const path of resourcePaths) {
      blocks.push({ type: 'resource_link', uri: `file://${path}` })
    }

    // Send both `prompt` and `content` keys: the ACP spec uses `prompt`, while
    // some agents' docs (Kiro's examples) use `content`. Extra keys are ignored.
    const result = await this.client.request(this.profile.methods.prompt, {
      sessionId: this.sessionId,
      prompt: blocks,
      content: blocks,
    })

    if (isEndOfTurnResult(result)) {
      this.opts.callbacks.onEvent({ type: 'message_complete', role: 'assistant' })
    }
    this.opts.callbacks.onIdle?.()
  }

  /** Cancel the in-flight turn (ACP cancel is a notification). */
  cancel(): void {
    if (this.client && this.sessionId) {
      this.client.notify(this.profile.methods.cancel, { sessionId: this.sessionId })
    }
  }

  /**
   * Switch the session's model, if the agent supports it. `modelId`/`model`
   * are both sent since param naming varies. Emits a model_info echo on success.
   */
  async setModel(modelId: string): Promise<void> {
    const method = this.profile.setModelMethod
    if (!this.client || !this.sessionId || !method) return
    await this.client.request(method, { sessionId: this.sessionId, modelId, model: modelId })
    this.opts.callbacks.onEvent({ type: 'model_info', current: modelId })
  }

  /** If a session result advertises models, surface them as a model_info event. */
  private emitModels(result: unknown): void {
    const parsed = parseAcpModels(result)
    if (!parsed) return
    this.opts.callbacks.onEvent({
      type: 'model_info',
      ...(parsed.current ? { current: parsed.current } : {}),
      ...(parsed.available.length > 0 ? { available: parsed.available } : {}),
    })
  }

  /** Terminate the process and reject any in-flight requests. */
  dispose(): void {
    this.client?.dispose()
    this.client = null
    if (this.child) {
      try {
        this.child.kill()
      } catch {
        /* already dead */
      }
      this.child = null
    }
  }
}
