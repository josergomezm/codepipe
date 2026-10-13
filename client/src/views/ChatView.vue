<script setup lang="ts">
import { ref, watch, computed, onUnmounted, defineAsyncComponent } from 'vue'
import { useSessionsStore } from '@/stores/sessions'
import { useProjectsStore } from '@/stores/projects'
import { useUiStore } from '@/stores/ui'
import { useSession } from '@/composables/useSession'
import MessageList from '@/components/MessageList.vue'
import ChatInput from '@/components/ChatInput.vue'
import ChatLoader from '@/components/ChatLoader.vue'
import ModelPicker from '@/components/ModelPicker.vue'
import ChangesPanel from '@/components/ChangesPanel.vue'
// xterm.js is large — load it only when a terminal tab is first opened.
const TerminalPanel = defineAsyncComponent(() => import('@/components/TerminalPanel.vue'))

const store = useSessionsStore()
const projectsStore = useProjectsStore()
const ui = useUiStore()
const { connect, disconnect, connectionError, clearConnectionError, restart } = useSession()

const showMenu = ref(false)

// Chat / Changes / Terminal tabs, scoped to the active chat's project.
type Tab = 'chat' | 'changes' | 'terminal'
const activeTab = ref<Tab>('chat')
/** Header icons for the tabs (Heroicons mini, 20px): chat bubble, code diff, terminal window. */
const TABS: { id: Tab; label: string; paths: string[] }[] = [
  {
    id: 'chat',
    label: 'Chat',
    paths: ['M3.43 2.524A41.29 41.29 0 0 1 10 2c2.236 0 4.43.18 6.57.524 1.437.231 2.43 1.49 2.43 2.902v5.148c0 1.413-.993 2.67-2.43 2.902a41.202 41.202 0 0 1-5.183.501.78.78 0 0 0-.528.224l-3.579 3.58A.75.75 0 0 1 6 17.25v-3.443a41.033 41.033 0 0 1-2.57-.33C1.993 13.244 1 11.986 1 10.573V5.426c0-1.413.993-2.67 2.43-2.902Z'],
  },
  {
    id: 'changes',
    label: 'Changes',
    paths: ['M6.28 5.22a.75.75 0 0 1 0 1.06L2.56 10l3.72 3.72a.75.75 0 0 1-1.06 1.06L.97 10.53a.75.75 0 0 1 0-1.06l4.25-4.25a.75.75 0 0 1 1.06 0Zm7.44 0a.75.75 0 0 1 1.06 0l4.25 4.25a.75.75 0 0 1 0 1.06l-4.25 4.25a.75.75 0 0 1-1.06-1.06L17.44 10l-3.72-3.72a.75.75 0 0 1 0-1.06ZM11.377 2.011a.75.75 0 0 1 .612.867l-2.5 14.5a.75.75 0 0 1-1.478-.255l2.5-14.5a.75.75 0 0 1 .866-.612Z'],
  },
  {
    id: 'terminal',
    label: 'Terminal',
    paths: ['M3.25 3A2.25 2.25 0 0 0 1 5.25v9.5A2.25 2.25 0 0 0 3.25 17h13.5A2.25 2.25 0 0 0 19 14.75v-9.5A2.25 2.25 0 0 0 16.75 3H3.25Zm.943 8.752a.75.75 0 0 1 .055-1.06L6.128 9l-1.88-1.692a.75.75 0 1 1 1.004-1.116l2.5 2.25a.75.75 0 0 1 0 1.116l-2.5 2.25a.75.75 0 0 1-1.06-.056ZM9.75 10.25a.75.75 0 0 0 0 1.5h2.5a.75.75 0 0 0 0-1.5h-2.5Z'],
  },
]
const changesCount = ref<number | null>(null)
const changesPanel = ref<InstanceType<typeof ChangesPanel> | null>(null)
// Terminals start a real shell, so only mount one once its tab is opened.
const terminalProjects = ref<Set<string>>(new Set())

// The currently active session's metadata
const activeSession = computed(() => store.sessions.find(s => s.id === store.activeSessionId) ?? null)

// Connect/disconnect when active session changes
watch(
  () => store.activeSessionId,
  (newId, oldId) => {
    if (oldId && oldId !== newId) {
      disconnect()
    }
    if (newId) {
      connect(newId)
    }
  },
  { immediate: true },
)

onUnmounted(() => {
  disconnect()
})

// The project name for the active session
const activeProjectName = computed(() => {
  if (!activeSession.value) return null
  const project = projectsStore.projects.find(p => p.id === activeSession.value!.projectId)
  return project?.name ?? null
})

// Dev server URL for the current session's project
const devServerUrl = computed(() => {
  if (!activeSession.value) return null
  return projectsStore.getProjectDevUrl(activeSession.value.projectId)
})

const activeProjectId = computed(() => activeSession.value?.projectId ?? null)

function selectTab(tab: Tab) {
  activeTab.value = tab
  if (tab === 'terminal' && activeProjectId.value) terminalProjects.value.add(activeProjectId.value)
}

watch(activeProjectId, (id) => {
  changesCount.value = null
  if (activeTab.value === 'terminal' && id) terminalProjects.value.add(id)
})

// When the agent finishes a turn it has likely edited files — refresh. (The
// terminal does the same after each command, via its `settled` event.)
watch(() => store.sessionStatus, (status, prev) => {
  if (prev === 'typing' && status === 'idle') changesPanel.value?.refresh()
})

function openDevServer() {
  if (devServerUrl.value) window.open(devServerUrl.value, '_blank')
}

function toggleMenu() {
  showMenu.value = !showMenu.value
}

function closeMenu() {
  showMenu.value = false
}

function handleRestart() {
  restart()
  showMenu.value = false
}
</script>

<template>
  <div class="flex h-full flex-col">
    <!-- Header bar -->
    <div class="flex shrink-0 items-center border-b border-gray-200 px-3 py-2 dark:border-gray-800">
      <button
        class="rounded-lg p-1.5 text-gray-600 hover:bg-gray-100 md:hidden dark:text-gray-400 dark:hover:bg-gray-800"
        @click="ui.toggleSidebar()"
      >
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" class="h-5 w-5">
          <path fill-rule="evenodd" d="M2 4.75A.75.75 0 0 1 2.75 4h14.5a.75.75 0 0 1 0 1.5H2.75A.75.75 0 0 1 2 4.75Zm0 10.5a.75.75 0 0 1 .75-.75h14.5a.75.75 0 0 1 0 1.5H2.75a.75.75 0 0 1-.75-.75ZM2 10a.75.75 0 0 1 .75-.75h7.5a.75.75 0 0 1 0 1.5h-7.5A.75.75 0 0 1 2 10Z" clip-rule="evenodd" />
        </svg>
      </button>
      <div class="ml-2 min-w-0">
        <span class="block truncate text-sm font-medium text-gray-700 dark:text-gray-300">
          {{ activeSession?.title ?? 'CodePipe' }}
        </span>
        <span
          v-if="activeProjectName"
          class="block truncate text-xs text-gray-400 dark:text-gray-500"
        >
          {{ activeProjectName }}
        </span>
      </div>

      <!-- Spacer -->
      <div class="flex-1" />

      <!-- Dev server chip -->
      <button
        v-if="devServerUrl && store.activeSessionId"
        class="mr-2 inline-flex items-center gap-1.5 rounded-full bg-green-50 px-2.5 py-0.5 text-xs font-medium text-green-700 transition hover:bg-green-100 dark:bg-green-900/20 dark:text-green-400 dark:hover:bg-green-900/40"
        @click="openDevServer"
      >
        <span class="h-1.5 w-1.5 rounded-full bg-green-500" />
        Dev
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" class="h-3 w-3">
          <path d="M8.75 3.5a.75.75 0 0 0 0-1.5h-5.5a.75.75 0 0 0-.75.75v10.5c0 .414.336.75.75.75h10.5a.75.75 0 0 0 .75-.75v-5.5a.75.75 0 0 0-1.5 0v4.75H3.5V3.5h5.25Z" />
          <path d="M10.25 1a.75.75 0 0 0 0 1.5h2.19L6.72 8.22a.75.75 0 1 0 1.06 1.06l5.72-5.72v2.19a.75.75 0 0 0 1.5 0v-4a.75.75 0 0 0-.75-.75h-4Z" />
        </svg>
      </button>

      <!-- Chat / Changes / Terminal, as icons -->
      <template v-if="store.activeSessionId">
        <button
          v-for="tab in TABS"
          :key="tab.id"
          class="relative mr-1 rounded-lg p-1.5 transition"
          :class="activeTab === tab.id
            ? 'bg-violet-50 text-violet-700 dark:bg-violet-900/30 dark:text-violet-300'
            : 'text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800'"
          :title="tab.label"
          :aria-label="tab.label"
          :aria-pressed="activeTab === tab.id"
          @click="selectTab(tab.id)"
        >
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" class="h-5 w-5">
            <path v-for="(d, i) in tab.paths" :key="i" fill-rule="evenodd" clip-rule="evenodd" :d="d" />
          </svg>
          <span
            v-if="tab.id === 'changes' && changesCount"
            class="absolute -right-0.5 -top-0.5 min-w-[16px] rounded-full bg-violet-600 px-1 text-center text-[10px] font-medium leading-4 text-white"
          >{{ changesCount }}</span>
        </button>
        <span class="mx-1 h-5 w-px bg-gray-200 dark:bg-gray-700" />
      </template>

      <!-- Add an action item for this chat's project -->
      <button
        v-if="store.activeSessionId"
        class="mr-1 rounded-lg p-1.5 text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800"
        title="Add an action item"
        @click="ui.openQuickAdd({ projectId: activeProjectId ?? undefined })"
      >
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" class="h-5 w-5">
          <path fill-rule="evenodd" d="M4.25 2A2.25 2.25 0 0 0 2 4.25v11.5A2.25 2.25 0 0 0 4.25 18h11.5A2.25 2.25 0 0 0 18 15.75V4.25A2.25 2.25 0 0 0 15.75 2H4.25ZM10 6a.75.75 0 0 1 .75.75v2.5h2.5a.75.75 0 0 1 0 1.5h-2.5v2.5a.75.75 0 0 1-1.5 0v-2.5h-2.5a.75.75 0 0 1 0-1.5h2.5v-2.5A.75.75 0 0 1 10 6Z" clip-rule="evenodd" />
        </svg>
      </button>

      <!-- Three-dot menu -->
      <div v-if="store.activeSessionId" class="relative">
        <button
          class="rounded-lg p-1.5 text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800"
          @click="toggleMenu"
        >
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" class="h-5 w-5">
            <path d="M10 3a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3ZM10 8.5a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3ZM11.5 15.5a1.5 1.5 0 1 0-3 0 1.5 1.5 0 0 0 3 0Z" />
          </svg>
        </button>

        <!-- Dropdown menu -->
        <div
          v-if="showMenu"
          class="absolute right-0 top-full z-50 mt-1 w-64 rounded-lg border border-gray-200 bg-white p-3 shadow-lg dark:border-gray-700 dark:bg-gray-800"
        >
          <!-- Click-away overlay -->
          <div class="fixed inset-0 z-[-1]" @click="closeMenu" />

          <div class="space-y-3">
            <ModelPicker />

            <div class="border-t border-gray-200 pt-2 dark:border-gray-700">
              <button
                class="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-xs text-gray-600 transition hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-700"
                @click="handleRestart"
              >
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" class="h-4 w-4">
                  <path fill-rule="evenodd" d="M15.312 11.424a5.5 5.5 0 0 1-9.201 2.466l-.312-.311h2.433a.75.75 0 0 0 0-1.5H3.989a.75.75 0 0 0-.75.75v4.242a.75.75 0 0 0 1.5 0v-2.43l.31.31a7 7 0 0 0 11.712-3.138.75.75 0 0 0-1.449-.39Zm1.23-3.723a.75.75 0 0 0 .219-.53V2.929a.75.75 0 0 0-1.5 0V5.36l-.31-.31A7 7 0 0 0 3.239 8.188a.75.75 0 1 0 1.448.389A5.5 5.5 0 0 1 13.89 6.11l.311.31h-2.432a.75.75 0 0 0 0 1.5h4.243a.75.75 0 0 0 .53-.219Z" clip-rule="evenodd" />
                </svg>
                Restart CLI
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Error banner -->
    <div
      v-if="store.error || connectionError"
      class="flex items-center justify-between bg-red-50 px-4 py-2 text-sm text-red-700 dark:bg-red-900/20 dark:text-red-400"
    >
      <span>{{ store.error || connectionError }}</span>
      <button
        class="ml-2 rounded p-1 hover:bg-red-100 dark:hover:bg-red-900/40"
        @click="store.clearError(); clearConnectionError()"
      >✕</button>
    </div>

    <!-- Welcome screen when no session selected -->
    <div v-if="!store.activeSessionId" class="flex flex-1 items-center justify-center px-4">
      <div class="text-center">
        <h1 class="mb-2 text-2xl font-bold text-gray-900 sm:text-3xl dark:text-gray-100">CodePipe</h1>
        <p class="text-sm text-gray-500 sm:text-base dark:text-gray-400">Select a session or start a new chat</p>
      </div>
    </div>

    <!-- Active chat -->
    <template v-else>
      <div v-show="activeTab === 'chat'" class="flex min-h-0 flex-1 flex-col">
        <ChatLoader v-if="store.loading" />
        <template v-else>
          <MessageList />
          <ChatInput />
        </template>
      </div>

      <ChangesPanel
        v-if="activeProjectId"
        v-show="activeTab === 'changes'"
        ref="changesPanel"
        :key="activeProjectId"
        :project-id="activeProjectId"
        :active="activeTab === 'changes'"
        @count="changesCount = $event"
      />

      <!-- One terminal per project, kept alive while switching tabs/chats -->
      <template v-for="pid in terminalProjects" :key="pid">
        <TerminalPanel
          v-show="activeTab === 'terminal' && pid === activeProjectId"
          :project-id="pid"
          :active="activeTab === 'terminal' && pid === activeProjectId"
          @settled="pid === activeProjectId && changesPanel?.refresh()"
        />
      </template>
    </template>
  </div>
</template>
