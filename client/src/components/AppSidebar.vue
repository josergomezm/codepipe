<script setup lang="ts">
import { useUiStore } from '@/stores/ui'
import NewSessionButton from '@/components/NewSessionButton.vue'
import ProjectList from '@/components/ProjectList.vue'
import NotificationToggle from '@/components/NotificationToggle.vue'
import DarkModeToggle from '@/components/DarkModeToggle.vue'

const ui = useUiStore()
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
      <ProjectList />
    </div>

    <!-- Footer -->
    <div class="border-t border-gray-200 py-2 dark:border-gray-800">
      <NotificationToggle />
      <DarkModeToggle />
    </div>
  </aside>
</template>
