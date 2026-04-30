<script setup lang="ts">
import { ref, computed } from 'vue'
import { useSession } from '@/composables/useSession'

const { sendMessage } = useSession()

const text = ref('')
const textarea = ref<HTMLTextAreaElement | null>(null)

const canSend = computed(() => text.value.trim().length > 0)

function send() {
  const trimmed = text.value.trim()
  if (!trimmed) return
  sendMessage(trimmed)
  text.value = ''
  // Reset textarea height
  if (textarea.value) {
    textarea.value.style.height = 'auto'
  }
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    send()
  }
}

function onInput() {
  if (!textarea.value) return
  textarea.value.style.height = 'auto'
  textarea.value.style.height = Math.min(textarea.value.scrollHeight, 200) + 'px'
}
</script>

<template>
  <div class="border-t border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-950">
    <div class="flex items-end gap-2">
      <textarea
        ref="textarea"
        v-model="text"
        rows="1"
        placeholder="Send a message…"
        class="flex-1 resize-none rounded-xl border border-gray-200 bg-gray-50 px-4 py-2.5 text-sm text-gray-900 transition placeholder:text-gray-400 focus:border-blue-500 focus:outline-none dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100 dark:placeholder:text-gray-500"
        @keydown="onKeydown"
        @input="onInput"
      ></textarea>
      <button
        :disabled="!canSend"
        class="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-blue-600 text-white transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-40"
        @click="send"
      >
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" class="h-5 w-5">
          <path d="M3.105 2.288a.75.75 0 0 0-.826.95l1.414 4.926A1.5 1.5 0 0 0 5.135 9.25h6.115a.75.75 0 0 1 0 1.5H5.135a1.5 1.5 0 0 0-1.442 1.086l-1.414 4.926a.75.75 0 0 0 .826.95l14.095-5.638a.75.75 0 0 0 0-1.398L3.105 2.288Z" />
        </svg>
      </button>
    </div>
  </div>
</template>
