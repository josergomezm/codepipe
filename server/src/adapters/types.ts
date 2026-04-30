import type { ProviderType, MessageRole } from '../schemas.js'

/**
 * Events emitted by a CLI adapter when processing output.
 */
export type AdapterEvent =
  | { type: 'chunk'; content: string; role: MessageRole }
  | { type: 'message_complete'; role: MessageRole; metadata?: { credits?: string; time?: string } }
  | { type: 'prompt_detected' }
  | { type: 'tool_use'; tool: string; content: string }
  | { type: 'thinking'; content: string }
  | { type: 'interactive_prompt'; content: string; options?: string[] }

/**
 * Pluggable parser layer that understands a specific CLI tool's output format.
 */
export interface ICLIAdapter {
  readonly provider: ProviderType
  readonly command: string
  readonly args: string[]
  readonly systemPrompt?: string

  onData(cleanText: string): AdapterEvent[]
  notifyUserInput(text: string): void
  notifySystemInput(text: string): void
  reset(): void
}

export type AdapterFactory = () => ICLIAdapter
