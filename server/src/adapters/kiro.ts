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
import { homedir } from 'os'

import type { ProviderType } from '../schemas.js'
import type { ICLIAdapter, AdapterEvent } from './types.js'
import {
  parseCredits,
  isToolLine,
  extractToolName,
  TOOL_NAME_PATTERN,
} from './kiro-patterns.js'

export class KiroAdapter implements ICLIAdapter {
  readonly provider: ProviderType = 'kiro'
  readonly command = 'kiro-cli.exe'
  readonly args: string[] = ['chat', '--no-interactive', '--trust-all-tools', '--wrap', 'never']
  readonly systemPrompt: string | undefined = undefined
  readonly cliSessionDir: string = path.join(homedir(), '.kiro', 'sessions', 'cli')

  /**
   * Whether this adapter uses non-interactive mode (spawn per message)
   * rather than a persistent PTY process.
   */
  readonly nonInteractive = true

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
  ): { command: string; args: string[] } {
    const args = [...this.args]

    if (cliSessionId) {
      args.push('--resume-id', cliSessionId)
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
