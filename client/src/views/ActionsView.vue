<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useTeamStore } from '@/stores/team'
import { useProjectsStore } from '@/stores/projects'
import { useSessionsStore } from '@/stores/sessions'
import { useUiStore } from '@/stores/ui'
import PersonaAvatar from '@/components/PersonaAvatar.vue'
import * as api from '@/api/client'
import type { ActionItem } from '@/api/client'

const teamStore = useTeamStore()
const projectStore = useProjectsStore()
const sessionStore = useSessionsStore()
const ui = useUiStore()
const router = useRouter()
const replyError = ref<string | null>(null)

const newText = ref('')
const newNotes = ref('')
const showNotes = ref(false)
const newProjectId = ref('')
const showDone = ref(false)
/** '' = all projects */
const filterProjectId = ref('')

onMounted(() => {
  teamStore.fetchActions()
  teamStore.fetchPersonas()
  teamStore.fetchTodos()
  if (projectStore.projects.length > 0 && !newProjectId.value) {
    newProjectId.value = projectStore.projects[0].id
  }
})

const visibleActions = computed(() =>
  filterProjectId.value
    ? teamStore.actions.filter((a) => a.projectId === filterProjectId.value)
    : teamStore.actions,
)

const grouped = computed(() => {
  const groups = new Map<string, ActionItem[]>()
  for (const item of visibleActions.value) {
    if (item.status === 'done' && !showDone.value) continue
    const list = groups.get(item.projectId) ?? []
    list.push(item)
    groups.set(item.projectId, list)
  }
  return groups
})

const doneCount = computed(() => visibleActions.value.filter((a) => a.status === 'done').length)

/** The idea an item gates, when linked and still on the board. */
function linkedIdea(item: ActionItem) {
  return item.todoId ? teamStore.todos.find((t) => t.id === item.todoId) ?? null : null
}

function openBoard(projectId: string) {
  router.push({ path: '/board', query: { project: projectId } })
}

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

/** One-click answer for decisions that came with a recommendation. */
const GO_WITH_RECOMMENDATION = 'Go with your recommendation.'

/** In-progress answers, per decision item. */
const answers = ref<Record<string, string>>({})

/**
 * Answer a decision in place: closes the item and queues the answer (with
 * the options the team offered) for the next standup — no trip to the chat.
 */
async function answer(item: ActionItem, text: string | undefined) {
  const resolution = text?.trim()
  if (!resolution) return
  await teamStore.resolveAction(item.id, resolution)
  if (!teamStore.error) delete answers.value[item.id]
}

/** Prefix of the draft this view writes — recognizable so a stale one can be replaced. */
const DRAFT_PREFIX = 'About "'

/**
 * For decisions that need a back-and-forth: jump into the project's team
 * thread with a reply drafted about this item. The team closes the item
 * itself (resolved_actions) once the conversation settles it.
 */
async function discussInThread(item: ActionItem) {
  replyError.value = null
  try {
    const state = await api.fetchStandupState(item.projectId)
    if (!state.teamSessionId) {
      replyError.value = 'No team thread for this project yet — run a standup first.'
      return
    }
    // ChatInput isn't mounted on this view and loads the draft when it
    // mounts, so writing it here is always picked up. Only a draft you were
    // actually writing is kept; an unsent prefill from this button (perhaps
    // for a different item) is replaced.
    const draftKey = `codepipe:draft:${state.teamSessionId}`
    const existing = localStorage.getItem(draftKey)
    if (!existing?.trim() || existing.startsWith(DRAFT_PREFIX)) {
      localStorage.setItem(draftKey, `${DRAFT_PREFIX}${item.text}"\n\n`)
    }
    await sessionStore.fetchSessions()
    await sessionStore.selectSession(state.teamSessionId)
    router.push('/')
  } catch {
    replyError.value = 'Could not open the team thread.'
  }
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
          Things only you can do — completions reach your team at the next standup
        </span>
      </div>
      <div class="flex-1" />
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

        <div v-if="teamStore.error || replyError" class="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700 dark:bg-red-900/20 dark:text-red-400">
          {{ teamStore.error || replyError }}
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
              <div class="flex items-start gap-2">
                <p
                  class="min-w-0 flex-1 text-sm"
                  :class="item.status === 'done'
                    ? 'text-gray-400 line-through dark:text-gray-500'
                    : 'text-gray-800 dark:text-gray-200'"
                >{{ item.text }}</p>
                <span
                  v-if="item.kind"
                  class="shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium"
                  :class="item.kind === 'decision'
                    ? 'bg-purple-50 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300'
                    : 'bg-sky-50 text-sky-700 dark:bg-sky-900/30 dark:text-sky-300'"
                >{{ item.kind === 'decision' ? 'decision' : 'setup' }}</span>
              </div>
              <p v-if="item.notes" class="mt-1 whitespace-pre-wrap text-xs text-gray-400 dark:text-gray-500">{{ item.notes }}</p>

              <!-- The idea this item gates, with its board location -->
              <button
                v-if="linkedIdea(item)"
                class="mt-1 flex max-w-full items-center gap-1.5 rounded bg-purple-50 px-2 py-1 text-left hover:bg-purple-100 dark:bg-purple-900/20 dark:hover:bg-purple-900/40"
                :title="'Open the board'"
                @click="openBoard(item.projectId)"
              >
                <span class="shrink-0 text-[10px] font-semibold uppercase tracking-wide text-purple-500 dark:text-purple-400">for idea</span>
                <span class="min-w-0 truncate text-xs text-purple-800 dark:text-purple-300">{{ linkedIdea(item)!.text }}</span>
                <span class="shrink-0 rounded-full bg-white/70 px-1.5 text-[10px] font-medium text-purple-700 dark:bg-purple-950/60 dark:text-purple-300">
                  {{ linkedIdea(item)!.status === 'under_review' ? 'in review' : linkedIdea(item)!.status }}
                </span>
              </button>

              <!-- Step-by-step guide (task items) -->
              <ol
                v-if="item.steps?.length && item.status !== 'done'"
                class="mt-2 flex flex-col gap-1"
              >
                <li
                  v-for="(step, i) in item.steps"
                  :key="i"
                  class="flex items-start gap-2 text-xs text-gray-600 dark:text-gray-400"
                >
                  <span class="mt-px flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-gray-100 text-[9px] font-semibold text-gray-500 dark:bg-gray-800 dark:text-gray-400">{{ i + 1 }}</span>
                  <span class="whitespace-pre-wrap">{{ step }}</span>
                </li>
              </ol>

              <!-- Decisions resolve by answering, right here -->
              <div v-if="item.kind === 'decision' && item.status !== 'done'" class="mt-2 flex flex-col gap-1.5">
                <textarea
                  v-model="answers[item.id]"
                  rows="2"
                  placeholder="Your answer…"
                  class="rounded-lg border border-gray-200 bg-white px-3 py-2 text-xs text-gray-900 placeholder:text-gray-400 focus:border-purple-500 focus:outline-none dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100"
                  @keydown.enter.ctrl.prevent="answer(item, answers[item.id])"
                  @keydown.enter.meta.prevent="answer(item, answers[item.id])"
                />
                <div class="flex flex-wrap items-center gap-1.5">
                  <button
                    :disabled="!answers[item.id]?.trim()"
                    class="rounded bg-purple-600 px-2.5 py-1 text-xs font-medium text-white transition hover:bg-purple-700 disabled:opacity-50"
                    @click="answer(item, answers[item.id])"
                  >Answer</button>
                  <button
                    v-if="item.notes"
                    class="rounded border border-purple-200 px-2.5 py-1 text-xs font-medium text-purple-700 transition hover:bg-purple-50 dark:border-purple-800 dark:text-purple-300 dark:hover:bg-purple-900/30"
                    title="Answer with the team's recommendation (see the notes above)"
                    @click="answer(item, GO_WITH_RECOMMENDATION)"
                  >Go with recommendation</button>
                  <button
                    class="px-1 text-xs text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
                    @click="discussInThread(item)"
                  >Discuss in thread</button>
                </div>
              </div>

              <p v-if="item.resolution" class="mt-1 whitespace-pre-wrap text-xs text-purple-700 dark:text-purple-300">
                <span class="font-medium">You answered:</span> {{ item.resolution }}
              </p>

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
