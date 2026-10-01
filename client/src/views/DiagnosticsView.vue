<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useUiStore } from '@/stores/ui'
import { fetchDiagnostics, fetchCrashReport, type Diagnostics } from '@/api/client'

const ui = useUiStore()

const data = ref<Diagnostics | null>(null)
const error = ref<string | null>(null)
const loading = ref(false)
const openReport = ref<string | null>(null)
const reportText = ref<string>('')
const showProblems = ref(false)

let timer: ReturnType<typeof setInterval> | null = null

async function load() {
  loading.value = true
  try {
    data.value = await fetchDiagnostics()
    error.value = null
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Failed to load diagnostics'
  } finally {
    loading.value = false
  }
}

onMounted(() => {
  void load()
  timer = setInterval(load, 30_000)
})
onUnmounted(() => {
  if (timer) clearInterval(timer)
})

async function toggleReport(file: string) {
  if (openReport.value === file) {
    openReport.value = null
    return
  }
  openReport.value = file
  reportText.value = 'Loading…'
  try {
    reportText.value = await fetchCrashReport(file)
  } catch (e) {
    reportText.value = e instanceof Error ? e.message : 'Failed to load report'
  }
}

/** Crashes and supervisor restarts, newest first. A restart links its report. */
const events = computed(() => {
  if (!data.value) return []
  const crashByFile = new Map(data.value.crashes.map((c) => [c.file, c]))
  const items: { time: string; title: string; detail: string; kind: string; report: string | null }[] = []
  const linked = new Set<string>()
  for (const r of data.value.restarts) {
    const crash = r.report ? crashByFile.get(r.report) : undefined
    if (r.report) linked.add(r.report)
    items.push({
      time: r.time,
      kind: crash?.kind ?? 'restart',
      title: crash?.message || `Server exited (code ${r.exitCode ?? '—'}${r.signal ? `, ${r.signal}` : ''})`,
      detail: `Restarted by the supervisor after ${formatDuration(r.uptimeSeconds)} up`,
      report: r.report,
    })
  }
  for (const c of data.value.crashes) {
    if (linked.has(c.file)) continue
    items.push({
      time: c.time,
      kind: c.kind,
      title: c.message || c.kind,
      detail: c.kind === 'unhandledRejection' ? 'Reported — the server kept running' : 'Crash report',
      report: c.file,
    })
  }
  return items.sort((a, b) => b.time.localeCompare(a.time))
})

const KIND_LABEL: Record<string, { label: string; cls: string }> = {
  uncaughtException: { label: 'Crash', cls: 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300' },
  'process-exit': { label: 'Died', cls: 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300' },
  unhandledRejection: { label: 'Error', cls: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300' },
  restart: { label: 'Restart', cls: 'bg-gray-200 text-gray-600 dark:bg-gray-700 dark:text-gray-300' },
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ${Math.round((seconds % 3600) / 60)}m`
  return `${Math.floor(seconds / 86400)}d ${Math.floor((seconds % 86400) / 3600)}h`
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

const tiles = computed(() => {
  const c = data.value?.current
  if (!c) return []
  return [
    { label: 'Uptime', value: formatDuration(c.uptimeSeconds) },
    { label: 'Memory', value: `${c.rssMb} MB` },
    { label: 'Live chats', value: String(c.liveSessions ?? 0) },
    { label: 'CLI processes', value: String((c.cliProcesses ?? 0) + (c.acpAgents ?? 0)) },
    { label: 'Shells', value: String(c.shells ?? 0) },
    { label: 'Worst stall', value: `${c.maxLoopDelayMs} ms` },
  ]
})

/** Memory over the last 24 h as an SVG polyline (viewBox 0 0 100 30). */
const memoryLine = computed(() => {
  const samples = data.value?.samples ?? []
  if (samples.length < 2) return null
  const values = samples.map((s) => s.rssMb)
  const max = Math.max(...values)
  const min = Math.min(...values)
  const span = Math.max(1, max - min)
  const points = values
    .map((v, i) => `${((i / (values.length - 1)) * 100).toFixed(1)},${(28 - ((v - min) / span) * 26).toFixed(1)}`)
    .join(' ')
  return { points, min, max, from: samples[0].time }
})
</script>

<template>
  <div class="flex h-full flex-col">
    <!-- Header bar -->
    <div class="flex shrink-0 items-center gap-2 border-b border-gray-200 px-3 py-2 dark:border-gray-800">
      <button
        class="rounded-lg p-1.5 text-gray-600 hover:bg-gray-100 md:hidden dark:text-gray-400 dark:hover:bg-gray-800"
        @click="ui.toggleSidebar()"
      >
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" class="h-5 w-5">
          <path fill-rule="evenodd" d="M2 4.75A.75.75 0 0 1 2.75 4h14.5a.75.75 0 0 1 0 1.5H2.75A.75.75 0 0 1 2 4.75Zm0 10.5a.75.75 0 0 1 .75-.75h14.5a.75.75 0 0 1 0 1.5H2.75a.75.75 0 0 1-.75-.75ZM2 10a.75.75 0 0 1 .75-.75h7.5a.75.75 0 0 1 0 1.5h-7.5A.75.75 0 0 1 2 10Z" clip-rule="evenodd" />
        </svg>
      </button>
      <span class="text-sm font-medium text-gray-700 dark:text-gray-300">Diagnostics</span>
      <div class="flex-1" />
      <button
        class="rounded-md px-2 py-1 text-xs text-gray-500 transition hover:bg-gray-100 hover:text-gray-700 disabled:opacity-50 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-gray-200"
        :disabled="loading"
        @click="load"
      >
        Refresh
      </button>
    </div>

    <div class="min-h-0 flex-1 overflow-y-auto">
      <div class="mx-auto flex max-w-2xl flex-col gap-5 px-4 py-6">
        <div v-if="error" class="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-900/20 dark:text-red-400">
          Couldn't reach the server: {{ error }}
        </div>

        <template v-if="data">
          <!-- Supervisor notice -->
          <div
            v-if="!data.process.supervised"
            class="rounded-lg border border-amber-300/60 bg-amber-50 px-3 py-2.5 text-sm text-amber-800 dark:border-amber-500/30 dark:bg-amber-900/20 dark:text-amber-300"
          >
            <div class="font-medium">Not running under the supervisor</div>
            <div class="mt-0.5 text-xs leading-relaxed">
              If the server crashes it stays down until you restart it. Start it with
              <code class="rounded bg-amber-100 px-1 dark:bg-amber-900/50">npm run serve</code> in
              <code class="rounded bg-amber-100 px-1 dark:bg-amber-900/50">server/</code> to restart automatically.
            </div>
          </div>

          <!-- Current health -->
          <div class="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <div v-for="t in tiles" :key="t.label" class="rounded-xl bg-gray-50 px-4 py-3 dark:bg-gray-900/60">
              <div class="text-xs text-gray-400 dark:text-gray-500">{{ t.label }}</div>
              <div class="text-xl font-semibold text-gray-900 tabular-nums dark:text-gray-100">{{ t.value }}</div>
            </div>
          </div>

          <!-- Memory trend -->
          <div class="rounded-xl bg-gray-50 px-4 py-3 dark:bg-gray-900/60">
            <div class="flex items-baseline justify-between text-xs text-gray-400 dark:text-gray-500">
              <span>Memory, last 24 h</span>
              <span v-if="memoryLine" class="tabular-nums">{{ memoryLine.min }}–{{ memoryLine.max }} MB</span>
            </div>
            <svg v-if="memoryLine" viewBox="0 0 100 30" preserveAspectRatio="none" class="mt-2 h-14 w-full text-violet-500">
              <polyline :points="memoryLine.points" fill="none" stroke="currentColor" stroke-width="1.2" vector-effect="non-scaling-stroke" />
            </svg>
            <div v-else class="mt-2 text-xs text-gray-400 dark:text-gray-500">
              Collecting — a sample is taken every 10 minutes.
            </div>
          </div>

          <!-- Crashes and restarts -->
          <section>
            <h2 class="mb-2 text-xs font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500">Crashes & restarts</h2>
            <div v-if="events.length === 0" class="rounded-xl bg-gray-50 px-4 py-6 text-center text-sm text-gray-400 dark:bg-gray-900/60 dark:text-gray-500">
              None recorded since crash logging was added.
            </div>
            <div v-else class="flex flex-col divide-y divide-gray-100 overflow-hidden rounded-xl border border-gray-200 dark:divide-gray-800 dark:border-gray-800">
              <div v-for="e in events" :key="e.time + e.kind">
                <button
                  class="flex w-full items-start gap-2 px-3 py-2.5 text-left transition hover:bg-gray-50 disabled:cursor-default dark:hover:bg-gray-800/50"
                  :disabled="!e.report"
                  @click="e.report && toggleReport(e.report)"
                >
                  <span class="mt-0.5 shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium" :class="(KIND_LABEL[e.kind] ?? KIND_LABEL.restart).cls">
                    {{ (KIND_LABEL[e.kind] ?? KIND_LABEL.restart).label }}
                  </span>
                  <span class="min-w-0 flex-1">
                    <span class="block break-words text-sm text-gray-800 dark:text-gray-200">{{ e.title }}</span>
                    <span class="block text-xs text-gray-400 dark:text-gray-500">{{ formatTime(e.time) }} · {{ e.detail }}</span>
                  </span>
                </button>
                <pre
                  v-if="e.report && openReport === e.report"
                  class="max-h-96 overflow-auto border-t border-gray-100 bg-gray-950 px-3 py-2 font-mono text-[11px] leading-4 whitespace-pre text-gray-200 dark:border-gray-800"
                >{{ reportText }}</pre>
              </div>
            </div>
          </section>

          <!-- Recent warnings / errors -->
          <section>
            <button
              class="mb-2 flex items-center gap-1 text-xs font-semibold uppercase tracking-wider text-gray-400 hover:text-gray-600 dark:text-gray-500 dark:hover:text-gray-300"
              @click="showProblems = !showProblems"
            >
              <span>{{ showProblems ? '▾' : '▸' }}</span>
              Recent warnings & errors ({{ data.recentProblems.length }})
            </button>
            <pre
              v-if="showProblems"
              class="max-h-96 overflow-auto rounded-xl bg-gray-950 px-3 py-2 font-mono text-[11px] leading-4 whitespace-pre text-gray-200"
            >{{ data.recentProblems.join('\n') || 'Nothing since the server started.' }}</pre>
          </section>

          <p class="text-xs text-gray-400 dark:text-gray-500">
            Server pid {{ data.process.pid }} · {{ data.process.node }} · started {{ formatTime(data.process.startedAt) }}.
            Full log: <code>server/data/server.log</code>; reports: <code>server/data/crashes/</code>.
          </p>
        </template>
      </div>
    </div>
  </div>
</template>
