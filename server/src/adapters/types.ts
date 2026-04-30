import type { ProviderType, MessageRole } from '../schemas.js'

/**
 * Events emitted by a CLI adapter when processing output.
 */
export type AdapterEvent =
  | { type: 'chunk'; content: string; role: MessageRole }
  | { type: 'message_complete'; role: MessageRole; metadata?: { credits?: string; time?: string } }
  | { type: 'prompt_detected' }
  | { type: 'tool_use'; tool: string; input: string }
  | { type: 'thinking'; content: string }

/**
 * Pluggable parser layer that understands a specific CLI tool's output format.
 * Converts raw terminal output into normalized chat events.
 */
export interface ICLIAdapter {
  readonly provider: ProviderType
  readonly command: string
  readonly args: string[]

  /**
   * Optional system prompt sent to the CLI after it finishes initializing.
   * The session manager sends this automatically when the adapter signals readiness.
   */
  readonly systemPrompt?: string

  /**
   * Process raw PTY output data (with ANSI codes stripped).
   * Called with each chunk of clean text from the terminal.
   */
  onData(cleanText: string): AdapterEvent[]

  /**
   * Notify the adapter that the user just sent input.
   * Called by SessionManager after writing to the pty so the adapter
   * can transition its state machine and skip the echoed input.
   */
  notifyUserInput(text: string): void

  /**
   * Notify the adapter that a system-level input was sent (e.g., system prompt).
   * The adapter should silently consume the echo and response without emitting events.
   */
  notifySystemInput(text: string): void

  /**
   * Reset internal parsing state (e.g., on session restart).
   */
  reset(): void
}

/**
 * Factory function that creates a new adapter instance.
 */
export type AdapterFactory = () => ICLIAdapter
