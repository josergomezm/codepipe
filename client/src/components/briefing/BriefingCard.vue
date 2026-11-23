<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import * as api from '@/api/client'
import { MAX_FOCUS_ITEMS, type Brief } from '@/api/client'
import { useTeamStore } from '@/stores/team'
import { useLeadStore } from '@/stores/lead'
import { useSessionsStore } from '@/stores/sessions'
import PersonaAvatar from '@/components/PersonaAvatar.vue'
import { dayLabel, formatWhen } from '@/lib/files'

/**
 * The lead's daily brief, as posted by post_brief: today's top 3, chats
 * waiting on you, the focus check (your day vs. your Focus list, with the
 * lead's suggested changes), what got done, what it updated on your items
 * (each undoable), and items to clean up.
 * Buttons act for real; their state is read back from your Focus list and
 * action items, so a reload shows what you already did.
 */
const props = defineProps<{ brief: Brief }>()

const team = useTeamStore()
const lead = useLeadStore()
const sessions = useSessionsStore()
const router = useRouter()

const leadPersona = computed(() => team.lead)
const busy = ref<string | null>(null)
const note = ref<string | null>(null)

function openChat(sessionId: string) {
  void sessions.selectSession(sessionId)
  router.push('/')
}

// ----- Focus check -----

const focusProjects = computed(() => new Set(lead.focus.map((f) => f.projectId).filter(Boolean)))
const total24 = computed(() => props.brief.activity.reduce((n, a) => n + a.mine24, 0))
const pct = (n: number) => `${total24.value ? Math.round((n / total24.value) * 100) : 0}%`

type Suggestion = Brief['focusCheck']['suggestions'][number]

function suggestionDone(s: Suggestion): boolean {
  if (s.kind === 'add') return lead.focus.some((f) => f.label.toLowerCase() === s.label.toLowerCase())
  return !!s.focusItemId && !lead.focus.some((f) => f.id === s.focusItemId)
}

async function accept(s: Suggestion) {
  note.value = null
  if (s.kind === 'add') {
    if (lead.focus.length >= MAX_FOCUS_ITEMS) { note.value = `Your Focus list is full (${MAX_FOCUS_ITEMS}) — drop one first.`; return }
    await lead.saveFocus([...lead.focus, { id: crypto.randomUUID(), label: s.label, ...(s.projectId ? { projectId: s.projectId } : {}) }])
  } else if (s.focusItemId) {
    await lead.saveFocus(lead.focus.filter((f) => f.id !== s.focusItemId))
  }
}

const VERDICT = {
  on_plan: { label: 'On plan', cls: 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300' },
  shifted: { label: 'Focus shifted', cls: 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300' },
  mixed: { label: 'Your call', cls: 'bg-violet-100 text-violet-800 dark:bg-violet-900/30 dark:text-violet-300' },
} as const

/** A Today item that opens its chat or the action list. */
const linkText = 'text-left text-sm font-medium text-gray-900 hover:text-violet-700 hover:underline dark:text-gray-100 dark:hover:text-violet-300'

// ----- Updated -----

/** The lead's 'updated' card for an update, as it stands now (undo flips it). */
function updateReverted(messageId: string): boolean {
  return sessions.activeMessages.find((m) => m.id === messageId)?.metadata?.action?.state === 'reverted'
}

async function undoUpdate(messageId: string) {
  const sessionId = sessions.activeSessionId
  if (!sessionId) return
  busy.value = messageId
  note.value = null
  try {
    await api.cardOp(sessionId, messageId, 'undo')
    await team.fetchActions()
  } catch (e) {
    note.value = e instanceof Error ? e.message : 'Could not undo that update'
  } finally {
    busy.value = null
  }
}

// ----- Clean up -----

function itemState(itemId: string): 'open' | 'closed' | 'snoozed' {
  const item = team.actions.find((a) => a.id === itemId)
  if (!item || item.status !== 'open') return 'closed'
  return item.snoozedUntil && item.snoozedUntil > Date.now() ? 'snoozed' : 'open'
}

async function cleanUp(itemId: string, how: 'close' | 'snooze') {
  busy.value = itemId
  note.value = null
  try {
    await api.updateActionItem(itemId, how === 'close' ? { status: 'done' } : { snoozedUntil: Date.now() + 14 * 86_400_000 })
    await team.fetchActions()
  } catch (e) {
    note.value = e instanceof Error ? e.message : 'Could not update the item'
  } finally {
    busy.value = null
  }
}

const sectionTitle = 'mb-2 text-[11px] font-semibold uppercase tracking-wide text-gray-400 dark:text-gray-500'
const smallBtn = 'shrink-0 rounded px-1.5 py-0.5 text-gray-600 hover:bg-gray-100 disabled:opacity-50 dark:text-gray-300 dark:hover:bg-gray-800'
</script>

<template>
  <div class="flex items-start gap-2.5 px-4 py-1">
    <PersonaAvatar v-if="leadPersona" :persona="leadPersona" size="sm" class="mt-1 shrink-0" />
    <div class="min-w-0 flex-1 overflow-hidden rounded-2xl rounded-tl-md border border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-900">
      <!-- Header -->
      <div class="border-b border-gray-100 px-4 pb-3 pt-3 dark:border-gray-800">
        <div class="flex items-baseline gap-1.5 text-xs">
          <span class="font-semibold text-gray-800 dark:text-gray-200">{{ leadPersona?.name ?? 'Team lead' }}</span>
          <span class="text-gray-400 dark:text-gray-500">Daily brief · {{ formatWhen(brief.at) }}</span>
        </div>
        <p class="mt-1 text-[15px] font-semibold leading-snug text-gray-900 dark:text-gray-50">{{ brief.headline }}</p>
      </div>

      <div class="flex flex-col divide-y divide-gray-100 dark:divide-gray-800">
        <!-- Today -->
        <section v-if="brief.top3.length" class="px-4 py-3">
          <h4 :class="sectionTitle">Today</h4>
          <ol class="flex flex-col gap-2">
            <li v-for="(t, i) in brief.top3" :key="i" class="flex gap-2.5">
              <span class="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-violet-600 text-[11px] font-semibold text-white dark:bg-violet-500">{{ i + 1 }}</span>
              <div class="min-w-0">
                <button
                  v-if="t.sessionId"
                  :class="linkText"
                  @click="openChat(t.sessionId)"
                >{{ t.text }} →</button>
                <button
                  v-else-if="t.itemId"
                  :class="itemState(t.itemId) === 'closed' ? 'text-left text-sm font-medium text-gray-400 line-through dark:text-gray-500' : linkText"
                  @click="router.push('/actions')"
                >{{ t.text }} →</button>
                <p v-else class="text-sm font-medium text-gray-900 dark:text-gray-100">{{ t.text }}</p>
                <p class="text-xs text-gray-500 dark:text-gray-400">{{ t.why }}</p>
              </div>
            </li>
          </ol>
        </section>

        <!-- Waiting on you -->
        <section v-if="brief.waiting.length" class="px-4 py-3">
          <h4 :class="sectionTitle">Waiting on you · {{ brief.waiting.length }}</h4>
          <ul class="flex flex-col gap-2">
            <li v-for="w in brief.waiting" :key="w.sessionId">
              <button class="group w-full text-left" @click="openChat(w.sessionId)">
                <div class="flex items-baseline gap-1.5">
                  <span class="truncate text-sm font-medium text-gray-800 group-hover:text-violet-700 group-hover:underline dark:text-gray-200 dark:group-hover:text-violet-300">{{ w.title }}</span>
                  <span class="shrink-0 text-[11px] text-gray-400 dark:text-gray-500">{{ w.projectName }}</span>
                </div>
                <p class="text-xs italic leading-relaxed text-gray-500 dark:text-gray-400">“{{ w.question }}”</p>
              </button>
            </li>
          </ul>
        </section>

        <!-- Focus check -->
        <section class="px-4 py-3">
          <div class="mb-2 flex items-center gap-2">
            <h4 class="text-[11px] font-semibold uppercase tracking-wide text-gray-400 dark:text-gray-500">Focus check</h4>
            <span class="rounded-full px-1.5 py-0.5 text-[10px] font-medium" :class="VERDICT[brief.focusCheck.verdict].cls">{{ VERDICT[brief.focusCheck.verdict].label }}</span>
          </div>
          <p class="text-xs leading-relaxed text-gray-700 dark:text-gray-300">{{ brief.focusCheck.note }}</p>
          <p v-if="brief.focusCheck.question" class="mt-2 rounded-lg bg-violet-50 px-3 py-2 text-xs font-medium leading-relaxed text-violet-800 dark:bg-violet-900/20 dark:text-violet-200">
            {{ brief.focusCheck.question }} <span class="font-normal text-violet-600 dark:text-violet-300">— reply below.</span>
          </p>

          <div v-if="brief.activity.length" class="mt-3 flex flex-col gap-1.5">
            <div v-for="row in brief.activity" :key="row.projectId" class="grid grid-cols-[minmax(0,9rem)_1fr_auto] items-center gap-2 text-xs">
              <span class="truncate text-gray-700 dark:text-gray-300" :title="row.projectName">{{ row.projectName }}</span>
              <div class="h-2 overflow-hidden rounded-full bg-gray-100 dark:bg-gray-800">
                <div class="h-full rounded-full" :class="focusProjects.has(row.projectId) ? 'bg-violet-500 dark:bg-violet-400' : 'bg-amber-400 dark:bg-amber-500'" :style="{ width: pct(row.mine24) }" />
              </div>
              <span class="w-20 text-right tabular-nums text-gray-500 dark:text-gray-400" :title="`${row.mine24} in 24h, ${row.mine7} in 7 days`">{{ row.mine24 }} <span class="text-gray-300 dark:text-gray-600">· {{ row.mine7 }} wk</span></span>
            </div>
            <div class="mt-1 flex flex-wrap gap-x-3 text-[10px] text-gray-400 dark:text-gray-500">
              <span class="inline-flex items-center gap-1"><span class="h-2 w-2 rounded-full bg-violet-500 dark:bg-violet-400" /> on your Focus list</span>
              <span class="inline-flex items-center gap-1"><span class="h-2 w-2 rounded-full bg-amber-400 dark:bg-amber-500" /> not on it</span>
              <span>your messages · today · this week</span>
            </div>
          </div>

          <div v-if="brief.focusCheck.suggestions.length" class="mt-3 flex flex-col gap-1.5">
            <div
              v-for="(s, i) in brief.focusCheck.suggestions"
              :key="i"
              class="flex items-start gap-2 rounded-lg border border-dashed border-violet-300 px-2.5 py-1.5 text-xs dark:border-violet-800"
            >
              <div class="min-w-0 flex-1">
                <span class="font-medium text-violet-700 dark:text-violet-300">{{ s.kind === 'add' ? 'Add to Focus: ' : 'Drop from Focus: ' }}</span>
                <span class="text-gray-700 dark:text-gray-300">{{ s.label }}</span>
                <p class="text-gray-400 dark:text-gray-500">{{ s.why }}</p>
              </div>
              <span v-if="suggestionDone(s)" class="shrink-0 text-green-600 dark:text-green-400">✓ {{ s.kind === 'add' ? 'In Focus' : 'Dropped' }}</span>
              <button v-else class="shrink-0 rounded bg-violet-600 px-2 py-0.5 font-medium text-white hover:bg-violet-700" @click="accept(s)">Accept</button>
            </div>
          </div>
        </section>

        <!-- Done -->
        <section v-if="brief.done.length" class="px-4 py-3">
          <h4 :class="sectionTitle">Done since {{ dayLabel(brief.since) }}</h4>
          <ul class="flex flex-col gap-1">
            <li v-for="(d, i) in brief.done" :key="i" class="flex gap-2 text-xs text-gray-700 dark:text-gray-300">
              <span class="text-green-500 dark:text-green-400">✓</span>
              <span class="min-w-0">{{ d.text }}<span v-if="d.projectName" class="text-gray-400 dark:text-gray-500"> · {{ d.projectName }}</span></span>
            </li>
          </ul>
        </section>

        <!-- What the lead updated on your items this run -->
        <section v-if="brief.updates?.length" class="px-4 py-3">
          <h4 :class="sectionTitle">Updated</h4>
          <div class="flex flex-col gap-1.5">
            <div v-for="u in brief.updates" :key="u.messageId" class="flex items-start gap-2 text-xs">
              <div class="min-w-0 flex-1">
                <p class="text-gray-700 dark:text-gray-300" :class="{ 'line-through opacity-60': updateReverted(u.messageId) }">{{ u.text }}</p>
                <p class="text-gray-400 dark:text-gray-500">{{ u.change }}</p>
              </div>
              <span v-if="updateReverted(u.messageId)" class="shrink-0 text-gray-400 dark:text-gray-500">Undone</span>
              <button v-else :class="smallBtn" :disabled="busy === u.messageId" @click="undoUpdate(u.messageId)">Undo</button>
            </div>
          </div>
        </section>

        <!-- Clean up -->
        <section v-if="brief.cleanUp.length" class="px-4 py-3">
          <h4 :class="sectionTitle">Clean up</h4>
          <div class="flex flex-col gap-1.5">
            <div v-for="c in brief.cleanUp" :key="c.itemId" class="flex items-start gap-2 text-xs">
              <span class="mt-px shrink-0 rounded bg-gray-100 px-1.5 tabular-nums text-gray-500 dark:bg-gray-800 dark:text-gray-400">{{ c.ageDays }}d</span>
              <div class="min-w-0 flex-1">
                <p class="truncate text-gray-700 dark:text-gray-300" :title="c.text">{{ c.text }} <span class="text-gray-400 dark:text-gray-500">· {{ c.projectName }}</span></p>
                <p class="text-gray-400 dark:text-gray-500">{{ c.why }}</p>
              </div>
              <template v-if="itemState(c.itemId) === 'open'">
                <button :class="smallBtn" :disabled="busy === c.itemId" @click="cleanUp(c.itemId, 'close')">Close</button>
                <button :class="smallBtn" :disabled="busy === c.itemId" @click="cleanUp(c.itemId, 'snooze')">Snooze 2w</button>
              </template>
              <span v-else class="shrink-0 text-green-600 dark:text-green-400">✓ {{ itemState(c.itemId) === 'snoozed' ? 'Snoozed' : 'Closed' }}</span>
            </div>
          </div>
        </section>

        <p v-if="note" class="px-4 py-2 text-xs text-amber-700 dark:text-amber-400">{{ note }}</p>
      </div>
    </div>
  </div>
</template>
