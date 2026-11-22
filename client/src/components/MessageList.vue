<script setup lang="ts">
import { ref, watch, nextTick, onMounted } from 'vue'
import { useSessionsStore } from '@/stores/sessions'
import ChatBubble from '@/components/ChatBubble.vue'
import TypingIndicator from '@/components/TypingIndicator.vue'
import QueuedMessage from '@/components/QueuedMessage.vue'

const store = useSessionsStore()
const container = ref<HTMLElement | null>(null)
const showScrollButton = ref(false)
let userScrolledUp = false

function isNearBottom(): boolean {
  if (!container.value) return true
  const { scrollTop, scrollHeight, clientHeight } = container.value
  return scrollHeight - scrollTop - clientHeight < 80
}

function scrollToBottom() {
  if (!container.value) return
  container.value.scrollTop = container.value.scrollHeight
  userScrolledUp = false
  showScrollButton.value = false
}

function onScroll() {
  if (isNearBottom()) {
    userScrolledUp = false
    showScrollButton.value = false
  } else {
    userScrolledUp = true
    showScrollButton.value = true
  }
}

// Auto-scroll on new messages
watch(
  () => store.activeMessages.length,
  async () => {
    if (!userScrolledUp) {
      await nextTick()
      scrollToBottom()
    }
  },
)

// Auto-scroll when typing status changes, or a message is queued
watch(
  () => [store.sessionStatus, store.queuedMessages.length],
  async () => {
    if (!userScrolledUp) {
      await nextTick()
      scrollToBottom()
    }
  },
)

onMounted(() => {
  scrollToBottom()
})
</script>

<template>
  <div class="relative min-h-0 flex-1 overflow-hidden">
    <!-- Showing the saved copy while the server's version loads -->
    <Transition leave-active-class="transition-opacity duration-300" leave-to-class="opacity-0">
      <div
        v-if="store.refreshing"
        class="pointer-events-none absolute left-1/2 top-2 z-10 flex -translate-x-1/2 items-center gap-1.5 rounded-full bg-white/90 px-2.5 py-1 text-[11px] text-gray-500 shadow-sm ring-1 ring-gray-200 backdrop-blur dark:bg-gray-900/90 dark:text-gray-400 dark:ring-gray-700"
        role="status"
      >
        <svg class="h-3 w-3 animate-spin" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
          <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 0 1 8-8V0C5.373 0 0 5.373 0 12h4Z" />
        </svg>
        Updating…
      </div>
    </Transition>
    <div
      ref="container"
      class="h-full overflow-y-auto overflow-x-hidden py-4"
      @scroll="onScroll"
    >
      <ChatBubble
        v-for="msg in store.activeMessages"
        :key="msg.id"
        :message="msg"
      />
      <TypingIndicator v-if="store.sessionStatus === 'typing'" />
      <!-- Waiting for the running reply to finish: always last -->
      <QueuedMessage
        v-for="(msg, i) in store.queuedMessages"
        :key="msg.id"
        :message="msg"
        :position="i + 1"
      />
    </div>

    <!-- Scroll to bottom button -->
    <Transition
      enter-active-class="transition duration-200 ease-out"
      enter-from-class="translate-y-2 opacity-0"
      enter-to-class="translate-y-0 opacity-100"
      leave-active-class="transition duration-150 ease-in"
      leave-from-class="translate-y-0 opacity-100"
      leave-to-class="translate-y-2 opacity-0"
    >
      <button
        v-if="showScrollButton"
        class="absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full bg-gray-800 px-3 py-1.5 text-xs text-white shadow-lg transition hover:bg-gray-700 dark:bg-gray-600 dark:hover:bg-gray-500"
        @click="scrollToBottom"
      >
        ↓ Scroll to bottom
      </button>
    </Transition>
  </div>
</template>
