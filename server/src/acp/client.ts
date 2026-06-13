/**
 * A small JSON-RPC 2.0 client for talking to an ACP agent.
 *
 * Transport-agnostic by design: it knows how to frame/correlate messages but
 * not how bytes move. The owner (see `driver.ts`) wires a child process's
 * stdin to `transport.write` and pipes stdout lines into `handleLine`. That
 * keeps this class trivially unit-testable with an in-memory transport.
 */

import {
  encodeMessage,
  parseMessage,
  isResponse,
  isNotification,
  isRequest,
  type JsonRpcId,
  type JsonRpcNotification,
  type JsonRpcRequest,
} from './jsonrpc.js'

/** Outbound byte sink (e.g. child.stdin.write). */
export interface AcpTransport {
  write(frame: string): void
}

interface Pending {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout> | null
}

export interface AcpClientOptions {
  /** Per-request timeout. Default 120s (agent turns can be long). */
  requestTimeoutMs?: number
}

const DEFAULT_REQUEST_TIMEOUT_MS = 120_000

export class AcpClient {
  private nextId = 1
  private readonly pending = new Map<JsonRpcId, Pending>()
  private notificationHandler: ((n: JsonRpcNotification) => void) | null = null
  private requestHandler: ((r: JsonRpcRequest) => Promise<unknown> | unknown) | null = null
  private disposed = false
  private readonly requestTimeoutMs: number

  constructor(private readonly transport: AcpTransport, opts: AcpClientOptions = {}) {
    this.requestTimeoutMs = opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
  }

  /** Register a handler for agent→client notifications (e.g. session/update). */
  onNotification(cb: (n: JsonRpcNotification) => void): void {
    this.notificationHandler = cb
  }

  /**
   * Register a handler for agent→client requests (e.g. permission prompts,
   * fs access). Return a result to resolve, or throw to send an error. If
   * unset, all inbound requests get a "method not found" error.
   */
  onRequest(cb: (r: JsonRpcRequest) => Promise<unknown> | unknown): void {
    this.requestHandler = cb
  }

  /** Send a request and resolve with its result (or reject on error/timeout). */
  request(method: string, params?: unknown, timeoutMs?: number): Promise<unknown> {
    if (this.disposed) return Promise.reject(new Error('ACP client disposed'))

    const id = this.nextId++
    return new Promise<unknown>((resolve, reject) => {
      const timeout = timeoutMs ?? this.requestTimeoutMs
      const timer =
        timeout > 0
          ? setTimeout(() => {
              this.pending.delete(id)
              reject(new Error(`ACP request "${method}" timed out after ${timeout}ms`))
            }, timeout)
          : null
      this.pending.set(id, { resolve, reject, timer })
      try {
        this.transport.write(encodeMessage({ jsonrpc: '2.0', id, method, params }))
      } catch (err) {
        this.pending.delete(id)
        if (timer) clearTimeout(timer)
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    })
  }

  /** Fire-and-forget notification. */
  notify(method: string, params?: unknown): void {
    if (this.disposed) return
    this.transport.write(encodeMessage({ jsonrpc: '2.0', method, params }))
  }

  /** Feed one inbound frame (a single newline-stripped line). */
  handleLine(line: string): void {
    const msg = parseMessage(line)
    if (!msg) return

    if (isResponse(msg)) {
      const pending = this.pending.get(msg.id)
      if (!pending) return
      this.pending.delete(msg.id)
      if (pending.timer) clearTimeout(pending.timer)
      if (msg.error) {
        pending.reject(new Error(`ACP error ${msg.error.code}: ${msg.error.message}`))
      } else {
        pending.resolve(msg.result)
      }
      return
    }

    if (isNotification(msg)) {
      this.notificationHandler?.(msg)
      return
    }

    if (isRequest(msg)) {
      void this.respondToRequest(msg)
    }
  }

  private async respondToRequest(req: JsonRpcRequest): Promise<void> {
    if (!this.requestHandler) {
      this.transport.write(
        encodeMessage({ jsonrpc: '2.0', id: req.id, error: { code: -32601, message: 'Method not found' } }),
      )
      return
    }
    try {
      const result = await this.requestHandler(req)
      this.transport.write(encodeMessage({ jsonrpc: '2.0', id: req.id, result: result ?? null }))
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.transport.write(encodeMessage({ jsonrpc: '2.0', id: req.id, error: { code: -32000, message } }))
    }
  }

  /** Reject all in-flight requests and stop accepting new ones. */
  dispose(reason = 'ACP client disposed'): void {
    if (this.disposed) return
    this.disposed = true
    for (const [, pending] of this.pending) {
      if (pending.timer) clearTimeout(pending.timer)
      pending.reject(new Error(reason))
    }
    this.pending.clear()
  }
}
