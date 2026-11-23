import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import * as api from '@/api/client'
import type { FocusItem, LeadStatus } from '@/api/client'

/**
 * Unread state for the lead's thread (the sidebar badge).
 *
 * PREVIEW: there is no lead session yet, so "messages" are the scheduled
 * 9 AM brief (today's once 9 AM has passed, else yesterday's) plus any
 * replies the preview thread posts. With the backend this becomes the lead
 * session's assistant messages, read the same way chats are.
 */
const LAST_READ_KEY = 'codepipe:lead:lastRead'
const BRIEF_HOUR = 9

/** When the most recent scheduled brief ran (today's once its hour has passed, else yesterday's). */
export function latestScheduledBrief(now = new Date()): number {
  const at = new Date(now)
  at.setHours(BRIEF_HOUR, 0, 0, 0)
  if (at.getTime() > now.getTime()) at.setDate(at.getDate() - 1)
  return at.getTime()
}

export const useLeadStore = defineStore('lead', () => {
  const lastRead = ref<number>(load())
  /** Timestamps of lead messages posted this visit (preview replies, runs). */
  const posted = ref<number[]>([])
  /** Re-evaluated every minute so 9 AM turns the badge on without a reload. */
  const now = ref(Date.now())
  setInterval(() => (now.value = Date.now()), 60_000)

  function load(): number {
    try { return Number(localStorage.getItem(LAST_READ_KEY)) || 0 } catch { return 0 }
  }

  const messages = computed(() => [latestScheduledBrief(new Date(now.value)), ...posted.value])
  const unreadCount = computed(() => messages.value.filter((t) => t > lastRead.value).length)
  /** Sidebar hint: a reply reads as a message; otherwise it's the morning brief. */
  const unreadLabel = computed(() => (posted.value.some((t) => t > lastRead.value) ? 'New message' : 'New brief'))

  function markRead() {
    lastRead.value = Date.now()
    try { localStorage.setItem(LAST_READ_KEY, String(lastRead.value)) } catch { /* preview */ }
  }

  /** The thread posted a lead message (callers mark it read if they're on screen). */
  function notePosted() {
    posted.value = [...posted.value, Date.now()]
  }

  /** Who leads, their thread, your Focus list (server). */
  const status = ref<LeadStatus | null>(null)
  const focus = computed(() => status.value?.focus ?? [])

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

  return { unreadCount, unreadLabel, markRead, notePosted, status, focus, fetchStatus, saveFocus }
})
