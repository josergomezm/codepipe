import { z } from 'zod'
import type { ProviderType } from '../schemas.js'
import { MessageRoleSchema } from '../schemas.js'
import type { AcpProfile } from '../acp/profile.js'
import type { McpServerSpec } from '../agent-tools.js'
import type { SettingValues } from '../provider-settings.js'

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

const ToolUseEventSchema = z.object({
  type: z.literal('tool_use'),
  tool: z.string().min(1),
  content: z.string().min(1),
})

const ThinkingEventSchema = z.object({
  type: z.literal('thinking'),
  content: z.string().min(1),
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
  ToolUseEventSchema,
  ThinkingEventSchema,
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

  /**
   * Transport the SessionManager should use to drive this adapter:
   *   - `'oneshot'`: spawn a short-lived process per message (built by
   *     `buildMessageCommand`); each stdout line is parsed via `onData`.
   *   - `'acp'`: persistent process speaking the Agent Client Protocol
   *     (JSON-RPC). Output is structured, so `onData` is unused — the
   *     SessionManager runs an AcpSessionDriver instead.
   */
  readonly transport: 'oneshot' | 'acp'

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
   * Enumerate models by asking the CLI itself (e.g. `kiro-cli chat
   * --list-models --format json`). Called lazily by the SessionManager when a
   * session has no dynamically advertised models yet; results populate the
   * picker. Implementations should cache — this runs on every client attach.
   */
  listModels?(): Promise<{ id: string; name?: string }[]>

  /**
   * When true, the SessionManager detects the CLI's session ID by running the
   * adapter's session-list command after the first message (legacy Kiro
   * non-interactive behavior). Adapters that report their session ID inline
   * (via a `cli_session` event) leave this unset.
   */
  readonly usesSessionListDetection?: boolean

  onData(cleanText: string): AdapterEvent[]
  onStderr?(text: string): AdapterEvent[]

  /**
   * Build the command + args for a single message invocation. Required for
   * `transport === 'oneshot'`.
   *
   * @param text — the user's message text
   * @param cliSessionId — the CLI's session ID for multi-turn (null for first message)
   * @param attachments — optional file attachments
   * @param model — the session's selected model, if any
   * @param mcpServers — MCP servers to give the agent for this turn (CodePipe's
   *   own tools). Adapters whose CLI can't take them per invocation ignore it.
   * @param settings — resolved launch settings for this session (see
   *   provider-settings.ts). Absent = the provider's defaults.
   */
  buildMessageCommand?(
    text: string,
    cliSessionId: string | null,
    attachments?: { path: string; mimeType: string }[],
    model?: string | null,
    mcpServers?: McpServerSpec[],
    settings?: SettingValues,
  ): { command: string; args: string[] }
}

export type AdapterFactory = () => ICLIAdapter
