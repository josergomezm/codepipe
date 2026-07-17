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

import type { ProviderType } from '../schemas.js'
import type { ICLIAdapter, AdapterEvent } from './types.js'

/** Resolve the Antigravity CLI binary: `AGY_CLI_BIN` override (falls back to `GEMINI_CLI_BIN`), else platform default. */
export function resolveAgyBinary(): string {
  const override = process.env['AGY_CLI_BIN'] || process.env['GEMINI_CLI_BIN']
  if (override && override.trim().length > 0) return override.trim()
  return platform() === 'win32' ? 'agy.exe' : 'agy'
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

  private lastToolName = 'tool'
  private seenPromptReady = false

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
