<script setup lang="ts">
import { ref, computed } from 'vue'
import { useSession } from '@/composables/useSession'
import { useSessionsStore } from '@/stores/sessions'
import { uploadFile } from '@/api/client'
import type { Attachment } from '@/api/client'

const { sendMessage, cancel } = useSession()
const sessionsStore = useSessionsStore()

// The CLI is working when the session status is 'typing' — show Stop then.
const isBusy = computed(() => sessionsStore.sessionStatus === 'typing')

function stop() {
  cancel()
}

const text = ref('')
const textarea = ref<HTMLTextAreaElement | null>(null)
const fileInput = ref<HTMLInputElement | null>(null)
const pendingFiles = ref<File[]>([])
const uploading = ref(false)
const uploadError = ref<string | null>(null)

const canSend = computed(() =>
  (text.value.trim().length > 0 || pendingFiles.value.length > 0) && !uploading.value,
)

const acceptedTypes = [
  'image/jpeg', 'image/png', 'image/gif', 'image/webp',
  'application/pdf', 'text/plain', 'text/markdown', 'text/csv', 'application/json',
].join(',')

function openFilePicker() {
  fileInput.value?.click()
}

function onFilesSelected(e: Event) {
  const input = e.target as HTMLInputElement
  if (!input.files) return
  for (const file of Array.from(input.files)) {
    // Avoid duplicates by name+size
    if (!pendingFiles.value.some(f => f.name === file.name && f.size === file.size)) {
      pendingFiles.value.push(file)
    }
  }
  // Reset input so the same file can be re-selected
  input.value = ''
  uploadError.value = null
}

function removeFile(index: number) {
  pendingFiles.value.splice(index, 1)
  uploadError.value = null
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function isImage(file: File): boolean {
  return file.type.startsWith('image/')
}

async function send() {
  const trimmed = text.value.trim()
  if (!trimmed && pendingFiles.value.length === 0) return

  uploading.value = true
  uploadError.value = null

  try {
    // Upload all pending files first
    let attachments: Attachment[] | undefined
    if (pendingFiles.value.length > 0) {
      attachments = await Promise.all(pendingFiles.value.map(f => uploadFile(f)))
    }

    // Send message with attachments
    const messageText = trimmed || 'Please analyze the attached file(s).'
    const sent = sendMessage(messageText, attachments)

    if (!sent) {
      uploadError.value = 'Not connected — message could not be sent. Try again in a moment.'
      return
    }

    // Clear state only on successful send
    text.value = ''
    pendingFiles.value = []
    if (textarea.value) {
      textarea.value.style.height = 'auto'
    }
  } catch (e) {
    uploadError.value = e instanceof Error ? e.message : 'Upload failed'
  } finally {
    uploading.value = false
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

function onDragOver(e: DragEvent) {
  e.preventDefault()
}

function onDrop(e: DragEvent) {
  e.preventDefault()
  if (!e.dataTransfer?.files) return
  for (const file of Array.from(e.dataTransfer.files)) {
    if (!pendingFiles.value.some(f => f.name === file.name && f.size === file.size)) {
      pendingFiles.value.push(file)
    }
  }
  uploadError.value = null
}
</script>

<template>
  <div
    class="border-t border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-950"
    @dragover="onDragOver"
    @drop="onDrop"
  >
    <!-- Pending attachments -->
    <div v-if="pendingFiles.length > 0" class="mb-2 flex flex-wrap gap-2">
      <div
        v-for="(file, i) in pendingFiles"
        :key="file.name + file.size"
        class="group flex items-center gap-1.5 rounded-lg border border-gray-200 bg-gray-50 px-2.5 py-1.5 text-xs dark:border-gray-700 dark:bg-gray-900"
      >
        <!-- Image thumbnail -->
        <span v-if="isImage(file)" class="text-base">🖼️</span>
        <span v-else class="text-base">📄</span>
        <span class="max-w-[120px] truncate text-gray-700 dark:text-gray-300">{{ file.name }}</span>
        <span class="text-gray-400 dark:text-gray-500">{{ formatFileSize(file.size) }}</span>
        <button
          class="ml-0.5 rounded p-0.5 text-gray-400 opacity-0 transition hover:bg-gray-200 hover:text-gray-600 group-hover:opacity-100 dark:hover:bg-gray-700 dark:hover:text-gray-300"
          @click="removeFile(i)"
          aria-label="Remove attachment"
        >
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" class="h-3.5 w-3.5">
            <path d="M5.28 4.22a.75.75 0 0 0-1.06 1.06L6.94 8l-2.72 2.72a.75.75 0 1 0 1.06 1.06L8 9.06l2.72 2.72a.75.75 0 1 0 1.06-1.06L9.06 8l2.72-2.72a.75.75 0 0 0-1.06-1.06L8 6.94 5.28 4.22Z" />
          </svg>
        </button>
      </div>
    </div>

    <!-- Upload error -->
    <div v-if="uploadError" class="mb-2 rounded-lg bg-red-50 px-3 py-1.5 text-xs text-red-600 dark:bg-red-900/20 dark:text-red-400">
      {{ uploadError }}
    </div>

    <!-- Input row -->
    <div class="flex items-end gap-2">
      <!-- Hidden file input -->
      <input
        ref="fileInput"
        type="file"
        :accept="acceptedTypes"
        multiple
        class="hidden"
        @change="onFilesSelected"
      />

      <!-- Attach button -->
      <button
        class="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-gray-400 transition hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-800 dark:hover:text-gray-300"
        @click="openFilePicker"
        title="Attach files"
        aria-label="Attach files"
      >
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" class="h-5 w-5">
          <path fill-rule="evenodd" d="M15.621 4.379a3 3 0 0 0-4.242 0l-7 7a3 3 0 0 0 4.241 4.243h.001l.497-.5a.75.75 0 0 1 1.064 1.057l-.498.501-.002.002a4.5 4.5 0 0 1-6.364-6.364l7-7a4.5 4.5 0 0 1 6.368 6.36l-3.455 3.553A2.625 2.625 0 1 1 9.52 9.52l3.45-3.451a.75.75 0 1 1 1.061 1.06l-3.45 3.451a1.125 1.125 0 0 0 1.587 1.595l3.454-3.553a3 3 0 0 0 0-4.242Z" clip-rule="evenodd" />
        </svg>
      </button>

      <!-- Textarea -->
      <textarea
        ref="textarea"
        v-model="text"
        rows="1"
        :placeholder="pendingFiles.length > 0 ? 'Add a message or just send…' : 'Send a message…'"
        class="flex-1 resize-none rounded-xl border border-gray-200 bg-gray-50 px-4 py-2.5 text-sm text-gray-900 transition placeholder:text-gray-400 focus:border-blue-500 focus:outline-none dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100 dark:placeholder:text-gray-500"
        @keydown="onKeydown"
        @input="onInput"
      ></textarea>

      <!-- Stop button — shown while the CLI is working -->
      <button
        v-if="isBusy"
        class="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gray-800 text-white transition hover:bg-black dark:bg-gray-200 dark:text-gray-900 dark:hover:bg-white"
        @click="stop"
        title="Stop"
        aria-label="Stop the current response"
      >
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" class="h-4 w-4">
          <rect x="5" y="5" width="10" height="10" rx="1.5" />
        </svg>
      </button>

      <!-- Send button -->
      <button
        v-else
        :disabled="!canSend"
        class="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-blue-600 text-white transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-40"
        @click="send"
      >
        <svg v-if="!uploading" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" class="h-5 w-5">
          <path d="M3.105 2.288a.75.75 0 0 0-.826.95l1.414 4.926A1.5 1.5 0 0 0 5.135 9.25h6.115a.75.75 0 0 1 0 1.5H5.135a1.5 1.5 0 0 0-1.442 1.086l-1.414 4.926a.75.75 0 0 0 .826.95l14.095-5.638a.75.75 0 0 0 0-1.398L3.105 2.288Z" />
        </svg>
        <!-- Uploading spinner -->
        <svg v-else class="h-5 w-5 animate-spin" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
          <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
          <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path>
        </svg>
      </button>
    </div>
  </div>
</template>
