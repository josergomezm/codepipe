<script setup lang="ts">
import { computed, ref } from 'vue'
import { useSessionsStore } from '@/stores/sessions'
import { useSession } from '@/composables/useSession'

const store = useSessionsStore()
const { disconnect } = useSession()

const openMenuId = ref<string | null>(null)

const sortedSessions = computed(() =>
  [...store.sessions].sort((a, b) => b.updatedAt - a.updatedAt),
)

function selectSession(sessionId: string) {
  store.selectSession(sessionId)
}

function toggleMenu(sessionId: string) {
  openMenuId.value = openMenuId.value === sessionId ? null : sessionId
}

async function removeSession(sessionId: string) {
  openMenuId.value = null
  if (store.activeSessionId === sessionId) {
    disconnect()
  }
  await store.deleteSession(sessionId)
}

function providerLabel(provider: string): string {
  return provider.charAt(0).toUpperCase() + provider.slice(1)
}
</script>

<template>
  <div class="flex flex-col gap-1" @click="openMenuId = null">
    <h3 class="px-2 text-xs font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500">
      Sessions
    </h3>
    <div v-if="sortedSessions.length === 0" class="px-2 py-2 text-xs text-gray-400 dark:text-gray-500">
      No sessions yet
    </div>
    <div
      v-for="session in sortedSessions"
      :key="session.id"
      class="group relative flex items-center gap-2 rounded-lg px-2 py-2 text-left text-sm transition cursor-pointer"
      :class="[
        store.activeSessionId === session.id
          ? 'bg-blue-50 text-blue-700 dark:bg-blue-900/20 dark:text-blue-400'
          : 'text-gray-700 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800',
      ]"
      @click="selectSession(session.id)"
    >
      <span
        class="inline-block h-2 w-2 shrink-0 rounded-full"
        :class="session.status === 'live' ? 'bg-green-500' : 'bg-gray-400 dark:bg-gray-600'"
      ></span>
      <span class="flex-1 truncate">{{ session.title }}</span>
      <span class="shrink-0 rounded bg-gray-200 px-1.5 py-0.5 text-[10px] font-medium text-gray-600 dark:bg-gray-700 dark:text-gray-400">
        {{ providerLabel(session.provider) }}
      </span>
      <!-- 3-dot menu button -->
      <button
        class="shrink-0 rounded p-1 text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700"
        title="Session actions"
        @click.stop="toggleMenu(session.id)"
      >
        <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
          <circle cx="10" cy="4" r="1.5" />
          <circle cx="10" cy="10" r="1.5" />
          <circle cx="10" cy="16" r="1.5" />
        </svg>
      </button>
      <!-- Dropdown menu -->
      <div
        v-if="openMenuId === session.id"
        class="absolute right-0 top-full z-10 mt-1 w-32 rounded-md border border-gray-200 bg-white py-1 shadow-lg dark:border-gray-700 dark:bg-gray-800"
        @click.stop
      >
        <button
          class="flex w-full items-center gap-2 px-3 py-1.5 text-xs text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-900/20"
          @click="removeSession(session.id)"
        >
          Delete
        </button>
      </div>
    </div>
  </div>
</template>
