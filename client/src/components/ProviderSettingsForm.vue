<script setup lang="ts">
/**
 * Renders one provider's launch settings from its schema, VS Code style:
 * every setting shows its effective value; editing one pins an override at
 * this layer (marked with a bar and a reset control), while untouched ones
 * say where their value comes from.
 *
 * Controls by type: booleans are switches; enums are selects; lists with
 * known choices are toggle chips plus an "other" field for anything else
 * (tool patterns); strings with suggestions are a picker with a Custom
 * option; the rest (system prompt, raw flags) are plain text.
 */
import { computed, reactive } from 'vue'
import type { ProviderSettingSpec, SettingOption, SettingSource, SettingValue, SettingValues } from '@/api/client'

const props = defineProps<{
  settings: ProviderSettingSpec[]
  /** This layer's own overrides (only the keys it sets). */
  modelValue: SettingValues
  /** Effective values from the layers below, for every key. */
  inherited: SettingValues
  inheritedSources: Record<string, SettingSource>
  /** Which layer this form edits — names the "set here" marker. */
  layer: 'global' | 'project' | 'persona'
  compact?: boolean
}>()

const emit = defineEmits<{ 'update:modelValue': [value: SettingValues] }>()

const SOURCE_LABELS: Record<SettingSource, string> = {
  default: 'CLI default',
  env: 'from env var',
  global: 'from global',
  project: 'from project',
  persona: 'from persona',
}

const CUSTOM = '\u0000custom'

/** Per-setting UI state: the "other" draft for choice lists, Custom mode for pickers. */
const otherDraft = reactive<Record<string, string>>({})
const customMode = reactive<Record<string, boolean>>({})

function isSetHere(key: string): boolean {
  return props.modelValue[key] !== undefined
}

function effective(setting: ProviderSettingSpec): SettingValue {
  return props.modelValue[setting.key] ?? props.inherited[setting.key] ?? setting.default
}

function asList(v: SettingValue): string[] {
  return Array.isArray(v) ? v : []
}
function asString(v: SettingValue): string {
  return typeof v === 'string' ? v : ''
}

function sourceLabel(setting: ProviderSettingSpec): string {
  if (isSetHere(setting.key)) return `set at ${props.layer}`
  const src = props.inheritedSources[setting.key] ?? 'default'
  if (src === 'env' && setting.env) return `from ${setting.env}`
  return SOURCE_LABELS[src]
}

function set(key: string, value: SettingValue) {
  emit('update:modelValue', { ...props.modelValue, [key]: value })
}

function reset(key: string) {
  const next = { ...props.modelValue }
  delete next[key]
  emit('update:modelValue', next)
  customMode[key] = false
}

// ---- Choice lists (toggle chips + "other" entries) ----

function hasChoice(setting: ProviderSettingSpec, value: string): boolean {
  return asList(effective(setting)).includes(value)
}

function toggleChoice(setting: ProviderSettingSpec, value: string) {
  const list = asList(effective(setting))
  set(setting.key, list.includes(value) ? list.filter((v) => v !== value) : [...list, value])
}

/** Entries in the value that aren't one of the known choices. */
function otherEntries(setting: ProviderSettingSpec): string[] {
  const known = new Set((setting.choices ?? []).map((c) => c.value))
  return asList(effective(setting)).filter((v) => !known.has(v))
}

function addOther(setting: ProviderSettingSpec) {
  const text = (otherDraft[setting.key] ?? '').trim()
  if (!text) return
  const list = asList(effective(setting))
  if (!list.includes(text)) set(setting.key, [...list, text])
  otherDraft[setting.key] = ''
}

function removeEntry(setting: ProviderSettingSpec, value: string) {
  set(setting.key, asList(effective(setting)).filter((v) => v !== value))
}

/** Caution for a chosen chip (e.g. Bash) — shown once below the chips. */
function choiceCautions(setting: ProviderSettingSpec): string[] {
  const chosen = new Set(asList(effective(setting)))
  return (setting.choices ?? []).filter((c) => c.caution && chosen.has(c.value)).map((c) => `${c.label}: ${c.caution}`)
}

// ---- Suggested strings (picker + Custom) ----

function pickerValue(setting: ProviderSettingSpec): string {
  const value = asString(effective(setting))
  if (customMode[setting.key]) return CUSTOM
  return setting.suggestions?.some((s) => s.value === value) ? value : CUSTOM
}

function isCustom(setting: ProviderSettingSpec): boolean {
  return pickerValue(setting) === CUSTOM
}

function onPick(setting: ProviderSettingSpec, value: string) {
  if (value === CUSTOM) {
    customMode[setting.key] = true
    return
  }
  customMode[setting.key] = false
  set(setting.key, value)
}

// ---- Free text ----

// Raw extra args split on whitespace like a shell would; other free lists
// are one per line.
function listToText(setting: ProviderSettingSpec, value: SettingValue): string {
  return asList(value).join(setting.key === 'extraArgs' ? ' ' : '\n')
}
function textToList(setting: ProviderSettingSpec, text: string): string[] {
  const parts = setting.key === 'extraArgs' ? text.split(/\s+/) : text.split('\n')
  return parts.map((s) => s.trim()).filter((s) => s.length > 0)
}

function cautionFor(setting: ProviderSettingSpec): string | null {
  const value = effective(setting)
  if (setting.type === 'boolean') return value === true && setting.caution ? setting.caution : null
  if (setting.type === 'enum') return setting.options?.find((o) => o.value === value)?.caution ?? null
  return null
}

function control(setting: ProviderSettingSpec): 'switch' | 'select' | 'chips' | 'picker' | 'text' | 'prose' | 'textarea' {
  if (setting.type === 'boolean') return 'switch'
  if (setting.type === 'enum') return 'select'
  if (setting.type === 'list') return setting.choices?.length ? 'chips' : 'textarea'
  if (setting.suggestions?.length) return 'picker'
  return setting.multiline ? 'prose' : 'text'
}

const rows = computed(() =>
  props.settings.map((s) => ({
    setting: s,
    control: control(s),
    caution: cautionFor(s),
    setHere: isSetHere(s.key),
    options: (s.options ?? []) as SettingOption[],
  })),
)
</script>

<template>
  <div class="flex flex-col" :class="compact ? 'gap-2' : 'gap-3'">
    <div
      v-for="{ setting, control: kind, caution, setHere } in rows"
      :key="setting.key"
      class="rounded-lg border-l-2 py-1 pl-3"
      :class="setHere ? 'border-blue-500' : 'border-transparent'"
    >
      <div class="flex items-start justify-between gap-3">
        <div class="min-w-0 flex-1">
          <div class="flex flex-wrap items-baseline gap-x-2">
            <label class="text-sm font-medium text-gray-900 dark:text-gray-100">{{ setting.label }}</label>
            <span class="text-[11px]" :class="setHere ? 'text-blue-600 dark:text-blue-400' : 'text-gray-400 dark:text-gray-500'">
              {{ sourceLabel(setting) }}
            </span>
            <button
              v-if="setHere"
              class="text-[11px] text-gray-500 underline-offset-2 hover:underline dark:text-gray-400"
              title="Remove this override; inherit the value again"
              @click="reset(setting.key)"
            >reset</button>
          </div>
          <p v-if="!compact || setting.description.length < 140" class="mt-0.5 text-xs text-gray-500 dark:text-gray-400">{{ setting.description }}</p>
        </div>

        <!-- Boolean: switch -->
        <button
          v-if="kind === 'switch'"
          class="relative mt-1 inline-flex h-5 w-9 shrink-0 items-center rounded-full transition"
          :class="effective(setting) === true ? (setting.caution ? 'bg-amber-500' : 'bg-blue-600') : 'bg-gray-300 dark:bg-gray-600'"
          role="switch"
          :aria-checked="effective(setting) === true"
          :aria-label="setting.label"
          @click="set(setting.key, effective(setting) !== true)"
        >
          <span
            class="inline-block h-3.5 w-3.5 transform rounded-full bg-white transition"
            :class="effective(setting) === true ? 'translate-x-[18px]' : 'translate-x-1'"
          />
        </button>
      </div>

      <!-- Enum: select -->
      <select
        v-if="kind === 'select'"
        :value="effective(setting)"
        class="mt-1.5 w-full rounded border border-gray-200 bg-white px-2 py-1.5 text-xs text-gray-700 focus:border-blue-500 focus:outline-none dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300"
        @change="set(setting.key, ($event.target as HTMLSelectElement).value)"
      >
        <option v-for="o in setting.options" :key="o.value" :value="o.value">{{ o.label }}</option>
      </select>

      <!-- List with known choices: toggle chips + other entries -->
      <div v-else-if="kind === 'chips'" class="mt-1.5">
        <div class="flex flex-wrap gap-1">
          <button
            v-for="c in setting.choices"
            :key="c.value"
            type="button"
            class="rounded-full border px-2 py-0.5 text-[11px] font-medium transition"
            :class="hasChoice(setting, c.value)
              ? 'border-blue-600 bg-blue-600 text-white dark:border-blue-500 dark:bg-blue-500'
              : 'border-gray-200 bg-white text-gray-600 hover:border-gray-400 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-400 dark:hover:border-gray-500'"
            :title="c.value"
            :aria-pressed="hasChoice(setting, c.value)"
            @click="toggleChoice(setting, c.value)"
          >{{ c.label }}</button>
          <button
            v-for="v in otherEntries(setting)"
            :key="`other:${v}`"
            type="button"
            class="inline-flex items-center gap-1 rounded-full border border-blue-600 bg-blue-600 px-2 py-0.5 font-mono text-[11px] text-white dark:border-blue-500 dark:bg-blue-500"
            title="Remove"
            @click="removeEntry(setting, v)"
          >{{ v }}<span aria-hidden="true">×</span></button>
        </div>
        <form class="mt-1.5 flex gap-1" @submit.prevent="addOther(setting)">
          <input
            v-model="otherDraft[setting.key]"
            type="text"
            placeholder="Other (a tool name or pattern)…"
            class="min-w-0 flex-1 rounded border border-gray-200 bg-white px-2 py-1 font-mono text-[11px] text-gray-900 placeholder:font-sans placeholder:text-gray-400 focus:border-blue-500 focus:outline-none dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100"
          />
          <button
            type="submit"
            :disabled="!(otherDraft[setting.key] ?? '').trim()"
            class="rounded bg-gray-100 px-2 py-1 text-[11px] font-medium text-gray-600 transition hover:bg-gray-200 disabled:opacity-40 dark:bg-gray-800 dark:text-gray-400 dark:hover:bg-gray-700"
          >Add</button>
        </form>
        <p
          v-for="c in choiceCautions(setting)"
          :key="c"
          class="mt-1 text-[11px] text-amber-700 dark:text-amber-400"
        >{{ c }}</p>
      </div>

      <!-- String with suggestions: picker + Custom -->
      <div v-else-if="kind === 'picker'" class="mt-1.5 flex flex-col gap-1.5">
        <select
          :value="pickerValue(setting)"
          class="w-full rounded border border-gray-200 bg-white px-2 py-1.5 text-xs text-gray-700 focus:border-blue-500 focus:outline-none dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300"
          @change="onPick(setting, ($event.target as HTMLSelectElement).value)"
        >
          <option v-for="o in setting.suggestions" :key="o.value" :value="o.value">{{ o.label }}</option>
          <option :value="CUSTOM">Custom…</option>
        </select>
        <input
          v-if="isCustom(setting)"
          type="text"
          :value="asString(effective(setting))"
          placeholder="Type a value"
          class="w-full rounded border border-gray-200 bg-white px-2 py-1.5 font-mono text-xs text-gray-900 placeholder:font-sans placeholder:text-gray-400 focus:border-blue-500 focus:outline-none dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100"
          @change="set(setting.key, ($event.target as HTMLInputElement).value)"
        />
      </div>

      <!-- Plain string -->
      <input
        v-else-if="kind === 'text'"
        type="text"
        :value="effective(setting)"
        :placeholder="setting.default === '' ? 'Not set' : String(setting.default)"
        class="mt-1.5 w-full rounded border border-gray-200 bg-white px-2 py-1.5 text-xs text-gray-900 placeholder:text-gray-400 focus:border-blue-500 focus:outline-none dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100"
        @change="set(setting.key, ($event.target as HTMLInputElement).value)"
      />

      <!-- Multi-line string (a system prompt) -->
      <textarea
        v-else-if="kind === 'prose'"
        :value="asString(effective(setting))"
        rows="3"
        :placeholder="setting.default === '' ? 'Not set' : String(setting.default)"
        class="mt-1.5 w-full rounded border border-gray-200 bg-white px-2 py-1.5 text-xs text-gray-900 placeholder:text-gray-400 focus:border-blue-500 focus:outline-none dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100"
        @change="set(setting.key, ($event.target as HTMLTextAreaElement).value)"
      />

      <!-- Free list: textarea, one per line (extra args: space-separated) -->
      <textarea
        v-else-if="kind === 'textarea'"
        :value="listToText(setting, effective(setting))"
        :rows="setting.key === 'extraArgs' ? 1 : 2"
        :placeholder="setting.key === 'extraArgs' ? '--flag value --other' : 'One per line'"
        class="mt-1.5 w-full rounded border border-gray-200 bg-white px-2 py-1.5 font-mono text-xs text-gray-900 placeholder:font-sans placeholder:text-gray-400 focus:border-blue-500 focus:outline-none dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100"
        @change="set(setting.key, textToList(setting, ($event.target as HTMLTextAreaElement).value))"
      />

      <p v-if="caution" class="mt-1.5 flex items-start gap-1.5 rounded bg-amber-50 px-2 py-1.5 text-[11px] text-amber-800 dark:bg-amber-900/20 dark:text-amber-300">
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" class="mt-px h-3.5 w-3.5 shrink-0">
          <path fill-rule="evenodd" d="M6.701 2.25c.577-1 2.02-1 2.598 0l5.196 9a1.5 1.5 0 0 1-1.299 2.25H2.804a1.5 1.5 0 0 1-1.3-2.25l5.197-9ZM8 4a.75.75 0 0 1 .75.75v3a.75.75 0 1 1-1.5 0v-3A.75.75 0 0 1 8 4Zm0 8a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z" clip-rule="evenodd" />
        </svg>
        <span>{{ caution }}</span>
      </p>
    </div>
  </div>
</template>
