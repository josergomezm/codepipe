<script setup lang="ts">
import type { ProviderType } from '@/api/client'

const model = defineModel<ProviderType>({ default: 'kiro' })

const providers: { value: ProviderType; label: string }[] = [
  { value: 'kiro', label: 'Kiro' },
  { value: 'gemini', label: 'Gemini' },
  { value: 'claude', label: 'Claude' },
  { value: 'codex', label: 'Codex' },
]
</script>

<template>
  <select
    v-model="model"
    class="rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-sm text-gray-700 transition focus:border-blue-500 focus:outline-none dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300"
  >
    <option v-for="p in providers" :key="p.value" :value="p.value">
      {{ p.label }}
    </option>
  </select>
</template>
