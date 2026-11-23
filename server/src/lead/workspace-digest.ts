/**
 * Everything the lead's brief reads, collected by code (no AI): your open
 * chats as digests, git activity since the last brief, chats you closed,
 * open action items and the board. See docs/lead-assistant-plan.md.
 *
 * Open chats = pending work: you delete a chat once it's done, so every user
 * chat still here is something in flight.
 */
import type { IStorageLayer } from '../storage.js'
import type { ActionItem, ClosedChat, Session } from '../schemas.js'
import { getRepoActivity, type RepoActivity } from '../git-changes.js'
import { clip, clipEnd, digestChat, endingHint, extractTurns, isUserChat, type ChatDigest } from './chat-digest.js'

/** Rough token estimate (chars / 4) — the digest's budget. */
const TOKEN_BUDGET = 40_000

export interface WorkspaceDigest {
  generatedAt: number
  /** Git activity and closed chats are reported since this time. */
  since: number
  chats: (ChatDigest & { projectName: string })[]
  /** Your messages per project, last 24h and 7d (projects with any). */
  activity: { projectId: string; projectName: string; mine24: number; mine7: number }[]
  /** Repos with something to say: commits since, unpushed, or uncommitted work. */
  repos: { projectId: string; projectName: string; activity: Extract<RepoActivity, { isRepo: true }> }[]
  closed: ClosedChat[]
  openActions: Pick<ActionItem, 'id' | 'projectId' | 'text' | 'kind' | 'dueDate' | 'blocking' | 'createdAt'>[]
  ideas: { proposed: { id: string; projectId: string; text: string }[]; inboxCount: number }
  /** True when quiet chats were shortened to fit the budget. */
  trimmed: boolean
}

/** Closed-chat entry for a session about to be deleted (null for non-chats). */
export function closedChatFrom(session: Session): ClosedChat | null {
  if (!isUserChat(session)) return null
  const turns = extractTurns(session.messages)
  const last = turns.at(-1)
  if (!last) return null
  const attention = endingHint(last.reply)
  return {
    sessionId: session.id,
    projectId: session.projectId,
    title: session.title,
    request: clip(turns[0].you, 600),
    lastReply: clipEnd(last.reply, 600),
    ...(attention ? { attention } : {}),
    closedAt: Date.now(),
  }
}

/** Shrink the quietest chats to request + last reply until the digest fits. */
function fitBudget(chats: WorkspaceDigest['chats']): boolean {
  const size = () => JSON.stringify(chats).length / 4
  if (size() <= TOKEN_BUDGET) return false
  const quietestFirst = [...chats].sort((a, b) => a.mine7 - b.mine7 || a.lastActivityAt - b.lastActivityAt)
  for (const c of quietestFirst) {
    c.firstRequest = clip(c.firstRequest, 600)
    c.lastTurns = c.lastTurns.slice(-1).map((t) => ({ ...t, you: clip(t.you, 300), reply: clipEnd(t.reply, 600) }))
    if (size() <= TOKEN_BUDGET) break
  }
  return true
}

/** Your messages per project (24h / 7d), busiest first — projects with any in 7 days. */
export function activityRows(chats: (Pick<ChatDigest, 'projectId' | 'mine24' | 'mine7'> & { projectName: string })[]): WorkspaceDigest['activity'] {
  const byProject = new Map<string, WorkspaceDigest['activity'][number]>()
  for (const c of chats) {
    const row = byProject.get(c.projectId) ?? { projectId: c.projectId, projectName: c.projectName, mine24: 0, mine7: 0 }
    row.mine24 += c.mine24
    row.mine7 += c.mine7
    byProject.set(c.projectId, row)
  }
  return [...byProject.values()].filter((r) => r.mine7 > 0).sort((a, b) => b.mine24 - a.mine24 || b.mine7 - a.mine7)
}

export interface DigestSources {
  storage: IStorageLayer
  /** Live in-memory copy of a session, fresher than disk while it runs. */
  liveSession?: (id: string) => Session | undefined
}

/** Your chats, newest first — each from memory when it's running, else disk. */
export async function loadUserChats({ storage, liveSession }: DigestSources): Promise<Session[]> {
  const metas = (await storage.listSessions()).filter(isUserChat).sort((a, b) => b.updatedAt - a.updatedAt)
  const sessions = await Promise.all(metas.map(async (m) => liveSession?.(m.id) ?? (await storage.getSession(m.id))))
  return sessions.filter((s): s is Session => !!s)
}

export async function buildWorkspaceDigest(
  sources: DigestSources,
  opts: { since: number; now?: number },
): Promise<WorkspaceDigest> {
  const { storage } = sources
  const now = opts.now ?? Date.now()
  const [projects, sessions, closed, actions, todos] = await Promise.all([
    storage.listProjects(),
    loadUserChats(sources),
    storage.listClosedChats(opts.since),
    storage.listActionItems(),
    storage.listTodos(),
  ])
  const projectName = (id: string) => projects.find((p) => p.id === id)?.name ?? 'Removed project'

  const chats = sessions
    .map((s) => ({ ...digestChat(s, now), projectName: projectName(s.projectId) }))
    .filter((c) => c.turnCount > 0)
    // Waiting on you first, then the most recently active.
    .sort((a, b) => Number(b.attention?.state === 'waiting_on_you') - Number(a.attention?.state === 'waiting_on_you') || b.lastActivityAt - a.lastActivityAt)

  const repos = (
    // Not the internal Workspace: its folder sits inside CodePipe's own checkout.
    await Promise.all(projects.filter((p) => !p.internal).map(async (p) => ({ projectId: p.id, projectName: p.name, activity: await getRepoActivity(p.path, opts.since) })))
  ).flatMap((r) => (r.activity.isRepo && (r.activity.commits.length || r.activity.unpushed || r.activity.uncommitted) ? [{ ...r, activity: r.activity }] : []))

  const trimmed = fitBudget(chats)

  return {
    generatedAt: now,
    since: opts.since,
    chats,
    activity: activityRows(chats),
    repos,
    closed,
    openActions: actions
      .filter((a) => a.status === 'open')
      .map(({ id, projectId, text, kind, dueDate, blocking, createdAt }) => ({ id, projectId, text, kind, dueDate, blocking, createdAt })),
    ideas: {
      proposed: todos.filter((t) => t.status === 'proposed').map((t) => ({ id: t.id, projectId: t.projectId, text: t.text })),
      inboxCount: todos.filter((t) => t.status === 'inbox').length,
    },
    trimmed,
  }
}

/**
 * At startup, recompute how each idle chat ended from its last turn, so the
 * sidebar chip is right without waiting for the next turn — for chats from
 * before attention existed, and after the hint rules improve. Writes only
 * what changed; skips sessions already running (their memory copy wins).
 */
export async function refreshAttention({ storage, liveSession }: DigestSources): Promise<number> {
  let updated = 0
  for (const meta of await storage.listSessions()) {
    if (!isUserChat(meta) || liveSession?.(meta.id)) continue
    const session = await storage.getSession(meta.id)
    if (!session) continue
    const attention = digestChat(session).attention
    if (JSON.stringify(attention ?? null) === JSON.stringify(meta.attention ?? null)) continue
    // It may have started running while we read it — its memory copy wins.
    if (liveSession?.(meta.id)) continue
    await storage.setSessionAttention(meta.id, attention)
    updated++
  }
  return updated
}

/**
 * Record a chat you're deleting as "closed" for the lead (its last chance to
 * be read). Never blocks or fails the delete.
 */
export async function noteClosedChat({ storage, liveSession }: DigestSources, sessionId: string): Promise<void> {
  const session = liveSession?.(sessionId) ?? (await storage.getSession(sessionId))
  const entry = session ? closedChatFrom(session) : null
  if (entry) await storage.addClosedChat(entry)
}
