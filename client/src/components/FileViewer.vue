<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { rawFileUrl, type FileEntry } from '@/api/client'
import MarkdownContent from '@/components/MarkdownContent.vue'
import FileKindIcon from '@/components/FileKindIcon.vue'
import { baseName, dirName, entryForPath, formatSize, formatWhen, MAX_TEXT_PREVIEW } from '@/lib/files'

/**
 * Full-screen preview of one project file, with prev/next through `files`
 * (← / → keys too). Video/audio stream with seeking; images fit-to-screen
 * (click for actual size); PDFs use the browser's viewer; markdown renders;
 * other text shows with line numbers.
 */
const props = defineProps<{ projectId: string; files: FileEntry[]; index: number }>()
const emit = defineEmits<{ close: []; 'update:index': [i: number]; 'show-in-folder': [path: string] }>()

// Links inside a markdown file can open other files; those stack here so the
// viewer can show them without disturbing the caller's list.
const detour = ref<FileEntry | null>(null)
const file = computed<FileEntry>(() => detour.value ?? props.files[props.index])
const canNav = computed(() => !detour.value && props.files.length > 1)

const src = computed(() => rawFileUrl(props.projectId, file.value.path, { v: file.value.mtime }))
const downloadUrl = computed(() => rawFileUrl(props.projectId, file.value.path, { download: true }))

const text = ref<string | null>(null)
const textError = ref<string | null>(null)
const textLoading = ref(false)
const tooBig = computed(() => (file.value.size ?? 0) > MAX_TEXT_PREVIEW)
const zoomed = ref(false)
const mediaError = ref(false)

async function loadText() {
  text.value = null
  textError.value = null
  if (file.value.kind !== 'markdown' && file.value.kind !== 'text') return
  if (tooBig.value) return
  textLoading.value = true
  const path = file.value.path
  try {
    const res = await fetch(src.value)
    if (!res.ok) throw new Error(res.status === 404 ? 'File not found in this project.' : `Couldn't load (${res.status}).`)
    const len = Number(res.headers.get('content-length') ?? 0)
    if (len > MAX_TEXT_PREVIEW) throw new Error('File is too large to preview.')
    const body = await res.text()
    if (path !== file.value.path) return
    // A NUL byte early on means it isn't text after all.
    if (body.slice(0, 8000).includes('\u0000')) throw new Error('Binary file — no preview.')
    text.value = body
  } catch (e) {
    if (path === file.value.path) textError.value = e instanceof Error ? e.message : 'Failed to load file'
  } finally {
    if (path === file.value.path) textLoading.value = false
  }
}

watch(() => file.value.path, () => {
  zoomed.value = false
  mediaError.value = false
  void loadText()
}, { immediate: true })

const lines = computed(() => (text.value ?? '').replace(/\n$/, '').split('\n'))

function go(delta: number) {
  if (!canNav.value) return
  const n = props.files.length
  emit('update:index', (props.index + delta + n) % n)
}

function openLinked(path: string) {
  detour.value = entryForPath(path)
}

function back() {
  if (detour.value) detour.value = null
  else emit('close')
}

function onKey(e: KeyboardEvent) {
  const t = e.target as HTMLElement | null
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return
  if (e.key === 'Escape') { e.preventDefault(); back() }
  // Leave arrows to a focused video/audio (seeking).
  else if ((e.key === 'ArrowRight' || e.key === 'ArrowLeft') && !(t && (t.tagName === 'VIDEO' || t.tagName === 'AUDIO'))) {
    go(e.key === 'ArrowRight' ? 1 : -1)
  }
}

onMounted(() => window.addEventListener('keydown', onKey))
onUnmounted(() => window.removeEventListener('keydown', onKey))

const copied = ref(false)
async function copyPath() {
  await navigator.clipboard.writeText(file.value.path)
  copied.value = true
  setTimeout(() => (copied.value = false), 1500)
}

// Swipe left/right on touch screens (not over a video's own controls area).
let touchX: number | null = null
function onTouchStart(e: TouchEvent) { touchX = e.touches.length === 1 ? e.touches[0].clientX : null }
function onTouchEnd(e: TouchEvent) {
  if (touchX == null || zoomed.value) return
  const dx = e.changedTouches[0].clientX - touchX
  touchX = null
  if (Math.abs(dx) > 60) go(dx < 0 ? 1 : -1)
}

const isMediaStage = computed(() => ['video', 'image', 'audio', 'pdf'].includes(file.value.kind ?? ''))
</script>

<template>
  <div class="fixed inset-0 z-50 flex flex-col bg-white dark:bg-gray-950" role="dialog" aria-modal="true" :aria-label="file.name">
    <!-- Header -->
    <div class="flex shrink-0 items-center gap-1 border-b border-gray-200 px-2 py-2 dark:border-gray-800" style="padding-top: max(0.5rem, env(safe-area-inset-top))">
      <button
        class="rounded-lg p-1.5 text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800"
        :title="detour ? 'Back' : 'Close (Esc)'"
        @click="back"
      >
        <svg v-if="detour" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" class="h-5 w-5"><path fill-rule="evenodd" d="M17 10a.75.75 0 0 1-.75.75H5.612l4.158 3.96a.75.75 0 1 1-1.04 1.08l-5.5-5.25a.75.75 0 0 1 0-1.08l5.5-5.25a.75.75 0 1 1 1.04 1.08L5.612 9.25H16.25A.75.75 0 0 1 17 10Z" clip-rule="evenodd" /></svg>
        <svg v-else xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" class="h-5 w-5"><path d="M6.28 5.22a.75.75 0 0 0-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 1 0 1.06 1.06L10 11.06l3.72 3.72a.75.75 0 1 0 1.06-1.06L11.06 10l3.72-3.72a.75.75 0 0 0-1.06-1.06L10 8.94 6.28 5.22Z" /></svg>
      </button>
      <FileKindIcon :kind="file.kind ?? 'other'" class="ml-1 h-4 w-4 shrink-0" />
      <div class="ml-1.5 min-w-0 flex-1">
        <div class="truncate text-sm font-medium text-gray-800 dark:text-gray-200" :title="file.path">{{ baseName(file.path) }}</div>
        <div class="truncate text-[11px] text-gray-400 dark:text-gray-500">
          <span v-if="dirName(file.path)">{{ dirName(file.path) }}</span>
          <template v-if="file.size != null"> · {{ formatSize(file.size) }}</template>
          <template v-if="file.mtime"> · {{ formatWhen(file.mtime) }}</template>
        </div>
      </div>

      <span v-if="canNav" class="mr-1 hidden text-xs tabular-nums text-gray-400 sm:inline dark:text-gray-500">{{ index + 1 }} / {{ files.length }}</span>
      <button v-if="canNav" class="rounded-lg p-1.5 text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800" title="Previous (←)" @click="go(-1)">
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" class="h-5 w-5"><path fill-rule="evenodd" d="M11.78 5.22a.75.75 0 0 1 0 1.06L8.06 10l3.72 3.72a.75.75 0 1 1-1.06 1.06l-4.25-4.25a.75.75 0 0 1 0-1.06l4.25-4.25a.75.75 0 0 1 1.06 0Z" clip-rule="evenodd" /></svg>
      </button>
      <button v-if="canNav" class="rounded-lg p-1.5 text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800" title="Next (→)" @click="go(1)">
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" class="h-5 w-5"><path fill-rule="evenodd" d="M8.22 5.22a.75.75 0 0 1 1.06 0l4.25 4.25a.75.75 0 0 1 0 1.06l-4.25 4.25a.75.75 0 0 1-1.06-1.06L11.94 10 8.22 6.28a.75.75 0 0 1 0-1.06Z" clip-rule="evenodd" /></svg>
      </button>
      <span class="mx-1 h-5 w-px bg-gray-200 dark:bg-gray-700" />
      <button class="rounded-lg p-1.5 text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800" :title="copied ? 'Copied' : 'Copy path'" @click="copyPath">
        <svg v-if="!copied" xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
        <svg v-else xmlns="http://www.w3.org/2000/svg" class="h-5 w-5 text-green-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
      </button>
      <button class="rounded-lg p-1.5 text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800" title="Show in folder" @click="emit('show-in-folder', file.path); emit('close')">
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" class="h-5 w-5"><path d="M3.75 3A1.75 1.75 0 0 0 2 4.75v3.26a3.235 3.235 0 0 1 1.75-.51h12.5c.644 0 1.245.188 1.75.51V6.75A1.75 1.75 0 0 0 16.25 5h-4.836a.25.25 0 0 1-.177-.073L9.823 3.513A1.75 1.75 0 0 0 8.586 3H3.75ZM3.75 9A1.75 1.75 0 0 0 2 10.75v4.5c0 .966.784 1.75 1.75 1.75h12.5A1.75 1.75 0 0 0 18 15.25v-4.5A1.75 1.75 0 0 0 16.25 9H3.75Z" /></svg>
      </button>
      <a :href="src" target="_blank" rel="noopener" class="rounded-lg p-1.5 text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800" title="Open in new tab">
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" class="h-5 w-5"><path fill-rule="evenodd" d="M4.25 5.5a.75.75 0 0 0-.75.75v8.5c0 .414.336.75.75.75h8.5a.75.75 0 0 0 .75-.75v-4a.75.75 0 0 1 1.5 0v4A2.25 2.25 0 0 1 12.75 17h-8.5A2.25 2.25 0 0 1 2 14.75v-8.5A2.25 2.25 0 0 1 4.25 4h5a.75.75 0 0 1 0 1.5h-5Z" clip-rule="evenodd" /><path fill-rule="evenodd" d="M6.194 12.753a.75.75 0 0 0 1.06.053L16.5 4.44v2.81a.75.75 0 0 0 1.5 0v-4.5a.75.75 0 0 0-.75-.75h-4.5a.75.75 0 0 0 0 1.5h2.553l-9.056 8.194a.75.75 0 0 0-.053 1.06Z" clip-rule="evenodd" /></svg>
      </a>
      <a :href="downloadUrl" class="rounded-lg p-1.5 text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800" title="Download">
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" class="h-5 w-5"><path d="M10.75 2.75a.75.75 0 0 0-1.5 0v8.614L6.295 8.235a.75.75 0 1 0-1.09 1.03l4.25 4.5a.75.75 0 0 0 1.09 0l4.25-4.5a.75.75 0 0 0-1.09-1.03l-2.955 3.129V2.75Z" /><path d="M3.5 12.75a.75.75 0 0 0-1.5 0v2.5A2.75 2.75 0 0 0 4.75 18h10.5A2.75 2.75 0 0 0 18 15.25v-2.5a.75.75 0 0 0-1.5 0v2.5c0 .69-.56 1.25-1.25 1.25H4.75c-.69 0-1.25-.56-1.25-1.25v-2.5Z" /></svg>
      </a>
    </div>

    <!-- Stage -->
    <div
      class="relative min-h-0 flex-1"
      :class="isMediaStage ? 'bg-gray-950' : 'overflow-auto'"
      @touchstart.passive="onTouchStart"
      @touchend.passive="onTouchEnd"
    >
      <div v-if="mediaError" class="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-sm text-gray-400">
        <p>Couldn't play this file here — it may not exist any more, or the browser doesn't support its format.</p>
        <a :href="downloadUrl" class="text-violet-400 underline">Download it instead</a>
      </div>

      <video
        v-else-if="file.kind === 'video'"
        :key="src"
        :src="src"
        class="h-full w-full object-contain"
        controls
        autoplay
        playsinline
        @error="mediaError = true"
      />

      <div v-else-if="file.kind === 'image'" class="h-full w-full" :class="zoomed ? 'overflow-auto' : 'flex items-center justify-center p-3'">
        <img
          :key="src"
          :src="src"
          :alt="file.name"
          class="select-none"
          :class="zoomed ? 'max-w-none cursor-zoom-out' : 'max-h-full max-w-full cursor-zoom-in object-contain'"
          style="background: repeating-conic-gradient(#80808022 0% 25%, transparent 0% 50%) 50% / 16px 16px"
          @click="zoomed = !zoomed"
          @error="mediaError = true"
        >
      </div>

      <div v-else-if="file.kind === 'audio'" class="flex h-full flex-col items-center justify-center gap-6 px-6">
        <div class="flex h-28 w-28 items-center justify-center rounded-3xl bg-gradient-to-br from-amber-500/30 to-violet-600/30">
          <FileKindIcon kind="audio" class="h-12 w-12" />
        </div>
        <div class="max-w-full truncate text-sm text-gray-300">{{ file.name }}</div>
        <audio :key="src" :src="src" controls autoplay class="w-full max-w-md" @error="mediaError = true" />
      </div>

      <iframe v-else-if="file.kind === 'pdf'" :key="src" :src="src" class="h-full w-full border-0 bg-white" :title="file.name" />

      <!-- Text-ish -->
      <template v-else>
        <div v-if="textLoading" class="px-4 py-10 text-center text-sm text-gray-400">Loading…</div>
        <div v-else-if="textError || tooBig || file.kind === 'other'" class="flex flex-col items-center gap-3 px-6 py-16 text-center text-sm text-gray-500 dark:text-gray-400">
          <FileKindIcon :kind="file.kind ?? 'other'" class="h-10 w-10" />
          <p>{{ textError ?? (tooBig ? 'This file is too large to preview.' : 'No preview for this file type.') }}</p>
          <a v-if="textError !== 'File not found in this project.'" :href="downloadUrl" class="text-violet-600 underline dark:text-violet-400">Download</a>
        </div>
        <div v-else-if="file.kind === 'markdown' && text != null" class="mx-auto max-w-3xl px-5 py-6">
          <MarkdownContent
            :source="text"
            :env="{ basePath: dirName(file.path), rawUrl: (p: string) => rawFileUrl(projectId, p) }"
            @open-file="openLinked"
          />
        </div>
        <div v-else-if="text != null" class="min-w-max py-2 font-mono text-[12px] leading-5">
          <div v-for="(line, i) in lines" :key="i" class="flex hover:bg-gray-50 dark:hover:bg-gray-900">
            <span class="sticky left-0 w-12 shrink-0 select-none bg-white pr-3 text-right text-gray-400 dark:bg-gray-950 dark:text-gray-600">{{ i + 1 }}</span>
            <span class="whitespace-pre pr-4 text-gray-800 dark:text-gray-200">{{ line || ' ' }}</span>
          </div>
        </div>
      </template>
    </div>
  </div>
</template>
