import { defineStore } from 'pinia'
import { ref } from 'vue'
import * as api from '../api/client'
import type { ChatMessage, SessionMeta, Session, ProviderType } from '../api/client'

export const useSessionsStore = defineStore('sessions', () => {
  const sessions = ref<SessionMeta[]>([])
  const activeSessionId = ref<string | null>(null)
  const activeMessages = ref<ChatMessage[]>([])
  const sessionStatus = ref<'typing' | 'idle' | 'exited'>('idle')

  async function fetchSessions() {
    sessions.value = await api.fetchSessions()
  }

  async function createSession(provider: ProviderType, projectId: string): Promise<Session> {
    const session = await api.createSession(provider, projectId)
    const { messages: _messages, ...meta } = session
    sessions.value.unshift(meta)
    return session
  }

  async function selectSession(sessionId: string) {
    activeSessionId.value = sessionId
    const session = await api.fetchSession(sessionId)
    activeMessages.value = session.messages
    sessionStatus.value = session.status === 'archived' ? 'exited' : 'idle'
  }

  async function deleteSession(sessionId: string) {
    await api.deleteSession(sessionId)
    sessions.value = sessions.value.filter((s) => s.id !== sessionId)
    if (activeSessionId.value === sessionId) {
      activeSessionId.value = null
      activeMessages.value = []
      sessionStatus.value = 'idle'
    }
  }

  function upsertMessage(message: ChatMessage) {
    const idx = activeMessages.value.findIndex((m) => m.id === message.id)
    if (idx >= 0) {
      // Update in-place to avoid replacing the object reference
      const existing = activeMessages.value[idx]
      existing.content = message.content
      existing.status = message.status
      if (message.metadata) existing.metadata = message.metadata
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
    activeMessages.value = messages
  }

  return {
    sessions,
    activeSessionId,
    activeMessages,
    sessionStatus,
    fetchSessions,
    createSession,
    selectSession,
    deleteSession,
    upsertMessage,
    appendDelta,
    setStatus,
    setMessages,
  }
})
