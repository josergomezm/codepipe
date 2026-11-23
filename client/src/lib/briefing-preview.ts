/**
 * PREVIEW ONLY — the lead's daily brief, with no backend.
 *
 * The daily question: what did you work on in the last 24 hours, against
 * your Focus list, the board and your action items? Inputs are real (your
 * chats from the last 24h and their last messages, action items, ideas).
 * The brief itself is a SAMPLE assembled here with simple rules, standing in
 * for what the lead's CLI would write. Focus lives in localStorage. Nothing
 * is sent to the server.
 */
import * as api from '@/api/client'
import type { ActionItem, ChatMessage, Persona, Project, SessionMeta, Todo } from '@/api/client'
import { getCachedMessages } from '@/lib/cache'

const HOUR = 3_600_000
const DAY = 24 * HOUR
/** The brief covers this window ("since yesterday's brief"). */
export const WINDOW_HOURS = 24

export interface FocusItem {
  id: string
  label: string
  /** Project it maps to, for matching against activity (optional). */
  projectId?: string
}

export interface OpenConversation {
  session: SessionMeta
  projectName: string
  lastUser: string
  lastAgent: string
  /** Your messages in the last 24 hours. */
  mine24: number
  /** …and in the last 7 days, for telling a blip from a shift. */
  mine7: number
}

export interface ActivityRow {
  projectId: string
  projectName: string
  mine24: number
  mine7: number
  /** Share of your last-24h messages. */
  share24: number
  inFocus: boolean
}

export interface BriefingInputs {
  /** Chats you touched in the window. */
  conversations: OpenConversation[]
  openActions: ActionItem[]
  proposedIdeas: Todo[]
  inboxIdeas: Todo[]
}

export interface SampleBriefing {
  at: number
  headline: string
  top3: { text: string; why: string; sessionId?: string }[]
  activity: ActivityRow[]
  driftNote: string | null
  moved: { sessionId: string; title: string; projectName: string; summary: string }[]
  stale: { item: ActionItem; projectName: string; ageDays: number }[]
  staleIdeas: number
  proposedActions: { id: string; text: string; bucket: string; why: string }[]
  focusSuggestions: { id: string; kind: 'add' | 'drop'; label: string; projectId?: string; why: string }[]
  deliberation: { personaId: string; text: string }[]
}

// --- Focus (localStorage) --------------------------------------------------

const FOCUS_KEY = 'codepipe:preview:focus'

export function loadFocus(projects: Project[]): FocusItem[] {
  try {
    const raw = localStorage.getItem(FOCUS_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : null
    const isItem = (x: unknown): x is FocusItem =>
      !!x && typeof (x as FocusItem).id === 'string' && typeof (x as FocusItem).label === 'string'
    if (Array.isArray(parsed) && parsed.every(isItem)) return parsed
  } catch { /* fall through to the sample */ }
  // Sample starting point: the products with the most ideas on the board,
  // which is roughly what the team has been working from.
  const pick = (name: string) => projects.find((p) => p.name === name)
  return [pick('Dirumed App'), pick('Teremu App')]
    .filter((p): p is Project => !!p)
    .map((p) => ({ id: crypto.randomUUID(), label: p.name.replace(/ App$/, '') + ' — ship next release', projectId: p.id }))
}

export function saveFocus(items: FocusItem[]): void {
  try { localStorage.setItem(FOCUS_KEY, JSON.stringify(items)) } catch { /* preview */ }
}

// --- Inputs (real) ---------------------------------------------------------

function excerpt(text: string, max = 220): string {
  const flat = text.replace(/```[\s\S]*?```/g, ' [code] ').replace(/[#*_`>|]/g, '').replace(/\s+/g, ' ').trim()
  return flat.length > max ? flat.slice(0, max - 1).trimEnd() + '…' : flat
}

function firstSentence(text: string, max = 170): string {
  const flat = excerpt(text, 600)
  const m = /^(.{20,}?[.!?])\s/.exec(flat)
  return excerpt(m ? m[1] : flat, max)
}

/**
 * A chat's messages: the local copy when it's current, else the server's.
 * The local copy is only refreshed while a chat is open, so one that moved
 * in the background would otherwise show an old ending and old counts.
 */
async function transcript(session: SessionMeta): Promise<ChatMessage[]> {
  const cached = await getCachedMessages(session.id)
  const cachedUpTo = cached?.at(-1)?.timestamp ?? 0
  if (cached?.length && cachedUpTo >= session.updatedAt) return cached
  try { return (await api.fetchSession(session.id)).messages } catch { return cached ?? [] }
}

function projectNamer(projects: Project[]): (id: string) => string {
  return (id) => projects.find((p) => p.id === id)?.name ?? 'Unknown project'
}

export async function loadInputs(
  sessions: SessionMeta[],
  projects: Project[],
  actions: ActionItem[],
  todos: Todo[],
  now = Date.now(),
): Promise<BriefingInputs> {
  const name = projectNamer(projects)
  const since = now - WINDOW_HOURS * HOUR
  const touched = sessions
    .filter((s) => !s.kind && s.updatedAt > since)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 20)

  const conversations = (await Promise.all(touched.map(async (session) => {
    const msgs = await transcript(session)
    const mine = msgs.filter((m) => m.role === 'user' && m.metadata?.kind !== 'prompt')
    const lastUser = mine.at(-1)?.content ?? ''
    const lastAgent = msgs.filter((m) => m.role === 'assistant' && m.metadata?.kind !== 'deliberation').at(-1)?.content ?? ''
    return {
      session,
      projectName: name(session.projectId),
      lastUser: excerpt(lastUser),
      lastAgent: excerpt(lastAgent, 320),
      mine24: mine.filter((m) => m.timestamp > since).length,
      mine7: mine.filter((m) => m.timestamp > now - 7 * DAY).length,
    }
  })))
    // Touched by an agent turn alone (no message from you) still counts as
    // movement, but sort your own work first.
    .sort((a, b) => b.mine24 - a.mine24 || b.session.updatedAt - a.session.updatedAt)

  return {
    conversations,
    openActions: actions.filter((a) => a.status === 'open'),
    proposedIdeas: todos.filter((t) => t.status === 'proposed'),
    inboxIdeas: todos.filter((t) => t.status === 'inbox'),
  }
}

// --- Sample brief (rules standing in for the lead) -------------------------

export function buildSampleBriefing(
  inputs: BriefingInputs,
  focus: FocusItem[],
  projects: Project[],
  personas: Persona[],
  now = Date.now(),
): SampleBriefing {
  const name = projectNamer(projects)
  const short = (n: string) => n.replace(/ \[ROOT\]$/, '')
  const focusProjects = new Set(focus.map((f) => f.projectId).filter(Boolean))

  // Activity per project, from your own messages in the last 24h.
  const byProject = new Map<string, ActivityRow>()
  for (const c of inputs.conversations) {
    const row = byProject.get(c.session.projectId) ?? {
      projectId: c.session.projectId, projectName: c.projectName, mine24: 0, mine7: 0, share24: 0,
      inFocus: focusProjects.has(c.session.projectId),
    }
    row.mine24 += c.mine24
    row.mine7 += c.mine7
    byProject.set(c.session.projectId, row)
  }
  const activity = [...byProject.values()].filter((r) => r.mine24 > 0).sort((a, b) => b.mine24 - a.mine24)
  const total24 = activity.reduce((n, r) => n + r.mine24, 0)
  for (const r of activity) r.share24 = total24 ? r.mine24 / total24 : 0

  const offFocus = activity.filter((r) => !r.inFocus && r.share24 >= 0.25)
  const quietFocus = focus.filter((f) => f.projectId && (byProject.get(f.projectId)?.mine24 ?? 0) === 0)
  const offShare = offFocus.reduce((n, r) => n + r.share24, 0)
  // A shift, not a blip: the off-focus work also dominated the week.
  const sustained = offFocus.some((r) => r.mine7 >= 3 * Math.max(1, r.mine24) || r.mine7 >= 10)
  const driftNote = offFocus.length
    ? `${Math.round(offShare * 100)}% of what you sent in the last 24 hours went to ${offFocus.map((r) => r.projectName).join(' and ')} — not on your Focus list${quietFocus.length ? `, while ${quietFocus.map((f) => f.label).join(' and ')} got nothing` : ''}. ${sustained ? 'It was the same most of the week, so this looks like a real shift, not a one-off. Update Focus?' : 'First day like this — I\'ll watch whether it sticks.'}`
    : null

  const moved = inputs.conversations
    .filter((c) => c.lastAgent)
    .slice(0, 6)
    .map((c) => ({ sessionId: c.session.id, title: c.session.title, projectName: c.projectName, summary: firstSentence(c.lastAgent) }))

  const stale = inputs.openActions
    .map((item) => ({ item, projectName: name(item.projectId), ageDays: Math.floor((now - item.createdAt) / DAY) }))
    .filter((s) => s.ageDays >= 21)
    .sort((a, b) => b.ageDays - a.ageDays)
    .slice(0, 4)

  const hottest = activity[0]
  const hotConv = hottest && inputs.conversations.find((c) => c.session.projectId === hottest.projectId)
  const blocking = inputs.openActions.find((a) => a.blocking !== false && a.kind === 'decision') ?? inputs.openActions[0]
  const top3: SampleBriefing['top3'] = []
  if (hotConv) top3.push({ text: `Pick up “${hotConv.session.title}” where you left it`, why: `Most of yesterday went here (${hottest!.mine24} messages in ${hottest!.projectName}).`, sessionId: hotConv.session.id })
  if (blocking) top3.push({ text: blocking.text.length > 110 ? blocking.text.slice(0, 109) + '…' : blocking.text, why: `Open ${Math.floor((now - blocking.createdAt) / DAY)} days in ${name(blocking.projectId)} — it blocks the team.` })
  if (inputs.proposedIdeas.length) top3.push({ text: `Triage ${inputs.proposedIdeas.length} proposals on the board`, why: 'They are waiting on you; approve, park, or drop — 10 minutes.' })

  const proposedActions = offFocus.length
    ? [
        { id: crypto.randomUUID(), text: `Write down the ${short(offFocus[0].projectName)} partnership goals for this month`, bucket: 'Workspace', why: 'Partnership work has no board or items yet — this gives the team something to track.' },
        { id: crypto.randomUUID(), text: 'Decide which product work pauses while partnerships take the lead', bucket: 'Workspace', why: 'Your Focus list still says products; one of the two should change.' },
      ]
    : []

  const focusSuggestions: SampleBriefing['focusSuggestions'] = sustained
    ? [
        ...offFocus.slice(0, 1).map((r) => ({ id: crypto.randomUUID(), kind: 'add' as const, label: `${short(r.projectName)} — partnerships`, projectId: r.projectId, why: `${Math.round(r.share24 * 100)}% of the last 24h` })),
        ...quietFocus.slice(0, 1).map((f) => ({ id: f.id, kind: 'drop' as const, label: f.label, projectId: f.projectId, why: 'Untouched in 24h' })),
      ]
    : []

  const others = personas.filter((p) => !p.isLead)
  const lines = [
    `The ${hottest?.projectName ?? 'busiest'} threads are moving fast without tracked items — risky if anything needs follow-up.`,
    `${stale.length} action items are older than three weeks; most look superseded by the shift in focus.`,
    `The board hasn't been reviewed since October. I'd batch-park the inbox rather than review it item by item.`,
  ]
  const deliberation = others.slice(0, 3).map((p, i) => ({ personaId: p.id, text: lines[i % lines.length] }))

  const headline = !total24
    ? 'Quiet 24 hours. Here\'s what\'s waiting on you.'
    : driftNote
      ? 'Your focus has shifted — let\'s make the plan match.'
      : 'You\'re on plan. Three things for today.'

  return { at: now, headline, top3: top3.slice(0, 3), activity: activity.slice(0, 6), driftNote, moved, stale, staleIdeas: inputs.inboxIdeas.length, proposedActions, focusSuggestions, deliberation }
}
