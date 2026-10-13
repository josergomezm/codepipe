<script setup lang="ts">
import { ref, computed } from 'vue'
import { useRouter } from 'vue-router'
import { useTeamStore } from '@/stores/team'
import { useProjectsStore } from '@/stores/projects'
import { useSessionsStore } from '@/stores/sessions'
import PersonaAvatar from '@/components/PersonaAvatar.vue'
import * as api from '@/api/client'
import type { ActionItem } from '@/api/client'

/**
 * One action item, answerable in place: tappable options for decisions,
 * a free-text answer, steps for tasks, a due date (exportable to Google
 * Calendar for tasks), and snooze / won't do / discuss.
 * Shared by the Actions page and the idea modal on the board.
 */
const props = withDefaults(
  defineProps<{
    item: ActionItem
    /** Show the "for idea" chip (off inside the idea's own modal). */
    showIdea?: boolean
  }>(),
  { showIdea: true },
)
const emit = defineEmits<{ navigate: [] }>()

const teamStore = useTeamStore()
const projectStore = useProjectsStore()
const sessionStore = useSessionsStore()
const router = useRouter()

/** One-click answer for legacy decisions whose options live in the notes. */
const GO_WITH_RECOMMENDATION = 'Go with your recommendation.'
/** Prefix of the draft "Discuss" writes — recognizable so a stale one can be replaced. */
const DRAFT_PREFIX = 'About "'

const answer = ref('')
const showOther = ref(false)
const showNotes = ref(false)
const showMenu = ref(false)
const declining = ref(false)
const editingDue = ref(false)
const declineReason = ref('')
const busy = ref(false)
const localError = ref<string | null>(null)
const startedStandup = ref<string | null>(null)

const isOpen = computed(() => props.item.status === 'open')
const isDecision = computed(() => props.item.kind === 'decision')
const options = computed(() => props.item.options ?? [])
const raiser = computed(() =>
  props.item.personaId ? teamStore.personasById.get(props.item.personaId) ?? null : null,
)
const idea = computed(() =>
  props.item.todoId ? teamStore.todos.find((t) => t.id === props.item.todoId) ?? null : null,
)
const project = computed(() => projectStore.projects.find((p) => p.id === props.item.projectId) ?? null)
const snoozed = computed(() => !!props.item.snoozedUntil && props.item.snoozedUntil > Date.now())
/** Closed during this visit — show where the answer went. */
const justClosed = computed(() => !isOpen.value && teamStore.recentlyClosedIds.has(props.item.id))
const longNotes = computed(() => (props.item.notes?.length ?? 0) > 160)

/** Today as YYYY-MM-DD in local time — what a due date is compared against. */
function localToday(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

const dueState = computed<'overdue' | 'today' | 'upcoming' | null>(() => {
  const due = props.item.dueDate
  if (!due || !isOpen.value) return null
  const today = localToday()
  return due < today ? 'overdue' : due === today ? 'today' : 'upcoming'
})

/** A due date read as a local calendar day (not UTC midnight). */
function formatDueDate(due: string): string {
  const [y, m, d] = due.split('-').map(Number)
  const date = new Date(y, m - 1, d)
  return date.toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    ...(y !== new Date().getFullYear() ? { year: 'numeric' } : {}),
  })
}

/**
 * Google Calendar's "create event" template, prefilled as an all-day event
 * on the due date. One-way: the event doesn't follow later edits here.
 * Decisions aren't exported — they're answered here, not scheduled.
 */
const calendarUrl = computed(() => {
  const due = props.item.dueDate
  if (!due || !isOpen.value || isDecision.value) return null
  const [y, m, d] = due.split('-').map(Number)
  // All-day events take an exclusive end date: the day after.
  const end = new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10)
  const details = [
    props.item.notes,
    props.item.steps?.length ? props.item.steps.map((step, i) => `${i + 1}. ${step}`).join('\n') : undefined,
    project.value ? `From CodePipe — ${project.value.name}` : 'From CodePipe',
  ]
    .filter(Boolean)
    .join('\n\n')
  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: props.item.text,
    dates: `${due.replaceAll('-', '')}/${end.replaceAll('-', '')}`,
    // Keep the URL well under browser/Google limits.
    details: details.length > 1500 ? `${details.slice(0, 1500)}…` : details,
  })
  return `https://calendar.google.com/calendar/render?${params}`
})

async function setDue(value: string | null) {
  if (value === '') value = null
  if (value === (props.item.dueDate ?? null)) {
    editingDue.value = false
    return
  }
  if (await teamStore.setActionDueDate(props.item.id, value)) editingDue.value = false
}

/** Where an answer goes: the next standup, when one is scheduled. */
const nextStandupLabel = computed(() => {
  const s = project.value?.standup
  if (!s?.enabled) return 'the next standup you run'
  const at = new Date()
  at.setHours(s.hour, 0, 0, 0)
  return `the next standup (daily at ${at.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })})`
})

function age(ts: number): string {
  const days = Math.floor((Date.now() - ts) / 86_400_000)
  if (days < 1) return 'today'
  if (days < 7) return `${days}d ago`
  if (days < 60) return `${Math.floor(days / 7)}w ago`
  return `${Math.floor(days / 30)}mo ago`
}

function formatDay(ts: number): string {
  return new Date(ts).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
}

async function submit(text: string | undefined) {
  const resolution = text?.trim()
  if (!resolution || busy.value) return
  busy.value = true
  if (await teamStore.resolveAction(props.item.id, resolution)) answer.value = ''
  busy.value = false
}

async function decline() {
  busy.value = true
  if (await teamStore.dismissAction(props.item.id, declineReason.value.trim() || undefined)) {
    declining.value = false
    declineReason.value = ''
  }
  busy.value = false
}

function snooze(days: number | null) {
  showMenu.value = false
  if (days === null) return teamStore.snoozeAction(props.item.id, null)
  // Back at the start of that day, not mid-afternoon.
  const until = new Date()
  until.setDate(until.getDate() + days)
  until.setHours(8, 0, 0, 0)
  return teamStore.snoozeAction(props.item.id, until.getTime())
}

function toggleDone() {
  teamStore.setActionStatus(props.item.id, isOpen.value ? 'done' : 'open')
}

async function openSession(sessionId: string) {
  await sessionStore.fetchSessions()
  await sessionStore.selectSession(sessionId)
  emit('navigate')
  router.push('/')
}

/** Answer delivered now instead of at the next standup. */
async function tellThemNow() {
  localError.value = null
  const result = await teamStore.runStandup(props.item.projectId)
  if (!result) return
  if (result.ran && result.sessionId) {
    startedStandup.value = result.sessionId
  } else {
    localError.value = result.reason ?? 'The standup did not start'
  }
}

/**
 * For decisions that need a back-and-forth: jump into the project's team
 * thread with a reply drafted about this item. The team closes the item
 * itself (resolve_action_item) once the conversation settles it.
 */
async function discussInThread() {
  showMenu.value = false
  localError.value = null
  try {
    const state = await api.fetchStandupState(props.item.projectId)
    if (!state.teamSessionId) {
      localError.value = 'No team thread for this project yet — run a standup first.'
      return
    }
    // ChatInput isn't mounted while this card is on screen and loads the
    // draft when it mounts, so writing it here is always picked up. Only a
    // draft you were actually writing is kept; an unsent prefill from this
    // button (perhaps for a different item) is replaced.
    const draftKey = `codepipe:draft:${state.teamSessionId}`
    const existing = localStorage.getItem(draftKey)
    if (!existing?.trim() || existing.startsWith(DRAFT_PREFIX)) {
      localStorage.setItem(draftKey, `${DRAFT_PREFIX}${props.item.text}"\n\n`)
    }
    await openSession(state.teamSessionId)
  } catch {
    localError.value = 'Could not open the team thread.'
  }
}

function openBoard() {
  emit('navigate')
  router.push({ path: '/board', query: { project: props.item.projectId } })
}
</script>

<template>
  <div
    class="flex items-start gap-3 rounded-lg border px-4 py-3"
    :class="isOpen
      ? 'border-gray-200 dark:border-gray-700'
      : 'border-gray-100 bg-gray-50/60 dark:border-gray-800 dark:bg-gray-900/40'"
  >
    <input
      type="checkbox"
      :checked="!isOpen"
      class="mt-0.5 rounded"
      :title="isOpen ? 'Mark done' : 'Reopen'"
      @change="toggleDone"
    />
    <div class="min-w-0 flex-1">
      <!-- Question / task -->
      <div class="flex items-start gap-2">
        <p
          class="min-w-0 flex-1 text-sm"
          :class="isOpen ? 'text-gray-800 dark:text-gray-200' : 'text-gray-400 line-through dark:text-gray-500'"
        >{{ item.text }}</p>
        <span
          v-if="item.blocking === false && isOpen"
          class="shrink-0 rounded-full bg-gray-100 px-1.5 py-0.5 text-[10px] font-medium text-gray-500 dark:bg-gray-800 dark:text-gray-400"
        >nice to know</span>
        <span
          v-if="item.kind"
          class="shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium"
          :class="isDecision
            ? 'bg-purple-50 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300'
            : 'bg-sky-50 text-sky-700 dark:bg-sky-900/30 dark:text-sky-300'"
        >{{ isDecision ? 'decision' : 'setup' }}</span>

        <!-- Overflow menu -->
        <div v-if="isOpen" class="relative shrink-0">
          <button
            class="-my-1 rounded p-1 text-gray-400 transition hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-800 dark:hover:text-gray-300"
            title="More"
            @click="showMenu = !showMenu"
          >
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" class="h-4 w-4">
              <path d="M2 8a1.5 1.5 0 1 1 3 0 1.5 1.5 0 0 1-3 0Zm4.5 0a1.5 1.5 0 1 1 3 0 1.5 1.5 0 0 1-3 0ZM12.5 6.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3Z" />
            </svg>
          </button>
          <div
            v-if="showMenu"
            class="absolute right-0 z-20 mt-1 flex w-44 flex-col rounded-lg border border-gray-200 bg-white py-1 text-xs shadow-lg dark:border-gray-700 dark:bg-gray-800"
            @mouseleave="showMenu = false"
          >
            <button v-if="snoozed" class="px-3 py-1.5 text-left hover:bg-gray-50 dark:hover:bg-gray-700" @click="snooze(null)">Unsnooze</button>
            <template v-else>
              <button class="px-3 py-1.5 text-left hover:bg-gray-50 dark:hover:bg-gray-700" @click="snooze(1)">Snooze until tomorrow</button>
              <button class="px-3 py-1.5 text-left hover:bg-gray-50 dark:hover:bg-gray-700" @click="snooze(7)">Snooze a week</button>
            </template>
            <button class="px-3 py-1.5 text-left hover:bg-gray-50 dark:hover:bg-gray-700" @click="editingDue = true; showMenu = false">{{ item.dueDate ? 'Change due date…' : 'Set due date…' }}</button>
            <button class="px-3 py-1.5 text-left hover:bg-gray-50 dark:hover:bg-gray-700" @click="declining = true; showMenu = false">Won't do…</button>
            <button v-if="raiser" class="px-3 py-1.5 text-left hover:bg-gray-50 dark:hover:bg-gray-700" @click="discussInThread">Discuss in thread</button>
            <button
              class="px-3 py-1.5 text-left text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-900/20"
              title="Removes it silently — the team may raise it again. Prefer “Won't do”."
              @click="teamStore.deleteAction(item.id)"
            >Delete</button>
          </div>
        </div>
      </div>

      <!-- Context, collapsed when long -->
      <template v-if="item.notes && (isOpen || !item.resolution)">
        <p
          class="mt-1 whitespace-pre-wrap text-xs text-gray-500 dark:text-gray-400"
          :class="{ 'line-clamp-2': longNotes && !showNotes }"
        >{{ item.notes }}</p>
        <button
          v-if="longNotes"
          class="text-[11px] text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
          @click="showNotes = !showNotes"
        >{{ showNotes ? 'Less' : 'More' }}</button>
      </template>

      <!-- The idea this item gates -->
      <button
        v-if="showIdea && idea"
        class="mt-1 flex max-w-full items-center gap-1.5 rounded bg-purple-50 px-2 py-1 text-left hover:bg-purple-100 dark:bg-purple-900/20 dark:hover:bg-purple-900/40"
        title="Open the board"
        @click="openBoard"
      >
        <span class="shrink-0 text-[10px] font-semibold uppercase tracking-wide text-purple-500 dark:text-purple-400">for idea</span>
        <span class="min-w-0 truncate text-xs text-purple-800 dark:text-purple-300">{{ idea.text }}</span>
      </button>

      <!-- Answering a decision -->
      <div v-if="isOpen && isDecision && !declining" class="mt-2 flex flex-col gap-1.5">
        <div v-if="options.length" class="flex flex-col gap-1">
          <button
            v-for="opt in options"
            :key="opt.label"
            :disabled="busy"
            class="flex flex-col items-start rounded-lg border px-3 py-1.5 text-left transition disabled:opacity-50"
            :class="opt.recommended
              ? 'border-purple-300 bg-purple-50 hover:bg-purple-100 dark:border-purple-700 dark:bg-purple-900/30 dark:hover:bg-purple-900/50'
              : 'border-gray-200 hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-800'"
            @click="submit(opt.label)"
          >
            <span class="flex items-center gap-1.5 text-xs font-medium text-gray-800 dark:text-gray-200">
              {{ opt.label }}
              <span v-if="opt.recommended" class="rounded-full bg-purple-600 px-1.5 text-[9px] font-semibold uppercase tracking-wide text-white">recommended</span>
            </span>
            <span v-if="opt.detail" class="text-[11px] text-gray-500 dark:text-gray-400">{{ opt.detail }}</span>
          </button>
          <button
            v-if="!showOther"
            class="self-start text-[11px] text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
            @click="showOther = true"
          >Something else…</button>
        </div>
        <template v-if="!options.length || showOther">
          <textarea
            v-model="answer"
            rows="2"
            placeholder="Your answer…"
            class="rounded-lg border border-gray-200 bg-white px-3 py-2 text-xs text-gray-900 placeholder:text-gray-400 focus:border-purple-500 focus:outline-none dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100"
            @keydown.enter.ctrl.prevent="submit(answer)"
            @keydown.enter.meta.prevent="submit(answer)"
          />
          <div class="flex flex-wrap items-center gap-1.5">
            <button
              :disabled="busy || !answer.trim()"
              class="rounded bg-purple-600 px-2.5 py-1 text-xs font-medium text-white transition hover:bg-purple-700 disabled:opacity-50"
              @click="submit(answer)"
            >Answer</button>
            <button
              v-if="!options.length && item.notes"
              :disabled="busy"
              class="rounded border border-purple-200 px-2.5 py-1 text-xs font-medium text-purple-700 transition hover:bg-purple-50 disabled:opacity-50 dark:border-purple-800 dark:text-purple-300 dark:hover:bg-purple-900/30"
              title="Answer with the team's recommendation (see the notes above)"
              @click="submit(GO_WITH_RECOMMENDATION)"
            >Go with recommendation</button>
          </div>
        </template>
      </div>

      <!-- Step-by-step guide (tasks) -->
      <ol v-if="isOpen && item.steps?.length" class="mt-2 flex flex-col gap-1">
        <li
          v-for="(step, i) in item.steps"
          :key="i"
          class="flex items-start gap-2 text-xs text-gray-600 dark:text-gray-400"
        >
          <span class="mt-px flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-gray-100 text-[9px] font-semibold text-gray-500 dark:bg-gray-800 dark:text-gray-400">{{ i + 1 }}</span>
          <span class="whitespace-pre-wrap">{{ step }}</span>
        </li>
      </ol>

      <!-- Due date -->
      <div v-if="editingDue && isOpen" class="mt-2 flex flex-wrap items-center gap-1.5">
        <input
          type="date"
          :value="item.dueDate ?? ''"
          :min="item.dueDate && item.dueDate < localToday() ? undefined : localToday()"
          class="rounded border border-gray-200 bg-white px-2 py-1 text-xs text-gray-900 focus:border-purple-500 focus:outline-none dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100 dark:[color-scheme:dark]"
          @change="setDue(($event.target as HTMLInputElement).value)"
        />
        <button
          v-if="item.dueDate"
          class="rounded px-2 py-1 text-xs text-gray-500 hover:text-gray-700 dark:hover:text-gray-300"
          @click="setDue(null)"
        >Clear</button>
        <button class="rounded px-2 py-1 text-xs text-gray-500 hover:text-gray-700 dark:hover:text-gray-300" @click="editingDue = false">Done</button>
      </div>

      <!-- Won't do -->
      <div v-if="declining" class="mt-2 flex flex-col gap-1.5">
        <textarea
          v-model="declineReason"
          rows="2"
          placeholder="Why not? (optional — the team uses it so they don't ask again)"
          class="rounded-lg border border-gray-200 bg-white px-3 py-2 text-xs text-gray-900 placeholder:text-gray-400 focus:border-gray-400 focus:outline-none dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100"
        />
        <div class="flex gap-1.5">
          <button
            :disabled="busy"
            class="rounded bg-gray-700 px-2.5 py-1 text-xs font-medium text-white transition hover:bg-gray-800 disabled:opacity-50 dark:bg-gray-600 dark:hover:bg-gray-500"
            @click="decline"
          >Won't do</button>
          <button class="rounded px-2.5 py-1 text-xs text-gray-500 hover:text-gray-700 dark:hover:text-gray-300" @click="declining = false">Cancel</button>
        </div>
      </div>

      <!-- Outcome -->
      <p v-if="!isOpen && item.resolution" class="mt-1 whitespace-pre-wrap text-xs text-purple-700 dark:text-purple-300">
        <span class="font-medium">{{ item.status === 'dismissed' ? 'Declined:' : 'You answered:' }}</span> {{ item.resolution }}
      </p>
      <p v-else-if="item.status === 'dismissed'" class="mt-1 text-xs text-gray-500 dark:text-gray-400">Declined (won't do)</p>
      <div
        v-if="justClosed && item.personaId"
        class="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 rounded bg-green-50 px-2 py-1 text-[11px] text-green-800 dark:bg-green-900/20 dark:text-green-300"
      >
        <template v-if="startedStandup">
          <span>The team is on it.</span>
          <button class="font-medium underline" @click="openSession(startedStandup)">Watch</button>
        </template>
        <template v-else>
          <span>Sent — the team picks it up at {{ nextStandupLabel }}.</span>
          <button
            :disabled="teamStore.standupRunning.has(item.projectId)"
            class="font-medium underline disabled:opacity-50"
            @click="tellThemNow"
          >{{ teamStore.standupRunning.has(item.projectId) ? 'Starting…' : 'Tell them now' }}</button>
        </template>
      </div>

      <p v-if="localError" class="mt-1 text-xs text-red-600 dark:text-red-400">{{ localError }}</p>

      <!-- Footer -->
      <div class="mt-1.5 flex items-center gap-1.5 text-[10px] text-gray-400 dark:text-gray-500">
        <template v-if="raiser">
          <PersonaAvatar :persona="raiser" size="sm" />
          <span>{{ raiser.name }}</span>
          <span>·</span>
        </template>
        <span :title="new Date(item.createdAt).toLocaleString()">{{ age(item.createdAt) }}</span>
        <template v-if="item.dueDate && isOpen">
          <span>·</span>
          <button
            class="rounded-full px-1.5 py-px font-medium"
            :class="{
              'bg-red-50 text-red-700 dark:bg-red-900/30 dark:text-red-300': dueState === 'overdue',
              'bg-amber-50 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300': dueState === 'today',
              'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300': dueState === 'upcoming',
            }"
            title="Change due date"
            @click="editingDue = !editingDue"
          >{{ dueState === 'overdue' ? 'overdue · ' : dueState === 'today' ? 'due today · ' : 'due ' }}{{ formatDueDate(item.dueDate) }}</button>
          <a
            v-if="calendarUrl"
            :href="calendarUrl"
            target="_blank"
            rel="noopener noreferrer"
            class="flex items-center gap-0.5 hover:text-gray-600 hover:underline dark:hover:text-gray-300"
            title="Opens a prefilled all-day event in Google Calendar — later changes here won't sync"
          >
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" class="h-3 w-3">
              <path fill-rule="evenodd" d="M4 1.75a.75.75 0 0 1 1.5 0V3h5V1.75a.75.75 0 0 1 1.5 0V3a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2V1.75ZM3.5 7v5a.5.5 0 0 0 .5.5h8a.5.5 0 0 0 .5-.5V7h-9Z" clip-rule="evenodd" />
            </svg>
            Add to Google Calendar
          </a>
        </template>
        <template v-else-if="isOpen && !isDecision && !editingDue">
          <span>·</span>
          <button
            class="hover:text-gray-600 hover:underline dark:hover:text-gray-300"
            title="Set a deadline — then add it to Google Calendar"
            @click="editingDue = true"
          >+ due date</button>
        </template>
        <template v-if="snoozed && isOpen">
          <span>·</span>
          <span>snoozed until {{ formatDay(item.snoozedUntil!) }}</span>
        </template>
      </div>
    </div>
  </div>
</template>
