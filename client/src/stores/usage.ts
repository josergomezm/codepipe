import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import * as api from '../api/client'
import type { ProviderUsage, UsageWindow } from '../api/client'

/** The window closest to its limit — what the sidebar meter shows. */
export function headlineWindow(p: ProviderUsage): UsageWindow | null {
  let best: UsageWindow | null = null
  for (const w of p.windows) {
    if (w.usedPercent === null) continue
    if (!best || w.usedPercent > (best.usedPercent ?? -1)) best = w
  }
  return best
}

/** Bar/text color for a usage percentage. */
export function usageTone(percent: number | null): 'ok' | 'warn' | 'danger' {
  if (percent === null) return 'ok'
  if (percent >= 90) return 'danger'
  if (percent >= 75) return 'warn'
  return 'ok'
}

export const useUsageStore = defineStore('usage', () => {
  const providers = ref<ProviderUsage[]>([])
  const loading = ref(false)
  const error = ref<string | null>(null)
  const modalOpen = ref(false)
  let inFlight: Promise<void> | null = null

  async function load(refresh = false) {
    if (inFlight) return inFlight
    loading.value = true
    inFlight = (async () => {
      try {
        providers.value = (await api.fetchUsage(refresh)).providers
        error.value = null
      } catch (err) {
        error.value = err instanceof Error ? err.message : 'Failed to load usage'
      } finally {
        loading.value = false
        inFlight = null
      }
    })()
    return inFlight
  }

  /** Providers that reported at least one percentage, for the compact meter. */
  const headlines = computed(() =>
    providers.value
      .map((p) => ({ provider: p.provider, window: headlineWindow(p), status: p.status }))
      .filter((h) => h.window !== null),
  )

  function openModal() {
    modalOpen.value = true
    void load(true)
  }

  function closeModal() {
    modalOpen.value = false
  }

  return { providers, loading, error, modalOpen, headlines, load, openModal, closeModal }
})
