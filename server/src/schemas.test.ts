import { describe, it, expect } from 'vitest'
import { randomUUID } from 'crypto'
import {
  ProviderTypeSchema,
  ChatMessageSchema,
  ProjectSchema,
  SessionSchema,
  SessionMetaSchema,
  WSClientMessageSchema,
  WSServerMessageSchema,
  CreateSessionRequestSchema,
  CreateProjectRequestSchema,
} from './schemas.js'

// --- Helper factories ---

function validChatMessage(overrides: Record<string, unknown> = {}) {
  return {
    id: randomUUID(),
    role: 'user',
    content: 'hello world',
    timestamp: Date.now(),
    status: 'complete',
    ...overrides,
  }
}

function validProject(overrides: Record<string, unknown> = {}) {
  return {
    id: randomUUID(),
    name: 'My Project',
    path: '/home/user/project',
    ...overrides,
  }
}

function validSession(overrides: Record<string, unknown> = {}) {
  const now = Date.now()
  return {
    id: randomUUID(),
    provider: 'kiro',
    projectId: randomUUID(),
    title: 'Test Session',
    createdAt: now,
    updatedAt: now + 1000,
    status: 'live',
    messages: [],
    ...overrides,
  }
}

// --- Tests ---

describe('ProviderTypeSchema', () => {
  it.each(['kiro', 'gemini', 'claude', 'codex'])('accepts valid provider "%s"', (provider) => {
    expect(ProviderTypeSchema.safeParse(provider).success).toBe(true)
  })

  it('rejects an invalid provider string', () => {
    const result = ProviderTypeSchema.safeParse('openai')
    expect(result.success).toBe(false)
  })

  it('rejects a non-string value', () => {
    const result = ProviderTypeSchema.safeParse(42)
    expect(result.success).toBe(false)
  })
})

describe('ChatMessageSchema', () => {
  it('accepts a valid chat message', () => {
    const result = ChatMessageSchema.safeParse(validChatMessage())
    expect(result.success).toBe(true)
  })

  it('accepts a message with optional metadata', () => {
    const msg = validChatMessage({ metadata: { toolName: 'read_file' } })
    const result = ChatMessageSchema.safeParse(msg)
    expect(result.success).toBe(true)
  })

  it('rejects a message with missing required fields', () => {
    const result = ChatMessageSchema.safeParse({ id: randomUUID() })
    expect(result.success).toBe(false)
  })

  it('rejects a message with an invalid UUID', () => {
    const result = ChatMessageSchema.safeParse(validChatMessage({ id: 'not-a-uuid' }))
    expect(result.success).toBe(false)
  })

  it('rejects a message with an invalid role', () => {
    const result = ChatMessageSchema.safeParse(validChatMessage({ role: 'admin' }))
    expect(result.success).toBe(false)
  })
})

describe('ProjectSchema', () => {
  it('accepts a valid project', () => {
    const result = ProjectSchema.safeParse(validProject())
    expect(result.success).toBe(true)
  })

  it('accepts a project with a relative path (validation done at route level)', () => {
    const result = ProjectSchema.safeParse(validProject({ path: 'relative/path' }))
    expect(result.success).toBe(true)
  })

  it('rejects a project with an empty name', () => {
    const result = ProjectSchema.safeParse(validProject({ name: '' }))
    expect(result.success).toBe(false)
  })

  it('rejects a project with a name over 100 characters', () => {
    const result = ProjectSchema.safeParse(validProject({ name: 'a'.repeat(101) }))
    expect(result.success).toBe(false)
  })
})

describe('SessionSchema', () => {
  it('accepts a valid session', () => {
    const result = SessionSchema.safeParse(validSession())
    expect(result.success).toBe(true)
  })

  it('rejects a session where updatedAt < createdAt', () => {
    const now = Date.now()
    const result = SessionSchema.safeParse(
      validSession({ createdAt: now, updatedAt: now - 1000 }),
    )
    expect(result.success).toBe(false)
    if (!result.success) {
      const messages = result.error.issues.map((i) => i.message)
      expect(messages).toContain('updatedAt must be >= createdAt')
    }
  })

  it('accepts a session where updatedAt === createdAt', () => {
    const now = Date.now()
    const result = SessionSchema.safeParse(
      validSession({ createdAt: now, updatedAt: now }),
    )
    expect(result.success).toBe(true)
  })

  it('rejects a session with an invalid provider', () => {
    const result = SessionSchema.safeParse(validSession({ provider: 'chatgpt' }))
    expect(result.success).toBe(false)
  })
})

describe('SessionMetaSchema', () => {
  it('accepts a valid session meta (no messages field)', () => {
    const { messages: _, ...meta } = validSession()
    const result = SessionMetaSchema.safeParse(meta)
    expect(result.success).toBe(true)
  })

  it('strips the messages field if present', () => {
    const session = validSession()
    const result = SessionMetaSchema.safeParse(session)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data).not.toHaveProperty('messages')
    }
  })
})

describe('WSClientMessageSchema', () => {
  it('accepts a valid input message', () => {
    const result = WSClientMessageSchema.safeParse({ type: 'input', data: 'hello' })
    expect(result.success).toBe(true)
  })

  it('rejects a message with empty data', () => {
    const result = WSClientMessageSchema.safeParse({ type: 'input', data: '' })
    expect(result.success).toBe(false)
  })

  it('rejects a message with an unknown type', () => {
    const result = WSClientMessageSchema.safeParse({ type: 'unknown', data: 'hello' })
    expect(result.success).toBe(false)
  })
})

describe('WSServerMessageSchema', () => {
  it('accepts a valid "message" type', () => {
    const result = WSServerMessageSchema.safeParse({
      type: 'message',
      data: validChatMessage(),
    })
    expect(result.success).toBe(true)
  })

  it('accepts a valid "status" type', () => {
    const result = WSServerMessageSchema.safeParse({ type: 'status', data: 'typing' })
    expect(result.success).toBe(true)
  })

  it('accepts a valid "history" type', () => {
    const result = WSServerMessageSchema.safeParse({
      type: 'history',
      data: [validChatMessage()],
    })
    expect(result.success).toBe(true)
  })

  it('accepts a valid "error" type', () => {
    const result = WSServerMessageSchema.safeParse({
      type: 'error',
      data: 'Something went wrong',
    })
    expect(result.success).toBe(true)
  })
})

describe('CreateSessionRequestSchema', () => {
  it('accepts a valid request', () => {
    const result = CreateSessionRequestSchema.safeParse({
      provider: 'kiro',
      projectId: randomUUID(),
    })
    expect(result.success).toBe(true)
  })

  it('rejects a request with missing provider', () => {
    const result = CreateSessionRequestSchema.safeParse({
      projectId: randomUUID(),
    })
    expect(result.success).toBe(false)
  })

  it('rejects a request with an invalid provider', () => {
    const result = CreateSessionRequestSchema.safeParse({
      provider: 'openai',
      projectId: randomUUID(),
    })
    expect(result.success).toBe(false)
  })
})

describe('CreateProjectRequestSchema', () => {
  it('accepts a valid request', () => {
    const result = CreateProjectRequestSchema.safeParse({
      name: 'My Project',
      path: '/home/user/project',
    })
    expect(result.success).toBe(true)
  })

  it('accepts a request with a relative path (validation done at route level)', () => {
    const result = CreateProjectRequestSchema.safeParse({
      name: 'My Project',
      path: 'relative/path',
    })
    expect(result.success).toBe(true)
  })

  it('rejects a request with an empty name', () => {
    const result = CreateProjectRequestSchema.safeParse({
      name: '',
      path: '/home/user/project',
    })
    expect(result.success).toBe(false)
  })
})
