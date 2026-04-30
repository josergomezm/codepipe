<script setup lang="ts">
import { useProjectsStore } from '@/stores/projects'

const model = defineModel<string>({ default: '' })
const projectsStore = useProjectsStore()
</script>

<template>
  <select
    v-model="model"
    class="rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-sm text-gray-700 transition focus:border-blue-500 focus:outline-none dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300"
  >
    <option value="" disabled>Select project…</option>
    <option v-for="p in projectsStore.projects" :key="p.id" :value="p.id">
      {{ p.name }}
    </option>
  </select>
</template>
