<script setup lang="ts">
import { computed } from 'vue'
import { useSessionsStore } from '@/stores/sessions'
import { useSession } from '@/composables/useSession'
import IconClose from '@/components/icons/IconClose.vue'

const store = useSessionsStore()
const { disconnect } = useSession()

const sortedSessions = computed(() =>
  [...store.sessions].sort((a, b) => b.updatedAt - a.updatedAt),
)

function selectSession(sessionId: string) {
  // selectSession sets activeSessionId, which triggers the watch in ChatView
  // to call connect() — no need to call connect() here
  store.selectSession(sessionId)
}

async function removeSession(sessionId: string) {
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
  <div class="flex flex-col gap-1">
    <h3 class="px-2 text-xs font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500">
      Sessions
    </h3>
    <div v-if="sortedSessions.length === 0" class="px-2 py-2 text-xs text-gray-400 dark:text-gray-500">
      No sessions yet
    </div>
    <div
      v-for="session in sortedSessions"
      :key="session.id"
      class="group flex items-center gap-2 rounded-lg px-2 py-2 text-left text-sm transition cursor-pointer"
      :class="[
        store.activeSessionId === session.id
          ? 'bg-blue-50 text-blue-700 dark:bg-blue-900/20 dark:text-blue-400'
          : 'text-gray-700 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800',
      ]"
      @click="selectSession(session.id)"
    >
      <!-- Live/archived indicator dot -->
      <span
        class="inline-block h-2 w-2 shrink-0 rounded-full"
        :class="session.status === 'live' ? 'bg-green-500' : 'bg-gray-400 dark:bg-gray-600'"
      ></span>
      <span class="flex-1 truncate">{{ session.title }}</span>
      <span class="shrink-0 rounded bg-gray-200 px-1.5 py-0.5 text-[10px] font-medium text-gray-600 dark:bg-gray-700 dark:text-gray-400">
        {{ providerLabel(session.provider) }}
      </span>
      <!-- Delete button (visible on hover) -->
      <button
        class="shrink-0 rounded p-1 text-gray-400 opacity-0 transition hover:bg-red-50 hover:text-red-500 group-hover:opacity-100 dark:hover:bg-red-900/20"
        title="Delete session"
        @click.stop="removeSession(session.id)"
      >
        <IconClose />
      </button>
    </div>
  </div>
</template>
