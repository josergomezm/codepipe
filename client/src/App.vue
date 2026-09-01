<script setup lang="ts">
import { onMounted, onUnmounted } from 'vue'
import { useRouter } from 'vue-router'
import { useSessionsStore } from '@/stores/sessions'
import { useProjectsStore } from '@/stores/projects'
import { useTeamStore } from '@/stores/team'
import { useUiStore } from '@/stores/ui'
import { startEvents } from '@/composables/useEvents'
import AppSidebar from '@/components/AppSidebar.vue'

const sessionsStore = useSessionsStore()
const projectsStore = useProjectsStore()
const teamStore = useTeamStore()
const ui = useUiStore()
const router = useRouter()

async function openSessionFromId(sessionId: string | null | undefined) {
  if (!sessionId) return
  // Scheduled standups create sessions in the background — refresh the list
  // first so the sidebar and header know about the session being opened.
  if (!sessionsStore.sessions.some((s) => s.id === sessionId)) {
    await sessionsStore.fetchSessions()
  }
  sessionsStore.selectSession(sessionId)
  // A notification tap may land while a workspace page is open.
  if (router.currentRoute.value.name !== 'chat') router.push('/')
}

// Fallback freshness: live change hints (startEvents) cover the common case,
// but a phone PWA can suspend the socket entirely — refetch on return so the
// sidebar, unread dots, and todos recover even if the reconnect is slow.
function onVisibilityChange() {
  if (document.visibilityState === 'visible') {
    sessionsStore.fetchSessions()
    teamStore.fetchTodos()
    teamStore.fetchActions()
  }
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
  } else {
    // Restore last active session (survives PWA minimize/kill).
    const saved = localStorage.getItem('codepipe:activeSession')
    if (saved && sessionsStore.sessions.some((s) => s.id === saved)) {
      openSessionFromId(saved)
    }
  }

  // Notification tapped while the app was already open.
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', (event) => {
      if (event.data?.type === 'open-session') openSessionFromId(event.data.sessionId)
    })
  }

  document.addEventListener('visibilitychange', onVisibilityChange)
  startEvents()
})

onUnmounted(() => {
  document.removeEventListener('visibilitychange', onVisibilityChange)
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
    <main class="min-w-0 flex-1 overflow-hidden">
      <router-view />
    </main>
  </div>
</template>
