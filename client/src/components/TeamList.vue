<script setup lang="ts">
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { useTeamStore } from '@/stores/team'
import { useUiStore } from '@/stores/ui'
import PersonaAvatar from '@/components/PersonaAvatar.vue'
import TeamSettingsModal from '@/components/TeamSettingsModal.vue'

const teamStore = useTeamStore()
const ui = useUiStore()
const router = useRouter()

const showSettings = ref(false)

function openPersona(personaId: string) {
  router.push(`/team/${personaId}`)
  ui.closeSidebar()
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

    <!-- The roster: tap a member to see their contributions -->
    <button
      v-for="persona in teamStore.personas"
      :key="persona.id"
      class="flex items-center gap-2 rounded-lg px-2 py-1.5 text-left transition hover:bg-gray-100 dark:hover:bg-gray-800"
      @click="openPersona(persona.id)"
    >
      <PersonaAvatar :persona="persona" />
      <div class="min-w-0 flex-1">
        <div class="truncate text-sm font-medium text-gray-700 dark:text-gray-300">
          {{ persona.name }}
          <span v-if="persona.isLead" class="ml-1 rounded-full bg-purple-100 px-1.5 text-[10px] font-medium text-purple-700 dark:bg-purple-900/40 dark:text-purple-300">lead</span>
        </div>
        <div class="truncate text-xs text-gray-400 dark:text-gray-500">{{ persona.role }}</div>
      </div>
    </button>

    <TeamSettingsModal v-if="showSettings" @close="showSettings = false" />
  </div>
</template>
