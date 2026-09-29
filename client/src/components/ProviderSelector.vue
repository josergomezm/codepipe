<script setup lang="ts">
import { PROVIDER_LABELS, type ProviderType } from '@/api/client'

const model = defineModel<ProviderType>({ default: 'kiro' })

const providers = (Object.keys(PROVIDER_LABELS) as ProviderType[]).map((value) => ({
  value,
  label: PROVIDER_LABELS[value],
}))
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
