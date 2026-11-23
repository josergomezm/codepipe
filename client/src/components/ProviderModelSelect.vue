<script setup lang="ts">
import { computed, ref, useId, watch } from 'vue'
import { fetchProviderModels, type ModelOption, type ProviderModels, type ProviderType } from '@/api/client'

/**
 * Pick a model for a provider without a live session (persona settings).
 * Lists what the CLI reports; "Default" leaves it to the CLI; "Custom…"
 * takes any id. Providers that can't list models (Claude Code) get a text
 * box with the common aliases suggested.
 */
const props = defineProps<{ provider: ProviderType }>()
const model = defineModel<string>({ default: '' })

const CUSTOM = '__custom__'
const CLAUDE_ALIASES = ['opus', 'sonnet', 'haiku']

const cache = new Map<ProviderType, ProviderModels>()
const listing = ref<ProviderModels | null>(null)
const loading = ref(false)
const custom = ref(false)
/** Unique per instance, so two pickers on a page don't share one datalist. */
const aliasListId = `model-aliases-${useId()}`

watch(() => props.provider, async (provider) => {
  custom.value = false
  listing.value = cache.get(provider) ?? null
  // A fetch for the previous provider may still be in flight; this one is settled.
  loading.value = !listing.value
  if (listing.value) return
  try {
    const result = await fetchProviderModels(provider)
    cache.set(provider, result)
    if (provider === props.provider) listing.value = result
  } catch {
    if (provider === props.provider) listing.value = { listable: false, models: [] }
  } finally {
    if (provider === props.provider) loading.value = false
  }
}, { immediate: true })

/** The list, plus the saved value when it isn't in it (kept selectable). */
const options = computed<ModelOption[]>(() => {
  const list = listing.value?.models ?? []
  return model.value && !list.some((m) => m.id === model.value) ? [{ id: model.value }, ...list] : list
})

const useText = computed(() => custom.value || (listing.value !== null && !listing.value.listable))

function onSelect(e: Event) {
  const value = (e.target as HTMLSelectElement).value
  if (value === CUSTOM) { custom.value = true; return }
  model.value = value
}

const inputClass = 'w-full rounded border border-gray-200 bg-white px-2 py-1.5 text-xs text-gray-900 placeholder:text-gray-400 focus:border-blue-500 focus:outline-none dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100'
</script>

<template>
  <div class="min-w-0">
    <template v-if="useText">
      <input
        v-model.trim="model"
        type="text"
        :list="provider === 'claude' ? aliasListId : undefined"
        :placeholder="provider === 'claude' ? 'Default (or opus, sonnet…)' : 'Model id (blank = default)'"
        :class="inputClass"
      />
      <datalist :id="aliasListId">
        <option v-for="a in CLAUDE_ALIASES" :key="a" :value="a" />
      </datalist>
    </template>
    <select
      v-else
      :value="model"
      :disabled="loading"
      :class="inputClass"
      :title="loading ? 'Loading models…' : 'Model'"
      @change="onSelect"
    >
      <option value="">{{ loading ? 'Loading models…' : 'Default model' }}</option>
      <option v-for="m in options" :key="m.id" :value="m.id">{{ m.name ?? m.id }}</option>
      <option :value="CUSTOM">Custom…</option>
    </select>
  </div>
</template>
