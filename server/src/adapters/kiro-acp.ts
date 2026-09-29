/**
 * Kiro CLI adapter — ACP (Agent Client Protocol) transport.
 *
 * Instead of scraping `--no-interactive` text output line by line (see
 * `kiro.ts` + `kiro-patterns.ts`), this adapter drives a persistent
 * `kiro-cli acp` process over JSON-RPC. The SessionManager detects
 * `transport === 'acp'` and runs an AcpSessionDriver, so the brittle
 * `onData`/credits/glyph parsing is bypassed entirely. Attachments are sent
 * as structured content blocks and resume uses `session/load`, both in the
 * driver.
 *
 * Opt in by registering this adapter for the `kiro` provider (e.g. via
 * `KIRO_TRANSPORT=acp`). The non-interactive adapter remains the default.
 */

import type { ProviderType } from '../schemas.js'
import type { ICLIAdapter, AdapterEvent } from './types.js'
import { SPEC_ACP_PROFILE } from '../acp/profile.js'
import { resolveKiroBinary, listKiroModels } from './kiro.js'

export class KiroAcpAdapter implements ICLIAdapter {
  readonly provider: ProviderType = 'kiro'
  readonly command = resolveKiroBinary()
  /** Launch args (`acp`) live in the ACP profile. */
  readonly args: string[] = []
  readonly transport = 'acp' as const
  readonly acpProfile = SPEC_ACP_PROFILE

  /**
   * Fallback model enumeration via the CLI (cached). Used when the ACP
   * `session/new` result doesn't advertise a model list.
   */
  listModels(): Promise<{ id: string; name?: string }[]> {
    return listKiroModels()
  }

  /** Unused for ACP — the driver parses structured output — but required by ICLIAdapter. */
  onData(_text: string): AdapterEvent[] {
    return []
  }
}
