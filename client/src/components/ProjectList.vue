<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { useProjectsStore } from '@/stores/projects'
import { useSessionsStore } from '@/stores/sessions'
import { useSession } from '@/composables/useSession'
import FolderPicker from '@/components/FolderPicker.vue'
import ProjectSettingsModal from '@/components/ProjectSettingsModal.vue'
import ProjectServicesModal from '@/components/ProjectServicesModal.vue'
import IconPlus from '@/components/icons/IconPlus.vue'

const projectStore = useProjectsStore()
const sessionStore = useSessionsStore()
const { disconnect } = useSession()

const showAddForm = ref(false)
const newName = ref('')
const newPath = ref('')
const showFolderPicker = ref(false)
const openMenuId = ref<string | null>(null)
const openSessionMenuId = ref<string | null>(null)
const settingsProjectId = ref<string | null>(null)
const servicesProjectId = ref<string | null>(null)
const expandedProjects = ref<Set<string>>(new Set())
const renamingSessionId = ref<string | null>(null)
const renameInput = ref('')

// Auto-expand the project that contains the active session
watch(
  () => sessionStore.activeSessionId,
  (sessionId) => {
    if (!sessionId) return
    const session = sessionStore.sessions.find((s) => s.id === sessionId)
    if (session) {
      expandedProjects.value.add(session.projectId)
    }
  },
  { immediate: true },
)

// Group sessions by projectId, sorted by updatedAt descending within each group
const sessionsByProject = computed(() => {
  const map = new Map<string, typeof sessionStore.sessions>()
  const sorted = [...sessionStore.sessions].sort((a, b) => b.updatedAt - a.updatedAt)
  for (const session of sorted) {
    const list = map.get(session.projectId) ?? []
    list.push(session)
    map.set(session.projectId, list)
  }
  return map
})

function toggleProject(projectId: string) {
  if (expandedProjects.value.has(projectId)) {
    expandedProjects.value.delete(projectId)
  } else {
    expandedProjects.value.add(projectId)
  }
}

function selectSession(sessionId: string) {
  sessionStore.selectSession(sessionId)
}

function toggleSessionMenu(sessionId: string) {
  openSessionMenuId.value = openSessionMenuId.value === sessionId ? null : sessionId
}

function startRename(sessionId: string, currentTitle: string) {
  openSessionMenuId.value = null
  renamingSessionId.value = sessionId
  renameInput.value = currentTitle
}

async function confirmRename(sessionId: string) {
  const title = renameInput.value.trim()
  if (title) {
    await sessionStore.renameSession(sessionId, title)
  }
  renamingSessionId.value = null
  renameInput.value = ''
}

function cancelRename() {
  renamingSessionId.value = null
  renameInput.value = ''
}

async function removeSession(sessionId: string) {
  openSessionMenuId.value = null
  if (sessionStore.activeSessionId === sessionId) {
    disconnect()
  }
  await sessionStore.deleteSession(sessionId)
}

function providerLabel(provider: string): string {
  return provider.charAt(0).toUpperCase() + provider.slice(1)
}

function onFolderSelected(path: string) {
  newPath.value = path
}

async function addProject() {
  const name = newName.value.trim()
  const path = newPath.value.trim()
  if (!name || !path) return

  await projectStore.addProject(name, path)
  newName.value = ''
  newPath.value = ''
  showAddForm.value = false
}

async function removeProject(id: string) {
  openMenuId.value = null
  await projectStore.removeProject(id)
}

function toggleMenu(id: string) {
  openMenuId.value = openMenuId.value === id ? null : id
}

function closeMenu() {
  openMenuId.value = null
  openSessionMenuId.value = null
}

function openSettings(id: string) {
  openMenuId.value = null
  settingsProjectId.value = id
}

function openServices(id: string) {
  openMenuId.value = null
  servicesProjectId.value = id
}

function openDevServer(url: string) {
  openMenuId.value = null
  window.location.href = url // navigates out of PWA scope → opens in browser
}

async function startDevServer(id: string) {
  openMenuId.value = null
  const info = await projectStore.startDevServer(id)
  if (!info) {
    // Start failed (e.g. port conflict) — open settings so the error is visible
    settingsProjectId.value = id
  }
}

async function stopDevServer(id: string) {
  openMenuId.value = null
  await projectStore.stopDevServer(id)
}
</script>

<template>
  <div class="flex flex-col gap-1" @click="closeMenu">
    <h3 class="px-2 text-xs font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500">
      Projects
    </h3>

    <div v-if="projectStore.projects.length === 0" class="px-2 py-1 text-xs text-gray-400 dark:text-gray-500">
      No projects added
    </div>

    <div
      v-for="project in projectStore.projects"
      :key="project.id"
      class="flex flex-col"
    >
      <!-- Project header row -->
      <div
        class="group relative flex items-center justify-between rounded-lg px-2 py-1.5 text-sm text-gray-700 dark:text-gray-300"
      >
        <div class="min-w-0 flex-1 flex items-center gap-1.5 cursor-pointer" @click="toggleProject(project.id)">
          <!-- Expand/collapse chevron -->
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 20 20"
            fill="currentColor"
            class="h-3.5 w-3.5 shrink-0 text-gray-400 transition-transform dark:text-gray-500"
            :class="{ 'rotate-90': expandedProjects.has(project.id) }"
          >
            <path fill-rule="evenodd" d="M8.22 5.22a.75.75 0 0 1 1.06 0l4.25 4.25a.75.75 0 0 1 0 1.06l-4.25 4.25a.75.75 0 0 1-1.06-1.06L11.94 10 8.22 6.28a.75.75 0 0 1 0-1.06Z" clip-rule="evenodd" />
          </svg>
          <span class="truncate font-medium">{{ project.name }}</span>
          <!-- Session count badge -->
          <span
            v-if="sessionsByProject.get(project.id)?.length"
            class="shrink-0 rounded-full bg-gray-200 px-1.5 text-[10px] font-medium text-gray-600 dark:bg-gray-700 dark:text-gray-400"
          >
            {{ sessionsByProject.get(project.id)!.length }}
          </span>
          <!-- Green dot for running dev server -->
          <span
            v-if="project.devServerStatus?.status === 'running'"
            class="relative flex h-2 w-2 shrink-0"
            title="Dev server running"
          >
            <span class="absolute inline-flex h-full w-full rounded-full bg-green-400 animate-breathe"></span>
            <span class="relative inline-flex h-2 w-2 rounded-full bg-green-500"></span>
          </span>
          <!-- Orange dot for running service (e.g. Firebase emulators) -->
          <span
            v-else-if="projectStore.hasRunningService(project.id)"
            class="relative flex h-2 w-2 shrink-0"
            title="Service running"
          >
            <span class="absolute inline-flex h-full w-full rounded-full bg-orange-400 animate-breathe"></span>
            <span class="relative inline-flex h-2 w-2 rounded-full bg-orange-500"></span>
          </span>
        </div>

        <!-- Three-dot menu button -->
        <button
          class="shrink-0 rounded p-1 text-gray-400 transition hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-700 dark:hover:text-gray-300"
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

          <!-- Manage services -->
          <button
            class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-gray-700 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-700"
            @click="openServices(project.id)"
          >
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" class="h-3.5 w-3.5">
              <path d="M2 3a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V3ZM2 8.5a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1v-1ZM3 13a1 1 0 0 0 0 2h10a1 1 0 0 0 0-2H3Z" />
            </svg>
            <span class="flex-1">Services</span>
            <span
              v-if="projectStore.hasRunningService(project.id)"
              class="h-1.5 w-1.5 rounded-full bg-orange-500"
            />
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

      <!-- Sessions sub-list (toggleable) -->
      <div
        v-if="expandedProjects.has(project.id)"
        class="ml-4 flex flex-col gap-0.5 border-l border-gray-200 pl-2 dark:border-gray-700"
      >
        <div
          v-if="!sessionsByProject.get(project.id)?.length"
          class="px-2 py-1 text-xs text-gray-400 dark:text-gray-500"
        >
          No sessions
        </div>
        <div
          v-for="session in sessionsByProject.get(project.id)"
          :key="session.id"
          class="group/session relative flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition cursor-pointer"
          :class="[
            sessionStore.activeSessionId === session.id
              ? 'bg-blue-50 text-blue-700 dark:bg-blue-900/20 dark:text-blue-400'
              : 'text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800',
          ]"
          @click="selectSession(session.id)"
        >
          <span
            class="inline-block h-1.5 w-1.5 shrink-0 rounded-full"
            :class="session.status === 'live' ? 'bg-green-500' : 'bg-gray-400 dark:bg-gray-600'"
          ></span>

          <!-- Normal title display -->
          <template v-if="renamingSessionId !== session.id">
            <span class="flex-1 truncate text-xs">{{ session.title }}</span>
          </template>
          <!-- Inline rename input -->
          <template v-else>
            <input
              v-model="renameInput"
              type="text"
              class="flex-1 rounded border border-blue-400 bg-white px-1 py-0.5 text-xs text-gray-900 focus:outline-none dark:border-blue-600 dark:bg-gray-900 dark:text-gray-100"
              @click.stop
              @keydown.enter.stop="confirmRename(session.id)"
              @keydown.escape.stop="cancelRename"
              @blur="confirmRename(session.id)"
              @vue:mounted="($event: any) => $event.el.focus()"
            />
          </template>

          <span class="shrink-0 rounded bg-gray-200 px-1 py-0.5 text-[9px] font-medium text-gray-500 dark:bg-gray-700 dark:text-gray-400">
            {{ providerLabel(session.provider) }}
          </span>

          <!-- 3-dot session menu button -->
          <button
            class="shrink-0 rounded p-0.5 text-gray-400 transition hover:bg-gray-200 hover:text-gray-600 dark:hover:bg-gray-700 dark:hover:text-gray-300"
            title="Session actions"
            @click.stop="toggleSessionMenu(session.id)"
          >
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" class="h-3.5 w-3.5">
              <path d="M8 2a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3ZM8 6.5a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3ZM9.5 12.5a1.5 1.5 0 1 0-3 0 1.5 1.5 0 0 0 3 0Z" />
            </svg>
          </button>

          <!-- Session dropdown menu -->
          <div
            v-if="openSessionMenuId === session.id"
            class="absolute right-0 top-full z-50 mt-1 w-32 rounded-lg border border-gray-200 bg-white py-1 shadow-lg dark:border-gray-700 dark:bg-gray-800"
            @click.stop
          >
            <button
              class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-gray-700 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-700"
              @click="startRename(session.id, session.title)"
            >
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" class="h-3.5 w-3.5">
                <path d="M13.488 2.513a1.75 1.75 0 0 0-2.475 0L6.75 6.774a2.75 2.75 0 0 0-.596.892l-.848 2.047a.75.75 0 0 0 .98.98l2.047-.848a2.75 2.75 0 0 0 .892-.596l4.261-4.262a1.75 1.75 0 0 0 0-2.474Z" />
                <path d="M4.75 3.5c-.69 0-1.25.56-1.25 1.25v6.5c0 .69.56 1.25 1.25 1.25h6.5c.69 0 1.25-.56 1.25-1.25V9A.75.75 0 0 1 14 9v2.25A2.75 2.75 0 0 1 11.25 14h-6.5A2.75 2.75 0 0 1 2 11.25v-6.5A2.75 2.75 0 0 1 4.75 2H7a.75.75 0 0 1 0 1.5H4.75Z" />
              </svg>
              Rename
            </button>
            <button
              class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-900/20"
              @click="removeSession(session.id)"
            >
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" class="h-3.5 w-3.5">
                <path fill-rule="evenodd" d="M5 3.25V4H2.75a.75.75 0 0 0 0 1.5h.3l.815 8.15A1.5 1.5 0 0 0 5.357 15h5.285a1.5 1.5 0 0 0 1.493-1.35l.815-8.15h.3a.75.75 0 0 0 0-1.5H11v-.75A2.25 2.25 0 0 0 8.75 1h-1.5A2.25 2.25 0 0 0 5 3.25Zm2.25-.75a.75.75 0 0 0-.75.75V4h3v-.75a.75.75 0 0 0-.75-.75h-1.5ZM6.05 6a.75.75 0 0 1 .787.713l.275 5.5a.75.75 0 0 1-1.498.075l-.275-5.5A.75.75 0 0 1 6.05 6Zm3.9 0a.75.75 0 0 1 .712.787l-.275 5.5a.75.75 0 0 1-1.498-.075l.275-5.5a.75.75 0 0 1 .786-.711Z" clip-rule="evenodd" />
              </svg>
              Delete
            </button>
          </div>
        </div>
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

    <FolderPicker v-model="showFolderPicker" @select="onFolderSelected" />
    <ProjectSettingsModal :project-id="settingsProjectId" @close="settingsProjectId = null" />
    <ProjectServicesModal :project-id="servicesProjectId" @close="servicesProjectId = null" />
  </div>
</template>
