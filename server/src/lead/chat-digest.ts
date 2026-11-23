/**
 * What the lead reads about a chat — built by code, no AI (see
 * docs/lead-assistant-plan.md, "Collect").
 *
 * A chat is read as TURNS: each message you sent plus the agent's final reply
 * to it. Tool lines, intermediate text, internal prompts and cards are noise
 * for this purpose. A 500-message chat is usually ~10 turns.
 *
 * The ending hint says how the chat stopped, from the last reply alone:
 *   waiting_on_you  — it asked you something
 *   pending_action  — built but not committed / pushed / deployed, or blocked
 *   done            — it says it shipped
 * It's a hint for the sidebar chip and the lead, never the final word.
 */
import type { ChatMessage, ChatAttention, Session } from '../schemas.js'

export interface Turn {
  /** Your message. */
  you: string
  /** The agent's final reply to it ('' when it never answered). */
  reply: string
  at: number
}

export interface ChatDigest {
  sessionId: string
  projectId: string
  title: string
  lastActivityAt: number
  turnCount: number
  /** Your messages in the last 24h / 7 days. */
  mine24: number
  mine7: number
  /** The original request: your first message. */
  firstRequest: string
  /** Where it ended: the last few turns, trimmed. */
  lastTurns: Turn[]
  attention: ChatAttention | null
}

const HOUR = 3_600_000
const DAY = 24 * HOUR
/** How much of a chat the digest keeps. */
const REQUEST_CHARS = 1500
const LAST_TURNS = 3
const YOU_CHARS = 600
const REPLY_CHARS = 1200

/** A user's chat (not a standup, build, review or lead session). */
export function isUserChat(s: { kind?: string }): boolean {
  return !s.kind || s.kind === 'chat'
}

/** Your own messages — not machine-built prompts. */
function isYours(m: ChatMessage): boolean {
  return m.role === 'user' && m.metadata?.kind !== 'prompt'
}

/** Agent prose — not deliberation transcripts or persona routing artifacts. */
function isReply(m: ChatMessage): boolean {
  return m.role === 'assistant' && m.metadata?.kind !== 'deliberation' && m.content.trim().length > 0
}

export function extractTurns(messages: ChatMessage[]): Turn[] {
  const turns: Turn[] = []
  for (const m of messages) {
    if (isYours(m)) turns.push({ you: m.content, reply: '', at: m.timestamp })
    else if (isReply(m) && turns.length) turns[turns.length - 1].reply = m.content
  }
  return turns
}

/** Trim to `max` characters on a word boundary, marking the cut. */
export function clip(text: string, max: number): string {
  const flat = text.trim()
  if (flat.length <= max) return flat
  const cut = flat.slice(0, max)
  const space = cut.lastIndexOf(' ')
  return (space > max * 0.8 ? cut.slice(0, space) : cut).trimEnd() + ' …'
}

/** Keep the END of a long reply — that's where the open question / next step is. */
export function clipEnd(text: string, max: number): string {
  const flat = text.trim()
  if (flat.length <= max) return flat
  const cut = flat.slice(flat.length - max)
  const space = cut.indexOf(' ')
  return '… ' + (space >= 0 && space < max * 0.2 ? cut.slice(space + 1) : cut).trimStart()
}

const PENDING = /\b(uncommitted|not (?:yet )?(?:pushed|committed|deployed|merged|run)|nothing (?:has been )?(?:pushed|deployed|committed)|haven['’]?t (?:run|pushed|deployed|committed|tested)|(?:needs?|need you) to (?:run|deploy|push|commit)|you(?:['’]ll| will) need to|blocked|still (?:needs?|pending)|before (?:this|it) (?:works|goes live)|once you (?:pick|decide|confirm|answer)|when you (?:deploy|push|merge|ship))\b/i
const DONE = /\b(deployed|pushed to|merged|is (?:now )?live|shipped|all done|everything is (?:in|done))\b/i

/** Code blocks and inline code can contain "?" or "deploy" without meaning it. */
function prose(text: string): string {
  return text.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`]*`/g, (m) => m.slice(1, -1))
}

/**
 * The question the reply ends on, if it ends on one: the last sentence ending
 * in "?" within its final paragraph.
 */
export function openQuestion(reply: string): string | null {
  const paragraphs = prose(reply).split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean)
  const last = paragraphs.at(-1)
  if (!last || !/\?\s*\**\s*$/.test(last)) return null
  // A sentence ends at . ! ? followed by a space — not at the dot in a file name.
  const sentences = last.replace(/\s+/g, ' ').split(/(?<=[.!?])\s+/)
  const q = [...sentences].reverse().find((s) => s.trim().endsWith('?'))
  return q ? clip(q.trim().replace(/^[*_\s]+|[*_\s]+$/g, ''), 300) : null
}

export function endingHint(reply: string): ChatAttention | null {
  if (!reply.trim()) return null
  const question = openQuestion(reply)
  if (question) return { state: 'waiting_on_you', question }
  // Only the end of the reply decides — an early "blocked" that was resolved
  // further down shouldn't count.
  const tail = prose(reply).slice(-1200)
  if (PENDING.test(tail)) return { state: 'pending_action' }
  if (DONE.test(tail)) return { state: 'done' }
  return null
}

export function digestChat(session: Session, now = Date.now()): ChatDigest {
  const turns = extractTurns(session.messages)
  const mine = session.messages.filter(isYours)
  const last = turns.at(-1)
  return {
    sessionId: session.id,
    projectId: session.projectId,
    title: session.title,
    lastActivityAt: session.updatedAt,
    turnCount: turns.length,
    mine24: mine.filter((m) => m.timestamp > now - DAY).length,
    mine7: mine.filter((m) => m.timestamp > now - 7 * DAY).length,
    firstRequest: clip(turns[0]?.you ?? '', REQUEST_CHARS),
    // When the first turn is among the last ones, its message is already
    // firstRequest — keep its reply, don't repeat the request.
    lastTurns: turns.slice(-LAST_TURNS).map((t) => ({
      you: t === turns[0] ? '(the original request, above)' : clip(t.you, YOU_CHARS),
      reply: clipEnd(t.reply, REPLY_CHARS),
      at: t.at,
    })),
    attention: last ? endingHint(last.reply) : null,
  }
}
