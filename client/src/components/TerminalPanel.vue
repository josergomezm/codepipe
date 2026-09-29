<script setup lang="ts">
import { ref, watch, onMounted, onBeforeUnmount, nextTick } from 'vue'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'

/**
 * A real shell in the project folder, streamed over `/ws/terminal`. The shell
 * lives on the server and is shared by every open tab/device; closing this
 * panel just detaches — use "Kill" to end it.
 */
const props = defineProps<{ projectId: string; active: boolean }>()

const container = ref<HTMLDivElement | null>(null)
const state = ref<'connecting' | 'open' | 'exited' | 'error'>('connecting')
const exitCode = ref<number | null>(null)

let term: Terminal | null = null
let fit: FitAddon | null = null
let ws: WebSocket | null = null
let resizeObserver: ResizeObserver | null = null
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let disposed = false

function send(msg: unknown) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg))
}

function sendSize() {
  if (!term || !fit || !props.active) return
  try {
    fit.fit()
  } catch {
    return // container not laid out yet
  }
  send({ type: 'resize', cols: term.cols, rows: term.rows })
}

function connect() {
  if (disposed) return
  state.value = 'connecting'
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  const socket = new WebSocket(`${protocol}//${window.location.host}/ws/terminal?projectId=${encodeURIComponent(props.projectId)}`)
  ws = socket

  socket.onopen = () => {
    state.value = 'open'
    sendSize()
  }
  socket.onmessage = (ev) => {
    const msg = JSON.parse(ev.data as string) as { type: string; data?: string; code?: number }
    if (msg.type === 'snapshot') {
      term?.reset()
      term?.write(msg.data ?? '')
    } else if (msg.type === 'output') {
      term?.write(msg.data ?? '')
    } else if (msg.type === 'exit') {
      exitCode.value = msg.code ?? null
      state.value = 'exited'
    }
  }
  socket.onclose = (ev) => {
    if (ws !== socket) return
    ws = null
    if (disposed || state.value === 'exited') return
    if (ev.code === 4404) {
      state.value = 'error'
      return
    }
    // Dropped connection (server restart, network blip) — the shell survives
    // on the server, so reattach and get the snapshot back.
    state.value = 'connecting'
    reconnectTimer = setTimeout(connect, 2000)
  }
}

function restart() {
  exitCode.value = null
  ws?.close()
  ws = null
  term?.reset()
  connect()
}

function kill() {
  send({ type: 'kill' })
}

/** Keys phone keyboards lack. */
const KEYS: { label: string; seq: string }[] = [
  { label: 'Tab', seq: '\t' },
  { label: 'Esc', seq: '\x1b' },
  { label: 'Ctrl+C', seq: '\x03' },
  { label: '↑', seq: '\x1b[A' },
  { label: '↓', seq: '\x1b[B' },
  { label: '←', seq: '\x1b[D' },
  { label: '→', seq: '\x1b[C' },
]

function focusTerm() {
  term?.focus()
}

function sendKey(seq: string) {
  send({ type: 'input', data: seq })
  term?.focus()
}

onMounted(() => {
  term = new Terminal({
    cursorBlink: true,
    fontSize: 13,
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    scrollback: 5000,
    theme: { background: '#0b0b12', foreground: '#e5e7eb', cursor: '#a78bfa', selectionBackground: '#4c1d9580' },
  })
  fit = new FitAddon()
  term.loadAddon(fit)
  term.open(container.value!)
  term.onData((data) => send({ type: 'input', data }))

  resizeObserver = new ResizeObserver(() => sendSize())
  resizeObserver.observe(container.value!)
  connect()
})

onBeforeUnmount(() => {
  disposed = true
  if (reconnectTimer) clearTimeout(reconnectTimer)
  resizeObserver?.disconnect()
  ws?.close()
  term?.dispose()
})

// The panel is kept alive (v-show) while other tabs are showing; re-fit and
// focus when it comes back.
watch(() => props.active, async (active) => {
  if (!active) return
  await nextTick()
  sendSize()
  term?.focus()
})
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col bg-[#0b0b12]">
    <!-- Toolbar -->
    <div class="flex shrink-0 items-center gap-2 border-b border-white/10 px-3 py-1.5 text-xs text-gray-400">
      <span class="flex items-center gap-1.5">
        <span
          class="h-1.5 w-1.5 rounded-full"
          :class="{
            'bg-green-500': state === 'open',
            'bg-amber-400 animate-pulse': state === 'connecting',
            'bg-gray-500': state === 'exited',
            'bg-red-500': state === 'error',
          }"
        />
        <template v-if="state === 'open'">Shell running</template>
        <template v-else-if="state === 'connecting'">Connecting…</template>
        <template v-else-if="state === 'exited'">Shell exited{{ exitCode !== null ? ` (code ${exitCode})` : '' }}</template>
        <template v-else>Project not found</template>
      </span>
      <div class="flex-1" />
      <button
        v-if="state === 'exited'"
        class="rounded-md bg-violet-600 px-2 py-0.5 font-medium text-white transition hover:bg-violet-500"
        @click="restart"
      >New shell</button>
      <button
        v-else-if="state === 'open'"
        class="rounded-md px-2 py-0.5 transition hover:bg-white/10 hover:text-red-400"
        title="End this shell"
        @click="kill"
      >Kill</button>
    </div>

    <div ref="container" class="min-h-0 flex-1 overflow-hidden px-2 pt-1" @click="focusTerm" />

    <!-- Extra keys for touch keyboards -->
    <div class="flex shrink-0 gap-1 overflow-x-auto border-t border-white/10 px-2 py-1.5 md:hidden">
      <button
        v-for="k in KEYS"
        :key="k.label"
        class="shrink-0 rounded-md bg-white/10 px-2.5 py-1 font-mono text-xs text-gray-200 active:bg-white/20"
        @click="sendKey(k.seq)"
      >{{ k.label }}</button>
    </div>
  </div>
</template>
