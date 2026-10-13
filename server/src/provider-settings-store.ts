/**
 * The global layer of provider launch settings, persisted to
 * `data/provider-settings.json`. Loaded once at startup and kept in memory
 * so the session manager can read it synchronously at spawn time; writes
 * are serialized and atomic (json-file.ts).
 */

import { mkdir, readFile } from 'fs/promises'
import path from 'path'

import type { ProviderType } from './schemas.js'
import { validateSettingValues, type SettingValues } from './provider-settings.js'
import { atomicWriteJson, FileLocks } from './json-file.js'
import { log } from './logger.js'

interface FileShape {
  version: 1
  providers: Partial<Record<ProviderType, SettingValues>>
}

export class ProviderSettingsStore {
  private readonly file: string
  private providers: Partial<Record<ProviderType, SettingValues>> = {}
  private readonly locks = new FileLocks()

  constructor(opts: { dataDir: string }) {
    this.file = path.join(opts.dataDir, 'provider-settings.json')
  }

  /** Read the file; a missing or unreadable file means no overrides. */
  async load(): Promise<void> {
    let raw: string
    try {
      raw = await readFile(this.file, 'utf8')
    } catch {
      this.providers = {}
      return
    }
    try {
      const parsed = JSON.parse(raw) as Partial<FileShape>
      const providers: Partial<Record<ProviderType, SettingValues>> = {}
      for (const [provider, values] of Object.entries(parsed.providers ?? {})) {
        // Re-validate on load: a spec may have dropped or renamed a key since
        // the file was written — keep what still applies.
        const result = validateSettingValues(provider as ProviderType, values)
        if (result.ok) providers[provider as ProviderType] = result.values
        else log.warn('settings', `Ignoring invalid ${provider} settings in ${this.file}: ${result.errors.join('; ')}`)
      }
      this.providers = providers
    } catch (err) {
      log.error('settings', `Failed to parse ${this.file} — starting with no global overrides`, err)
      this.providers = {}
    }
  }

  /** The global overrides for a provider (only keys explicitly set). */
  get(provider: ProviderType): SettingValues {
    return { ...(this.providers[provider] ?? {}) }
  }

  all(): Partial<Record<ProviderType, SettingValues>> {
    const out: Partial<Record<ProviderType, SettingValues>> = {}
    for (const [p, v] of Object.entries(this.providers)) out[p as ProviderType] = { ...v }
    return out
  }

  /** Replace a provider's global overrides (already validated by the caller). */
  async set(provider: ProviderType, values: SettingValues): Promise<void> {
    if (Object.keys(values).length === 0) delete this.providers[provider]
    else this.providers[provider] = { ...values }
    await this.persist()
  }

  private persist(): Promise<void> {
    const snapshot: FileShape = { version: 1, providers: this.all() }
    return this.locks.runExclusive(this.file, async () => {
      await mkdir(path.dirname(this.file), { recursive: true })
      await atomicWriteJson(this.file, snapshot)
    })
  }
}
