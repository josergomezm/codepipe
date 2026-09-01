<script setup lang="ts">
import { ref, computed } from 'vue'
import { useRouter } from 'vue-router'
import { useSessionsStore } from '@/stores/sessions'
import { useProjectsStore } from '@/stores/projects'
import { useTeamStore } from '@/stores/team'
import PersonaAvatar from '@/components/PersonaAvatar.vue'
import TeamSettingsModal from '@/components/TeamSettingsModal.vue'

const sessionStore = useSessionsStore()
const projectStore = useProjectsStore()
const teamStore = useTeamStore()

const showSettings = ref(false)
const router = useRouter()

// One thread per project: sessions the standup service created (kind 'team'),
// newest activity first.
const teamSessions = computed(() =>
  sessionStore.sessions
    .filter((s) => s.kind === 'team')
    .sort((a, b) => b.updatedAt - a.updatedAt),
)

function projectName(projectId: string): string {
  return projectStore.projects.find((p) => p.id === projectId)?.name ?? 'Unknown project'
}

function selectSession(id: string) {
  sessionStore.selectSession(id)
  router.push('/')
}
</script>

<template>
  <div class="flex flex-col gap-1">
    <div class="flex items-center justify-between px-2">
      <h3 class="text-xs font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500">
        Team
      </h3>
      <button
        class="rounded p-1 text-gray-400 transition hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-700 dark:hover:text-gray-300"
        title="Team settings"
        @click="showSettings = true"
      >
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" class="h-3.5 w-3.5">
          <path d="M8 8a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5ZM3.156 11.763c.16-.629.44-1.21.813-1.72a2.5 2.5 0 0 0-2.725 1.377c-.136.287.102.58.42.58h1.449c.01-.08.024-.16.043-.237ZM12.847 11.763c.02.077.033.157.043.237h1.45c.317 0 .555-.293.42-.58a2.5 2.5 0 0 0-2.725-1.377c.373.51.652 1.091.812 1.72ZM14 7.5a2 2 0 1 1-4 0 2 2 0 0 1 4 0ZM3.5 9.5a2 2 0 1 0 0-4 2 2 0 0 0 0 4ZM5 13c-.552 0-1.016-.452-.9-.992a4.002 4.002 0 0 1 7.8 0c.116.54-.348.992-.9.992H5Z" />
        </svg>
      </button>
    </div>

    <div v-if="teamStore.personas.length === 0" class="px-2 py-1 text-xs text-gray-400 dark:text-gray-500">
      No team yet —
      <button class="text-blue-600 hover:underline dark:text-blue-400" @click="showSettings = true">
        add personas
      </button>
    </div>

    <div
      v-else-if="teamSessions.length === 0"
      class="px-2 py-1 text-xs text-gray-400 dark:text-gray-500"
    >
      No standups yet. Enable one in a project's settings, or add ideas and run it manually.
    </div>

    <button
      v-for="session in teamSessions"
      :key="session.id"
      class="flex items-center gap-2 rounded-lg px-2 py-1.5 text-left transition"
      :class="sessionStore.activeSessionId === session.id
        ? 'bg-blue-50 dark:bg-blue-900/20'
        : 'hover:bg-gray-100 dark:hover:bg-gray-800'"
      @click="selectSession(session.id)"
    >
      <PersonaAvatar :persona="teamStore.lead" />
      <div class="min-w-0 flex-1">
        <div
          class="truncate text-sm"
          :class="[
            sessionStore.activeSessionId === session.id
              ? 'text-blue-700 dark:text-blue-400'
              : 'text-gray-700 dark:text-gray-300',
            sessionStore.isUnread(session) ? 'font-semibold' : 'font-medium',
          ]"
        >
          {{ session.title }}
        </div>
        <div class="truncate text-xs text-gray-400 dark:text-gray-500">
          {{ projectName(session.projectId) }}
        </div>
      </div>
      <span
        v-if="sessionStore.isUnread(session)"
        class="h-2 w-2 shrink-0 rounded-full bg-blue-500"
        title="New messages"
      />
    </button>

    <TeamSettingsModal v-if="showSettings" @close="showSettings = false" />
  </div>
</template>
