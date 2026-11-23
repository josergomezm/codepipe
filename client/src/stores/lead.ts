import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import * as api from '@/api/client'
import type { BriefSchedule, FocusItem, LeadStatus } from '@/api/client'
import { useSessionsStore } from '@/stores/sessions'

/**
 * The lead assistant, client side: who leads and their thread, your Focus
 * list, the brief schedule, and whether the thread has something you haven't
 * read — the same unread check chats use, on the lead's session.
 */
export const useLeadStore = defineStore('lead', () => {
  const sessions = useSessionsStore()

  const status = ref<LeadStatus | null>(null)
  const focus = computed(() => status.value?.focus ?? [])

  /** The lead's thread, as listed with the other sessions. */
  const thread = computed(() => {
    const id = status.value?.sessionId
    return id ? sessions.sessions.find((s) => s.id === id) ?? null : null
  })
  const unread = computed(() => !!thread.value && sessions.isUnread(thread.value))
  /** Sidebar hint: a brief since you last looked, or just a message. */
  const unreadLabel = computed(() => {
    const t = thread.value
    const brief = status.value?.lastBriefAt
    return t && brief && brief > (sessions.lastRead[t.id] ?? 0) ? 'New brief' : 'New message'
  })

  async function fetchStatus() {
    try { status.value = await api.fetchLeadStatus() } catch { /* keep the last known */ }
  }

  /** Save the Focus list (shown at once; the server's copy wins on reply). */
  async function saveFocus(next: FocusItem[]) {
    if (status.value) status.value = { ...status.value, focus: next }
    try {
      const saved = await api.saveFocus(next)
      if (status.value) status.value = { ...status.value, focus: saved.focus }
      else await fetchStatus()
    } catch {
      await fetchStatus()
    }
  }

  /** Start a brief now; the answer says whether it started (and why not). */
  async function runBrief(): Promise<{ ran: boolean; reason?: string }> {
    try {
      const result = await api.runBrief()
      await fetchStatus()
      return result
    } catch (e) {
      return { ran: false, reason: e instanceof Error ? e.message : 'Could not start the brief' }
    }
  }

  async function saveSchedule(schedule: BriefSchedule) {
    if (status.value) status.value = { ...status.value, schedule }
    try { await api.saveBriefSchedule(schedule) } catch { /* the refetch shows the truth */ }
    await fetchStatus()
  }

  return { status, focus, unread, unreadLabel, fetchStatus, saveFocus, runBrief, saveSchedule }
})
