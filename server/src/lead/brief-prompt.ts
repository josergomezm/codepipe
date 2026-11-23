/**
 * The prompt for the lead's daily brief: the workspace digest rendered as
 * text, your Focus list and the lead's memo, plus how to report — through
 * CodePipe's tools (update_action_item for progress, post_brief,
 * add_action_item, save_memo), never by changing code. See docs/lead-assistant-plan.md, "The brief".
 */
import type { ActionItem, FocusItem, Persona, Project } from '../schemas.js'
import { MAX_OPEN_ACTIONS } from '../standup-protocol.js'
import type { WorkspaceDigest } from './workspace-digest.js'

const DAY = 86_400_000

export interface BriefPromptInput {
  digest: WorkspaceDigest
  lead: Persona
  projects: Project[]
  focus: FocusItem[]
  memo?: string
  now: number
}

const shortId = (id: string) => id.slice(0, 8)
/** The item's latest progress line, so the lead doesn't log the same thing twice. */
const lastProgress = (a: Pick<ActionItem, 'progress'>) => {
  const p = a.progress?.at(-1)
  return p ? `\n    Last progress (${day(p.at)}): ${p.text}` : ''
}
/** YYYY-MM-DD in local time (like every other date the user sees). */
const day = (ms: number) => new Date(ms).toLocaleDateString('en-CA')
const ago = (ms: number, now: number) => {
  const hours = Math.round((now - ms) / 3_600_000)
  return hours < 48 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`
}

function chatsSection(d: WorkspaceDigest, now: number): string {
  if (!d.chats.length) return 'No open chats.'
  return d.chats
    .map((c) => {
      const ended = c.attention
        ? c.attention.state === 'waiting_on_you'
          ? `ended asking you: "${c.attention.question ?? ''}"`
          : c.attention.state === 'pending_action' ? 'ended with work pending' : 'ended saying it shipped'
        : 'ended without a clear next step'
      const turns = c.lastTurns
        .map((t) => `    You: ${t.you}\n    Agent: ${t.reply || '(no reply yet)'}`)
        .join('\n')
      return [
        `- [${shortId(c.sessionId)}] "${c.title}" — ${c.projectName} · last activity ${ago(c.lastActivityAt, now)} · your messages ${c.mine24} (24h) / ${c.mine7} (7d) · ${c.turnCount} turns · ${ended}`,
        `  Original request: ${c.firstRequest}`,
        `  Where it ended:\n${turns}`,
      ].join('\n')
    })
    .join('\n\n')
}

function reposSection(d: WorkspaceDigest): string {
  if (!d.repos.length) return 'No commits, unpushed or uncommitted work in any project.'
  return d.repos
    .map(({ projectName, activity: a }) => {
      const bits = [
        a.commits.length ? `${a.commits.length} commit(s): ${a.commits.slice(0, 8).map((c) => `"${c.subject}"`).join('; ')}` : 'no new commits',
        a.unpushed ? `${a.unpushed} unpushed` : null,
        a.uncommitted ? `${a.uncommitted} uncommitted file(s)` : null,
      ].filter(Boolean)
      return `- ${projectName}${a.branch ? ` (${a.branch})` : ''}: ${bits.join(' · ')}`
    })
    .join('\n')
}

export function buildBriefPrompt({ digest: d, lead, projects, focus, memo, now }: BriefPromptInput): string {
  const projectName = (id?: string) => (id ? projects.find((p) => p.id === id)?.name ?? 'Removed project' : null)
  const today = new Date(now).toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })

  const focusList = focus.length
    ? focus.map((f, i) => `${i + 1}. ${f.label}${f.projectId ? ` (${projectName(f.projectId)})` : ''}`).join('\n')
    : '(none set yet — if the work makes the priorities clear, suggest some)'
  const activity = d.activity.length
    ? d.activity.map((a) => `- ${a.projectName}: ${a.mine24} (24h) / ${a.mine7} (7d)`).join('\n')
    : '- No messages from the user in the last 7 days.'
  const closed = d.closed.length
    ? d.closed.map((c) => `- "${c.title}" — ${projectName(c.projectId)}: asked "${c.request}" → last reply "${c.lastReply}"`).join('\n')
    : '- None.'
  const items = d.openActions.length
    ? d.openActions
        .map((a) => `- [${shortId(a.id)}] ${projectName(a.projectId)} · ${a.kind ?? 'task'} · open ${Math.floor((now - a.createdAt) / DAY)}d${a.dueDate ? ` · due ${a.dueDate}` : ''}${a.blocking === false ? ' · non-blocking' : ''}: ${a.text}${lastProgress(a)}`)
        .join('\n')
    : '- None.'
  const ideas = [
    d.ideas.proposed.length
      ? `Proposed, waiting for the user to approve (${d.ideas.proposed.length}):\n${d.ideas.proposed.map((t) => `- ${projectName(t.projectId)}: ${t.text}`).join('\n')}`
      : 'No proposals waiting.',
    `${d.ideas.inboxCount} idea(s) sit untriaged in the board inbox.`,
  ].join('\n')

  return [
    `You are ${lead.name}, ${lead.role} — the user's assistant across ALL their projects, not one codebase. ${lead.personality}`.trim(),
    '',
    `Today is ${today}. Write the user's daily brief: what they worked on, what's waiting on them, and whether their day matched their priorities. The user deletes a chat once its work is done, so every open chat below is work still in flight.`,
    '',
    memo ? `Your memo from the last brief:\n${memo}\n` : '',
    `The user's Focus list (their priorities, in order):\n${focusList}`,
    '',
    `Their messages per project — what they actually spent the day on:\n${activity}`,
    '',
    `## Open chats (waiting on the user first)\n${chatsSection(d, now)}`,
    '',
    `## Git since the last brief (${day(d.since)})\n${reposSection(d)}`,
    '',
    `## Chats the user closed since the last brief (finished work)\n${closed}`,
    '',
    `## Open action items\n${items}`,
    '',
    `## The ideas board\n${ideas}`,
    d.trimmed ? '\n(Some quiet chats were shortened to fit; read_chat has the rest.)' : '',
    '',
    `## How to report — through CodePipe's tools; text alone changes nothing`,
    '',
    `1. If an open chat matters to a Focus item or is pending without a matching action item, and its excerpt isn't enough, read more with \`read_chat\` or \`search_chat\` (its [id]). At most 4 such reads.`,
    `2. Keep the action items current: when a chat or commit shows progress on an open item, log it with \`update_action_item\` (\`progress\`: one line on what moved, \`chat\`: where), and reword or re-date the item when the work shows it ("Review the doc" → "Review sections 4–6"). Skip what its last progress already says. Never close an item: when it looks done, put it under \`clean_up\`.`,
    `3. Call \`post_brief\` exactly once — the brief the user sees:`,
    `   - \`top3\`: today's three most important things, ranked against Focus — open action items count, not just chats. Link the chat (\`chat\`) or the action item (\`item\`) by its [id].`,
    `   - \`waiting_on_you\`: each open chat that ended on a question or a step only the user can take — quote the question.`,
    `   - \`focus_check\`: compare their messages and commits with Focus (to suggest dropping an item, give its number as \`focus_item\`). \`on_plan\` when they match; \`shifted\` when other work clearly dominated for days (check the 7-day numbers and your memo, not one day) — then suggest the Focus change; \`mixed\` when you can't tell — then ASK how they want to prioritize in \`question\`. Never change Focus yourself.`,
    `   - \`done\`: what finished since the last brief — closed chats, shipped commits.`,
    `   - \`clean_up\`: open action items that look stale or settled by what you read (close or snooze, with why).`,
    `4. For pending work that no action item tracks, suggest one with \`add_action_item\` (user_requested: false, \`project\` set, or omitted for Workspace — business and partnership work that belongs to no product). Don't duplicate items that already exist. Your suggestions count toward each project's queue of ${MAX_OPEN_ACTIONS} team items: at the limit, suggest only what beats an item already waiting, and name that one under \`clean_up\`.`,
    `5. Call \`save_memo\`: what you're watching for the next brief (e.g. a shift you saw but aren't sure of yet).`,
    `6. Then reply in 1–3 plain sentences — it's what the notification shows. Don't repeat the brief.`,
    '',
    `You never change code or files. Work happens in project chats: if something needs doing in a project, the user can ask you to open one (\`open_project_chat\`) with a drafted prompt, or to refine or implement an idea on a board — you do those only when they say so, never in the brief.`,
  ]
    .filter((line, i, all) => !(line === '' && all[i - 1] === ''))
    .join('\n')
}
