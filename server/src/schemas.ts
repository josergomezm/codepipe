import { z } from 'zod'

// --- Enums & Primitives ---

export const ProviderTypeSchema = z.enum(['kiro', 'gemini', 'claude', 'codex'])

export const SessionStatusSchema = z.enum(['live', 'archived'])

export const MessageRoleSchema = z.enum(['user', 'assistant', 'system', 'tool'])

export const MessageStatusSchema = z.enum(['streaming', 'complete'])

// --- Core Models ---

export const ChatMessageMetadataSchema = z.object({
  toolName: z.string().optional(),
  thinkingContent: z.string().optional(),
  credits: z.string().optional(),
  time: z.string().optional(),
})

export const AttachmentSchema = z.object({
  id: z.string().uuid(),
  filename: z.string().min(1),
  mimeType: z.string().min(1),
  size: z.number().int().nonnegative(),
  /** Absolute path on the host filesystem where the file was saved. */
  path: z.string().min(1),
})

export const ChatMessageSchema = z.object({
  id: z.string().uuid(),
  role: MessageRoleSchema,
  content: z.string(),
  timestamp: z.number().int().positive(),
  status: MessageStatusSchema,
  metadata: ChatMessageMetadataSchema.optional(),
  attachments: z.array(AttachmentSchema).optional(),
})

export const ProjectSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(100),
  path: z.string().min(1),
})

// Base session object without the refinement — needed so .omit() works
// (.refine() returns ZodEffects which doesn't support .omit())
const SessionObjectSchema = z.object({
  id: z.string().uuid(),
  provider: ProviderTypeSchema,
  projectId: z.string().uuid(),
  title: z.string().min(1).max(200),
  createdAt: z.number().int().positive(),
  updatedAt: z.number().int().positive(),
  status: SessionStatusSchema,
  messages: z.array(ChatMessageSchema),
  /** The CLI tool's own session ID, used for --resume-id on reconnection. */
  cliSessionId: z.string().optional(),
})

export const SessionSchema = SessionObjectSchema.refine(
  s => s.updatedAt >= s.createdAt,
  { message: 'updatedAt must be >= createdAt' },
)

export const SessionMetaSchema = SessionObjectSchema.omit({ messages: true })

// --- WebSocket Protocol ---

export const WSClientMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('input'),
    data: z.string().min(1),
    attachments: z.array(AttachmentSchema).optional(),
  }),
])

export const WSServerMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('message'), data: ChatMessageSchema }),
  z.object({ type: z.literal('status'), data: z.enum(['typing', 'idle', 'exited']) }),
  z.object({ type: z.literal('history'), data: z.array(ChatMessageSchema) }),
  z.object({ type: z.literal('error'), data: z.string() }),
])

// --- REST API Request Bodies ---

export const CreateSessionRequestSchema = z.object({
  provider: ProviderTypeSchema,
  projectId: z.string().uuid(),
})

export const RenameSessionRequestSchema = z.object({
  title: z.string().min(1).max(200),
})

export const CreateProjectRequestSchema = z.object({
  name: z.string().min(1).max(100),
  path: z.string().min(1),
})

// --- Inferred Types ---

export type ProviderType = z.infer<typeof ProviderTypeSchema>
export type SessionStatus = z.infer<typeof SessionStatusSchema>
export type MessageRole = z.infer<typeof MessageRoleSchema>
export type MessageStatus = z.infer<typeof MessageStatusSchema>
export type ChatMessageMetadata = z.infer<typeof ChatMessageMetadataSchema>
export type Attachment = z.infer<typeof AttachmentSchema>
export type ChatMessage = z.infer<typeof ChatMessageSchema>
export type Project = z.infer<typeof ProjectSchema>
export type Session = z.infer<typeof SessionSchema>
export type SessionMeta = z.infer<typeof SessionMetaSchema>
export type WSClientMessage = z.infer<typeof WSClientMessageSchema>
export type WSServerMessage = z.infer<typeof WSServerMessageSchema>
export type CreateSessionRequest = z.infer<typeof CreateSessionRequestSchema>
export type CreateProjectRequest = z.infer<typeof CreateProjectRequestSchema>
