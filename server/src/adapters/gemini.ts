/**
 * Antigravity CLI adapter — PTY text-parsing transport.
 *
 * Google replaced Gemini CLI with Antigravity CLI (`agy`) in June 2026.
 * ACP stdio mode is NOT yet available — tracked at:
 * https://github.com/google-antigravity/antigravity-cli/issues/31
 *
 * Until ACP ships, we drive `agy` via a persistent PTY and parse its TUI
 * output. The adapter uses `--dangerously-skip-permissions` so tool calls
 * don't block waiting for interactive approval in the TUI.
 *
 * Output patterns (from agy's bubbletea TUI, post ANSI-strip):
 *   ● ToolName(args)         — tool invocation
 *   ▸ Thought for Xs, N tokens — thinking indicator
 *   > (prompt marker)        — ready for input
 *   Regular text             — assistant response content
 */

import { platform } from 'os'
import { execFile } from 'child_process'
import { promisify } from 'util'

import type { ProviderType } from '../schemas.js'
import type { ICLIAdapter, AdapterEvent } from './types.js'

/** Resolve the Antigravity CLI binary: `AGY_CLI_BIN` override (falls back to `GEMINI_CLI_BIN`), else platform default. */
export function resolveAgyBinary(): string {
  const override = process.env['AGY_CLI_BIN'] || process.env['GEMINI_CLI_BIN']
  if (override && override.trim().length > 0) return override.trim()
  return platform() === 'win32' ? 'agy.exe' : 'agy'
}

// ---------------------------------------------------------------------------
// Model enumeration (`agy models` — one model ID per line)
// ---------------------------------------------------------------------------

const execFileAsync = promisify(execFile)

/** Parse `agy models` output: one bare model ID per line; skip banner lines. */
export function parseAgyModelList(stdout: string): { id: string }[] {
  return stdout
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.includes(' '))
    .map((id) => ({ id }))
}

let cachedModels: { id: string }[] | null = null
let cachedModelsAt = 0
const MODEL_CACHE_TTL_MS = 10 * 60 * 1000

/** Enumerate Antigravity's models via `agy models`, cached for 10 minutes. */
export async function listAgyModels(): Promise<{ id: string }[]> {
  const now = Date.now()
  if (cachedModels && now - cachedModelsAt < MODEL_CACHE_TTL_MS) return cachedModels
  try {
    const { stdout } = await execFileAsync(resolveAgyBinary(), ['models'], {
      timeout: 15000,
      windowsHide: true,
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

// --- Patterns ----------------------------------------------------------------

/** Tool invocation: ● ToolName(args) or ● ToolName (no parens) */
const TOOL_CALL_PATTERN = /^● (\w+)\(?(.*?)\)?$/

/** Thinking indicator: ▸ Thought for Xs, N tokens */
const THINKING_PATTERN = /^▸ Thought for .+/

/** Prompt ready: line is just ">" or starts with "> " at input position */
const PROMPT_READY_PATTERN = /^>\s*$/

/** TUI chrome to skip: status line, model indicator, shortcuts hint */
const CHROME_PATTERNS = [
  /^\s*\?.*shortcuts/i,
  /^───+$/,
  /^\s*Gemini \d/,
  /^\s*Claude /,
  /^\s*GPT-OSS /,
  /^Antigravity CLI/,
  /^\s*~\//,
  /^Requesting permission for:/,
  /^Do you want to proceed\?/,
  /^\s*▄▀/,
  /^\s*▀▀/,
  /^\s*▄▀▀/,
]

/** Lines indicating a tool result/context (collapsed output) */
const TOOL_CONTEXT_PATTERN = /^\s*⎿\s*/

export class GeminiAdapter implements ICLIAdapter {
  readonly provider: ProviderType = 'gemini'
  readonly command = resolveAgyBinary()
  readonly args: string[] = ['--dangerously-skip-permissions']
  readonly systemPrompt: string | undefined = undefined
  readonly cliSessionDir: string | null = null
  readonly transport = 'pty' as const

  /** Model is applied at spawn (`agy --model <id>`); switching needs a CLI restart. */
  readonly modelSpawnFlag = '--model'

  private lastToolName = 'tool'
  private seenPromptReady = false

  /** Enumerate models via `agy models` (cached). */
  listModels(): Promise<{ id: string; name?: string }[]> {
    return listAgyModels()
  }

  onData(text: string): AdapterEvent[] {
    const events: AdapterEvent[] = []
    const lines = text.split('\n')

    for (const line of lines) {
      const trimmed = line.trim()
      if (trimmed.length === 0) continue

      // Skip TUI chrome
      if (isChrome(trimmed)) continue

      // Prompt ready — signals turn complete
      if (PROMPT_READY_PATTERN.test(trimmed)) {
        if (this.seenPromptReady) {
          // Second prompt ready after content = turn done
          events.push({ type: 'message_complete', role: 'assistant' })
        }
        this.seenPromptReady = true
        continue
      }

      // Tool invocation
      const toolMatch = TOOL_CALL_PATTERN.exec(trimmed)
      if (toolMatch) {
        this.lastToolName = toolMatch[1]
        events.push({ type: 'tool_use', tool: toolMatch[1], content: trimmed })
        this.seenPromptReady = false
        continue
      }

      // Tool result (indented under ⎿)
      if (TOOL_CONTEXT_PATTERN.test(line)) {
        const content = line.replace(TOOL_CONTEXT_PATTERN, '').trim()
        if (content.length > 0) {
          events.push({ type: 'tool_use', tool: this.lastToolName, content })
        }
        continue
      }

      // Thinking indicator — skip, not user-visible content
      if (THINKING_PATTERN.test(trimmed)) continue

      // Assistant text
      events.push({ type: 'chunk', content: line, role: 'assistant' })
      this.seenPromptReady = false
    }

    return events
  }

  notifyUserInput(_text: string): void {
    /* PTY write is handled by SessionManager */
  }

  notifySystemInput(_text: string): void {
    /* no-op */
  }

  reset(): void {
    this.lastToolName = 'tool'
    this.seenPromptReady = false
  }

  formatAttachment(filePath: string, _mimeType: string): string {
    return `@${filePath}`
  }

  getResumeCommand(): { command: string; args: string[] } | null {
    return null
  }
}

function isChrome(line: string): boolean {
  return CHROME_PATTERNS.some(p => p.test(line))
}
