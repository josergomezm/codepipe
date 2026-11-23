<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useTeamStore } from '@/stores/team'
import { useProjectsStore } from '@/stores/projects'
import { useSessionsStore } from '@/stores/sessions'
import { latestScheduledBrief, useLeadStore } from '@/stores/lead'
import { dayLabel } from '@/lib/files'
import type { Persona } from '@/api/client'
import PersonaAvatar from '@/components/PersonaAvatar.vue'
import SheetModal from '@/components/SheetModal.vue'
import FocusList from '@/components/briefing/FocusList.vue'
import BriefingCard from '@/components/briefing/BriefingCard.vue'
import {
  WINDOW_HOURS, buildSampleBriefing, loadFocus, loadInputs, saveFocus,
  type BriefingInputs, type FocusItem, type SampleBriefing,
} from '@/lib/briefing-preview'

/**
 * PREVIEW of the lead's assistant thread: a workspace-level chat with your
 * team lead, where the daily brief lands each morning (what you worked on in
 * the last 24h vs. your Focus list, board and action items) and you reply.
 * Real inputs, sample brief, no backend — see lib/briefing-preview.ts.
 */
defineProps<{ lead: Persona }>()

const team = useTeamStore()
const projectsStore = useProjectsStore()
const sessionsStore = useSessionsStore()
const router = useRouter()
const leadInbox = useLeadStore()

const focus = ref<FocusItem[]>([])
const highlight = ref<string | null>(null)
const inputs = ref<BriefingInputs | null>(null)
const today = ref<SampleBriefing | null>(null)
const yesterday = ref<SampleBriefing | null>(null)
const showYesterday = ref(false)
const schedule = ref('daily-9')
const modal = ref<'focus' | 'sources' | null>(null)
const openInput = ref<string | null>(null)

// Simulated run
const running = ref(false)
const step = ref(0)
const steps = computed(() => {
  const i = inputs.value
  const others = team.personas.filter((p) => !p.isLead).map((p) => p.name)
  return [
    `Reading ${i?.conversations.length ?? 0} chats from the last ${WINDOW_HOURS} hours`,
    `Checking ${i?.openActions.length ?? 0} action items and ${(i?.proposedIdeas.length ?? 0) + (i?.inboxIdeas.length ?? 0)} ideas`,
    'Comparing your day with your Focus list',
    others.length ? `Asking ${others.join(', ')}` : 'Gathering team notes',
    'Writing the brief',
  ]
})

// Thread replies (preview)
const replies = ref<{ from: 'you' | 'lead'; text: string }[]>([])
const draft = ref('')
const leadTyping = ref(false)
const thread = ref<HTMLElement | null>(null)

/** True while this thread is on screen; its timers die with it. */
let open = true
const timers = new Set<ReturnType<typeof setTimeout>>()
function later(fn: () => void, ms: number) {
  const t = setTimeout(() => { timers.delete(t); fn() }, ms)
  timers.add(t)
  return t
}
onUnmounted(() => {
  open = false
  for (const t of timers) clearTimeout(t)
})

const toastText = ref<string | null>(null)
let toastTimer: ReturnType<typeof setTimeout> | undefined
function toast(text: string) {
  toastText.value = text
  if (toastTimer) { clearTimeout(toastTimer); timers.delete(toastTimer) }
  toastTimer = later(() => (toastText.value = null), 2200)
}

onMounted(async () => {
  // Open thread = read; anything the lead posts while it's open stays read.
  leadInbox.markRead()
  await Promise.all([team.fetchActions(), team.fetchTodos(), sessionsStore.fetchSessions()])
  focus.value = loadFocus(projectsStore.projects)
  inputs.value = await loadInputs(sessionsStore.sessions, projectsStore.projects, team.actions, team.todos)
  // This morning's run, and a shorter one from the day before above it.
  const lastBrief = latestScheduledBrief()
  today.value = buildSampleBriefing(inputs.value, focus.value, projectsStore.projects, team.personas, lastBrief)
  const dayBefore = new Date(lastBrief); dayBefore.setDate(dayBefore.getDate() - 1)
  yesterday.value = { ...today.value, at: dayBefore.getTime(), headline: 'Quiet day on the board — most of your time went to conversations.' }
  replies.value = [{ from: 'you', text: 'Partners is my main thing this month, products are on maintenance.' }]
  await scrollToEnd()
})

watch(focus, (f) => saveFocus(f), { deep: true })

/** Activity bars follow your current Focus list (the note stays as written). */
const todayView = computed<SampleBriefing | null>(() => {
  if (!today.value) return null
  const inFocus = new Set(focus.value.map((f) => f.projectId).filter(Boolean))
  return { ...today.value, activity: today.value.activity.map((r) => ({ ...r, inFocus: inFocus.has(r.projectId) })) }
})

async function runNow() {
  if (running.value || !inputs.value) return
  running.value = true
  today.value = null
  await scrollToEnd()
  for (step.value = 0; step.value < steps.value.length; step.value++) {
    await new Promise<void>((r) => later(r, 700))
    if (!open) return
  }
  inputs.value = await loadInputs(sessionsStore.sessions, projectsStore.projects, team.actions, team.todos)
  today.value = buildSampleBriefing(inputs.value, focus.value, projectsStore.projects, team.personas)
  leadInbox.notePosted()
  if (open) leadInbox.markRead()
  running.value = false
  await scrollToEnd()
}

function acceptFocus(s: SampleBriefing['focusSuggestions'][number]) {
  if (s.kind === 'add') {
    const item = { id: crypto.randomUUID(), label: s.label, ...(s.projectId ? { projectId: s.projectId } : {}) }
    focus.value = [item, ...focus.value].slice(0, 5)
    highlight.value = item.id
    toast('Added to the top of your Focus list')
  } else {
    focus.value = focus.value.filter((f) => f.id !== s.id && f.projectId !== s.projectId)
    toast('Removed from your Focus list')
  }
  later(() => (highlight.value = null), 2500)
}

function openSession(id: string) {
  modal.value = null
  void sessionsStore.selectSession(id)
  router.push('/')
}

async function send() {
  const text = draft.value.trim()
  if (!text) return
  replies.value.push({ from: 'you', text })
  draft.value = ''
  leadTyping.value = true
  await scrollToEnd()
  later(async () => {
    leadTyping.value = false
    replies.value.push({
      from: 'lead',
      text: '(Preview reply) Noted. In the real version I\'d answer here with your full context, and could update your Focus list, add workspace action items, or open a chat in the right project with a brief for you to send.',
    })
    leadInbox.notePosted()
    // Left the thread before the reply came? Then it's unread (badge).
    if (open) leadInbox.markRead()
    await scrollToEnd()
  }, 1200)
}

async function scrollToEnd() {
  await nextTick()
  thread.value?.scrollTo({ top: thread.value.scrollHeight, behavior: 'smooth' })
}

const sourcesLabel = computed(() => {
  const n = inputs.value?.conversations.length
  return n == null ? 'Sources' : `${n} chat${n === 1 ? '' : 's'} · 24h`
})
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col">
    <!-- Toolbar -->
    <div class="flex shrink-0 flex-wrap items-center gap-2 border-b border-gray-200 px-3 py-1.5 text-xs dark:border-gray-800">
      <span class="rounded-full bg-violet-100 px-1.5 py-0.5 text-[10px] font-medium text-violet-700 dark:bg-violet-900/40 dark:text-violet-300" title="Real inputs; the brief is sample text and buttons don't change anything yet">preview</span>
      <select
        v-model="schedule"
        class="rounded-md border border-gray-200 bg-white px-1.5 py-1 text-xs text-gray-600 focus:outline-none dark:border-gray-700 dark:bg-gray-900 dark:text-gray-300"
        title="When the daily brief runs"
        @change="toast('Preview: schedule not saved yet')"
      >
        <option value="daily-9">Brief daily · 9:00 AM</option>
        <option value="weekdays-9">Brief weekdays · 9:00 AM</option>
        <option value="weekdays-8">Brief weekdays · 8:00 AM</option>
        <option value="off">Brief only when I ask</option>
      </select>
      <div class="flex-1" />
      <button class="flex items-center gap-1 rounded-md px-2 py-1 text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800" @click="modal = 'focus'">
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" class="h-3.5 w-3.5 text-violet-500"><path fill-rule="evenodd" d="M8 15A7 7 0 1 0 8 1a7 7 0 0 0 0 14Zm0-2.5a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9ZM8 10a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z" clip-rule="evenodd" /></svg>
        Focus · {{ focus.length }}
      </button>
      <button class="flex items-center gap-1 rounded-md px-2 py-1 text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800" :title="`What ${lead.name} read`" @click="modal = 'sources'">
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" class="h-3.5 w-3.5 text-gray-400"><path d="M1 8.849c0 1 .738 1.851 1.734 1.947L3 10.82v2.429a.75.75 0 0 0 1.28.53l1.82-1.82A3.484 3.484 0 0 1 5.5 10V9A3.5 3.5 0 0 1 9 5.5h4V4.151c0-1-.739-1.851-1.734-1.947a44.539 44.539 0 0 0-8.532 0C1.738 2.3 1 3.151 1 4.151V8.85Z" /><path d="M7 9a2 2 0 0 1 2-2h5a2 2 0 0 1 2 2v1a2 2 0 0 1-2 2h-.25v1.25a.75.75 0 0 1-1.28.53L10.69 12H9a2 2 0 0 1-2-2V9Z" /></svg>
        {{ sourcesLabel }}
      </button>
      <button
        class="flex items-center gap-1.5 rounded-md bg-violet-600 px-2.5 py-1 font-medium text-white transition hover:bg-violet-700 disabled:opacity-60"
        :disabled="running || !inputs"
        @click="runNow"
      >
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" class="h-3.5 w-3.5" :class="{ 'animate-spin': running }"><path fill-rule="evenodd" d="M13.836 2.477a.75.75 0 0 1 .75.75v3.182a.75.75 0 0 1-.75.75h-3.182a.75.75 0 0 1 0-1.5h1.37l-.84-.841a4.5 4.5 0 0 0-7.08.932.75.75 0 0 1-1.3-.75 6 6 0 0 1 9.44-1.242l.842.84V3.227a.75.75 0 0 1 .75-.75Zm-.911 7.5A.75.75 0 0 1 13.199 11a6 6 0 0 1-9.44 1.241l-.84-.84v1.371a.75.75 0 0 1-1.5 0V9.591a.75.75 0 0 1 .75-.75H5.35a.75.75 0 0 1 0 1.5H3.98l.841.841a4.5 4.5 0 0 0 7.08-.932.75.75 0 0 1 1.025-.273Z" clip-rule="evenodd" /></svg>
        {{ running ? 'Briefing…' : 'Brief me now' }}
      </button>
    </div>

    <!-- Thread -->
    <div ref="thread" class="min-h-0 flex-1 overflow-y-auto">
      <div class="mx-auto flex max-w-3xl flex-col gap-4 px-4 py-5">
        <!-- Yesterday, collapsed -->
        <template v-if="yesterday">
          <div class="flex items-center gap-3 text-[11px] text-gray-400 dark:text-gray-500">
            <span class="h-px flex-1 bg-gray-200 dark:bg-gray-800" />{{ dayLabel(yesterday.at) }}<span class="h-px flex-1 bg-gray-200 dark:bg-gray-800" />
          </div>
          <div class="opacity-80">
            <BriefingCard :briefing="yesterday" :lead="lead" :personas="team.personasById" :compact="!showYesterday" @open-session="openSession" @toast="toast" />
            <button class="ml-9 mt-1 text-[11px] text-gray-400 hover:text-gray-600 dark:text-gray-500 dark:hover:text-gray-300" @click="showYesterday = !showYesterday">{{ showYesterday ? 'Collapse' : 'Show full brief' }}</button>
          </div>
          <div v-for="(r, i) in replies.slice(0, 1)" :key="'y' + i" class="flex justify-end">
            <p class="max-w-[80%] rounded-2xl bg-blue-600 px-4 py-2 text-sm text-white">{{ r.text }}</p>
          </div>
        </template>

        <!-- Today -->
        <div class="flex items-center gap-3 text-[11px] text-gray-400 dark:text-gray-500">
          <span class="h-px flex-1 bg-gray-200 dark:bg-gray-800" />Today<span class="h-px flex-1 bg-gray-200 dark:bg-gray-800" />
        </div>

        <div v-if="running" class="flex items-start gap-2.5">
          <PersonaAvatar :persona="lead" size="sm" class="mt-1 shrink-0" />
          <div class="rounded-2xl rounded-tl-md border border-gray-200 bg-white px-4 py-3 dark:border-gray-800 dark:bg-gray-900">
            <ul class="flex flex-col gap-1.5 text-xs">
              <li v-for="(s, i) in steps" :key="s" class="flex items-center gap-2" :class="i < step ? 'text-gray-500 dark:text-gray-400' : i === step ? 'text-gray-900 dark:text-gray-100' : 'text-gray-300 dark:text-gray-600'">
                <span v-if="i < step" class="text-green-500">✓</span>
                <svg v-else-if="i === step" class="h-3 w-3 animate-spin text-violet-500" viewBox="0 0 24 24" fill="none"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" /><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 0 1 8-8V0C5.373 0 0 5.373 0 12h4Z" /></svg>
                <span v-else class="inline-block h-3 w-3 rounded-full border border-current" />
                {{ s }}
              </li>
            </ul>
          </div>
        </div>
        <BriefingCard v-else-if="todayView" :briefing="todayView" :lead="lead" :personas="team.personasById" @open-session="openSession" @accept-focus="acceptFocus" @toast="toast" />
        <div v-else class="py-10 text-center text-sm text-gray-400 dark:text-gray-500">Loading…</div>

        <template v-for="(r, i) in replies.slice(1)" :key="'t' + i">
          <div v-if="r.from === 'you'" class="flex justify-end">
            <p class="max-w-[80%] whitespace-pre-wrap rounded-2xl bg-blue-600 px-4 py-2 text-sm text-white">{{ r.text }}</p>
          </div>
          <div v-else class="flex items-start gap-2.5">
            <PersonaAvatar :persona="lead" size="sm" class="mt-1 shrink-0" />
            <p class="max-w-[80%] rounded-2xl rounded-tl-md bg-gray-100 px-4 py-2 text-sm text-gray-800 dark:bg-gray-800 dark:text-gray-200">{{ r.text }}</p>
          </div>
        </template>
        <div v-if="leadTyping" class="ml-9 text-xs text-gray-400 dark:text-gray-500">{{ lead.name }} is typing…</div>
      </div>
    </div>

    <!-- Reply -->
    <div class="shrink-0 border-t border-gray-200 px-4 py-3 dark:border-gray-800">
      <div class="mx-auto flex max-w-3xl items-end gap-2">
        <textarea
          v-model="draft"
          rows="1"
          :placeholder="`Message ${lead.name}…`"
          class="min-h-[40px] flex-1 resize-none rounded-xl border border-gray-200 bg-white px-3 py-2.5 text-sm text-gray-900 placeholder:text-gray-400 focus:border-violet-500 focus:outline-none dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
          @keydown.enter.exact.prevent="send"
        />
        <button class="h-10 rounded-xl bg-blue-600 px-4 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-40" :disabled="!draft.trim()" @click="send">Send</button>
      </div>
    </div>

    <!-- Focus -->
    <SheetModal v-if="modal === 'focus'" title="Focus" subtitle="Your priorities, in order (up to 5). The brief checks your day against these." @close="modal = null">
      <FocusList v-model="focus" :projects="projectsStore.projects" :highlight="highlight" />
    </SheetModal>

    <!-- Sources -->
    <SheetModal
      v-if="modal === 'sources'"
      :title="`What ${lead.name} read`"
      :subtitle="`Chats you touched in the last ${WINDOW_HOURS} hours, with their last messages.`"
      @close="modal = null"
    >
      <p v-if="inputs && !inputs.conversations.length" class="py-4 text-center text-xs text-gray-400 dark:text-gray-500">No chats touched in the last {{ WINDOW_HOURS }} hours.</p>
      <ul v-if="inputs" class="-mx-1.5 flex flex-col">
        <li v-for="c in inputs.conversations" :key="c.session.id">
          <button class="w-full rounded-lg px-1.5 py-1.5 text-left hover:bg-gray-50 dark:hover:bg-gray-800/60" @click="openInput = openInput === c.session.id ? null : c.session.id">
            <div class="flex items-baseline gap-2">
              <span class="min-w-0 flex-1 truncate text-sm font-medium text-gray-800 dark:text-gray-200">{{ c.session.title }}</span>
              <span class="shrink-0 text-[11px] tabular-nums text-gray-400 dark:text-gray-500" :title="`${c.mine24} of your messages in 24h, ${c.mine7} this week`">{{ c.mine24 }} sent</span>
            </div>
            <div class="truncate text-[11px] text-gray-400 dark:text-gray-500">{{ c.projectName }}</div>
          </button>
          <div v-if="openInput === c.session.id" class="mx-1.5 mb-1.5 flex flex-col gap-1 rounded-lg bg-gray-50 p-2.5 text-xs leading-relaxed dark:bg-gray-800/60">
            <p v-if="c.lastUser" class="text-gray-600 dark:text-gray-300"><span class="font-medium">You:</span> {{ c.lastUser }}</p>
            <p v-if="c.lastAgent" class="text-gray-500 dark:text-gray-400"><span class="font-medium">Agent:</span> {{ c.lastAgent }}</p>
            <button class="self-start text-violet-600 hover:underline dark:text-violet-400" @click="openSession(c.session.id)">Open chat →</button>
          </div>
        </li>
      </ul>
      <div class="mt-3 grid grid-cols-3 gap-1 border-t border-gray-100 pt-3 text-center dark:border-gray-800">
        <router-link to="/actions" class="rounded py-1 hover:bg-gray-50 dark:hover:bg-gray-800/60">
          <div class="text-sm font-semibold text-gray-800 dark:text-gray-200">{{ inputs?.openActions.length ?? '–' }}</div>
          <div class="text-[10px] text-gray-400 dark:text-gray-500">open items</div>
        </router-link>
        <router-link to="/board" class="rounded py-1 hover:bg-gray-50 dark:hover:bg-gray-800/60">
          <div class="text-sm font-semibold text-gray-800 dark:text-gray-200">{{ inputs?.proposedIdeas.length ?? '–' }}</div>
          <div class="text-[10px] text-gray-400 dark:text-gray-500">proposed</div>
        </router-link>
        <router-link to="/board" class="rounded py-1 hover:bg-gray-50 dark:hover:bg-gray-800/60">
          <div class="text-sm font-semibold text-gray-800 dark:text-gray-200">{{ inputs?.inboxIdeas.length ?? '–' }}</div>
          <div class="text-[10px] text-gray-400 dark:text-gray-500">inbox ideas</div>
        </router-link>
      </div>
    </SheetModal>

    <!-- Toast -->
    <Transition enter-from-class="translate-y-2 opacity-0" enter-active-class="transition" leave-to-class="opacity-0" leave-active-class="transition">
      <div v-if="toastText" class="fixed bottom-20 left-1/2 z-[60] -translate-x-1/2 rounded-full bg-gray-900 px-3.5 py-1.5 text-xs text-white shadow-lg dark:bg-gray-100 dark:text-gray-900">{{ toastText }}</div>
    </Transition>
  </div>
</template>
