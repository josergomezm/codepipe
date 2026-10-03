import { spawn } from 'child_process'
import { existsSync } from 'fs'
import path from 'path'

import { listProviders, getAdapter } from './adapters/registry.js'
import type { ProviderType } from './schemas.js'
import { ISOLATED_CHILD } from './child-options.js'

export interface ProviderHealth {
  provider: ProviderType
  /** The resolved binary/command the adapter would spawn. */
  command: string
  /** Whether the command appears to be runnable on this machine. */
  available: boolean
}

const PROBE_TIMEOUT_MS = 3000
/** Installed CLIs rarely change; don't re-run every probe on each request. */
const CACHE_MS = 60_000

/**
 * Best-effort check that a CLI binary is runnable on this machine.
 *
 * - Absolute/relative paths are checked with `existsSync`.
 * - Bare command names are probed by invoking `<command> --version` with a
 *   short timeout; ENOENT (not found on PATH) marks it unavailable. A non-zero
 *   exit code still counts as "available" — the binary exists, it just didn't
 *   like `--version`.
 *
 * Async on purpose: some CLIs take seconds to print a version (agy can take
 * 3 s+), and a synchronous probe froze the whole server meanwhile.
 */
export function isBinaryAvailable(command: string): Promise<boolean> {
  if (command.includes(path.sep) || command.includes('/')) {
    return Promise.resolve(existsSync(command))
  }
  return new Promise((resolve) => {
    let settled = false
    const done = (available: boolean) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(available)
    }
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(command, ['--version'], { stdio: 'ignore', shell: false, ...ISOLATED_CHILD })
    } catch {
      resolve(false)
      return
    }
    // Slow to answer still means it's installed.
    const timer = setTimeout(() => {
      try { child.kill() } catch { /* already gone */ }
      done(true)
    }, PROBE_TIMEOUT_MS)
    child.on('error', (err: NodeJS.ErrnoException) => done(err.code !== 'ENOENT'))
    child.on('close', () => done(true))
  })
}

let cache: { at: number; result: Promise<ProviderHealth[]> } | null = null

/**
 * Report availability for every registered provider, probing them in
 * parallel and caching the answer for a minute. Used by `/api/health`.
 */
export function getProviderHealth(): Promise<ProviderHealth[]> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.result
  const result = Promise.all(
    listProviders().map(async (provider) => {
      const command = getAdapter(provider)?.command ?? ''
      return { provider, command, available: command ? await isBinaryAvailable(command) : false }
    }),
  )
  cache = { at: Date.now(), result }
  return result
}
