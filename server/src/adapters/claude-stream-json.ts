/**
 * Claude Code stream-json translation.
 *
 * `claude -p "<prompt>" --output-format stream-json --verbose` emits
 * newline-delimited JSON, one event per line. This is Claude Code's native
 * structured output — the equivalent of Kiro's ACP for parsing
 * purposes. We translate each event into CodePipe's `AdapterEvent` model.
 *
 * Event shapes (from the Claude Code headless docs):
 *   - {type:'system', subtype:'init', session_id, ...}        → cli_session
 *   - {type:'assistant', message:{content:[blocks]}, ...}     → chunk / tool_use
 *   - {type:'user', message:{content:[tool_result]}, ...}     → (ignored)
 *   - {type:'result', subtype:'success', session_id, total_cost_usd, duration_ms, ...} → message_complete
 *   - {type:'stream_event', ...}                              → (ignored; partial deltas)
 */

import type { AdapterEvent } from './types.js'

type MessageCompleteMetadata = NonNullable<Extract<AdapterEvent, { type: 'message_complete' }>['metadata']>
import { summarizeToolInput } from './tool-summary.js'

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

function translateAssistant(message: unknown): AdapterEvent[] {
  if (!isRecord(message) || !Array.isArray(message['content'])) return []
  const events: AdapterEvent[] = []
  for (const block of message['content']) {
    if (!isRecord(block)) continue
    if (block['type'] === 'text' && typeof block['text'] === 'string' && block['text'].length > 0) {
      events.push({ type: 'chunk', content: block['text'], role: 'assistant' })
    } else if (block['type'] === 'tool_use') {
      const name = typeof block['name'] === 'string' && block['name'].length > 0 ? block['name'] : 'tool'
      // A concise, single-line summary — never a raw JSON dump.
      events.push({ type: 'tool_use', tool: name, content: summarizeToolInput(name, block['input']) || name })
    }
  }
  return events
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

/**
 * Build `message_complete` metadata from a result event, if cost+duration are
 * present. NB: on `--resume`, `total_cost_usd` and `modelUsage` usually
 * include earlier runs of the conversation, while `usage` is this run only —
 * the raw numbers go out as `claudeUsage` and the session manager works out
 * the reply's own cost.
 */
function resultMetadata(event: Record<string, unknown>): MessageCompleteMetadata | undefined {
  const cost = event['total_cost_usd']
  const durationMs = event['duration_ms']
  if (typeof cost !== 'number' || typeof durationMs !== 'number') return undefined
  const seconds = Math.max(1, Math.round(durationMs / 1000))
  const metadata: MessageCompleteMetadata = { credits: `$${cost.toFixed(4)}`, time: `${seconds}s` }

  const usage = event['usage']
  if (isRecord(usage)) {
    let cumulative = 0
    const modelUsage = event['modelUsage']
    if (isRecord(modelUsage)) {
      for (const m of Object.values(modelUsage)) {
        if (!isRecord(m)) continue
        cumulative += num(m['inputTokens']) + num(m['outputTokens']) + num(m['cacheReadInputTokens']) + num(m['cacheCreationInputTokens'])
      }
    }
    metadata.claudeUsage = {
      cliTotalUsd: cost,
      cliCumulativeTokens: cumulative,
      inputTokens: num(usage['input_tokens']),
      cacheReadTokens: num(usage['cache_read_input_tokens']),
      cacheWriteTokens: num(usage['cache_creation_input_tokens']),
      outputTokens: num(usage['output_tokens']),
    }
  }
  return metadata
}

/**
 * Translate a single stream-json line into zero or more AdapterEvents.
 * Non-JSON lines (stray logs) and unrecognized event types return `[]`.
 */
export function translateStreamJsonLine(line: string): AdapterEvent[] {
  const trimmed = line.trim()
  if (trimmed.length === 0 || trimmed[0] !== '{') return []

  let event: unknown
  try {
    event = JSON.parse(trimmed)
  } catch {
    return []
  }
  if (!isRecord(event)) return []

  const type = event['type']
  const events: AdapterEvent[] = []

  // Capture the CLI session ID wherever it appears (init or result).
  const sessionId = event['session_id']

  if (type === 'system' && event['subtype'] === 'init') {
    if (typeof sessionId === 'string' && sessionId.length > 0) {
      events.push({ type: 'cli_session', sessionId })
    }
    // The init event reports the active model. Claude Code has no CLI command
    // to enumerate models, so we surface only the current one (the UI offers a
    // free-text override) — nothing hardcoded.
    if (typeof event['model'] === 'string' && event['model'].length > 0) {
      events.push({ type: 'model_info', current: event['model'] })
    }
    return events
  }

  if (type === 'assistant') {
    return translateAssistant(event['message'])
  }

  if (type === 'result') {
    if (typeof sessionId === 'string' && sessionId.length > 0) {
      events.push({ type: 'cli_session', sessionId })
    }
    const metadata = resultMetadata(event)
    events.push(metadata ? { type: 'message_complete', role: 'assistant', metadata } : { type: 'message_complete', role: 'assistant' })
    return events
  }

  // 'user' (tool_result), 'stream_event' partial deltas, and anything else
  // carry no standalone chat content.
  return events
}
