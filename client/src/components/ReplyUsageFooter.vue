<script setup lang="ts">
import { computed, ref } from 'vue'
import type { ChatMessage } from '@/api/client'

/**
 * The cost / tokens / time line under a finished assistant reply. Tap it for
 * the breakdown (works on phones, unlike a hover tooltip).
 *
 *  - Claude (metadata.usage): this reply's cost + tokens; conversation total
 *    and cache split in the details.
 *  - Older Claude replies (a bare "$x"): that was Claude Code's running total
 *    for the whole conversation, not the reply — labelled as such.
 *  - Kiro: bare credit numbers ("0.15"). Antigravity/Gemini: "24.7k tokens".
 */
const props = defineProps<{ metadata: NonNullable<ChatMessage['metadata']> }>()

const open = ref(false)
const usage = computed(() => props.metadata.usage ?? null)
const credits = computed(() => props.metadata.credits ?? '')
const isLegacyClaudeTotal = computed(() => !usage.value && credits.value.startsWith('$'))

function usd(n: number): string {
  return `$${n < 1 ? n.toFixed(4) : n.toFixed(2)}`
}
function compact(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`
  return `${(n / 1_000_000).toFixed(1)}M`
}
const full = (n: number) => n.toLocaleString()

const inputTotal = computed(() => (usage.value ? usage.value.inputTokens + usage.value.cacheReadTokens + usage.value.cacheWriteTokens : 0))

const summary = computed(() => {
  if (usage.value) return usd(usage.value.costUsd)
  if (isLegacyClaudeTotal.value) return `${usd(Number(credits.value.slice(1)) || 0)} total`
  return /^[\d.]+$/.test(credits.value) ? `Credits: ${credits.value}` : credits.value
})

const expandable = computed(() => !!usage.value || isLegacyClaudeTotal.value)
</script>

<template>
  <div class="mt-2 border-t border-gray-200 pt-1.5 text-xs text-gray-400 dark:border-gray-700 dark:text-gray-500">
    <component
      :is="expandable ? 'button' : 'div'"
      class="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-left"
      :class="expandable && 'rounded transition hover:text-gray-600 dark:hover:text-gray-300'"
      :aria-expanded="expandable ? open : undefined"
      :title="expandable ? 'Show cost details' : undefined"
      @click="expandable && (open = !open)"
    >
      <span v-if="summary" :class="isLegacyClaudeTotal && 'italic'">{{ summary }}</span>
      <template v-if="usage">
        <span :title="`${full(inputTotal)} input tokens`">{{ compact(inputTotal) }} in</span>
        <span :title="`${full(usage.outputTokens)} output tokens`">{{ compact(usage.outputTokens) }} out</span>
      </template>
      <span v-if="metadata.time">{{ metadata.time }}</span>
    </component>

    <div v-if="open && usage" class="mt-1.5 grid grid-cols-[auto_1fr] gap-x-4 gap-y-0.5 rounded-lg bg-gray-50 px-2.5 py-2 text-[11px] text-gray-500 dark:bg-gray-900/60 dark:text-gray-400">
      <span>This reply</span><span class="text-right tabular-nums text-gray-700 dark:text-gray-200">{{ usd(usage.costUsd) }}</span>
      <template v-if="usage.sessionCostUsd != null">
        <span>Conversation so far</span><span class="text-right tabular-nums">{{ usd(usage.sessionCostUsd) }}</span>
      </template>
      <span class="mt-1">Input</span><span class="mt-1 text-right tabular-nums">{{ full(inputTotal) }}</span>
      <span class="pl-3">read from cache</span><span class="text-right tabular-nums">{{ full(usage.cacheReadTokens) }}</span>
      <span class="pl-3">written to cache</span><span class="text-right tabular-nums">{{ full(usage.cacheWriteTokens) }}</span>
      <span class="pl-3">uncached</span><span class="text-right tabular-nums">{{ full(usage.inputTokens) }}</span>
      <span>Output</span><span class="text-right tabular-nums">{{ full(usage.outputTokens) }}</span>
      <p class="col-span-2 mt-1.5 leading-snug text-gray-400 dark:text-gray-500">
        Claude Code's estimate at API list prices. On a Claude subscription you aren't billed per token. Most input is
        the conversation re-read from cache each turn, which is why input runs high.
      </p>
    </div>
    <p v-else-if="open && isLegacyClaudeTotal" class="mt-1.5 rounded-lg bg-gray-50 px-2.5 py-2 text-[11px] leading-snug text-gray-500 dark:bg-gray-900/60 dark:text-gray-400">
      Recorded before per-reply costs: this is Claude Code's running total for the whole conversation so far
      (API list-price estimate), not what this reply cost. New replies show their own cost and tokens.
    </p>
  </div>
</template>
