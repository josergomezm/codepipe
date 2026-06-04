<script setup lang="ts">
import { ref } from 'vue'
import { useProjectsStore } from '@/stores/projects'
import FolderPicker from '@/components/FolderPicker.vue'
import ProjectSettingsModal from '@/components/ProjectSettingsModal.vue'
import IconPlus from '@/components/icons/IconPlus.vue'

const store = useProjectsStore()
const collapsed = ref(false)
const showAddForm = ref(false)
const newName = ref('')
const newPath = ref('')
const showFolderPicker = ref(false)
const openMenuId = ref<string | null>(null)
const settingsProjectId = ref<string | null>(null)

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
  openMenuId.value = null
  await store.removeProject(id)
}

function toggleMenu(id: string) {
  openMenuId.value = openMenuId.value === id ? null : id
}

function closeMenu() {
  openMenuId.value = null
}

function openSettings(id: string) {
  openMenuId.value = null
  settingsProjectId.value = id
}

function openDevServer(url: string) {
  openMenuId.value = null
  window.open(url, '_blank')
}

async function startDevServer(id: string) {
  openMenuId.value = null
  await store.startDevServer(id)
}

async function stopDevServer(id: string) {
  openMenuId.value = null
  await store.stopDevServer(id)
}
</script>

<template>
  <div class="flex flex-col gap-1" @click.self="closeMenu">
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
        class="group relative flex items-center justify-between rounded-lg px-2 py-1.5 text-sm text-gray-700 dark:text-gray-300"
      >
        <div class="min-w-0 flex-1 cursor-pointer" @click="openSettings(project.id)">
          <div class="flex items-center gap-1.5">
            <span class="truncate font-medium hover:text-blue-600 dark:hover:text-blue-400">{{ project.name }}</span>
            <!-- Green dot for running dev server -->
            <span
              v-if="project.devServerStatus?.status === 'running'"
              class="h-2 w-2 shrink-0 rounded-full bg-green-500"
              title="Dev server running"
            />
            <!-- Quick link to dev server -->
            <a
              v-if="project.devServerStatus?.status === 'running' && project.devServerStatus.url"
              :href="project.devServerStatus.url"
              target="_blank"
              class="shrink-0 text-gray-400 transition hover:text-blue-500"
              title="Open dev server"
              @click.stop
            >
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" class="h-3 w-3">
                <path d="M8.75 3.5a.75.75 0 0 0 0-1.5h-5.5a.75.75 0 0 0-.75.75v10.5c0 .414.336.75.75.75h10.5a.75.75 0 0 0 .75-.75v-5.5a.75.75 0 0 0-1.5 0v4.75H3.5V3.5h5.25Z" />
                <path d="M10.25 1a.75.75 0 0 0 0 1.5h2.19L6.72 8.22a.75.75 0 1 0 1.06 1.06l5.72-5.72v2.19a.75.75 0 0 0 1.5 0v-4a.75.75 0 0 0-.75-.75h-4Z" />
              </svg>
            </a>
          </div>
          <div class="truncate text-xs text-gray-400 dark:text-gray-500">{{ project.path }}</div>
        </div>

        <!-- Three-dot menu button -->
        <button
          class="shrink-0 rounded p-1 text-gray-400 opacity-0 transition hover:bg-gray-100 hover:text-gray-600 group-hover:opacity-100 dark:hover:bg-gray-700 dark:hover:text-gray-300"
          @click.stop="toggleMenu(project.id)"
        >
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" class="h-4 w-4">
            <path d="M8 2a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3ZM8 6.5a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3ZM9.5 12.5a1.5 1.5 0 1 0-3 0 1.5 1.5 0 0 0 3 0Z" />
          </svg>
        </button>

        <!-- Dropdown menu -->
        <div
          v-if="openMenuId === project.id"
          class="absolute right-0 top-full z-50 mt-1 w-44 rounded-lg border border-gray-200 bg-white py-1 shadow-lg dark:border-gray-700 dark:bg-gray-800"
        >
          <!-- Open dev server link -->
          <button
            v-if="project.devServerStatus?.status === 'running' && project.devServerStatus.url"
            class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-gray-700 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-700"
            @click="openDevServer(project.devServerStatus.url!)"
          >
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" class="h-3.5 w-3.5">
              <path d="M8.75 3.5a.75.75 0 0 0 0-1.5h-5.5a.75.75 0 0 0-.75.75v10.5c0 .414.336.75.75.75h10.5a.75.75 0 0 0 .75-.75v-5.5a.75.75 0 0 0-1.5 0v4.75H3.5V3.5h5.25Z" />
              <path d="M10.25 1a.75.75 0 0 0 0 1.5h2.19L6.72 8.22a.75.75 0 1 0 1.06 1.06l5.72-5.72v2.19a.75.75 0 0 0 1.5 0v-4a.75.75 0 0 0-.75-.75h-4Z" />
            </svg>
            Open Dev Server
          </button>

          <!-- Start dev server -->
          <button
            v-if="project.devServer && project.devServerStatus?.status !== 'running'"
            class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-gray-700 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-700"
            @click="startDevServer(project.id)"
          >
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" class="h-3.5 w-3.5">
              <path d="M3 3.732a1.5 1.5 0 0 1 2.305-1.265l6.706 4.267a1.5 1.5 0 0 1 0 2.531l-6.706 4.268A1.5 1.5 0 0 1 3 12.267V3.732Z" />
            </svg>
            Start Dev Server
          </button>

          <!-- Stop dev server -->
          <button
            v-if="project.devServerStatus?.status === 'running'"
            class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-gray-700 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-700"
            @click="stopDevServer(project.id)"
          >
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" class="h-3.5 w-3.5">
              <path d="M4.5 2A2.5 2.5 0 0 0 2 4.5v7A2.5 2.5 0 0 0 4.5 14h7a2.5 2.5 0 0 0 2.5-2.5v-7A2.5 2.5 0 0 0 11.5 2h-7Z" />
            </svg>
            Stop Dev Server
          </button>

          <!-- Settings -->
          <button
            class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-gray-700 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-700"
            @click="openSettings(project.id)"
          >
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" class="h-3.5 w-3.5">
              <path fill-rule="evenodd" d="M6.455 1.45A.5.5 0 0 1 6.952 1h2.096a.5.5 0 0 1 .497.45l.186 1.858a4.996 4.996 0 0 1 1.466.848l1.77-.712a.5.5 0 0 1 .618.224l1.048 1.815a.5.5 0 0 1-.12.665l-1.584 1.146a5.027 5.027 0 0 1 0 1.412l1.584 1.146a.5.5 0 0 1 .12.665l-1.048 1.815a.5.5 0 0 1-.618.224l-1.77-.712a4.996 4.996 0 0 1-1.466.848l-.186 1.858a.5.5 0 0 1-.497.45H6.952a.5.5 0 0 1-.497-.45l-.186-1.858a4.993 4.993 0 0 1-1.466-.848l-1.77.712a.5.5 0 0 1-.618-.224L1.367 12.55a.5.5 0 0 1 .12-.665l1.584-1.146a5.027 5.027 0 0 1 0-1.412L1.487 8.18a.5.5 0 0 1-.12-.665l1.048-1.815a.5.5 0 0 1 .618-.224l1.77.712a4.996 4.996 0 0 1 1.466-.848l.186-1.858ZM8 10.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z" clip-rule="evenodd" />
            </svg>
            Settings
          </button>

          <div class="my-1 border-t border-gray-200 dark:border-gray-700" />

          <!-- Delete project -->
          <button
            class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-900/20"
            @click="removeProject(project.id)"
          >
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" class="h-3.5 w-3.5">
              <path fill-rule="evenodd" d="M5 3.25V4H2.75a.75.75 0 0 0 0 1.5h.3l.815 8.15A1.5 1.5 0 0 0 5.357 15h5.285a1.5 1.5 0 0 0 1.493-1.35l.815-8.15h.3a.75.75 0 0 0 0-1.5H11v-.75A2.25 2.25 0 0 0 8.75 1h-1.5A2.25 2.25 0 0 0 5 3.25Zm2.25-.75a.75.75 0 0 0-.75.75V4h3v-.75a.75.75 0 0 0-.75-.75h-1.5ZM6.05 6a.75.75 0 0 1 .787.713l.275 5.5a.75.75 0 0 1-1.498.075l-.275-5.5A.75.75 0 0 1 6.05 6Zm3.9 0a.75.75 0 0 1 .712.787l-.275 5.5a.75.75 0 0 1-1.498-.075l.275-5.5a.75.75 0 0 1 .786-.711Z" clip-rule="evenodd" />
            </svg>
            Delete
          </button>
        </div>
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
    <ProjectSettingsModal :project-id="settingsProjectId" @close="settingsProjectId = null" />
  </div>
</template>
