<script setup lang="ts">
import { reactive, ref } from 'vue'
import type { Persona } from '@/api/client'
import PersonaAvatar from '@/components/PersonaAvatar.vue'
import type { SampleBriefing } from '@/lib/briefing-preview'
import { formatWhen } from '@/lib/files'

/**
 * The lead's daily briefing, as one message in their thread: today's top 3,
 * a focus check (where your week went vs. your Focus list), what moved,
 * suggested items, stale things to clear, and the team's notes.
 * Every button here is a preview — it changes only this page.
 */
defineProps<{ briefing: SampleBriefing; lead: Persona | null; personas: Map<string, Persona>; compact?: boolean }>()
const emit = defineEmits<{
  'open-session': [id: string]
  'accept-focus': [s: SampleBriefing['focusSuggestions'][number]]
  toast: [text: string]
}>()

/** Outcome of each actionable row, by id. */
const done = reactive(new Map<string, string>())
const showTeam = ref(false)

function mark(id: string, outcome: string, toast: string) {
  done.set(id, outcome)
  emit('toast', toast)
}

function acceptFocus(s: SampleBriefing['focusSuggestions'][number]) {
  done.set(s.id, s.kind === 'add' ? 'Added to Focus' : 'Removed from Focus')
  emit('accept-focus', s)
}

const pct = (n: number) => `${Math.round(n * 100)}%`
</script>

<template>
  <div class="flex items-start gap-2.5">
    <PersonaAvatar v-if="lead" :persona="lead" size="sm" class="mt-1 shrink-0" />
    <div class="min-w-0 flex-1 overflow-hidden rounded-2xl rounded-tl-md border border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-900">
      <!-- Header -->
      <div class="border-b border-gray-100 px-4 pb-3 pt-3 dark:border-gray-800">
        <div class="flex items-baseline gap-1.5 text-xs">
          <span class="font-semibold text-gray-800 dark:text-gray-200">{{ lead?.name ?? 'Team lead' }}</span>
          <span class="text-gray-400 dark:text-gray-500">Daily brief · {{ formatWhen(briefing.at) }}</span>
        </div>
        <p class="mt-1 text-[15px] font-semibold leading-snug text-gray-900 dark:text-gray-50">{{ briefing.headline }}</p>
      </div>

      <div v-if="!compact" class="flex flex-col divide-y divide-gray-100 dark:divide-gray-800">
        <!-- Today -->
        <section class="px-4 py-3">
          <h4 class="mb-2 text-[11px] font-semibold uppercase tracking-wide text-gray-400 dark:text-gray-500">Today</h4>
          <ol class="flex flex-col gap-2">
            <li v-for="(t, i) in briefing.top3" :key="i" class="flex gap-2.5">
              <span class="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-violet-600 text-[11px] font-semibold text-white">{{ i + 1 }}</span>
              <div class="min-w-0">
                <button
                  v-if="t.sessionId"
                  class="text-left text-sm font-medium text-gray-900 hover:text-violet-700 hover:underline dark:text-gray-100 dark:hover:text-violet-300"
                  @click="emit('open-session', t.sessionId)"
                >{{ t.text }} →</button>
                <p v-else class="text-sm font-medium text-gray-900 dark:text-gray-100">{{ t.text }}</p>
                <p class="text-xs text-gray-500 dark:text-gray-400">{{ t.why }}</p>
              </div>
            </li>
          </ol>
        </section>

        <!-- Focus check -->
        <section class="px-4 py-3">
          <h4 class="mb-2 text-[11px] font-semibold uppercase tracking-wide text-gray-400 dark:text-gray-500">Focus check · what you sent, last 24 hours</h4>
          <p v-if="!briefing.activity.length" class="text-xs text-gray-500 dark:text-gray-400">You didn't send anything in the last 24 hours.</p>
          <div v-if="briefing.driftNote" class="mb-3 rounded-lg bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-800 dark:bg-amber-900/20 dark:text-amber-300">
            {{ briefing.driftNote }}
          </div>
          <div class="flex flex-col gap-1.5">
            <div v-for="row in briefing.activity" :key="row.projectId" class="grid grid-cols-[minmax(0,9rem)_1fr_auto] items-center gap-2 text-xs">
              <span class="truncate text-gray-700 dark:text-gray-300" :title="row.projectName">{{ row.projectName }}</span>
              <div class="h-2 overflow-hidden rounded-full bg-gray-100 dark:bg-gray-800">
                <div class="h-full rounded-full" :class="row.inFocus ? 'bg-violet-500' : 'bg-amber-400'" :style="{ width: pct(row.share24) }" />
              </div>
              <span class="w-20 text-right tabular-nums text-gray-500 dark:text-gray-400" :title="`${row.mine24} today, ${row.mine7} this week`">{{ row.mine24 }} <span class="text-gray-300 dark:text-gray-600">· {{ row.mine7 }} wk</span></span>
            </div>
            <div class="mt-1 flex gap-3 text-[10px] text-gray-400 dark:text-gray-500">
              <span class="inline-flex items-center gap-1"><span class="h-2 w-2 rounded-full bg-violet-500" /> on your Focus list</span>
              <span class="inline-flex items-center gap-1"><span class="h-2 w-2 rounded-full bg-amber-400" /> not on it</span>
            </div>
          </div>
          <div v-if="briefing.focusSuggestions.length" class="mt-3 flex flex-col gap-1.5">
            <div
              v-for="s in briefing.focusSuggestions"
              :key="s.id"
              class="flex items-center gap-2 rounded-lg border border-dashed border-violet-300 px-2.5 py-1.5 text-xs dark:border-violet-800"
            >
              <span class="font-medium text-violet-700 dark:text-violet-300">{{ s.kind === 'add' ? 'Add to Focus' : 'Drop from Focus' }}</span>
              <span class="min-w-0 flex-1 truncate text-gray-700 dark:text-gray-300">{{ s.label }} <span class="text-gray-400 dark:text-gray-500">· {{ s.why }}</span></span>
              <span v-if="done.get(s.id)" class="shrink-0 text-green-600 dark:text-green-400">✓ {{ done.get(s.id) }}</span>
              <template v-else>
                <button class="shrink-0 rounded bg-violet-600 px-2 py-0.5 font-medium text-white hover:bg-violet-700" @click="acceptFocus(s)">Accept</button>
                <button class="shrink-0 rounded px-1.5 py-0.5 text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800" @click="mark(s.id, 'Kept as is', 'Kept your Focus list as it is')">No</button>
              </template>
            </div>
          </div>
        </section>

        <!-- Suggested items -->
        <section v-if="briefing.proposedActions.length" class="px-4 py-3">
          <h4 class="mb-2 text-[11px] font-semibold uppercase tracking-wide text-gray-400 dark:text-gray-500">Suggested action items</h4>
          <div class="flex flex-col gap-2">
            <div v-for="a in briefing.proposedActions" :key="a.id" class="flex items-start gap-2 rounded-lg bg-gray-50 px-3 py-2 dark:bg-gray-800/50">
              <div class="min-w-0 flex-1">
                <div class="flex items-center gap-1.5">
                  <span class="rounded bg-violet-100 px-1.5 text-[10px] font-medium text-violet-700 dark:bg-violet-900/40 dark:text-violet-300">{{ a.bucket }}</span>
                </div>
                <p class="mt-1 text-sm text-gray-800 dark:text-gray-200">{{ a.text }}</p>
                <p class="text-xs text-gray-500 dark:text-gray-400">{{ a.why }}</p>
              </div>
              <span v-if="done.get(a.id)" class="shrink-0 text-xs text-green-600 dark:text-green-400">✓ {{ done.get(a.id) }}</span>
              <div v-else class="flex shrink-0 flex-col gap-1">
                <button class="rounded bg-gray-900 px-2 py-0.5 text-xs font-medium text-white hover:bg-gray-700 dark:bg-gray-100 dark:text-gray-900 dark:hover:bg-white" @click="mark(a.id, 'Added', 'Preview: would add to Action items → Workspace')">Add</button>
                <button class="rounded px-2 py-0.5 text-xs text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800" @click="mark(a.id, 'Dismissed', 'Dismissed')">Dismiss</button>
              </div>
            </div>
          </div>
        </section>

        <!-- What moved -->
        <section v-if="briefing.moved.length" class="px-4 py-3">
          <h4 class="mb-2 text-[11px] font-semibold uppercase tracking-wide text-gray-400 dark:text-gray-500">What moved · last 24 hours</h4>
          <ul class="flex flex-col gap-2">
            <li v-for="m in briefing.moved" :key="m.sessionId">
              <button class="group w-full text-left" @click="emit('open-session', m.sessionId)">
                <div class="flex items-baseline gap-1.5">
                  <span class="truncate text-sm font-medium text-gray-800 group-hover:text-violet-700 group-hover:underline dark:text-gray-200 dark:group-hover:text-violet-300">{{ m.title }}</span>
                  <span class="shrink-0 text-[11px] text-gray-400 dark:text-gray-500">{{ m.projectName }}</span>
                </div>
                <p class="text-xs leading-relaxed text-gray-500 dark:text-gray-400">{{ m.summary }}</p>
              </button>
            </li>
          </ul>
        </section>

        <!-- Clean up -->
        <section v-if="briefing.stale.length || briefing.staleIdeas" class="px-4 py-3">
          <h4 class="mb-2 text-[11px] font-semibold uppercase tracking-wide text-gray-400 dark:text-gray-500">Clean up</h4>
          <div class="flex flex-col gap-1.5">
            <div v-for="s in briefing.stale" :key="s.item.id" class="flex items-center gap-2 text-xs">
              <span class="shrink-0 rounded bg-gray-100 px-1.5 tabular-nums text-gray-500 dark:bg-gray-800 dark:text-gray-400">{{ s.ageDays }}d</span>
              <span class="min-w-0 flex-1 truncate text-gray-700 dark:text-gray-300" :title="s.item.text">{{ s.item.text }} <span class="text-gray-400 dark:text-gray-500">· {{ s.projectName }}</span></span>
              <span v-if="done.get(s.item.id)" class="shrink-0 text-green-600 dark:text-green-400">✓ {{ done.get(s.item.id) }}</span>
              <template v-else>
                <button class="shrink-0 rounded px-1.5 py-0.5 text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800" @click="mark(s.item.id, 'Closed', 'Preview: would close this item')">Close</button>
                <button class="shrink-0 rounded px-1.5 py-0.5 text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800" @click="mark(s.item.id, 'Snoozed 2w', 'Preview: would snooze for 2 weeks')">Snooze</button>
              </template>
            </div>
            <div v-if="briefing.staleIdeas" class="flex items-center gap-2 text-xs">
              <span class="shrink-0 rounded bg-gray-100 px-1.5 tabular-nums text-gray-500 dark:bg-gray-800 dark:text-gray-400">{{ briefing.staleIdeas }}</span>
              <span class="min-w-0 flex-1 text-gray-700 dark:text-gray-300">ideas sitting in the board inbox</span>
              <span v-if="done.get('ideas')" class="shrink-0 text-green-600 dark:text-green-400">✓ {{ done.get('ideas') }}</span>
              <button v-else class="shrink-0 rounded px-1.5 py-0.5 text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800" @click="mark('ideas', 'Parked', 'Preview: would park the inbox ideas')">Park all</button>
            </div>
          </div>
        </section>

        <!-- Team notes -->
        <section v-if="briefing.deliberation.length" class="px-4 py-2.5">
          <button class="flex items-center gap-1.5 text-xs text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200" @click="showTeam = !showTeam">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" class="h-3 w-3 transition-transform" :class="{ 'rotate-90': showTeam }"><path fill-rule="evenodd" d="M8.22 5.22a.75.75 0 0 1 1.06 0l4.25 4.25a.75.75 0 0 1 0 1.06l-4.25 4.25a.75.75 0 0 1-1.06-1.06L11.94 10 8.22 6.28a.75.75 0 0 1 0-1.06Z" clip-rule="evenodd" /></svg>
            Team notes
            <span class="flex -space-x-1.5">
              <PersonaAvatar v-for="d in briefing.deliberation" :key="d.personaId" :persona="personas.get(d.personaId)!" size="sm" class="!h-4 !w-4 ring-2 ring-white dark:ring-gray-900" />
            </span>
          </button>
          <div v-if="showTeam" class="mt-2 flex flex-col gap-2">
            <div v-for="d in briefing.deliberation" :key="d.personaId" class="flex gap-2 text-xs">
              <PersonaAvatar :persona="personas.get(d.personaId)!" size="sm" class="mt-0.5 shrink-0" />
              <div>
                <span class="font-medium text-gray-700 dark:text-gray-300">{{ personas.get(d.personaId)?.name }}</span>
                <p class="text-gray-500 dark:text-gray-400">{{ d.text }}</p>
              </div>
            </div>
          </div>
        </section>
      </div>
    </div>
  </div>
</template>
