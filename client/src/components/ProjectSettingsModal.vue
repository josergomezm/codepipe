<script setup lang="ts">
import { ref, watch, computed } from 'vue'
import { useProjectsStore } from '@/stores/projects'
import { useSessionsStore } from '@/stores/sessions'
import { detectDevServer } from '@/api/client'
import type { Project } from '@/api/client'

type PackageManager = 'npm' | 'bun' | 'pnpm' | 'yarn'

const props = defineProps<{
  projectId: string | null
}>()

const emit = defineEmits<{
  close: []
}>()

const store = useProjectsStore()
const sessionsStore = useSessionsStore()

const project = computed<Project | undefined>(() =>
  store.projects.find((p) => p.id === props.projectId),
)

// Form state
const packageManager = ref<PackageManager>('npm')
const port = ref('')
const tailscalePort = ref('')
const customCommand = ref('')
const useCustomCommand = ref(false)
const saving = ref(false)
const detecting = ref(false)
const serverLoading = ref(false)
const detectedFramework = ref<string | null>(null)
const detectedSubDir = ref<string | null>(null)

const SCRIPT_NAME = 'dev:remote'

// --- Daily standup config ---
const standupEnabled = ref(false)
const standupHour = ref(9)
const standupSaving = ref(false)

async function saveStandup() {
  if (!props.projectId) return
  standupSaving.value = true
  await store.updateProjectStandup(
    props.projectId,
    standupEnabled.value ? { enabled: true, hour: standupHour.value } : null,
  )
  standupSaving.value = false
}

function formatHour(h: number): string {
  const period = h < 12 ? 'AM' : 'PM'
  const display = h % 12 === 0 ? 12 : h % 12
  return `${display}:00 ${period}`
}

// Derived start command
const startCommand = computed(() => {
  if (useCustomCommand.value) return customCommand.value.trim()
  const pm = packageManager.value
  const run = pm === 'npm' ? `npm run ${SCRIPT_NAME}` : `${pm} run ${SCRIPT_NAME}`
  if (detectedSubDir.value) {
    if (pm === 'npm') return `${run} --prefix ${detectedSubDir.value}`
    return `${run} --cwd ${detectedSubDir.value}`
  }
  return run
})

// Track whether the project already has dev:remote script
const hasDevRemoteScript = ref(false)

async function refreshDetection() {
  if (!props.projectId) return
  detecting.value = true
  try {
    const result = await detectDevServer(props.projectId)
    if (result.packageManager) packageManager.value = result.packageManager
    if (!project.value?.devServer) {
      if (result.port) port.value = String(result.port)
      if (result.tailscalePort) tailscalePort.value = String(result.tailscalePort)
    }
    detectedFramework.value = result.framework
    detectedSubDir.value = result.subDir
    hasDevRemoteScript.value = result.availableScripts.includes('dev:remote')
  } catch {
    // Best-effort
  } finally {
    detecting.value = false
  }
}

// Sync form state when project changes
watch(
  () => props.projectId,
  async (id) => {
    detectedFramework.value = null
    detectedSubDir.value = null
    useCustomCommand.value = false
    customCommand.value = ''
    hasDevRemoteScript.value = false
    standupEnabled.value = project.value?.standup?.enabled ?? false
    standupHour.value = project.value?.standup?.hour ?? 9

    if (project.value?.devServer) {
      port.value = String(project.value.devServer.port)
      tailscalePort.value = project.value.devServer.tailscalePort
        ? String(project.value.devServer.tailscalePort)
        : ''
      // Try to parse the stored command to extract package manager
      const cmd = project.value.devServer.startCommand
      if (cmd.startsWith('bun ')) packageManager.value = 'bun'
      else if (cmd.startsWith('pnpm ')) packageManager.value = 'pnpm'
      else if (cmd.startsWith('yarn ')) packageManager.value = 'yarn'
      else packageManager.value = 'npm'

      // If stored command doesn't match convention, show custom
      const conventional = startCommand.value
      if (cmd !== conventional) {
        useCustomCommand.value = true
        customCommand.value = cmd
      }
    } else {
      port.value = ''
      tailscalePort.value = ''
      packageManager.value = 'npm'
    }

    if (id) await refreshDetection()
  },
  { immediate: true },
)

const isRunning = computed(
  () => project.value?.devServerStatus?.status === 'running',
)

const devUrl = computed(() => {
  if (!project.value?.devServer) return null
  return project.value.devServerStatus?.url ?? null
})

const hasValidConfig = computed(
  () => !!project.value?.devServer,
)

const isTailscaleMapped = computed(
  () => project.value?.devServerStatus?.tailscaleMapped ?? false,
)

// --- Port validation ---

const MIN_PORT = 1024
const MAX_PORT = 65535

const parsedPort = computed(() => parseInt(port.value))
const parsedTailscalePort = computed(() => tailscalePort.value ? parseInt(tailscalePort.value) : null)

const portError = computed<string | null>(() => {
  if (port.value === '') return null
  const p = parsedPort.value
  if (isNaN(p)) return 'Must be a number'
  if (p < MIN_PORT || p > MAX_PORT) return `Must be ${MIN_PORT}–${MAX_PORT}`

  // Reserved ports check (CodePipe Backend: 5551, CodePipe Frontend: 5552)
  const reserved = store.portRegistry?.reserved.find((r) => r.port === p)
  if (reserved) return `Reserved by ${reserved.owner}`

  // Check existing projects
  const conflict = store.projects.find(
    (proj) => proj.id !== props.projectId && proj.devServer?.port === p,
  )
  if (conflict) return `Used by ${conflict.name}`

  // Check active Tailscale serve mappings
  const activeMapping = store.portRegistry?.tailscaleMappings.find(
    (m) => m.localPort === p && m.owner !== 'Unknown' && m.owner !== project.value?.name,
  )
  if (activeMapping) return `Used by ${activeMapping.owner}`

  return null
})

const tailscalePortError = computed<string | null>(() => {
  // Required: leaving it empty used to default to 443, which is CodePipe's
  // own frontend mapping — starting the server would clobber it.
  if (tailscalePort.value === '') {
    return port.value === '' ? null : 'Required — 443 is reserved by CodePipe'
  }
  const p = parsedTailscalePort.value
  if (p === null || isNaN(p)) return 'Must be a number'
  if (p === 443) return 'Reserved by CodePipe Frontend'
  if (p < MIN_PORT || p > MAX_PORT) return `Must be ${MIN_PORT}–${MAX_PORT}`

  const conflict = store.projects.find(
    (proj) => proj.id !== props.projectId && (proj.devServer?.tailscalePort ?? 443) === p,
  )
  if (conflict) return `Used by ${conflict.name}`

  const activeMapping = store.portRegistry?.tailscaleMappings.find(
    (m) => m.tailscalePort === p && m.localPort !== parsedPort.value && m.owner !== project.value?.name,
  )
  if (activeMapping) return `Used by ${activeMapping.owner === 'Unknown' ? 'an active Tailscale mapping' : activeMapping.owner}`

  return null
})

// First free Tailscale port starting at 8443, skipping other projects'
// configs and every active Tailscale mapping.
const suggestedTailscalePort = computed<number>(() => {
  const taken = new Set<number>()
  for (const proj of store.projects) {
    if (proj.id === props.projectId) continue
    if (proj.devServer?.tailscalePort) taken.add(proj.devServer.tailscalePort)
  }
  for (const m of store.portRegistry?.tailscaleMappings ?? []) {
    taken.add(m.tailscalePort)
  }
  let candidate = 8443
  while (taken.has(candidate)) candidate++
  return candidate
})

const formValid = computed(() => {
  const p = parsedPort.value
  const tp = parsedTailscalePort.value
  return (
    startCommand.value.length > 0 &&
    !isNaN(p) &&
    p >= MIN_PORT &&
    p <= MAX_PORT &&
    tp !== null &&
    !isNaN(tp) &&
    !portError.value &&
    !tailscalePortError.value
  )
})

async function saveConfig() {
  if (!props.projectId || !formValid.value) return
  saving.value = true
  store.clearError()
  await store.updateProjectDevServer(props.projectId, {
    startCommand: startCommand.value,
    port: parseInt(port.value),
    tailscalePort: parseInt(tailscalePort.value),
  })
  saving.value = false
}

async function removeConfig() {
  if (!props.projectId) return
  await store.updateProjectDevServer(props.projectId, null)
}

async function startServer() {
  if (!props.projectId) return
  serverLoading.value = true
  store.clearError()
  try {
    await store.startDevServer(props.projectId)
  } finally {
    serverLoading.value = false
    // Refresh so the port registry reflects the new Tailscale mapping
    await store.fetchProjects()
  }
}

async function stopServer() {
  if (!props.projectId) return
  serverLoading.value = true
  store.clearError()
  try {
    await store.stopDevServer(props.projectId)
  } finally {
    serverLoading.value = false
    await store.fetchProjects()
  }
}

function openDevUrl() {
  if (devUrl.value) {
    window.open(devUrl.value, '_blank')
  }
}

async function setupProject() {
  if (!props.projectId || !project.value) return

  const p = port.value || '5173'
  const tp = tailscalePort.value || String(suggestedTailscalePort.value)
  const pm = packageManager.value

  const prompt = `Set up this project for CodePipe remote dev access. Here's what needs to happen:

1. Add a \`dev:remote\` script to package.json that sets TAILSCALE_HOST and TAILSCALE_PORT env vars before running the dev server. Use \`set\` for Windows CMD (this is a Windows machine). The tailscale host is "${store.tailscaleHostname || '<your-tailscale-host>'}" and the tailscale port is ${tp}.

2. Configure the dev server (Vite, Next, etc.) for HMR over Tailscale:
   - Bind to 0.0.0.0
   - Set port to ${p}
   - Configure HMR to use wss:// protocol with the TAILSCALE_HOST env var and clientPort from TAILSCALE_PORT env var (only when TAILSCALE_HOST is set, otherwise use defaults for local dev)
   - Set allowedHosts to true (safe on a tailnet)

3. The package manager is ${pm}.

4. IMPORTANT — single-origin rule: this app is accessed remotely (e.g. from a phone) through ONE Tailscale-served https origin, so browser code must NEVER connect directly to other localhost ports (on the phone, 127.0.0.1 is the phone; https pages also can't call http endpoints). Server-side emulator traffic (Admin SDK) is fine as-is via *_EMULATOR_HOST env vars. But if this project uses Firebase client-SDK emulators in the BROWSER, wire them through the dev server so all emulator traffic is same-origin:

   a. Read the emulator ports from firebase.json, then add Vite server.proxy entries targeting them (emulator URL paths are globally unique, so they won't clash with app routes):
      - '/identitytoolkit.googleapis.com' → http://127.0.0.1:<auth port>
      - '/securetoken.googleapis.com' → http://127.0.0.1:<auth port>
      - '/emulator' → http://127.0.0.1:<auth port>  (auth handler/widget pages used by signInWithPopup/Redirect)
      - '/google.firestore.v1.Firestore' → http://127.0.0.1:<firestore port>  (set ws: true)
      - '/v0' → http://127.0.0.1:<storage port>  (only if the storage emulator is used in the browser)

   b. In the client emulator-connection code, branch on remote mode (expose TAILSCALE_HOST to the client, e.g. via Vite define/VITE_ var, or use the mode):
      - Remote: connectAuthEmulator(auth, window.location.origin, { disableWarnings: true })
      - Remote Firestore: do NOT use connectFirestoreEmulator (it forces ssl:false, which breaks on an https page). Instead: initializeFirestore(app, { host: window.location.host, ssl: true, experimentalAutoDetectLongPolling: true })
      - Local (no TAILSCALE_HOST): keep the normal 127.0.0.1:<port> emulator connections.
      - Callable functions used from the browser: route through the same origin (proxy) or move the calls to the backend — never the raw functions emulator port.

Keep the existing dev script intact — dev:remote is a separate script for tunnel access. The regular dev script should keep working for local development.`

  emit('close')
  await sessionsStore.createSessionWithPrompt('kiro', props.projectId, prompt)
}

function close() {
  store.clearError()
  emit('close')
}
</script>

<template>
  <Teleport to="body">
    <div
      v-if="projectId && project"
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      @click.self="close"
    >
      <div class="w-full max-w-md rounded-xl bg-white shadow-xl dark:bg-gray-900">
        <!-- Header -->
        <div class="flex items-center justify-between border-b border-gray-200 px-5 py-4 dark:border-gray-800">
          <h2 class="text-base font-semibold text-gray-900 dark:text-gray-100">{{ project.name }}</h2>
          <button
            class="rounded-lg p-1 text-gray-400 transition hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-800 dark:hover:text-gray-300"
            @click="close"
          >
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" class="h-5 w-5">
              <path d="M6.28 5.22a.75.75 0 0 0-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 1 0 1.06 1.06L10 11.06l3.72 3.72a.75.75 0 1 0 1.06-1.06L11.06 10l3.72-3.72a.75.75 0 0 0-1.06-1.06L10 8.94 6.28 5.22Z" />
            </svg>
          </button>
        </div>

        <!-- Body -->
        <div class="flex flex-col gap-5 px-5 py-4">
          <!-- Project path -->
          <div>
            <div class="text-xs font-medium uppercase tracking-wider text-gray-400 dark:text-gray-500">Path</div>
            <div class="mt-0.5 truncate text-sm text-gray-700 dark:text-gray-300">{{ project.path }}</div>
          </div>

          <!-- Dev Server Status & Actions -->
          <div v-if="hasValidConfig" class="rounded-lg border border-gray-200 dark:border-gray-700">
            <div class="flex items-center justify-between px-4 py-3">
              <div class="flex items-center gap-2.5">
                <span
                  class="h-2.5 w-2.5 rounded-full"
                  :class="isRunning && hasDevRemoteScript ? 'bg-green-500 animate-pulse' : isRunning ? 'bg-amber-500 animate-pulse' : 'bg-gray-300 dark:bg-gray-600'"
                />
                <span class="text-sm font-medium text-gray-900 dark:text-gray-100">Dev Server</span>
                <span class="rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-500 dark:bg-gray-800 dark:text-gray-400">:{{ project.devServer!.port }}</span>
              </div>
              <button
                v-if="isRunning"
                :disabled="serverLoading"
                class="rounded-lg bg-red-600 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-red-700 disabled:opacity-50"
                @click="stopServer"
              >{{ serverLoading ? 'Stopping…' : 'Stop' }}</button>
              <button
                v-else-if="hasDevRemoteScript"
                :disabled="serverLoading"
                class="rounded-lg bg-green-600 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-green-700 disabled:opacity-50"
                @click="startServer"
              >{{ serverLoading ? 'Starting…' : 'Start' }}</button>
              <span
                v-else
                class="rounded-lg bg-gray-100 px-3 py-1.5 text-xs font-medium text-gray-400 dark:bg-gray-800"
              >Setup required</span>
            </div>

            <!-- Open link — only green when running AND project is properly set up -->
            <div v-if="devUrl" class="border-t border-gray-200 px-4 py-2.5 dark:border-gray-700">
              <button
                class="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left transition"
                :class="isRunning && hasDevRemoteScript
                  ? 'bg-green-50 text-green-700 hover:bg-green-100 dark:bg-green-900/20 dark:text-green-400 dark:hover:bg-green-900/30'
                  : 'bg-gray-50 text-gray-400 cursor-not-allowed dark:bg-gray-800/50 dark:text-gray-500'"
                :disabled="!isRunning || !hasDevRemoteScript"
                @click="openDevUrl"
              >
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" class="h-4 w-4 shrink-0">
                  <path d="M8.75 3.5a.75.75 0 0 0 0-1.5h-5.5a.75.75 0 0 0-.75.75v10.5c0 .414.336.75.75.75h10.5a.75.75 0 0 0 .75-.75v-5.5a.75.75 0 0 0-1.5 0v4.75H3.5V3.5h5.25Z" />
                  <path d="M10.25 1a.75.75 0 0 0 0 1.5h2.19L6.72 8.22a.75.75 0 1 0 1.06 1.06l5.72-5.72v2.19a.75.75 0 0 0 1.5 0v-4a.75.75 0 0 0-.75-.75h-4Z" />
                </svg>
                <span class="truncate text-sm font-medium">{{ devUrl }}</span>
                <span v-if="isRunning && hasDevRemoteScript" class="ml-auto shrink-0 text-xs opacity-70">Open in new tab</span>
              </button>
            </div>

            <!-- Warnings -->
            <div v-if="!hasDevRemoteScript && !detecting" class="border-t border-gray-200 px-4 py-2.5 dark:border-gray-700">
              <div class="flex items-center gap-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700 dark:bg-amber-900/20 dark:text-amber-400">
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" class="h-4 w-4 shrink-0">
                  <path fill-rule="evenodd" d="M6.701 2.25c.577-1 2.02-1 2.598 0l5.196 9a1.5 1.5 0 0 1-1.299 2.25H2.804a1.5 1.5 0 0 1-1.3-2.25l5.197-9ZM8 4a.75.75 0 0 1 .75.75v3a.75.75 0 0 1-1.5 0v-3A.75.75 0 0 1 8 4Zm0 8a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z" clip-rule="evenodd" />
                </svg>
                <span class="flex-1">No <code class="font-mono">dev:remote</code> script found. Set up the project first.</span>
                <button
                  class="shrink-0 rounded p-1 text-amber-600 transition hover:bg-amber-100 dark:text-amber-400 dark:hover:bg-amber-800/30"
                  title="Re-check"
                  @click="refreshDetection"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" class="h-3.5 w-3.5">
                    <path fill-rule="evenodd" d="M13.836 2.477a.75.75 0 0 1 .75.75v3.182a.75.75 0 0 1-.75.75h-3.182a.75.75 0 0 1 0-1.5h1.37l-.84-.841a4.5 4.5 0 0 0-7.08.932.75.75 0 0 1-1.3-.75 6 6 0 0 1 9.44-1.242l.842.84V3.227a.75.75 0 0 1 .75-.75Zm-.911 7.5A.75.75 0 0 1 13.199 11a6 6 0 0 1-9.44 1.241l-.84-.84v1.371a.75.75 0 0 1-1.5 0V9.591a.75.75 0 0 1 .75-.75H5.35a.75.75 0 0 1 0 1.5H3.98l.841.841a4.5 4.5 0 0 0 7.08-.932.75.75 0 0 1 1.025-.273Z" clip-rule="evenodd" />
                  </svg>
                </button>
              </div>
            </div>

            <div v-if="hasDevRemoteScript && !isTailscaleMapped && !detecting" class="border-t border-gray-200 px-4 py-2.5 dark:border-gray-700">
              <div class="flex items-center gap-2 rounded-lg bg-blue-50 px-3 py-2 text-xs text-blue-700 dark:bg-blue-900/20 dark:text-blue-400">
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" class="h-4 w-4 shrink-0">
                  <path fill-rule="evenodd" d="M15 8A7 7 0 1 1 1 8a7 7 0 0 1 14 0ZM9 5a1 1 0 1 1-2 0 1 1 0 0 1 2 0ZM6.75 8a.75.75 0 0 0 0 1.5h.75v1.75a.75.75 0 0 0 1.5 0v-2.5A.75.75 0 0 0 8.25 8h-1.5Z" clip-rule="evenodd" />
                </svg>
                <span>Tailscale mapping will be created automatically on start.</span>
              </div>
            </div>
          </div>

          <!-- Daily standup -->
          <div class="rounded-lg border border-gray-200 px-4 py-3 dark:border-gray-700">
            <div class="flex items-center justify-between">
              <div>
                <div class="text-sm font-medium text-gray-900 dark:text-gray-100">Daily standup</div>
                <p class="text-xs text-gray-400 dark:text-gray-500">
                  Your team reviews this project's ideas once a day (skipped when nothing changed).
                  If the machine was asleep at the scheduled time, it catches up on wake.
                </p>
              </div>
              <button
                class="relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition"
                :class="standupEnabled ? 'bg-purple-600' : 'bg-gray-300 dark:bg-gray-600'"
                role="switch"
                :aria-checked="standupEnabled"
                @click="standupEnabled = !standupEnabled; saveStandup()"
              >
                <span
                  class="inline-block h-3.5 w-3.5 transform rounded-full bg-white transition"
                  :class="standupEnabled ? 'translate-x-[18px]' : 'translate-x-1'"
                />
              </button>
            </div>
            <div v-if="standupEnabled" class="mt-2.5 flex items-center gap-2">
              <label class="text-xs text-gray-500 dark:text-gray-400">Runs at</label>
              <select
                v-model.number="standupHour"
                class="rounded border border-gray-200 bg-white px-2 py-1 text-xs text-gray-700 focus:border-blue-500 focus:outline-none dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300"
                @change="saveStandup"
              >
                <option v-for="h in 24" :key="h - 1" :value="h - 1">{{ formatHour(h - 1) }}</option>
              </select>
              <span v-if="standupSaving" class="text-xs text-gray-400">Saving…</span>
            </div>
          </div>

          <!-- Detection badges (no config yet) -->
          <div v-if="!hasValidConfig && !detecting && detectedFramework" class="flex flex-wrap items-center gap-2">
            <span class="rounded-full bg-purple-50 px-2.5 py-0.5 text-xs font-medium text-purple-700 dark:bg-purple-900/20 dark:text-purple-400">{{ detectedFramework }}</span>
            <span class="rounded-full bg-blue-50 px-2.5 py-0.5 text-xs font-medium text-blue-700 dark:bg-blue-900/20 dark:text-blue-400">{{ packageManager }}</span>
            <span v-if="detectedSubDir" class="rounded-full bg-gray-100 px-2.5 py-0.5 text-xs text-gray-600 dark:bg-gray-800 dark:text-gray-400">./{{ detectedSubDir }}</span>
          </div>

          <div v-if="detecting" class="py-2 text-center text-sm text-gray-400">Detecting…</div>

          <!-- Config form -->
          <div class="flex flex-col gap-3">
            <!-- Package manager selector -->
            <div v-if="!useCustomCommand">
              <label class="mb-1 block text-xs text-gray-500 dark:text-gray-400">Package Manager</label>
              <div class="flex gap-1">
                <button
                  v-for="pm in (['npm', 'bun', 'pnpm', 'yarn'] as PackageManager[])"
                  :key="pm"
                  class="rounded-lg px-3 py-1.5 text-xs font-medium transition"
                  :class="packageManager === pm
                    ? 'bg-blue-600 text-white'
                    : 'bg-gray-100 text-gray-600 hover:bg-gray-200 dark:bg-gray-800 dark:text-gray-400 dark:hover:bg-gray-700'"
                  @click="packageManager = pm"
                >{{ pm }}</button>
              </div>
              <p class="mt-1.5 font-mono text-xs text-gray-500 dark:text-gray-400">
                → {{ startCommand }}
              </p>
            </div>

            <!-- Custom command (fallback for non-JS projects) -->
            <div v-if="useCustomCommand">
              <label class="mb-1 block text-xs text-gray-500 dark:text-gray-400">Custom Command</label>
              <input
                v-model="customCommand"
                type="text"
                placeholder="flutter run -d web-server --web-port 5173"
                class="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-900 placeholder:text-gray-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100"
              />
            </div>

            <!-- Toggle between convention / custom -->
            <button
              class="self-start text-xs text-blue-600 hover:text-blue-700 dark:text-blue-400"
              @click="useCustomCommand = !useCustomCommand"
            >
              {{ useCustomCommand ? 'Use convention (dev:remote)' : 'Use custom command' }}
            </button>

            <!-- Ports -->
            <div class="grid grid-cols-2 gap-3">
              <div>
                <label class="mb-1 block text-xs text-gray-500 dark:text-gray-400">Local Port <span class="text-gray-400 dark:text-gray-600">1024–65535</span></label>
                <input
                  v-model="port"
                  type="number"
                  placeholder="5173"
                  class="w-full rounded-lg border bg-white px-3 py-2 text-sm text-gray-900 placeholder:text-gray-400 focus:outline-none focus:ring-1 dark:bg-gray-800 dark:text-gray-100"
                  :class="portError
                    ? 'border-red-300 focus:border-red-500 focus:ring-red-500 dark:border-red-700'
                    : 'border-gray-200 focus:border-blue-500 focus:ring-blue-500 dark:border-gray-700'"
                />
                <p v-if="portError" class="mt-1 text-xs text-red-500 dark:text-red-400">{{ portError }}</p>
              </div>
              <div>
                <label class="mb-1 block text-xs text-gray-500 dark:text-gray-400">Tailscale Port <span class="text-gray-400 dark:text-gray-600">1024–65535</span></label>
                <input
                  v-model="tailscalePort"
                  type="number"
                  :placeholder="String(suggestedTailscalePort)"
                  class="w-full rounded-lg border bg-white px-3 py-2 text-sm text-gray-900 placeholder:text-gray-400 focus:outline-none focus:ring-1 dark:bg-gray-800 dark:text-gray-100"
                  :class="tailscalePortError
                    ? 'border-red-300 focus:border-red-500 focus:ring-red-500 dark:border-red-700'
                    : 'border-gray-200 focus:border-blue-500 focus:ring-blue-500 dark:border-gray-700'"
                />
                <p v-if="tailscalePortError" class="mt-1 text-xs text-red-500 dark:text-red-400">{{ tailscalePortError }}</p>
                <button
                  v-if="tailscalePort === '' || tailscalePortError"
                  class="mt-1 text-xs text-blue-600 hover:text-blue-700 dark:text-blue-400"
                  @click="tailscalePort = String(suggestedTailscalePort)"
                >Use {{ suggestedTailscalePort }} (free)</button>
              </div>
            </div>

            <!-- Server-side error (port conflicts on save/start) -->
            <div v-if="store.error" class="flex items-start gap-2 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700 dark:bg-red-900/20 dark:text-red-400">
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" class="mt-0.5 h-4 w-4 shrink-0">
                <path fill-rule="evenodd" d="M6.701 2.25c.577-1 2.02-1 2.598 0l5.196 9a1.5 1.5 0 0 1-1.299 2.25H2.804a1.5 1.5 0 0 1-1.3-2.25l5.197-9ZM8 4a.75.75 0 0 1 .75.75v3a.75.75 0 0 1-1.5 0v-3A.75.75 0 0 1 8 4Zm0 8a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z" clip-rule="evenodd" />
              </svg>
              <span>{{ store.error }}</span>
            </div>

            <!-- Action buttons -->
            <div class="flex items-center gap-2 pt-1">
              <button
                :disabled="!formValid || saving"
                class="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
                @click="saveConfig"
              >{{ saving ? 'Saving…' : hasValidConfig ? 'Update' : 'Save Config' }}</button>
              <button
                v-if="hasValidConfig"
                class="rounded-lg border border-red-200 px-4 py-2 text-sm font-medium text-red-600 transition hover:bg-red-50 dark:border-red-800 dark:text-red-400 dark:hover:bg-red-900/20"
                @click="removeConfig"
              >Remove</button>
            </div>

            <!-- Set up project via AI — only show if dev:remote doesn't exist yet -->
            <div v-if="hasValidConfig && !hasDevRemoteScript" class="border-t border-gray-200 pt-3 dark:border-gray-700">
              <button
                class="flex w-full items-center justify-center gap-2 rounded-lg border border-gray-200 px-4 py-2 text-sm font-medium text-gray-700 transition hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
                @click="setupProject"
              >
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" class="h-4 w-4">
                  <path fill-rule="evenodd" d="M11.5 8a3.5 3.5 0 0 0-3.495-3.5H7.5v-1A2.5 2.5 0 0 0 5 1H3.5A2.5 2.5 0 0 0 1 3.5V5a2.5 2.5 0 0 0 2.5 2.5h1V8.5A3.5 3.5 0 0 0 8 12h.5v1a2.5 2.5 0 0 0 2.5 2.5h1.5A2.5 2.5 0 0 0 15 13v-1.5a2.5 2.5 0 0 0-2.5-2.5H11v-.5A3.5 3.5 0 0 0 11.5 8ZM3.5 2.5H5A1 1 0 0 1 6 3.5v1H3.5A1 1 0 0 1 2.5 3.5V5a1 1 0 0 0 1-1V2.5ZM12.5 11H11a1 1 0 0 0-1 1v1.5a1 1 0 0 0 1 1h1.5a1 1 0 0 0 1-1V12a1 1 0 0 0-1-1Z" clip-rule="evenodd" />
                </svg>
                Set up project for remote dev
              </button>
              <p class="mt-1.5 text-center text-xs text-gray-400 dark:text-gray-500">
                Opens a chat to add dev:remote script &amp; configure HMR
              </p>
            </div>

            <!-- Already configured indicator -->
            <div v-if="hasValidConfig && hasDevRemoteScript" class="border-t border-gray-200 pt-3 dark:border-gray-700">
              <div class="flex items-center justify-center gap-1.5 text-xs text-green-600 dark:text-green-400">
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" class="h-3.5 w-3.5">
                  <path fill-rule="evenodd" d="M12.416 3.376a.75.75 0 0 1 .208 1.04l-5 7.5a.75.75 0 0 1-1.154.114l-3-3a.75.75 0 0 1 1.06-1.06l2.353 2.353 4.493-6.74a.75.75 0 0 1 1.04-.207Z" clip-rule="evenodd" />
                </svg>
                dev:remote script found — project is ready
              </div>
              <button
                class="mt-1.5 block w-full text-center text-xs text-blue-600 hover:text-blue-700 dark:text-blue-400"
                @click="setupProject"
              >Re-run remote setup (HMR + same-origin emulator proxy)</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  </Teleport>
</template>
