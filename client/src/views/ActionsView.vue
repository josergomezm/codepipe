<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useTeamStore } from '@/stores/team'
import { useProjectsStore } from '@/stores/projects'
import { useUiStore } from '@/stores/ui'
import ActionItemCard from '@/components/ActionItemCard.vue'
import ActionAddForm from '@/components/ActionAddForm.vue'
import * as api from '@/api/client'
import type { ActionItem } from '@/api/client'

const teamStore = useTeamStore()
const projectStore = useProjectsStore()
const ui = useUiStore()

const showAdd = ref(false)
const showDone = ref(false)
const showSnoozed = ref(false)
/** Projects whose nice-to-know items are expanded. */
const expandedExtras = ref(new Set<string>())
/** '' = all projects */
const filterProjectId = ref('')

onMounted(() => {
  teamStore.fetchActions()
  teamStore.fetchPersonas()
  teamStore.fetchTodos()
})

const visibleActions = computed(() =>
  filterProjectId.value
    ? teamStore.actions.filter((a) => a.projectId === filterProjectId.value)
    : teamStore.actions,
)

/** Decisions first (usually one tap), then oldest first. */
function byUrgency(a: ActionItem, b: ActionItem): number {
  const kind = (x: ActionItem) => (x.kind === 'decision' ? 0 : 1)
  return kind(a) - kind(b) || a.createdAt - b.createdAt
}

interface ProjectGroup {
  projectId: string
  blocking: ActionItem[]
  extras: ActionItem[]
  /** Closed during this visit, or all closed ones when "show completed" is on. */
  closed: ActionItem[]
}

const groups = computed<ProjectGroup[]>(() => {
  const map = new Map<string, ProjectGroup>()
  const group = (projectId: string) => {
    let g = map.get(projectId)
    if (!g) {
      g = { projectId, blocking: [], extras: [], closed: [] }
      map.set(projectId, g)
    }
    return g
  }
  for (const item of visibleActions.value) {
    if (teamStore.isWaiting(item)) {
      group(item.projectId)[item.blocking === false ? 'extras' : 'blocking'].push(item)
    } else if (item.status !== 'open' && (showDone.value || teamStore.recentlyClosedIds.has(item.id))) {
      group(item.projectId).closed.push(item)
    }
  }
  for (const g of map.values()) {
    g.blocking.sort(byUrgency)
    g.extras.sort(byUrgency)
    g.closed.sort((a, b) => b.updatedAt - a.updatedAt)
  }
  // Projects with the most blocking items first.
  return [...map.values()].sort((a, b) => b.blocking.length - a.blocking.length)
})

const snoozedItems = computed(() =>
  visibleActions.value.filter((a) => a.status === 'open' && !teamStore.isWaiting(a)),
)
const closedCount = computed(() => visibleActions.value.filter((a) => a.status !== 'open').length)
/** Open tasks with a deadline in view — what "Export to calendar" would include. */
const exportableCount = computed(
  () => visibleActions.value.filter((a) => a.status === 'open' && a.dueDate && a.kind !== 'decision').length,
)
const waitingCount = computed(() => visibleActions.value.filter((a) => teamStore.isWaiting(a)).length)

function projectName(projectId: string): string {
  return projectStore.projects.find((p) => p.id === projectId)?.name ?? 'Removed project'
}

function toggleExtras(projectId: string) {
  const next = new Set(expandedExtras.value)
  if (next.has(projectId)) next.delete(projectId)
  else next.add(projectId)
  expandedExtras.value = next
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
        <span class="hidden text-xs text-gray-400 sm:block dark:text-gray-500">
          Things only you can do — answers reach your team at the next standup
        </span>
      </div>
      <div class="flex-1" />
      <a
        v-if="exportableCount > 0"
        :href="api.actionItemsCalendarUrl(filterProjectId || undefined)"
        download="codepipe-tasks.ics"
        class="shrink-0 rounded-lg px-2 py-1 text-xs text-gray-500 hover:bg-gray-100 hover:text-gray-700 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-gray-200"
        :title="`Download ${exportableCount} task(s) with due dates as an .ics file — import it in Google Calendar (Settings → Import). Re-importing updates events instead of duplicating them.`"
      >Export to calendar</a>
      <button
        class="shrink-0 rounded-lg px-2 py-1 text-xs text-gray-500 hover:bg-gray-100 hover:text-gray-700 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-gray-200"
        @click="showAdd = !showAdd"
      >+ Add</button>
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
      <div class="mx-auto flex max-w-2xl flex-col gap-5 px-4 py-6">
        <!-- Manual add (most items come from the team, so it stays tucked away) -->
        <div v-if="showAdd" class="rounded-lg border border-dashed border-gray-300 p-3 dark:border-gray-700">
          <ActionAddForm :project-id="filterProjectId || undefined" autofocus @added="showAdd = false" />
        </div>

        <div v-if="teamStore.error" class="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700 dark:bg-red-900/20 dark:text-red-400">
          {{ teamStore.error }}
        </div>

        <div v-if="groups.length === 0" class="py-10 text-center text-sm text-gray-400 dark:text-gray-500">
          <template v-if="waitingCount === 0 && snoozedItems.length === 0">
            Nothing waiting on you. Your team raises items here when only you can unblock something — secrets, accounts, decisions.
          </template>
          <template v-else>Nothing to show here right now.</template>
        </div>

        <!-- Grouped by project -->
        <div v-for="g in groups" :key="g.projectId" class="flex flex-col gap-1.5">
          <h3 class="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500">
            {{ projectName(g.projectId) }}
            <span
              v-if="g.blocking.length"
              class="rounded-full bg-amber-100 px-1.5 text-[10px] font-medium normal-case tracking-normal text-amber-700 dark:bg-amber-900/30 dark:text-amber-400"
            >{{ g.blocking.length }} waiting on you</span>
          </h3>

          <ActionItemCard v-for="item in g.blocking" :key="item.id" :item="item" />

          <template v-if="g.extras.length">
            <button
              class="self-start text-xs text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
              @click="toggleExtras(g.projectId)"
            >
              {{ expandedExtras.has(g.projectId) ? 'Hide' : 'Show' }} {{ g.extras.length }} nice-to-know
            </button>
            <template v-if="expandedExtras.has(g.projectId)">
              <ActionItemCard v-for="item in g.extras" :key="item.id" :item="item" />
            </template>
          </template>

          <ActionItemCard v-for="item in g.closed" :key="item.id" :item="item" />
        </div>

        <!-- Snoozed -->
        <div v-if="snoozedItems.length" class="flex flex-col gap-1.5">
          <button
            class="self-center text-xs text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
            @click="showSnoozed = !showSnoozed"
          >{{ showSnoozed ? 'Hide' : 'Show' }} {{ snoozedItems.length }} snoozed</button>
          <template v-if="showSnoozed">
            <ActionItemCard v-for="item in snoozedItems" :key="item.id" :item="item" />
          </template>
        </div>

        <button
          v-if="closedCount > 0"
          class="self-center text-xs text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
          @click="showDone = !showDone"
        >
          {{ showDone ? 'Hide' : 'Show' }} {{ closedCount }} completed
        </button>
      </div>
    </div>
  </div>
</template>
