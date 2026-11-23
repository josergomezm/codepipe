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
/**
 * 'lead': the team lead's workspace thread (one per lead) — read-only on
 * code, runs in the internal Workspace project. See lead/lead-service.ts.
 */
export const SessionKindSchema = z.enum(['chat', 'team', 'work', 'review', 'lead'])

export const MessageRoleSchema = z.enum(['user', 'assistant', 'system', 'tool'])

export const MessageStatusSchema = z.enum(['streaming', 'complete'])

// --- Action item primitives (used by chat cards and action items) ---

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

/**
 * The content of an action item as an agent proposes it — through the
 * CodePipe MCP tool in any chat, or a standup's `user_actions`. Ids, status
 * and timestamps are the server's to assign.
 */
export const ActionDraftSchema = z.object({
  text: z.string().trim().min(1).max(2000),
  notes: z.string().max(10000).optional(),
  kind: ActionItemKindSchema.optional(),
  steps: z.array(z.string().min(1).max(1000)).max(12).optional(),
  options: z.array(ActionItemOptionSchema).max(6).optional(),
  blocking: z.boolean().optional(),
  dueDate: DueDateSchema.optional(),
})

/**
 * An action-item card in a chat: the agent added an item (state 'added'),
 * or suggested one the user can accept ('suggested'). The draft rides along
 * so the card still reads after an undo or dismissal.
 */
export const ChatActionCardSchema = z.object({
  draft: ActionDraftSchema,
  /**
   * added/suggested → dismissed/undone by the user; closed = the agent
   * resolved an existing item (undo reopens it → reopened).
   */
  state: z.enum(['added', 'suggested', 'dismissed', 'undone', 'closed', 'reopened']),
  /** The item the card is about, while it exists. */
  itemId: z.string().uuid().optional(),
  /** closed: the answer or what was done ('declined' marks a won't-do). */
  resolution: z.string().max(4000).optional(),
  declined: z.boolean().optional(),
})

/** An idea the agent put on the board (add_idea tool) — undo-able from the chat. */
export const ChatIdeaCardSchema = z.object({
  text: z.string().min(1).max(2000),
  notes: z.string().max(10000).optional(),
  state: z.enum(['added', 'undone']),
  /** The created idea, while it exists. */
  todoId: z.string().uuid().optional(),
})

// --- Core Models ---

/**
 * Token/cost accounting for one reply (Claude Code). `costUsd` is this reply
 * alone; the cli* fields are the CLI's raw, possibly carried-over numbers,
 * kept so the next reply can be computed (see reply-usage.ts).
 */
export const ReplyUsageSchema = z.object({
  costUsd: z.number().nonnegative(),
  sessionCostUsd: z.number().nonnegative().optional(),
  cliTotalUsd: z.number().nonnegative().optional(),
  cliCumulativeTokens: z.number().nonnegative().optional(),
  inputTokens: z.number().int().nonnegative(),
  cacheReadTokens: z.number().int().nonnegative(),
  cacheWriteTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
})

/**
 * The lead's daily brief, posted to its thread by the post_brief tool
 * (metadata.kind 'brief'). The lead writes the judgment; code fills in the
 * numbers (activity) and resolves every reference to a real chat / item.
 */
export const BriefSchema = z.object({
  at: z.number().int().positive(),
  /** Git and closed chats were reported since this time. */
  since: z.number().int().nonnegative(),
  headline: z.string().max(200),
  top3: z.array(z.object({
    text: z.string().max(300),
    why: z.string().max(300),
    sessionId: z.string().uuid().optional(),
  })).max(3),
  /** Chats that ended on a question or a step only you can take. */
  waiting: z.array(z.object({
    sessionId: z.string().uuid(),
    title: z.string(),
    projectName: z.string(),
    question: z.string().max(400),
  })).max(8),
  focusCheck: z.object({
    /** on_plan: your day matched Focus; shifted: a sustained shift; mixed: the lead asks you. */
    verdict: z.enum(['on_plan', 'shifted', 'mixed']),
    note: z.string().max(600),
    /** When mixed: how the lead asks you to prioritize. */
    question: z.string().max(300).optional(),
    suggestions: z.array(z.object({
      kind: z.enum(['add', 'drop']),
      label: z.string().max(200),
      projectId: z.string().uuid().optional(),
      /** For 'drop': the Focus item it would remove. */
      focusItemId: z.string().uuid().optional(),
      why: z.string().max(200),
    })).max(3),
  }),
  done: z.array(z.object({ text: z.string().max(300), projectName: z.string().optional() })).max(10),
  cleanUp: z.array(z.object({
    itemId: z.string().uuid(),
    text: z.string(),
    projectName: z.string(),
    ageDays: z.number().int().nonnegative(),
    suggestion: z.enum(['close', 'snooze']),
    why: z.string().max(200),
  })).max(6),
  /** Your messages per project, last 24h / 7d — computed, not written by the lead. */
  activity: z.array(z.object({
    projectId: z.string().uuid(),
    projectName: z.string(),
    mine24: z.number().int().nonnegative(),
    mine7: z.number().int().nonnegative(),
  })),
})

export const ChatMessageMetadataSchema = z.object({
  toolName: z.string().optional(),
  thinkingContent: z.string().optional(),
  credits: z.string().optional(),
  time: z.string().optional(),
  /** Per-reply tokens and cost, when the provider reports them. */
  usage: ReplyUsageSchema.optional(),
  /** Persona who authored this message (team sessions). */
  personaId: z.string().uuid().optional(),
  /**
   * 'deliberation' marks raw team-discussion output; 'prompt' marks a
   * machine-built dispatch prompt (standup/refine/implement). Both are
   * collapsed behind a disclosure in the UI.
   */
  kind: z.enum(['deliberation', 'prompt', 'action', 'idea', 'brief']).optional(),
  /** kind 'action': an action-item card (see ChatActionCardSchema). */
  action: ChatActionCardSchema.optional(),
  /** kind 'idea': an idea card (see ChatIdeaCardSchema). */
  idea: ChatIdeaCardSchema.optional(),
  /** kind 'brief': the lead's daily brief (see BriefSchema). */
  brief: BriefSchema.optional(),
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
  /**
   * Ports the service binds, by name (e.g. firebase.json emulator → port).
   * Persisted so conflicts are caught while the service is stopped; the
   * running service's stdout stays the source of truth while it's up.
   */
  ports: z.record(z.string(), z.number()).optional(),
})

/** Per-project daily standup configuration (the proactive team layer). */
export const ProjectStandupConfigSchema = z.object({
  enabled: z.boolean(),
  /** Local hour of day (0-23) the standup runs. */
  hour: z.number().int().min(0).max(23),
})

/**
 * One layer of provider launch settings: only the keys this layer overrides.
 * Keys and values are checked against the provider's spec by the routes
 * (see provider-settings.ts); the schema just pins the value shapes.
 */
export const ProviderSettingValuesSchema = z.record(
  z.string(),
  z.union([z.string(), z.boolean(), z.array(z.string())]),
)

/** Per-provider overrides, as stored on a project or persona. */
export const ProviderSettingsOverridesSchema = z.object({
  kiro: ProviderSettingValuesSchema.optional(),
  gemini: ProviderSettingValuesSchema.optional(),
  claude: ProviderSettingValuesSchema.optional(),
  codex: ProviderSettingValuesSchema.optional(),
})

export const ProjectSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(100),
  path: z.string().min(1),
  /**
   * CodePipe's own project (the Workspace: home of the lead's thread and of
   * action items that belong to no product). Hidden from project lists.
   */
  internal: z.boolean().optional(),
  devServer: ProjectDevServerSchema.optional(),
  services: z.array(ProjectServiceConfigSchema).optional(),
  standup: ProjectStandupConfigSchema.optional(),
  /** Launch-setting overrides for sessions in this project (over the global layer). */
  providerSettings: ProviderSettingsOverridesSchema.optional(),
})

/**
 * How a chat stopped, read from its last reply (lead/chat-digest.ts): it asked
 * you something, or left something uncommitted / undeployed / blocked, or
 * says it shipped. Drives the sidebar chip; cleared when you send again.
 */
export const ChatAttentionSchema = z.object({
  state: z.enum(['waiting_on_you', 'pending_action', 'done']),
  /** The question it ended on (waiting_on_you). */
  question: z.string().max(400).optional(),
})

/**
 * A chat you deleted — kept as one line for the lead, since deleting is how
 * you mark work done. Written just before the chat is removed.
 */
export const ClosedChatSchema = z.object({
  sessionId: z.string().uuid(),
  projectId: z.string().uuid(),
  title: z.string(),
  /** Your first message (excerpt). */
  request: z.string(),
  /** The agent's last reply (excerpt). */
  lastReply: z.string(),
  attention: ChatAttentionSchema.optional(),
  closedAt: z.number().int().positive(),
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
  /** Persona driving this session (team runs) — their launch overrides apply. */
  personaId: z.string().uuid().optional(),
  /** How the last turn ended (user chats only); absent while you're mid-conversation. */
  attention: ChatAttentionSchema.optional(),
  /**
   * A prompt waiting in the composer, not sent (a chat the lead opened for
   * you with open_project_chat). Cleared when you send.
   */
  draft: z.string().max(20000).optional(),
})

// A model the provider can run, for the picker.
export const ModelOptionSchema = z.object({
  id: z.string().min(1),
  name: z.string().optional(),
})

/** GET /api/provider-settings/:provider/models — `listable: false` = nothing to pick, use free text. */
export const ProviderModelsSchema = z.object({
  listable: z.boolean(),
  models: z.array(ModelOptionSchema),
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

// --- Lead assistant ---

/** One of your priorities, in order (up to 5). */
export const FocusItemSchema = z.object({
  id: z.string().uuid(),
  label: z.string().trim().min(1).max(200),
  /** The project it maps to, so activity can be compared with it. */
  projectId: z.string().uuid().optional(),
})

export const MAX_FOCUS_ITEMS = 5

export const FocusListSchema = z.array(FocusItemSchema).max(MAX_FOCUS_ITEMS)

/** When the daily brief runs on its own (local time). */
export const BriefScheduleSchema = z.object({
  enabled: z.boolean(),
  hour: z.number().int().min(0).max(23),
  weekdaysOnly: z.boolean(),
})

export const DEFAULT_BRIEF_SCHEDULE = { enabled: true, hour: 9, weekdaysOnly: false } as const

/** The lead's state (data/lead-state.json). */
export const LeadStateSchema = z.object({
  focus: FocusListSchema,
  /** The lead's note to its next brief (save_memo). */
  memo: z.string().max(4000).optional(),
  memoSavedAt: z.number().int().positive().optional(),
  /** The lead's thread, and the persona/provider it was created for. */
  sessionId: z.string().uuid().optional(),
  sessionPersonaId: z.string().uuid().optional(),
  sessionProvider: ProviderTypeSchema.optional(),
  /** When the last brief ran — git and closed chats are reported since then. */
  lastBriefAt: z.number().int().positive().optional(),
  /**
   * When a scheduled brief was last attempted — at most one attempt a day,
   * so a failing run never retries every minute.
   */
  lastAttemptAt: z.number().int().positive().optional(),
  /** When the last brief run ended (posted or not) — its write tells clients the run is over. */
  lastRunEndedAt: z.number().int().positive().optional(),
  schedule: BriefScheduleSchema.optional(),
})

export const PutFocusRequestSchema = z.object({ focus: FocusListSchema })

export const PutBriefScheduleRequestSchema = z.object({ schedule: BriefScheduleSchema })

/** GET /api/lead */
export const LeadStatusSchema = z.object({
  /** The persona who leads (null when there's no team yet). */
  leadPersonaId: z.string().uuid().nullable(),
  /** The lead's thread, when it exists for the current lead. */
  sessionId: z.string().uuid().nullable(),
  workspaceProjectId: z.string().uuid(),
  focus: FocusListSchema,
  memo: z.string().nullable(),
  lastBriefAt: z.number().int().positive().nullable(),
  schedule: BriefScheduleSchema,
  /** A brief is being written right now. */
  briefRunning: z.boolean(),
})

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
  /** Launch-setting overrides for this persona's sessions (over global and project). */
  providerSettings: ProviderSettingsOverridesSchema.optional(),
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
   * When the team last saved the memo (save_memo tool). A standup that ends
   * without one most likely ran without CodePipe's tools — surfaced in the
   * thread rather than failing silently.
   */
  memoSavedAt: z.number().int().positive().optional(),
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
  // Remove a queued (not yet dispatched) input, by its message id.
  z.object({
    type: z.literal('unqueue'),
    id: z.string().min(1),
  }),
])

export const WSServerMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('message'), data: ChatMessageSchema }),
  z.object({ type: z.literal('status'), data: z.enum(['typing', 'idle', 'exited']) }),
  z.object({ type: z.literal('history'), data: z.array(ChatMessageSchema) }),
  z.object({ type: z.literal('model_state'), data: ModelStateSchema }),
  z.object({ type: z.literal('error'), data: z.string() }),
  // Inputs waiting behind the running turn; `dropped` = discarded by Stop/Restart.
  z.object({ type: z.literal('queue'), data: z.array(ChatMessageSchema), dropped: z.array(ChatMessageSchema).optional() }),
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

/** An agent tool call, forwarded by the CodePipe MCP server (routes/agent.ts). */
export const AgentToolCallRequestSchema = z.object({
  arguments: z.record(z.unknown()).optional(),
})

/** The user acting on a card in a chat (action item or idea). */
export const CardOpRequestSchema = z.object({
  op: z.enum(['accept', 'dismiss', 'undo']),
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
export type ReplyUsage = z.infer<typeof ReplyUsageSchema>
export type Attachment = z.infer<typeof AttachmentSchema>
export type ChatMessage = z.infer<typeof ChatMessageSchema>
export type ProjectDevServer = z.infer<typeof ProjectDevServerSchema>
export type ProjectServiceConfig = z.infer<typeof ProjectServiceConfigSchema>
export type Project = z.infer<typeof ProjectSchema>
export type Session = z.infer<typeof SessionSchema>
export type SessionMeta = z.infer<typeof SessionMetaSchema>
export type ChatAttention = z.infer<typeof ChatAttentionSchema>
export type FocusItem = z.infer<typeof FocusItemSchema>
export type LeadState = z.infer<typeof LeadStateSchema>
export type LeadStatus = z.infer<typeof LeadStatusSchema>
export type Brief = z.infer<typeof BriefSchema>
export type BriefSchedule = z.infer<typeof BriefScheduleSchema>
export type ClosedChat = z.infer<typeof ClosedChatSchema>
export type WSClientMessage = z.infer<typeof WSClientMessageSchema>
export type WSServerMessage = z.infer<typeof WSServerMessageSchema>
export type ModelOption = z.infer<typeof ModelOptionSchema>
export type ProviderModels = z.infer<typeof ProviderModelsSchema>
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
export type ActionDraft = z.infer<typeof ActionDraftSchema>
export type ChatActionCard = z.infer<typeof ChatActionCardSchema>
export type ChatIdeaCard = z.infer<typeof ChatIdeaCardSchema>
export type Persona = z.infer<typeof PersonaSchema>
export type StandupState = z.infer<typeof StandupStateSchema>
