<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useUiStore } from '@/stores/ui'
import { useTeamStore } from '@/stores/team'
import NewSessionButton from '@/components/NewSessionButton.vue'
import TeamList from '@/components/TeamList.vue'
import ProjectList from '@/components/ProjectList.vue'
import NotificationToggle from '@/components/NotificationToggle.vue'
import DarkModeToggle from '@/components/DarkModeToggle.vue'

const ui = useUiStore()
const team = useTeamStore()
const route = useRoute()
const router = useRouter()

const navItems = computed(() => [
  { label: 'Action items', path: '/actions', badge: team.openActionCount },
  { label: 'Ideas board', path: '/board', badge: 0 },
  { label: 'Ledger', path: '/ledger', badge: 0 },
])

function navigate(path: string) {
  router.push(path)
  ui.closeSidebar()
}

onMounted(() => {
  team.fetchPersonas()
  team.fetchTodos()
  team.fetchActions()
})
</script>

<template>
  <aside
    class="fixed inset-y-0 left-0 z-40 flex h-full w-72 shrink-0 flex-col border-r border-gray-200 bg-gray-50 transition-transform duration-200 dark:border-gray-800 dark:bg-gray-900 md:static md:translate-x-0"
    :class="ui.sidebarOpen ? 'translate-x-0' : '-translate-x-full'"
  >
    <!-- Header -->
    <div class="flex items-center gap-2 p-3">
      <div class="flex-1">
        <NewSessionButton />
      </div>
      <button
        class="rounded-lg p-1.5 text-gray-500 hover:bg-gray-200 md:hidden dark:text-gray-400 dark:hover:bg-gray-700"
        @click="ui.closeSidebar()"
      >
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" class="h-5 w-5">
          <path d="M6.28 5.22a.75.75 0 0 0-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 1 0 1.06 1.06L10 11.06l3.72 3.72a.75.75 0 1 0 1.06-1.06L11.06 10l3.72-3.72a.75.75 0 0 0-1.06-1.06L10 8.94 6.28 5.22Z" />
        </svg>
      </button>
    </div>

    <!-- Scrollable content -->
    <div class="flex flex-1 flex-col gap-4 overflow-y-auto px-2 pb-4">
      <TeamList />

      <!-- Workspace pages -->
      <div class="flex flex-col gap-0.5">
        <h3 class="px-2 text-xs font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500">
          Workspace
        </h3>
        <button
          v-for="item in navItems"
          :key="item.path"
          class="flex items-center gap-2 rounded-lg px-2 py-1.5 text-left transition"
          :class="route.path === item.path
            ? 'bg-blue-50 text-blue-700 dark:bg-blue-900/20 dark:text-blue-400'
            : 'text-gray-700 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800'"
          @click="navigate(item.path)"
        >
          <span class="flex-1 truncate text-sm font-medium">{{ item.label }}</span>
          <span
            v-if="item.badge > 0"
            class="shrink-0 rounded-full bg-amber-100 px-1.5 text-[10px] font-medium text-amber-700 dark:bg-amber-900/40 dark:text-amber-300"
          >{{ item.badge }}</span>
        </button>
      </div>

      <ProjectList />
    </div>

    <!-- Footer -->
    <div class="border-t border-gray-200 py-2 dark:border-gray-800">
      <NotificationToggle />
      <DarkModeToggle />
    </div>
  </aside>
</template>
