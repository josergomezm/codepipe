<script setup lang="ts">
/**
 * Sidebar footer row: each provider's most-used plan window as a mini bar.
 * Click opens the per-provider breakdown (UsageModal). Polls slowly — the
 * server caches each CLI's /usage reading for a few minutes anyway.
 */
import { onMounted, onUnmounted } from 'vue'
import { useUsageStore, usageTone } from '@/stores/usage'
import { providerLabel } from '@/api/client'

const usage = useUsageStore()

const POLL_MS = 5 * 60_000
let timer: ReturnType<typeof setInterval> | null = null
function poll() {
  if (document.visibilityState === 'visible') void usage.load()
}
onMounted(() => {
  void usage.load()
  timer = setInterval(poll, POLL_MS)
  window.addEventListener('focus', poll)
})
onUnmounted(() => {
  if (timer) clearInterval(timer)
  window.removeEventListener('focus', poll)
})

const BAR: Record<string, string> = {
  ok: 'bg-blue-500',
  warn: 'bg-amber-500',
  danger: 'bg-red-500',
}
const TEXT: Record<string, string> = {
  ok: 'text-gray-500 dark:text-gray-400',
  warn: 'text-amber-600 dark:text-amber-400',
  danger: 'text-red-600 dark:text-red-400',
}
</script>

<template>
  <div class="px-2">
    <button
      class="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-gray-600 transition hover:bg-gray-200 dark:text-gray-300 dark:hover:bg-gray-800"
      title="Plan usage by provider"
      @click="usage.openModal()"
    >
      <!-- Gauge icon -->
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" class="h-4 w-4 shrink-0" aria-hidden="true">
        <path d="M15.5 2A1.5 1.5 0 0 0 14 3.5v13a1.5 1.5 0 0 0 1.5 1.5h1a1.5 1.5 0 0 0 1.5-1.5v-13A1.5 1.5 0 0 0 16.5 2h-1ZM9.5 6A1.5 1.5 0 0 0 8 7.5v9A1.5 1.5 0 0 0 9.5 18h1a1.5 1.5 0 0 0 1.5-1.5v-9A1.5 1.5 0 0 0 10.5 6h-1ZM3.5 10A1.5 1.5 0 0 0 2 11.5v5A1.5 1.5 0 0 0 3.5 18h1A1.5 1.5 0 0 0 6 16.5v-5A1.5 1.5 0 0 0 4.5 10h-1Z" />
      </svg>
      <span class="shrink-0">Usage</span>

      <span class="flex min-w-0 flex-1 items-center justify-end gap-2">
        <span
          v-if="usage.headlines.length === 0"
          class="truncate text-xs text-gray-400 dark:text-gray-500"
        >{{ usage.loading ? 'Checking…' : usage.error ? 'Unavailable' : '' }}</span>
        <span
          v-for="h in usage.headlines"
          :key="h.provider"
          class="flex w-16 shrink-0 flex-col gap-0.5"
          :title="`${providerLabel(h.provider)} · ${h.window!.label}: ${h.window!.usedPercent}% used`"
        >
          <span class="flex items-baseline justify-between text-[10px] leading-none">
            <span class="truncate text-gray-500 dark:text-gray-400">{{ providerLabel(h.provider) }}</span>
            <span class="font-medium tabular-nums" :class="TEXT[usageTone(h.window!.usedPercent)]">{{ Math.round(h.window!.usedPercent!) }}%</span>
          </span>
          <span class="h-1 w-full overflow-hidden rounded-full bg-gray-200 dark:bg-gray-700">
            <span
              class="block h-full rounded-full"
              :class="BAR[usageTone(h.window!.usedPercent)]"
              :style="{ width: `${Math.min(100, h.window!.usedPercent!)}%` }"
            />
          </span>
        </span>
      </span>
    </button>
  </div>
</template>
