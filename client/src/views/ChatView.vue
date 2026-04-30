<script setup lang="ts">
import { watch, onUnmounted } from 'vue'
import { useSessionsStore } from '@/stores/sessions'
import { useSession } from '@/composables/useSession'
import MessageList from '@/components/MessageList.vue'
import ChatInput from '@/components/ChatInput.vue'

const store = useSessionsStore()
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
    <!-- Welcome screen when no session selected -->
    <div v-if="!store.activeSessionId" class="flex flex-1 items-center justify-center">
      <div class="text-center">
        <h1 class="mb-2 text-3xl font-bold text-gray-900 dark:text-gray-100">CodePipe</h1>
        <p class="text-gray-500 dark:text-gray-400">Select a session or start a new chat</p>
      </div>
    </div>

    <!-- Active chat -->
    <template v-else>
      <MessageList />
      <ChatInput />
    </template>
  </div>
</template>
