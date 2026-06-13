/**
 * Agent Client Protocol (ACP) — session update translation.
 *
 * Converts the structured session updates a Kiro ACP agent streams (over the
 * `session/update` JSON-RPC notification) into CodePipe's normalized
 * `AdapterEvent` model. This is the replacement for the line-by-line regex
 * scraping in `kiro-patterns.ts`: instead of guessing message boundaries and
 * spotting glyphs, we read typed events.
 *
 * Wire-format note: the ACP spec uses snake_case discriminators
 * (`agent_message_chunk`, `tool_call`, ...) under an `update.sessionUpdate`
 * field, while Kiro's published docs list PascalCase names (`AgentMessageChunk`,
 * `ToolCall`, `TurnEnd`). Until verified against a live binary, the translator
 * accepts BOTH and normalizes, and tolerates content shaped as a string, a
 * single `{type:'text', text}` block, or an array of such blocks.
 */

import type { AdapterEvent } from '../adapters/types.js'
import { summarizeToolInput } from '../adapters/tool-summary.js'

/** Params of a `session/update` (a.k.a. `session/notification`) message. */
export interface AcpSessionUpdateParams {
  sessionId?: string
  update?: unknown
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

/** Normalize a discriminator: "agent_message_chunk" / "AgentMessageChunk" -> "agentmessagechunk". */
function normalizeKind(value: unknown): string {
  return typeof value === 'string' ? value.replace(/[^a-z0-9]/gi, '').toLowerCase() : ''
}

/**
 * Extract plain text from an ACP content value, which may be:
 *   - a string
 *   - a content block: { type: 'text', text: '...' }
 *   - an array of content blocks
 * Non-text blocks (images, etc.) contribute nothing here.
 */
export function extractText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map(extractText).join('')
  if (isRecord(content)) {
    if (typeof content['text'] === 'string') return content['text']
    if ('content' in content) return extractText(content['content'])
  }
  return ''
}

/** Pull a human-readable tool name from a tool_call update. */
function extractToolName(update: Record<string, unknown>): string {
  const candidates = [update['title'], update['kind'], update['name'], update['toolCallId']]
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim().length > 0) return c.trim()
  }
  return 'tool'
}

/** Describe a tool call's content for the chat bubble (title + status, or raw input). */
function describeToolCall(update: Record<string, unknown>): string {
  const title = typeof update['title'] === 'string' ? update['title'] : ''
  const status = typeof update['status'] === 'string' ? update['status'] : ''
  const parts: string[] = []
  if (title) parts.push(title)
  if (status) parts.push(`(${status})`)
  if (parts.length > 0) return parts.join(' ')

  // Fall back to a concise, single-line summary of the tool input.
  const raw = update['rawInput'] ?? update['input'] ?? update['parameters']
  const name = extractToolName(update)
  if (raw !== undefined) return summarizeToolInput(name, raw)
  return name
}

/**
 * Translate a single ACP session update into zero or more AdapterEvents.
 * Returns `[]` for updates that carry no user-visible content (pure status
 * pings, plans, available-command lists, unknown kinds).
 */
export function translateSessionUpdate(params: AcpSessionUpdateParams): AdapterEvent[] {
  const update = params?.update
  if (!isRecord(update)) return []

  const kind = normalizeKind(update['sessionUpdate'] ?? update['type'])

  switch (kind) {
    case 'agentmessagechunk': {
      const text = extractText(update['content'])
      if (text.length === 0) return []
      return [{ type: 'chunk', content: text, role: 'assistant' }]
    }

    case 'agentthoughtchunk':
    case 'thought':
    case 'thinking': {
      const text = extractText(update['content'])
      if (text.length === 0) return [{ type: 'thinking', content: '…' }]
      return [{ type: 'thinking', content: text }]
    }

    case 'toolcall': {
      const content = describeToolCall(update)
      return [{ type: 'tool_use', tool: extractToolName(update), content: content || 'tool' }]
    }

    case 'toolcallupdate': {
      // Only surface updates that bring new output/content; skip pure
      // status transitions to avoid spamming the conversation.
      const text = extractText(update['content'] ?? update['output'])
      if (text.length === 0) return []
      return [{ type: 'tool_use', tool: extractToolName(update), content: text }]
    }

    case 'turnend':
    case 'endturn':
    case 'turncomplete':
      return [{ type: 'message_complete', role: 'assistant' }]

    default:
      return []
  }
}

/**
 * Parse available/current models out of a `session/new` (or load/resume)
 * result. Model advertisement is an OPTIONAL agent extension in ACP — the base
 * spec only guarantees `sessionId` — so the shape varies by agent. This reads
 * several plausible shapes defensively and returns null when none are present.
 *
 * Recognized shapes (any of):
 *   result.models = ["id1", "id2"]
 *   result.models = [{ modelId|id|model, name|displayName }]
 *   result.models = { available|models: [...], current|currentModelId }
 *   result.{currentModelId|currentModel|model} = "id"
 *
 * VERIFY against your installed agents — overridable, and absence just means
 * the UI falls back to showing the current model with a free-text override.
 */
export interface ParsedModels {
  available: { id: string; name?: string }[]
  current: string | null
}

function normalizeModelEntry(m: unknown): { id: string; name?: string } | null {
  if (typeof m === 'string') return m.length > 0 ? { id: m } : null
  if (isRecord(m)) {
    const id = m['modelId'] ?? m['id'] ?? m['model']
    if (typeof id === 'string' && id.length > 0) {
      const name = m['name'] ?? m['displayName']
      return typeof name === 'string' ? { id, name } : { id }
    }
  }
  return null
}

export function parseAcpModels(result: unknown): ParsedModels | null {
  if (!isRecord(result)) return null

  const available: { id: string; name?: string }[] = []
  let current: string | null = null

  const modelsField = result['models'] ?? result['availableModels']
  if (Array.isArray(modelsField)) {
    for (const m of modelsField) {
      const e = normalizeModelEntry(m)
      if (e) available.push(e)
    }
  } else if (isRecord(modelsField)) {
    const arr = modelsField['available'] ?? modelsField['models']
    if (Array.isArray(arr)) {
      for (const m of arr) {
        const e = normalizeModelEntry(m)
        if (e) available.push(e)
      }
    }
    const c = modelsField['current'] ?? modelsField['currentModelId']
    if (typeof c === 'string') current = c
  }

  if (!current) {
    const c = result['currentModelId'] ?? result['currentModel'] ?? result['model']
    if (typeof c === 'string') current = c
  }

  if (available.length === 0 && !current) return null
  return { available, current }
}

/** ACP stop reasons that mean "the agent's turn is over" (in normalized form). */
const END_TURN_STOP_REASONS = new Set(['endturn', 'cancelled', 'canceled', 'maxtokens', 'refusal'])

/**
 * Inspect a `session/prompt` RESULT and decide whether it signals turn
 * completion. ACP returns `{ stopReason }` when a prompt turn finishes, which
 * is the authoritative end-of-turn signal (complementary to any `TurnEnd`
 * notification).
 */
export function isEndOfTurnResult(result: unknown): boolean {
  if (!isRecord(result)) return false
  const reason = normalizeKind(result['stopReason'])
  return reason.length > 0 && END_TURN_STOP_REASONS.has(reason)
}
