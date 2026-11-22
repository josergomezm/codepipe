<script setup lang="ts">
import { computed, onUnmounted, ref, watch, type Directive } from 'vue'
import { fetchDir, fetchMedia, rawFileUrl, type DirListing, type FileEntry, type FileKind } from '@/api/client'
import FileViewer from '@/components/FileViewer.vue'
import FileKindIcon from '@/components/FileKindIcon.vue'
import { dayLabel, dirName, entryForPath, formatSize, formatWhen } from '@/lib/files'

/**
 * The Files tab: a project's media, newest first (renders, screenshots,
 * voiceovers…), and a plain folder browser. Either opens files in FileViewer.
 */
const props = defineProps<{
  projectId: string
  active: boolean
  /** A path to open (clicked in chat); nonce changes on every request. */
  request?: { path: string; nonce: number } | null
}>()

type Mode = 'media' | 'browse'
const mode = ref<Mode>('media')

// --- Media ---
type MediaFilter = Extract<FileKind, 'video' | 'image' | 'audio' | 'pdf'>
const FILTERS: { id: MediaFilter; label: string }[] = [
  { id: 'video', label: 'Videos' },
  { id: 'image', label: 'Images' },
  { id: 'audio', label: 'Audio' },
  { id: 'pdf', label: 'PDFs' },
]
const filter = ref<MediaFilter>('video')
const media = ref<{ files: FileEntry[]; total: number; truncated: boolean } | null>(null)
const mediaLoading = ref(false)
const query = ref('')

// --- Browse ---
const dir = ref<DirListing | null>(null)
const dirPath = ref('')
const dirLoading = ref(false)

const error = ref<string | null>(null)

async function loadMedia() {
  mediaLoading.value = true
  error.value = null
  const want = filter.value
  try {
    const result = await fetchMedia(props.projectId, [want])
    if (want === filter.value) media.value = result
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Failed to load media'
  } finally {
    mediaLoading.value = false
  }
}

async function loadDir(path = dirPath.value) {
  dirLoading.value = true
  error.value = null
  try {
    dir.value = await fetchDir(props.projectId, path)
    dirPath.value = dir.value.path
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Failed to load folder'
  } finally {
    dirLoading.value = false
  }
}

function refresh() {
  if (mode.value === 'media') void loadMedia()
  else void loadDir()
}
defineExpose({ refresh })

// Load lazily: only once the tab is shown, and again on each re-show.
watch(() => props.projectId, () => {
  media.value = null
  dir.value = null
  dirPath.value = ''
  viewer.value = null
  if (props.active) refresh()
})
watch(() => props.active, (a) => { if (a) refresh() }, { immediate: true })
watch(mode, (m) => {
  if (m === 'media' && !media.value) void loadMedia()
  if (m === 'browse' && !dir.value) void loadDir()
})
watch(filter, () => { media.value = null; void loadMedia() })

const filteredMedia = computed(() => {
  const q = query.value.trim().toLowerCase()
  const files = media.value?.files ?? []
  return q ? files.filter((f) => f.path.toLowerCase().includes(q)) : files
})

/** Media grouped by the day it was last written. */
const mediaGroups = computed(() => {
  const groups: { label: string; items: { file: FileEntry; i: number }[] }[] = []
  filteredMedia.value.forEach((file, i) => {
    const label = dayLabel(file.mtime)
    const last = groups[groups.length - 1]
    if (last?.label === label) last.items.push({ file, i })
    else groups.push({ label, items: [{ file, i }] })
  })
  return groups
})

const crumbs = computed(() => {
  const parts = dirPath.value ? dirPath.value.split('/') : []
  return parts.map((name, i) => ({ name, path: parts.slice(0, i + 1).join('/') }))
})

const dirFiles = computed(() => (dir.value?.entries ?? []).filter((e) => e.type === 'file'))
const filteredEntries = computed(() => {
  const q = query.value.trim().toLowerCase()
  const entries = dir.value?.entries ?? []
  return q ? entries.filter((e) => e.name.toLowerCase().includes(q)) : entries
})

// --- Viewer ---
const viewer = ref<{ files: FileEntry[]; index: number } | null>(null)

function openMedia(i: number) {
  viewer.value = { files: filteredMedia.value, index: i }
}

function openEntry(entry: FileEntry) {
  if (entry.type === 'dir') {
    query.value = ''
    void loadDir(entry.path)
    return
  }
  viewer.value = { files: dirFiles.value, index: Math.max(0, dirFiles.value.findIndex((f) => f.path === entry.path)) }
}

watch(() => props.request?.nonce, () => {
  if (!props.request) return
  viewer.value = { files: [entryForPath(props.request.path)], index: 0 }
})

function showInFolder(path: string) {
  mode.value = 'browse'
  query.value = ''
  void loadDir(dirName(path))
}

// Video thumbnails: only attach a <video> once its card scrolls into view,
// so a folder of 200 renders doesn't fire 200 metadata requests at once.
const visible = ref<Set<string>>(new Set())
let observer: IntersectionObserver | null = null
function getObserver(): IntersectionObserver {
  observer ??= new IntersectionObserver((entries) => {
    let changed = false
    const next = new Set(visible.value)
    for (const e of entries) {
      const key = (e.target as HTMLElement).dataset.thumb!
      if (e.isIntersecting && !next.has(key)) { next.add(key); changed = true; observer!.unobserve(e.target) }
    }
    if (changed) visible.value = next
  }, { rootMargin: '300px' })
  return observer
}
const vThumb: Directive<HTMLElement> = {
  mounted: (el) => getObserver().observe(el),
  unmounted: (el) => observer?.unobserve(el),
}
onUnmounted(() => observer?.disconnect())

function thumbUrl(f: FileEntry): string {
  return rawFileUrl(props.projectId, f.path, { v: f.mtime })
}

/** Renders usually open on a black fade-in — show a frame ~30% in instead. */
function seekThumb(e: Event) {
  const v = e.target as HTMLVideoElement
  if (Number.isFinite(v.duration) && v.duration > 0) v.currentTime = Math.min(v.duration * 0.3, 8)
}
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col">
    <!-- Toolbar -->
    <div class="flex shrink-0 flex-wrap items-center gap-2 border-b border-gray-200 px-3 py-2 text-xs dark:border-gray-800">
      <div class="flex rounded-lg bg-gray-100 p-0.5 dark:bg-gray-800">
        <button
          v-for="m in (['media', 'browse'] as const)"
          :key="m"
          class="rounded-md px-2.5 py-1 font-medium transition"
          :class="mode === m ? 'bg-white text-gray-900 shadow-sm dark:bg-gray-700 dark:text-gray-100' : 'text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200'"
          @click="mode = m"
        >{{ m === 'media' ? 'Media' : 'Browse' }}</button>
      </div>

      <template v-if="mode === 'media'">
        <button
          v-for="f in FILTERS"
          :key="f.id"
          class="rounded-full border px-2.5 py-0.5 transition"
          :class="filter === f.id
            ? 'border-violet-300 bg-violet-50 text-violet-700 dark:border-violet-700 dark:bg-violet-900/30 dark:text-violet-300'
            : 'border-gray-200 text-gray-500 hover:border-gray-300 dark:border-gray-700 dark:text-gray-400 dark:hover:border-gray-600'"
          @click="filter = f.id"
        >{{ f.label }}</button>
      </template>

      <div class="flex-1" />
      <input
        v-model="query"
        type="search"
        :placeholder="mode === 'media' ? 'Filter by path…' : 'Filter this folder…'"
        class="w-36 rounded-md border border-gray-200 bg-white px-2 py-1 text-xs text-gray-800 outline-none placeholder:text-gray-400 focus:border-violet-400 sm:w-48 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200"
      >
      <button
        class="flex items-center rounded-md p-1.5 text-gray-500 transition hover:bg-gray-100 hover:text-gray-700 disabled:opacity-50 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-gray-200"
        :disabled="mediaLoading || dirLoading"
        title="Refresh"
        @click="refresh"
      >
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" class="h-3.5 w-3.5" :class="{ 'animate-spin': mediaLoading || dirLoading }">
          <path fill-rule="evenodd" d="M13.836 2.477a.75.75 0 0 1 .75.75v3.182a.75.75 0 0 1-.75.75h-3.182a.75.75 0 0 1 0-1.5h1.37l-.84-.841a4.5 4.5 0 0 0-7.08.932.75.75 0 0 1-1.3-.75 6 6 0 0 1 9.44-1.242l.842.84V3.227a.75.75 0 0 1 .75-.75Zm-.911 7.5A.75.75 0 0 1 13.199 11a6 6 0 0 1-9.44 1.241l-.84-.84v1.371a.75.75 0 0 1-1.5 0V9.591a.75.75 0 0 1 .75-.75H5.35a.75.75 0 0 1 0 1.5H3.98l.841.841a4.5 4.5 0 0 0 7.08-.932.75.75 0 0 1 1.025-.273Z" clip-rule="evenodd" />
        </svg>
      </button>
    </div>

    <div v-if="error" class="shrink-0 bg-red-50 px-3 py-2 text-xs text-red-700 dark:bg-red-900/20 dark:text-red-400">{{ error }}</div>

    <!-- Media -->
    <div v-if="mode === 'media'" class="min-h-0 flex-1 overflow-y-auto">
      <div v-if="!media && mediaLoading" class="px-4 py-10 text-center text-sm text-gray-400 dark:text-gray-500">Scanning project…</div>
      <div v-else-if="media && !filteredMedia.length" class="px-4 py-10 text-center text-sm text-gray-500 dark:text-gray-400">
        {{ query ? 'Nothing matches that filter.' : `No ${FILTERS.find((f) => f.id === filter)!.label.toLowerCase()} in this project.` }}
      </div>
      <template v-else-if="media">
        <div v-if="media.total > media.files.length || media.truncated" class="px-3 pt-2 text-[11px] text-gray-400 dark:text-gray-500">
          <template v-if="media.total > media.files.length">Showing the newest {{ media.files.length }} of {{ media.total }}. Filter by path or use Browse for older ones.</template>
          <template v-if="media.truncated"> The scan stopped early in this very large project; Browse reaches everything.</template>
        </div>
        <section v-for="group in mediaGroups" :key="group.label" class="px-3 pb-2">
          <h3 class="sticky top-0 z-10 -mx-3 bg-white/90 px-3 pb-1.5 pt-3 text-[11px] font-semibold uppercase tracking-wide text-gray-500 backdrop-blur dark:bg-gray-950/90 dark:text-gray-400">
            {{ group.label }} <span class="font-normal normal-case text-gray-400 dark:text-gray-500">· {{ group.items.length }}</span>
          </h3>

          <!-- Visual kinds: thumbnail grid -->
          <div v-if="filter === 'video' || filter === 'image'" class="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
            <button
              v-for="{ file, i } in group.items"
              :key="file.path"
              v-thumb
              :data-thumb="file.path"
              class="group overflow-hidden rounded-xl border border-gray-200 bg-white text-left transition hover:border-violet-300 hover:shadow-md dark:border-gray-800 dark:bg-gray-900 dark:hover:border-violet-700"
              :title="file.path"
              @click="openMedia(i)"
            >
              <div class="relative aspect-video bg-gray-100 dark:bg-gray-800">
                <template v-if="visible.has(file.path)">
                  <video v-if="file.kind === 'video'" :src="thumbUrl(file)" preload="metadata" muted playsinline class="h-full w-full object-cover" @loadedmetadata="seekThumb" />
                  <img v-else :src="thumbUrl(file)" loading="lazy" :alt="file.name" class="h-full w-full object-contain">
                </template>
                <div v-if="file.kind === 'video'" class="absolute inset-0 flex items-center justify-center">
                  <span class="flex h-9 w-9 items-center justify-center rounded-full bg-black/55 text-white opacity-90 transition group-hover:scale-110 group-hover:bg-violet-600">
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" class="ml-0.5 h-4 w-4"><path d="M6.3 2.84A1.5 1.5 0 0 0 4 4.11v11.78a1.5 1.5 0 0 0 2.3 1.27l9.344-5.891a1.5 1.5 0 0 0 0-2.538L6.3 2.841Z" /></svg>
                  </span>
                </div>
              </div>
              <div class="px-2 py-1.5">
                <div class="truncate text-xs font-medium text-gray-800 dark:text-gray-200">{{ file.name }}</div>
                <div class="truncate text-[10px] text-gray-400 dark:text-gray-500">{{ dirName(file.path) || '/' }} · {{ formatSize(file.size) }}</div>
              </div>
            </button>
          </div>

          <!-- Audio / PDF: rows -->
          <div v-else class="divide-y divide-gray-100 overflow-hidden rounded-xl border border-gray-200 dark:divide-gray-800 dark:border-gray-800">
            <button
              v-for="{ file, i } in group.items"
              :key="file.path"
              class="flex w-full items-center gap-2.5 px-3 py-2 text-left transition hover:bg-gray-50 dark:hover:bg-gray-900"
              @click="openMedia(i)"
            >
              <FileKindIcon :kind="file.kind!" class="h-4 w-4 shrink-0" />
              <span class="min-w-0 flex-1 truncate text-sm">
                <span class="text-gray-800 dark:text-gray-200">{{ file.name }}</span>
                <span class="ml-1.5 text-xs text-gray-400 dark:text-gray-500">{{ dirName(file.path) }}</span>
              </span>
              <span class="shrink-0 text-xs text-gray-400 dark:text-gray-500">{{ formatSize(file.size) }}</span>
            </button>
          </div>
        </section>
      </template>
    </div>

    <!-- Browse -->
    <div v-else class="flex min-h-0 flex-1 flex-col">
      <nav class="flex shrink-0 items-center gap-0.5 overflow-x-auto border-b border-gray-100 px-3 py-1.5 text-xs dark:border-gray-800/70">
        <button class="rounded px-1.5 py-0.5 font-medium text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800" @click="loadDir('')">Project</button>
        <template v-for="c in crumbs" :key="c.path">
          <span class="text-gray-300 dark:text-gray-600">/</span>
          <button class="whitespace-nowrap rounded px-1.5 py-0.5 text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800" @click="loadDir(c.path)">{{ c.name }}</button>
        </template>
      </nav>
      <div class="min-h-0 flex-1 overflow-y-auto">
        <div v-if="!dir && dirLoading" class="px-4 py-10 text-center text-sm text-gray-400 dark:text-gray-500">Loading…</div>
        <div v-else-if="dir && !filteredEntries.length" class="px-4 py-10 text-center text-sm text-gray-500 dark:text-gray-400">
          {{ query ? 'Nothing matches that filter.' : 'Empty folder.' }}
        </div>
        <button
          v-for="entry in filteredEntries"
          :key="entry.path"
          class="flex w-full items-center gap-2.5 border-b border-gray-100 px-3 py-2 text-left text-sm transition hover:bg-gray-50 dark:border-gray-800/70 dark:hover:bg-gray-800/50"
          @click="openEntry(entry)"
        >
          <FileKindIcon :kind="entry.type === 'dir' ? 'dir' : entry.kind!" class="h-4 w-4 shrink-0" />
          <span class="min-w-0 flex-1 truncate text-gray-800 dark:text-gray-200">{{ entry.name }}</span>
          <span v-if="entry.type === 'file'" class="hidden w-16 shrink-0 text-right text-xs text-gray-400 sm:block dark:text-gray-500">{{ formatSize(entry.size) }}</span>
          <span class="w-16 shrink-0 text-right text-xs text-gray-400 dark:text-gray-500">{{ formatWhen(entry.mtime) }}</span>
        </button>
      </div>
    </div>

    <FileViewer
      v-if="viewer"
      v-model:index="viewer.index"
      :project-id="projectId"
      :files="viewer.files"
      @close="viewer = null"
      @show-in-folder="showInFolder"
    />
  </div>
</template>
