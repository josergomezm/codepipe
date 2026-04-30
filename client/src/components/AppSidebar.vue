<script setup lang="ts">
import NewSessionButton from '@/components/NewSessionButton.vue'
import SessionList from '@/components/SessionList.vue'
import ProjectList from '@/components/ProjectList.vue'
</script>

<template>
  <aside class="flex h-full w-72 shrink-0 flex-col border-r border-gray-200 bg-gray-50 dark:border-gray-800 dark:bg-gray-900">
    <!-- Header -->
    <div class="p-3">
      <NewSessionButton />
    </div>

    <!-- Scrollable content -->
    <div class="flex flex-1 flex-col gap-6 overflow-y-auto px-2 pb-4">
      <SessionList />
      <ProjectList />
    </div>
  </aside>
</template>
