import { ref } from 'vue'
import { useSessionsStore } from '../stores/sessions'

// Singleton state — shared across all components that call useSession()
const isConnected = ref(false)
const connectionError = ref<string | null>(null)

let ws: WebSocket | null = null
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let reconnectAttempts = 0
let currentSessionId: string | null = null

function connect(sessionId: string) {
  disconnect()
  currentSessionId = sessionId

  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  ws = new WebSocket(`${protocol}//${window.location.host}/ws?sessionId=${sessionId}`)

  ws.onopen = () => {
    isConnected.value = true
    connectionError.value = null
    reconnectAttempts = 0
  }

  ws.onmessage = (event: MessageEvent) => {
    const msg = JSON.parse(event.data as string)
    const store = useSessionsStore()

    switch (msg.type) {
      case 'history':
        store.setMessages(msg.data)
        break
      case 'message':
        store.upsertMessage(msg.data)
        break
      case 'status':
        store.setStatus(msg.data)
        break
      case 'error':
        connectionError.value = msg.data
        break
    }
  }

  ws.onclose = () => {
    isConnected.value = false

    // Auto-reconnect with exponential backoff (max 5 attempts)
    if (currentSessionId && reconnectAttempts < 5) {
      const delay = Math.min(1000 * 2 ** reconnectAttempts, 30000)
      reconnectTimer = setTimeout(() => {
        reconnectAttempts++
        if (currentSessionId) {
          connect(currentSessionId)
        }
      }, delay)
    }
  }

  ws.onerror = () => {
    connectionError.value = 'WebSocket connection failed'
  }
}

function disconnect() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
  reconnectAttempts = 0
  currentSessionId = null
  ws?.close()
  ws = null
  isConnected.value = false
}

function sendMessage(text: string) {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'input', data: text }))
  }
}

export function useSession() {
  return {
    connect,
    disconnect,
    sendMessage,
    isConnected,
    connectionError,
  }
}
