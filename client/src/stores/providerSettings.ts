import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import * as api from '../api/client'
import type { ProviderSettingsInfo, ProviderType, SettingValues } from '../api/client'

/**
 * Provider launch settings: each provider's schema (what its CLI can be
 * started with, and when that list was last checked) plus the global layer.
 * Projects and personas keep their own overrides on their records; this
 * store supplies the schema and the inherited values they render against.
 */
export const useProviderSettingsStore = defineStore('providerSettings', () => {
  const providers = ref<ProviderSettingsInfo[]>([])
  const loaded = ref(false)
  const loading = ref(false)
  const error = ref<string | null>(null)

  const byProvider = computed(() => {
    const map = new Map<ProviderType, ProviderSettingsInfo>()
    for (const p of providers.value) map.set(p.spec.provider, p)
    return map
  })

  /** Providers that have launch settings (those with a server adapter). */
  const configurableProviders = computed(() => providers.value.map((p) => p.spec.provider))

  function infoFor(provider: ProviderType): ProviderSettingsInfo | undefined {
    return byProvider.value.get(provider)
  }

  async function fetch(force = false) {
    if (loaded.value && !force) return
    if (loading.value) return
    loading.value = true
    try {
      providers.value = (await api.fetchProviderSettings()).providers
      loaded.value = true
      error.value = null
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Failed to load provider settings'
    } finally {
      loading.value = false
    }
  }

  /** Replace a provider's global layer; the server echoes the new effective state. */
  async function saveGlobal(provider: ProviderType, values: SettingValues) {
    const updated = await api.updateProviderSettings(provider, values)
    const idx = providers.value.findIndex((p) => p.spec.provider === provider)
    if (idx >= 0) providers.value[idx] = updated
    else providers.value.push(updated)
    error.value = null
  }

  return { providers, loaded, loading, error, configurableProviders, infoFor, fetch, saveGlobal }
})
