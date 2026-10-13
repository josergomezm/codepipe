/**
 * Antigravity CLI adapter — non-interactive stream-json transport.
 *
 * Google replaced Gemini CLI with Antigravity CLI (`agy`) in June 2026. Like
 * the Claude adapter, each message spawns
 * `agy -p "<prompt>" --output-format stream-json`, which emits one JSON event
 * per line. Multi-turn conversations resume via `--conversation <id>`, where
 * the ID is captured inline from the `init` event.
 *
 * Event shapes (observed on agy 1.2.x):
 *   {event:'init', conversation_id, init:{model, ...}}                → cli_session + model_info
 *   {event:'step_update', step_update:{step_type:'agent_response',
 *      state:'ACTIVE'|'DONE', text_delta?}}                          → buffered, one chunk per step
 *   {event:'step_update', step_update:{step_type:'tool',
 *      state:'ACTIVE', tool_name, tool_info:{parameters}}}           → tool_use
 *   {event:'result', result:{status, error?, denied_actions?,
 *      duration_seconds, usage:{total_tokens}}}                      → message_complete
 *
 * `--dangerously-skip-permissions` is on by default: headless mode can't
 * prompt, so without it agy silently denies shell commands (even in
 * accept-edits). It and the other flags come from the provider launch
 * settings (provider-settings.ts).
 */

import { platform } from 'os'
import { dirname } from 'path'
import { execFile } from 'child_process'
import { promisify } from 'util'

import type { ProviderType } from '../schemas.js'
import type { ICLIAdapter, AdapterEvent } from './types.js'
import { summarizeToolInput } from './tool-summary.js'
import { ISOLATED_CHILD } from '../child-options.js'
import type { McpServerSpec } from '../agent-tools.js'
import { defaultSettings, settingsToArgs, type SettingValues } from '../provider-settings.js'

/** Resolve the Antigravity CLI binary: `AGY_CLI_BIN` override (falls back to `GEMINI_CLI_BIN`), else platform default. */
export function resolveAgyBinary(): string {
  const override = process.env['AGY_CLI_BIN'] || process.env['GEMINI_CLI_BIN']
  if (override && override.trim().length > 0) return override.trim()
  return platform() === 'win32' ? 'agy.exe' : 'agy'
}

// ---------------------------------------------------------------------------
// Model enumeration (`agy models` — `<id>\t<display name>` per line)
// ---------------------------------------------------------------------------

const execFileAsync = promisify(execFile)

/**
 * Parse `agy models` output. Each model line is `<id>\t<display name>`; older
 * builds printed a bare id. Banner lines ("Fetching available models...")
 * have spaces but no tab, so they're skipped.
 */
export function parseAgyModelList(stdout: string): { id: string; name?: string }[] {
  const models: { id: string; name?: string }[] = []
  for (const raw of stdout.split('\n')) {
    const line = raw.trim()
    if (line.length === 0) continue
    const [id, name] = line.split('\t').map((s) => s.trim())
    if (!id || id.includes(' ')) continue
    models.push(name ? { id, name } : { id })
  }
  return models
}

let cachedModels: { id: string; name?: string }[] | null = null
let cachedModelsAt = 0
const MODEL_CACHE_TTL_MS = 10 * 60 * 1000

/** Enumerate Antigravity's models via `agy models`, cached for 10 minutes. */
export async function listAgyModels(): Promise<{ id: string; name?: string }[]> {
  const now = Date.now()
  if (cachedModels && now - cachedModelsAt < MODEL_CACHE_TTL_MS) return cachedModels
  try {
    const { stdout } = await execFileAsync(resolveAgyBinary(), ['models'], {
      timeout: 15000,
      ...ISOLATED_CHILD,
    })
    const models = parseAgyModelList(stdout)
    if (models.length > 0) {
      cachedModels = models
      cachedModelsAt = now
    }
    return models
  } catch {
    return []
  }
}

// ---------------------------------------------------------------------------
// Stream-json translation
// ---------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

/** Format token usage + duration as message metadata, when both are present. */
function resultMetadata(result: Record<string, unknown>): { credits: string; time: string } | undefined {
  const usage = result['usage']
  const tokens = isRecord(usage) ? usage['total_tokens'] : undefined
  const seconds = result['duration_seconds']
  if (typeof tokens !== 'number' || typeof seconds !== 'number') return undefined
  const credits = tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k tokens` : `${tokens} tokens`
  return { credits, time: `${Math.max(1, Math.round(seconds))}s` }
}

export class GeminiAdapter implements ICLIAdapter {
  readonly provider: ProviderType = 'gemini'
  readonly command = resolveAgyBinary()
  /** Permission skipping, mode, sandbox… come from the launch settings. */
  readonly args: string[] = ['--output-format', 'stream-json']
  /** Conversation ID is captured inline (cli_session event) and resumed via --conversation. */
  readonly transport = 'oneshot' as const

  /**
   * agy streams replies as small `text_delta` fragments, but the session
   * manager joins chunks with newlines — so fragments are buffered per step
   * and emitted as one chunk when the step finishes (like Claude's blocks).
   */
  private textSteps = new Map<number, string>()
  private announcedTools = new Set<number>()

  /** Enumerate models via `agy models` (cached). */
  listModels(): Promise<{ id: string; name?: string }[]> {
    return listAgyModels()
  }

  onData(text: string): AdapterEvent[] {
    const trimmed = text.trim()
    if (trimmed.length === 0 || trimmed[0] !== '{') return []

    let event: unknown
    try {
      event = JSON.parse(trimmed)
    } catch {
      return []
    }
    if (!isRecord(event)) return []

    switch (event['event']) {
      case 'init':
        return this.onInit(event)
      case 'step_update':
        return isRecord(event['step_update']) ? this.onStep(event['step_update']) : []
      case 'result':
        return isRecord(event['result']) ? this.onResult(event['result']) : []
      default:
        return []
    }
  }

  private onInit(event: Record<string, unknown>): AdapterEvent[] {
    const events: AdapterEvent[] = []
    const id = event['conversation_id']
    if (typeof id === 'string' && id.length > 0) events.push({ type: 'cli_session', sessionId: id })
    const init = event['init']
    if (isRecord(init) && typeof init['model'] === 'string' && init['model'].length > 0) {
      events.push({ type: 'model_info', current: init['model'] })
    }
    return events
  }

  private onStep(step: Record<string, unknown>): AdapterEvent[] {
    const index = typeof step['step_index'] === 'number' ? step['step_index'] : -1

    if (step['step_type'] === 'agent_response') {
      const delta = step['text_delta']
      if (typeof delta === 'string') {
        this.textSteps.set(index, (this.textSteps.get(index) ?? '') + delta)
      }
      return step['state'] === 'DONE' ? this.flushText(index) : []
    }

    if (step['step_type'] === 'tool' && !this.announcedTools.has(index)) {
      // Each tool step reports ACTIVE then DONE — announce it once.
      this.announcedTools.add(index)
      const info = isRecord(step['tool_info']) ? step['tool_info'] : {}
      const name =
        (typeof step['tool_name'] === 'string' && step['tool_name']) ||
        (typeof info['name'] === 'string' && info['name']) ||
        'tool'
      return [{ type: 'tool_use', tool: name, content: summarizeToolInput(name, info['parameters']) || name }]
    }

    return []
  }

  private onResult(result: Record<string, unknown>): AdapterEvent[] {
    // Flush any text whose step never reported DONE.
    const events: AdapterEvent[] = [...this.textSteps.keys()].flatMap((i) => this.flushText(i))

    const id = result['conversation_id']
    if (typeof id === 'string' && id.length > 0) events.push({ type: 'cli_session', sessionId: id })

    if (result['status'] !== 'SUCCESS') {
      const error = typeof result['error'] === 'string' ? result['error'].split('\n')[0] : 'unknown error'
      events.push({ type: 'chunk', role: 'system', content: `Antigravity error: ${error}` })
    }
    const denied = result['denied_actions']
    if (Array.isArray(denied) && denied.length > 0) {
      const names = denied.map((d) => (isRecord(d) && typeof d['display_name'] === 'string' ? d['display_name'] : 'action'))
      events.push({ type: 'chunk', role: 'system', content: `Antigravity denied: ${names.join(', ')}` })
    }

    const metadata = resultMetadata(result)
    events.push(metadata ? { type: 'message_complete', role: 'assistant', metadata } : { type: 'message_complete', role: 'assistant' })
    this.reset()
    return events
  }

  private flushText(index: number): AdapterEvent[] {
    const text = (this.textSteps.get(index) ?? '').trim()
    this.textSteps.delete(index)
    return text.length > 0 ? [{ type: 'chunk', content: text, role: 'assistant' }] : []
  }

  buildMessageCommand(
    text: string,
    cliSessionId: string | null,
    attachments?: { path: string; mimeType: string }[],
    model?: string | null,
    _mcpServers?: McpServerSpec[],
    settings: SettingValues = defaultSettings('gemini'),
  ): { command: string; args: string[] } {
    const args = [...this.args, ...settingsToArgs('gemini', settings)]

    if (model) {
      args.push('--model', model)
    }

    if (cliSessionId) {
      args.push('--conversation', cliSessionId)
    }

    // Uploads live outside the project dir — grant their folders so agy can
    // read them (same reason as the Claude adapter).
    let input = text
    if (attachments?.length) {
      for (const dir of new Set(attachments.map((a) => dirname(a.path)))) {
        args.push('--add-dir', dir)
      }
      input = attachments.map((a) => this.formatAttachment(a.path, a.mimeType)).join(' ') + ' ' + text
    }

    args.push('-p', input)
    return { command: this.command, args }
  }

  /** Forget per-turn parse state; called when a turn's result arrives. */
  private reset(): void {
    this.textSteps.clear()
    this.announcedTools.clear()
  }

  formatAttachment(filePath: string, _mimeType: string): string {
    return `@${filePath}`
  }
}
