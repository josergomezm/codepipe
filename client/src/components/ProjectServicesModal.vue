<script setup lang="ts">
import { ref, computed, watch, onUnmounted } from 'vue'
import { useProjectsStore } from '@/stores/projects'
import { useSessionsStore } from '@/stores/sessions'
import { detectFirebase } from '@/api/client'
import type { ServiceWithState, DetectFirebaseResponse } from '@/api/client'

const props = defineProps<{
  projectId: string | null
}>()

const emit = defineEmits<{
  close: []
}>()

const store = useProjectsStore()
const sessionsStore = useSessionsStore()

const project = computed(() => store.projects.find((p) => p.id === props.projectId))
const services = computed<ServiceWithState[]>(() =>
  props.projectId ? store.getServices(props.projectId) : [],
)

// Firebase emulators are a singleton per project — hide the add flow once present
const hasFirebaseService = computed(() =>
  services.value.some((s) => s.type === 'firebase-emulators'),
)

// Detection state
const detecting = ref(false)
const detected = ref<DetectFirebaseResponse | null>(null)
const detectError = ref<string | null>(null)

// Per-service loading state
const loadingId = ref<string | null>(null)

// Polling for running services
let pollTimer: ReturnType<typeof setInterval> | null = null

function startPolling() {
  if (pollTimer) return
  pollTimer = setInterval(async () => {
    if (!props.projectId) return
    const running = services.value.filter((s) => s.state.status === 'running')
    for (const svc of running) {
      await store.refreshServiceStatus(props.projectId, svc.id)
    }
  }, 3000)
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
}

onUnmounted(stopPolling)

watch(
  () => props.projectId,
  async (id) => {
    detected.value = null
    detectError.value = null
    if (!id) {
      stopPolling()
      return
    }
    await store.fetchServices(id)
    startPolling()
  },
  { immediate: true },
)

watch(
  () => services.value.some((s) => s.state.status === 'running'),
  (hasRunning) => {
    if (hasRunning) startPolling()
  },
)

async function runDetect() {
  if (!props.projectId) return
  detecting.value = true
  detectError.value = null
  try {
    detected.value = await detectFirebase(props.projectId)
  } catch (e) {
    detectError.value = e instanceof Error ? e.message : 'Detection failed'
  } finally {
    detecting.value = false
  }
}

async function addDetected() {
  if (!props.projectId || !detected.value?.suggested || hasFirebaseService.value) return
  loadingId.value = 'adding'
  await store.addService(props.projectId, detected.value.suggested)
  detected.value = null
  loadingId.value = null
}

async function startService(serviceId: string) {
  if (!props.projectId) return
  loadingId.value = serviceId
  store.clearError()
  await store.startService(props.projectId, serviceId)
  loadingId.value = null
  startPolling()
}

async function stopService(serviceId: string) {
  if (!props.projectId) return
  loadingId.value = serviceId
  store.clearError()
  await store.stopService(props.projectId, serviceId)
  loadingId.value = null
}

async function removeService(serviceId: string) {
  if (!props.projectId) return
  loadingId.value = serviceId
  await store.removeService(props.projectId, serviceId)
  loadingId.value = null
}

// True when the shown error is a port conflict — enables the fix-ports flow
const isPortConflictError = computed(
  () => !!store.error && store.error.toLowerCase().includes('port'),
)

/**
 * Open an AI session that rewrites this project's firebase.json with a
 * unique emulator port block and updates code references to the old ports.
 */
async function fixEmulatorPorts() {
  if (!props.projectId) return

  // Every local port we know is taken on this machine
  const taken = new Set<number>()
  for (const r of store.portRegistry?.reserved ?? []) taken.add(r.port)
  for (const m of store.portRegistry?.tailscaleMappings ?? []) taken.add(m.localPort)
  for (const p of store.projects) {
    if (p.devServer) taken.add(p.devServer.port)
  }
  const takenList = [...taken].sort((a, b) => a - b).join(', ')

  const conflictContext = isPortConflictError.value
    ? `The emulators just failed to start with this error: "${store.error}"\n\n`
    : ''

  const prompt = `${conflictContext}Fix the Firebase emulator ports of this project so its emulators can run alongside other projects on this machine. Firebase's default ports are the same for every project, so this project needs its own unique port block.

1. Locate firebase.json (project root or an immediate subdirectory).

2. In its "emulators" section, set an explicit unique "port" for EVERY emulator this project uses — including "ui" and "hub" even if they currently have no entry. Firebase defaults for reference: auth 9099, functions 5001, firestore 8080, database 9000, hosting 5000, pubsub 8085, storage 9199, eventarc 9299, ui 4000, hub 4400.

3. Pick one consistent offset from those defaults (e.g. +100 or +1000) so the block is easy to remember, and make sure NONE of the new ports are in this list of ports already taken on this machine: ${takenList || '(none known)'}. Also avoid the plain Firebase defaults, since other projects use them.

4. Search this codebase for references to the old emulator ports and update them to the new ones — connectAuthEmulator / connectFirestoreEmulator / connectFunctionsEmulator / connectStorageEmulator / connectDatabaseEmulator calls, Vite server.proxy targets, .env files, test configs, and scripts.

5. Single-origin rule check: this app is accessed remotely through one Tailscale-served https origin, so BROWSER code must never connect directly to emulator localhost ports. Emulator traffic belongs either in the backend (Admin SDK with *_EMULATOR_HOST env vars) or behind the dev server's same-origin proxy — Vite server.proxy entries for the emulators' unique paths ('/identitytoolkit.googleapis.com', '/securetoken.googleapis.com', '/emulator' → auth port; '/google.firestore.v1.Firestore' → firestore port with ws: true; '/v0' → storage port), with the client connecting via window.location.origin in remote mode (for Firestore use initializeFirestore with { host: window.location.host, ssl: true, experimentalAutoDetectLongPolling: true } instead of connectFirestoreEmulator). If any emulator connection you touch in step 4 runs in the browser without this, refactor it accordingly.

6. Change nothing else in firebase.json.`

  close()
  await sessionsStore.createSessionWithPrompt('kiro', props.projectId, prompt)
}

function statusColor(status: string) {
  if (status === 'running') return 'bg-green-500'
  if (status === 'error') return 'bg-red-500'
  return 'bg-gray-300 dark:bg-gray-600'
}

function openUrl(url: string) {
  window.open(url, '_blank')
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
      <div class="flex w-full max-w-lg flex-col rounded-xl bg-white shadow-xl dark:bg-gray-900 max-h-[85vh]">
        <!-- Header -->
        <div class="flex items-center justify-between border-b border-gray-200 px-5 py-4 dark:border-gray-800 shrink-0">
          <div>
            <h2 class="text-base font-semibold text-gray-900 dark:text-gray-100">{{ project.name }}</h2>
            <p class="text-xs text-gray-400 dark:text-gray-500">Services &amp; Emulators</p>
          </div>
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
        <div class="flex flex-col gap-4 overflow-y-auto px-5 py-4">
          <!-- Server-side error (e.g. emulator port conflicts) -->
          <div v-if="store.error" class="rounded-lg bg-red-50 px-3 py-2 dark:bg-red-900/20">
            <div class="flex items-start gap-2 text-xs text-red-700 dark:text-red-400">
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" class="mt-0.5 h-4 w-4 shrink-0">
                <path fill-rule="evenodd" d="M6.701 2.25c.577-1 2.02-1 2.598 0l5.196 9a1.5 1.5 0 0 1-1.299 2.25H2.804a1.5 1.5 0 0 1-1.3-2.25l5.197-9ZM8 4a.75.75 0 0 1 .75.75v3a.75.75 0 0 1-1.5 0v-3A.75.75 0 0 1 8 4Zm0 8a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z" clip-rule="evenodd" />
              </svg>
              <span>{{ store.error }}</span>
            </div>
            <button
              v-if="isPortConflictError"
              class="mt-2 rounded-lg bg-red-600 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-red-700"
              @click="fixEmulatorPorts"
            >Fix ports with AI</button>
          </div>

          <!-- Existing services -->
          <div v-if="services.length > 0" class="flex flex-col gap-2">
            <div
              v-for="svc in services"
              :key="svc.id"
              class="rounded-lg border border-gray-200 dark:border-gray-700"
            >
              <!-- Service header row -->
              <div class="flex items-center gap-3 px-4 py-3">
                <span
                  class="h-2.5 w-2.5 shrink-0 rounded-full"
                  :class="[statusColor(svc.state.status), svc.state.status === 'running' ? 'animate-pulse' : '']"
                />
                <div class="min-w-0 flex-1">
                  <div class="flex items-center gap-2">
                    <span class="text-sm font-medium text-gray-900 dark:text-gray-100">{{ svc.label }}</span>
                    <span class="rounded-full bg-gray-100 px-2 py-0.5 text-[10px] text-gray-500 dark:bg-gray-800 dark:text-gray-400">{{ svc.type }}</span>
                  </div>
                  <div class="mt-0.5 font-mono text-xs text-gray-500 dark:text-gray-500 truncate">{{ svc.startCommand }}</div>
                </div>
                <!-- Controls -->
                <div class="flex shrink-0 items-center gap-1.5">
                  <button
                    v-if="svc.type === 'firebase-emulators' && svc.state.status !== 'running'"
                    :disabled="loadingId === svc.id"
                    class="rounded p-1.5 text-gray-400 transition hover:bg-gray-100 hover:text-blue-500 dark:hover:bg-gray-800 dark:hover:text-blue-400"
                    title="Fix emulator ports with AI"
                    @click="fixEmulatorPorts"
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" class="h-3.5 w-3.5">
                      <path fill-rule="evenodd" d="M11.5 1.5a3 3 0 0 0-2.87 3.87L4.94 9.06a3 3 0 1 0 2 2l3.69-3.69A3 3 0 1 0 11.5 1.5Zm-6 9a1 1 0 1 1-2 0 1 1 0 0 1 2 0Zm7.5-6a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0Z" clip-rule="evenodd" />
                    </svg>
                  </button>
                  <button
                    v-if="svc.state.status !== 'running'"
                    :disabled="loadingId === svc.id"
                    class="rounded-lg bg-green-600 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-green-700 disabled:opacity-50"
                    @click="startService(svc.id)"
                  >{{ loadingId === svc.id ? '…' : 'Start' }}</button>
                  <button
                    v-else
                    :disabled="loadingId === svc.id"
                    class="rounded-lg bg-red-600 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-red-700 disabled:opacity-50"
                    @click="stopService(svc.id)"
                  >{{ loadingId === svc.id ? '…' : 'Stop' }}</button>
                  <button
                    :disabled="loadingId === svc.id"
                    class="rounded p-1.5 text-gray-400 transition hover:bg-gray-100 hover:text-red-500 dark:hover:bg-gray-800 dark:hover:text-red-400"
                    title="Remove service"
                    @click="removeService(svc.id)"
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" class="h-3.5 w-3.5">
                      <path fill-rule="evenodd" d="M5 3.25V4H2.75a.75.75 0 0 0 0 1.5h.3l.815 8.15A1.5 1.5 0 0 0 5.357 15h5.285a1.5 1.5 0 0 0 1.493-1.35l.815-8.15h.3a.75.75 0 0 0 0-1.5H11v-.75A2.25 2.25 0 0 0 8.75 1h-1.5A2.25 2.25 0 0 0 5 3.25Zm2.25-.75a.75.75 0 0 0-.75.75V4h3v-.75a.75.75 0 0 0-.75-.75h-1.5ZM6.05 6a.75.75 0 0 1 .787.713l.275 5.5a.75.75 0 0 1-1.498.075l-.275-5.5A.75.75 0 0 1 6.05 6Zm3.9 0a.75.75 0 0 1 .712.787l-.275 5.5a.75.75 0 0 1-1.498-.075l.275-5.5a.75.75 0 0 1 .786-.711Z" clip-rule="evenodd" />
                    </svg>
                  </button>
                </div>
              </div>

              <!-- Runtime info (when running) -->
              <div
                v-if="svc.state.status === 'running'"
                class="border-t border-gray-100 px-4 py-2.5 dark:border-gray-800"
              >
                <!-- Emulator UI link -->
                <div v-if="svc.state.uiUrl" class="mb-2">
                  <button
                    class="flex items-center gap-1.5 rounded-lg bg-green-50 px-3 py-1.5 text-xs font-medium text-green-700 transition hover:bg-green-100 dark:bg-green-900/20 dark:text-green-400 dark:hover:bg-green-900/30"
                    @click="openUrl(svc.state.uiUrl!)"
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" class="h-3.5 w-3.5">
                      <path d="M8.75 3.5a.75.75 0 0 0 0-1.5h-5.5a.75.75 0 0 0-.75.75v10.5c0 .414.336.75.75.75h10.5a.75.75 0 0 0 .75-.75v-5.5a.75.75 0 0 0-1.5 0v4.75H3.5V3.5h5.25Z" />
                      <path d="M10.25 1a.75.75 0 0 0 0 1.5h2.19L6.72 8.22a.75.75 0 1 0 1.06 1.06l5.72-5.72v2.19a.75.75 0 0 0 1.5 0v-4a.75.75 0 0 0-.75-.75h-4Z" />
                    </svg>
                    Open Emulator UI
                    <span class="font-mono font-normal opacity-70">{{ svc.state.uiUrl }}</span>
                  </button>
                </div>

                <!-- Port table -->
                <div v-if="Object.keys(svc.state.ports).length > 0" class="flex flex-wrap gap-1.5">
                  <span
                    v-for="(info, name) in svc.state.ports"
                    :key="name"
                    class="rounded-full bg-gray-100 px-2.5 py-0.5 font-mono text-[10px] text-gray-600 dark:bg-gray-800 dark:text-gray-400"
                  >{{ name }}: {{ info.port }}</span>
                </div>
                <div v-else class="text-xs text-gray-400 dark:text-gray-500">Starting up…</div>
              </div>

              <!-- Error -->
              <div
                v-if="svc.state.status === 'error'"
                class="border-t border-red-100 bg-red-50 px-4 py-2.5 dark:border-red-900/30 dark:bg-red-900/10"
              >
                <p class="text-xs text-red-600 dark:text-red-400">{{ svc.state.error ?? 'Process exited with error' }}</p>
              </div>

              <!-- Recent logs (last 5 lines) -->
              <div
                v-if="svc.state.logs.length > 0 && svc.state.status !== 'stopped'"
                class="border-t border-gray-100 dark:border-gray-800"
              >
                <pre class="max-h-24 overflow-y-auto rounded-b-lg bg-gray-950 px-4 py-2 font-mono text-[10px] leading-relaxed text-gray-300">{{ svc.state.logs.slice(-10).join('\n') }}</pre>
              </div>
            </div>
          </div>

          <!-- Empty state -->
          <div v-else class="py-4 text-center text-sm text-gray-400 dark:text-gray-500">
            No services configured for this project
          </div>

          <!-- Firebase detection section (hidden once emulators are configured) -->
          <div v-if="!hasFirebaseService" class="rounded-lg border border-dashed border-gray-200 dark:border-gray-700">
            <div class="px-4 py-3">
              <div class="flex items-center justify-between">
                <div>
                  <p class="text-sm font-medium text-gray-700 dark:text-gray-300">Firebase Emulators</p>
                  <p class="text-xs text-gray-400 dark:text-gray-500">Auto-detect firebase.json and emulators script</p>
                </div>
                <button
                  :disabled="detecting"
                  class="rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-600 transition hover:bg-gray-50 disabled:opacity-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
                  @click="runDetect"
                >
                  <span v-if="detecting" class="flex items-center gap-1.5">
                    <svg class="h-3 w-3 animate-spin" fill="none" viewBox="0 0 24 24">
                      <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
                      <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                    </svg>
                    Detecting…
                  </span>
                  <span v-else>Detect</span>
                </button>
              </div>

              <!-- Error -->
              <p v-if="detectError" class="mt-2 text-xs text-red-500">{{ detectError }}</p>

              <!-- Not found -->
              <div
                v-else-if="detected && !detected.detection.found"
                class="mt-2 rounded-lg bg-gray-50 px-3 py-2 text-xs text-gray-500 dark:bg-gray-800 dark:text-gray-400"
              >
                No firebase.json found in this project.
              </div>

              <!-- Found but no script -->
              <div
                v-else-if="detected && detected.detection.found && !detected.suggested"
                class="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700 dark:bg-amber-900/20 dark:text-amber-400"
              >
                firebase.json found but no emulators script detected in package.json.
                Add a script like <code class="font-mono">"emulators": "firebase emulators:start"</code> to use this feature.
              </div>

              <!-- Suggested config ready to add -->
              <div
                v-else-if="detected?.suggested"
                class="mt-3 rounded-lg border border-green-200 bg-green-50 dark:border-green-800 dark:bg-green-900/10"
              >
                <div class="px-3 py-2.5">
                  <p class="mb-1.5 text-xs font-medium text-green-800 dark:text-green-300">Detected Firebase Emulators</p>
                  <div class="font-mono text-[10px] text-green-700 dark:text-green-400 mb-1">{{ detected.suggested.startCommand }}</div>
                  <div
                    v-if="Object.keys(detected.detection.defaultPorts).length > 0"
                    class="flex flex-wrap gap-1"
                  >
                    <span
                      v-for="(port, name) in detected.detection.defaultPorts"
                      :key="name"
                      class="rounded-full bg-green-100 px-2 py-0.5 font-mono text-[10px] text-green-700 dark:bg-green-900/30 dark:text-green-400"
                    >{{ name }}: {{ port }}</span>
                  </div>
                </div>
                <div class="flex justify-end border-t border-green-200 px-3 py-2 dark:border-green-800">
                  <button
                    :disabled="loadingId === 'adding'"
                    class="rounded-lg bg-green-600 px-4 py-1.5 text-xs font-medium text-white transition hover:bg-green-700 disabled:opacity-50"
                    @click="addDetected"
                  >{{ loadingId === 'adding' ? 'Adding…' : 'Add Service' }}</button>
                </div>
              </div>
            </div>
          </div>

        </div>
      </div>
    </div>
  </Teleport>
</template>
