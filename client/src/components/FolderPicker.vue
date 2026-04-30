<script setup lang="ts">
import { ref, watch, computed } from 'vue'
import { browsePath, type BrowseResult } from '@/api/client'
import IconFolder from '@/components/icons/IconFolder.vue'

const props = defineProps<{ modelValue: boolean }>()
const emit = defineEmits<{
  (e: 'update:modelValue', value: boolean): void
  (e: 'select', path: string): void
}>()

const loading = ref(false)
const error = ref('')
const browseData = ref<BrowseResult | null>(null)

const breadcrumbs = computed(() => {
  const current = browseData.value?.current
  if (!current) return []

  // Windows drive root like "C:\"
  const isWindows = /^[A-Z]:\\/i.test(current)
  const sep = isWindows ? '\\' : '/'
  const parts = current.split(sep).filter(Boolean)

  const crumbs: { label: string; path: string }[] = []

  if (isWindows) {
    // First part is drive letter like "C:"
    for (let i = 0; i < parts.length; i++) {
      const crumbPath = parts.slice(0, i + 1).join(sep) + sep
      crumbs.push({ label: i === 0 ? parts[i] + sep : parts[i], path: crumbPath })
    }
  } else {
    crumbs.push({ label: '/', path: '/' })
    for (let i = 0; i < parts.length; i++) {
      crumbs.push({ label: parts[i], path: '/' + parts.slice(0, i + 1).join('/') })
    }
  }

  return crumbs
})

async function loadPath(path?: string) {
  loading.value = true
  error.value = ''
  try {
    browseData.value = await browsePath(path)
  } catch (err: unknown) {
    error.value = err instanceof Error ? err.message : 'Failed to browse'
  } finally {
    loading.value = false
  }
}

function navigateTo(path: string) {
  loadPath(path)
}

function goUp() {
  if (browseData.value?.parent) {
    loadPath(browseData.value.parent)
  } else {
    // Go to root / drive listing
    loadPath(undefined)
  }
}

function goToRoot() {
  loadPath(undefined)
}

function selectCurrent() {
  if (browseData.value?.current) {
    emit('select', browseData.value.current)
    close()
  }
}

function close() {
  emit('update:modelValue', false)
}

// Load root when modal opens
watch(
  () => props.modelValue,
  (open) => {
    if (open) {
      browseData.value = null
      error.value = ''
      loadPath(undefined)
    }
  },
)
</script>

<template>
  <Teleport to="body">
    <div
      v-if="modelValue"
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      @click.self="close"
    >
      <div
        class="flex max-h-[80vh] w-full max-w-lg flex-col rounded-xl bg-white shadow-2xl dark:bg-gray-900"
      >
        <!-- Header -->
        <div class="flex items-center justify-between border-b border-gray-200 px-4 py-3 dark:border-gray-700">
          <h2 class="text-sm font-semibold text-gray-900 dark:text-gray-100">Select Folder</h2>
          <button
            class="rounded p-1 text-gray-400 transition hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-800 dark:hover:text-gray-300"
            @click="close"
          >
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" class="h-4 w-4">
              <path d="M6.28 5.22a.75.75 0 0 0-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 1 0 1.06 1.06L10 11.06l3.72 3.72a.75.75 0 1 0 1.06-1.06L11.06 10l3.72-3.72a.75.75 0 0 0-1.06-1.06L10 8.94 6.28 5.22Z" />
            </svg>
          </button>
        </div>

        <!-- Breadcrumb -->
        <div class="flex items-center gap-1 border-b border-gray-200 px-4 py-2 dark:border-gray-700">
          <button
            class="shrink-0 rounded p-1 text-gray-500 transition hover:bg-gray-100 hover:text-gray-700 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-gray-200"
            title="Root"
            @click="goToRoot"
          >
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" class="h-4 w-4">
              <path fill-rule="evenodd" d="M9.293 2.293a1 1 0 0 1 1.414 0l7 7A1 1 0 0 1 17 11h-1v6a1 1 0 0 1-1 1h-2a1 1 0 0 1-1-1v-3a1 1 0 0 0-1-1H9a1 1 0 0 0-1 1v3a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-6H3a1 1 0 0 1-.707-1.707l7-7Z" clip-rule="evenodd" />
            </svg>
          </button>
          <button
            class="shrink-0 rounded p-1 text-gray-500 transition hover:bg-gray-100 hover:text-gray-700 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-gray-200"
            title="Go up"
            :disabled="!browseData?.parent && !browseData?.current"
            @click="goUp"
          >
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" class="h-4 w-4">
              <path fill-rule="evenodd" d="M10 18a.75.75 0 0 1-.75-.75V4.66L7.3 6.76a.75.75 0 0 1-1.1-1.02l3.25-3.5a.75.75 0 0 1 1.1 0l3.25 3.5a.75.75 0 1 1-1.1 1.02l-1.95-2.1v12.59A.75.75 0 0 1 10 18Z" clip-rule="evenodd" />
            </svg>
          </button>
          <div class="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto text-xs">
            <template v-for="(crumb, i) in breadcrumbs" :key="crumb.path">
              <span v-if="i > 0" class="text-gray-300 dark:text-gray-600">/</span>
              <button
                class="shrink-0 rounded px-1 py-0.5 text-gray-600 transition hover:bg-gray-100 hover:text-gray-900 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-gray-200"
                @click="navigateTo(crumb.path)"
              >
                {{ crumb.label }}
              </button>
            </template>
            <span
              v-if="browseData && !browseData.current"
              class="px-1 py-0.5 text-gray-400 dark:text-gray-500"
            >
              Drives
            </span>
          </div>
        </div>

        <!-- Directory listing -->
        <div class="min-h-0 flex-1 overflow-y-auto px-2 py-2">
          <!-- Loading -->
          <div v-if="loading" class="flex items-center justify-center py-8">
            <svg class="h-5 w-5 animate-spin text-blue-500" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
              <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
              <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
          </div>

          <!-- Error -->
          <div v-else-if="error" class="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-600 dark:bg-red-900/20 dark:text-red-400">
            {{ error }}
          </div>

          <!-- Empty -->
          <div
            v-else-if="browseData && browseData.entries.length === 0"
            class="py-8 text-center text-xs text-gray-400 dark:text-gray-500"
          >
            No subdirectories
          </div>

          <!-- Entries -->
          <div v-else-if="browseData" class="flex flex-col gap-0.5">
            <button
              v-for="entry in browseData.entries"
              :key="entry.name"
              class="flex items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-gray-700 transition hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800"
              @click="navigateTo(
                browseData!.current
                  ? (browseData!.current.endsWith('/') || browseData!.current.endsWith('\\')
                      ? browseData!.current + entry.name
                      : browseData!.current + '/' + entry.name)
                  : entry.name
              )"
            >
              <IconFolder />
              <span class="truncate">{{ entry.name }}</span>
            </button>
          </div>
        </div>

        <!-- Footer -->
        <div class="flex items-center justify-between border-t border-gray-200 px-4 py-3 dark:border-gray-700">
          <div class="min-w-0 flex-1 truncate text-xs text-gray-400 dark:text-gray-500">
            {{ browseData?.current || 'Select a folder' }}
          </div>
          <div class="flex shrink-0 gap-2">
            <button
              class="rounded-lg bg-gray-200 px-3 py-1.5 text-xs font-medium text-gray-700 transition hover:bg-gray-300 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600"
              @click="close"
            >
              Cancel
            </button>
            <button
              class="rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-blue-700 disabled:opacity-50"
              :disabled="!browseData?.current"
              @click="selectCurrent"
            >
              Select this folder
            </button>
          </div>
        </div>
      </div>
    </div>
  </Teleport>
</template>
