import { defineStore } from 'pinia'
import { ref } from 'vue'

export const useUiStore = defineStore('ui', () => {
  const sidebarOpen = ref(false)

  // Dark mode — persisted in localStorage, applied as .dark class on <html>
  const darkMode = ref(loadDarkMode())

  function loadDarkMode(): boolean {
    const stored = localStorage.getItem('codepipe:darkMode')
    if (stored !== null) return stored === 'true'
    // Default to system preference
    return window.matchMedia('(prefers-color-scheme: dark)').matches
  }

  function applyDarkMode(enabled: boolean) {
    document.documentElement.classList.toggle('dark', enabled)
  }

  function toggleDarkMode() {
    darkMode.value = !darkMode.value
    localStorage.setItem('codepipe:darkMode', String(darkMode.value))
    applyDarkMode(darkMode.value)
  }

  // Apply on store initialization
  applyDarkMode(darkMode.value)

  function toggleSidebar() {
    sidebarOpen.value = !sidebarOpen.value
  }

  function closeSidebar() {
    sidebarOpen.value = false
  }

  /**
   * The quick-add dialog for action items — opened from any chat (header
   * button, or a message's "Add as action item"), prefilled with what's known.
   */
  const quickAdd = ref<{ projectId?: string; text?: string; notes?: string } | null>(null)

  function openQuickAdd(prefill: { projectId?: string; text?: string; notes?: string } = {}) {
    quickAdd.value = prefill
  }

  function closeQuickAdd() {
    quickAdd.value = null
  }

  /**
   * A request to show a project file (from a path clicked in a chat message).
   * ChatView switches to the Files tab and FilesPanel opens it; the nonce makes
   * clicking the same path twice still count.
   */
  const fileRequest = ref<{ path: string; nonce: number } | null>(null)

  function openFile(path: string) {
    fileRequest.value = { path, nonce: Date.now() }
  }

  /** A one-tap action that can be taken back (see UndoToast.vue). */
  const undo = ref<{ id: number; text: string; run: () => unknown } | null>(null)

  function offerUndo(text: string, run: () => unknown) {
    undo.value = { id: Date.now(), text, run }
  }

  function dismissUndo() {
    undo.value = null
  }

  return {
    undo, offerUndo, dismissUndo,
    fileRequest, openFile,
    sidebarOpen, darkMode, toggleSidebar, closeSidebar, toggleDarkMode,
    quickAdd, openQuickAdd, closeQuickAdd,
  }
})
