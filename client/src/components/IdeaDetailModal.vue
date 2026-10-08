<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useTeamStore } from '@/stores/team'
import { useProjectsStore } from '@/stores/projects'
import { useSessionsStore } from '@/stores/sessions'
import PersonaAvatar from '@/components/PersonaAvatar.vue'
import ActionItemCard from '@/components/ActionItemCard.vue'
import type { TodoStatus } from '@/api/client'

const props = defineProps<{ todoId: string | null }>()
const emit = defineEmits<{ close: [] }>()

const teamStore = useTeamStore()
const projectStore = useProjectsStore()
const sessionStore = useSessionsStore()
const router = useRouter()

// Live from the store, so routing/events update the open modal in place.
const todo = computed(() => teamStore.todos.find((t) => t.id === props.todoId) ?? null)
const project = computed(() =>
  todo.value ? projectStore.projects.find((p) => p.id === todo.value!.projectId) ?? null : null,
)

const STATUS_LABELS: Record<TodoStatus, string> = {
  inbox: 'Inbox',
  under_review: 'In review',
  proposed: 'Proposed',
  approved: 'Approved',
  done: 'Done',
}
const ORDER: TodoStatus[] = ['inbox', 'under_review', 'proposed', 'approved', 'done']

const busyMessage = ref<string | null>(null)
const showRefine = ref(false)
const refineFeedback = ref('')
const refineSending = ref(false)
const confirmBuild = ref(false)

watch(
  () => props.todoId,
  () => {
    busyMessage.value = null
    showRefine.value = false
    refineFeedback.value = ''
    confirmBuild.value = false
  },
)

function taker(personaId: string) {
  return teamStore.personasById.get(personaId) ?? null
}
const proposer = computed(() =>
  todo.value?.proposal?.personaId
    ? teamStore.personasById.get(todo.value.proposal.personaId) ?? null
    : null,
)

const prereqs = computed(() =>
  todo.value ? teamStore.actions.filter((a) => a.todoId === todo.value!.id) : [],
)
const openPrereqCount = computed(() => prereqs.value.filter((a) => a.status === 'open').length)

const canBuild = computed(
  () =>
    !!todo.value?.proposal &&
    !todo.value.workSessionId &&
    (todo.value.status === 'proposed' || todo.value.status === 'approved'),
)

function move(direction: -1 | 1) {
  if (!todo.value) return
  const index = ORDER.indexOf(todo.value.status) + direction
  if (index < 0 || index >= ORDER.length) return
  teamStore.setTodoStatus(todo.value.id, ORDER[index])
}

async function openSession(sessionId: string) {
  await sessionStore.fetchSessions()
  await sessionStore.selectSession(sessionId)
  router.push('/')
  emit('close')
}

async function build() {
  if (!todo.value) return
  busyMessage.value = null
  if (openPrereqCount.value > 0 && !confirmBuild.value) {
    confirmBuild.value = true
    return
  }
  confirmBuild.value = false
  const result = await teamStore.implementTodo(todo.value.id)
  if (!result) return
  if (result.sessionId) await openSession(result.sessionId)
  else busyMessage.value = result.reason ?? 'Could not start the implementation'
}

async function sendRefine() {
  if (!todo.value) return
  const feedback = refineFeedback.value.trim()
  if (!feedback) return
  refineSending.value = true
  const result = await teamStore.refineTodo(todo.value.id, feedback)
  refineSending.value = false
  if (!result) return
  if (result.ran && result.sessionId) {
    showRefine.value = false
    await openSession(result.sessionId)
  } else {
    busyMessage.value = result.reason ?? 'Could not send the feedback'
  }
}

async function remove() {
  if (!todo.value) return
  await teamStore.deleteTodo(todo.value.id)
  emit('close')
}
</script>

<template>
  <Teleport to="body">
    <div
      v-if="todoId && todo"
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      @click.self="emit('close')"
    >
      <div class="flex max-h-[85vh] w-full max-w-lg flex-col rounded-xl bg-white shadow-xl dark:bg-gray-900">
        <!-- Header -->
        <div class="flex items-start justify-between gap-3 border-b border-gray-200 px-5 py-4 dark:border-gray-800">
          <div class="min-w-0">
            <div class="flex items-center gap-2">
              <span class="text-[10px] font-medium uppercase tracking-wide text-purple-600 dark:text-purple-400">
                {{ project?.name ?? 'Removed project' }}
              </span>
              <span class="rounded-full bg-gray-100 px-2 py-0.5 text-[10px] font-medium text-gray-600 dark:bg-gray-800 dark:text-gray-400">
                {{ STATUS_LABELS[todo.status] }}
              </span>
            </div>
            <h2 class="mt-1 text-sm font-semibold text-gray-900 dark:text-gray-100">{{ todo.text }}</h2>
            <p v-if="todo.notes" class="mt-1 whitespace-pre-wrap text-xs text-gray-500 dark:text-gray-400">{{ todo.notes }}</p>
          </div>
          <button
            class="shrink-0 rounded-lg p-1 text-gray-400 transition hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-800 dark:hover:text-gray-300"
            @click="emit('close')"
          >
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" class="h-5 w-5">
              <path d="M6.28 5.22a.75.75 0 0 0-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 1 0 1.06 1.06L10 11.06l3.72 3.72a.75.75 0 1 0 1.06-1.06L11.06 10l3.72-3.72a.75.75 0 0 0-1.06-1.06L10 8.94 6.28 5.22Z" />
            </svg>
          </button>
        </div>

        <!-- Body -->
        <div class="flex flex-col gap-4 overflow-y-auto px-5 py-4">
          <div v-if="teamStore.error || busyMessage" class="order-first rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700 dark:bg-amber-900/20 dark:text-amber-400">
            {{ teamStore.error || busyMessage }}
          </div>

          <!-- Independent reviews -->
          <div v-if="todo.takes?.length" class="flex flex-col gap-1.5">
            <h3 class="text-xs font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500">Team reviews</h3>
            <div
              v-for="take in todo.takes"
              :key="take.personaId"
              class="flex items-start gap-2 rounded-lg bg-gray-50 p-2.5 dark:bg-gray-800/50"
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

          <!-- Proposal -->
          <div v-if="todo.proposal" class="flex flex-col gap-1.5">
            <h3 class="text-xs font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500">Proposal</h3>
            <div class="rounded-lg bg-blue-50/60 p-2.5 dark:bg-blue-900/10">
              <div class="flex items-center gap-1.5">
                <PersonaAvatar :persona="proposer" size="sm" />
                <span class="text-xs font-medium text-gray-800 dark:text-gray-200">
                  {{ proposer?.name ?? 'Team' }}: {{ todo.proposal.summary }}
                </span>
              </div>
              <p class="mt-1.5 whitespace-pre-wrap text-xs text-gray-600 dark:text-gray-400">{{ todo.proposal.approach }}</p>
              <p v-if="todo.proposal.effort" class="mt-1 text-xs text-gray-400 dark:text-gray-500">Effort: {{ todo.proposal.effort }}</p>
              <details v-if="todo.proposal.brief" class="mt-1.5">
                <summary class="cursor-pointer text-xs text-blue-600 dark:text-blue-400">Implementation brief (what the builder runs on)</summary>
                <pre class="mt-1 whitespace-pre-wrap rounded bg-white p-2 font-mono text-[11px] text-gray-600 dark:bg-gray-900 dark:text-gray-400">{{ todo.proposal.brief }}</pre>
              </details>
            </div>
          </div>

          <!-- Prerequisites: answerable right here, and on top while any are
               open — that's usually why the card was opened -->
          <div v-if="prereqs.length" class="flex flex-col gap-1.5" :class="{ 'order-first': openPrereqCount > 0 }">
            <h3 class="text-xs font-semibold uppercase tracking-wider text-amber-600 dark:text-amber-500">
              Waiting on you{{ openPrereqCount ? ` · ${openPrereqCount} open` : ' · all done' }}
            </h3>
            <ActionItemCard
              v-for="item in prereqs"
              :key="item.id"
              :item="item"
              :show-idea="false"
              @navigate="emit('close')"
            />
          </div>

          <!-- Refine -->
          <div v-if="showRefine" class="flex flex-col gap-1.5">
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
                @click="sendRefine"
              >{{ refineSending ? 'Sending…' : 'Send to team' }}</button>
              <button
                class="rounded px-2.5 py-1 text-xs text-gray-500 hover:text-gray-700 dark:hover:text-gray-300"
                @click="showRefine = false"
              >Cancel</button>
            </div>
          </div>
        </div>

        <!-- Action bar -->
        <div class="flex flex-wrap items-center gap-1.5 border-t border-gray-200 px-5 py-3 dark:border-gray-800">
          <button
            v-if="canBuild"
            class="rounded px-3 py-1.5 text-xs font-medium text-white transition"
            :class="confirmBuild ? 'bg-amber-600 hover:bg-amber-700' : 'bg-green-600 hover:bg-green-700'"
            @click="build"
          >{{ confirmBuild
            ? `Build anyway? (${openPrereqCount} open)`
            : (todo.status === 'proposed' ? 'Approve & build' : 'Build') }}</button>
          <button
            v-if="todo.workSessionId"
            class="rounded bg-blue-600 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-blue-700"
            @click="openSession(todo.workSessionId!)"
          >{{ todo.status === 'done' ? 'View build session' : 'Building — watch live' }}</button>
          <button
            v-if="todo.proposal && !todo.workSessionId && todo.status !== 'done'"
            class="rounded bg-purple-100 px-3 py-1.5 text-xs font-medium text-purple-700 transition hover:bg-purple-200 dark:bg-purple-900/30 dark:text-purple-300 dark:hover:bg-purple-900/50"
            @click="showRefine = !showRefine"
          >Request changes</button>

          <div class="flex-1" />

          <button
            class="rounded p-1.5 text-gray-400 transition hover:bg-gray-100 hover:text-gray-600 disabled:invisible dark:hover:bg-gray-800 dark:hover:text-gray-300"
            :disabled="todo.status === 'inbox'"
            title="Move back"
            @click="move(-1)"
          >
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" class="h-4 w-4">
              <path fill-rule="evenodd" d="M9.78 4.22a.75.75 0 0 1 0 1.06L7.06 8l2.72 2.72a.75.75 0 1 1-1.06 1.06L5.47 8.53a.75.75 0 0 1 0-1.06l3.25-3.25a.75.75 0 0 1 1.06 0Z" clip-rule="evenodd" />
            </svg>
          </button>
          <button
            class="rounded p-1.5 text-gray-400 transition hover:bg-gray-100 hover:text-gray-600 disabled:invisible dark:hover:bg-gray-800 dark:hover:text-gray-300"
            :disabled="todo.status === 'done'"
            title="Move forward"
            @click="move(1)"
          >
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" class="h-4 w-4">
              <path fill-rule="evenodd" d="M6.22 4.22a.75.75 0 0 1 1.06 0l3.25 3.25a.75.75 0 0 1 0 1.06l-3.25 3.25a.75.75 0 0 1-1.06-1.06L8.94 8 6.22 5.28a.75.75 0 0 1 0-1.06Z" clip-rule="evenodd" />
            </svg>
          </button>
          <button
            class="rounded p-1.5 text-red-500 transition hover:bg-red-50 dark:hover:bg-red-900/20"
            title="Delete idea"
            @click="remove"
          >
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" class="h-4 w-4">
              <path fill-rule="evenodd" d="M5 3.25V4H2.75a.75.75 0 0 0 0 1.5h.3l.815 8.15A1.5 1.5 0 0 0 5.357 15h5.285a1.5 1.5 0 0 0 1.493-1.35l.815-8.15h.3a.75.75 0 0 0 0-1.5H11v-.75A2.25 2.25 0 0 0 8.75 1h-1.5A2.25 2.25 0 0 0 5 3.25Zm2.25-.75a.75.75 0 0 0-.75.75V4h3v-.75a.75.75 0 0 0-.75-.75h-1.5Z" clip-rule="evenodd" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>
