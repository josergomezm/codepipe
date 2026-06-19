<script setup lang="ts">
import { watch, computed, onUnmounted } from 'vue'
import { useSessionsStore } from '@/stores/sessions'
import { useProjectsStore } from '@/stores/projects'
import { useUiStore } from '@/stores/ui'
import { useSession } from '@/composables/useSession'
import MessageList from '@/components/MessageList.vue'
import ChatInput from '@/components/ChatInput.vue'
import ChatLoader from '@/components/ChatLoader.vue'
import ModelPicker from '@/components/ModelPicker.vue'

const store = useSessionsStore()
const projectsStore = useProjectsStore()
const ui = useUiStore()
const { connect, disconnect, connectionError, clearConnectionError } = useSession()

// The currently active session's metadata
const activeSession = computed(() => store.sessions.find(s => s.id === store.activeSessionId) ?? null)

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

// Dev server URL for the current session's project
const devServerUrl = computed(() => {
  if (!activeSession.value) return null
  return projectsStore.getProjectDevUrl(activeSession.value.projectId)
})

function openDevServer() {
  if (devServerUrl.value) window.location.href = devServerUrl.value
}
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
        {{ activeSession?.title ?? 'CodePipe' }}
      </span>
    </div>

    <!-- Error banner -->
    <div
      v-if="store.error || connectionError"
      class="flex items-center justify-between bg-red-50 px-4 py-2 text-sm text-red-700 dark:bg-red-900/20 dark:text-red-400"
    >
      <span>{{ store.error || connectionError }}</span>
      <button
        class="ml-2 rounded p-1 hover:bg-red-100 dark:hover:bg-red-900/40"
        @click="store.clearError(); clearConnectionError()"
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
      <!-- Model picker bar -->
      <div class="flex items-center justify-end border-b border-gray-200 px-4 py-1.5 dark:border-gray-800">
        <ModelPicker />
      </div>

      <!-- Dev server link bar -->
      <div
        v-if="devServerUrl"
        class="flex items-center border-b border-gray-200 px-4 py-1.5 dark:border-gray-800"
      >
        <button
          class="inline-flex items-center gap-1.5 rounded-full bg-green-50 px-2.5 py-0.5 text-xs font-medium text-green-700 transition hover:bg-green-100 dark:bg-green-900/20 dark:text-green-400 dark:hover:bg-green-900/40"
          @click="openDevServer"
        >
          <span class="h-1.5 w-1.5 rounded-full bg-green-500" />
          Dev Server
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" class="h-3 w-3">
            <path d="M8.75 3.5a.75.75 0 0 0 0-1.5h-5.5a.75.75 0 0 0-.75.75v10.5c0 .414.336.75.75.75h10.5a.75.75 0 0 0 .75-.75v-5.5a.75.75 0 0 0-1.5 0v4.75H3.5V3.5h5.25Z" />
            <path d="M10.25 1a.75.75 0 0 0 0 1.5h2.19L6.72 8.22a.75.75 0 1 0 1.06 1.06l5.72-5.72v2.19a.75.75 0 0 0 1.5 0v-4a.75.75 0 0 0-.75-.75h-4Z" />
          </svg>
        </button>
      </div>

      <ChatLoader v-if="store.loading" />
      <template v-else>
        <MessageList />
        <ChatInput />
      </template>
    </template>
  </div>
</template>
