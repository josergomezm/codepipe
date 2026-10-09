import { z } from 'zod'

// --- Enums & Primitives ---

export const ProviderTypeSchema = z.enum(['kiro', 'gemini', 'claude', 'codex'])

/** Names for messages users see. `gemini` is the stored id for Antigravity CLI. */
export const PROVIDER_DISPLAY_NAMES: Record<z.infer<typeof ProviderTypeSchema>, string> = {
  kiro: 'Kiro',
  gemini: 'Antigravity',
  claude: 'Claude',
  codex: 'Codex',
}

export const SessionStatusSchema = z.enum(['live', 'archived'])

/**
 * 'chat' = a normal user-driven session; 'team' = an ephemeral dated standup
 * session (the lead's synthesis thread for one run); 'work' = an
 * implementation session spawned from an approved proposal; 'review' = a
 * throwaway reviewer session — hidden from the UI and deleted once its take
 * is harvested (the take on the todo is the artifact, not the session).
 */
export const SessionKindSchema = z.enum(['chat', 'team', 'work', 'review'])

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
  /**
   * 'deliberation' marks raw team-discussion output; 'prompt' marks a
   * machine-built dispatch prompt (standup/refine/implement). Both are
   * collapsed behind a disclosure in the UI.
   */
  kind: z.enum(['deliberation', 'prompt']).optional(),
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
  /**
   * The execution-ready implementation brief: the exact prompt to hand the
   * coding CLI — goal, files/docs to read, constraints, definition of done.
   * The whole point of the planning layer is tuning this.
   */
  brief: z.string().optional(),
  /** Persona who proposed it. */
  personaId: z.string().uuid().optional(),
})

/**
 * One reviewer's independent take on an idea, produced in its own context
 * (unbiased by the other reviewers) and synthesized by the lead afterward.
 */
export const TodoTakeSchema = z.object({
  personaId: z.string().uuid(),
  /** The reviewer's single most important point. */
  take: z.string().min(1).max(2000),
  concerns: z.array(z.string().min(1).max(500)).max(8).optional(),
  effort: z.string().max(200).optional(),
  createdAt: z.number().int().positive(),
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
  /** Independent reviewer takes from the most recent standup review. */
  takes: z.array(TodoTakeSchema).max(8).optional(),
})

// --- Action items (things only the user can do, surfaced by the team) ---

/**
 * 'done' = resolved (answered or completed); 'dismissed' = the user declined
 * it ("won't do") — the team is told, and must not raise it again.
 */
export const ActionItemStatusSchema = z.enum(['open', 'done', 'dismissed'])

/**
 * 'decision' = the user must decide something (resolved by answering it —
 * the answer is stored as the item's `resolution`); 'task' = external setup
 * only the user can do (resolved by following the steps). Absent on
 * older/manual items — treated as a plain task.
 */
export const ActionItemKindSchema = z.enum(['decision', 'task'])

/** One answer the team offers for a decision — rendered as a one-tap button. */
export const ActionItemOptionSchema = z.object({
  label: z.string().min(1).max(200),
  detail: z.string().max(1000).optional(),
  recommended: z.boolean().optional(),
})

/** A calendar date, YYYY-MM-DD. */
export const DueDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  // Round-trips only for real dates (rejects 2026-02-30).
  .refine((d) => {
    const t = Date.parse(`${d}T00:00:00Z`)
    return !Number.isNaN(t) && new Date(t).toISOString().startsWith(d)
  }, 'Invalid date')

export const ActionItemSchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  text: z.string().min(1).max(2000),
  notes: z.string().max(10000).optional(),
  kind: ActionItemKindSchema.optional(),
  /** Step-by-step guide to complete it (task-kind items). */
  steps: z.array(z.string().min(1).max(1000)).max(12).optional(),
  /** The answers the team offers (decision items). */
  options: z.array(ActionItemOptionSchema).max(6).optional(),
  /** False when it's useful to know but blocks nothing. Absent = blocking. */
  blocking: z.boolean().optional(),
  /** Hidden from the list (and the badge) until this time. */
  snoozedUntil: z.number().int().positive().optional(),
  /**
   * Deadline as a calendar date (YYYY-MM-DD) — a day, not an instant, so it
   * never drifts across timezones and exports as an all-day event.
   */
  dueDate: DueDateSchema.optional(),
  /** The idea this item gates or informs (a prerequisite of that idea). */
  todoId: z.string().uuid().optional(),
  status: ActionItemStatusSchema,
  /**
   * The user's answer when resolving it (decision items), or their reason
   * when dismissing it — relayed to the team.
   */
  resolution: z.string().max(4000).optional(),
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
  /** The most recent dated standup session (today's, until the next run). */
  teamSessionId: z.string().uuid().optional(),
  /**
   * The team's own handoff note, written at the end of each standup and
   * injected into the next — explicit, bounded, inspectable memory that
   * replaces dragging a persistent thread's history around.
   */
  memo: z.string().max(4000).optional(),
  /**
   * Events since the last standup (resolved action items, shipped builds).
   * Consumed and cleared by the next run — one turn amortizes all the
   * acknowledgments that used to cost a CLI turn each.
   */
  agenda: z.array(z.string().min(1).max(1000)).max(30).optional(),
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
  brief: z.string().optional(),
  persona: z.string().optional(),
})

/** A task only the user can do (secrets, accounts, purchases, decisions). */
export const StandupUserActionSchema = z.object({
  persona: z.string().optional(),
  text: z.string().min(1),
  notes: z.string().optional(),
  kind: ActionItemKindSchema.optional(),
  steps: z.array(z.string().min(1)).optional(),
  /** Decision answers, each a one-tap button for the user. */
  options: z
    .array(
      z.object({
        label: z.string().min(1),
        detail: z.string().optional(),
        recommended: z.boolean().optional(),
      }),
    )
    .optional(),
  /** False for nice-to-know items that block nothing. */
  blocking: z.boolean().optional(),
  /** The [id] of the idea this action gates, when it is a prerequisite. */
  todoId: z.string().optional(),
})

/** An idea the lead found already shipped (e.g. built outside CodePipe). */
export const StandupCompletedTodoSchema = z.object({
  todoId: z.string().min(1),
  /** How the lead knows — a commit hash, a file. Shown to the user. */
  evidence: z.string().optional(),
})

export const StandupOutputSchema = z.object({
  messages: z.array(StandupMessageSchema),
  proposals: z.array(StandupProposalSchema).optional(),
  user_actions: z.array(StandupUserActionSchema).optional(),
  /**
   * [id]s of already-tracked action items that no longer block anything —
   * the user settled them in the thread, or the plan changed.
   */
  resolved_actions: z.array(z.string()).optional(),
  /** Planned ideas the lead verified are already implemented. */
  completed_todos: z.array(StandupCompletedTodoSchema).optional(),
  /** The team's handoff note to their next standup (see StandupState.memo). */
  memo: z.string().optional(),
})

/** What a single reviewer session returns (lenient — raw text falls back to `take`). */
export const ReviewerOutputSchema = z.object({
  take: z.string().min(1),
  concerns: z.array(z.string().min(1)).optional(),
  effort: z.string().optional(),
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

export const RefineProposalRequestSchema = z.object({
  feedback: z.string().min(1).max(8000),
})

export const PersonaBodySchema = PersonaSchema.omit({ id: true, avatar: true })
export const UpdatePersonaRequestSchema = PersonaBodySchema.partial()

export const CreateActionItemRequestSchema = z.object({
  projectId: z.string().uuid(),
  text: z.string().min(1).max(2000),
  notes: z.string().max(10000).optional(),
  dueDate: DueDateSchema.optional(),
})

export const UpdateActionItemRequestSchema = z.object({
  text: z.string().min(1).max(2000).optional(),
  notes: z.string().max(10000).optional(),
  status: ActionItemStatusSchema.optional(),
  resolution: z.string().max(4000).optional(),
  /** null un-snoozes. */
  snoozedUntil: z.number().int().positive().nullable().optional(),
  /** null clears the deadline. */
  dueDate: DueDateSchema.nullable().optional(),
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
export type TodoTake = z.infer<typeof TodoTakeSchema>
export type Todo = z.infer<typeof TodoSchema>
export type ReviewerOutput = z.infer<typeof ReviewerOutputSchema>
export type ActionItemStatus = z.infer<typeof ActionItemStatusSchema>
export type ActionItemKind = z.infer<typeof ActionItemKindSchema>
export type ActionItem = z.infer<typeof ActionItemSchema>
export type StandupUserAction = z.infer<typeof StandupUserActionSchema>
export type Persona = z.infer<typeof PersonaSchema>
export type StandupState = z.infer<typeof StandupStateSchema>
export type StandupMessage = z.infer<typeof StandupMessageSchema>
export type StandupProposal = z.infer<typeof StandupProposalSchema>
export type StandupOutput = z.infer<typeof StandupOutputSchema>
