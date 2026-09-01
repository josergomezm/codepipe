import { z } from 'zod'

// --- Enums & Primitives ---

export const ProviderTypeSchema = z.enum(['kiro', 'gemini', 'claude', 'codex'])

export const SessionStatusSchema = z.enum(['live', 'archived'])

/**
 * 'chat' = a normal user-driven session; 'team' = the per-project persona
 * team thread; 'work' = an implementation session spawned from an approved
 * proposal (behaves like a chat — the kind is a presentation/lineage signal).
 */
export const SessionKindSchema = z.enum(['chat', 'team', 'work'])

export const MessageRoleSchema = z.enum(['user', 'assistant', 'system', 'tool'])

export const MessageStatusSchema = z.enum(['streaming', 'complete'])

// --- Core Models ---

export const ChatMessageMetadataSchema = z.object({
  toolName: z.string().optional(),
  thinkingContent: z.string().optional(),
  credits: z.string().optional(),
  time: z.string().optional(),
  /** Persona who authored this message (team sessions). */
  personaId: z.string().uuid().optional(),
  /** 'deliberation' marks the raw team-discussion output (collapsed in the UI). */
  kind: z.enum(['deliberation']).optional(),
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

export const ProjectDevServerSchema = z.object({
  startCommand: z.string().min(1),
  port: z.number().int().positive(),
  tailscalePort: z.number().int().positive().optional(),
  cwd: z.string().optional(),
})

export const ProjectServiceConfigSchema = z.object({
  id: z.string().uuid(),
  type: z.string().min(1),         // e.g. 'firebase-emulators'
  label: z.string().min(1),
  startCommand: z.string().min(1),
  cwd: z.string().optional(),
})

/** Per-project daily standup configuration (the proactive team layer). */
export const ProjectStandupConfigSchema = z.object({
  enabled: z.boolean(),
  /** Local hour of day (0-23) the standup runs. */
  hour: z.number().int().min(0).max(23),
})

export const ProjectSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(100),
  path: z.string().min(1),
  devServer: ProjectDevServerSchema.optional(),
  services: z.array(ProjectServiceConfigSchema).optional(),
  standup: ProjectStandupConfigSchema.optional(),
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
  /** Selected model for this session (provider-specific id). */
  model: z.string().optional(),
  /** Session kind — absent means 'chat' (a normal user session). */
  kind: SessionKindSchema.optional(),
})

// A model the provider can run, for the picker.
export const ModelOptionSchema = z.object({
  id: z.string().min(1),
  name: z.string().optional(),
})

export const ModelStateSchema = z.object({
  available: z.array(ModelOptionSchema),
  current: z.string().nullable(),
})

export const SessionSchema = SessionObjectSchema.refine(
  s => s.updatedAt >= s.createdAt,
  { message: 'updatedAt must be >= createdAt' },
)

export const SessionMetaSchema = SessionObjectSchema.omit({ messages: true })

// --- Todos (per-project ideas list) ---

export const TodoStatusSchema = z.enum(['inbox', 'under_review', 'proposed', 'approved', 'done'])

/** A proposal attached to a todo by the team during a standup. */
export const TodoProposalSchema = z.object({
  summary: z.string().min(1),
  approach: z.string().min(1),
  effort: z.string().optional(),
  /** Persona who proposed it. */
  personaId: z.string().uuid().optional(),
})

export const TodoSchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  text: z.string().min(1).max(2000),
  notes: z.string().max(10000).optional(),
  status: TodoStatusSchema,
  proposal: TodoProposalSchema.optional(),
  createdAt: z.number().int().positive(),
  updatedAt: z.number().int().positive(),
  /** When the idea reached 'done' (stamped by storage, cleared on reopen). */
  completedAt: z.number().int().positive().optional(),
  /** The implementation ('work') session spawned for this idea, if any. */
  workSessionId: z.string().uuid().optional(),
})

// --- Action items (things only the user can do, surfaced by the team) ---

export const ActionItemStatusSchema = z.enum(['open', 'done'])

export const ActionItemSchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  text: z.string().min(1).max(2000),
  notes: z.string().max(10000).optional(),
  status: ActionItemStatusSchema,
  /** Persona who raised it (absent for manually added items). */
  personaId: z.string().uuid().optional(),
  createdAt: z.number().int().positive(),
  updatedAt: z.number().int().positive(),
})

// --- Personas (the AI team) ---

export const PersonaSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(60),
  role: z.string().min(1).max(100),
  /** Free-text personality/behavior prompt injected into standups. */
  personality: z.string().max(4000),
  /** Avatar filename under the data avatars dir (served at /api/avatars/<file>). */
  avatar: z.string().optional(),
  provider: ProviderTypeSchema,
  model: z.string().optional(),
  /** Exactly one persona should lead — their provider runs the team session. */
  isLead: z.boolean(),
})

/** Internal per-project standup runtime state (not user config). */
export const StandupStateSchema = z.object({
  projectId: z.string().uuid(),
  /** Timestamp of the last completed run. */
  lastRunAt: z.number().int().positive().optional(),
  /** Hash of the todo list at the last run — unchanged list skips the run. */
  lastHash: z.string().optional(),
  /** The persistent team session for this project. */
  teamSessionId: z.string().uuid().optional(),
  /**
   * Consecutive team turns whose structured JSON tail failed to parse.
   * Reset on the first successful parse; makes silent protocol degradation
   * observable (surfaced in the thread once the streak passes a threshold).
   */
  protocolFailStreak: z.number().int().nonnegative().optional(),
})

// --- Standup structured output (the JSON tail the team session must emit) ---

/** One outbound message from a persona to the user. */
export const StandupMessageSchema = z.object({
  /** Persona name or id — resolved leniently against the roster. */
  persona: z.string().min(1),
  kind: z.enum(['proposal', 'question', 'update']).optional(),
  text: z.string().min(1),
})

export const StandupProposalSchema = z.object({
  todoId: z.string().min(1),
  summary: z.string().min(1),
  approach: z.string().min(1),
  effort: z.string().optional(),
  persona: z.string().optional(),
})

/** A task only the user can do (secrets, accounts, purchases, decisions). */
export const StandupUserActionSchema = z.object({
  persona: z.string().optional(),
  text: z.string().min(1),
  notes: z.string().optional(),
})

export const StandupOutputSchema = z.object({
  messages: z.array(StandupMessageSchema),
  proposals: z.array(StandupProposalSchema).optional(),
  user_actions: z.array(StandupUserActionSchema).optional(),
})

// --- WebSocket Protocol ---

export const WSClientMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('input'),
    data: z.string().min(1),
    attachments: z.array(AttachmentSchema).optional(),
  }),
  // Cancel the in-flight turn (Stop button). Also drains the input queue.
  z.object({
    type: z.literal('cancel'),
  }),
  // Choose the model for this session.
  z.object({
    type: z.literal('set_model'),
    model: z.string().min(1),
  }),
  // Restart the CLI process (kill + respawn). Used when the agent hangs.
  z.object({
    type: z.literal('restart'),
  }),
])

export const WSServerMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('message'), data: ChatMessageSchema }),
  z.object({ type: z.literal('status'), data: z.enum(['typing', 'idle', 'exited']) }),
  z.object({ type: z.literal('history'), data: z.array(ChatMessageSchema) }),
  z.object({ type: z.literal('model_state'), data: ModelStateSchema }),
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

export const RunTurnRequestSchema = z.object({
  text: z.string().min(1),
  /** Max time to wait for the turn, in ms (default 5 minutes, capped at 30). */
  timeoutMs: z.number().int().positive().max(30 * 60 * 1000).optional(),
})

export const CreateTodoRequestSchema = z.object({
  projectId: z.string().uuid(),
  text: z.string().min(1).max(2000),
  notes: z.string().max(10000).optional(),
})

export const UpdateTodoRequestSchema = z.object({
  text: z.string().min(1).max(2000).optional(),
  notes: z.string().max(10000).optional(),
  status: TodoStatusSchema.optional(),
})

export const PersonaBodySchema = PersonaSchema.omit({ id: true, avatar: true })
export const UpdatePersonaRequestSchema = PersonaBodySchema.partial()

export const CreateActionItemRequestSchema = z.object({
  projectId: z.string().uuid(),
  text: z.string().min(1).max(2000),
  notes: z.string().max(10000).optional(),
})

export const UpdateActionItemRequestSchema = z.object({
  text: z.string().min(1).max(2000).optional(),
  notes: z.string().max(10000).optional(),
  status: ActionItemStatusSchema.optional(),
})

// --- Inferred Types ---

export type ProviderType = z.infer<typeof ProviderTypeSchema>
export type SessionStatus = z.infer<typeof SessionStatusSchema>
export type MessageRole = z.infer<typeof MessageRoleSchema>
export type MessageStatus = z.infer<typeof MessageStatusSchema>
export type ChatMessageMetadata = z.infer<typeof ChatMessageMetadataSchema>
export type Attachment = z.infer<typeof AttachmentSchema>
export type ChatMessage = z.infer<typeof ChatMessageSchema>
export type ProjectDevServer = z.infer<typeof ProjectDevServerSchema>
export type ProjectServiceConfig = z.infer<typeof ProjectServiceConfigSchema>
export type Project = z.infer<typeof ProjectSchema>
export type Session = z.infer<typeof SessionSchema>
export type SessionMeta = z.infer<typeof SessionMetaSchema>
export type WSClientMessage = z.infer<typeof WSClientMessageSchema>
export type WSServerMessage = z.infer<typeof WSServerMessageSchema>
export type ModelOption = z.infer<typeof ModelOptionSchema>
export type ModelState = z.infer<typeof ModelStateSchema>
export type CreateSessionRequest = z.infer<typeof CreateSessionRequestSchema>
export type CreateProjectRequest = z.infer<typeof CreateProjectRequestSchema>
export type SessionKind = z.infer<typeof SessionKindSchema>
export type ProjectStandupConfig = z.infer<typeof ProjectStandupConfigSchema>
export type TodoStatus = z.infer<typeof TodoStatusSchema>
export type TodoProposal = z.infer<typeof TodoProposalSchema>
export type Todo = z.infer<typeof TodoSchema>
export type ActionItemStatus = z.infer<typeof ActionItemStatusSchema>
export type ActionItem = z.infer<typeof ActionItemSchema>
export type StandupUserAction = z.infer<typeof StandupUserActionSchema>
export type Persona = z.infer<typeof PersonaSchema>
export type StandupState = z.infer<typeof StandupStateSchema>
export type StandupMessage = z.infer<typeof StandupMessageSchema>
export type StandupProposal = z.infer<typeof StandupProposalSchema>
export type StandupOutput = z.infer<typeof StandupOutputSchema>
