import { defineStore } from 'pinia'
import { ref } from 'vue'
import * as api from '../api/client'
import type { ChatMessage, SessionMeta, Session, ProviderType } from '../api/client'

export const useSessionsStore = defineStore('sessions', () => {
  const sessions = ref<SessionMeta[]>([])
  const activeSessionId = ref<string | null>(null)
  const activeMessages = ref<ChatMessage[]>([])
  const sessionStatus = ref<'typing' | 'idle' | 'exited'>('idle')
  /** User-facing error message, cleared on next successful action. */
  const error = ref<string | null>(null)

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

  async function selectSession(sessionId: string) {
    try {
      activeSessionId.value = sessionId
      const session = await api.fetchSession(sessionId)
      activeMessages.value = session.messages
      sessionStatus.value = session.status === 'archived' ? 'exited' : 'idle'
      error.value = null
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Failed to load session'
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
      }
      error.value = null
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Failed to delete session'
    }
  }

  function clearError() {
    error.value = null
  }

  function upsertMessage(message: ChatMessage) {
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

  /** Append content to an existing message by ID. Reserved for future delta-based streaming. */
  function appendDelta(messageId: string, content: string) {
    const msg = activeMessages.value.find((m) => m.id === messageId)
    if (msg) {
      msg.content += content
    }
  }

  function setStatus(status: 'typing' | 'idle' | 'exited') {
    sessionStatus.value = status
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
    error,
    fetchSessions,
    createSession,
    selectSession,
    deleteSession,
    upsertMessage,
    appendDelta,
    setStatus,
    setMessages,
    clearError,
  }
})
