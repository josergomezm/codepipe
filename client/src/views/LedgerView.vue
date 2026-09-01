<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useTeamStore } from '@/stores/team'
import { useProjectsStore } from '@/stores/projects'
import { useSessionsStore } from '@/stores/sessions'
import { useUiStore } from '@/stores/ui'
import PersonaAvatar from '@/components/PersonaAvatar.vue'
import type { Todo } from '@/api/client'

const teamStore = useTeamStore()
const projectStore = useProjectsStore()
const sessionStore = useSessionsStore()
const ui = useUiStore()
const router = useRouter()

async function openSession(sessionId: string) {
  await sessionStore.fetchSessions()
  await sessionStore.selectSession(sessionId)
  router.push('/')
}

/** '' = all projects */
const filterProjectId = ref('')

onMounted(() => {
  teamStore.fetchTodos()
  teamStore.fetchPersonas()
})

function completedAt(todo: Todo): number {
  return todo.completedAt ?? todo.updatedAt
}

const doneTodos = computed(() =>
  teamStore.todos
    .filter((t) => t.status === 'done')
    .filter((t) => !filterProjectId.value || t.projectId === filterProjectId.value)
    .sort((a, b) => completedAt(b) - completedAt(a)),
)

/** Grouped by "September 2026"-style month labels, newest first. */
const byMonth = computed(() => {
  const groups = new Map<string, Todo[]>()
  for (const todo of doneTodos.value) {
    const d = new Date(completedAt(todo))
    const label = d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
    const list = groups.get(label) ?? []
    list.push(todo)
    groups.set(label, list)
  }
  return groups
})

const thisMonthCount = computed(() => {
  const now = new Date()
  return doneTodos.value.filter((t) => {
    const d = new Date(completedAt(t))
    return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth()
  }).length
})

function projectName(projectId: string): string {
  return projectStore.projects.find((p) => p.id === projectId)?.name ?? 'Removed project'
}

function proposer(todo: Todo) {
  return todo.proposal?.personaId ? teamStore.personasById.get(todo.proposal.personaId) ?? null : null
}

function formatDay(todo: Todo): string {
  return new Date(completedAt(todo)).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
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
      <span class="text-sm font-medium text-gray-700 dark:text-gray-300">Ledger</span>
      <select
        v-model="filterProjectId"
        class="rounded-lg border border-gray-200 bg-white px-2 py-1 text-xs text-gray-700 focus:border-blue-500 focus:outline-none dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300"
      >
        <option value="">All projects</option>
        <option v-for="p in projectStore.projects" :key="p.id" :value="p.id">{{ p.name }}</option>
      </select>
    </div>

    <!-- Content -->
    <div class="min-h-0 flex-1 overflow-y-auto">
      <div class="mx-auto flex max-w-2xl flex-col gap-6 px-4 py-6">
        <!-- Stats -->
        <div class="grid grid-cols-2 gap-3">
          <div class="rounded-xl bg-gray-50 px-4 py-3 dark:bg-gray-900/60">
            <div class="text-xs text-gray-400 dark:text-gray-500">Shipped this month</div>
            <div class="text-2xl font-semibold text-gray-900 dark:text-gray-100">{{ thisMonthCount }}</div>
          </div>
          <div class="rounded-xl bg-gray-50 px-4 py-3 dark:bg-gray-900/60">
            <div class="text-xs text-gray-400 dark:text-gray-500">Shipped all time</div>
            <div class="text-2xl font-semibold text-gray-900 dark:text-gray-100">{{ doneTodos.length }}</div>
          </div>
        </div>

        <div v-if="doneTodos.length === 0" class="py-10 text-center text-sm text-gray-400 dark:text-gray-500">
          Nothing shipped yet. Ideas land here when they reach Done on the board — your progress, on the record.
        </div>

        <!-- Month groups -->
        <div v-for="[month, todos] in byMonth" :key="month" class="flex flex-col gap-1.5">
          <h3 class="text-xs font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500">
            {{ month }} <span class="font-normal normal-case">· {{ todos.length }} shipped</span>
          </h3>
          <div
            v-for="todo in todos"
            :key="todo.id"
            class="flex items-start gap-3 rounded-lg border border-gray-200 px-4 py-3 dark:border-gray-700"
          >
            <span class="mt-0.5 shrink-0 text-[10px] font-medium text-gray-400 tabular-nums dark:text-gray-500">
              {{ formatDay(todo) }}
            </span>
            <div class="min-w-0 flex-1">
              <p class="text-sm text-gray-800 dark:text-gray-200">{{ todo.text }}</p>
              <div class="mt-1 flex flex-wrap items-center gap-2 text-[10px] text-gray-400 dark:text-gray-500">
                <span class="rounded-full bg-purple-50 px-1.5 py-0.5 font-medium text-purple-700 dark:bg-purple-900/30 dark:text-purple-300">
                  {{ projectName(todo.projectId) }}
                </span>
                <template v-if="todo.proposal">
                  <PersonaAvatar :persona="proposer(todo)" size="sm" />
                  <span class="line-clamp-1">{{ todo.proposal.summary }}</span>
                </template>
                <button
                  v-if="todo.workSessionId"
                  class="text-blue-600 hover:underline dark:text-blue-400"
                  @click="openSession(todo.workSessionId!)"
                >build session</button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
