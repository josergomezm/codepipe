/**
 * Claude Code adapter — non-interactive stream-json transport.
 *
 * Each message spawns `claude -p "<prompt>" --output-format stream-json
 * --verbose`, which emits newline-delimited JSON parsed by
 * `translateStreamJsonLine`. Multi-turn conversations resume via
 * `--resume <session_id>`, where the session ID is captured inline from the
 * stream (the `cli_session` event), so no session-list scraping is needed.
 *
 * Tool approval: defaults to `--permission-mode acceptEdits`. For fuller
 * autonomy (Bash, network, etc.) set `CLAUDE_PERMISSION_MODE` or append flags
 * via `CLAUDE_EXTRA_ARGS` (e.g. `--dangerously-skip-permissions`). See
 * SECURITY.md before broadening this.
 */

import { existsSync } from 'fs'
import { homedir, platform } from 'os'
import { join } from 'path'

import type { ProviderType } from '../schemas.js'
import type { ICLIAdapter, AdapterEvent } from './types.js'
import { translateStreamJsonLine } from './claude-stream-json.js'

/**
 * Resolve the Claude Code binary: `CLAUDE_CLI_BIN` override, else the native
 * installer location (`~/.local/bin`, which is often not on PATH on Windows),
 * else the PATH-based name (`claude.cmd` from an npm global install on
 * Windows, `claude` elsewhere).
 */
export function resolveClaudeBinary(): string {
  const override = process.env['CLAUDE_CLI_BIN']
  if (override && override.trim().length > 0) return override.trim()

  const isWindows = platform() === 'win32'
  const native = join(homedir(), '.local', 'bin', isWindows ? 'claude.exe' : 'claude')
  if (existsSync(native)) return native

  return isWindows ? 'claude.cmd' : 'claude'
}

/** Extra args from `CLAUDE_EXTRA_ARGS` (space-separated), for power users. */
function extraArgs(): string[] {
  const raw = process.env['CLAUDE_EXTRA_ARGS']
  return raw && raw.trim().length > 0 ? raw.trim().split(/\s+/) : []
}

export class ClaudeAdapter implements ICLIAdapter {
  readonly provider: ProviderType = 'claude'
  readonly command = resolveClaudeBinary()
  readonly args: string[] = ['--output-format', 'stream-json', '--verbose']
  readonly systemPrompt: string | undefined = undefined
  /** Session ID is captured inline (cli_session event), not from disk. */
  readonly cliSessionDir: string | null = null
  readonly nonInteractive = true
  readonly transport = 'oneshot' as const

  /**
   * Claude Code has no command to enumerate models, so we offer its documented
   * aliases (which always map to the current version) plus a "Custom…" option
   * in the UI for pinning a full model ID. Aliases per the CLI reference:
   * `sonnet`, `opus`, `haiku`, `fable`.
   */
  readonly suggestedModels = [
    { id: 'default', name: 'Default (account setting)' },
    { id: 'sonnet', name: 'Sonnet (latest)' },
    { id: 'opus', name: 'Opus (latest)' },
    { id: 'haiku', name: 'Haiku (latest)' },
    { id: 'fable', name: 'Fable (latest)' },
  ]

  onData(text: string): AdapterEvent[] {
    return translateStreamJsonLine(text)
  }

  buildMessageCommand(
    text: string,
    cliSessionId: string | null,
    attachments?: { path: string; mimeType: string }[],
    model?: string | null,
  ): { command: string; args: string[] } {
    const permissionMode = process.env['CLAUDE_PERMISSION_MODE'] ?? 'acceptEdits'
    const args = [...this.args, '--permission-mode', permissionMode, ...extraArgs()]

    if (model) {
      args.push('--model', model)
    }

    if (cliSessionId) {
      args.push('--resume', cliSessionId)
    }

    // Inline attachment file references into the prompt text.
    let input = text
    if (attachments?.length) {
      const refs = attachments.map((a) => this.formatAttachment(a.path, a.mimeType))
      input = refs.join(' ') + ' ' + text
    }

    // `-p` enables non-interactive print mode; the prompt is the positional arg.
    args.push('-p', input)

    return { command: this.command, args }
  }

  notifyUserInput(_text: string): void {
    /* no-op — state is per-process / resumed via --resume */
  }

  notifySystemInput(_text: string): void {
    /* no-op */
  }

  reset(): void {
    /* no-op */
  }

  formatAttachment(filePath: string, _mimeType: string): string {
    // Claude Code reads file references prefixed with @.
    return `@${filePath}`
  }

  getResumeCommand(): { command: string; args: string[] } | null {
    // Resume is handled per-message via --resume in buildMessageCommand.
    return null
  }
}
