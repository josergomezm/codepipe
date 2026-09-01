<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useTeamStore } from '@/stores/team'
import { useProjectsStore } from '@/stores/projects'
import { useSessionsStore } from '@/stores/sessions'
import { useUiStore } from '@/stores/ui'
import PersonaAvatar from '@/components/PersonaAvatar.vue'
import type { Todo, TodoStatus } from '@/api/client'

const teamStore = useTeamStore()
const projectStore = useProjectsStore()
const sessionStore = useSessionsStore()
const ui = useUiStore()
const router = useRouter()

/** '' = all projects */
const filterProjectId = ref('')
const newText = ref('')
const newProjectId = ref('')
const runMessage = ref<string | null>(null)

onMounted(() => {
  teamStore.fetchTodos()
  teamStore.fetchPersonas()
  if (projectStore.projects.length > 0) newProjectId.value = projectStore.projects[0].id
})

const COLUMNS: { status: TodoStatus; label: string }[] = [
  { status: 'inbox', label: 'Inbox' },
  { status: 'under_review', label: 'In review' },
  { status: 'proposed', label: 'Proposed' },
  { status: 'approved', label: 'Approved' },
  { status: 'done', label: 'Done' },
]
const ORDER: TodoStatus[] = COLUMNS.map((c) => c.status)

const visibleTodos = computed(() =>
  filterProjectId.value
    ? teamStore.todos.filter((t) => t.projectId === filterProjectId.value)
    : teamStore.todos,
)

const byStatus = computed(() => {
  const map = new Map<TodoStatus, Todo[]>()
  for (const col of COLUMNS) map.set(col.status, [])
  for (const todo of visibleTodos.value) map.get(todo.status)?.push(todo)
  return map
})

function projectName(projectId: string): string {
  return projectStore.projects.find((p) => p.id === projectId)?.name ?? '?'
}

function proposer(todo: Todo) {
  return todo.proposal?.personaId ? teamStore.personasById.get(todo.proposal.personaId) ?? null : null
}

function move(todo: Todo, direction: -1 | 1) {
  const index = ORDER.indexOf(todo.status) + direction
  if (index < 0 || index >= ORDER.length) return
  teamStore.setTodoStatus(todo.id, ORDER[index])
}

const addProjectId = computed(() => filterProjectId.value || newProjectId.value)

async function add() {
  if (!newText.value.trim() || !addProjectId.value) return
  await teamStore.addTodo(addProjectId.value, newText.value.trim())
  newText.value = ''
}

const running = computed(
  () => !!filterProjectId.value && teamStore.standupRunning.has(filterProjectId.value),
)

async function openSession(sessionId: string) {
  await sessionStore.fetchSessions()
  await sessionStore.selectSession(sessionId)
  router.push('/')
}

function canBuild(todo: Todo): boolean {
  return !!todo.proposal && !todo.workSessionId && (todo.status === 'proposed' || todo.status === 'approved')
}

async function build(todo: Todo) {
  runMessage.value = null
  const result = await teamStore.implementTodo(todo.id)
  if (!result) return
  if (result.sessionId) {
    await openSession(result.sessionId)
  } else {
    runMessage.value = result.reason ?? 'Could not start the implementation'
  }
}

async function runStandup() {
  if (!filterProjectId.value) return
  runMessage.value = null
  const result = await teamStore.runStandup(filterProjectId.value)
  if (!result) return
  if (result.ran && result.sessionId) {
    await sessionStore.fetchSessions()
    await sessionStore.selectSession(result.sessionId)
    router.push('/')
  } else {
    runMessage.value = result.reason ?? 'Standup skipped'
  }
}
</script>

<template>
  <div class="flex h-full flex-col">
    <!-- Header bar -->
    <div class="flex shrink-0 flex-wrap items-center gap-2 border-b border-gray-200 px-3 py-2 dark:border-gray-800">
      <button
        class="rounded-lg p-1.5 text-gray-600 hover:bg-gray-100 md:hidden dark:text-gray-400 dark:hover:bg-gray-800"
        @click="ui.toggleSidebar()"
      >
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" class="h-5 w-5">
          <path fill-rule="evenodd" d="M2 4.75A.75.75 0 0 1 2.75 4h14.5a.75.75 0 0 1 0 1.5H2.75A.75.75 0 0 1 2 4.75Zm0 10.5a.75.75 0 0 1 .75-.75h14.5a.75.75 0 0 1 0 1.5H2.75a.75.75 0 0 1-.75-.75ZM2 10a.75.75 0 0 1 .75-.75h7.5a.75.75 0 0 1 0 1.5h-7.5A.75.75 0 0 1 2 10Z" clip-rule="evenodd" />
        </svg>
      </button>
      <span class="text-sm font-medium text-gray-700 dark:text-gray-300">Ideas board</span>
      <select
        v-model="filterProjectId"
        class="rounded-lg border border-gray-200 bg-white px-2 py-1 text-xs text-gray-700 focus:border-blue-500 focus:outline-none dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300"
      >
        <option value="">All projects</option>
        <option v-for="p in projectStore.projects" :key="p.id" :value="p.id">{{ p.name }}</option>
      </select>
      <div class="flex-1" />
      <button
        v-if="filterProjectId"
        :disabled="running || teamStore.personas.length === 0"
        class="rounded-lg bg-purple-600 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-purple-700 disabled:opacity-50"
        @click="runStandup"
      >{{ running ? 'Team is working…' : 'Run standup' }}</button>
    </div>

    <!-- Quick add -->
    <div class="flex shrink-0 items-center gap-1.5 border-b border-gray-200 px-3 py-2 dark:border-gray-800">
      <select
        v-if="!filterProjectId"
        v-model="newProjectId"
        class="shrink-0 rounded-lg border border-gray-200 bg-white px-2 py-1.5 text-xs text-gray-700 focus:border-blue-500 focus:outline-none dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300"
      >
        <option v-for="p in projectStore.projects" :key="p.id" :value="p.id">{{ p.name }}</option>
      </select>
      <input
        v-model="newText"
        type="text"
        placeholder="Jot an idea — it lands in Inbox…"
        class="min-w-0 flex-1 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-sm text-gray-900 placeholder:text-gray-400 focus:border-blue-500 focus:outline-none dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100"
        @keydown.enter="add"
      />
      <button
        :disabled="!newText.trim() || !addProjectId"
        class="shrink-0 rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-blue-700 disabled:opacity-50"
        @click="add"
      >Add</button>
    </div>

    <div v-if="teamStore.error || runMessage" class="shrink-0 px-3 py-2">
      <div
        class="rounded-lg px-3 py-2 text-xs"
        :class="teamStore.error
          ? 'bg-red-50 text-red-700 dark:bg-red-900/20 dark:text-red-400'
          : 'bg-amber-50 text-amber-700 dark:bg-amber-900/20 dark:text-amber-400'"
      >{{ teamStore.error || runMessage }}</div>
    </div>

    <!-- Board -->
    <div class="min-h-0 flex-1 overflow-x-auto overflow-y-hidden">
      <div class="flex h-full gap-3 px-3 py-3">
        <div
          v-for="col in COLUMNS"
          :key="col.status"
          class="flex h-full w-60 shrink-0 flex-col rounded-xl bg-gray-50 dark:bg-gray-900/60"
        >
          <div class="flex items-center gap-2 px-3 py-2.5">
            <span class="text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">{{ col.label }}</span>
            <span class="rounded-full bg-gray-200 px-1.5 text-[10px] font-medium text-gray-600 dark:bg-gray-700 dark:text-gray-400">
              {{ byStatus.get(col.status)?.length ?? 0 }}
            </span>
          </div>
          <div class="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-2 pb-3">
            <div
              v-for="todo in byStatus.get(col.status)"
              :key="todo.id"
              class="group rounded-lg border border-gray-200 bg-white p-2.5 dark:border-gray-700 dark:bg-gray-800"
            >
              <div v-if="!filterProjectId" class="mb-1 text-[10px] font-medium text-purple-600 dark:text-purple-400">
                {{ projectName(todo.projectId) }}
              </div>
              <p class="text-xs text-gray-800 dark:text-gray-200">{{ todo.text }}</p>
              <p v-if="todo.notes" class="mt-1 line-clamp-2 text-[11px] text-gray-400 dark:text-gray-500">{{ todo.notes }}</p>
              <div
                v-if="todo.proposal"
                class="mt-1.5 flex items-center gap-1.5 rounded bg-blue-50 px-1.5 py-1 dark:bg-blue-900/20"
              >
                <PersonaAvatar :persona="proposer(todo)" size="sm" />
                <span class="line-clamp-2 text-[10px] text-blue-700 dark:text-blue-300">{{ todo.proposal.summary }}</span>
              </div>
              <!-- Build state / trigger -->
              <button
                v-if="todo.workSessionId"
                class="mt-1.5 flex w-full items-center justify-center gap-1.5 rounded px-1.5 py-1 text-[10px] font-medium transition"
                :class="todo.status === 'done'
                  ? 'bg-gray-100 text-gray-500 hover:bg-gray-200 dark:bg-gray-700/60 dark:text-gray-400 dark:hover:bg-gray-700'
                  : 'bg-green-50 text-green-700 hover:bg-green-100 dark:bg-green-900/20 dark:text-green-400 dark:hover:bg-green-900/40'"
                @click="openSession(todo.workSessionId!)"
              >
                <span v-if="todo.status !== 'done'" class="relative flex h-1.5 w-1.5">
                  <span class="absolute inline-flex h-full w-full rounded-full bg-green-400 animate-breathe"></span>
                  <span class="relative inline-flex h-1.5 w-1.5 rounded-full bg-green-500"></span>
                </span>
                {{ todo.status === 'done' ? 'View build session' : 'Building — watch live' }}
              </button>
              <button
                v-else-if="canBuild(todo)"
                class="mt-1.5 w-full rounded bg-green-600 px-1.5 py-1 text-[10px] font-medium text-white transition hover:bg-green-700"
                :title="`${proposer(todo)?.name ?? 'The team'} implements it in a live work session`"
                @click="build(todo)"
              >{{ todo.status === 'proposed' ? 'Approve & build' : 'Build' }}</button>

              <div class="mt-1.5 flex items-center justify-between">
                <button
                  class="rounded p-1 text-gray-300 transition hover:bg-gray-100 hover:text-gray-600 disabled:invisible dark:text-gray-600 dark:hover:bg-gray-700 dark:hover:text-gray-300"
                  :disabled="todo.status === 'inbox'"
                  title="Move back"
                  @click="move(todo, -1)"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" class="h-3.5 w-3.5">
                    <path fill-rule="evenodd" d="M9.78 4.22a.75.75 0 0 1 0 1.06L7.06 8l2.72 2.72a.75.75 0 1 1-1.06 1.06L5.47 8.53a.75.75 0 0 1 0-1.06l3.25-3.25a.75.75 0 0 1 1.06 0Z" clip-rule="evenodd" />
                  </svg>
                </button>
                <button
                  class="rounded p-1 text-gray-300 opacity-100 transition hover:bg-red-50 hover:text-red-600 md:opacity-0 md:group-hover:opacity-100 dark:text-gray-600 dark:hover:bg-red-900/20 dark:hover:text-red-400"
                  title="Delete"
                  @click="teamStore.deleteTodo(todo.id)"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" class="h-3 w-3">
                    <path fill-rule="evenodd" d="M5 3.25V4H2.75a.75.75 0 0 0 0 1.5h.3l.815 8.15A1.5 1.5 0 0 0 5.357 15h5.285a1.5 1.5 0 0 0 1.493-1.35l.815-8.15h.3a.75.75 0 0 0 0-1.5H11v-.75A2.25 2.25 0 0 0 8.75 1h-1.5A2.25 2.25 0 0 0 5 3.25Zm2.25-.75a.75.75 0 0 0-.75.75V4h3v-.75a.75.75 0 0 0-.75-.75h-1.5Z" clip-rule="evenodd" />
                  </svg>
                </button>
                <button
                  class="rounded p-1 text-gray-400 transition hover:bg-gray-100 hover:text-gray-700 disabled:invisible dark:text-gray-500 dark:hover:bg-gray-700 dark:hover:text-gray-200"
                  :disabled="todo.status === 'done'"
                  :title="todo.status === 'proposed' ? 'Approve' : 'Move forward'"
                  @click="move(todo, 1)"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" class="h-3.5 w-3.5">
                    <path fill-rule="evenodd" d="M6.22 4.22a.75.75 0 0 1 1.06 0l3.25 3.25a.75.75 0 0 1 0 1.06l-3.25 3.25a.75.75 0 0 1-1.06-1.06L8.94 8 6.22 5.28a.75.75 0 0 1 0-1.06Z" clip-rule="evenodd" />
                  </svg>
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
