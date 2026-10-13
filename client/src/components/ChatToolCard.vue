<script setup lang="ts">
/**
 * A card an agent tool posted in a chat — an action item added, suggested
 * or closed, or an idea put on the board — with the user's one-tap
 * follow-ups (accept, dismiss, undo). Card state lives on the message
 * server-side, so it survives reloads.
 */
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useTeamStore } from '@/stores/team'
import { useSessionsStore } from '@/stores/sessions'
import * as api from '@/api/client'
import type { ChatActionCard, ChatIdeaCard, ChatMessage } from '@/api/client'

const props = defineProps<{ message: ChatMessage }>()

const router = useRouter()
const teamStore = useTeamStore()
const sessionsStore = useSessionsStore()

type Op = 'accept' | 'dismiss' | 'undo'
interface CardButton {
  label: string
  op?: Op
  to?: string
  primary?: boolean
}
interface CardView {
  tone: 'green' | 'blue' | 'gray'
  label: string
  text: string
  /** Struck through: the thing no longer stands. */
  struck: boolean
  details: string[]
  options: { label: string; recommended?: boolean }[]
  buttons: CardButton[]
}

const view = computed<CardView | null>(() => {
  const meta = props.message.metadata
  if (meta?.kind === 'action' && meta.action) return actionView(meta.action)
  if (meta?.kind === 'idea' && meta.idea) return ideaView(meta.idea)
  return null
})

function actionView(card: ChatActionCard): CardView {
  const { draft } = card
  const base = { text: draft.text, details: [] as string[], options: [] as CardView['options'] }
  const due = draft.dueDate ? [`Due ${draft.dueDate}`] : []
  switch (card.state) {
    case 'added':
      return { ...base, tone: 'green', label: '✓ Added to your action items', struck: false, details: due,
        buttons: [{ label: 'View list', to: '/actions', primary: true }, { label: 'Undo', op: 'undo' }] }
    case 'suggested':
      return {
        ...base, tone: 'blue', label: 'Suggested action item', struck: false,
        details: [
          ...(draft.notes ? [draft.notes] : []),
          ...(draft.steps?.length ? [`${draft.steps.length} step${draft.steps.length === 1 ? '' : 's'} included`] : []),
          ...due,
        ],
        options: draft.options ?? [],
        buttons: [{ label: 'Add to my list', op: 'accept', primary: true }, { label: 'Dismiss', op: 'dismiss' }],
      }
    case 'closed':
      return {
        ...base, tone: 'green', label: card.declined ? '✓ Marked as won’t do' : '✓ Closed on your list', struck: true,
        details: card.resolution ? [card.resolution] : [],
        buttons: [{ label: 'View list', to: '/actions', primary: true }, { label: 'Reopen', op: 'undo' }],
      }
    case 'reopened':
      return { ...base, tone: 'gray', label: 'Reopened on your list', struck: false, buttons: [{ label: 'View list', to: '/actions' }] }
    case 'undone':
      return { ...base, tone: 'gray', label: 'Removed from your action items', struck: true, buttons: [{ label: 'Add again', op: 'accept' }] }
    case 'dismissed':
      return { ...base, tone: 'gray', label: 'Suggestion dismissed', struck: true, buttons: [{ label: 'Add anyway', op: 'accept' }] }
  }
}

function ideaView(card: ChatIdeaCard): CardView {
  return card.state === 'added'
    ? { tone: 'green', label: '✓ Added to the Ideas board', text: card.text, struck: false,
        details: card.notes ? [card.notes] : [], options: [],
        buttons: [{ label: 'View board', to: '/board', primary: true }, { label: 'Undo', op: 'undo' }] }
    : { tone: 'gray', label: 'Removed from the Ideas board', text: card.text, struck: true, details: [], options: [],
        buttons: [{ label: 'Add again', op: 'accept' }] }
}

const busy = ref(false)
const error = ref<string | null>(null)

async function press(button: CardButton) {
  if (button.to) {
    router.push(button.to)
    return
  }
  const sessionId = sessionsStore.activeSessionId
  if (!button.op || !sessionId || busy.value) return
  busy.value = true
  error.value = null
  try {
    // The server also re-broadcasts the amended message; this is the fast path.
    const card = await api.cardOp(sessionId, props.message.id, button.op)
    const kind = props.message.metadata?.kind
    props.message.metadata = { ...props.message.metadata, ...(kind === 'idea' ? { idea: card as ChatIdeaCard } : { action: card as ChatActionCard }) }
    if (kind === 'idea') teamStore.fetchTodos()
    else teamStore.fetchActions()
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Something went wrong'
  } finally {
    busy.value = false
  }
}

const TONES = {
  green: { box: 'border-green-200 bg-green-50 dark:border-green-800/40 dark:bg-green-900/15', label: 'text-green-700 dark:text-green-400', primary: 'font-medium text-green-700 hover:underline dark:text-green-400' },
  blue: { box: 'border-blue-200 bg-blue-50 dark:border-blue-800/40 dark:bg-blue-900/15', label: 'text-blue-700 dark:text-blue-400', primary: 'rounded-lg bg-blue-600 px-3 py-1 font-medium text-white transition hover:bg-blue-700' },
  gray: { box: 'border-gray-200 bg-gray-50 dark:border-gray-700 dark:bg-gray-900/40', label: 'text-gray-400 dark:text-gray-500', primary: 'font-medium text-gray-600 hover:underline dark:text-gray-300' },
} as const
</script>

<template>
  <div v-if="view" class="flex justify-center px-4 py-2">
    <div class="w-full max-w-md rounded-xl border px-4 py-3" :class="TONES[view.tone].box">
      <p class="text-[11px] font-semibold uppercase tracking-wider" :class="TONES[view.tone].label">{{ view.label }}</p>
      <p
        class="mt-1 text-sm"
        :class="view.struck ? 'text-gray-500 line-through dark:text-gray-400' : 'text-gray-900 dark:text-gray-100'"
      >{{ view.text }}</p>
      <p
        v-for="(d, i) in view.details"
        :key="i"
        class="mt-1 whitespace-pre-wrap text-xs text-gray-600 dark:text-gray-400"
      >{{ d }}</p>
      <div v-if="view.options.length" class="mt-1.5 flex flex-wrap gap-1">
        <span
          v-for="o in view.options"
          :key="o.label"
          class="rounded-full border border-blue-200 bg-white px-2 py-0.5 text-[11px] text-gray-700 dark:border-blue-800/50 dark:bg-gray-900 dark:text-gray-300"
        >{{ o.label }}<template v-if="o.recommended"> ★</template></span>
      </div>

      <div class="mt-2 flex items-center gap-3 text-xs">
        <button
          v-for="b in view.buttons"
          :key="b.label"
          :disabled="busy && !!b.op"
          class="disabled:opacity-50"
          :class="b.primary ? TONES[view.tone].primary : 'text-gray-500 hover:underline dark:text-gray-400'"
          @click="press(b)"
        >{{ b.label }}</button>
      </div>
      <p v-if="error" class="mt-1 text-xs text-red-600 dark:text-red-400">{{ error }}</p>
    </div>
  </div>
</template>
