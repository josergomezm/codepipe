<script setup lang="ts">
/**
 * The manual "add an action item" form — on the Action items page, and in
 * the quick-add dialog any chat can open (prefilled from the chat).
 */
import { ref, watch, onMounted } from 'vue'
import { useTeamStore } from '@/stores/team'
import { useProjectsStore } from '@/stores/projects'
import type { ActionItem } from '@/api/client'

const props = defineProps<{
  /** Preselected project (the chat's). */
  projectId?: string
  text?: string
  notes?: string
  autofocus?: boolean
}>()

const emit = defineEmits<{ added: [item: ActionItem] }>()

const teamStore = useTeamStore()
const projectStore = useProjectsStore()

const newText = ref(props.text ?? '')
const newNotes = ref(props.notes ?? '')
/** YYYY-MM-DD, or '' for none. */
const newDueDate = ref('')
const showNotes = ref(!!props.notes)
const newProjectId = ref(props.projectId ?? '')
const saving = ref(false)
const textInput = ref<HTMLInputElement | null>(null)

// Default the project — also when projects load after mount.
watch(
  () => projectStore.projects,
  (projects) => {
    if (!projects.some((p) => p.id === newProjectId.value)) newProjectId.value = projects[0]?.id ?? ''
  },
  { immediate: true },
)

onMounted(() => {
  if (props.autofocus) textInput.value?.focus()
})

async function add() {
  if (!newText.value.trim() || !newProjectId.value || saving.value) return
  saving.value = true
  const item = await teamStore.addAction(
    newProjectId.value,
    newText.value.trim(),
    newNotes.value.trim() || undefined,
    newDueDate.value || undefined,
  )
  saving.value = false
  if (!item) return
  newText.value = ''
  newNotes.value = ''
  newDueDate.value = ''
  showNotes.value = false
  emit('added', item)
}
</script>

<template>
  <div class="flex flex-col gap-1.5">
    <div class="flex gap-1.5">
      <select
        v-model="newProjectId"
        class="w-28 shrink-0 rounded-lg border border-gray-200 bg-white px-2 py-2 text-xs text-gray-700 focus:border-blue-500 focus:outline-none sm:w-auto dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300"
      >
        <option v-for="p in projectStore.projects" :key="p.id" :value="p.id">{{ p.name }}</option>
      </select>
      <input
        ref="textInput"
        v-model="newText"
        type="text"
        placeholder="Add something you need to do…"
        class="min-w-0 flex-1 rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-900 placeholder:text-gray-400 focus:border-blue-500 focus:outline-none dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100"
        @keydown.enter="add"
      />
      <button
        :disabled="!newText.trim() || !newProjectId || saving"
        class="shrink-0 rounded-lg bg-blue-600 px-3 py-2 text-xs font-medium text-white transition hover:bg-blue-700 disabled:opacity-50"
        @click="add"
      >Add</button>
    </div>
    <div class="flex items-center gap-3">
      <button
        v-if="!showNotes"
        class="text-xs text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
        @click="showNotes = true"
      >+ add context</button>
      <label class="flex items-center gap-1.5 text-xs text-gray-400">
        Due
        <input
          v-model="newDueDate"
          type="date"
          class="rounded border border-gray-200 bg-white px-1.5 py-0.5 text-xs text-gray-700 focus:border-blue-500 focus:outline-none dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300 dark:[color-scheme:dark]"
        />
      </label>
    </div>
    <textarea
      v-if="showNotes"
      v-model="newNotes"
      rows="3"
      placeholder="Optional context…"
      class="rounded-lg border border-gray-200 bg-white px-3 py-2 text-xs text-gray-900 placeholder:text-gray-400 focus:border-blue-500 focus:outline-none dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100"
    />
  </div>
</template>
