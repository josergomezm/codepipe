/**
 * Minimal JSON-RPC 2.0 codec for the Agent Client Protocol (ACP).
 *
 * ACP agents (e.g. `kiro-cli acp`) communicate over stdin/stdout using
 * JSON-RPC 2.0, one JSON object per line (newline-delimited / "ndjson").
 * This module handles only framing + (de)serialization — no transport and
 * no protocol semantics — so it is trivially unit-testable in isolation.
 */

export type JsonRpcId = string | number

export interface JsonRpcRequest {
  jsonrpc: '2.0'
  id: JsonRpcId
  method: string
  params?: unknown
}

export interface JsonRpcNotification {
  jsonrpc: '2.0'
  method: string
  params?: unknown
}

export interface JsonRpcResponse {
  jsonrpc: '2.0'
  id: JsonRpcId
  result?: unknown
  error?: JsonRpcError
}

export interface JsonRpcError {
  code: number
  message: string
  data?: unknown
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse

/** Serialize a JSON-RPC message to a single newline-terminated frame. */
export function encodeMessage(message: JsonRpcMessage): string {
  return JSON.stringify(message) + '\n'
}

/**
 * Parse one frame (a single line, without the trailing newline) into a
 * JSON-RPC message. Returns `null` for blank lines or invalid JSON rather
 * than throwing, so a noisy stream can't crash the reader.
 */
export function parseMessage(line: string): JsonRpcMessage | null {
  const trimmed = line.trim()
  if (trimmed.length === 0) return null
  try {
    const parsed = JSON.parse(trimmed)
    if (parsed && typeof parsed === 'object' && parsed.jsonrpc === '2.0') {
      return parsed as JsonRpcMessage
    }
    return null
  } catch {
    return null
  }
}

/** Discriminators for an incoming message. */
export function isResponse(m: JsonRpcMessage): m is JsonRpcResponse {
  return 'id' in m && !('method' in m)
}

export function isRequest(m: JsonRpcMessage): m is JsonRpcRequest {
  return 'id' in m && 'method' in m
}

export function isNotification(m: JsonRpcMessage): m is JsonRpcNotification {
  return !('id' in m) && 'method' in m
}

/**
 * Accumulates raw stream chunks and yields complete lines as they arrive,
 * retaining any trailing partial line until its newline shows up. This is
 * the same partial-frame problem the old PTY parser fought with ANSI codes —
 * here it's handled once, cleanly, at the framing layer.
 */
export class LineBuffer {
  private buffer = ''

  /** Push a chunk; return the complete lines it completed (newline-stripped). */
  push(chunk: string): string[] {
    this.buffer += chunk
    const parts = this.buffer.split('\n')
    // Last element is the (possibly empty) partial line — keep it buffered.
    this.buffer = parts.pop() ?? ''
    return parts
  }

  /** Flush any buffered partial line (e.g. on stream close). */
  flush(): string | null {
    const remaining = this.buffer
    this.buffer = ''
    return remaining.length > 0 ? remaining : null
  }
}
