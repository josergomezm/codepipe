import { defineStore } from 'pinia'
import { ref } from 'vue'
import * as api from '../api/client'
import type { ChatMessage, SessionMeta, Session, ProviderType, ModelOption } from '../api/client'

export const useSessionsStore = defineStore('sessions', () => {
  const sessions = ref<SessionMeta[]>([])
  const activeSessionId = ref<string | null>(null)
  const activeMessages = ref<ChatMessage[]>([])
  const sessionStatus = ref<'typing' | 'idle' | 'exited'>('idle')
  /** Model picker state for the active session. */
  const availableModels = ref<ModelOption[]>([])
  const currentModel = ref<string | null>(null)
  /** True while a session is being loaded (REST fetch + WS connect). */
  const loading = ref(false)
  /** User-facing error message, cleared on next successful action. */
  const error = ref<string | null>(null)

  /**
   * Per-session last-read timestamps (persisted per browser). Drives unread
   * indicators for sessions where agents message the user proactively.
   */
  const lastRead = ref<Record<string, number>>(loadLastRead())

  function loadLastRead(): Record<string, number> {
    try {
      return JSON.parse(localStorage.getItem('codepipe:lastRead') ?? '{}')
    } catch {
      return {}
    }
  }

  function markRead(sessionId: string) {
    lastRead.value = { ...lastRead.value, [sessionId]: Date.now() }
    try {
      localStorage.setItem('codepipe:lastRead', JSON.stringify(lastRead.value))
    } catch {
      // Storage full/unavailable — indicators degrade gracefully
    }
  }

  function isUnread(session: SessionMeta): boolean {
    if (session.id === activeSessionId.value) return false
    const readAt = lastRead.value[session.id]
    // Never-opened sessions only count once they have activity
    return readAt === undefined ? session.updatedAt > 0 : session.updatedAt > readAt
  }

  async function fetchSessions() {
    try {
      sessions.value = await api.fetchSessions()
      error.value = null
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Failed to load sessions'
    }
  }

  async function createSession(provider: ProviderType, projectId: string): Promise<Session> {
    try {
      const session = await api.createSession(provider, projectId)
      const { messages: _messages, ...meta } = session
      sessions.value.unshift(meta)
      error.value = null
      return session
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Failed to create session'
      throw e
    }
  }

  /**
   * Create a session and queue an initial message to be sent once connected.
   * Used for automated setup flows where we want to pre-fill a prompt.
   */
  let pendingInitialMessage: string | null = null

  async function createSessionWithPrompt(
    provider: ProviderType,
    projectId: string,
    prompt: string,
  ): Promise<Session> {
    const session = await createSession(provider, projectId)
    pendingInitialMessage = prompt
    await selectSession(session.id)
    return session
  }

  function consumePendingMessage(): string | null {
    const msg = pendingInitialMessage
    pendingInitialMessage = null
    return msg
  }

  async function selectSession(sessionId: string) {
    try {
      activeSessionId.value = sessionId
      loading.value = true
      markRead(sessionId)
      localStorage.setItem('codepipe:activeSession', sessionId)
      navigator.serviceWorker?.controller?.postMessage({ type: 'active-session', sessionId })
      const session = await api.fetchSession(sessionId)
      // Guard: only apply the fetched data if this is still the active session.
      // Without this, a slow fetch for a previous session can overwrite the
      // current session's messages.
      if (activeSessionId.value !== sessionId) return
      activeMessages.value = session.messages
      sessionStatus.value = session.status === 'archived' ? 'exited' : 'idle'
      // Reset model state; the live model_state message (on WS connect) fills
      // in the available list. Seed current from the persisted selection.
      availableModels.value = []
      currentModel.value = session.model ?? null
      error.value = null
    } catch (e) {
      // Only show the error if this is still the active session
      if (activeSessionId.value === sessionId) {
        error.value = e instanceof Error ? e.message : 'Failed to load session'
      }
    } finally {
      if (activeSessionId.value === sessionId) {
        loading.value = false
      }
    }
  }

  async function deleteSession(sessionId: string) {
    try {
      await api.deleteSession(sessionId)
      sessions.value = sessions.value.filter((s) => s.id !== sessionId)
      if (activeSessionId.value === sessionId) {
        activeSessionId.value = null
        activeMessages.value = []
        sessionStatus.value = 'idle'
        localStorage.removeItem('codepipe:activeSession')
        navigator.serviceWorker?.controller?.postMessage({ type: 'active-session', sessionId: null })
      }
      error.value = null
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Failed to delete session'
    }
  }

  async function renameSession(sessionId: string, title: string) {
    try {
      await api.renameSession(sessionId, title)
      const session = sessions.value.find((s) => s.id === sessionId)
      if (session) {
        session.title = title
      }
      error.value = null
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Failed to rename session'
    }
  }

  function clearError() {
    error.value = null
  }

  function upsertMessage(message: ChatMessage) {
    // Messages arriving while the session is open are read by definition.
    if (activeSessionId.value) markRead(activeSessionId.value)
    const idx = activeMessages.value.findIndex((m) => m.id === message.id)
    if (idx >= 0) {
      // Update in-place to avoid replacing the object reference
      const existing = activeMessages.value[idx]
      existing.content = message.content
      existing.status = message.status
      if (message.metadata) existing.metadata = message.metadata
      if (message.attachments) existing.attachments = message.attachments
    } else {
      activeMessages.value.push(message)
    }
  }

  function setStatus(status: 'typing' | 'idle' | 'exited') {
    sessionStatus.value = status
  }

  function setModelState(state: { available: ModelOption[]; current: string | null }) {
    availableModels.value = state.available
    currentModel.value = state.current
  }

  function setMessages(messages: ChatMessage[]) {
    // Deduplicate by id — the last occurrence wins, preserving order
    const seen = new Map<string, ChatMessage>()
    for (const msg of messages) {
      seen.set(msg.id, msg)
    }
    activeMessages.value = [...seen.values()]
  }

  return {
    sessions,
    activeSessionId,
    activeMessages,
    sessionStatus,
    availableModels,
    currentModel,
    loading,
    error,
    lastRead,
    markRead,
    isUnread,
    fetchSessions,
    createSession,
    createSessionWithPrompt,
    consumePendingMessage,
    selectSession,
    deleteSession,
    renameSession,
    upsertMessage,
    setStatus,
    setModelState,
    setMessages,
    clearError,
  }
})
