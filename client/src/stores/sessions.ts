import { defineStore } from 'pinia'
import { ref } from 'vue'

export const useSessionsStore = defineStore('sessions', () => {
  const sessions = ref<unknown[]>([])
  const activeSessionId = ref<string | null>(null)

  return {
    sessions,
    activeSessionId,
  }
})
