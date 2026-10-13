/**
 * The one way an action item gets recorded — from a standup's
 * `user_actions`, the CodePipe MCP tool in any chat, a chat card the user
 * accepted, or the manual form. Owning it in one place keeps duplicate
 * detection, the team's queue cap and the field caps identical everywhere.
 */

import type { IStorageLayer } from './storage.js'
import type { ActionDraft, ActionItem } from './schemas.js'
import { MAX_OPEN_ACTIONS, normalizeActionText, trackedActions } from './standup-protocol.js'

export interface RecordActionInput extends ActionDraft {
  /** The idea this item gates (standups only). */
  todoId?: string
  /** Persona who raised it — team-raised items are deduped harder and capped. */
  personaId?: string
}

export type RecordActionResult =
  | { status: 'added'; item: ActionItem }
  /** Already tracked — `item` is the existing one. */
  | { status: 'duplicate'; item: ActionItem }
  /** The team's queue is full (team-raised items only). */
  | { status: 'over_cap' }

/** Same text gating the same idea = the same item. */
function dedupKey(text: string, todoId: string | undefined): string {
  return `${todoId ?? ''}:${normalizeActionText(text)}`
}

/** The item already covering `input`, if any (see recordActionItem). */
export function findDuplicateAction(
  existing: ActionItem[],
  input: Pick<RecordActionInput, 'text' | 'todoId' | 'personaId'>,
  now = Date.now(),
): ActionItem | null {
  // The team must not re-raise what the user just answered or declined, so
  // its items dedup against recently closed ones too. The user asking again
  // means it again: theirs only dedup against what's still open.
  const pool = input.personaId
    ? trackedActions(existing, now)
    : existing.filter((a) => a.status === 'open')
  const key = dedupKey(input.text, input.todoId)
  return pool.find((a) => dedupKey(a.text, a.todoId) === key) ?? null
}

/**
 * Record an action item for a project unless it is already tracked. Team-
 * raised items (with a persona) also respect the open-item cap — the team
 * was told the limit, so past it new items are dropped rather than queued.
 */
export async function recordActionItem(
  storage: IStorageLayer,
  projectId: string,
  input: RecordActionInput,
): Promise<RecordActionResult> {
  const text = input.text.trim()
  const existing = await storage.listActionItems(projectId)

  const duplicate = findDuplicateAction(existing, { ...input, text })
  if (duplicate) return { status: 'duplicate', item: duplicate }

  if (input.personaId) {
    const open = trackedActions(existing).filter((a) => a.status === 'open' && a.personaId).length
    if (open >= MAX_OPEN_ACTIONS) return { status: 'over_cap' }
  }

  // Trim to the schema's caps rather than dropping the whole item — standup
  // output is parsed leniently, so its fields arrive unbounded.
  const options = input.options?.slice(0, 6).map((o) => ({
    label: o.label.slice(0, 200),
    ...(o.detail ? { detail: o.detail.slice(0, 1000) } : {}),
    ...(o.recommended ? { recommended: true } : {}),
  }))
  const item = await storage.addActionItem({
    projectId,
    text: text.slice(0, 2000),
    ...(input.notes?.trim() ? { notes: input.notes.trim().slice(0, 10000) } : {}),
    ...(input.kind ? { kind: input.kind } : {}),
    ...(input.steps?.length ? { steps: input.steps.slice(0, 12).map((s) => s.slice(0, 1000)) } : {}),
    ...(options?.length ? { options } : {}),
    ...(input.blocking === false ? { blocking: false } : {}),
    ...(input.dueDate ? { dueDate: input.dueDate } : {}),
    ...(input.todoId ? { todoId: input.todoId } : {}),
    ...(input.personaId ? { personaId: input.personaId } : {}),
  })
  return { status: 'added', item }
}
