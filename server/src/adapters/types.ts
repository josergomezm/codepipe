import { z } from 'zod'
import type { ProviderType } from '../schemas.js'
import { MessageRoleSchema } from '../schemas.js'
import type { AcpProfile } from '../acp/profile.js'

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

const CliSessionEventSchema = z.object({
  type: z.literal('cli_session'),
  /** The CLI tool's own session ID, captured inline from structured output. */
  sessionId: z.string().min(1),
})

const ModelInfoEventSchema = z.object({
  type: z.literal('model_info'),
  /** The model the CLI reports it is currently using. */
  current: z.string().min(1).optional(),
  /** Models the provider can switch to (empty/absent when not discoverable). */
  available: z.array(z.object({ id: z.string().min(1), name: z.string().optional() })).optional(),
})

export const AdapterEventSchema = z.discriminatedUnion('type', [
  ChunkEventSchema,
  MessageCompleteEventSchema,
  PromptDetectedEventSchema,
  ToolUseEventSchema,
  ThinkingEventSchema,
  InteractivePromptEventSchema,
  CliSessionEventSchema,
  ModelInfoEventSchema,
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

  /**
   * Whether this adapter uses non-interactive mode (spawn a short-lived
   * process per message) rather than a persistent PTY process.
   *
   * When true, the SessionManager uses child_process.spawn per message
   * instead of maintaining a long-lived PTY. The adapter's onData receives
   * clean stdout lines instead of raw terminal output.
   */
  readonly nonInteractive?: boolean

  /**
   * Transport the SessionManager should use to drive this adapter:
   *   - `'pty'` (default when unset and nonInteractive is false): persistent
   *     pseudo-terminal, output parsed via `onData`.
   *   - `'oneshot'` (implied by `nonInteractive: true`): spawn a short-lived
   *     process per message, stdout parsed via `onData`.
   *   - `'acp'`: persistent process speaking the Agent Client Protocol
   *     (JSON-RPC). Output is structured, so `onData` is unused — the
   *     SessionManager runs an AcpSessionDriver instead.
   */
  readonly transport?: 'pty' | 'oneshot' | 'acp'

  /**
   * ACP dialect for this adapter (only meaningful when transport === 'acp').
   * Captures provider-specific method names / launch args / post-session setup.
   */
  readonly acpProfile?: AcpProfile

  /**
   * Models to offer in the picker for providers that can't enumerate their
   * own models (e.g. Claude Code). These should be stable, forward-compatible
   * selectors (aliases), not pinned versions. Ignored when the provider
   * advertises a model list dynamically.
   */
  readonly suggestedModels?: { id: string; name?: string }[]

  /**
   * When true, the SessionManager detects the CLI's session ID by running the
   * adapter's session-list command after the first message (legacy Kiro
   * non-interactive behavior). Adapters that report their session ID inline
   * (via a `cli_session` event) leave this unset.
   */
  readonly usesSessionListDetection?: boolean

  onData(cleanText: string): AdapterEvent[]
  onStderr?(text: string): AdapterEvent[]
  notifyUserInput(text: string): void
  notifySystemInput(text: string): void
  reset(): void

  /**
   * Format a file attachment as a string to inject into the CLI prompt.
   * Each provider has its own syntax for referencing files.
   * Returns the string to prepend/append to the user's message text.
   */
  formatAttachment(filePath: string, mimeType: string): string

  /**
   * Return the command + args needed to resume/continue a previous session.
   * Each CLI tool has its own mechanism (e.g., `--continue`, `--resume <id>`).
   *
   * @param cliSessionId — the CLI tool's own session ID (captured during the
   *   original session). If null, the adapter should fall back to a best-effort
   *   resume (e.g., "resume most recent in this directory").
   *
   * If the CLI doesn't support session resumption at all, return `null`.
   */
  getResumeCommand(cliSessionId: string | null): { command: string; args: string[] } | null

  /**
   * Build the command + args for a single non-interactive message invocation.
   * Only used when `nonInteractive` is true.
   *
   * @param text — the user's message text
   * @param cliSessionId — the CLI's session ID for multi-turn (null for first message)
   * @param attachments — optional file attachments
   */
  buildMessageCommand?(
    text: string,
    cliSessionId: string | null,
    attachments?: { path: string; mimeType: string }[],
    model?: string | null,
  ): { command: string; args: string[] }

  /**
   * Directory where the CLI tool stores its own session files.
   * Used to detect the CLI's session ID after spawning a new process.
   * Return `null` if the CLI doesn't have a known session storage location.
   */
  readonly cliSessionDir: string | null
}

export type AdapterFactory = () => ICLIAdapter
