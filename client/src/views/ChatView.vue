<script setup lang="ts">
import { watch, onUnmounted } from 'vue'
import { useSessionsStore } from '@/stores/sessions'
import { useUiStore } from '@/stores/ui'
import { useSession } from '@/composables/useSession'
import MessageList from '@/components/MessageList.vue'
import ChatInput from '@/components/ChatInput.vue'

const store = useSessionsStore()
const ui = useUiStore()
const { connect, disconnect } = useSession()

// Connect/disconnect when active session changes
watch(
  () => store.activeSessionId,
  (newId, oldId) => {
    if (oldId && oldId !== newId) {
      disconnect()
    }
    if (newId) {
      connect(newId)
    }
  },
  { immediate: true },
)

onUnmounted(() => {
  disconnect()
})
</script>

<template>
  <div class="flex h-full flex-col">
    <!-- Mobile header bar -->
    <div class="flex items-center border-b border-gray-200 px-3 py-2 md:hidden dark:border-gray-800">
      <button
        class="rounded-lg p-1.5 text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800"
        @click="ui.toggleSidebar()"
      >
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" class="h-5 w-5">
          <path fill-rule="evenodd" d="M2 4.75A.75.75 0 0 1 2.75 4h14.5a.75.75 0 0 1 0 1.5H2.75A.75.75 0 0 1 2 4.75Zm0 10.5a.75.75 0 0 1 .75-.75h14.5a.75.75 0 0 1 0 1.5H2.75a.75.75 0 0 1-.75-.75ZM2 10a.75.75 0 0 1 .75-.75h7.5a.75.75 0 0 1 0 1.5h-7.5A.75.75 0 0 1 2 10Z" clip-rule="evenodd" />
        </svg>
      </button>
      <span class="ml-2 truncate text-sm font-medium text-gray-700 dark:text-gray-300">
        {{ store.sessions.find(s => s.id === store.activeSessionId)?.title ?? 'CodePipe' }}
      </span>
    </div>

    <!-- Error banner -->
    <div
      v-if="store.error"
      class="flex items-center justify-between bg-red-50 px-4 py-2 text-sm text-red-700 dark:bg-red-900/20 dark:text-red-400"
    >
      <span>{{ store.error }}</span>
      <button
        class="ml-2 rounded p-1 hover:bg-red-100 dark:hover:bg-red-900/40"
        @click="store.clearError()"
      >✕</button>
    </div>

    <!-- Welcome screen when no session selected -->
    <div v-if="!store.activeSessionId" class="flex flex-1 items-center justify-center px-4">
      <div class="text-center">
        <h1 class="mb-2 text-2xl font-bold text-gray-900 sm:text-3xl dark:text-gray-100">CodePipe</h1>
        <p class="text-sm text-gray-500 sm:text-base dark:text-gray-400">Select a session or start a new chat</p>
      </div>
    </div>

    <!-- Active chat -->
    <template v-else>
      <MessageList />
      <ChatInput />
    </template>
  </div>
</template>
