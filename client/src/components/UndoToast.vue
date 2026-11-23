<script setup lang="ts">
import { onUnmounted, ref, watch } from 'vue'
import { useUiStore } from '@/stores/ui'

/**
 * "Marked done · Undo" — a short-lived toast for one-tap actions that are
 * easy to mis-tap. Mounted once (App.vue); anything offers it through
 * ui.offerUndo(text, undo).
 */
const ui = useUiStore()
const busy = ref(false)
let timer: ReturnType<typeof setTimeout> | undefined

const SHOW_MS = 6000

watch(() => ui.undo?.id, (id) => {
  clearTimeout(timer)
  if (id) timer = setTimeout(() => { if (ui.undo?.id === id) ui.dismissUndo() }, SHOW_MS)
})
onUnmounted(() => clearTimeout(timer))

async function undo() {
  const current = ui.undo
  if (!current || busy.value) return
  busy.value = true
  try {
    await current.run()
  } finally {
    busy.value = false
    if (ui.undo?.id === current.id) ui.dismissUndo()
  }
}
</script>

<template>
  <Transition
    enter-active-class="transition duration-200 ease-out"
    enter-from-class="translate-y-3 opacity-0"
    leave-active-class="transition duration-150 ease-in"
    leave-to-class="translate-y-3 opacity-0"
  >
    <div
      v-if="ui.undo"
      class="fixed bottom-24 left-1/2 z-[70] flex -translate-x-1/2 items-center gap-3 rounded-full bg-gray-900 py-2 pl-4 pr-2 text-sm text-white shadow-lg dark:bg-gray-100 dark:text-gray-900"
      role="status"
    >
      <span class="whitespace-nowrap">{{ ui.undo.text }}</span>
      <button
        class="rounded-full px-2.5 py-0.5 font-semibold text-green-400 hover:bg-white/10 disabled:opacity-50 dark:text-green-700 dark:hover:bg-black/10"
        :disabled="busy"
        @click="undo"
      >Undo</button>
      <button
        class="rounded-full p-1 text-gray-400 hover:bg-white/10 hover:text-white dark:text-gray-500 dark:hover:bg-black/10 dark:hover:text-gray-900"
        aria-label="Dismiss"
        @click="ui.dismissUndo()"
      >
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" class="h-3.5 w-3.5"><path d="M5.28 4.22a.75.75 0 0 0-1.06 1.06L6.94 8l-2.72 2.72a.75.75 0 1 0 1.06 1.06L8 9.06l2.72 2.72a.75.75 0 1 0 1.06-1.06L9.06 8l2.72-2.72a.75.75 0 0 0-1.06-1.06L8 6.94 5.28 4.22Z" /></svg>
      </button>
    </div>
  </Transition>
</template>
