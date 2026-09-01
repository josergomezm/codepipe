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
  type ChatMessage,
  type Persona,
  type Project,
  type StandupOutput,
  type Todo,
} from './schemas.js'

export const PROTOCOL_VERSION = 1

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

/** Resolve a todo reference (full id, or an unambiguous id prefix). */
export function matchTodo(todos: Todo[], ref: string): Todo | null {
  const needle = ref.trim().toLowerCase()
  const exact = todos.find((t) => t.id.toLowerCase() === needle)
  if (exact) return exact
  const prefixed = todos.filter((t) => t.id.toLowerCase().startsWith(needle))
  return prefixed.length === 1 ? prefixed[0] : null
}

/** Canonical form of an action item's text, for duplicate detection. */
export function normalizeActionText(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, ' ')
}

/**
 * Build the prompt for an implementation ('work') session. Work sessions are
 * ordinary chats — no JSON protocol — because their output is code and a
 * human-readable summary, not routed persona messages.
 */
export function buildImplementPrompt(
  project: Project,
  implementer: Persona,
  todo: Todo,
): string {
  const proposal = todo.proposal
  return [
    `You are ${implementer.name}, ${implementer.role} on the "${project.name}" team. ${implementer.personality}`,
    '',
    'The user approved your team\'s proposal — implement it now, in this repository.',
    '',
    `The idea: ${todo.text}`,
    todo.notes ? `Context from the user: ${todo.notes}` : '',
    proposal ? `The approved proposal: ${proposal.summary}` : '',
    proposal ? `Planned approach: ${proposal.approach}` : '',
    proposal?.effort ? `Estimated effort: ${proposal.effort}` : '',
    '',
    'Guidelines:',
    '- Follow the planned approach unless the code proves it wrong; if you deviate, say why.',
    '- Match the project\'s existing conventions, and run its tests/typechecks if it has them.',
    '- If something genuinely needs the user\'s decision, stop and ask — this is a chat, they can reply.',
    '- Finish with a short summary of what you changed (files touched, anything left open).',
  ]
    .filter(Boolean)
    .join('\n')
}

/**
 * Build the team-thread ping announcing a finished implementation. This runs
 * in the TEAM session, so the normal JSON protocol applies.
 */
export function buildWorkCompletePrompt(
  implementer: Persona,
  todo: Todo,
  resultMessage: ChatMessage | null,
): string {
  const summary = resultMessage
    ? resultMessage.content.slice(0, 1500)
    : '(the work session produced no summary)'
  return [
    `${implementer.name} just finished implementing the approved idea "${todo.text}" in a separate work session. Their closing summary:`,
    '',
    summary,
    '',
    `Announce the completion to the user as ${implementer.name} — one short message: what shipped and anything the user should look at. The idea has been moved to Done on their board. End with the same \`\`\`json block as always.`,
  ].join('\n')
}

/** Build the standup prompt: roster, todos, and the output contract. */
export function buildStandupPrompt(
  project: Project,
  personas: Persona[],
  todos: Todo[],
): string {
  const roster = personas
    .map(
      (p) =>
        `- ${p.name}${p.isLead ? ' (team lead)' : ''} — ${p.role}. ${p.personality}`.trim(),
    )
    .join('\n')

  const todoList =
    todos.length > 0
      ? todos
          .map((t) => `- [${t.id}] ${t.text}${t.notes ? `\n  Notes: ${t.notes}` : ''}`)
          .join('\n')
      : '(none — review the project itself and suggest improvements)'

  return [
    `You are running the daily standup for the project "${project.name}" as its AI team. The team members are:`,
    '',
    roster,
    '',
    `Today's open ideas/todos from the user:`,
    '',
    todoList,
    '',
    'Deliberate as the team: have each relevant member weigh in from their role, disagree where warranted, and converge on concrete recommendations. Investigate the codebase as needed to ground the discussion in reality.',
    '',
    `Then END your reply with a single fenced \`\`\`json block (nothing after it) in exactly this shape (team output protocol v${PROTOCOL_VERSION}):`,
    '',
    '```json',
    JSON.stringify(
      {
        messages: [
          {
            persona: '<team member name>',
            kind: 'proposal | question | update',
            text: '<a short chat message to the user, written in that persona\'s voice>',
          },
        ],
        proposals: [
          {
            todoId: '<the [id] of the todo>',
            summary: '<one-line summary>',
            approach: '<how to implement it>',
            effort: '<rough estimate>',
            persona: '<who proposes it>',
          },
        ],
        user_actions: [
          {
            persona: '<who raised it>',
            text: '<a task only the user can do>',
            notes: '<optional: why it is needed / how to do it>',
          },
        ],
      },
      null,
      2,
    ),
    '```',
    '',
    'Rules for the JSON block:',
    '- `messages` is what the user actually receives on their phone — keep each one short and personal, like a colleague texting them. The lead summarizes; other members may add a message only when they have a genuine question or point of their own.',
    '- `proposals` maps your recommendations onto the todo ids above. Only include todos you actually formed a recommendation for.',
    '- `user_actions` are tasks ONLY the user can do and that block progress: creating accounts, adding secrets or API keys, making purchases, approving external services, or decisions that are theirs to make. Include them sparingly — only genuine blockers — and omit the array when there are none.',
    '- This conversation is persistent. In EVERY future reply in this session (including answers to the user\'s follow-up messages), end with the same ```json block — usually with a single message from whichever team member is answering.',
  ].join('\n')
}
