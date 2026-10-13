<script setup lang="ts">
import { ref, reactive, onMounted, onUnmounted } from 'vue'
import { useUiStore } from '@/stores/ui'
import { useProviderSettingsStore } from '@/stores/providerSettings'
import ProviderSettingsForm from '@/components/ProviderSettingsForm.vue'
import { providerLabel, type ProviderSettingsInfo, type ProviderType, type SettingValues } from '@/api/client'

const ui = useUiStore()
const store = useProviderSettingsStore()

/** Per-provider draft of the global layer; autosaved shortly after each edit. */
const drafts = reactive<Partial<Record<ProviderType, SettingValues>>>({})
const saveState = reactive<Partial<Record<ProviderType, 'saving' | 'saved' | 'error'>>>({})
const saveErrors = reactive<Partial<Record<ProviderType, string>>>({})
const timers = new Map<ProviderType, ReturnType<typeof setTimeout>>()
const showArgs = ref<Partial<Record<ProviderType, boolean>>>({})

function draftFor(info: ProviderSettingsInfo): SettingValues {
  return drafts[info.spec.provider] ?? info.global
}

function onChange(info: ProviderSettingsInfo, values: SettingValues) {
  const provider = info.spec.provider
  drafts[provider] = values
  const existing = timers.get(provider)
  if (existing) clearTimeout(existing)
  timers.set(
    provider,
    setTimeout(() => {
      timers.delete(provider)
      void save(provider)
    }, 500),
  )
}

async function save(provider: ProviderType) {
  const values = drafts[provider]
  if (!values) return
  saveState[provider] = 'saving'
  try {
    await store.saveGlobal(provider, values)
    // An edit made while this save was in flight has its own save pending;
    // only clear the draft if it is still the one we just wrote.
    if (drafts[provider] === values) delete drafts[provider]
    saveState[provider] = 'saved'
    delete saveErrors[provider]
    setTimeout(() => {
      if (saveState[provider] === 'saved') delete saveState[provider]
    }, 1500)
  } catch (e) {
    saveState[provider] = 'error'
    saveErrors[provider] = e instanceof Error ? e.message : 'Failed to save'
  }
}

function overrideCount(info: ProviderSettingsInfo): number {
  return Object.keys(draftFor(info)).length
}

function formatDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00`)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

function daysSince(iso: string): number {
  const d = new Date(`${iso}T00:00:00`)
  return Math.floor((Date.now() - d.getTime()) / 86_400_000)
}

onMounted(() => {
  void store.fetch(true)
})
// Leaving the page saves what is still pending rather than dropping it.
onUnmounted(() => {
  for (const [provider, t] of timers) {
    clearTimeout(t)
    void save(provider)
  }
  timers.clear()
})
</script>

<template>
  <div class="flex h-full flex-col">
    <!-- Header bar -->
    <div class="flex shrink-0 items-center gap-2 border-b border-gray-200 px-3 py-2 dark:border-gray-800">
      <button
        class="rounded-lg p-1.5 text-gray-600 hover:bg-gray-100 md:hidden dark:text-gray-400 dark:hover:bg-gray-800"
        @click="ui.toggleSidebar()"
      >
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" class="h-5 w-5">
          <path fill-rule="evenodd" d="M2 4.75A.75.75 0 0 1 2.75 4h14.5a.75.75 0 0 1 0 1.5H2.75A.75.75 0 0 1 2 4.75Zm0 10.5a.75.75 0 0 1 .75-.75h14.5a.75.75 0 0 1 0 1.5H2.75a.75.75 0 0 1-.75-.75ZM2 10a.75.75 0 0 1 .75-.75h7.5a.75.75 0 0 1 0 1.5h-7.5A.75.75 0 0 1 2 10Z" clip-rule="evenodd" />
        </svg>
      </button>
      <span class="text-sm font-medium text-gray-700 dark:text-gray-300">Providers</span>
    </div>

    <!-- Content -->
    <div class="min-h-0 flex-1 overflow-y-auto">
      <div class="mx-auto flex max-w-2xl flex-col gap-6 px-4 py-6">
        <p class="text-sm text-gray-500 dark:text-gray-400">
          How each CLI is launched for every chat: permission modes, tool trust, extra flags.
          These are the global values. A project can override them in its settings, and a
          persona in the team roster; the most specific layer wins. Changes apply to the next
          message, no restart needed.
        </p>

        <div v-if="store.error" class="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-900/20 dark:text-red-400">
          {{ store.error }}
        </div>
        <div v-else-if="!store.loaded" class="py-8 text-center text-sm text-gray-400">Loading…</div>

        <section
          v-for="info in store.providers"
          :key="info.spec.provider"
          class="rounded-xl border border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-900"
        >
          <!-- Card header -->
          <div class="flex items-center justify-between gap-3 border-b border-gray-200 px-5 py-3 dark:border-gray-800">
            <div class="flex items-baseline gap-2">
              <h2 class="text-base font-semibold text-gray-900 dark:text-gray-100">{{ providerLabel(info.spec.provider) }}</h2>
              <span v-if="overrideCount(info) > 0" class="text-[11px] text-blue-600 dark:text-blue-400">
                {{ overrideCount(info) }} set here
              </span>
            </div>
            <span class="text-xs" :class="saveState[info.spec.provider] === 'error' ? 'text-red-600 dark:text-red-400' : 'text-gray-400'">
              <template v-if="saveState[info.spec.provider] === 'saving'">Saving…</template>
              <template v-else-if="saveState[info.spec.provider] === 'saved'">Saved</template>
              <template v-else-if="saveState[info.spec.provider] === 'error'">{{ saveErrors[info.spec.provider] }}</template>
            </span>
          </div>

          <div class="flex flex-col gap-4 px-5 py-4">
            <p v-if="info.spec.inactive" class="rounded bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:bg-amber-900/20 dark:text-amber-300">
              {{ info.spec.inactive }}
            </p>
            <p v-if="info.spec.note" class="rounded bg-gray-50 px-3 py-2 text-xs text-gray-600 dark:bg-gray-800/60 dark:text-gray-400">
              {{ info.spec.note }}
            </p>

            <ProviderSettingsForm
              :class="info.spec.inactive ? 'opacity-60' : ''"
              :settings="info.spec.settings"
              :model-value="draftFor(info)"
              :inherited="info.resolved.values"
              :inherited-sources="info.resolved.sources"
              layer="global"
              @update:model-value="onChange(info, $event)"
            />

            <!-- Effective flags -->
            <div>
              <button
                class="text-xs text-gray-500 underline-offset-2 hover:underline dark:text-gray-400"
                @click="showArgs[info.spec.provider] = !showArgs[info.spec.provider]"
              >
                {{ showArgs[info.spec.provider] ? 'Hide' : 'Show' }} launch flags
              </button>
              <code
                v-if="showArgs[info.spec.provider]"
                class="mt-1.5 block overflow-x-auto whitespace-pre-wrap break-all rounded bg-gray-100 px-3 py-2 text-[11px] text-gray-700 dark:bg-gray-800 dark:text-gray-300"
              >{{ info.args.length ? info.args.join(' ') : '(no extra flags)' }}</code>
            </div>
          </div>

          <!-- Docs footer -->
          <div class="flex flex-wrap items-center justify-between gap-2 border-t border-gray-200 px-5 py-2.5 text-[11px] text-gray-400 dark:border-gray-800 dark:text-gray-500">
            <span>
              Flag list last checked <span :class="daysSince(info.spec.docsCheckedOn) > 90 ? 'font-medium text-amber-600 dark:text-amber-400' : ''">{{ formatDate(info.spec.docsCheckedOn) }}</span>
              against {{ info.spec.docsCheckedAgainst }}
            </span>
            <a :href="info.spec.docsUrl" target="_blank" rel="noopener" class="hover:text-gray-600 hover:underline dark:hover:text-gray-300">CLI docs ↗</a>
          </div>
        </section>
      </div>
    </div>
  </div>
</template>
