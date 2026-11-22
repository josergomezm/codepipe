<script setup lang="ts">
import type { ChatMessage } from '@/api/client'
import { useSession } from '@/composables/useSession'
import { useSessionsStore } from '@/stores/sessions'

/**
 * A message waiting for the agent to finish its current reply. It sits at
 * the bottom of the chat, outlined and faded, until the server moves it into
 * the transcript as a normal sent message.
 */
const props = defineProps<{ message: ChatMessage; position: number }>()
const { unqueue } = useSession()
const store = useSessionsStore()

/** Pull it back into the composer to rewrite it. */
function edit() {
  if (unqueue(props.message.id)) store.restoreToComposer(props.message.content)
}
</script>

<template>
  <div class="group flex justify-end px-4 py-1">
    <div class="flex max-w-[85%] flex-col items-end md:max-w-[75%]">
      <div class="overflow-hidden rounded-2xl border border-dashed border-blue-400/70 bg-blue-50/60 px-4 py-2.5 text-gray-700 dark:border-blue-500/50 dark:bg-blue-950/30 dark:text-gray-300">
        <div v-if="message.attachments?.length" class="mb-1.5 flex flex-wrap gap-1.5">
          <span
            v-for="att in message.attachments"
            :key="att.id"
            class="inline-flex items-center gap-1 rounded-md bg-blue-100 px-2 py-0.5 text-xs dark:bg-blue-900/40"
          >{{ att.mimeType.startsWith('image/') ? '🖼️' : '📄' }} {{ att.filename }}</span>
        </div>
        <p v-if="message.metadata?.kind === 'prompt'" class="text-xs italic">Briefing (queued)</p>
        <p v-else class="whitespace-pre-wrap break-words text-sm">{{ message.content }}</p>
      </div>
      <div class="mt-1 flex items-center gap-2 text-[11px] text-gray-400 dark:text-gray-500">
        <span class="inline-flex items-center gap-1">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" class="h-3 w-3" aria-hidden="true">
            <path fill-rule="evenodd" d="M1 8a7 7 0 1 1 14 0A7 7 0 0 1 1 8Zm7.75-4.25a.75.75 0 0 0-1.5 0V8c0 .414.336.75.75.75h3.25a.75.75 0 0 0 0-1.5h-2.5v-3.5Z" clip-rule="evenodd" />
          </svg>
          Queued{{ position > 1 ? ` · #${position}` : '' }} — sends when the current reply finishes
        </span>
        <template v-if="message.metadata?.kind !== 'prompt'">
          <button class="rounded px-1 hover:text-gray-700 dark:hover:text-gray-200" title="Move back to the message box to edit" @click="edit">Edit</button>
          <button class="rounded px-1 hover:text-red-600 dark:hover:text-red-400" title="Remove from queue" aria-label="Remove from queue" @click="unqueue(message.id)">✕</button>
        </template>
      </div>
    </div>
  </div>
</template>
