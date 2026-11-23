/**
 * The tools an agent can call from inside a CodePipe chat, served through
 * CodePipe's MCP server (mcp/codepipe-mcp.mjs — a thin stdio proxy that asks
 * this registry what to list and forwards every call here).
 *
 * Every session the user works in (chat, build, standup) gets the shared
 * tools: action items (add, list, resolve) and ideas (add). Standup ('team')
 * sessions also get the team protocol: propose_plan, complete_idea and
 * save_memo. The lead's workspace thread ('lead') gets the item tools across
 * ALL projects, plus its own: reading your chats, your Focus list, its memo,
 * and opening a project chat with a drafted prompt (it never edits code). Tool calls replace the JSON block standups used to end with —
 * the CLI validates the shape, each call lands as it happens, and a bad
 * argument comes back to the agent as an error it can fix and retry.
 *
 * Arguments arrive as the agent wrote them (snake_case), validated with zod;
 * the input schemas listed to the agent are hand-written JSON Schema kept
 * next to each tool. Results are short plain text the agent reads back.
 */

import { randomUUID } from 'crypto'
import { z } from 'zod'

import type { IStorageLayer } from './storage.js'
import type { SessionManager } from './session-manager.js'
import {
  ActionItemKindSchema,
  ActionItemOptionSchema,
  DueDateSchema,
  MAX_FOCUS_ITEMS,
  type ActionDraft,
  type Brief,
  type ActionItem,
  type FocusItem,
  type Persona,
  type Project,
  type Session,
  type SessionKind,
  type Todo,
} from './schemas.js'
import { clip, clipEnd, digestChat, extractTurns, isUserChat, type Turn } from './lead/chat-digest.js'
import { activityRows, loadUserChats } from './lead/workspace-digest.js'
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
/** The item tools: every working session, plus the lead (across all projects). */
const ITEM_KINDS: SessionKind[] = [...WORKING_KINDS, 'lead']

const isLead = (ctx: ToolContext) => ctx.session.kind === 'lead'

/** Which project's items a session sees: its own, or all of them for the lead. */
const itemScope = (ctx: ToolContext): string | undefined => (isLead(ctx) ? undefined : ctx.session.projectId)

/**
 * A project by [id] prefix or name (exact, then partial; case-insensitive).
 * The internal Workspace project only by its name.
 */
export function matchProject(projects: Project[], query: string): Project | null {
  const q = query.trim().toLowerCase()
  if (!q) return null
  const byId = projects.filter((p) => p.id.toLowerCase().startsWith(q))
  if (byId.length === 1) return byId[0]
  const exact = projects.find((p) => p.name.toLowerCase() === q)
  if (exact) return exact
  const partial = projects.filter((p) => !p.internal && p.name.toLowerCase().includes(q))
  return partial.length === 1 ? partial[0] : null
}

function projectNames(projects: Project[]): string {
  return projects.filter((p) => !p.internal).map((p) => p.name).join(', ')
}

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
  project: z.string().optional(),
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
  kinds: ITEM_KINDS,
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
          project: {
            type: 'string',
            description: '(Lead only) Project name or [id] it belongs to; omit for "Workspace" — work that belongs to no single product (partnerships, business, admin).',
          },
        },
    required: isTeam ? ['text'] : ['text', 'user_requested'],
  }),
  async run(ctx, raw) {
    const parsed = parseArgs(AddActionArgs, raw)
    if ('error' in parsed) return parsed.error
    const a = parsed.data
    const { storage, sessionManager } = ctx.deps
    let projectId = ctx.session.projectId
    if (isLead(ctx) && a.project?.trim()) {
      const projects = await storage.listProjects()
      const project = matchProject(projects, a.project)
      if (!project) return { text: `No project matches "${a.project}". Projects: ${projectNames(projects)} (or omit it for Workspace).`, isError: true }
      projectId = project.id
    }
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
    sessionManager.appendCard(
      ctx.session.id,
      `Suggested action item: ${draft.text}`,
      { kind: 'action', action: { draft, state: 'suggested' } },
      { atTurnEnd: true },
    )
    return {
      text: 'The user will see this as a suggestion card right after your reply — they decide whether to add it. No need to repeat it in your reply.',
    }
  },
}

const ListActionArgs = z.object({ include_closed: z.boolean().optional() })

function describeItem(item: ActionItem, personas: Persona[], todos: Todo[], today: string, projectName?: string): string {
  const tags: string[] = [item.kind ?? 'task']
  if (projectName) tags.unshift(projectName)
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
  kinds: ITEM_KINDS,
  description: () =>
    "List what is waiting on the user in this project (their action items; the lead sees every project's), with [id]s for resolve_action_item. Set include_closed to also see what they recently answered, did or declined.",
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
    const scope = itemScope(ctx)
    const [items, personas, todos, projects] = await Promise.all([
      storage.listActionItems(scope),
      storage.listPersonas(),
      storage.listTodos(scope),
      storage.listProjects(),
    ])
    const projectName = (id: string) => (scope ? undefined : projects.find((p) => p.id === id)?.name ?? 'Removed project')
    const today = new Date().toISOString().slice(0, 10)
    const open = items.filter((a) => a.status === 'open').sort((a, b) => a.createdAt - b.createdAt)
    const sections = [
      open.length
        ? `Waiting on the user (${open.length}):\n${open.map((a) => describeItem(a, personas, todos, today, projectName(a.projectId))).join('\n')}`
        : scope ? 'Nothing is waiting on the user in this project.' : 'Nothing is waiting on the user.',
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
  kinds: ITEM_KINDS,
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
    const open = (await storage.listActionItems(itemScope(ctx))).filter((a) => a.status === 'open')
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
  kinds: ['team', 'lead'],
  description: () =>
    'Save your handoff note to your next run (standup or brief) — record decisions made, open questions, what you are watching, and anything you would otherwise forget. Under a paragraph. Replaces the previous memo.',
  inputSchema: () => ({
    type: 'object',
    properties: { memo: { type: 'string', description: 'The full note (replaces the previous one).' } },
    required: ['memo'],
  }),
  async run(ctx, raw) {
    const parsed = parseArgs(SaveMemoArgs, raw)
    if ('error' in parsed) return parsed.error
    const { storage } = ctx.deps
    if (isLead(ctx)) {
      await storage.updateLeadState((s) => {
        s.memo = parsed.data.memo
        s.memoSavedAt = Date.now()
      })
      return { text: 'Memo saved for your next brief.' }
    }
    const projectId = ctx.session.projectId
    const state = (await storage.getStandupState(projectId)) ?? { projectId }
    state.memo = parsed.data.memo
    state.memoSavedAt = Date.now()
    await storage.setStandupState(state)
    return { text: 'Memo saved for the next standup.' }
  },
}

// ---------------------------------------------------------------------------
// The lead: your chats, your Focus list, project chats
// ---------------------------------------------------------------------------

const userChats = (ctx: ToolContext) =>
  loadUserChats({ storage: ctx.deps.storage, liveSession: (id) => ctx.deps.sessionManager.getSession(id) })

/** A chat by [id] prefix or title (exact, then partial; case-insensitive). */
function matchChat(chats: Session[], query: string): Session | null {
  const q = query.trim().toLowerCase()
  if (!q) return null
  const byId = chats.filter((s) => s.id.toLowerCase().startsWith(q))
  if (byId.length === 1) return byId[0]
  const exact = chats.filter((s) => s.title.toLowerCase() === q)
  if (exact.length === 1) return exact[0]
  const partial = chats.filter((s) => s.title.toLowerCase().includes(q))
  return partial.length === 1 ? partial[0] : null
}

const TURN_CHARS = 2500

function formatTurn(t: Turn, n: number): string {
  const when = new Date(t.at).toISOString().slice(0, 16).replace('T', ' ')
  return `Turn ${n} (${when})\nYou: ${clip(t.you, TURN_CHARS)}\nAgent: ${t.reply ? clipEnd(t.reply, TURN_CHARS) : '(no reply yet)'}`
}

const listOpenChats: ToolDef = {
  name: 'list_open_chats',
  kinds: ['lead'],
  description: () =>
    'List the user\'s open chats across all projects (finished ones get deleted, so open = still in flight), newest first, with [id]s for read_chat, how each ended, and when it last moved.',
  inputSchema: () => ({ type: 'object', properties: {} }),
  async run(ctx) {
    const [chats, projects] = await Promise.all([userChats(ctx), ctx.deps.storage.listProjects()])
    if (!chats.length) return { text: 'No open chats.' }
    const lines = chats.map((s) => {
      const project = projects.find((p) => p.id === s.projectId)?.name ?? 'Removed project'
      const ended = s.attention ? `, ${s.attention.state.replace(/_/g, ' ')}${s.attention.question ? `: "${s.attention.question}"` : ''}` : ''
      return `- [${shortId(s.id)}] "${s.title}" (${project}, ${new Date(s.updatedAt).toISOString().slice(0, 10)}${ended})`
    })
    return { text: `Open chats (${chats.length}):\n${lines.join('\n')}` }
  },
}

const ReadChatArgs = z.object({
  chat: z.string().trim().min(1),
  from: z.enum(['start', 'end']).optional(),
  turns: z.number().int().min(1).max(10).optional(),
})

const readChat: ToolDef = {
  name: 'read_chat',
  kinds: ['lead'],
  description: () =>
    'Read whole turns of one of the user\'s chats (their message + the agent\'s final reply) when the brief\'s excerpt isn\'t enough — e.g. what was originally asked, or what exactly is pending. from: "start" for the beginning, "end" (default) for the latest.',
  inputSchema: () => ({
    type: 'object',
    properties: {
      chat: { type: 'string', description: 'The chat\'s [id] (a prefix is fine) or its title.' },
      from: { type: 'string', enum: ['start', 'end'], description: 'Read from the start or the end (default end).' },
      turns: { type: 'number', description: 'How many turns (1–10, default 4).' },
    },
    required: ['chat'],
  }),
  async run(ctx, raw) {
    const parsed = parseArgs(ReadChatArgs, raw)
    if ('error' in parsed) return parsed.error
    const { chat, from = 'end', turns: n = 4 } = parsed.data
    const session = matchChat(await userChats(ctx), chat)
    if (!session) return { text: `No open chat matches "${chat}". Call list_open_chats for the [id]s.`, isError: true }
    const turns = extractTurns(session.messages)
    const start = from === 'start' ? 0 : Math.max(0, turns.length - n)
    const picked = turns.slice(start, start + n)
    if (!picked.length) return { text: `"${session.title}" has no messages from the user yet.` }
    return { text: `"${session.title}" — turns ${start + 1}–${start + picked.length} of ${turns.length}:\n\n${picked.map((t, i) => formatTurn(t, start + i + 1)).join('\n\n')}` }
  },
}

const SearchChatArgs = z.object({ chat: z.string().trim().min(1), query: z.string().trim().min(2).max(200) })

const searchChat: ToolDef = {
  name: 'search_chat',
  kinds: ['lead'],
  description: () => 'Find the turns of one of the user\'s chats that mention something (case-insensitive) — e.g. "was the deploy ever approved?". Returns up to 5 matching turns.',
  inputSchema: () => ({
    type: 'object',
    properties: {
      chat: { type: 'string', description: 'The chat\'s [id] (a prefix is fine) or its title.' },
      query: { type: 'string', description: 'Words to look for.' },
    },
    required: ['chat', 'query'],
  }),
  async run(ctx, raw) {
    const parsed = parseArgs(SearchChatArgs, raw)
    if ('error' in parsed) return parsed.error
    const session = matchChat(await userChats(ctx), parsed.data.chat)
    if (!session) return { text: `No open chat matches "${parsed.data.chat}". Call list_open_chats for the [id]s.`, isError: true }
    const q = parsed.data.query.toLowerCase()
    const turns = extractTurns(session.messages)
    const hits = turns.map((t, i) => ({ t, n: i + 1 })).filter(({ t }) => t.you.toLowerCase().includes(q) || t.reply.toLowerCase().includes(q))
    if (!hits.length) return { text: `No turn of "${session.title}" mentions "${parsed.data.query}".` }
    return { text: `"${session.title}" — ${hits.length} matching turn(s)${hits.length > 5 ? ', showing the last 5' : ''}:\n\n${hits.slice(-5).map(({ t, n }) => formatTurn(t, n)).join('\n\n')}` }
  },
}

const UpdateFocusArgs = z.object({
  focus: z.array(z.object({ label: z.string().trim().min(1).max(200), project: z.string().optional() })).max(MAX_FOCUS_ITEMS),
})

const updateFocus: ToolDef = {
  name: 'update_focus',
  kinds: ['lead'],
  description: () =>
    `Replace the user's Focus list — their priorities, most important first (up to ${MAX_FOCUS_ITEMS}). Only after the user agreed to the change in this thread; send the whole new list.`,
  inputSchema: () => ({
    type: 'object',
    properties: {
      focus: {
        type: 'array',
        description: 'The full new list, in priority order.',
        items: {
          type: 'object',
          properties: {
            label: { type: 'string', description: 'The priority, in a few words.' },
            project: { type: 'string', description: 'Project name or [id] it maps to, if any.' },
          },
          required: ['label'],
        },
      },
    },
    required: ['focus'],
  }),
  async run(ctx, raw) {
    const parsed = parseArgs(UpdateFocusArgs, raw)
    if ('error' in parsed) return parsed.error
    const projects = await ctx.deps.storage.listProjects()
    const focus: FocusItem[] = []
    for (const item of parsed.data.focus) {
      const project = item.project?.trim() ? matchProject(projects, item.project) : null
      if (item.project?.trim() && !project) return { text: `No project matches "${item.project}". Projects: ${projectNames(projects)}.`, isError: true }
      focus.push({ id: randomUUID(), label: item.label, ...(project ? { projectId: project.id } : {}) })
    }
    await ctx.deps.storage.updateLeadState((s) => { s.focus = focus })
    ctx.deps.sessionManager.appendSystemMessage(ctx.session.id, `Focus updated: ${focus.map((f, i) => `${i + 1}. ${f.label}`).join(' · ') || '(empty)'}`)
    return { text: `Focus updated (${focus.length} item${focus.length === 1 ? '' : 's'}).` }
  },
}

const OpenProjectChatArgs = z.object({
  project: z.string().trim().min(1),
  title: z.string().trim().min(1).max(120),
  prompt: z.string().trim().min(1).max(20000),
})

const openProjectChat: ToolDef = {
  name: 'open_project_chat',
  kinds: ['lead'],
  description: () =>
    'Open a new chat in one of the user\'s projects with a prompt you drafted waiting in its message box — NOT sent; the user reviews and sends it. This is how work on code happens: you never change code yourself. Write the prompt as the user would: the goal, the context the agent needs, and what done looks like.',
  inputSchema: () => ({
    type: 'object',
    properties: {
      project: { type: 'string', description: 'Project name or [id].' },
      title: { type: 'string', description: 'Short chat title.' },
      prompt: { type: 'string', description: 'The drafted first message.' },
    },
    required: ['project', 'title', 'prompt'],
  }),
  async run(ctx, raw) {
    const parsed = parseArgs(OpenProjectChatArgs, raw)
    if ('error' in parsed) return parsed.error
    const { storage, sessionManager } = ctx.deps
    const projects = (await storage.listProjects()).filter((p) => !p.internal)
    const project = matchProject(projects, parsed.data.project)
    if (!project) return { text: `No project matches "${parsed.data.project}". Projects: ${projectNames(projects)}.`, isError: true }
    // The provider you last used in that project, else the lead's own.
    const recent = (await storage.listSessions())
      .filter((s) => s.projectId === project.id && isUserChat(s))
      .sort((a, b) => b.updatedAt - a.updatedAt)[0]
    const session = await sessionManager.createSession(recent?.provider ?? ctx.session.provider, project.id, {
      title: parsed.data.title,
      draft: parsed.data.prompt,
    })
    sessionManager.appendSystemMessage(ctx.session.id, `Opened a chat in ${project.name}: "${parsed.data.title}" — your prompt is waiting in its message box.`)
    return { text: `Opened "${parsed.data.title}" in ${project.name} [${shortId(session.id)}] with the prompt in its message box. The user sends it when ready.` }
  },
}

const PostBriefArgs = z.object({
  headline: z.string().trim().min(1).max(200),
  top3: z.array(z.object({ text: z.string().trim().min(1).max(300), why: z.string().trim().max(300), chat: z.string().optional() })).max(3),
  waiting_on_you: z.array(z.object({ chat: z.string().trim().min(1), question: z.string().trim().min(1).max(400) })).max(8).optional(),
  focus_check: z.object({
    verdict: z.enum(['on_plan', 'shifted', 'mixed']),
    note: z.string().trim().max(600),
    question: z.string().trim().max(300).optional(),
    suggestions: z.array(z.object({
      kind: z.enum(['add', 'drop']),
      label: z.string().trim().min(1).max(200),
      project: z.string().optional(),
      focus_item: z.union([z.string(), z.number()]).optional(),
      why: z.string().trim().max(200),
    })).max(3).optional(),
  }),
  done: z.array(z.object({ text: z.string().trim().min(1).max(300), project: z.string().optional() })).max(10).optional(),
  clean_up: z.array(z.object({
    item: z.string().trim().min(1),
    suggestion: z.enum(['close', 'snooze']),
    why: z.string().trim().max(200),
  })).max(6).optional(),
})

const postBrief: ToolDef = {
  name: 'post_brief',
  kinds: ['lead'],
  description: () =>
    'Post the daily brief to your thread — call it exactly once per brief. Reference chats and items by their [id] (a prefix is fine) and projects by name; the activity numbers are added for you.',
  inputSchema: () => ({
    type: 'object',
    properties: {
      headline: { type: 'string', description: 'One line: the gist of the day.' },
      top3: {
        type: 'array',
        description: 'Up to 3 things for today, most important first.',
        items: {
          type: 'object',
          properties: {
            text: { type: 'string' },
            why: { type: 'string', description: 'One line: why this, ranked against Focus.' },
            chat: { type: 'string', description: 'The chat [id] it continues, if any.' },
          },
          required: ['text', 'why'],
        },
      },
      waiting_on_you: {
        type: 'array',
        description: 'Open chats that ended on a question or a step only the user can take.',
        items: {
          type: 'object',
          properties: { chat: { type: 'string', description: 'Chat [id].' }, question: { type: 'string', description: 'What it is waiting for, quoted.' } },
          required: ['chat', 'question'],
        },
      },
      focus_check: {
        type: 'object',
        properties: {
          verdict: { type: 'string', enum: ['on_plan', 'shifted', 'mixed'] },
          note: { type: 'string', description: 'Your read of the day vs. Focus, in a sentence or two.' },
          question: { type: 'string', description: 'When mixed: how you ask the user to prioritize.' },
          suggestions: {
            type: 'array',
            description: 'Focus changes to suggest (the user accepts or not).',
            items: {
              type: 'object',
              properties: {
                kind: { type: 'string', enum: ['add', 'drop'] },
                label: { type: 'string' },
                project: { type: 'string', description: 'Project name, if it maps to one.' },
                focus_item: { type: 'string', description: 'For drop: the Focus item\'s number (1 = top) or label.' },
                why: { type: 'string' },
              },
              required: ['kind', 'label', 'why'],
            },
          },
        },
        required: ['verdict', 'note'],
      },
      done: {
        type: 'array',
        description: 'What finished since the last brief (closed chats, shipped commits).',
        items: { type: 'object', properties: { text: { type: 'string' }, project: { type: 'string' } }, required: ['text'] },
      },
      clean_up: {
        type: 'array',
        description: 'Open action items that look stale or settled.',
        items: {
          type: 'object',
          properties: {
            item: { type: 'string', description: 'Action item [id].' },
            suggestion: { type: 'string', enum: ['close', 'snooze'] },
            why: { type: 'string' },
          },
          required: ['item', 'suggestion', 'why'],
        },
      },
    },
    required: ['headline', 'top3', 'focus_check'],
  }),
  async run(ctx, raw) {
    const parsed = parseArgs(PostBriefArgs, raw)
    if ('error' in parsed) return parsed.error
    const a = parsed.data
    const { storage, sessionManager } = ctx.deps
    const now = Date.now()
    const [chats, projects, items, state] = await Promise.all([
      userChats(ctx),
      storage.listProjects(),
      storage.listActionItems(),
      storage.getLeadState(),
    ])
    const projectName = (id: string) => projects.find((p) => p.id === id)?.name ?? 'Removed project'
    const chat = (ref: string) => matchChat(chats, ref)
    const unknown: string[] = []

    // One brief per run: refuse a second one since the run's prompt.
    const thread = sessionManager.getSession(ctx.session.id)?.messages ?? []
    const promptAt = thread.filter((m) => m.role === 'user').at(-1)?.timestamp ?? 0
    if (thread.some((m) => m.metadata?.kind === 'brief' && m.timestamp >= promptAt)) {
      return { text: 'The brief for this run is already posted — continue with save_memo and your reply.', isError: true }
    }

    const top3 = a.top3.map((t) => {
      const s = t.chat ? chat(t.chat) : null
      if (t.chat && !s) unknown.push(`chat "${t.chat}"`)
      return { text: t.text, why: t.why, ...(s ? { sessionId: s.id } : {}) }
    })
    const waiting = (a.waiting_on_you ?? []).flatMap((w) => {
      const s = chat(w.chat)
      if (!s) { unknown.push(`chat "${w.chat}"`); return [] }
      // The chat's own question, word for word, when it ended on one.
      const question = s.attention?.state === 'waiting_on_you' && s.attention.question ? s.attention.question : w.question
      return [{ sessionId: s.id, title: s.title, projectName: projectName(s.projectId), question }]
    })
    const suggestions = (a.focus_check.suggestions ?? []).map((sg) => {
      const p = sg.project?.trim() ? matchProject(projects, sg.project) : null
      if (sg.project?.trim() && !p) unknown.push(`project "${sg.project}"`)
      let focusItemId: string | undefined
      if (sg.kind === 'drop') {
        const ref = String(sg.focus_item ?? sg.label).trim()
        const n = /^\d+$/.test(ref) ? Number(ref) : NaN
        const item = Number.isInteger(n) ? state.focus[n - 1] : state.focus.find((f) => f.label.toLowerCase() === ref.toLowerCase())
        if (!item) unknown.push(`Focus item "${ref}"`)
        else focusItemId = item.id
      }
      return { kind: sg.kind, label: sg.label, why: sg.why, ...(p ? { projectId: p.id } : {}), ...(focusItemId ? { focusItemId } : {}) }
    })
    const done = (a.done ?? []).map((d) => {
      const p = d.project?.trim() ? matchProject(projects, d.project) : null
      if (d.project?.trim() && !p) unknown.push(`project "${d.project}"`)
      return { text: d.text, ...(p ? { projectName: p.name } : {}) }
    })
    const cleanUp = (a.clean_up ?? []).flatMap((c) => {
      const item = matchById(items.filter((i) => i.status === 'open'), c.item)
      if (!item) { unknown.push(`item "${c.item}"`); return [] }
      return [{ itemId: item.id, text: item.text, projectName: projectName(item.projectId), ageDays: Math.floor((now - item.createdAt) / 86_400_000), suggestion: c.suggestion, why: c.why }]
    })
    if (unknown.length) {
      return { text: `Not posted — no match for ${unknown.join(', ')}. Use [id]s from the digest (list_open_chats / list_action_items) and project names, then call post_brief again.`, isError: true }
    }

    const brief: Brief = {
      at: now,
      since: state.lastBriefAt ?? now - 86_400_000,
      headline: a.headline,
      top3,
      waiting,
      focusCheck: { verdict: a.focus_check.verdict, note: a.focus_check.note, ...(a.focus_check.question ? { question: a.focus_check.question } : {}), suggestions },
      done,
      cleanUp,
      activity: activityRows(chats.map((s) => ({ ...digestChat(s, now), projectName: projectName(s.projectId) }))),
    }
    sessionManager.appendCard(ctx.session.id, `Daily brief: ${a.headline}`, { kind: 'brief', brief })
    return { text: 'Brief posted. Now save_memo, then reply in 1–3 plain sentences.' }
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
  listOpenChats,
  readChat,
  searchChat,
  updateFocus,
  openProjectChat,
  postBrief,
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
