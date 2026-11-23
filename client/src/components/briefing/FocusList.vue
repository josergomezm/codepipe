<script setup lang="ts">
import { ref } from 'vue'
import { MAX_FOCUS_ITEMS as MAX, type FocusItem, type Project } from '@/api/client'

/**
 * Your ranked priorities (at most 5), edited inside the Focus sheet. The lead
 * reconciles everything against this list; linking an item to a project lets
 * it compare with activity.
 */
const props = defineProps<{ projects: Project[]; highlight?: string | null }>()
const items = defineModel<FocusItem[]>({ required: true })

const adding = ref(false)
const label = ref('')
const projectId = ref('')

function move(i: number, delta: number) {
  const next = [...items.value]
  const [it] = next.splice(i, 1)
  next.splice(i + delta, 0, it)
  items.value = next
}

function remove(id: string) {
  items.value = items.value.filter((f) => f.id !== id)
}

function add() {
  const text = label.value.trim()
  if (!text) return
  items.value = [...items.value, { id: crypto.randomUUID(), label: text, ...(projectId.value ? { projectId: projectId.value } : {}) }]
  label.value = ''
  projectId.value = ''
  adding.value = false
}

const projectName = (id?: string) => (id ? props.projects.find((p) => p.id === id)?.name : undefined)
</script>

<template>
  <section>

    <ol class="flex flex-col px-2 pb-2">
      <li
        v-for="(item, i) in items"
        :key="item.id"
        class="group flex items-center gap-2 rounded-lg px-1.5 py-1.5 transition"
        :class="highlight === item.id ? 'bg-violet-50 ring-1 ring-violet-300 dark:bg-violet-900/20 dark:ring-violet-700' : 'hover:bg-gray-50 dark:hover:bg-gray-800/60'"
      >
        <span class="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-gray-100 text-[11px] font-semibold text-gray-600 dark:bg-gray-800 dark:text-gray-300">{{ i + 1 }}</span>
        <div class="min-w-0 flex-1">
          <div class="truncate text-sm text-gray-800 dark:text-gray-200">{{ item.label }}</div>
          <div v-if="projectName(item.projectId)" class="truncate text-[11px] text-gray-400 dark:text-gray-500">{{ projectName(item.projectId) }}</div>
        </div>
        <div class="flex shrink-0 items-center opacity-100 transition md:opacity-0 md:group-hover:opacity-100">
          <button class="rounded p-1 text-gray-400 hover:text-gray-700 disabled:opacity-30 dark:text-gray-500 dark:hover:text-gray-200" :disabled="i === 0" title="Move up" @click="move(i, -1)">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" class="h-3.5 w-3.5"><path fill-rule="evenodd" d="M11.78 9.78a.75.75 0 0 1-1.06 0L8 7.06 5.28 9.78a.75.75 0 0 1-1.06-1.06l3.25-3.25a.75.75 0 0 1 1.06 0l3.25 3.25a.75.75 0 0 1 0 1.06Z" clip-rule="evenodd" /></svg>
          </button>
          <button class="rounded p-1 text-gray-400 hover:text-gray-700 disabled:opacity-30 dark:text-gray-500 dark:hover:text-gray-200" :disabled="i === items.length - 1" title="Move down" @click="move(i, 1)">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" class="h-3.5 w-3.5"><path fill-rule="evenodd" d="M4.22 6.22a.75.75 0 0 1 1.06 0L8 8.94l2.72-2.72a.75.75 0 1 1 1.06 1.06l-3.25 3.25a.75.75 0 0 1-1.06 0L4.22 7.28a.75.75 0 0 1 0-1.06Z" clip-rule="evenodd" /></svg>
          </button>
          <button class="rounded p-1 text-gray-400 hover:text-red-600 dark:text-gray-500 dark:hover:text-red-400" title="Remove" @click="remove(item.id)">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" class="h-3.5 w-3.5"><path d="M5.28 4.22a.75.75 0 0 0-1.06 1.06L6.94 8l-2.72 2.72a.75.75 0 1 0 1.06 1.06L8 9.06l2.72 2.72a.75.75 0 1 0 1.06-1.06L9.06 8l2.72-2.72a.75.75 0 0 0-1.06-1.06L8 6.94 5.28 4.22Z" /></svg>
          </button>
        </div>
      </li>
      <li v-if="!items.length" class="px-2 py-2 text-xs text-gray-400 dark:text-gray-500">No priorities yet — add up to five.</li>
    </ol>

    <div v-if="adding" class="flex flex-col gap-1.5 border-t border-gray-100 p-2 dark:border-gray-800">
      <input
        v-model="label"
        type="text"
        placeholder="e.g. Partners MVP live with 3 agencies"
        class="rounded border border-gray-200 bg-white px-2 py-1.5 text-xs text-gray-900 placeholder:text-gray-400 focus:border-violet-500 focus:outline-none dark:border-gray-700 dark:bg-gray-950 dark:text-gray-100"
        @keydown.enter="add"
      />
      <div class="flex gap-1.5">
        <select v-model="projectId" class="min-w-0 flex-1 rounded border border-gray-200 bg-white px-2 py-1.5 text-xs text-gray-700 focus:outline-none dark:border-gray-700 dark:bg-gray-950 dark:text-gray-300">
          <option value="">No project (workspace)</option>
          <option v-for="p in projects" :key="p.id" :value="p.id">{{ p.name }}</option>
        </select>
        <button class="rounded bg-violet-600 px-3 text-xs font-medium text-white hover:bg-violet-700 disabled:opacity-50" :disabled="!label.trim()" @click="add">Add</button>
        <button class="rounded px-2 text-xs text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800" @click="adding = false">Cancel</button>
      </div>
    </div>
    <button
      v-else-if="items.length < MAX"
      class="w-full border-t border-gray-100 px-3 py-2 text-left text-xs text-violet-600 hover:bg-gray-50 dark:border-gray-800 dark:text-violet-400 dark:hover:bg-gray-800/60"
      @click="adding = true"
    >+ Add priority</button>
  </section>
</template>
