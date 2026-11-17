<script setup lang="ts">
/**
 * Per-provider plan usage, as each CLI's own /usage reports it. Mounted
 * once in App.vue; opened from the sidebar's Usage row.
 */
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useUsageStore, usageTone } from '@/stores/usage'
import { providerLabel } from '@/api/client'

const usage = useUsageStore()

// Re-render "checked N min ago" while open.
const now = ref(Date.now())
let tick: ReturnType<typeof setInterval> | null = null

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape' && usage.modalOpen) usage.closeModal()
}
onMounted(() => {
  document.addEventListener('keydown', onKeydown)
  tick = setInterval(() => (now.value = Date.now()), 15_000)
})
onUnmounted(() => {
  document.removeEventListener('keydown', onKeydown)
  if (tick) clearInterval(tick)
})

function ago(ts: number): string {
  const s = Math.max(0, Math.round((now.value - ts) / 1000))
  if (s < 60) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m} min ago`
  return `${Math.round(m / 60)} h ago`
}

const oldestCheck = computed(() =>
  usage.providers.length ? Math.min(...usage.providers.map((p) => p.checkedAt)) : null,
)

const BAR: Record<string, string> = {
  ok: 'bg-blue-500',
  warn: 'bg-amber-500',
  danger: 'bg-red-500',
}
const TEXT: Record<string, string> = {
  ok: 'text-gray-900 dark:text-gray-100',
  warn: 'text-amber-600 dark:text-amber-400',
  danger: 'text-red-600 dark:text-red-400',
}
</script>

<template>
  <Teleport to="body">
    <div
      v-if="usage.modalOpen"
      class="fixed inset-0 z-50 flex items-end justify-center bg-black/50 sm:items-start sm:p-4 sm:pt-[10vh]"
      @click.self="usage.closeModal()"
    >
      <div class="flex max-h-[90vh] w-full max-w-lg flex-col rounded-t-xl bg-white shadow-xl dark:bg-gray-900 sm:rounded-xl">
        <!-- Header -->
        <div class="flex items-center gap-2 border-b border-gray-200 px-4 py-3 dark:border-gray-800">
          <h2 class="flex-1 text-sm font-semibold text-gray-900 dark:text-gray-100">Usage</h2>
          <button
            class="flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium text-gray-500 transition hover:bg-gray-100 hover:text-gray-700 disabled:opacity-50 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-gray-200"
            :disabled="usage.loading"
            title="Re-run each provider's /usage"
            @click="usage.load(true)"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" class="h-3.5 w-3.5"
              :class="{ 'animate-spin': usage.loading }" aria-hidden="true"
            >
              <path fill-rule="evenodd" d="M13.836 2.477a.75.75 0 0 1 .75.75v3.182a.75.75 0 0 1-.75.75h-3.182a.75.75 0 0 1 0-1.5h1.37l-.84-.841a4.5 4.5 0 0 0-7.08.932.75.75 0 0 1-1.3-.75 6 6 0 0 1 9.44-1.242l.842.84V3.227a.75.75 0 0 1 .75-.75Zm-.911 7.5A.75.75 0 0 1 13.199 11a6 6 0 0 1-9.44 1.241l-.84-.84v1.371a.75.75 0 0 1-1.5 0V9.591a.75.75 0 0 1 .75-.75H5.35a.75.75 0 0 1 0 1.5H3.98l.841.841a4.5 4.5 0 0 0 7.08-.932.75.75 0 0 1 1.025-.273Z" clip-rule="evenodd" />
            </svg>
            {{ usage.loading ? 'Checking…' : 'Refresh' }}
          </button>
          <button
            class="rounded-lg p-1 text-gray-400 transition hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-800 dark:hover:text-gray-300"
            title="Close"
            @click="usage.closeModal()"
          >
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" class="h-5 w-5">
              <path d="M6.28 5.22a.75.75 0 0 0-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 1 0 1.06 1.06L10 11.06l3.72 3.72a.75.75 0 1 0 1.06-1.06L11.06 10l3.72-3.72a.75.75 0 0 0-1.06-1.06L10 8.94 6.28 5.22Z" />
            </svg>
          </button>
        </div>

        <!-- Body -->
        <div class="flex flex-col gap-3 overflow-y-auto px-4 py-4">
          <p v-if="usage.error && usage.providers.length === 0" class="text-sm text-red-600 dark:text-red-400">
            {{ usage.error }}
          </p>
          <p v-else-if="usage.providers.length === 0" class="text-sm text-gray-500 dark:text-gray-400">
            Checking each provider…
          </p>

          <section
            v-for="p in usage.providers"
            :key="p.provider"
            class="rounded-lg border border-gray-200 p-3 dark:border-gray-800"
          >
            <div class="mb-2 flex items-center gap-2">
              <h3 class="text-sm font-semibold text-gray-900 dark:text-gray-100">{{ providerLabel(p.provider) }}</h3>
              <span
                v-if="p.plan"
                class="rounded bg-gray-100 px-1.5 py-0.5 text-[10px] font-medium text-gray-600 dark:bg-gray-800 dark:text-gray-300"
              >{{ p.plan }}</span>
              <span class="flex-1" />
              <span class="text-[10px] text-gray-400 dark:text-gray-500">{{ ago(p.checkedAt) }}</span>
            </div>

            <p
              v-if="p.status === 'error'"
              class="mb-2 rounded bg-red-50 px-2 py-1 text-xs text-red-700 dark:bg-red-900/20 dark:text-red-300"
            >
              Couldn't read usage: {{ p.error }}<template v-if="p.windows.length"> · showing the last reading</template>
            </p>

            <div v-if="p.windows.length" class="flex flex-col gap-2.5">
              <div v-for="w in p.windows" :key="w.label" class="flex flex-col gap-1">
                <div class="flex items-baseline gap-2 text-xs">
                  <span class="min-w-0 flex-1 truncate text-gray-700 dark:text-gray-300">{{ w.label }}</span>
                  <span v-if="w.detail" class="shrink-0 text-gray-400 dark:text-gray-500">{{ w.detail }}</span>
                  <span
                    v-if="w.usedPercent !== null"
                    class="shrink-0 font-semibold tabular-nums"
                    :class="TEXT[usageTone(w.usedPercent)]"
                  >{{ w.usedPercent }}%</span>
                </div>
                <div v-if="w.usedPercent !== null" class="h-1.5 w-full overflow-hidden rounded-full bg-gray-200 dark:bg-gray-700">
                  <div
                    class="h-full rounded-full transition-all"
                    :class="BAR[usageTone(w.usedPercent)]"
                    :style="{ width: `${Math.min(100, w.usedPercent)}%` }"
                  />
                </div>
                <span v-if="w.resets" class="text-[10px] text-gray-400 dark:text-gray-500">Resets {{ w.resets }}</span>
              </div>
            </div>
            <p v-else-if="p.status === 'ok' && p.notes.length === 0" class="text-xs text-gray-500 dark:text-gray-400">
              No limits reported.
            </p>

            <ul v-if="p.notes.length" class="mt-2 flex flex-col gap-0.5">
              <li v-for="n in p.notes" :key="n" class="text-[11px] text-gray-500 dark:text-gray-400">{{ n }}</li>
            </ul>
          </section>

          <p v-if="oldestCheck" class="text-center text-[10px] text-gray-400 dark:text-gray-500">
            From each CLI's own /usage command · refreshed every few minutes
          </p>
        </div>
      </div>
    </div>
  </Teleport>
</template>
