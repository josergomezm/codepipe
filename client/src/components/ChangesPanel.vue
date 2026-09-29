<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { fetchChanges, fetchFileDiff, type ChangesResult, type ChangedFile, type FileDiff } from '@/api/client'

const props = defineProps<{ projectId: string; active: boolean }>()
const emit = defineEmits<{ count: [n: number] }>()

const result = ref<ChangesResult | null>(null)
const loading = ref(false)
const error = ref<string | null>(null)
const openPath = ref<string | null>(null)
const diffs = ref<Map<string, FileDiff>>(new Map())
const diffLoading = ref<string | null>(null)

const files = computed<ChangedFile[]>(() => (result.value?.isRepo ? result.value.files : []))
const totals = computed(() =>
  files.value.reduce(
    (t, f) => ({ add: t.add + (f.additions ?? 0), del: t.del + (f.deletions ?? 0) }),
    { add: 0, del: 0 },
  ),
)

async function load() {
  loading.value = true
  try {
    result.value = await fetchChanges(props.projectId)
    error.value = null
    // Cached diffs may be stale now; re-fetch the open one.
    diffs.value = new Map()
    if (openPath.value && files.value.some((f) => f.path === openPath.value)) void loadDiff(openPath.value)
    else openPath.value = null
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Failed to load changes'
  } finally {
    loading.value = false
    emit('count', files.value.length)
  }
}

async function loadDiff(path: string) {
  diffLoading.value = path
  try {
    const diff = await fetchFileDiff(props.projectId, path)
    diffs.value = new Map(diffs.value).set(path, diff)
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Failed to load diff'
  } finally {
    if (diffLoading.value === path) diffLoading.value = null
  }
}

function toggle(path: string) {
  if (openPath.value === path) {
    openPath.value = null
    return
  }
  openPath.value = path
  if (!diffs.value.has(path)) void loadDiff(path)
}

defineExpose({ refresh: load })

// Refresh on project change and whenever the tab is shown.
watch(() => props.projectId, () => {
  result.value = null
  openPath.value = null
  void load()
}, { immediate: true })
watch(() => props.active, (active) => { if (active) void load() })

const STATUS_BADGE: Record<ChangedFile['status'], { letter: string; cls: string; label: string }> = {
  modified: { letter: 'M', cls: 'text-amber-600 dark:text-amber-400', label: 'Modified' },
  added: { letter: 'A', cls: 'text-green-600 dark:text-green-400', label: 'Added' },
  untracked: { letter: 'U', cls: 'text-green-600 dark:text-green-400', label: 'New (untracked)' },
  deleted: { letter: 'D', cls: 'text-red-600 dark:text-red-400', label: 'Deleted' },
  renamed: { letter: 'R', cls: 'text-blue-600 dark:text-blue-400', label: 'Renamed' },
  conflicted: { letter: '!', cls: 'text-red-600 dark:text-red-400', label: 'Conflict' },
  typechange: { letter: 'T', cls: 'text-amber-600 dark:text-amber-400', label: 'Type changed' },
}

function fileName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

function dirName(path: string): string {
  const i = path.lastIndexOf('/')
  return i === -1 ? '' : path.slice(0, i)
}

/** Split a unified diff into lines, dropping the git header before the first hunk. */
function diffLines(diff: string): { text: string; kind: 'add' | 'del' | 'hunk' | 'ctx' }[] {
  const lines = diff.replace(/\n$/, '').split('\n')
  const start = lines.findIndex((l) => l.startsWith('@@'))
  return (start === -1 ? [] : lines.slice(start)).map((text) => ({
    text,
    kind: text.startsWith('@@') ? 'hunk' : text.startsWith('+') ? 'add' : text.startsWith('-') ? 'del' : 'ctx',
  }))
}

const LINE_CLASS = {
  add: 'bg-green-50 text-green-800 dark:bg-green-900/20 dark:text-green-300',
  del: 'bg-red-50 text-red-800 dark:bg-red-900/20 dark:text-red-300',
  hunk: 'bg-blue-50 text-blue-700 dark:bg-blue-900/20 dark:text-blue-300',
  ctx: 'text-gray-700 dark:text-gray-300',
} as const
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col">
    <!-- Toolbar -->
    <div class="flex shrink-0 items-center gap-2 border-b border-gray-200 px-3 py-2 text-xs dark:border-gray-800">
      <template v-if="result?.isRepo">
        <span v-if="result.branch" class="truncate font-medium text-gray-700 dark:text-gray-300">{{ result.branch }}</span>
        <span class="text-gray-400 dark:text-gray-500">{{ files.length }} file{{ files.length === 1 ? '' : 's' }}</span>
        <span v-if="files.length" class="text-green-600 dark:text-green-400">+{{ totals.add }}</span>
        <span v-if="files.length" class="text-red-600 dark:text-red-400">−{{ totals.del }}</span>
      </template>
      <div class="flex-1" />
      <button
        class="flex items-center gap-1 rounded-md px-2 py-1 text-gray-500 transition hover:bg-gray-100 hover:text-gray-700 disabled:opacity-50 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-gray-200"
        :disabled="loading"
        title="Refresh"
        @click="load"
      >
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" class="h-3.5 w-3.5" :class="{ 'animate-spin': loading }">
          <path fill-rule="evenodd" d="M13.836 2.477a.75.75 0 0 1 .75.75v3.182a.75.75 0 0 1-.75.75h-3.182a.75.75 0 0 1 0-1.5h1.37l-.84-.841a4.5 4.5 0 0 0-7.08.932.75.75 0 0 1-1.3-.75 6 6 0 0 1 9.44-1.242l.842.84V3.227a.75.75 0 0 1 .75-.75Zm-.911 7.5A.75.75 0 0 1 13.199 11a6 6 0 0 1-9.44 1.241l-.84-.84v1.371a.75.75 0 0 1-1.5 0V9.591a.75.75 0 0 1 .75-.75H5.35a.75.75 0 0 1 0 1.5H3.98l.841.841a4.5 4.5 0 0 0 7.08-.932.75.75 0 0 1 1.025-.273Z" clip-rule="evenodd" />
        </svg>
        Refresh
      </button>
    </div>

    <div v-if="error" class="shrink-0 bg-red-50 px-3 py-2 text-xs text-red-700 dark:bg-red-900/20 dark:text-red-400">{{ error }}</div>

    <div class="min-h-0 flex-1 overflow-y-auto">
      <div v-if="result && !result.isRepo" class="px-4 py-10 text-center text-sm text-gray-500 dark:text-gray-400">
        This project isn't a git repository.
      </div>
      <div v-else-if="result && files.length === 0" class="px-4 py-10 text-center text-sm text-gray-500 dark:text-gray-400">
        No uncommitted changes.
      </div>
      <div v-else-if="!result && loading" class="px-4 py-10 text-center text-sm text-gray-400 dark:text-gray-500">
        Loading changes…
      </div>

      <div v-for="file in files" :key="file.path" class="border-b border-gray-100 dark:border-gray-800/70">
        <!-- File row -->
        <button
          class="flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition hover:bg-gray-50 dark:hover:bg-gray-800/50"
          :class="{ 'bg-gray-50 dark:bg-gray-800/50': openPath === file.path }"
          @click="toggle(file.path)"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 20 20"
            fill="currentColor"
            class="h-3.5 w-3.5 shrink-0 text-gray-400 transition-transform dark:text-gray-500"
            :class="{ 'rotate-90': openPath === file.path }"
          >
            <path fill-rule="evenodd" d="M8.22 5.22a.75.75 0 0 1 1.06 0l4.25 4.25a.75.75 0 0 1 0 1.06l-4.25 4.25a.75.75 0 0 1-1.06-1.06L11.94 10 8.22 6.28a.75.75 0 0 1 0-1.06Z" clip-rule="evenodd" />
          </svg>
          <span
            class="w-3 shrink-0 text-center font-mono text-xs font-bold"
            :class="STATUS_BADGE[file.status].cls"
            :title="STATUS_BADGE[file.status].label"
          >{{ STATUS_BADGE[file.status].letter }}</span>
          <span class="min-w-0 flex-1 truncate">
            <span class="text-gray-800 dark:text-gray-200">{{ fileName(file.path) }}</span>
            <span v-if="dirName(file.path)" class="ml-1.5 text-xs text-gray-400 dark:text-gray-500">{{ dirName(file.path) }}</span>
          </span>
          <span v-if="file.binary" class="shrink-0 text-xs text-gray-400 dark:text-gray-500">binary</span>
          <template v-else>
            <span v-if="file.additions" class="shrink-0 font-mono text-xs text-green-600 dark:text-green-400">+{{ file.additions }}</span>
            <span v-if="file.deletions" class="shrink-0 font-mono text-xs text-red-600 dark:text-red-400">−{{ file.deletions }}</span>
          </template>
        </button>

        <!-- Inline diff -->
        <div v-if="openPath === file.path" class="border-t border-gray-100 dark:border-gray-800/70">
          <div v-if="file.oldPath" class="px-3 py-1.5 text-xs text-gray-500 dark:text-gray-400">
            Renamed from {{ file.oldPath }}
          </div>
          <div v-if="diffLoading === file.path && !diffs.has(file.path)" class="px-3 py-3 text-xs text-gray-400">Loading diff…</div>
          <template v-else-if="diffs.get(file.path)">
            <div v-if="diffs.get(file.path)!.binary" class="px-3 py-3 text-xs text-gray-500 dark:text-gray-400">Binary file — no text diff.</div>
            <div v-else-if="!diffLines(diffs.get(file.path)!.diff).length" class="px-3 py-3 text-xs text-gray-500 dark:text-gray-400">
              No content changes (mode or rename only).
            </div>
            <div v-else class="overflow-x-auto bg-white dark:bg-gray-950">
              <pre class="min-w-max py-1 font-mono text-[12px] leading-5"><div
                v-for="(line, i) in diffLines(diffs.get(file.path)!.diff)"
                :key="i"
                class="px-3"
                :class="LINE_CLASS[line.kind]"
              >{{ line.text || ' ' }}</div></pre>
            </div>
            <div v-if="diffs.get(file.path)!.truncated" class="px-3 py-2 text-xs text-amber-600 dark:text-amber-400">
              Diff truncated — it's too large to show in full.
            </div>
          </template>
        </div>
      </div>
    </div>
  </div>
</template>
