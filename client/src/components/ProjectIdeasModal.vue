<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useTeamStore } from '@/stores/team'
import { useProjectsStore } from '@/stores/projects'
import { useSessionsStore } from '@/stores/sessions'
import PersonaAvatar from '@/components/PersonaAvatar.vue'
import * as api from '@/api/client'
import type { Todo, TodoStatus, StandupState } from '@/api/client'

const props = defineProps<{ projectId: string | null }>()
const emit = defineEmits<{ close: [] }>()

const teamStore = useTeamStore()
const projectStore = useProjectsStore()
const sessionStore = useSessionsStore()
const router = useRouter()

const newText = ref('')
const newNotes = ref('')
const showNotes = ref(false)
const expandedId = ref<string | null>(null)
const runMessage = ref<string | null>(null)
const standupState = ref<StandupState | null>(null)

const project = computed(() => projectStore.projects.find((p) => p.id === props.projectId) ?? null)
const todos = computed(() => (props.projectId ? teamStore.todosForProject(props.projectId) : []))
const running = computed(() => (props.projectId ? teamStore.standupRunning.has(props.projectId) : false))

/** Relative time like "2 hours ago" / "3 days ago" — precise enough for a standup log. */
function relativeTime(ts: number): string {
  const secs = Math.round((Date.now() - ts) / 1000)
  if (secs < 60) return 'just now'
  const mins = Math.round(secs / 60)
  if (mins < 60) return `${mins} min${mins === 1 ? '' : 's'} ago`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`
  const days = Math.round(hours / 24)
  return `${days} day${days === 1 ? '' : 's'} ago`
}

const lastRunLabel = computed(() =>
  standupState.value?.lastRunAt ? relativeTime(standupState.value.lastRunAt) : null,
)

async function loadStandupState(id: string) {
  try {
    standupState.value = await api.fetchStandupState(id)
  } catch {
    standupState.value = null // Non-fatal — the panel works without it
  }
}

function openTeamThread() {
  const sessionId = standupState.value?.teamSessionId
  if (!sessionId) return
  sessionStore.selectSession(sessionId)
  router.push('/')
  emit('close')
}

watch(
  () => props.projectId,
  (id) => {
    runMessage.value = null
    standupState.value = null
    if (id) {
      teamStore.fetchTodos()
      teamStore.fetchActions()
      loadStandupState(id)
    }
  },
  { immediate: true },
)

const STATUS_LABELS: Record<TodoStatus, string> = {
  inbox: 'Inbox',
  under_review: 'In review',
  proposed: 'Proposed',
  approved: 'Approved',
  done: 'Done',
}

const STATUS_STYLES: Record<TodoStatus, string> = {
  inbox: 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400',
  under_review: 'bg-amber-50 text-amber-700 dark:bg-amber-900/20 dark:text-amber-400',
  proposed: 'bg-blue-50 text-blue-700 dark:bg-blue-900/20 dark:text-blue-400',
  approved: 'bg-green-50 text-green-700 dark:bg-green-900/20 dark:text-green-400',
  done: 'bg-gray-100 text-gray-400 dark:bg-gray-800 dark:text-gray-500',
}

async function add() {
  if (!props.projectId || !newText.value.trim()) return
  await teamStore.addTodo(props.projectId, newText.value.trim(), newNotes.value.trim() || undefined)
  newText.value = ''
  newNotes.value = ''
  showNotes.value = false
}

function proposer(todo: Todo) {
  return todo.proposal?.personaId ? teamStore.personasById.get(todo.proposal.personaId) ?? null : null
}

function taker(personaId: string) {
  return teamStore.personasById.get(personaId) ?? null
}

async function runNow() {
  if (!props.projectId) return
  runMessage.value = null
  const result = await teamStore.runStandup(props.projectId)
  if (!result) return
  if (result.ran && result.sessionId) {
    // Jump straight into the team thread to watch it land.
    await sessionStore.fetchSessions()
    await sessionStore.selectSession(result.sessionId)
    router.push('/')
    emit('close')
  } else {
    runMessage.value = result.reason ?? 'Standup skipped'
    // A skipped run still updated nothing, but refresh so a concurrent
    // scheduled run's timestamp is reflected.
    void loadStandupState(props.projectId)
  }
}

async function openSession(sessionId: string) {
  await sessionStore.fetchSessions()
  await sessionStore.selectSession(sessionId)
  router.push('/')
  emit('close')
}

const refiningId = ref<string | null>(null)
const refineFeedback = ref('')
const refineSending = ref(false)

function startRefine(todoId: string) {
  refiningId.value = refiningId.value === todoId ? null : todoId
  refineFeedback.value = ''
}

async function sendRefine(todoId: string) {
  const feedback = refineFeedback.value.trim()
  if (!feedback) return
  refineSending.value = true
  const result = await teamStore.refineTodo(todoId, feedback)
  refineSending.value = false
  if (!result) return
  if (result.ran && result.sessionId) {
    refiningId.value = null
    // Watch the team revise it live; the updated proposal lands via events.
    await openSession(result.sessionId)
  } else {
    runMessage.value = result.reason ?? 'Could not send the feedback'
  }
}

/** Team-raised actions linked to this idea (its prerequisites). */
function prereqs(todo: Todo) {
  return teamStore.actions.filter((a) => a.todoId === todo.id)
}
function openPrereqCount(todo: Todo): number {
  return prereqs(todo).filter((a) => a.status === 'open').length
}

// Soft gate: building with open prerequisites needs a second click.
const confirmBuildId = ref<string | null>(null)

async function build(todoId: string) {
  runMessage.value = null
  const todo = todos.value.find((t) => t.id === todoId)
  if (todo && openPrereqCount(todo) > 0 && confirmBuildId.value !== todoId) {
    confirmBuildId.value = todoId
    return
  }
  confirmBuildId.value = null
  const result = await teamStore.implementTodo(todoId)
  if (!result) return
  if (result.sessionId) {
    // Started (or already building) — jump into the work session to watch.
    await openSession(result.sessionId)
  } else {
    runMessage.value = result.reason ?? 'Could not start the implementation'
  }
}

function close() {
  teamStore.clearError()
  emit('close')
}
</script>

<template>
  <Teleport to="body">
    <div
      v-if="projectId && project"
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      @click.self="close"
    >
      <div class="flex max-h-[85vh] w-full max-w-md flex-col rounded-xl bg-white shadow-xl dark:bg-gray-900">
        <!-- Header -->
        <div class="flex items-center justify-between border-b border-gray-200 px-5 py-4 dark:border-gray-800">
          <div class="min-w-0">
            <h2 class="text-base font-semibold text-gray-900 dark:text-gray-100">Ideas</h2>
            <p class="truncate text-xs text-gray-400 dark:text-gray-500">
              <span>{{ project.name }}</span>
              <template v-if="lastRunLabel">
                <span class="mx-1">·</span>
                <span>Last standup {{ lastRunLabel }}</span>
              </template>
              <template v-if="standupState?.teamSessionId">
                <span class="mx-1">·</span>
                <button class="text-blue-600 hover:underline dark:text-blue-400" @click="openTeamThread">
                  View thread
                </button>
              </template>
            </p>
          </div>
          <div class="flex items-center gap-2">
            <button
              :disabled="running || teamStore.personas.length === 0"
              class="rounded-lg bg-purple-600 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-purple-700 disabled:opacity-50"
              :title="teamStore.personas.length === 0 ? 'Add personas in Team settings first' : 'Run the standup now'"
              @click="runNow"
            >{{ running ? 'Team is working…' : 'Run standup' }}</button>
            <button
              class="rounded-lg p-1 text-gray-400 transition hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-800 dark:hover:text-gray-300"
              @click="close"
            >
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" class="h-5 w-5">
                <path d="M6.28 5.22a.75.75 0 0 0-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 1 0 1.06 1.06L10 11.06l3.72 3.72a.75.75 0 1 0 1.06-1.06L11.06 10l3.72-3.72a.75.75 0 0 0-1.06-1.06L10 8.94 6.28 5.22Z" />
              </svg>
            </button>
          </div>
        </div>

        <!-- Body -->
        <div class="flex flex-col gap-3 overflow-y-auto px-5 py-4">
          <!-- Quick capture -->
          <div class="flex flex-col gap-1.5">
            <div class="flex gap-1.5">
              <input
                v-model="newText"
                type="text"
                placeholder="Jot an idea or todo…"
                class="min-w-0 flex-1 rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-900 placeholder:text-gray-400 focus:border-blue-500 focus:outline-none dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100"
                @keydown.enter="add"
              />
              <button
                :disabled="!newText.trim()"
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
              placeholder="Optional context for the team…"
              class="rounded-lg border border-gray-200 bg-white px-3 py-2 text-xs text-gray-900 placeholder:text-gray-400 focus:border-blue-500 focus:outline-none dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100"
            />
          </div>

          <div v-if="teamStore.error" class="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700 dark:bg-red-900/20 dark:text-red-400">
            {{ teamStore.error }}
          </div>
          <div v-if="runMessage" class="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700 dark:bg-amber-900/20 dark:text-amber-400">
            {{ runMessage }}
          </div>

          <div v-if="todos.length === 0" class="py-4 text-center text-xs text-gray-400 dark:text-gray-500">
            Nothing here yet. Ideas you add are reviewed by your team at the next standup.
          </div>

          <!-- Todo list -->
          <div
            v-for="todo in todos"
            :key="todo.id"
            class="rounded-lg border border-gray-200 dark:border-gray-700"
          >
            <div
              class="flex cursor-pointer items-start gap-2 px-3 py-2"
              @click="expandedId = expandedId === todo.id ? null : todo.id"
            >
              <div class="min-w-0 flex-1">
                <p
                  class="text-sm"
                  :class="todo.status === 'done'
                    ? 'text-gray-400 line-through dark:text-gray-500'
                    : 'text-gray-800 dark:text-gray-200'"
                >{{ todo.text }}</p>
                <p v-if="todo.notes" class="mt-0.5 truncate text-xs text-gray-400 dark:text-gray-500">{{ todo.notes }}</p>
              </div>
              <span
                class="shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium"
                :class="STATUS_STYLES[todo.status]"
              >{{ STATUS_LABELS[todo.status] }}</span>
            </div>

            <!-- Proposal + actions (expanded) -->
            <div v-if="expandedId === todo.id" class="border-t border-gray-200 px-3 py-2 dark:border-gray-700">
              <!-- Independent reviewer takes -->
              <div v-if="todo.takes?.length" class="mb-2 flex flex-col gap-1.5">
                <div
                  v-for="take in todo.takes"
                  :key="take.personaId"
                  class="flex items-start gap-2 rounded-lg bg-gray-50 p-2 dark:bg-gray-800/50"
                >
                  <PersonaAvatar :persona="taker(take.personaId)" size="sm" class="mt-0.5" />
                  <div class="min-w-0 flex-1">
                    <p class="text-xs text-gray-700 dark:text-gray-300">
                      <span class="font-medium">{{ taker(take.personaId)?.name ?? 'Reviewer' }}</span>
                      — {{ take.take }}
                    </p>
                    <ul v-if="take.concerns?.length" class="mt-0.5 list-inside list-disc text-[11px] text-amber-700 dark:text-amber-400">
                      <li v-for="(concern, i) in take.concerns" :key="i">{{ concern }}</li>
                    </ul>
                    <p v-if="take.effort" class="mt-0.5 text-[10px] text-gray-400 dark:text-gray-500">Effort: {{ take.effort }}</p>
                  </div>
                </div>
              </div>

              <div v-if="todo.proposal" class="mb-2 rounded-lg bg-gray-50 p-2.5 dark:bg-gray-800/50">
                <div class="flex items-center gap-1.5">
                  <PersonaAvatar :persona="proposer(todo)" size="sm" />
                  <span class="text-xs font-medium text-gray-700 dark:text-gray-300">
                    {{ proposer(todo)?.name ?? 'Team' }} proposes: {{ todo.proposal.summary }}
                  </span>
                </div>
                <p class="mt-1.5 whitespace-pre-wrap text-xs text-gray-600 dark:text-gray-400">{{ todo.proposal.approach }}</p>
                <p v-if="todo.proposal.effort" class="mt-1 text-xs text-gray-400 dark:text-gray-500">Effort: {{ todo.proposal.effort }}</p>
                <details v-if="todo.proposal.brief" class="mt-1.5">
                  <summary class="cursor-pointer text-xs text-blue-600 dark:text-blue-400">Implementation brief (what the builder runs on)</summary>
                  <pre class="mt-1 whitespace-pre-wrap rounded bg-white p-2 font-mono text-[11px] text-gray-600 dark:bg-gray-900 dark:text-gray-400">{{ todo.proposal.brief }}</pre>
                </details>
              </div>
              <!-- Prerequisites: things to do before building this idea -->
              <div v-if="prereqs(todo).length" class="mb-2 flex flex-col gap-1">
                <span class="text-[10px] font-semibold uppercase tracking-wide text-amber-600 dark:text-amber-500">
                  Before building{{ openPrereqCount(todo) ? ` · ${openPrereqCount(todo)} open` : ' · all done' }}
                </span>
                <div
                  v-for="item in prereqs(todo)"
                  :key="item.id"
                  class="flex items-start gap-2 rounded-lg border border-amber-200/60 px-2.5 py-1.5 dark:border-amber-900/40"
                >
                  <input
                    type="checkbox"
                    :checked="item.status === 'done'"
                    class="mt-0.5 rounded"
                    @change="teamStore.setActionStatus(item.id, item.status === 'done' ? 'open' : 'done')"
                  />
                  <div class="min-w-0 flex-1">
                    <p
                      class="text-xs"
                      :class="item.status === 'done'
                        ? 'text-gray-400 line-through dark:text-gray-500'
                        : 'text-gray-700 dark:text-gray-300'"
                    >{{ item.text }}</p>
                    <ol v-if="item.steps?.length && item.status !== 'done'" class="mt-1 flex flex-col gap-0.5">
                      <li v-for="(step, i) in item.steps" :key="i" class="flex items-start gap-1.5 text-[11px] text-gray-500 dark:text-gray-400">
                        <span class="mt-px flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full bg-gray-100 text-[8px] font-semibold text-gray-500 dark:bg-gray-800 dark:text-gray-400">{{ i + 1 }}</span>
                        <span class="whitespace-pre-wrap">{{ step }}</span>
                      </li>
                    </ol>
                  </div>
                </div>
              </div>

              <div class="flex flex-wrap gap-1.5">
                <button
                  v-if="todo.proposal && !todo.workSessionId && (todo.status === 'proposed' || todo.status === 'approved')"
                  class="rounded px-2.5 py-1 text-xs font-medium text-white transition"
                  :class="confirmBuildId === todo.id ? 'bg-amber-600 hover:bg-amber-700' : 'bg-green-600 hover:bg-green-700'"
                  :title="`${proposer(todo)?.name ?? 'The team'} implements it in a live work session`"
                  @click="build(todo.id)"
                >{{ confirmBuildId === todo.id
                  ? `Build anyway? (${openPrereqCount(todo)} open)`
                  : (todo.status === 'proposed' ? 'Approve & build' : 'Build') }}</button>
                <button
                  v-if="todo.workSessionId"
                  class="rounded bg-blue-600 px-2.5 py-1 text-xs font-medium text-white transition hover:bg-blue-700"
                  @click="openSession(todo.workSessionId!)"
                >{{ todo.status === 'done' ? 'View build session' : 'Building — watch live' }}</button>
                <button
                  v-if="todo.status === 'proposed'"
                  class="rounded bg-gray-200 px-2.5 py-1 text-xs font-medium text-gray-700 transition hover:bg-gray-300 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600"
                  title="Approve without starting the build"
                  @click="teamStore.setTodoStatus(todo.id, 'approved')"
                >Approve only</button>
                <button
                  v-if="todo.proposal && !todo.workSessionId && todo.status !== 'done'"
                  class="rounded bg-purple-100 px-2.5 py-1 text-xs font-medium text-purple-700 transition hover:bg-purple-200 dark:bg-purple-900/30 dark:text-purple-300 dark:hover:bg-purple-900/50"
                  title="Send feedback — the team revises the proposal and brief"
                  @click="startRefine(todo.id)"
                >Request changes</button>
                <button
                  v-if="todo.status !== 'done'"
                  class="rounded bg-gray-200 px-2.5 py-1 text-xs font-medium text-gray-700 transition hover:bg-gray-300 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600"
                  @click="teamStore.setTodoStatus(todo.id, 'done')"
                >Mark done</button>
                <button
                  v-if="todo.status === 'done'"
                  class="rounded bg-gray-200 px-2.5 py-1 text-xs font-medium text-gray-700 transition hover:bg-gray-300 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600"
                  @click="teamStore.setTodoStatus(todo.id, 'inbox')"
                >Reopen</button>
                <button
                  class="rounded px-2.5 py-1 text-xs font-medium text-red-600 transition hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-900/20"
                  @click="teamStore.deleteTodo(todo.id)"
                >Delete</button>
              </div>

              <!-- Refine: feedback that round-trips through the team -->
              <div v-if="refiningId === todo.id" class="mt-2 flex flex-col gap-1.5">
                <textarea
                  v-model="refineFeedback"
                  rows="2"
                  placeholder="What should change? (e.g. cap at 10s, don't touch auth, reference docs/pos.md)"
                  class="rounded-lg border border-purple-200 bg-white px-3 py-2 text-xs text-gray-900 placeholder:text-gray-400 focus:border-purple-500 focus:outline-none dark:border-purple-800 dark:bg-gray-800 dark:text-gray-100"
                />
                <div class="flex gap-1.5">
                  <button
                    :disabled="refineSending || !refineFeedback.trim()"
                    class="rounded bg-purple-600 px-2.5 py-1 text-xs font-medium text-white transition hover:bg-purple-700 disabled:opacity-50"
                    @click="sendRefine(todo.id)"
                  >{{ refineSending ? 'Sending…' : 'Send to team' }}</button>
                  <button
                    class="rounded px-2.5 py-1 text-xs text-gray-500 hover:text-gray-700 dark:hover:text-gray-300"
                    @click="refiningId = null"
                  >Cancel</button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </Teleport>
</template>
