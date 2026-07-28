<script setup lang="ts">
import { ref, watch, nextTick, onMounted } from 'vue'
import { useSessionsStore } from '@/stores/sessions'
import ChatBubble from '@/components/ChatBubble.vue'
import TypingIndicator from '@/components/TypingIndicator.vue'

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

// Auto-scroll when typing status changes
watch(
  () => store.sessionStatus,
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
