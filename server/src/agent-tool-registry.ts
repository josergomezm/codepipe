/**
 * The tools an agent can call from inside a CodePipe chat, served through
 * CodePipe's MCP server (mcp/codepipe-mcp.mjs — a thin stdio proxy that asks
 * this registry what to list and forwards every call here).
 *
 * Every session the user works in (chat, build, standup) gets the shared
 * tools: action items (add, list, resolve) and ideas (add). Standup ('team')
 * sessions also get the team protocol: propose_plan, complete_idea and
 * save_memo. Tool calls replace the JSON block standups used to end with —
 * the CLI validates the shape, each call lands as it happens, and a bad
 * argument comes back to the agent as an error it can fix and retry.
 *
 * Arguments arrive as the agent wrote them (snake_case), validated with zod;
 * the input schemas listed to the agent are hand-written JSON Schema kept
 * next to each tool. Results are short plain text the agent reads back.
 */

import { z } from 'zod'

import type { IStorageLayer } from './storage.js'
import type { SessionManager } from './session-manager.js'
import {
  ActionItemKindSchema,
  ActionItemOptionSchema,
  DueDateSchema,
  type ActionDraft,
  type ActionItem,
  type Persona,
  type Session,
  type SessionKind,
  type Todo,
} from './schemas.js'
import { findDuplicateAction, recordActionItem } from './action-items.js'
import {
  MAX_OPEN_ACTIONS,
  RESOLVED_ACTION_WINDOW_MS,
  matchById,
  matchPersona,
  matchTodo,
  normalizeActionText,
} from './standup-protocol.js'

export interface ToolResult {
  text: string
  isError?: boolean
}

/** A tool as listed to the agent (MCP `tools/list` entry). */
export interface ListedTool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

export interface AgentToolDeps {
  storage: IStorageLayer
  sessionManager: SessionManager
  /**
   * A team-raised item was closed from outside the standup thread (a chat
   * agent resolved it) — the team hears about it at the next standup.
   */
  onTeamActionClosed?: (item: ActionItem) => Promise<void>
}

interface ToolContext {
  session: Session
  isTeam: boolean
  deps: AgentToolDeps
}

interface ToolDef {
  name: string
  /** Session kinds that see this tool. */
  kinds: SessionKind[]
  description: (isTeam: boolean) => string
  inputSchema: (isTeam: boolean) => Record<string, unknown>
  run: (ctx: ToolContext, args: Record<string, unknown>) => Promise<ToolResult>
}

const WORKING_KINDS: SessionKind[] = ['chat', 'work', 'team']

/** Error result from a zod failure, phrased for the agent to fix. */
function invalid(error: z.ZodError): ToolResult {
  const issues = error.issues.map((i) => `${i.path.join('.') || 'arguments'}: ${i.message}`)
  return { text: `Invalid arguments — ${issues.join('; ')}`, isError: true }
}

function parseArgs<T>(schema: z.ZodType<T>, args: Record<string, unknown>): { data: T } | { error: ToolResult } {
  const parsed = schema.safeParse(args)
  return parsed.success ? { data: parsed.data } : { error: invalid(parsed.error) }
}

/** Short id the agent can pass back (any unambiguous prefix resolves). */
const shortId = (id: string) => id.slice(0, 8)

async function teamContext(ctx: ToolContext): Promise<{ personas: Persona[]; lead: Persona | undefined; todos: Todo[] }> {
  const personas = await ctx.deps.storage.listPersonas()
  const todos = await ctx.deps.storage.listTodos(ctx.session.projectId)
  return { personas, lead: personas.find((p) => p.isLead) ?? personas[0], todos }
}

// ---------------------------------------------------------------------------
// Action items
// ---------------------------------------------------------------------------

const actionFields = {
  text: z.string().trim().min(1).max(2000),
  notes: z.string().max(10000).optional(),
  kind: ActionItemKindSchema.optional(),
  options: z.array(ActionItemOptionSchema).max(6).optional(),
  steps: z.array(z.string().min(1).max(1000)).max(12).optional(),
  due_date: DueDateSchema.optional(),
  blocking: z.boolean().optional(),
}

const AddActionArgs = z.object({
  ...actionFields,
  user_requested: z.boolean().optional(),
  persona: z.string().optional(),
  todo_id: z.string().optional(),
})

const actionProperties = {
  text: {
    type: 'string',
    description: 'One line: what the user must do, or (for a decision) the question to answer.',
  },
  notes: { type: 'string', description: 'Optional short context: why it is needed — not a restatement of the options.' },
  kind: {
    type: 'string',
    enum: ['task', 'decision'],
    description: "'decision' when the user must choose or clarify; 'task' for something to do (default).",
  },
  options: {
    type: 'array',
    description: 'For decisions: 2–4 answers the user can tap. Mark your recommendation.',
    items: {
      type: 'object',
      properties: {
        label: { type: 'string', description: 'Short answer.' },
        detail: { type: 'string', description: 'One line: what it means.' },
        recommended: { type: 'boolean' },
      },
      required: ['label'],
    },
  },
  steps: {
    type: 'array',
    items: { type: 'string' },
    description: 'For tasks: a concrete walkthrough (console URLs, exact commands, which file the value goes in).',
  },
  due_date: {
    type: 'string',
    description: 'YYYY-MM-DD. Only a real deadline the user named or you found (an expiring key, a launch date) — never an invented one.',
  },
  blocking: { type: 'boolean', description: 'false when it is worth knowing but blocks nothing.' },
}

const addActionItem: ToolDef = {
  name: 'add_action_item',
  kinds: WORKING_KINDS,
  description: (isTeam) =>
    isTeam
      ? `Raise something only the user can do and that blocks progress — a decision, a secret, an account, a purchase. It goes straight onto their action-item list, credited to \`persona\`. At most ${MAX_OPEN_ACTIONS} team items may wait on the user at once: at the limit, close a less important one with resolve_action_item first.`
      : [
          "Add an item to the user's action-item list in CodePipe — something only the user can do: a decision, an account/secret/purchase to set up, a reminder, a deadline.",
          'Use it when the user asks you to add, track or remember something for them (user_requested: true — it is added right away).',
          'Also use it when you hit something that genuinely needs the user and would otherwise get lost in the chat (user_requested: false — the user sees a suggestion card and decides).',
          'Do not use it for work you can do yourself, and add each thing once.',
        ].join(' '),
  inputSchema: (isTeam) => ({
    type: 'object',
    properties: isTeam
      ? {
          ...actionProperties,
          persona: { type: 'string', description: 'Name of the team member raising it (defaults to the lead).' },
          todo_id: { type: 'string', description: 'The [id] of the idea this gates, when it is a prerequisite of one.' },
        }
      : {
          ...actionProperties,
          user_requested: {
            type: 'boolean',
            description: 'true when the user asked for this item; false when you are suggesting it on your own.',
          },
        },
    required: isTeam ? ['text'] : ['text', 'user_requested'],
  }),
  async run(ctx, raw) {
    const parsed = parseArgs(AddActionArgs, raw)
    if ('error' in parsed) return parsed.error
    const a = parsed.data
    const { storage, sessionManager } = ctx.deps
    const projectId = ctx.session.projectId
    const draft: ActionDraft = {
      text: a.text,
      ...(a.notes?.trim() ? { notes: a.notes.trim() } : {}),
      ...(a.kind ? { kind: a.kind } : {}),
      ...(a.options?.length ? { options: a.options } : {}),
      ...(a.steps?.length ? { steps: a.steps } : {}),
      ...(a.due_date ? { dueDate: a.due_date } : {}),
      ...(a.blocking === false ? { blocking: false } : {}),
    }

    if (ctx.isTeam) {
      const { personas, lead, todos } = await teamContext(ctx)
      const persona = (a.persona ? matchPersona(personas, a.persona) : null) ?? lead
      const gated = a.todo_id ? matchTodo(todos, a.todo_id) : null
      if (a.todo_id && !gated) return { text: `No idea matches "${a.todo_id}" — use an [id] from the board.`, isError: true }
      const result = await recordActionItem(storage, projectId, {
        ...draft,
        ...(gated ? { todoId: gated.id } : {}),
        ...(persona ? { personaId: persona.id } : {}),
      })
      if (result.status === 'over_cap') {
        return {
          text: `Not added: ${MAX_OPEN_ACTIONS} team items are already waiting on the user. Raise this only if it matters more than one of them — close that one with resolve_action_item, then add this again.`,
          isError: true,
        }
      }
      if (result.status === 'duplicate') {
        return { text: `Already tracked as [${shortId(result.item.id)}] "${result.item.text}" — not added again.` }
      }
      sessionManager.appendCard(ctx.session.id, `Added to your action items: ${draft.text}`, {
        kind: 'action',
        action: { draft, state: 'added', itemId: result.item.id },
      })
      return { text: `Added [${shortId(result.item.id)}] "${draft.text}" to the user's action items.` }
    }

    if (a.user_requested === undefined) {
      return { text: 'Invalid arguments — user_requested: Required', isError: true }
    }
    if (a.user_requested) {
      const result = await recordActionItem(storage, projectId, draft)
      if (result.status === 'duplicate') {
        return { text: `Already on the user's list, not added again: "${result.item.text}".` }
      }
      if (result.status !== 'added') return { text: 'Not added.', isError: true }
      sessionManager.appendCard(ctx.session.id, `Added to your action items: ${draft.text}`, {
        kind: 'action',
        action: { draft, state: 'added', itemId: result.item.id },
      })
      return {
        text: `Added to the user's action items: "${draft.text}". They see it in this chat and on their Action items page.`,
      }
    }

    const duplicate = findDuplicateAction(await storage.listActionItems(projectId), draft)
    if (duplicate) return { text: `Already on the user's list: "${duplicate.text}".` }
    sessionManager.appendCard(ctx.session.id, `Suggested action item: ${draft.text}`, {
      kind: 'action',
      action: { draft, state: 'suggested' },
    })
    return {
      text: 'Shown to the user as a suggestion card in this chat — they decide whether to add it. No need to mention it again.',
    }
  },
}

const ListActionArgs = z.object({ include_closed: z.boolean().optional() })

function describeItem(item: ActionItem, personas: Persona[], todos: Todo[], today: string): string {
  const tags: string[] = [item.kind ?? 'task']
  if (item.blocking === false) tags.push('non-blocking')
  if (item.dueDate) tags.push(`due ${item.dueDate}${item.dueDate < today ? ' (overdue)' : item.dueDate === today ? ' (today)' : ''}`)
  if (item.snoozedUntil && item.snoozedUntil > Date.now()) tags.push('snoozed')
  const raisedBy = item.personaId ? personas.find((p) => p.id === item.personaId)?.name : null
  tags.push(raisedBy ? `raised by ${raisedBy}` : "the user's own")
  const gated = item.todoId ? todos.find((t) => t.id === item.todoId) : null
  if (gated) tags.push(`gates idea [${shortId(gated.id)}] "${gated.text}"`)
  const lines = [`- [${shortId(item.id)}] (${tags.join(', ')}) ${item.text}`]
  if (item.options?.length) lines.push(`  Options: ${item.options.map((o) => o.label + (o.recommended ? ' (recommended)' : '')).join('; ')}`)
  if (item.notes) lines.push(`  Notes: ${item.notes.slice(0, 300)}`)
  return lines.join('\n')
}

const listActionItems: ToolDef = {
  name: 'list_action_items',
  kinds: WORKING_KINDS,
  description: () =>
    "List what is waiting on the user in this project (their action items), with [id]s for resolve_action_item. Set include_closed to also see what they recently answered, did or declined.",
  inputSchema: () => ({
    type: 'object',
    properties: {
      include_closed: { type: 'boolean', description: 'Also list items closed in the last 14 days, with the user’s answer.' },
    },
  }),
  async run(ctx, raw) {
    const parsed = parseArgs(ListActionArgs, raw)
    if ('error' in parsed) return parsed.error
    const { storage } = ctx.deps
    const [items, personas, todos] = await Promise.all([
      storage.listActionItems(ctx.session.projectId),
      storage.listPersonas(),
      storage.listTodos(ctx.session.projectId),
    ])
    const today = new Date().toISOString().slice(0, 10)
    const open = items.filter((a) => a.status === 'open').sort((a, b) => a.createdAt - b.createdAt)
    const sections = [
      open.length
        ? `Waiting on the user (${open.length}):\n${open.map((a) => describeItem(a, personas, todos, today)).join('\n')}`
        : 'Nothing is waiting on the user in this project.',
    ]
    if (parsed.data.include_closed) {
      const closed = items
        .filter((a) => a.status !== 'open' && Date.now() - a.updatedAt <= RESOLVED_ACTION_WINDOW_MS)
        .sort((a, b) => b.updatedAt - a.updatedAt)
      sections.push(
        closed.length
          ? `Recently closed:\n${closed
              .map((a) => `- [${shortId(a.id)}] ${a.status === 'dismissed' ? 'declined' : 'done'}: ${a.text}${a.resolution ? ` — ${a.status === 'dismissed' ? 'reason' : 'answer'}: ${a.resolution}` : ''}`)
              .join('\n')}`
          : 'Nothing closed recently.',
      )
    }
    return { text: sections.join('\n\n') }
  },
}

const ResolveActionArgs = z.object({
  id: z.string().trim().min(1),
  resolution: z.string().max(4000).optional(),
  declined: z.boolean().optional(),
})

const resolveActionItem: ToolDef = {
  name: 'resolve_action_item',
  kinds: WORKING_KINDS,
  description: (isTeam) =>
    isTeam
      ? 'Close a team-raised item that no longer blocks anything — the user settled it in this conversation, or the plan changed so it is moot. Pass the [id] (a prefix is fine). The user’s own items are theirs to close.'
      : "Close one of the user's action items once it is settled — they told you they did it, answered it in this chat, or it became moot. Pass the [id] from list_action_items (a prefix is fine) and, for a decision, their answer as `resolution`. Set declined when they decided not to do it.",
  inputSchema: () => ({
    type: 'object',
    properties: {
      id: { type: 'string', description: 'The item’s [id] (or an unambiguous prefix).' },
      resolution: { type: 'string', description: 'The user’s answer, or what was done — kept with the item.' },
      declined: { type: 'boolean', description: 'true when the user decided not to do it (won’t do).' },
    },
    required: ['id'],
  }),
  async run(ctx, raw) {
    const parsed = parseArgs(ResolveActionArgs, raw)
    if ('error' in parsed) return parsed.error
    const { id, resolution, declined } = parsed.data
    const { storage, sessionManager } = ctx.deps
    const open = (await storage.listActionItems(ctx.session.projectId)).filter((a) => a.status === 'open')
    const item = matchById(open, id)
    if (!item) return { text: `No open item matches "${id}". Call list_action_items for the current [id]s.`, isError: true }
    if (ctx.isTeam && !item.personaId) {
      return { text: `"${item.text}" is the user's own item — only they can close it.`, isError: true }
    }
    const closed = await storage.updateActionItem(item.id, {
      status: declined ? 'dismissed' : 'done',
      ...(resolution?.trim() ? { resolution: resolution.trim() } : {}),
    })
    sessionManager.appendCard(ctx.session.id, `Closed action item: ${item.text}`, {
      kind: 'action',
      action: {
        draft: { text: item.text },
        state: 'closed',
        itemId: item.id,
        ...(resolution?.trim() ? { resolution: resolution.trim() } : {}),
        ...(declined ? { declined: true } : {}),
      },
    })
    // Closed from a chat → the team learns at the next standup. A standup
    // closing its own item needs no echo.
    if (!ctx.isTeam && closed.personaId) await ctx.deps.onTeamActionClosed?.(closed)
    return { text: `Closed [${shortId(item.id)}] "${item.text}"${declined ? ' as declined' : ''}.` }
  },
}

// ---------------------------------------------------------------------------
// Ideas
// ---------------------------------------------------------------------------

const AddIdeaArgs = z.object({
  text: z.string().trim().min(1).max(2000),
  notes: z.string().max(10000).optional(),
})

const addIdea: ToolDef = {
  name: 'add_idea',
  kinds: WORKING_KINDS,
  description: () =>
    "Put an idea on this project's Ideas board — a feature, fix or refactor worth doing later. The team reviews new ideas at the next standup and proposes a plan. Use it when the user asks to capture an idea, or for a worthwhile follow-up you are not doing now (say so in your reply).",
  inputSchema: () => ({
    type: 'object',
    properties: {
      text: { type: 'string', description: 'One line: the idea.' },
      notes: { type: 'string', description: 'Context the team will need: why, where in the code, constraints.' },
    },
    required: ['text'],
  }),
  async run(ctx, raw) {
    const parsed = parseArgs(AddIdeaArgs, raw)
    if ('error' in parsed) return parsed.error
    const { text, notes } = parsed.data
    const { storage, sessionManager } = ctx.deps
    const key = normalizeActionText(text)
    const existing = (await storage.listTodos(ctx.session.projectId)).find(
      (t) => t.status !== 'done' && normalizeActionText(t.text) === key,
    )
    if (existing) return { text: `Already on the board as [${shortId(existing.id)}] "${existing.text}".` }
    const todo = await storage.addTodo({
      projectId: ctx.session.projectId,
      text,
      ...(notes?.trim() ? { notes: notes.trim() } : {}),
    })
    sessionManager.appendCard(ctx.session.id, `Added to ideas: ${text}`, {
      kind: 'idea',
      idea: { text, ...(notes?.trim() ? { notes: notes.trim() } : {}), state: 'added', todoId: todo.id },
    })
    return { text: `Added [${shortId(todo.id)}] "${text}" to the Ideas board — the team reviews it at the next standup.` }
  },
}

// ---------------------------------------------------------------------------
// Team protocol (standup sessions only)
// ---------------------------------------------------------------------------

const ProposePlanArgs = z.object({
  idea_id: z.string().trim().min(1),
  summary: z.string().trim().min(1).max(500),
  approach: z.string().trim().min(1).max(8000),
  brief: z.string().trim().min(1).max(20000),
  effort: z.string().max(200).optional(),
  persona: z.string().optional(),
})

const proposePlan: ToolDef = {
  name: 'propose_plan',
  kinds: ['team'],
  description: () =>
    "Attach the team's recommendation to an idea on the board (moves it to Proposed for the user to approve). Call again with the same idea_id to replace it. `brief` is the real deliverable: the exact, standalone prompt a coding agent will be handed to build it.",
  inputSchema: () => ({
    type: 'object',
    properties: {
      idea_id: { type: 'string', description: 'The [id] of the idea.' },
      summary: { type: 'string', description: 'One line.' },
      approach: { type: 'string', description: 'How to implement it, for the user to read.' },
      brief: {
        type: 'string',
        description: 'The execution prompt: goal, files/docs to read first (by path), hard constraints and what NOT to touch, definition of done. Never mentions the team, the takes or this conversation.',
      },
      effort: { type: 'string', description: 'Rough estimate, only if you can ground it.' },
      persona: { type: 'string', description: 'Team member proposing it — they will build it (defaults to the lead).' },
    },
    required: ['idea_id', 'summary', 'approach', 'brief'],
  }),
  async run(ctx, raw) {
    const parsed = parseArgs(ProposePlanArgs, raw)
    if ('error' in parsed) return parsed.error
    const a = parsed.data
    const { personas, todos } = await teamContext(ctx)
    const todo = matchTodo(todos.filter((t) => t.status !== 'done'), a.idea_id)
    if (!todo) return { text: `No open idea matches "${a.idea_id}" — use an [id] from the board.`, isError: true }
    const persona = a.persona ? matchPersona(personas, a.persona) : null
    await ctx.deps.storage.updateTodo(todo.id, {
      status: 'proposed',
      proposal: {
        summary: a.summary,
        approach: a.approach,
        brief: a.brief,
        ...(a.effort ? { effort: a.effort } : {}),
        ...(persona ? { personaId: persona.id } : {}),
      },
    })
    return { text: `Proposal saved on [${shortId(todo.id)}] "${todo.text}" — it is now Proposed for the user to review.` }
  },
}

const CompleteIdeaArgs = z.object({
  idea_id: z.string().trim().min(1),
  evidence: z.string().trim().min(1).max(500),
})

const completeIdea: ToolDef = {
  name: 'complete_idea',
  kinds: ['team'],
  description: () =>
    'Move a planned idea to Done because you VERIFIED it is already implemented (built outside CodePipe). Give evidence the user can check — a commit hash or file. Its open prerequisites close with it.',
  inputSchema: () => ({
    type: 'object',
    properties: {
      idea_id: { type: 'string', description: 'The [id] of the idea.' },
      evidence: { type: 'string', description: 'Commit hash or file that proves it.' },
    },
    required: ['idea_id', 'evidence'],
  }),
  async run(ctx, raw) {
    const parsed = parseArgs(CompleteIdeaArgs, raw)
    if ('error' in parsed) return parsed.error
    const { storage, sessionManager } = ctx.deps
    const todos = await storage.listTodos(ctx.session.projectId)
    const todo = matchTodo(todos.filter((t) => t.status !== 'done'), parsed.data.idea_id)
    if (!todo) return { text: `No open idea matches "${parsed.data.idea_id}".`, isError: true }
    await storage.updateTodo(todo.id, { status: 'done' })
    const prerequisites = (await storage.listActionItems(ctx.session.projectId)).filter(
      (a) => a.status === 'open' && a.personaId && a.todoId === todo.id,
    )
    for (const item of prerequisites) await storage.updateActionItem(item.id, { status: 'done' })
    sessionManager.appendSystemMessage(
      ctx.session.id,
      `Moved "${todo.text}" to Done — the team found it already implemented (${parsed.data.evidence}).`,
    )
    return {
      text: `Moved [${shortId(todo.id)}] to Done${prerequisites.length ? ` and closed ${prerequisites.length} prerequisite item(s)` : ''}.`,
    }
  },
}

const SaveMemoArgs = z.object({ memo: z.string().trim().min(1).max(4000) })

const saveMemo: ToolDef = {
  name: 'save_memo',
  kinds: ['team'],
  description: () =>
    'Save your handoff note to the next standup — it starts fresh and receives ONLY this note plus the board. Record decisions made, open questions, and anything you would otherwise forget. Under a paragraph. Replaces the previous memo.',
  inputSchema: () => ({
    type: 'object',
    properties: { memo: { type: 'string', description: 'The full note (replaces the previous one).' } },
    required: ['memo'],
  }),
  async run(ctx, raw) {
    const parsed = parseArgs(SaveMemoArgs, raw)
    if ('error' in parsed) return parsed.error
    const { storage } = ctx.deps
    const projectId = ctx.session.projectId
    const state = (await storage.getStandupState(projectId)) ?? { projectId }
    state.memo = parsed.data.memo
    state.memoSavedAt = Date.now()
    await storage.setStandupState(state)
    return { text: 'Memo saved for the next standup.' }
  },
}

const TOOLS: ToolDef[] = [
  addActionItem,
  listActionItems,
  resolveActionItem,
  addIdea,
  proposePlan,
  completeIdea,
  saveMemo,
]

export class AgentToolService {
  constructor(private readonly deps: AgentToolDeps) {}

  /** The tools a session's agent gets (empty for reviewer sessions). */
  listTools(session: Session): ListedTool[] {
    const kind = session.kind ?? 'chat'
    const isTeam = kind === 'team'
    return TOOLS.filter((t) => t.kinds.includes(kind)).map((t) => ({
      name: t.name,
      description: t.description(isTeam),
      inputSchema: t.inputSchema(isTeam),
    }))
  }

  /** Run one tool call. Unknown or unavailable tools are an error result, not a throw. */
  async call(session: Session, name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
    const kind = session.kind ?? 'chat'
    const tool = TOOLS.find((t) => t.name === name && t.kinds.includes(kind))
    if (!tool) return { text: `Unknown tool: ${name}`, isError: true }
    return tool.run({ session, isTeam: kind === 'team', deps: this.deps }, args)
  }
}
