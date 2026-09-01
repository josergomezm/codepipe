<script setup lang="ts">
import { computed } from 'vue'
import { personaAvatarUrl, type Persona } from '@/api/client'

const props = withDefaults(
  defineProps<{
    persona: Persona | null
    size?: 'sm' | 'md'
  }>(),
  { size: 'md' },
)

const avatarUrl = computed(() => (props.persona ? personaAvatarUrl(props.persona) : null))
const initial = computed(() => props.persona?.name.charAt(0).toUpperCase() ?? '?')

// A stable pastel per persona so initials-avatars are distinguishable
const PALETTE = [
  'bg-purple-200 text-purple-800 dark:bg-purple-900/60 dark:text-purple-300',
  'bg-teal-200 text-teal-800 dark:bg-teal-900/60 dark:text-teal-300',
  'bg-amber-200 text-amber-800 dark:bg-amber-900/60 dark:text-amber-300',
  'bg-rose-200 text-rose-800 dark:bg-rose-900/60 dark:text-rose-300',
  'bg-sky-200 text-sky-800 dark:bg-sky-900/60 dark:text-sky-300',
]
const colorClass = computed(() => {
  const id = props.persona?.id ?? ''
  let hash = 0
  for (const ch of id) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0
  return PALETTE[hash % PALETTE.length]
})

const sizeClass = computed(() =>
  props.size === 'sm' ? 'h-6 w-6 text-[10px]' : 'h-8 w-8 text-xs',
)
</script>

<template>
  <img
    v-if="avatarUrl"
    :src="avatarUrl"
    :alt="persona?.name"
    class="shrink-0 rounded-full object-cover"
    :class="sizeClass"
  />
  <div
    v-else
    class="flex shrink-0 items-center justify-center rounded-full font-medium"
    :class="[sizeClass, colorClass]"
  >
    {{ initial }}
  </div>
</template>
