<script setup lang="ts">
import { computed } from 'vue'
import MarkdownIt from 'markdown-it'
import type { ChatMessage } from '@/api/client'

const props = defineProps<{
  message: ChatMessage
}>()

const md = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: true,
})

// Only render markdown when the message is complete — avoids expensive
// re-renders on every streaming chunk
const renderedContent = computed(() => {
  if (props.message.role !== 'assistant' && props.message.role !== 'tool') return ''
  if (props.message.status === 'streaming') return ''
  return md.render(props.message.content)
})

const isStreaming = computed(() => props.message.status === 'streaming')
const isUser = computed(() => props.message.role === 'user')
const isAssistant = computed(() => props.message.role === 'assistant')
const isTool = computed(() => props.message.role === 'tool')
const isSystem = computed(() => props.message.role === 'system')
</script>

<template>
  <!-- System message: centered, muted -->
  <div v-if="isSystem" class="flex justify-center px-4 py-2">
    <div class="rounded-xl border border-amber-200 bg-amber-50 px-4 py-2.5 text-center dark:border-amber-800/40 dark:bg-amber-900/20">
      <p class="whitespace-pre-wrap text-sm text-amber-800 dark:text-amber-300">{{ message.content }}</p>
    </div>
  </div>

  <!-- User message: right-aligned, blue -->
  <div v-else-if="isUser" class="flex justify-end px-4 py-1">
    <div class="max-w-[75%] overflow-hidden rounded-2xl bg-blue-600 px-4 py-2.5 text-white">
      <!-- Attachment indicators -->
      <div v-if="message.attachments?.length" class="mb-1.5 flex flex-wrap gap-1.5">
        <span
          v-for="att in message.attachments"
          :key="att.id"
          class="inline-flex items-center gap-1 rounded-md bg-blue-500/40 px-2 py-0.5 text-xs"
        >
          <span v-if="att.mimeType.startsWith('image/')">🖼️</span>
          <span v-else>📄</span>
          {{ att.filename }}
        </span>
      </div>
      <p class="whitespace-pre-wrap break-words text-sm">{{ message.content }}</p>
    </div>
  </div>

  <!-- Tool message: left-aligned with badge -->
  <div v-else-if="isTool" class="flex items-start gap-2 px-4 py-1">
    <div class="max-w-[75%] overflow-hidden rounded-2xl bg-gray-100 px-4 py-2.5 dark:bg-gray-800">
      <div class="mb-1 flex items-center gap-1.5">
        <span class="inline-flex items-center rounded bg-amber-100 px-1.5 py-0.5 text-xs font-medium text-amber-800 dark:bg-amber-900/30 dark:text-amber-400">
          🔧 {{ message.metadata?.toolName ?? 'tool' }}
        </span>
      </div>
      <!-- Streaming: show raw text. Complete: render markdown -->
      <p v-if="isStreaming" class="whitespace-pre-wrap break-words text-sm text-gray-900 dark:text-gray-100">{{ message.content }}</p>
      <div v-else class="prose prose-sm max-w-none break-words dark:prose-invert" v-html="renderedContent"></div>
    </div>
  </div>

  <!-- Assistant message: left-aligned, gray -->
  <div v-else-if="isAssistant" class="flex items-start px-4 py-1">
    <div class="max-w-[75%] overflow-hidden rounded-2xl bg-gray-100 px-4 py-2.5 dark:bg-gray-800">
      <!-- Streaming: show raw text to avoid markdown re-parsing flicker -->
      <p v-if="isStreaming" class="whitespace-pre-wrap break-words text-sm text-gray-900 dark:text-gray-100">{{ message.content }}</p>
      <!-- Complete: render full markdown -->
      <div v-else class="prose prose-sm max-w-none break-words dark:prose-invert" v-html="renderedContent"></div>
      <!-- Credits footer for completed assistant messages -->
      <div v-if="!isStreaming && message.metadata?.credits"
           class="mt-2 flex items-center gap-3 border-t border-gray-200 pt-1.5 text-xs text-gray-400 dark:border-gray-700 dark:text-gray-500">
        <span v-if="message.metadata.credits">Credits: {{ message.metadata.credits }}</span>
        <span v-if="message.metadata.time">{{ message.metadata.time }}</span>
      </div>
    </div>
  </div>
</template>
