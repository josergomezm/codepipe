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
 * Tool use is auto-approved with `--trust-all-tools`.
 */

import path from 'path'
import { homedir, platform } from 'os'
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
      { timeout: 15000, windowsHide: true },
    )
    const models = parseKiroModelList(stdout)
    if (models.length > 0) {
      cachedModels = models
      cachedModelsAt = now
    }
    return models
  } catch {
    return []
  }
}

export class KiroAdapter implements ICLIAdapter {
  readonly provider: ProviderType = 'kiro'
  readonly command = resolveKiroBinary()
  readonly args: string[] = ['chat', '--no-interactive', '--trust-all-tools', '--wrap', 'never']
  readonly systemPrompt: string | undefined = undefined
  readonly cliSessionDir: string = path.join(homedir(), '.kiro', 'sessions', 'cli')

  /**
   * Whether this adapter uses non-interactive mode (spawn per message)
   * rather than a persistent PTY process.
   */
  readonly nonInteractive = true

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
   * - Credits line (▸ Credits: 0.05 • Time: 3s)
   */
  onStderr(text: string): AdapterEvent[] {
    const events: AdapterEvent[] = []
    const lines = text.split('\n')

    for (const line of lines) {
      const trimmed = line.trim()
      if (trimmed.length === 0) continue

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
  ): { command: string; args: string[] } {
    const args = [...this.args]

    if (cliSessionId) {
      args.push('--resume-id', cliSessionId)
    }

    if (model) {
      args.push('--model', model)
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

  // ── Interface methods (simplified for non-interactive mode) ──────────

  notifyUserInput(_text: string): void {
    // No-op in non-interactive mode — state is managed per-process
  }

  notifySystemInput(_text: string): void {
    // No-op in non-interactive mode — no persistent process to send to
  }

  reset(): void {
    this.lastToolName = 'tool'
  }

  formatAttachment(filePath: string, mimeType: string): string {
    if (mimeType.startsWith('image/')) {
      return filePath
    }
    return `@${filePath}`
  }

  getResumeCommand(cliSessionId: string | null): { command: string; args: string[] } | null {
    // Not used in non-interactive mode — resume is handled per-message
    // via buildMessageCommand. Keep for interface compatibility.
    if (cliSessionId) {
      return {
        command: this.command,
        args: ['chat', '--no-interactive', '--trust-all-tools', '--wrap', 'never', '--resume-id', cliSessionId],
      }
    }
    return null
  }
}
