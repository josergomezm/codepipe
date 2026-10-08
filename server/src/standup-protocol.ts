/**
 * The team-output protocol: the contract between CodePipe and the CLI that
 * role-plays the personas. This module owns both sides of it — building the
 * prompt that states the contract, and parsing/validating what comes back.
 * Everything here is pure (no I/O), so it's trivially testable and the
 * contract can only drift in one file.
 *
 * The wire format is a fenced ```json block at the END of each team reply.
 * Parsing is deliberately lenient (last fence wins, bare trailing object
 * accepted) and failure is expected — callers degrade to lead attribution.
 * Bump PROTOCOL_VERSION when the contract changes shape: the version is
 * stated in the prompt, so a resumed thread carrying older instructions in
 * its CLI context is detectable rather than a silent mystery.
 */

import {
  StandupOutputSchema,
  ReviewerOutputSchema,
  type ActionItem,
  type Persona,
  type Project,
  type ReviewerOutput,
  type StandupOutput,
  type Todo,
} from './schemas.js'

export const PROTOCOL_VERSION = 5

export interface ParsedStandupTail {
  output: StandupOutput
  /** The message content with the JSON tail removed. */
  stripped: string
}

/**
 * Extract and validate the structured JSON tail from a team turn's final
 * message. Accepts a trailing ```json fenced block (preferred) or a trailing
 * bare JSON object. Returns null when no valid tail is found.
 */
export function parseStandupTail(content: string): ParsedStandupTail | null {
  // Preferred: the LAST fenced json block.
  const fenceRe = /```(?:json)?\s*\n([\s\S]*?)```/g
  let lastFence: { raw: string; start: number; end: number } | null = null
  for (let m = fenceRe.exec(content); m !== null; m = fenceRe.exec(content)) {
    lastFence = { raw: m[1], start: m.index, end: m.index + m[0].length }
  }

  if (lastFence) {
    const output = tryParseOutput(lastFence.raw)
    if (output) {
      const stripped = (content.slice(0, lastFence.start) + content.slice(lastFence.end)).trim()
      return { output, stripped }
    }
  }

  // Fallback: a bare JSON object at the very end of the message.
  const braceStart = content.lastIndexOf('\n{')
  if (braceStart >= 0) {
    const candidate = content.slice(braceStart).trim()
    const output = tryParseOutput(candidate)
    if (output) {
      return { output, stripped: content.slice(0, braceStart).trim() }
    }
  }

  return null
}

function tryParseOutput(raw: string): StandupOutput | null {
  try {
    const parsed = JSON.parse(raw)
    const result = StandupOutputSchema.safeParse(parsed)
    return result.success ? result.data : null
  } catch {
    return null
  }
}

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

function formatTrackedActions(actions: ActionItem[]): string {
  const open = actions.filter((a) => a.status === 'open')
  const resolved = actions.filter((a) => a.status === 'done')
  const declined = actions.filter((a) => a.status === 'dismissed')
  const sections: string[] = []
  if (open.length > 0) {
    sections.push(
      `Already waiting on the user — ${open.length} of at most ${MAX_OPEN_ACTIONS} (tracked — do NOT raise these again in \`user_actions\`):\n` +
        open
          .map((a) => `- [${a.id}] (${a.kind ?? 'task'}${a.blocking === false ? ', non-blocking' : ''}) ${a.text}`)
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
    'Ideas already planned (proposed/approved — not for review today). If one is ALREADY implemented in the codebase (check `git log` and the code), report it in `completed_todos`:\n' +
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
 * Parse a reviewer session's output. Lenient by design: a fenced or bare
 * JSON object is preferred; anything else becomes the take verbatim, so a
 * reviewer that ignored the format still contributes.
 */
export function parseReviewerOutput(content: string): ReviewerOutput {
  const fenceRe = /```(?:json)?\s*\n([\s\S]*?)```/g
  let lastFence: string | null = null
  for (let m = fenceRe.exec(content); m !== null; m = fenceRe.exec(content)) {
    lastFence = m[1]
  }
  for (const candidate of [lastFence, content.trim()]) {
    if (!candidate) continue
    try {
      const result = ReviewerOutputSchema.safeParse(JSON.parse(candidate))
      if (result.success) return result.data
    } catch {
      // Not JSON — fall through
    }
  }
  return { take: content.trim().slice(0, 2000) || '(no output)' }
}

/**
 * Build the standup-session turn for refining a proposal from user feedback.
 * Runs in a standup ('team') session, so the JSON protocol applies — the
 * revised proposal re-emitted with the same todoId flows through the normal
 * router and replaces the stored one.
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
    'Revise the proposal — especially the `brief`, since that is what the builder will run on. Read the codebase if needed but modify nothing. Re-emit the FULL updated proposal in `proposals` with the same todoId (summary, approach, effort, brief). Have the proposing team member reply with one short message saying what changed. End with the same ```json block as always.',
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
  } = {},
): string {
  const { memo, agenda, actions = [], planned = [] } = context
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
    `You are running today's standup for the project "${project.name}" as its AI team. The team members are:`,
    '',
    roster,
    '',
    memo ? `Your handoff note from the previous standup:\n${memo}\n` : '',
    agenda?.length
      ? `Since the last standup:\n${agenda.map((a) => `- ${a}`).join('\n')}\n`
      : '',
    formatTrackedActions(actions),
    formatPlannedTodos(planned),
    `Today's open ideas/todos from the user (with the team's independent takes where reviewed):`,
    '',
    todoList,
    '',
    `You speak for the whole team, synthesizing the takes above — where reviewers disagree, weigh the disagreement rather than smoothing it over. Investigate the codebase if you need to verify something, but this is PLANNING: read anything, modify nothing.`,
    '',
    `Then END your reply with a single fenced \`\`\`json block (nothing after it) in exactly this shape (team output protocol v${PROTOCOL_VERSION}):`,
    '',
    '```json',
    JSON.stringify(
      {
        messages: [
          {
            persona: '<your name — the lead speaks for the team>',
            kind: 'proposal | question | update',
            text: '<one short chat message to the user summarizing the standup>',
          },
        ],
        proposals: [
          {
            todoId: '<the [id] of the todo>',
            summary: '<one-line summary>',
            approach: '<how to implement it, for the user to read>',
            effort: '<rough estimate>',
            brief: '<the execution prompt — see rules below>',
            persona: '<who proposes it>',
          },
        ],
        user_actions: [
          {
            persona: '<who raised it>',
            text: '<a task or decision only the user can handle>',
            notes: '<optional: short context — why it is needed>',
            kind: 'decision | task',
            options: [
              { label: '<for decisions: a short answer the user can tap>', detail: '<one line: what it means>', recommended: true },
              { label: '<another answer>', detail: '<one line>' },
            ],
            steps: ['<for tasks: concrete numbered steps to complete it>'],
            blocking: true,
            todoId: '<the [id] of the idea this gates, when it is a prerequisite of one>',
          },
        ],
        resolved_actions: ['<[id] of a tracked user action that no longer blocks anything>'],
        completed_todos: [{ todoId: '<[id] of a planned idea that is already implemented>', evidence: '<commit hash or file that proves it>' }],
        memo: '<handoff note to your next standup: open questions, decisions made, what to revisit — a few sentences>',
      },
      null,
      2,
    ),
    '```',
    '',
    'Rules for the JSON block:',
    '- `messages` come from YOU, the lead, only — usually exactly one short summary, personal like a colleague texting. Do NOT fabricate messages from other team members: they already spoke through their independent takes, which the user sees on the board. If a reviewer\'s take contains a question the user must answer, turn it into a `user_actions` entry with kind `decision`, credited to that reviewer via `persona`.',
    '- `proposals` maps your recommendations onto the todo ids above. Only include todos you actually formed a recommendation for. `approach` is the human-readable plan; `brief` is the real deliverable of this standup: the EXACT prompt a coding agent will be handed to implement the proposal. Write the brief with everything the agent needs and nothing it doesn\'t — the goal, the specific files and docs to read first (by path, e.g. `docs/pos.md`, `src/foo.ts`), hard constraints and things NOT to touch, and a definition of done (tests to run, behavior to verify). Ground it in what you actually found in the codebase. The brief must STAND ALONE: never reference the team, the takes, this conversation, or who proposed what — the executing agent knows none of that and needs none of it.',
    '- `user_actions` are tasks ONLY the user can do and that block progress. Set `kind`: use `decision` when the user must choose or clarify something — phrase `text` as the question and give 2–4 `options` (short tappable `label`, one-line `detail`), marking your recommendation with `recommended: true`, so the user can answer in one tap; keep `notes` to brief context, not a restatement of the options. Use `task` for external setup — accounts, secrets, purchases — and then include `steps`: a concrete numbered walkthrough (console URLs, exact commands, which file to put the value in). When an action gates a specific idea (an API key its build needs), set `todoId` to that idea\'s [id] so it shows as a prerequisite on the idea\'s card. Set `blocking: false` when it is worth knowing but blocks nothing. Include them sparingly and omit the array when there are none. At most ' + MAX_OPEN_ACTIONS + ' items may wait on the user at once — new ones past that are discarded — so at the limit, raise something only if it matters more than a waiting item, and drop that item via `resolved_actions`. Only NEW blockers belong here: anything already listed as waiting on the user is tracked, and anything recently resolved is settled — build on the user\'s answer instead of re-asking.',
    '- `resolved_actions` lists the [id]s of items waiting on the user that no longer block anything — the user settled it in this conversation, or the plan changed so it is moot. Omit it when there are none.',
    '- `completed_todos` lists planned ideas you VERIFIED are already implemented (built outside this flow) — with `evidence` the user can check, like a commit hash. They move to Done. Only report what you confirmed in the code; omit it otherwise.',
    '- `memo` is your memory: the next standup starts fresh and receives ONLY this note plus the board. Record decisions made, open questions, and anything you would otherwise forget. Keep it under a paragraph.',
    '- The user may reply in this session today. In EVERY reply (including answers to their follow-ups), end with the same ```json block — usually a single message from whichever team member is answering, plus an updated `memo` if something worth remembering changed.',
  ]
    .filter(Boolean)
    .join('\n')
}
