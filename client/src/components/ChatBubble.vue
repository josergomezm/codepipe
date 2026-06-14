<script setup lang="ts">
import { computed, ref } from 'vue'
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

// Open all rendered links in a new window (system browser in PWA context).
const defaultRender = md.renderer.rules.link_open || function (tokens, idx, options, _env, self) { return self.renderToken(tokens, idx, options) }
md.renderer.rules.link_open = function (tokens, idx, options, env, self) {
  tokens[idx].attrSet('target', '_blank')
  tokens[idx].attrSet('rel', 'noopener')
  return defaultRender(tokens, idx, options, env, self)
}

// Only render markdown for completed assistant messages — avoids expensive
// re-renders on every streaming chunk, and keeps tool calls (which are concise
// argument summaries, not prose) out of the markdown pipeline.
const renderedContent = computed(() => {
  if (props.message.role !== 'assistant') return ''
  if (props.message.status === 'streaming') return ''
  return md.render(props.message.content)
})

const isStreaming = computed(() => props.message.status === 'streaming')
const isUser = computed(() => props.message.role === 'user')
const isAssistant = computed(() => props.message.role === 'assistant')
const isTool = computed(() => props.message.role === 'tool')
const isSystem = computed(() => props.message.role === 'system')

const copied = ref(false)
async function copyContent() {
  await navigator.clipboard.writeText(props.message.content)
  copied.value = true
  setTimeout(() => (copied.value = false), 1500)
}
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

  <!-- Tool message: left-aligned with a tool badge + concise argument -->
  <div v-else-if="isTool" class="flex items-start gap-2 px-4 py-1">
    <div class="flex max-w-[75%] items-center gap-2 overflow-hidden rounded-xl border border-gray-200 bg-gray-50 px-3 py-1.5 dark:border-gray-700 dark:bg-gray-900/50">
      <span class="inline-flex shrink-0 items-center gap-1 rounded bg-amber-100 px-1.5 py-0.5 text-xs font-medium text-amber-800 dark:bg-amber-900/30 dark:text-amber-400">
        🔧 {{ message.metadata?.toolName ?? 'tool' }}
      </span>
      <code class="truncate font-mono text-xs text-gray-600 dark:text-gray-400" :title="message.content">{{ message.content }}</code>
    </div>
  </div>

  <!-- Assistant message: left-aligned, gray -->
  <div v-else-if="isAssistant" class="group relative flex items-start px-4 py-1">
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
    <!-- Copy button: always visible on mobile, hover-reveal on desktop -->
    <button
      v-if="!isStreaming"
      class="ml-1 mt-1 rounded p-1 text-gray-400 hover:text-gray-600 dark:text-gray-500 dark:hover:text-gray-300 opacity-100 md:opacity-0 md:group-hover:opacity-100 transition-opacity"
      title="Copy response"
      @click="copyContent"
    >
      <svg v-if="!copied" xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
      <svg v-else xmlns="http://www.w3.org/2000/svg" class="h-4 w-4 text-green-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
    </button>
  </div>
</template>
