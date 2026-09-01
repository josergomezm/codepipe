<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useTeamStore } from '@/stores/team'
import { useProjectsStore } from '@/stores/projects'
import { useUiStore } from '@/stores/ui'
import PersonaAvatar from '@/components/PersonaAvatar.vue'
import type { ActionItem } from '@/api/client'

const teamStore = useTeamStore()
const projectStore = useProjectsStore()
const ui = useUiStore()

const newText = ref('')
const newNotes = ref('')
const showNotes = ref(false)
const newProjectId = ref('')
const showDone = ref(false)

onMounted(() => {
  teamStore.fetchActions()
  teamStore.fetchPersonas()
  if (projectStore.projects.length > 0 && !newProjectId.value) {
    newProjectId.value = projectStore.projects[0].id
  }
})

const grouped = computed(() => {
  const groups = new Map<string, ActionItem[]>()
  for (const item of teamStore.actions) {
    if (item.status === 'done' && !showDone.value) continue
    const list = groups.get(item.projectId) ?? []
    list.push(item)
    groups.set(item.projectId, list)
  }
  return groups
})

const doneCount = computed(() => teamStore.actions.filter((a) => a.status === 'done').length)

function projectName(projectId: string): string {
  return projectStore.projects.find((p) => p.id === projectId)?.name ?? 'Removed project'
}

function raiser(item: ActionItem) {
  return item.personaId ? teamStore.personasById.get(item.personaId) ?? null : null
}

async function add() {
  if (!newText.value.trim() || !newProjectId.value) return
  await teamStore.addAction(newProjectId.value, newText.value.trim(), newNotes.value.trim() || undefined)
  newText.value = ''
  newNotes.value = ''
  showNotes.value = false
}

function formatDate(ts: number): string {
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}
</script>

<template>
  <div class="flex h-full flex-col">
    <!-- Header bar -->
    <div class="flex shrink-0 items-center gap-2 border-b border-gray-200 px-3 py-2 dark:border-gray-800">
      <button
        class="rounded-lg p-1.5 text-gray-600 hover:bg-gray-100 md:hidden dark:text-gray-400 dark:hover:bg-gray-800"
        @click="ui.toggleSidebar()"
      >
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" class="h-5 w-5">
          <path fill-rule="evenodd" d="M2 4.75A.75.75 0 0 1 2.75 4h14.5a.75.75 0 0 1 0 1.5H2.75A.75.75 0 0 1 2 4.75Zm0 10.5a.75.75 0 0 1 .75-.75h14.5a.75.75 0 0 1 0 1.5H2.75a.75.75 0 0 1-.75-.75ZM2 10a.75.75 0 0 1 .75-.75h7.5a.75.75 0 0 1 0 1.5h-7.5A.75.75 0 0 1 2 10Z" clip-rule="evenodd" />
        </svg>
      </button>
      <div class="min-w-0">
        <span class="block text-sm font-medium text-gray-700 dark:text-gray-300">Action items</span>
        <span class="block text-xs text-gray-400 dark:text-gray-500">
          Things only you can do — completing a team-raised item notifies your team
        </span>
      </div>
    </div>

    <!-- Content -->
    <div class="min-h-0 flex-1 overflow-y-auto">
      <div class="mx-auto flex max-w-2xl flex-col gap-5 px-4 py-6">
        <!-- Manual add -->
        <div class="flex flex-col gap-1.5">
          <div class="flex gap-1.5">
            <select
              v-model="newProjectId"
              class="shrink-0 rounded-lg border border-gray-200 bg-white px-2 py-2 text-xs text-gray-700 focus:border-blue-500 focus:outline-none dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300"
            >
              <option v-for="p in projectStore.projects" :key="p.id" :value="p.id">{{ p.name }}</option>
            </select>
            <input
              v-model="newText"
              type="text"
              placeholder="Add something you need to do…"
              class="min-w-0 flex-1 rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-900 placeholder:text-gray-400 focus:border-blue-500 focus:outline-none dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100"
              @keydown.enter="add"
            />
            <button
              :disabled="!newText.trim() || !newProjectId"
              class="shrink-0 rounded-lg bg-blue-600 px-3 py-2 text-xs font-medium text-white transition hover:bg-blue-700 disabled:opacity-50"
              @click="add"
            >Add</button>
          </div>
          <button
            v-if="!showNotes"
            class="self-start text-xs text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
            @click="showNotes = true"
          >+ add context</button>
          <textarea
            v-else
            v-model="newNotes"
            rows="2"
            placeholder="Optional context…"
            class="rounded-lg border border-gray-200 bg-white px-3 py-2 text-xs text-gray-900 placeholder:text-gray-400 focus:border-blue-500 focus:outline-none dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100"
          />
        </div>

        <div v-if="teamStore.error" class="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700 dark:bg-red-900/20 dark:text-red-400">
          {{ teamStore.error }}
        </div>

        <div v-if="grouped.size === 0" class="py-10 text-center text-sm text-gray-400 dark:text-gray-500">
          Nothing blocking. Your team raises items here when only you can unblock something — secrets, accounts, decisions.
        </div>

        <!-- Grouped by project -->
        <div v-for="[projectId, items] in grouped" :key="projectId" class="flex flex-col gap-1.5">
          <h3 class="text-xs font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500">
            {{ projectName(projectId) }}
          </h3>
          <div
            v-for="item in items"
            :key="item.id"
            class="group flex items-start gap-3 rounded-lg border border-gray-200 px-4 py-3 dark:border-gray-700"
          >
            <input
              type="checkbox"
              :checked="item.status === 'done'"
              class="mt-0.5 rounded"
              @change="teamStore.setActionStatus(item.id, item.status === 'done' ? 'open' : 'done')"
            />
            <div class="min-w-0 flex-1">
              <p
                class="text-sm"
                :class="item.status === 'done'
                  ? 'text-gray-400 line-through dark:text-gray-500'
                  : 'text-gray-800 dark:text-gray-200'"
              >{{ item.text }}</p>
              <p v-if="item.notes" class="mt-1 whitespace-pre-wrap text-xs text-gray-400 dark:text-gray-500">{{ item.notes }}</p>
              <div class="mt-1.5 flex items-center gap-2 text-[10px] text-gray-400 dark:text-gray-500">
                <template v-if="raiser(item)">
                  <PersonaAvatar :persona="raiser(item)" size="sm" />
                  <span>raised by {{ raiser(item)!.name }}</span>
                  <span>·</span>
                </template>
                <span>{{ formatDate(item.createdAt) }}</span>
              </div>
            </div>
            <button
              class="shrink-0 rounded p-1 text-gray-300 opacity-100 transition hover:bg-red-50 hover:text-red-600 md:opacity-0 md:group-hover:opacity-100 dark:text-gray-600 dark:hover:bg-red-900/20 dark:hover:text-red-400"
              title="Delete"
              @click="teamStore.deleteAction(item.id)"
            >
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" class="h-3.5 w-3.5">
                <path fill-rule="evenodd" d="M5 3.25V4H2.75a.75.75 0 0 0 0 1.5h.3l.815 8.15A1.5 1.5 0 0 0 5.357 15h5.285a1.5 1.5 0 0 0 1.493-1.35l.815-8.15h.3a.75.75 0 0 0 0-1.5H11v-.75A2.25 2.25 0 0 0 8.75 1h-1.5A2.25 2.25 0 0 0 5 3.25Zm2.25-.75a.75.75 0 0 0-.75.75V4h3v-.75a.75.75 0 0 0-.75-.75h-1.5Z" clip-rule="evenodd" />
              </svg>
            </button>
          </div>
        </div>

        <button
          v-if="doneCount > 0"
          class="self-center text-xs text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
          @click="showDone = !showDone"
        >
          {{ showDone ? 'Hide' : 'Show' }} {{ doneCount }} completed
        </button>
      </div>
    </div>
  </div>
</template>
