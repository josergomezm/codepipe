# Lead assistant & daily brief — plan

Status: **phases 1–4 done** — the digest, git and closed chats, the sidebar
chip, the lead's read-only thread and tools, Focus on the server, the brief
run (daily at 9 AM by default, or "Brief me now"), and the lead's page
showing the real thread with the brief card. Phase 5 is for later.
Updated: 2026-11-22.

## Goal

The team lead acts as your assistant at the workspace level. Each morning
it reads your open chats and your git activity, compares them with your
Focus list, action items and board, and writes a brief in its own thread:
today's top 3, what's waiting on you, whether your focus has shifted, what
got done, and what to clean up. You reply to it like any chat.

The lead never changes code. It reads; it writes only CodePipe data (Focus,
workspace action items, its memo). Changes to a project go through a project
chat that it drafts and you send.

## Key fact: open chats are pending work

You delete a chat once its work is done. So:

- **Every open chat is pending work** (or ongoing). The lead doesn't need to
  work out *whether* a chat is pending, only *what* is pending, how it ranks
  against your Focus, and what's blocking it.
- **Finished work leaves two traces:** the git history, and the deletion
  itself. Both feed the brief (see below).

Delete is a real delete today: it stops the CLI, removes the chat file and
index entry, and drops the client cache copy. (Uploaded attachments in
`data/uploads` are left behind; worth cleaning up separately.)

## What the data says (2026-11-22)

- Chats are long in messages, short in turns: "CEO Assistant" has 410
  messages but 11 from you. Most messages are tool steps, so the unit that
  matters is a **turn**: your message plus the agent's final reply.
- Chats usually end one of three ways: **waiting on you** (a question: "Do
  you want me to run it?"), **pending action** (built but uncommitted,
  unpushed, undeployed, or blocked), or **informational**.
- Git knows things the chats don't say plainly: `mtmcya-partners-app` is
  5 commits ahead of origin and `mtmcya-dashboard` 7 ahead, not deployed.

## How it works: one script, one AI step

### 1. Collect (script, free, at brief time)

For **each open chat**:
- title, project, last activity, your message count (24h / 7d)
- **the original request**: your first message (up to ~1,500 chars)
- **where it ended**: the last 2–3 turns (your message + the agent's final
  reply, trimmed; tool lines dropped)
- **an ending hint** from the last reply: question to you → *waiting on
  you*; uncommitted / not pushed / haven't run / blocked → *pending action*

For **each project repo**, since the last brief:
- commits (subject, time), unpushed commits, uncommitted files

Plus: **chats closed since the last brief** (see below), open action items,
proposed and inbox ideas, Focus, and the lead's memo from last time.

Budget: ~12 chats ≈ 20–30k tokens. If the digest ever passes ~40k, the
quietest chats shrink to first message + last turn.

### 2. Brief (the one AI step)

One turn in the lead's session reads the digest and writes the brief as
structured JSON (rendered by `BriefingCard`) plus a short message:

- **Today**: top 3, ranked against Focus.
- **Waiting on you**: each chat's open question, quoted, with a link.
- **Focus check**: your 24h activity vs. Focus. When they disagree, the lead
  decides (clear, sustained shift → suggests a Focus change) or **asks how
  you want to prioritize** (mixed signals).
- **Done since last brief**: closed chats + commits.
- **Suggested action items**: pending things not tracked yet (project or
  Workspace); items that look resolved → suggest closing.
- **Clean up**: stale or settled action items (close or snooze).

It saves a memo for next time (what it's watching, e.g. "partnerships 3
days running").

### 3. Going deeper (lead tools, only when needed)

`read_chat(sessionId, { from: 'start' | 'end', turns })` and
`search_chat(sessionId, query)` for when the first message and last turns
aren't enough, e.g. a pending item that relates to a Focus item and isn't
tracked yet. At most ~4 per brief.

## Closed chats (the "done" signal)

When you delete a chat, CodePipe first records a one-line **closed entry**
for the lead: title, project, the original request (excerpt), the last
reply (excerpt), and how it ended (the same hint as the sidebar chip).
Entries are kept 60 days (`data/closed-chats.json`). It's a script, no AI, and it's the last moment that
information exists. The next brief lists them under *Done since last brief*
alongside the commits, and can mark related action items resolved.

## Windows

- **Chats:** your activity in the last 24 hours (for the focus check); all
  open chats for "waiting on you".
- **Git and closed chats:** since the last brief (covers weekends and days
  off without double counting).

## Where the lead runs

- A hidden **Workspace** project (folder `server/data/workspace`, empty),
  hidden from the Projects list. It gives the lead's session a home that
  isn't the CodePipe repo, and gives action items a **Workspace** bucket
  without changing their schema.
- The lead's session: kind `lead`, one persistent session, the lead
  persona's provider/model (changeable any time in team settings),
  **read-only** launch settings (plan mode, no edit/shell tools).
- Lead-only tools: `list_open_chats`, `read_chat`, `search_chat`,
  `post_brief`, `update_focus`, `save_memo`, `open_project_chat(project,
  title, prompt)` (it creates the chat with the prompt in the composer; you
  send it), plus `list_action_items` / `add_action_item` (project or
  Workspace) / `resolve_action_item` / `update_action_item` (reword, due
  date, blocking, snooze — only when you ask) across all projects.
- Items the lead suggests on its own are credited to it and count toward
  that project's team queue (`MAX_OPEN_ACTIONS`); at the limit it must name
  which waiting item to clean up instead. Items you ask it to add are yours
  and never capped. The brief's `top3` can point at an action item as well
  as a chat.

## Build phases

1. **Digest + chip** (no AI) — **done**: turn extraction, ending hints
   (`server/src/lead/chat-digest.ts`), the workspace digest and closed-chat
   entries (`lead/workspace-digest.ts`), git activity
   (`getRepoActivity`), and the sidebar chip ("Your turn" / "Pending"),
   recomputed for idle chats at startup.
2. **Lead session** — **done**: the hidden Workspace project and the lead's
   thread (`server/src/lead/lead-service.ts`); read-only launch settings
   enforced per provider (`READ_ONLY_SETTINGS`, also applied to reviewer
   sessions; ACP sessions reject non-read tool calls); the lead's tools
   (`list_open_chats`, `read_chat`, `search_chat`, `update_focus`,
   `open_project_chat`, `save_memo`, and the item tools across all
   projects); Focus at `GET /api/lead` / `PUT /api/lead/focus`.
3. **Brief run** — **done**: `LeadService.runBrief` builds the digest since
   the last brief and gives the lead one turn (`lead/brief-prompt.ts`); the
   lead posts the brief with the `post_brief` tool (every chat / item /
   project reference resolved, activity computed by code, stored as a
   `brief` card), suggests untracked work with `add_action_item`, and saves
   its memo. `lastBriefAt` moves to the run's start only when a brief was
   posted. Scheduled daily at 9 AM by default (`PUT /api/lead/schedule`,
   weekdays-only or off), at most one scheduled attempt a day; "Brief me
   now" is `POST /api/lead/brief`. Push comes from the turn's end like any
   chat. Briefs too long for a command line reach the CLI as a file
   (`server/src/long-input.ts`, for any long message).
4. **Wire the UI** — **done**: the lead's Chat tab is the real lead session
   (`LeadThread.vue` borrows the app's message list and composer while
   open); the brief renders from `metadata.brief` (`BriefingCard.vue`):
   Accept on Focus suggestions, Close/Snooze on clean-up items, links to
   chats; suggested items are the usual suggestion cards. The sidebar badge
   is the lead session's unread state; a lead notification opens the lead's
   page. The sample-data preview is gone.
5. **Later**: per-chat summaries only if digests outgrow the budget; team
   members' notes; per-member threads.

## Decisions (2026-11-22)

- **Model:** the lead's provider and model, changeable on the fly.
- **"Waiting on you" chip:** yes, phase 1.
- **Windows:** chats 24h; git and closed chats since the last brief.
- **Git history:** in.
- **No per-chat AI summaries in v1:** open chats = pending work, so a
  script digest plus one lead run covers it.
