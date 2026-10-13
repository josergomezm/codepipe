<script setup lang="ts">
/**
 * Per-provider launch overrides for one layer (a project or a persona):
 * a provider picker plus the settings form, editing a `{ provider: values }`
 * map. Inherited values come from the global layer.
 */
import { ref, computed, watch, onMounted } from 'vue'
import { useProviderSettingsStore } from '@/stores/providerSettings'
import ProviderSettingsForm from '@/components/ProviderSettingsForm.vue'
import { providerLabel, type ProviderSettingsOverrides, type ProviderType, type SettingValues } from '@/api/client'

const props = defineProps<{
  modelValue: ProviderSettingsOverrides
  layer: 'project' | 'persona'
  /** Limit to these providers (a persona has one); default: every configurable provider. */
  providers?: ProviderType[]
}>()

const emit = defineEmits<{ 'update:modelValue': [value: ProviderSettingsOverrides] }>()

const store = useProviderSettingsStore()

const choices = computed<ProviderType[]>(() =>
  (props.providers ?? store.configurableProviders).filter((p) => store.infoFor(p) !== undefined),
)
const selected = ref<ProviderType | null>(null)

watch(
  choices,
  (list) => {
    if (!selected.value || !list.includes(selected.value)) selected.value = list[0] ?? null
  },
  { immediate: true },
)

const info = computed(() => (selected.value ? store.infoFor(selected.value) : undefined))
const values = computed<SettingValues>(() => (selected.value ? props.modelValue[selected.value] ?? {} : {}))

function countFor(provider: ProviderType): number {
  return Object.keys(props.modelValue[provider] ?? {}).length
}

function onChange(next: SettingValues) {
  if (!selected.value) return
  const map: ProviderSettingsOverrides = { ...props.modelValue }
  if (Object.keys(next).length === 0) delete map[selected.value]
  else map[selected.value] = next
  emit('update:modelValue', map)
}

onMounted(() => {
  void store.fetch()
})
</script>

<template>
  <div class="flex flex-col gap-2.5">
    <div v-if="store.error" class="text-xs text-red-600 dark:text-red-400">{{ store.error }}</div>
    <div v-else-if="!store.loaded" class="text-xs text-gray-400">Loading…</div>
    <template v-else>
      <div v-if="choices.length > 1" class="flex flex-wrap gap-1">
        <button
          v-for="p in choices"
          :key="p"
          class="rounded-lg px-2.5 py-1 text-xs font-medium transition"
          :class="selected === p
            ? 'bg-blue-600 text-white'
            : 'bg-gray-100 text-gray-600 hover:bg-gray-200 dark:bg-gray-800 dark:text-gray-400 dark:hover:bg-gray-700'"
          @click="selected = p"
        >
          {{ providerLabel(p) }}<span v-if="countFor(p) > 0" class="ml-1 opacity-75">· {{ countFor(p) }}</span>
        </button>
      </div>

      <template v-if="info">
        <p v-if="info.spec.inactive" class="rounded bg-amber-50 px-2 py-1.5 text-[11px] text-amber-800 dark:bg-amber-900/20 dark:text-amber-300">{{ info.spec.inactive }}</p>
        <p v-if="info.spec.note" class="text-[11px] text-gray-400 dark:text-gray-500">{{ info.spec.note }}</p>
        <ProviderSettingsForm
          :class="info.spec.inactive ? 'opacity-60' : ''"
          :settings="info.spec.settings"
          :model-value="values"
          :inherited="info.resolved.values"
          :inherited-sources="info.resolved.sources"
          :layer="layer"
          compact
          @update:model-value="onChange"
        />
      </template>
      <p v-else class="text-xs text-gray-400">No launch settings for this provider.</p>
    </template>
  </div>
</template>
