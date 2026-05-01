import { z } from 'zod'
import type { ProviderType } from '../schemas.js'
import { MessageRoleSchema } from '../schemas.js'

// ---------------------------------------------------------------------------
// AdapterEvent — Zod schemas + TypeScript types
// ---------------------------------------------------------------------------

const AdapterCreditsSchema = z.object({
  credits: z.string().min(1),
  time: z.string().min(1),
})

const ChunkEventSchema = z.object({
  type: z.literal('chunk'),
  content: z.string().min(1),
  role: MessageRoleSchema,
})

const MessageCompleteEventSchema = z.object({
  type: z.literal('message_complete'),
  role: MessageRoleSchema,
  metadata: AdapterCreditsSchema.optional(),
})

const PromptDetectedEventSchema = z.object({
  type: z.literal('prompt_detected'),
})

const ToolUseEventSchema = z.object({
  type: z.literal('tool_use'),
  tool: z.string().min(1),
  content: z.string().min(1),
})

const ThinkingEventSchema = z.object({
  type: z.literal('thinking'),
  content: z.string().min(1),
})

const InteractivePromptEventSchema = z.object({
  type: z.literal('interactive_prompt'),
  content: z.string().min(1),
  options: z.array(z.string().min(1)).optional(),
})

export const AdapterEventSchema = z.discriminatedUnion('type', [
  ChunkEventSchema,
  MessageCompleteEventSchema,
  PromptDetectedEventSchema,
  ToolUseEventSchema,
  ThinkingEventSchema,
  InteractivePromptEventSchema,
])

export type AdapterEvent = z.infer<typeof AdapterEventSchema>

// ---------------------------------------------------------------------------
// Validation helper
// ---------------------------------------------------------------------------

/**
 * Validate an array of adapter events. Returns only the valid events,
 * logging warnings for any that fail validation.
 */
export function validateAdapterEvents(
  events: unknown[],
  logger?: (msg: string) => void,
): AdapterEvent[] {
  const valid: AdapterEvent[] = []
  for (const event of events) {
    const result = AdapterEventSchema.safeParse(event)
    if (result.success) {
      valid.push(result.data)
    } else {
      const msg = `Invalid adapter event dropped: ${JSON.stringify(event)} — ${result.error.message}`
      if (logger) logger(msg)
    }
  }
  return valid
}

// ---------------------------------------------------------------------------
// CLI Adapter interface
// ---------------------------------------------------------------------------

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

  /**
   * Format a file attachment as a string to inject into the CLI prompt.
   * Each provider has its own syntax for referencing files.
   * Returns the string to prepend/append to the user's message text.
   */
  formatAttachment(filePath: string, mimeType: string): string
}

export type AdapterFactory = () => ICLIAdapter
