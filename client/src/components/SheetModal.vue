<script setup lang="ts">
import { onMounted, onUnmounted } from 'vue'

/** A dialog: bottom sheet on phones, centered card on wider screens. Esc / backdrop closes. */
defineProps<{ title: string; subtitle?: string }>()
const emit = defineEmits<{ close: [] }>()

function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') emit('close')
}
onMounted(() => window.addEventListener('keydown', onKey))
onUnmounted(() => window.removeEventListener('keydown', onKey))
</script>

<template>
  <Teleport to="body">
    <div class="fixed inset-0 z-50 flex items-end justify-center bg-black/50 sm:items-center sm:p-4" @click.self="emit('close')">
      <div class="flex max-h-[85vh] w-full flex-col rounded-t-2xl bg-white shadow-xl sm:max-w-lg sm:rounded-2xl dark:bg-gray-900" role="dialog" aria-modal="true" :aria-label="title">
        <header class="flex items-start justify-between gap-3 border-b border-gray-200 px-5 py-3.5 dark:border-gray-800">
          <div class="min-w-0">
            <h2 class="text-base font-semibold text-gray-900 dark:text-gray-100">{{ title }}</h2>
            <p v-if="subtitle" class="text-xs text-gray-400 dark:text-gray-500">{{ subtitle }}</p>
          </div>
          <button class="rounded-lg p-1 text-gray-400 transition hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-800 dark:hover:text-gray-300" aria-label="Close" @click="emit('close')">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" class="h-5 w-5"><path d="M6.28 5.22a.75.75 0 0 0-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 1 0 1.06 1.06L10 11.06l3.72 3.72a.75.75 0 1 0 1.06-1.06L11.06 10l3.72-3.72a.75.75 0 0 0-1.06-1.06L10 8.94 6.28 5.22Z" /></svg>
          </button>
        </header>
        <div class="min-h-0 overflow-y-auto p-4" style="padding-bottom: max(1rem, env(safe-area-inset-bottom))">
          <slot />
        </div>
      </div>
    </div>
  </Teleport>
</template>
