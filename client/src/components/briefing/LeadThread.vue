<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useSessionsStore } from '@/stores/sessions'
import { useProjectsStore } from '@/stores/projects'
import { useTeamStore } from '@/stores/team'
import { useLeadStore } from '@/stores/lead'
import { useSession } from '@/composables/useSession'
import * as api from '@/api/client'
import type { LeadDigest, Persona } from '@/api/client'
import MessageList from '@/components/MessageList.vue'
import ChatInput from '@/components/ChatInput.vue'
import SheetModal from '@/components/SheetModal.vue'
import FocusList from '@/components/briefing/FocusList.vue'

/**
 * The lead's thread: a real chat with your team lead, at the workspace
 * level. The daily brief lands here as a card (see BriefingCard); you reply
 * like in any chat. It borrows the app's active-chat machinery (message list,
 * composer, socket) while open, and hands the chat you had open back when
 * you leave.
 */
const props = defineProps<{ lead: Persona }>()

const sessions = useSessionsStore()
const projects = useProjectsStore()
const team = useTeamStore()
const leadStore = useLeadStore()
const { connect, disconnect } = useSession()
const router = useRouter()

const threadId = computed(() => leadStore.status?.sessionId ?? null)
const running = computed(() => !!leadStore.status?.briefRunning)
const loaded = ref(false)

// ----- Borrowing the active chat while open -----

/** The chat you had open, restored on leave. */
const previous = sessions.activeSessionId
/**
 * Set once you leave. Every await below re-checks it: a late load must never
 * take over the chat you moved to (its messages, its socket, your composer).
 */
let gone = false

async function openThread(id: string) {
  if (gone || sessions.activeSessionId === id) return
  await sessions.selectSession(id)
  // You may have left, or opened another chat, while it loaded.
  if (gone || sessions.activeSessionId !== id) return
  connect(id)
}

onMounted(async () => {
  await Promise.all([leadStore.fetchStatus(), team.fetchActions()])
  if (gone) return
  loaded.value = true
  if (threadId.value) await openThread(threadId.value)
})

// The first brief creates the thread — open it as soon as it exists.
watch(threadId, (id) => { if (id && loaded.value) void openThread(id) })

onUnmounted(() => {
  gone = true
  // Only if you're still on the thread (opening a chat from the brief moved on).
  if (!threadId.value || sessions.activeSessionId !== threadId.value) return
  disconnect()
  if (previous && previous !== threadId.value) void sessions.selectSession(previous)
  else sessions.deselectSession()
})

// ----- Toolbar -----

/** The schedule picker's options ↔ the server's schedule. */
const SCHEDULES = [
  { key: 'daily-9', label: 'Brief daily · 9:00 AM', schedule: { enabled: true, hour: 9, weekdaysOnly: false } },
  { key: 'weekdays-9', label: 'Brief weekdays · 9:00 AM', schedule: { enabled: true, hour: 9, weekdaysOnly: true } },
  { key: 'weekdays-8', label: 'Brief weekdays · 8:00 AM', schedule: { enabled: true, hour: 8, weekdaysOnly: true } },
  { key: 'off', label: 'Brief only when I ask', schedule: { enabled: false, hour: 9, weekdaysOnly: false } },
] as const

const scheduleKey = computed({
  get: () => {
    const s = leadStore.status?.schedule
    if (!s) return 'daily-9'
    if (!s.enabled) return 'off'
    return SCHEDULES.find((o) => o.schedule.enabled && o.schedule.hour === s.hour && o.schedule.weekdaysOnly === s.weekdaysOnly)?.key ?? 'daily-9'
  },
  set: (key: string) => {
    const option = SCHEDULES.find((o) => o.key === key)
    if (option) void leadStore.saveSchedule({ ...option.schedule })
  },
})

const toastText = ref<string | null>(null)
let toastTimer: ReturnType<typeof setTimeout> | undefined
function toast(text: string) {
  toastText.value = text
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => (toastText.value = null), 2500)
}
onUnmounted(() => clearTimeout(toastTimer))

async function briefNow() {
  if (running.value) return
  const result = await leadStore.runBrief()
  toast(result.ran ? `${props.lead.name} is writing your brief` : (result.reason ?? 'Could not start the brief'))
}

// ----- Focus and Sources sheets -----

const modal = ref<'focus' | 'sources' | null>(null)
const focus = computed({
  get: () => leadStore.focus,
  set: (next) => void leadStore.saveFocus(next),
})

const digest = ref<LeadDigest | null>(null)
const digestError = ref<string | null>(null)
const openChat = ref<string | null>(null)

async function showSources() {
  modal.value = 'sources'
  digestError.value = null
  try { digest.value = await api.fetchLeadDigest() } catch (e) { digestError.value = e instanceof Error ? e.message : 'Could not load' }
}

function goToChat(id: string) {
  modal.value = null
  void sessions.selectSession(id)
  router.push('/')
}

const ENDED: Record<string, string> = { waiting_on_you: 'Your turn', pending_action: 'Pending', done: 'Done' }
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col">
    <!-- Toolbar -->
    <div class="flex shrink-0 flex-wrap items-center gap-2 border-b border-gray-200 px-3 py-1.5 text-xs dark:border-gray-800">
      <select
        v-model="scheduleKey"
        class="rounded-md border border-gray-200 bg-white px-1.5 py-1 text-xs text-gray-600 focus:outline-none dark:border-gray-700 dark:bg-gray-900 dark:text-gray-300"
        title="When the daily brief runs"
      >
        <option v-for="o in SCHEDULES" :key="o.key" :value="o.key">{{ o.label }}</option>
      </select>
      <div class="flex-1" />
      <button class="flex items-center gap-1 rounded-md px-2 py-1 text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800" @click="modal = 'focus'">
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" class="h-3.5 w-3.5 text-violet-500 dark:text-violet-400"><path fill-rule="evenodd" d="M8 15A7 7 0 1 0 8 1a7 7 0 0 0 0 14Zm0-2.5a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9ZM8 10a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z" clip-rule="evenodd" /></svg>
        Focus · {{ focus.length }}
      </button>
      <button class="flex items-center gap-1 rounded-md px-2 py-1 text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800" :title="`What ${lead.name} reads`" @click="showSources">
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" class="h-3.5 w-3.5 text-gray-400 dark:text-gray-500"><path d="M1 8.849c0 1 .738 1.851 1.734 1.947L3 10.82v2.429a.75.75 0 0 0 1.28.53l1.82-1.82A3.484 3.484 0 0 1 5.5 10V9A3.5 3.5 0 0 1 9 5.5h4V4.151c0-1-.739-1.851-1.734-1.947a44.539 44.539 0 0 0-8.532 0C1.738 2.3 1 3.151 1 4.151V8.85Z" /><path d="M7 9a2 2 0 0 1 2-2h5a2 2 0 0 1 2 2v1a2 2 0 0 1-2 2h-.25v1.25a.75.75 0 0 1-1.28.53L10.69 12H9a2 2 0 0 1-2-2V9Z" /></svg>
        Sources
      </button>
      <button
        class="flex items-center gap-1.5 rounded-md bg-violet-600 px-2.5 py-1 font-medium text-white transition hover:bg-violet-700 disabled:opacity-60"
        :disabled="running"
        @click="briefNow"
      >
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" class="h-3.5 w-3.5" :class="{ 'animate-spin': running }"><path fill-rule="evenodd" d="M13.836 2.477a.75.75 0 0 1 .75.75v3.182a.75.75 0 0 1-.75.75h-3.182a.75.75 0 0 1 0-1.5h1.37l-.84-.841a4.5 4.5 0 0 0-7.08.932.75.75 0 0 1-1.3-.75 6 6 0 0 1 9.44-1.242l.842.84V3.227a.75.75 0 0 1 .75-.75Zm-.911 7.5A.75.75 0 0 1 13.199 11a6 6 0 0 1-9.44 1.241l-.84-.84v1.371a.75.75 0 0 1-1.5 0V9.591a.75.75 0 0 1 .75-.75H5.35a.75.75 0 0 1 0 1.5H3.98l.841.841a4.5 4.5 0 0 0 7.08-.932.75.75 0 0 1 1.025-.273Z" clip-rule="evenodd" /></svg>
        {{ running ? 'Briefing…' : 'Brief me now' }}
      </button>
    </div>

    <!-- The thread -->
    <template v-if="threadId && sessions.activeSessionId === threadId">
      <MessageList />
      <ChatInput />
    </template>
    <div v-else-if="loaded && !threadId" class="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
      <p class="max-w-sm text-sm text-gray-500 dark:text-gray-400">
        {{ lead.name }} reads your open chats, git activity and action items each morning, checks them against your Focus list, and writes you a brief here.
      </p>
      <button class="rounded-lg bg-violet-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-violet-700 disabled:opacity-60" :disabled="running" @click="briefNow">
        {{ running ? 'Writing your first brief…' : 'Get your first brief' }}
      </button>
    </div>
    <div v-else class="flex flex-1 items-center justify-center text-sm text-gray-400 dark:text-gray-500">Loading…</div>

    <!-- Focus -->
    <SheetModal v-if="modal === 'focus'" title="Focus" subtitle="Your priorities, in order (up to 5). The brief checks your day against these." @close="modal = null">
      <FocusList v-model="focus" :projects="projects.projects" />
    </SheetModal>

    <!-- Sources -->
    <SheetModal
      v-if="modal === 'sources'"
      :title="`What ${lead.name} reads`"
      subtitle="Your open chats — finished ones get deleted, so these are still in flight — plus your action items and the board."
      @close="modal = null"
    >
      <p v-if="digestError" class="py-4 text-center text-xs text-red-600 dark:text-red-400">{{ digestError }}</p>
      <p v-else-if="!digest" class="py-4 text-center text-xs text-gray-400 dark:text-gray-500">Loading…</p>
      <template v-else>
        <p v-if="!digest.chats.length" class="py-4 text-center text-xs text-gray-400 dark:text-gray-500">No open chats.</p>
        <ul class="-mx-1.5 flex flex-col">
          <li v-for="c in digest.chats" :key="c.sessionId">
            <button class="w-full rounded-lg px-1.5 py-1.5 text-left hover:bg-gray-50 dark:hover:bg-gray-800/60" @click="openChat = openChat === c.sessionId ? null : c.sessionId">
              <div class="flex items-baseline gap-2">
                <span class="min-w-0 flex-1 truncate text-sm font-medium text-gray-800 dark:text-gray-200">{{ c.title }}</span>
                <span v-if="c.attention && ENDED[c.attention.state]" class="shrink-0 text-[10px] font-medium text-amber-700 dark:text-amber-300">{{ ENDED[c.attention.state] }}</span>
                <span class="shrink-0 text-[11px] tabular-nums text-gray-400 dark:text-gray-500" :title="`${c.mine24} of your messages in 24h, ${c.mine7} this week`">{{ c.mine24 }} today</span>
              </div>
              <div class="truncate text-[11px] text-gray-400 dark:text-gray-500">{{ c.projectName }}</div>
            </button>
            <div v-if="openChat === c.sessionId" class="mx-1.5 mb-1.5 flex flex-col gap-1 rounded-lg bg-gray-50 p-2.5 text-xs leading-relaxed dark:bg-gray-800/60">
              <p class="text-gray-600 dark:text-gray-300"><span class="font-medium">Asked:</span> {{ c.firstRequest }}</p>
              <p v-if="c.lastTurns.at(-1)?.reply" class="text-gray-500 dark:text-gray-400"><span class="font-medium">Ended:</span> {{ c.lastTurns.at(-1)!.reply }}</p>
              <button class="self-start text-violet-600 hover:underline dark:text-violet-400" @click="goToChat(c.sessionId)">Open chat →</button>
            </div>
          </li>
        </ul>
        <div class="mt-3 grid grid-cols-3 gap-1 border-t border-gray-100 pt-3 text-center dark:border-gray-800">
          <router-link to="/actions" class="rounded py-1 hover:bg-gray-50 dark:hover:bg-gray-800/60">
            <div class="text-sm font-semibold text-gray-800 dark:text-gray-200">{{ digest.openActions.length }}</div>
            <div class="text-[10px] text-gray-400 dark:text-gray-500">open items</div>
          </router-link>
          <router-link to="/board" class="rounded py-1 hover:bg-gray-50 dark:hover:bg-gray-800/60">
            <div class="text-sm font-semibold text-gray-800 dark:text-gray-200">{{ digest.ideas.proposed.length }}</div>
            <div class="text-[10px] text-gray-400 dark:text-gray-500">proposed</div>
          </router-link>
          <router-link to="/board" class="rounded py-1 hover:bg-gray-50 dark:hover:bg-gray-800/60">
            <div class="text-sm font-semibold text-gray-800 dark:text-gray-200">{{ digest.ideas.inboxCount }}</div>
            <div class="text-[10px] text-gray-400 dark:text-gray-500">inbox ideas</div>
          </router-link>
        </div>
      </template>
    </SheetModal>

    <!-- Toast -->
    <Transition enter-from-class="translate-y-2 opacity-0" enter-active-class="transition" leave-to-class="opacity-0" leave-active-class="transition">
      <div v-if="toastText" class="fixed bottom-24 left-1/2 z-[60] -translate-x-1/2 rounded-full bg-gray-900 px-3.5 py-1.5 text-xs text-white shadow-lg dark:bg-gray-100 dark:text-gray-900">{{ toastText }}</div>
    </Transition>
  </div>
</template>
