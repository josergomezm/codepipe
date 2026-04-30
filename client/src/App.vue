<script setup lang="ts">
import { onMounted } from 'vue'
import { useSessionsStore } from '@/stores/sessions'
import { useProjectsStore } from '@/stores/projects'
import AppSidebar from '@/components/AppSidebar.vue'

const sessionsStore = useSessionsStore()
const projectsStore = useProjectsStore()

onMounted(async () => {
  await Promise.all([
    sessionsStore.fetchSessions(),
    projectsStore.fetchProjects(),
  ])
})
</script>

<template>
  <div class="flex h-screen bg-white text-gray-900 dark:bg-gray-950 dark:text-gray-100">
    <AppSidebar />
    <main class="flex-1 overflow-hidden">
      <router-view />
    </main>
  </div>
</template>
