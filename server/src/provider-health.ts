import { spawnSync } from 'child_process'
import { existsSync } from 'fs'
import path from 'path'

import { listProviders, getAdapter } from './adapters/registry.js'
import type { ProviderType } from './schemas.js'

export interface ProviderHealth {
  provider: ProviderType
  /** The resolved binary/command the adapter would spawn. */
  command: string
  /** Whether the command appears to be runnable on this machine. */
  available: boolean
}

/**
 * Best-effort check that a CLI binary is runnable on this machine.
 *
 * - Absolute/relative paths are checked with `existsSync`.
 * - Bare command names are probed by invoking `<command> --version` with a
 *   short timeout; ENOENT (not found on PATH) marks it unavailable. A non-zero
 *   exit code still counts as "available" — the binary exists, it just didn't
 *   like `--version`.
 */
export function isBinaryAvailable(command: string): boolean {
  if (command.includes(path.sep) || command.includes('/')) {
    return existsSync(command)
  }

  try {
    const result = spawnSync(command, ['--version'], {
      timeout: 3000,
      stdio: 'ignore',
      shell: false,
    })
    if (result.error) {
      // ENOENT => not on PATH. Other errors (e.g. timeout) => treat as present.
      const code = (result.error as NodeJS.ErrnoException).code
      return code !== 'ENOENT'
    }
    return true
  } catch {
    return false
  }
}

/**
 * Report availability for every registered provider. Used by `/api/health`
 * and (later) to gate session creation / hide unavailable providers in the UI.
 */
export function getProviderHealth(): ProviderHealth[] {
  return listProviders().map((provider) => {
    const adapter = getAdapter(provider)
    const command = adapter?.command ?? ''
    return {
      provider,
      command,
      available: command ? isBinaryAvailable(command) : false,
    }
  })
}
