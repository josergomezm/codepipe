<script setup lang="ts">
import { ref } from 'vue'
import type { ProviderType } from '@/api/client'
import { useSessionsStore } from '@/stores/sessions'
import { useProjectsStore } from '@/stores/projects'
import ProjectSelector from '@/components/ProjectSelector.vue'
import ProviderSelector from '@/components/ProviderSelector.vue'

const sessionsStore = useSessionsStore()
const projectsStore = useProjectsStore()

const open = ref(false)
const selectedProjectId = ref('')
const selectedProvider = ref<ProviderType>('kiro')

function toggle() {
  if (projectsStore.projects.length === 0) {
    alert('Add a project first before starting a chat.')
    return
  }
  open.value = !open.value
  if (open.value && !selectedProjectId.value) {
    selectedProjectId.value = projectsStore.projects[0].id
  }
}

async function start() {
  if (!selectedProjectId.value) return
  open.value = false
  const session = await sessionsStore.createSession(selectedProvider.value, selectedProjectId.value)
  await sessionsStore.selectSession(session.id)
}
</script>

<template>
  <div class="relative">
    <button
      class="flex w-full items-center gap-2 rounded-lg border border-gray-200 px-3 py-2 text-sm font-medium text-gray-700 transition hover:bg-gray-100 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
      @click="toggle"
    >
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" class="h-4 w-4">
        <path d="M10.75 4.75a.75.75 0 0 0-1.5 0v4.5h-4.5a.75.75 0 0 0 0 1.5h4.5v4.5a.75.75 0 0 0 1.5 0v-4.5h4.5a.75.75 0 0 0 0-1.5h-4.5v-4.5Z" />
      </svg>
      New Chat
    </button>

    <div
      v-if="open"
      class="absolute left-0 right-0 top-full z-10 mt-1 flex flex-col gap-2 rounded-lg border border-gray-200 bg-white p-3 shadow-lg dark:border-gray-700 dark:bg-gray-800"
    >
      <label class="text-xs font-medium text-gray-500 dark:text-gray-400">Project</label>
      <ProjectSelector v-model="selectedProjectId" />

      <label class="mt-1 text-xs font-medium text-gray-500 dark:text-gray-400">Provider</label>
      <ProviderSelector v-model="selectedProvider" />

      <button
        :disabled="!selectedProjectId"
        class="mt-1 rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-blue-700 disabled:opacity-40"
        @click="start"
      >
        Start Chat
      </button>
    </div>
  </div>
</template>
