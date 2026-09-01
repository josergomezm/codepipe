<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useTeamStore } from '@/stores/team'
import PersonaAvatar from '@/components/PersonaAvatar.vue'
import type { Persona, ProviderType } from '@/api/client'

const emit = defineEmits<{ close: [] }>()

const teamStore = useTeamStore()

const editingId = ref<string | null>(null)
const showForm = ref(false)

// Form state
const name = ref('')
const role = ref('')
const personality = ref('')
const provider = ref<ProviderType>('kiro')
const model = ref('')
const isLead = ref(false)
const saving = ref(false)

const avatarInput = ref<HTMLInputElement | null>(null)
const avatarTargetId = ref<string | null>(null)

onMounted(() => {
  teamStore.fetchPersonas()
})

function startAdd() {
  editingId.value = null
  name.value = ''
  role.value = ''
  personality.value = ''
  provider.value = 'kiro'
  model.value = ''
  isLead.value = teamStore.personas.length === 0
  showForm.value = true
}

function startEdit(persona: Persona) {
  editingId.value = persona.id
  name.value = persona.name
  role.value = persona.role
  personality.value = persona.personality
  provider.value = persona.provider
  model.value = persona.model ?? ''
  isLead.value = persona.isLead
  showForm.value = true
}

async function save() {
  if (!name.value.trim() || !role.value.trim()) return
  saving.value = true
  const data = {
    name: name.value.trim(),
    role: role.value.trim(),
    personality: personality.value.trim(),
    provider: provider.value,
    ...(model.value.trim() ? { model: model.value.trim() } : {}),
    isLead: isLead.value,
  }
  if (editingId.value) {
    await teamStore.updatePersona(editingId.value, data)
  } else {
    await teamStore.createPersona(data)
  }
  saving.value = false
  if (!teamStore.error) showForm.value = false
}

async function remove(id: string) {
  await teamStore.deletePersona(id)
}

function pickAvatar(id: string) {
  avatarTargetId.value = id
  avatarInput.value?.click()
}

async function onAvatarChosen(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (file && avatarTargetId.value) {
    await teamStore.uploadAvatar(avatarTargetId.value, file)
  }
  input.value = ''
  avatarTargetId.value = null
}

function close() {
  teamStore.clearError()
  emit('close')
}
</script>

<template>
  <Teleport to="body">
    <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" @click.self="close">
      <div class="flex max-h-[85vh] w-full max-w-md flex-col rounded-xl bg-white shadow-xl dark:bg-gray-900">
        <!-- Header -->
        <div class="flex items-center justify-between border-b border-gray-200 px-5 py-4 dark:border-gray-800">
          <h2 class="text-base font-semibold text-gray-900 dark:text-gray-100">Your team</h2>
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
        <div class="flex flex-col gap-3 overflow-y-auto px-5 py-4">
          <p class="text-xs text-gray-400 dark:text-gray-500">
            Personas review your project ideas in daily standups and message you with proposals and questions. Tap an avatar to set a profile picture — it shows on notifications.
          </p>

          <div v-if="teamStore.error" class="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700 dark:bg-red-900/20 dark:text-red-400">
            {{ teamStore.error }}
          </div>

          <!-- Roster -->
          <div
            v-for="persona in teamStore.personas"
            :key="persona.id"
            class="flex items-center gap-3 rounded-lg border border-gray-200 px-3 py-2 dark:border-gray-700"
          >
            <button title="Change profile picture" @click="pickAvatar(persona.id)">
              <PersonaAvatar :persona="persona" />
            </button>
            <div class="min-w-0 flex-1">
              <div class="flex items-center gap-1.5">
                <span class="truncate text-sm font-medium text-gray-900 dark:text-gray-100">{{ persona.name }}</span>
                <span
                  v-if="persona.isLead"
                  class="shrink-0 rounded-full bg-purple-100 px-1.5 text-[10px] font-medium text-purple-700 dark:bg-purple-900/40 dark:text-purple-300"
                >lead</span>
              </div>
              <div class="truncate text-xs text-gray-400 dark:text-gray-500">
                {{ persona.role }} · {{ persona.provider }}<span v-if="persona.model"> ({{ persona.model }})</span>
              </div>
            </div>
            <button
              class="shrink-0 rounded p-1 text-gray-400 transition hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-700 dark:hover:text-gray-300"
              title="Edit"
              @click="startEdit(persona)"
            >
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" class="h-3.5 w-3.5">
                <path d="M13.488 2.513a1.75 1.75 0 0 0-2.475 0L6.75 6.774a2.75 2.75 0 0 0-.596.892l-.848 2.047a.75.75 0 0 0 .98.98l2.047-.848a2.75 2.75 0 0 0 .892-.596l4.261-4.262a1.75 1.75 0 0 0 0-2.474Z" />
                <path d="M4.75 3.5c-.69 0-1.25.56-1.25 1.25v6.5c0 .69.56 1.25 1.25 1.25h6.5c.69 0 1.25-.56 1.25-1.25V9A.75.75 0 0 1 14 9v2.25A2.75 2.75 0 0 1 11.25 14h-6.5A2.75 2.75 0 0 1 2 11.25v-6.5A2.75 2.75 0 0 1 4.75 2H7a.75.75 0 0 1 0 1.5H4.75Z" />
              </svg>
            </button>
            <button
              class="shrink-0 rounded p-1 text-gray-400 transition hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-900/20 dark:hover:text-red-400"
              title="Remove"
              @click="remove(persona.id)"
            >
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" class="h-3.5 w-3.5">
                <path fill-rule="evenodd" d="M5 3.25V4H2.75a.75.75 0 0 0 0 1.5h.3l.815 8.15A1.5 1.5 0 0 0 5.357 15h5.285a1.5 1.5 0 0 0 1.493-1.35l.815-8.15h.3a.75.75 0 0 0 0-1.5H11v-.75A2.25 2.25 0 0 0 8.75 1h-1.5A2.25 2.25 0 0 0 5 3.25Zm2.25-.75a.75.75 0 0 0-.75.75V4h3v-.75a.75.75 0 0 0-.75-.75h-1.5Z" clip-rule="evenodd" />
              </svg>
            </button>
          </div>

          <!-- Add / edit form -->
          <div v-if="showForm" class="flex flex-col gap-2 rounded-lg bg-gray-50 p-3 dark:bg-gray-800/50">
            <div class="grid grid-cols-2 gap-2">
              <input
                v-model="name"
                type="text"
                placeholder="Name (e.g. Maya)"
                class="rounded border border-gray-200 bg-white px-2 py-1.5 text-xs text-gray-900 placeholder:text-gray-400 focus:border-blue-500 focus:outline-none dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
              />
              <input
                v-model="role"
                type="text"
                placeholder="Role (e.g. Tech lead)"
                class="rounded border border-gray-200 bg-white px-2 py-1.5 text-xs text-gray-900 placeholder:text-gray-400 focus:border-blue-500 focus:outline-none dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
              />
            </div>
            <textarea
              v-model="personality"
              rows="3"
              placeholder="Personality &amp; behavior — how they think, what they push back on, how they write."
              class="rounded border border-gray-200 bg-white px-2 py-1.5 text-xs text-gray-900 placeholder:text-gray-400 focus:border-blue-500 focus:outline-none dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
            />
            <div class="grid grid-cols-2 gap-2">
              <select
                v-model="provider"
                class="rounded border border-gray-200 bg-white px-2 py-1.5 text-xs text-gray-700 focus:border-blue-500 focus:outline-none dark:border-gray-700 dark:bg-gray-900 dark:text-gray-300"
              >
                <option value="kiro">Kiro</option>
                <option value="gemini">Gemini</option>
                <option value="claude">Claude</option>
                <!-- Codex has no adapter yet — re-enable once it's implemented -->
                <!-- <option value="codex">Codex</option> -->
              </select>
              <input
                v-model="model"
                type="text"
                placeholder="Model (optional)"
                class="rounded border border-gray-200 bg-white px-2 py-1.5 text-xs text-gray-900 placeholder:text-gray-400 focus:border-blue-500 focus:outline-none dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
              />
            </div>
            <p class="text-[11px] text-gray-400 dark:text-gray-500">
              Provider and model are used when this persona leads — the lead's CLI runs the whole standup.
            </p>
            <label class="flex items-center gap-2 text-xs text-gray-600 dark:text-gray-400">
              <input v-model="isLead" type="checkbox" class="rounded" />
              Team lead — their provider runs the standup and they summarize for you
            </label>
            <p v-if="isLead" class="text-[11px] text-gray-400 dark:text-gray-500">
              Changing the lead's provider starts a fresh team thread on the next standup (old threads stay as history).
            </p>
            <div class="flex gap-1.5">
              <button
                :disabled="saving || !name.trim() || !role.trim()"
                class="flex-1 rounded bg-blue-600 px-2 py-1.5 text-xs font-medium text-white transition hover:bg-blue-700 disabled:opacity-50"
                @click="save"
              >{{ saving ? 'Saving…' : editingId ? 'Update' : 'Add' }}</button>
              <button
                class="flex-1 rounded bg-gray-200 px-2 py-1.5 text-xs font-medium text-gray-700 transition hover:bg-gray-300 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600"
                @click="showForm = false"
              >Cancel</button>
            </div>
          </div>

          <button
            v-if="!showForm"
            class="flex items-center justify-center gap-1 rounded-lg border border-dashed border-gray-300 px-2 py-2 text-xs text-gray-500 transition hover:border-gray-400 hover:text-gray-700 dark:border-gray-700 dark:text-gray-400 dark:hover:border-gray-600 dark:hover:text-gray-300"
            @click="startAdd"
          >
            + Add team member
          </button>
        </div>

        <input ref="avatarInput" type="file" accept="image/*" class="hidden" @change="onAvatarChosen" />
      </div>
    </div>
  </Teleport>
</template>
