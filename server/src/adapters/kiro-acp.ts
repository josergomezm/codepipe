/**
 * Kiro CLI adapter — ACP (Agent Client Protocol) transport.
 *
 * Instead of scraping `--no-interactive` text output line by line (see
 * `kiro.ts` + `kiro-patterns.ts`), this adapter drives a persistent
 * `kiro-cli acp` process over JSON-RPC. The SessionManager detects
 * `transport === 'acp'` and runs an AcpSessionDriver, so the brittle
 * `onData`/credits/glyph parsing is bypassed entirely.
 *
 * Opt in by registering this adapter for the `kiro` provider (e.g. via
 * `KIRO_TRANSPORT=acp`). The non-interactive adapter remains the default.
 */

import path from 'path'
import { homedir } from 'os'

import type { ProviderType } from '../schemas.js'
import type { ICLIAdapter, AdapterEvent } from './types.js'
import { SPEC_ACP_PROFILE } from '../acp/profile.js'
import { resolveKiroBinary, listKiroModels } from './kiro.js'

export class KiroAcpAdapter implements ICLIAdapter {
  readonly provider: ProviderType = 'kiro'
  readonly command = resolveKiroBinary()
  /** Launch args (`acp`) live in the ACP profile. */
  readonly args: string[] = []
  readonly systemPrompt: string | undefined = undefined
  readonly cliSessionDir: string = path.join(homedir(), '.kiro', 'sessions', 'cli')
  readonly transport = 'acp' as const
  readonly acpProfile = SPEC_ACP_PROFILE

  /**
   * Fallback model enumeration via the CLI (cached). Used when the ACP
   * `session/new` result doesn't advertise a model list.
   */
  listModels(): Promise<{ id: string; name?: string }[]> {
    return listKiroModels()
  }

  // ── onData et al. are unused for the ACP transport ───────────────────
  // The SessionManager routes ACP sessions through AcpSessionDriver and never
  // calls these, but they satisfy the ICLIAdapter contract.

  onData(_text: string): AdapterEvent[] {
    return []
  }

  notifyUserInput(_text: string): void {
    /* no-op — state lives in the ACP session */
  }

  notifySystemInput(_text: string): void {
    /* no-op */
  }

  reset(): void {
    /* no-op — session lifecycle handled by the driver */
  }

  /**
   * For ACP, attachments are sent as structured content blocks by the driver,
   * not inlined into the prompt text. Return an empty string so the
   * SessionManager doesn't prepend anything.
   */
  formatAttachment(_filePath: string, _mimeType: string): string {
    return ''
  }

  /**
   * Resume is handled natively by the driver via `session/load`, so there's
   * no separate resume command to build.
   */
  getResumeCommand(): { command: string; args: string[] } | null {
    return null
  }
}
