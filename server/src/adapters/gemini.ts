/**
 * Gemini CLI adapter — ACP transport.
 *
 * Gemini CLI runs as an Agent Client Protocol agent via `gemini --acp`,
 * speaking JSON-RPC 2.0 over stdio. CodePipe drives it with the same
 * AcpSessionDriver used for Kiro, parameterized by the Gemini ACP profile
 * (its method names differ from the spec, and it uses `setSessionMode` to
 * auto-approve tool calls).
 *
 * Verify method/param names against your installed `gemini` — the profile
 * reflects Gemini's published ACP-mode docs but the binary is authoritative.
 */

import { platform } from 'os'

import type { ProviderType } from '../schemas.js'
import type { ICLIAdapter, AdapterEvent } from './types.js'
import { GEMINI_ACP_PROFILE } from '../acp/profile.js'

/** Resolve the Gemini CLI binary: `GEMINI_CLI_BIN` override, else platform default. */
export function resolveGeminiBinary(): string {
  const override = process.env['GEMINI_CLI_BIN']
  if (override && override.trim().length > 0) return override.trim()
  return platform() === 'win32' ? 'gemini.exe' : 'gemini'
}

export class GeminiAdapter implements ICLIAdapter {
  readonly provider: ProviderType = 'gemini'
  readonly command = resolveGeminiBinary()
  readonly args: string[] = []
  readonly systemPrompt: string | undefined = undefined
  readonly cliSessionDir: string | null = null
  readonly transport = 'acp' as const
  readonly acpProfile = GEMINI_ACP_PROFILE

  onData(_text: string): AdapterEvent[] {
    return []
  }

  notifyUserInput(_text: string): void {
    /* no-op — handled by the ACP session */
  }

  notifySystemInput(_text: string): void {
    /* no-op */
  }

  reset(): void {
    /* no-op */
  }

  formatAttachment(_filePath: string, _mimeType: string): string {
    return ''
  }

  getResumeCommand(): { command: string; args: string[] } | null {
    return null
  }
}
