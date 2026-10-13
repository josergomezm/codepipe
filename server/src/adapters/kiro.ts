/**
 * Kiro CLI adapter — non-interactive mode.
 *
 * Instead of spawning a persistent PTY and parsing TUI output in real-time,
 * this adapter uses `kiro-cli chat --no-interactive` which produces clean,
 * machine-friendly output. Each user message spawns a short-lived process
 * that exits when the response is complete.
 *
 * Multi-turn conversations work via `--resume-id <cliSessionId>`, which
 * tells the CLI to continue an existing conversation.
 *
 * Tool use is auto-approved with `--trust-all-tools` by default; the trust
 * flags come from the provider launch settings (provider-settings.ts).
 */

import { platform } from 'os'
import { execFile } from 'child_process'
import { promisify } from 'util'

import type { ProviderType } from '../schemas.js'
import type { ICLIAdapter, AdapterEvent } from './types.js'
import {
  parseCredits,
  isToolLine,
  extractToolName,
  TOOL_NAME_PATTERN,
} from './kiro-patterns.js'
import { ISOLATED_CHILD } from '../child-options.js'
import { stripAnsi } from './strip-ansi.js'
import type { McpServerSpec } from '../agent-tools.js'
import { defaultSettings, settingsToArgs, type SettingValues } from '../provider-settings.js'

/**
 * A tool call as Kiro reports it on stderr: `[tool] Reading src/a.ts:1`,
 * `[tool] Running: @codepipe/add_action_item`. Its `[tool] status: …`
 * follow-up lines carry nothing new and are skipped.
 */
const STDERR_TOOL_LINE = /^\[tool\]\s+(?!status:)(.+)$/

/** Tool name + summary from a stderr tool line's body. */
export function parseStderrTool(body: string): { tool: string; content: string } {
  const running = /^Running:\s*@?(\S+)\s*(.*)$/.exec(body)
  if (running) return { tool: running[1], content: running[2] || running[1] }
  const [verb, ...rest] = body.split(/\s+/)
  return { tool: verb.toLowerCase(), content: rest.join(' ') || body }
}

/**
 * Resolve the Kiro CLI binary name for the current platform.
 *
 * Precedence:
 *   1. `KIRO_CLI_BIN` env var (absolute path or name on PATH) — explicit override.
 *   2. Platform default: `kiro-cli.exe` on Windows, `kiro-cli` elsewhere.
 *
 * The original hardcoded `kiro-cli.exe` only resolved on Windows; on
 * macOS/Linux the binary is `kiro-cli`, so the app could never spawn there.
 */
export function resolveKiroBinary(): string {
  const override = process.env['KIRO_CLI_BIN']
  if (override && override.trim().length > 0) return override.trim()
  return platform() === 'win32' ? 'kiro-cli.exe' : 'kiro-cli'
}

// ---------------------------------------------------------------------------
// Model enumeration (`kiro-cli chat --list-models --format json`)
// ---------------------------------------------------------------------------

const execFileAsync = promisify(execFile)

/** Shape of the `--list-models --format json` output (fields we use). */
interface KiroModelListJson {
  models?: { model_id?: string; model_name?: string; rate_multiplier?: number }[]
  default_model?: string
}

/**
 * Parse the JSON emitted by `kiro-cli chat --list-models --format json` into
 * picker options. Labels include the credit rate multiplier and mark the
 * account default. Returns [] on any unexpected shape.
 */
export function parseKiroModelList(stdout: string): { id: string; name?: string }[] {
  try {
    const parsed = JSON.parse(stdout) as KiroModelListJson
    if (!Array.isArray(parsed.models)) return []
    const models: { id: string; name?: string }[] = []
    for (const m of parsed.models) {
      if (typeof m.model_id !== 'string' || m.model_id.length === 0) continue
      const label = typeof m.model_name === 'string' && m.model_name.length > 0 ? m.model_name : m.model_id
      const rate = typeof m.rate_multiplier === 'number' ? ` (${m.rate_multiplier}x)` : ''
      const def = m.model_id === parsed.default_model ? ' — default' : ''
      models.push({ id: m.model_id, name: `${label}${rate}${def}` })
    }
    return models
  } catch {
    return []
  }
}

/**
 * The models offered in the picker, in display order. Kiro lists ~20 models
 * (old Claude versions, DeepSeek, Qwen…); we keep the ones worth picking and
 * give them readable names. Ids Kiro doesn't offer yet (e.g. Sonnet 5.5) are
 * dropped until the CLI starts listing them. Anything else is still reachable
 * through the picker's "Custom…" entry.
 */
export const KIRO_PICKER_MODELS: { id: string; name: string }[] = [
  { id: 'auto', name: 'Auto' },
  { id: 'claude-opus-5.5', name: 'Opus 5.5' },
  { id: 'claude-sonnet-5.5', name: 'Sonnet 5.5' },
  { id: 'claude-sonnet-5', name: 'Sonnet 5' },
  { id: 'gpt-5.6-sol', name: 'GPT 5.6 Sol' },
  { id: 'gpt-5.6-terra', name: 'GPT 5.6 Terra' },
  { id: 'gpt-5.6-luna', name: 'GPT 5.6 Luna' },
]

/**
 * Narrow the CLI's model list to KIRO_PICKER_MODELS, keeping the credit rate
 * from the CLI's label. When the CLI list is empty (CLI unavailable), the
 * curated list is returned as-is so the picker still works.
 */
export function curateKiroModels(live: { id: string; name?: string }[]): { id: string; name?: string }[] {
  if (live.length === 0) return KIRO_PICKER_MODELS.filter((m) => m.id !== 'claude-sonnet-5.5')
  const byId = new Map(live.map((m) => [m.id, m]))
  return KIRO_PICKER_MODELS.flatMap((m) => {
    const found = byId.get(m.id)
    if (!found) return []
    const rate = /\(([\d.]+x)\)/.exec(found.name ?? '')?.[1]
    return [{ id: m.id, name: rate ? `${m.name} (${rate})` : m.name }]
  })
}

let cachedModels: { id: string; name?: string }[] | null = null
let cachedModelsAt = 0
const MODEL_CACHE_TTL_MS = 10 * 60 * 1000

/**
 * Enumerate Kiro's available models via the CLI, cached for 10 minutes.
 * Shared by both Kiro transports (non-interactive and ACP). Returns [] when
 * the CLI is unavailable or errors — the picker then just shows Custom.
 */
export async function listKiroModels(): Promise<{ id: string; name?: string }[]> {
  const now = Date.now()
  if (cachedModels && now - cachedModelsAt < MODEL_CACHE_TTL_MS) return cachedModels
  try {
    const { stdout } = await execFileAsync(
      resolveKiroBinary(),
      ['chat', '--list-models', '--format', 'json'],
      { timeout: 15000, ...ISOLATED_CHILD },
    )
    const models = parseKiroModelList(stdout)
    if (models.length > 0) {
      cachedModels = curateKiroModels(models)
      cachedModelsAt = now
      return cachedModels
    }
    return curateKiroModels([])
  } catch {
    return curateKiroModels([])
  }
}

export class KiroAdapter implements ICLIAdapter {
  readonly provider: ProviderType = 'kiro'
  readonly command = resolveKiroBinary()
  /** Tool trust (`--trust-all-tools` by default) comes from the launch settings. */
  readonly args: string[] = ['chat', '--no-interactive', '--wrap', 'never']
  /** One `kiro-cli chat --no-interactive` process per message. */
  readonly transport = 'oneshot' as const

  /** Kiro non-interactive reports its session ID only via `--list-sessions`. */
  readonly usesSessionListDetection = true

  /** Enumerate models via `kiro-cli chat --list-models` (cached). */
  listModels(): Promise<{ id: string; name?: string }[]> {
    return listKiroModels()
  }

  private lastToolName = 'tool'

  // ── Main entry point ─────────────────────────────────────────────────

  /**
   * Parse a line of stdout from the non-interactive CLI process.
   *
   * In non-interactive mode, stdout contains:
   * - Tool output lines (reading files, tool results, etc.)
   * - Assistant response text (first line prefixed with "> ")
   *
   * Credits go to stderr and are handled by onStderr().
   */
  onData(text: string): AdapterEvent[] {
    const events: AdapterEvent[] = []
    const lines = text.split('\n')

    for (const line of lines) {
      const trimmed = line.trim()
      if (trimmed.length === 0) continue

      // Skip the trust-all-tools warning lines (sometimes leak to stdout)
      if (trimmed.startsWith('All tools are now trusted')) continue
      if (trimmed.startsWith('Agents can sometimes do unexpected')) continue
      if (trimmed.startsWith('Learn more at')) continue
      if (trimmed.includes('kiro.dev/docs/cli/chat/security')) continue

      // Credits line (sometimes appears in stdout too)
      const credits = parseCredits(trimmed)
      if (credits) {
        events.push({
          type: 'message_complete',
          role: 'assistant',
          metadata: credits,
        })
        continue
      }

      // Tool output
      if (isToolLine(trimmed)) {
        const name = extractToolName(trimmed, this.lastToolName)
        const nameMatch = TOOL_NAME_PATTERN.exec(trimmed)
        if (nameMatch) this.lastToolName = nameMatch[1]
        events.push({ type: 'tool_use', tool: name, content: trimmed })
        continue
      }

      // Assistant text — strip leading "> " response marker
      let content = line
      if (content.startsWith('> ')) {
        content = content.slice(2)
      }

      // Skip empty content after stripping
      if (content.trim().length === 0) continue

      events.push({ type: 'chunk', content, role: 'assistant' })
    }

    return events
  }

  /**
   * Parse stderr output. In non-interactive mode, stderr contains:
   * - Trust-all-tools warning (skipped)
   * - Tool calls (`[tool] Reading a.ts:1`) — reported as tool_use, which
   *   also splits the reply around them (see SessionManager)
   * - Credits line (▸ Credits: 0.05 • Time: 3s)
   */
  onStderr(text: string): AdapterEvent[] {
    const events: AdapterEvent[] = []
    const lines = stripAnsi(text).split('\n')

    for (const line of lines) {
      const trimmed = line.trim()
      if (trimmed.length === 0) continue

      const tool = STDERR_TOOL_LINE.exec(trimmed)
      if (tool) {
        events.push({ type: 'tool_use', ...parseStderrTool(tool[1].trim()) })
        continue
      }

      const credits = parseCredits(trimmed)
      if (credits) {
        events.push({
          type: 'message_complete',
          role: 'assistant',
          metadata: credits,
        })
      }
    }

    return events
  }

  // ── Build command for a single message ───────────────────────────────

  /**
   * Build the command + args for a single non-interactive message.
   * If a CLI session ID is available, uses --resume-id for multi-turn.
   */
  buildMessageCommand(
    text: string,
    cliSessionId: string | null,
    attachments?: { path: string; mimeType: string }[],
    model?: string | null,
    _mcpServers?: McpServerSpec[],
    settings: SettingValues = defaultSettings('kiro'),
  ): { command: string; args: string[] } {
    // Trust flags, agent profile, effort, extra flags (provider-settings.ts).
    const args = [...this.args, ...settingsToArgs('kiro', settings)]

    if (cliSessionId) {
      args.push('--resume-id', cliSessionId)
    }

    // The default (v2) engine ignores `--model` ("failed to set model …
    // Method not found") and silently runs its default, so a pinned model
    // switches the chat to the v3 engine, which honours it and can resume v2
    // conversations. v3 prints no tool lines or credits, so "auto" — Kiro's
    // own default — stays on v2 to keep that activity visible.
    if (model && model !== 'auto') {
      args.push('--v3', '--model', model)
    }

    // Build the input: attachment references + user text
    let input = text
    if (attachments?.length) {
      const refs = attachments.map(a => this.formatAttachment(a.path, a.mimeType))
      input = refs.join(' ') + ' ' + text
    }

    args.push(input)

    return { command: this.command, args }
  }

  formatAttachment(filePath: string, mimeType: string): string {
    if (mimeType.startsWith('image/')) {
      return filePath
    }
    return `@${filePath}`
  }
}
