/**
 * The team protocol: what CodePipe tells the CLI that role-plays the
 * personas, and the pure helpers around it. This module builds the prompts
 * (standup, reviewer, refine, implement) and parses reviewer takes; the team
 * acts through CodePipe's tools (agent-tool-registry.ts), whose names these
 * prompts refer to.
 *
 * Everything here is pure (no I/O), so it's trivially testable. Bump
 * PROTOCOL_VERSION when the contract changes shape: the version is stated
 * in the prompt, so a thread carrying older instructions is recognizable.
 */

import {
  ReviewerOutputSchema,
  type ActionItem,
  type Persona,
  type Project,
  type ReviewerOutput,
  type Todo,
} from './schemas.js'
import { localDay } from './dates.js'

export const PROTOCOL_VERSION = 7

/** Resolve a persona reference (id or name, case-insensitive). */
export function matchPersona(personas: Persona[], ref: string): Persona | null {
  const needle = ref.trim().toLowerCase()
  return (
    personas.find((p) => p.id.toLowerCase() === needle) ??
    personas.find((p) => p.name.toLowerCase() === needle) ??
    null
  )
}

/** Resolve an id reference (full id, or an unambiguous id prefix). */
export function matchById<T extends { id: string }>(items: T[], ref: string): T | null {
  const needle = ref.trim().toLowerCase()
  if (!needle) return null
  const exact = items.find((t) => t.id.toLowerCase() === needle)
  if (exact) return exact
  const prefixed = items.filter((t) => t.id.toLowerCase().startsWith(needle))
  return prefixed.length === 1 ? prefixed[0] : null
}

/** Resolve a todo reference (full id, or an unambiguous id prefix). */
export function matchTodo(todos: Todo[], ref: string): Todo | null {
  return matchById(todos, ref)
}

/** How long a resolved action item stays in the team's view (and dedup set). */
export const RESOLVED_ACTION_WINDOW_MS = 14 * 24 * 60 * 60 * 1000

/**
 * The action items the team should know about: everything still open, plus
 * recently resolved ones (with the user's answer) — so a fresh standup
 * neither re-raises what is already tracked nor re-asks what was answered.
 */
export function trackedActions(items: ActionItem[], now = Date.now()): ActionItem[] {
  return items.filter(
    (a) => a.status === 'open' || now - a.updatedAt <= RESOLVED_ACTION_WINDOW_MS,
  )
}

/**
 * Most items a project may have waiting on the user at once. A short queue
 * gets answered; a long one gets avoided. Stated in the prompt, and enforced
 * when routing (new items past the cap are not recorded).
 */
export const MAX_OPEN_ACTIONS = 4

/** ", due 2026-10-14 (overdue)" — the deadline as the team should weigh it. */
function formatDue(item: ActionItem, today: string): string {
  if (!item.dueDate) return ''
  const when = item.dueDate < today ? ' (overdue)' : item.dueDate === today ? ' (today)' : ''
  return `, due ${item.dueDate}${when}`
}

function formatTrackedActions(actions: ActionItem[], today: string): string {
  const open = actions.filter((a) => a.status === 'open')
  const resolved = actions.filter((a) => a.status === 'done')
  const declined = actions.filter((a) => a.status === 'dismissed')
  const sections: string[] = []
  if (open.length > 0) {
    sections.push(
      `Already waiting on the user — ${open.length} of at most ${MAX_OPEN_ACTIONS} (tracked — do NOT raise these again with \`add_action_item\`):\n` +
        open
          .map(
            (a) =>
              `- [${a.id}] (${a.kind ?? 'task'}${a.blocking === false ? ', non-blocking' : ''}${formatDue(a, today)}) ${a.text}`,
          )
          .join('\n'),
    )
  }
  if (resolved.length > 0) {
    sections.push(
      'Recently resolved by the user (do not ask again):\n' +
        resolved
          .map((a) => `- ${a.text}${a.resolution ? `\n  The user's answer: ${a.resolution}` : ''}`)
          .join('\n'),
    )
  }
  if (declined.length > 0) {
    sections.push(
      'Declined by the user (won\'t do — never raise these again):\n' +
        declined
          .map((a) => `- ${a.text}${a.resolution ? `\n  Their reason: ${a.resolution}` : ''}`)
          .join('\n'),
    )
  }
  return sections.length > 0 ? sections.join('\n\n') + '\n' : ''
}

/** Ideas already planned — the lead checks whether any shipped outside CodePipe. */
function formatPlannedTodos(planned: Todo[]): string {
  if (planned.length === 0) return ''
  return (
    'Ideas already planned (proposed/approved — not for review today). If one is ALREADY implemented in the codebase (check `git log` and the code), report it with `complete_idea`:\n' +
    planned.map((t) => `- [${t.id}] (${t.status}) ${t.text}`).join('\n') +
    '\n'
  )
}

/** Canonical form of an action item's text, for duplicate detection. */
export function normalizeActionText(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, ' ')
}

/**
 * Build a reviewer session's prompt. Each reviewer runs in a FRESH context —
 * independence is the point: their take is unbiased by the other reviewers.
 * Output is a small JSON object, parsed leniently (raw text degrades to the
 * take itself, never lost).
 */
export function buildReviewerPrompt(
  project: Project,
  reviewer: Persona,
  todo: Todo,
): string {
  return [
    `You are ${reviewer.name}, ${reviewer.role} on the "${project.name}" team. ${reviewer.personality}`,
    '',
    'The user added this idea to the project board:',
    '',
    `"${todo.text}"`,
    todo.notes ? `Context from the user: ${todo.notes}` : '',
    '',
    'Investigate the codebase as needed to ground your review in reality — but this is a REVIEW: read anything, modify NOTHING. Do not create, edit, or delete any files.',
    '',
    'Then reply with ONLY a ```json block in this shape:',
    '',
    '```json',
    JSON.stringify(
      {
        take: '<your single most important point about this idea, from your role\'s perspective — one short paragraph>',
        concerns: ['<optional: specific concerns, each one sentence>'],
        effort: '<optional: rough estimate, only if you can ground it>',
      },
      null,
      2,
    ),
    '```',
    '',
    'One point, chosen well — the team lead synthesizes everyone\'s takes afterward. If the idea is outside your lens, say so briefly in `take` and stop.',
  ]
    .filter(Boolean)
    .join('\n')
}

/**
 * Parse a reviewer session's output. Lenient by design, in order:
 *   1. the last fenced ```json block;
 *   2. the last balanced JSON object anywhere in the text — some CLIs strip
 *      the fence when rendering, leaving prose, a bare `json` line, then
 *      the object;
 *   3. fields salvaged from a broken/truncated object (complete `take`,
 *      `concerns` entries, `effort` string literals);
 *   4. the raw text as the take, so a reviewer that ignored the format
 *      still contributes.
 */
export function parseReviewerOutput(content: string): ReviewerOutput {
  const fenceRe = /```(?:json)?\s*\n([\s\S]*?)```/g
  let lastFence: string | null = null
  for (let m = fenceRe.exec(content); m !== null; m = fenceRe.exec(content)) {
    lastFence = m[1]
  }
  if (lastFence) {
    const fenced = validReviewerOutput(lastFence)
    if (fenced) return fenced
  }

  // Try an object at every `{` (a stray brace in the prose must not hide
  // the real one), keeping the last that validates. Reviewer replies are a
  // few KB, so the quadratic worst case doesn't matter.
  let found: ReviewerOutput | null = null
  for (let i = content.indexOf('{'); i !== -1; i = content.indexOf('{', i + 1)) {
    const candidate = balancedObjectAt(content, i)
    if (candidate) found = validReviewerOutput(candidate) ?? found
  }
  if (found) return found

  return salvageReviewerFields(content) ?? { take: content.trim().slice(0, 2000) || '(no output)' }
}

function validReviewerOutput(raw: string): ReviewerOutput | null {
  try {
    const result = ReviewerOutputSchema.safeParse(JSON.parse(raw))
    return result.success ? result.data : null
  } catch {
    return null
  }
}

/**
 * The balanced `{…}` span starting at `start`, or null if it never closes
 * (truncated output). String-aware, so braces inside JSON strings don't
 * end it early.
 */
function balancedObjectAt(text: string, start: number): string | null {
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
    } else if (ch === '"') inString = true
    else if (ch === '{') depth++
    else if (ch === '}' && --depth === 0) return text.slice(start, i + 1)
  }
  return null
}

/** A complete JSON string literal, e.g. `"a \"quoted\" word"`. */
const JSON_STRING = /"(?:[^"\\]|\\.)*"/

/**
 * Recover the fields a broken or truncated reviewer object still holds in
 * full. Null when there is no complete `take` — then the raw text is the
 * better fallback.
 */
function salvageReviewerFields(text: string): ReviewerOutput | null {
  const field = (name: string): string | undefined => {
    const m = new RegExp(`"${name}"\\s*:\\s*(${JSON_STRING.source})`).exec(text)
    if (!m) return undefined
    try {
      return JSON.parse(m[1]) as string
    } catch {
      return undefined
    }
  }
  const take = field('take')?.trim()
  if (!take) return null

  // Complete string entries of `concerns`, up to its `]` or the cut-off.
  const concerns: string[] = []
  const list = /"concerns"\s*:\s*\[/.exec(text)
  if (list) {
    const entryRe = new RegExp(`\\s*,?\\s*(${JSON_STRING.source})`, 'y')
    entryRe.lastIndex = list.index + list[0].length
    for (let m = entryRe.exec(text); m !== null; m = entryRe.exec(text)) {
      try {
        const entry = (JSON.parse(m[1]) as string).trim()
        if (entry) concerns.push(entry)
      } catch {
        break
      }
    }
  }
  const effort = field('effort')?.trim()

  return {
    take,
    ...(concerns.length ? { concerns } : {}),
    ...(effort ? { effort } : {}),
  }
}

/**
 * Build the standup-session turn for refining a proposal from user feedback.
 * Runs in a standup ('team') session: the team re-saves the revised
 * proposal with `propose_plan` on the same idea, replacing the stored one.
 */
export function buildRefinePrompt(todo: Todo, personas: Persona[], feedback: string): string {
  const proposal = todo.proposal
  return [
    `The user reviewed your team's proposal for the idea [${todo.id}] "${todo.text}" and wants changes before building.`,
    '',
    proposal ? `Current proposal: ${proposal.summary}` : '',
    proposal ? `Current approach: ${proposal.approach}` : '',
    proposal?.brief ? `Current brief:\n${proposal.brief}` : '',
    formatTakes(todo, personas),
    '',
    `The user's feedback:`,
    feedback,
    '',
    `Revise the proposal — especially the \`brief\`, since that is what the builder will run on. Read the codebase if needed but modify nothing. Save the FULL updated proposal with \`propose_plan\` on idea [${todo.id}] (summary, approach, effort, brief) — it replaces the current one. Then reply with one short message saying what changed.`,
  ]
    .filter(Boolean)
    .join('\n')
}

/** Render an idea's reviewer takes for a synthesis or refine prompt. */
function formatTakes(todo: Todo, personas: Persona[]): string {
  if (!todo.takes?.length) return ''
  const lines = todo.takes.map((t) => {
    const who = personas.find((p) => p.id === t.personaId)
    const concerns = t.concerns?.length ? ` Concerns: ${t.concerns.join(' / ')}` : ''
    const effort = t.effort ? ` Effort: ${t.effort}.` : ''
    return `  - ${who?.name ?? 'Reviewer'}: ${t.take}${concerns}${effort}`
  })
  return `Team takes on this idea (each formed independently):\n${lines.join('\n')}`
}

/**
 * Build the prompt for an implementation ('work') session. Deliberately
 * team-free: the executing CLI gets the tuned brief and neutral guardrails,
 * nothing else — persona lore is attribution for the USER (session title,
 * card), never context for the executor, where it would only distract.
 */
export function buildImplementPrompt(
  _project: Project,
  _implementer: Persona,
  todo: Todo,
): string {
  const proposal = todo.proposal
  // The brief IS the tuned execution prompt the review produced — when
  // present it supersedes everything else. Fallbacks keep pre-brief
  // proposals and bare ideas buildable.
  const task = proposal?.brief
    ? proposal.brief
    : [
        `Task: ${todo.text}`,
        todo.notes ? `Context: ${todo.notes}` : '',
        proposal ? `Planned approach: ${proposal.approach}` : '',
      ]
        .filter(Boolean)
        .join('\n')

  return [
    task,
    '',
    'Guidelines:',
    '- Work in this repository, matching its existing conventions; run its tests/typechecks if it has them.',
    '- Follow the plan above unless the code proves it wrong; if you deviate, say why.',
    '- If something genuinely needs the user\'s decision, stop and ask — this is a chat, they can reply.',
    '- Finish with a short summary of what you changed (files touched, anything left open).',
  ].join('\n')
}

/**
 * Build the standup synthesis prompt. The reviewers have already spoken
 * (independently — their takes ride on each todo); this turn is the lead
 * digesting takes + agenda + memo into the run's output: messages to the
 * user, proposals with execution briefs, typed user actions, and the next
 * memo. Runs in the dated standup session the user can watch and reply to.
 */
export function buildStandupPrompt(
  project: Project,
  personas: Persona[],
  todos: Todo[],
  context: {
    /** The team's handoff note from the previous standup. */
    memo?: string
    /** Events since the last standup. */
    agenda?: string[]
    /** Tracked action items (see trackedActions). */
    actions?: ActionItem[]
    /** Proposed/approved ideas, checked for having already shipped. */
    planned?: Todo[]
    /** Today's date (YYYY-MM-DD), for weighing deadlines. Defaults to the local day. */
    today?: string
  } = {},
): string {
  const { memo, agenda, actions = [], planned = [], today = localDay(new Date()) } = context
  const roster = personas
    .map(
      (p) =>
        `- ${p.name}${p.isLead ? ' (team lead)' : ''} — ${p.role}. ${p.personality}`.trim(),
    )
    .join('\n')

  const todoList =
    todos.length > 0
      ? todos
          .map((t) =>
            [
              `- [${t.id}] ${t.text}${t.notes ? `\n  Notes: ${t.notes}` : ''}`,
              formatTakes(t, personas).replace(/^/gm, '  '),
            ]
              .filter((s) => s.trim())
              .join('\n'),
          )
          .join('\n')
      : '(none — review the project itself and suggest improvements)'

  return [
    `You are running today's standup (${today}) for the project "${project.name}" as its AI team. The team members are:`,
    '',
    roster,
    '',
    memo ? `Your handoff note from the previous standup:\n${memo}\n` : '',
    agenda?.length
      ? `Since the last standup:\n${agenda.map((a) => `- ${a}`).join('\n')}\n`
      : '',
    formatTrackedActions(actions, today),
    formatPlannedTodos(planned),
    `Today's open ideas/todos from the user (with the team's independent takes where reviewed):`,
    '',
    todoList,
    '',
    `You speak for the whole team, synthesizing the takes above — where reviewers disagree, weigh the disagreement rather than smoothing it over. Investigate the codebase if you need to verify something, but this is PLANNING: read anything, modify nothing.`,
    '',
    `Record the outcome with CodePipe's tools (team protocol v${PROTOCOL_VERSION}). They are the ONLY way anything you decide reaches the user's board — text alone changes nothing:`,
    '',
    '- `propose_plan` — once per idea you formed a recommendation for, using its [id]. `approach` is the human-readable plan; `brief` is the real deliverable of this standup: the EXACT prompt a coding agent will be handed to implement it. Write the brief with everything the agent needs and nothing it doesn\'t — the goal, the specific files and docs to read first (by path, e.g. `docs/pos.md`, `src/foo.ts`), hard constraints and things NOT to touch, and a definition of done (tests to run, behavior to verify). Ground it in what you actually found in the codebase. The brief must STAND ALONE: never reference the team, the takes, this conversation, or who proposed what. Credit the proposer with `persona` — they will build it.',
    '- `add_action_item` — ONLY for things only the user can do that block progress. Use kind `decision` when the user must choose or clarify something: phrase `text` as the question and give 2–4 `options` (short tappable `label`, one-line `detail`), marking your recommendation, so the user can answer in one tap; keep `notes` to brief context. Use kind `task` for external setup — accounts, secrets, purchases — with `steps`: a concrete walkthrough (console URLs, exact commands, which file to put the value in). Set `todo_id` when it gates a specific idea, `blocking: false` when it blocks nothing, and `due_date` ONLY for a real external deadline you found in the code, docs or conversation (an expiring key, a date the user named) — never an invented target. If a reviewer\'s take holds a question only the user can answer, raise it here as a decision credited to that reviewer via `persona`. At most ' + MAX_OPEN_ACTIONS + ' items may wait on the user at once: at the limit, raise something only if it matters more than a waiting item, and close that item first. Never re-raise what is already waiting or recently settled — build on the user\'s answer instead. Deadlines on tracked items are the user\'s: weigh overdue ones, but don\'t re-raise an item to change its date.',
    '- `resolve_action_item` — close a waiting team item that no longer blocks anything (settled in conversation, or moot after a plan change).',
    '- `complete_idea` — a planned idea you VERIFIED is already implemented, with `evidence` the user can check (a commit hash, a file). Only what you confirmed in the code.',
    '- `save_memo` — ALWAYS, once, after everything else: your handoff note. The next standup starts fresh and receives ONLY this note plus the board — record decisions made, open questions, and anything you would otherwise forget. Under a paragraph.',
    '- `list_action_items` / `add_idea` are there if you need them.',
    '',
    'Then finish with your message to the user — that final reply is what they read, and get notified with. Make it one short summary from you, the lead, personal like a colleague texting. Don\'t write messages for other team members: they already spoke through their takes, which the user sees on the board.',
    '',
    'The user may reply in this session today. Answer as the team, and use the same tools whenever something changes: a revised proposal, an item settled, a memo worth updating.',
  ]
    .filter(Boolean)
    .join('\n')
}
