<script setup lang="ts">
import { ref } from 'vue'
import { useProjectsStore } from '@/stores/projects'
import FolderPicker from '@/components/FolderPicker.vue'
import IconClose from '@/components/icons/IconClose.vue'
import IconPlus from '@/components/icons/IconPlus.vue'

const store = useProjectsStore()
const collapsed = ref(false)
const showAddForm = ref(false)
const newName = ref('')
const newPath = ref('')
const showFolderPicker = ref(false)

function onFolderSelected(path: string) {
  newPath.value = path
}

async function addProject() {
  const name = newName.value.trim()
  const path = newPath.value.trim()
  if (!name || !path) return

  await store.addProject(name, path)
  newName.value = ''
  newPath.value = ''
  showAddForm.value = false
}

async function removeProject(id: string) {
  await store.removeProject(id)
}
</script>

<template>
  <div class="flex flex-col gap-1">
    <button
      class="flex items-center justify-between px-2 text-xs font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500"
      @click="collapsed = !collapsed"
    >
      Projects
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 20 20"
        fill="currentColor"
        class="h-3.5 w-3.5 transition-transform"
        :class="{ '-rotate-90': collapsed }"
      >
        <path fill-rule="evenodd" d="M5.22 8.22a.75.75 0 0 1 1.06 0L10 11.94l3.72-3.72a.75.75 0 1 1 1.06 1.06l-4.25 4.25a.75.75 0 0 1-1.06 0L5.22 9.28a.75.75 0 0 1 0-1.06Z" clip-rule="evenodd" />
      </svg>
    </button>

    <div v-if="!collapsed" class="flex flex-col gap-1">
      <div v-if="store.projects.length === 0" class="px-2 py-1 text-xs text-gray-400 dark:text-gray-500">
        No projects added
      </div>

      <div
        v-for="project in store.projects"
        :key="project.id"
        class="group flex items-center justify-between rounded-lg px-2 py-1.5 text-sm text-gray-700 dark:text-gray-300"
      >
        <div class="min-w-0 flex-1">
          <div class="truncate font-medium">{{ project.name }}</div>
          <div class="truncate text-xs text-gray-400 dark:text-gray-500">{{ project.path }}</div>
        </div>
        <button
          class="shrink-0 rounded p-1 text-gray-400 opacity-0 transition hover:bg-red-50 hover:text-red-500 group-hover:opacity-100 dark:hover:bg-red-900/20"
          @click.stop="removeProject(project.id)"
        >
          <IconClose />
        </button>
      </div>

      <!-- Add project form -->
      <div v-if="showAddForm" class="flex flex-col gap-1.5 rounded-lg bg-gray-50 p-2 dark:bg-gray-800/50">
        <input
          v-model="newName"
          type="text"
          placeholder="Project name"
          class="rounded border border-gray-200 bg-white px-2 py-1 text-xs text-gray-900 placeholder:text-gray-400 focus:border-blue-500 focus:outline-none dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
        />
        <div class="flex gap-1">
          <input
            v-model="newPath"
            type="text"
            placeholder="/absolute/path/to/project"
            class="min-w-0 flex-1 rounded border border-gray-200 bg-white px-2 py-1 text-xs text-gray-900 placeholder:text-gray-400 focus:border-blue-500 focus:outline-none dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
          />
          <button
            class="shrink-0 rounded border border-gray-200 bg-white px-2 py-1 text-xs font-medium text-gray-600 transition hover:bg-gray-100 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-300 dark:hover:bg-gray-800"
            @click="showFolderPicker = true"
          >
            Browse…
          </button>
        </div>
        <div class="flex gap-1">
          <button
            class="flex-1 rounded bg-blue-600 px-2 py-1 text-xs font-medium text-white transition hover:bg-blue-700"
            @click="addProject"
          >
            Add
          </button>
          <button
            class="flex-1 rounded bg-gray-200 px-2 py-1 text-xs font-medium text-gray-700 transition hover:bg-gray-300 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600"
            @click="showAddForm = false; newName = ''; newPath = ''"
          >
            Cancel
          </button>
        </div>
      </div>

      <button
        v-if="!showAddForm"
        class="flex items-center gap-1 rounded-lg px-2 py-1.5 text-xs text-gray-500 transition hover:bg-gray-100 hover:text-gray-700 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-gray-300"
        @click="showAddForm = true"
      >
        <IconPlus />
        Add Project
      </button>
    </div>

    <FolderPicker v-model="showFolderPicker" @select="onFolderSelected" />
  </div>
</template>
