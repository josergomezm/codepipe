<script setup lang="ts">
import { onMounted } from 'vue'
import { useSessionsStore } from '@/stores/sessions'
import { useProjectsStore } from '@/stores/projects'
import { useUiStore } from '@/stores/ui'
import AppSidebar from '@/components/AppSidebar.vue'

const sessionsStore = useSessionsStore()
const projectsStore = useProjectsStore()
const ui = useUiStore()

function openSessionFromId(sessionId: string | null | undefined) {
  if (sessionId) sessionsStore.selectSession(sessionId)
}

onMounted(async () => {
  await Promise.all([
    sessionsStore.fetchSessions(),
    projectsStore.fetchProjects(),
  ])

  // Deep-link: opened from a push notification (/?session=<id>).
  const fromUrl = new URLSearchParams(window.location.search).get('session')
  if (fromUrl) {
    openSessionFromId(fromUrl)
    // Clean the URL so a refresh doesn't keep forcing this session.
    window.history.replaceState({}, '', window.location.pathname)
  }

  // Notification tapped while the app was already open.
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', (event) => {
      if (event.data?.type === 'open-session') openSessionFromId(event.data.sessionId)
    })
  }
})
</script>

<template>
  <div class="flex h-screen bg-white text-gray-900 dark:bg-gray-950 dark:text-gray-100">
    <!-- Mobile backdrop -->
    <Transition
      enter-active-class="transition-opacity duration-200"
      enter-from-class="opacity-0"
      enter-to-class="opacity-100"
      leave-active-class="transition-opacity duration-150"
      leave-from-class="opacity-100"
      leave-to-class="opacity-0"
    >
      <div
        v-if="ui.sidebarOpen"
        class="fixed inset-0 z-30 bg-black/40 md:hidden"
        @click="ui.closeSidebar()"
      />
    </Transition>

    <AppSidebar />
    <main class="flex-1 overflow-hidden">
      <router-view />
    </main>
  </div>
</template>
