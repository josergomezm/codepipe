import { ref } from 'vue'
import { useSessionsStore } from '../stores/sessions'

// Singleton state — shared across all components that call useSession()
const isConnected = ref(false)
const connectionError = ref<string | null>(null)

let ws: WebSocket | null = null
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let reconnectAttempts = 0
let currentSessionId: string | null = null
/** Suppress errors during intentional disconnect. */
let intentionalDisconnect = false

function connect(sessionId: string) {
  // If already connected to this session, don't reconnect
  if (currentSessionId === sessionId && ws?.readyState === WebSocket.OPEN) {
    return
  }

  intentionalDisconnect = true
  disconnect()
  intentionalDisconnect = false
  currentSessionId = sessionId

  try {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    ws = new WebSocket(`${protocol}//${window.location.host}/ws?sessionId=${sessionId}`)
  } catch {
    // WebSocket constructor can throw if URL is invalid
    return
  }

  ws.onopen = () => {
    isConnected.value = true
    connectionError.value = null
    reconnectAttempts = 0
  }

  ws.onmessage = (event: MessageEvent) => {
    try {
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
    } catch {
      // Ignore malformed messages
    }
  }

  ws.onclose = () => {
    isConnected.value = false

    // Don't reconnect if we intentionally disconnected or switched sessions
    if (intentionalDisconnect || !currentSessionId) return

    // Auto-reconnect with exponential backoff (max 5 attempts, start at 2s)
    if (reconnectAttempts < 5) {
      const delay = Math.min(2000 * 2 ** reconnectAttempts, 30000)
      reconnectTimer = setTimeout(() => {
        reconnectAttempts++
        if (currentSessionId) {
          connect(currentSessionId)
        }
      }, delay)
    }
  }

  ws.onerror = () => {
    // Don't set error for intentional disconnects or during HMR reloads
    if (!intentionalDisconnect) {
      connectionError.value = 'Connection lost — retrying...'
    }
  }
}

function disconnect() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
  reconnectAttempts = 0
  currentSessionId = null
  if (ws) {
    intentionalDisconnect = true
    ws.close()
    ws = null
    intentionalDisconnect = false
  }
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
