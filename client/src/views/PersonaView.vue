<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useTeamStore } from '@/stores/team'
import { useProjectsStore } from '@/stores/projects'
import { useUiStore } from '@/stores/ui'
import PersonaAvatar from '@/components/PersonaAvatar.vue'
import type { ActionItem, Todo, TodoStatus } from '@/api/client'

const route = useRoute()
const router = useRouter()
const teamStore = useTeamStore()
const projectStore = useProjectsStore()
const ui = useUiStore()

const personaId = computed(() => String(route.params.personaId ?? ''))
const persona = computed(() => teamStore.personasById.get(personaId.value) ?? null)

onMounted(() => {
  teamStore.fetchPersonas()
  teamStore.fetchTodos()
  teamStore.fetchActions()
})

const STATUS_LABELS: Record<TodoStatus, string> = {
  inbox: 'Inbox',
  under_review: 'In review',
  proposed: 'Proposed',
  approved: 'Approved',
  done: 'Done',
}

// ----- Performance numbers -----

const myTakes = computed(() =>
  teamStore.todos.flatMap((todo) =>
    (todo.takes ?? [])
      .filter((t) => t.personaId === personaId.value)
      .map((take) => ({ todo, take })),
  ),
)
const myProposals = computed(() =>
  teamStore.todos.filter((t) => t.proposal?.personaId === personaId.value),
)
const myShipped = computed(() => myProposals.value.filter((t) => t.status === 'done'))
const myActions = computed(() => teamStore.actions.filter((a) => a.personaId === personaId.value))
const myOpenActions = computed(() => myActions.value.filter((a) => a.status === 'open'))

const stats = computed(() => [
  { label: 'Reviews', value: myTakes.value.length },
  { label: 'Proposals', value: myProposals.value.length },
  { label: 'Shipped', value: myShipped.value.length },
  { label: 'Open asks', value: myOpenActions.value.length },
])

// ----- Per-project breakdown, tied to ideas -----

interface IdeaContribution {
  todo: Todo
  take?: { take: string; concerns?: string[]; effort?: string; createdAt: number }
  proposed: boolean
  actions: ActionItem[]
}

interface ProjectGroup {
  projectId: string
  name: string
  ideas: IdeaContribution[]
  /** Actions raised in this project that aren't tied to a specific idea. */
  looseActions: ActionItem[]
}

const groups = computed<ProjectGroup[]>(() => {
  const byProject = new Map<string, ProjectGroup>()
  const group = (projectId: string): ProjectGroup => {
    let g = byProject.get(projectId)
    if (!g) {
      g = {
        projectId,
        name: projectStore.projects.find((p) => p.id === projectId)?.name ?? 'Removed project',
        ideas: [],
        looseActions: [],
      }
      byProject.set(projectId, g)
    }
    return g
  }

  const ideaEntry = (todo: Todo): IdeaContribution => {
    const g = group(todo.projectId)
    let entry = g.ideas.find((i) => i.todo.id === todo.id)
    if (!entry) {
      entry = { todo, proposed: false, actions: [] }
      g.ideas.push(entry)
    }
    return entry
  }

  for (const { todo, take } of myTakes.value) ideaEntry(todo).take = take
  for (const todo of myProposals.value) ideaEntry(todo).proposed = true
  for (const action of myActions.value) {
    const linkedTodo = action.todoId
      ? teamStore.todos.find((t) => t.id === action.todoId)
      : undefined
    if (linkedTodo) ideaEntry(linkedTodo).actions.push(action)
    else group(action.projectId).looseActions.push(action)
  }

  const result = [...byProject.values()]
  for (const g of result) {
    g.ideas.sort((a, b) => b.todo.updatedAt - a.todo.updatedAt)
  }
  return result.sort((a, b) => a.name.localeCompare(b.name))
})

function openBoard(projectId: string) {
  router.push({ path: '/board', query: { project: projectId } })
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
      <template v-if="persona">
        <PersonaAvatar :persona="persona" />
        <div class="min-w-0">
          <span class="block truncate text-sm font-medium text-gray-700 dark:text-gray-300">
            {{ persona.name }}
            <span v-if="persona.isLead" class="ml-1 rounded-full bg-purple-100 px-1.5 text-[10px] font-medium text-purple-700 dark:bg-purple-900/40 dark:text-purple-300">lead</span>
          </span>
          <span class="block truncate text-xs text-gray-400 dark:text-gray-500">
            {{ persona.role }} · {{ persona.provider }}<span v-if="persona.model"> ({{ persona.model }})</span>
          </span>
        </div>
      </template>
      <span v-else class="text-sm text-gray-500 dark:text-gray-400">Team member not found</span>
    </div>

    <!-- Content -->
    <div v-if="persona" class="min-h-0 flex-1 overflow-y-auto">
      <div class="mx-auto flex max-w-2xl flex-col gap-6 px-4 py-6">
        <!-- Performance numbers -->
        <div class="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <div v-for="stat in stats" :key="stat.label" class="rounded-xl bg-gray-50 px-4 py-3 dark:bg-gray-900/60">
            <div class="text-xs text-gray-400 dark:text-gray-500">{{ stat.label }}</div>
            <div class="text-2xl font-semibold text-gray-900 dark:text-gray-100">{{ stat.value }}</div>
          </div>
        </div>

        <div v-if="groups.length === 0" class="py-10 text-center text-sm text-gray-400 dark:text-gray-500">
          Nothing yet — contributions appear here after {{ persona.name }}'s first review.
        </div>

        <!-- Per-project, tied to ideas -->
        <div v-for="g in groups" :key="g.projectId" class="flex flex-col gap-1.5">
          <div class="flex items-baseline justify-between">
            <h3 class="text-xs font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500">{{ g.name }}</h3>
            <button
              class="text-xs text-blue-600 hover:underline dark:text-blue-400"
              @click="openBoard(g.projectId)"
            >open board</button>
          </div>

          <div
            v-for="idea in g.ideas"
            :key="idea.todo.id"
            class="rounded-lg border border-gray-200 px-3 py-2.5 dark:border-gray-700"
          >
            <!-- The idea and where it sits on the board -->
            <div class="flex items-start justify-between gap-2">
              <p class="min-w-0 flex-1 text-xs font-medium text-gray-800 dark:text-gray-200">{{ idea.todo.text }}</p>
              <button
                class="shrink-0 rounded-full bg-gray-100 px-2 py-0.5 text-[10px] font-medium text-gray-600 hover:bg-gray-200 dark:bg-gray-800 dark:text-gray-400 dark:hover:bg-gray-700"
                :title="`On the board in '${STATUS_LABELS[idea.todo.status]}'`"
                @click="openBoard(g.projectId)"
              >{{ STATUS_LABELS[idea.todo.status] }}</button>
            </div>

            <!-- Their review -->
            <div v-if="idea.take" class="mt-1.5">
              <p class="text-xs text-gray-600 dark:text-gray-400">
                <span class="text-[10px] font-semibold uppercase tracking-wide text-gray-400 dark:text-gray-500">Review</span>
                — {{ idea.take.take }}
              </p>
              <ul v-if="idea.take.concerns?.length" class="mt-0.5 list-inside list-disc text-[11px] text-amber-700 dark:text-amber-400">
                <li v-for="(concern, i) in idea.take.concerns" :key="i">{{ concern }}</li>
              </ul>
            </div>

            <!-- Their proposal -->
            <p v-if="idea.proposed && idea.todo.proposal" class="mt-1.5 text-xs text-gray-600 dark:text-gray-400">
              <span class="text-[10px] font-semibold uppercase tracking-wide text-blue-500 dark:text-blue-400">Proposal</span>
              — {{ idea.todo.proposal.summary }}
            </p>

            <!-- Prerequisites they raised for this idea -->
            <div v-for="action in idea.actions" :key="action.id" class="mt-1.5 flex items-start gap-1.5">
              <span
                class="mt-1 h-1.5 w-1.5 shrink-0 rounded-full"
                :class="action.status === 'open' ? 'bg-amber-500' : 'bg-gray-300 dark:bg-gray-600'"
              />
              <p
                class="text-xs"
                :class="action.status === 'done'
                  ? 'text-gray-400 line-through dark:text-gray-500'
                  : 'text-gray-600 dark:text-gray-400'"
              >
                <span class="text-[10px] font-semibold uppercase tracking-wide text-amber-600 dark:text-amber-500">{{ action.kind === 'decision' ? 'Asked you' : 'Needs you' }}</span>
                — {{ action.text }}
              </p>
            </div>
          </div>

          <!-- Project-level asks not tied to an idea -->
          <div
            v-for="action in g.looseActions"
            :key="action.id"
            class="flex items-start gap-2 rounded-lg border border-dashed border-gray-200 px-3 py-2 dark:border-gray-700"
          >
            <span
              class="mt-1 h-1.5 w-1.5 shrink-0 rounded-full"
              :class="action.status === 'open' ? 'bg-amber-500' : 'bg-gray-300 dark:bg-gray-600'"
            />
            <p
              class="min-w-0 flex-1 text-xs"
              :class="action.status === 'done'
                ? 'text-gray-400 line-through dark:text-gray-500'
                : 'text-gray-600 dark:text-gray-400'"
            >{{ action.text }}</p>
            <span
              v-if="action.kind"
              class="shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium"
              :class="action.kind === 'decision'
                ? 'bg-purple-50 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300'
                : 'bg-sky-50 text-sky-700 dark:bg-sky-900/30 dark:text-sky-300'"
            >{{ action.kind === 'decision' ? 'decision' : 'setup' }}</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
