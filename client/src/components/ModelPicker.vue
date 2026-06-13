<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { useSessionsStore } from '@/stores/sessions'
import { useSession } from '@/composables/useSession'
import type { ModelOption } from '@/api/client'

const CUSTOM = '__custom__'

const store = useSessionsStore()
const { availableModels, currentModel } = storeToRefs(store)
const { setModel } = useSession()

const editing = ref(false)
const draft = ref('')

// Options to show: the provider's list, plus the current value if it isn't
// already one of them (e.g. a resolved id the agent reported).
const options = computed<ModelOption[]>(() => {
  const list = [...availableModels.value]
  const cur = currentModel.value
  if (cur && !list.some((m) => m.id === cur)) list.unshift({ id: cur })
  return list
})

function onSelect(e: Event) {
  const value = (e.target as HTMLSelectElement).value
  if (value === CUSTOM) {
    draft.value = currentModel.value ?? ''
    editing.value = true
    return
  }
  if (value && value !== currentModel.value) setModel(value)
}

function commitEdit() {
  const value = draft.value.trim()
  editing.value = false
  if (value && value !== currentModel.value) setModel(value)
}

watch(currentModel, () => {
  editing.value = false
})
</script>

<template>
  <div class="flex items-center gap-1.5 text-xs">
    <span class="text-gray-400 dark:text-gray-500">Model</span>

    <!-- Free-text entry (chosen via "Custom…") -->
    <input
      v-if="editing"
      v-model="draft"
      type="text"
      placeholder="full model id (e.g. claude-sonnet-4-6)"
      class="w-56 rounded-md border border-gray-200 bg-white px-2 py-1 text-gray-700 focus:border-blue-500 focus:outline-none dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300"
      @keydown.enter="commitEdit"
      @blur="commitEdit"
    />

    <!-- Dropdown -->
    <select
      v-else
      :value="currentModel ?? ''"
      class="max-w-[200px] truncate rounded-md border border-gray-200 bg-white px-2 py-1 text-gray-700 transition focus:border-blue-500 focus:outline-none dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300"
      @change="onSelect"
    >
      <option v-if="!currentModel" value="" disabled>Select a model…</option>
      <option v-for="m in options" :key="m.id" :value="m.id">{{ m.name ?? m.id }}</option>
      <option :value="CUSTOM">Custom…</option>
    </select>
  </div>
</template>
