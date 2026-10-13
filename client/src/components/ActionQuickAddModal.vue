<script setup lang="ts">
/**
 * Quick-add an action item from anywhere (mounted once in App.vue, opened
 * via ui.openQuickAdd). Confirms in place, so the user stays in their chat.
 */
import { ref, watch, onMounted, onUnmounted } from 'vue'
import { useRouter } from 'vue-router'
import { useUiStore } from '@/stores/ui'
import { useTeamStore } from '@/stores/team'
import ActionAddForm from '@/components/ActionAddForm.vue'

const ui = useUiStore()
const teamStore = useTeamStore()
const router = useRouter()

/** Text of the item just added — shown as a confirmation. */
const added = ref<string | null>(null)
/** Remount the form for each opening so its prefill applies. */
const openCount = ref(0)

watch(
  () => ui.quickAdd,
  (prefill) => {
    if (prefill) {
      added.value = null
      openCount.value++
      teamStore.clearError()
    }
  },
)

function close() {
  ui.closeQuickAdd()
}

function viewAll() {
  close()
  router.push('/actions')
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape' && ui.quickAdd) close()
}
onMounted(() => document.addEventListener('keydown', onKeydown))
onUnmounted(() => document.removeEventListener('keydown', onKeydown))
</script>

<template>
  <Teleport to="body">
    <div
      v-if="ui.quickAdd"
      class="fixed inset-0 z-50 flex items-start justify-center bg-black/50 p-4 pt-[15vh]"
      @click.self="close"
    >
      <div class="w-full max-w-lg rounded-xl bg-white shadow-xl dark:bg-gray-900">
        <div class="flex items-center justify-between border-b border-gray-200 px-4 py-3 dark:border-gray-800">
          <h2 class="text-sm font-semibold text-gray-900 dark:text-gray-100">Add to your action items</h2>
          <button
            class="rounded-lg p-1 text-gray-400 transition hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-800 dark:hover:text-gray-300"
            title="Close"
            @click="close"
          >
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" class="h-5 w-5">
              <path d="M6.28 5.22a.75.75 0 0 0-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 1 0 1.06 1.06L10 11.06l3.72 3.72a.75.75 0 1 0 1.06-1.06L11.06 10l3.72-3.72a.75.75 0 0 0-1.06-1.06L10 8.94 6.28 5.22Z" />
            </svg>
          </button>
        </div>

        <div class="flex flex-col gap-3 px-4 py-4">
          <div v-if="added" class="flex items-center justify-between gap-3 rounded-lg bg-green-50 px-3 py-2 text-xs text-green-800 dark:bg-green-900/20 dark:text-green-300">
            <span class="min-w-0 truncate">Added: {{ added }}</span>
            <span class="flex shrink-0 gap-3">
              <button class="font-medium hover:underline" @click="viewAll">View list</button>
              <button class="font-medium hover:underline" @click="close">Done</button>
            </span>
          </div>

          <ActionAddForm
            :key="openCount"
            :project-id="ui.quickAdd.projectId"
            :text="ui.quickAdd.text"
            :notes="ui.quickAdd.notes"
            autofocus
            @added="added = $event.text"
          />

          <p v-if="teamStore.error" class="text-xs text-red-600 dark:text-red-400">{{ teamStore.error }}</p>
        </div>
      </div>
    </div>
  </Teleport>
</template>
