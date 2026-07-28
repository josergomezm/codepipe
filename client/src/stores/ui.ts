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

  return { sidebarOpen, darkMode, toggleSidebar, closeSidebar, toggleDarkMode }
})
