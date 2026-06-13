<script setup lang="ts">
import { onMounted } from 'vue'
import { useNotifications } from '@/composables/useNotifications'

const { init, enable, disable, supported, serverEnabled, subscribed, permission, busy, lastError } =
  useNotifications()

onMounted(() => {
  init()
})

async function toggle() {
  if (subscribed.value) await disable()
  else await enable()
}
</script>

<template>
  <!-- Hidden entirely if the browser or server can't do push -->
  <div v-if="supported && serverEnabled" class="px-2">
    <button
      class="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-gray-600 transition hover:bg-gray-200 dark:text-gray-300 dark:hover:bg-gray-800 disabled:opacity-50"
      :disabled="busy || permission === 'denied'"
      @click="toggle"
    >
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" class="h-4 w-4 shrink-0">
        <path
          v-if="subscribed"
          d="M10 2a6 6 0 0 0-6 6v2.586l-.707.707A1 1 0 0 0 4 13h12a1 1 0 0 0 .707-1.707L16 10.586V8a6 6 0 0 0-6-6ZM8.05 16a2 2 0 0 0 3.9 0H8.05Z"
        />
        <path
          v-else
          fill-rule="evenodd"
          d="M10 2a6 6 0 0 0-6 6v2.586l-.707.707A1 1 0 0 0 4 13h12a1 1 0 0 0 .707-1.707L16 10.586V8a6 6 0 0 0-6-6Zm-1.95 14a2 2 0 0 0 3.9 0H8.05Z"
          clip-rule="evenodd"
          opacity="0.5"
        />
      </svg>
      <span class="flex-1 text-left">
        {{ subscribed ? 'Notifications on' : 'Enable notifications' }}
      </span>
    </button>
    <p v-if="permission === 'denied'" class="px-3 pt-1 text-xs text-gray-400">
      Blocked in browser settings.
    </p>
    <p v-else-if="lastError" class="px-3 pt-1 text-xs text-red-500">{{ lastError }}</p>
  </div>
</template>
