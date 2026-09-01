# CodePipe

A web app that makes AI CLI tools look and feel like a chat application.

CodePipe wraps terminal-based AI agents — Kiro CLI, Gemini CLI, Claude Code, and eventually Codex — in a clean messaging interface. You get conversation history, multiple concurrent sessions, project-scoped workspaces, and markdown-rendered output, all while running the real CLI tools under the hood.

## Quick Start

You'll need Node.js 22+ and at least one supported AI CLI installed and authenticated (`kiro-cli`, `claude`, or `gemini`).

```bash
# 1. Backend (http://127.0.0.1:5551)
cd server
npm install
npm run dev          # or: KIRO_TRANSPORT=acp npm run dev  (recommended for Kiro)

# 2. Frontend (http://127.0.0.1:5552) — in a second terminal
cd client
npm install
npm run dev
```

Open http://127.0.0.1:5552, pick a project directory and a provider, and start chatting. To use it from your phone with notifications, see [Remote Access](#remote-access-with-tailscale) and [Install on your phone](#install-on-your-phone--notifications-pwa). For configuration options, see [Configuration](#configuration).

## How It Works

The backend runs the real CLI tool for each conversation and normalizes its output into chat messages, which it streams to a Vue frontend over a WebSocket. Each conversation is tied to a specific project directory and AI provider.

CodePipe supports two ways of talking to a CLI, chosen per adapter:

- **Structured (ACP)** — for tools that speak the [Agent Client Protocol](https://agentclientprotocol.com), CodePipe drives a persistent process over JSON-RPC and reads typed events (message chunks, tool calls, turn boundaries). This is robust and is the recommended path. Kiro CLI supports it via `kiro-cli acp`.
- **Text parsing** — for tools without a structured mode, CodePipe spawns the process (PTY or one-shot) and parses its terminal output with a per-provider adapter. This is inherently more fragile and exists as a fallback.

## Tech Stack

**Backend** — Node.js, TypeScript, Express, `ws` (WebSocket), `web-push` (notifications). Structured CLIs are driven over JSON-RPC (ACP) or newline-delimited JSON (`stream-json`); `node-pty` is available for the legacy terminal-parsing fallback.

**Frontend** — Vue 3, Tailwind CSS, Vite, Pinia, plus a service worker + Web App Manifest for PWA install and push notifications.

**Storage** — JSON files: one per session, a metadata index for fast listing, and a `projects.json`. Lightweight and portable, no database required.

## Supported Providers

| Provider    | Transport                              | Status      |
|-------------|----------------------------------------|-------------|
| Kiro CLI    | ACP (`kiro-cli acp`) or text-parsing   | Implemented |
| Claude Code | stream-json (`claude -p`)              | Implemented |
| Gemini CLI  | ACP (`gemini --acp`)                   | Implemented |
| Codex       | —                                      | Future      |

Each provider has a dedicated adapter. Kiro ships in two flavors: the structured ACP transport (recommended, set `KIRO_TRANSPORT=acp`) and a legacy non-interactive text-parsing transport (default). Claude Code uses its native newline-delimited `stream-json` output. Gemini CLI is driven over ACP, the same JSON-RPC protocol as Kiro.

> The ACP details for Kiro and Gemini, and the Claude stream-json event mapping, were built against published docs. Verify against your installed CLIs — the adapters are defensive and every binary/flag is overridable via env (see Configuration).

## Configuration

The server reads these environment variables:

| Variable          | Default       | Description                                                                 |
|-------------------|---------------|-----------------------------------------------------------------------------|
| `PORT`            | `5551`        | Backend HTTP/WebSocket port.                                                |
| `HOST`            | `127.0.0.1`   | Backend bind address.                                                       |
| `KIRO_TRANSPORT`  | _(unset)_     | Set to `acp` to drive Kiro CLI over the Agent Client Protocol (recommended) instead of the legacy text-parsing path. |
| `KIRO_CLI_BIN`    | platform name | Override the Kiro binary (absolute path or name on `PATH`). Defaults to `kiro-cli` (`kiro-cli.exe` on Windows). |
| `GEMINI_CLI_BIN`  | `gemini`      | Override the Gemini CLI binary.                                            |
| `CLAUDE_CLI_BIN`  | `claude`      | Override the Claude Code binary (`claude.cmd` on Windows).                 |
| `CLAUDE_PERMISSION_MODE` | `acceptEdits` | Claude Code `--permission-mode`. See SECURITY.md before broadening.   |
| `CLAUDE_EXTRA_ARGS` | _(unset)_   | Extra flags appended to Claude Code (e.g. `--dangerously-skip-permissions`). |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | _(unset)_ | Web Push keys. Generate with `npm run gen-vapid`. Push is disabled without them. |
| `VAPID_SUBJECT`   | `mailto:admin@codepipe.local` | Contact URI sent with push (a `mailto:` or `https:` URL). |

`GET /api/health` reports server status plus, for each registered provider, the resolved binary and whether it appears to be installed — useful for catching a missing CLI before creating a session.

## Features

- Chat-style UI with conversation sidebar, message bubbles, and markdown rendering
- Multiple providers — Kiro CLI, Claude Code, and Gemini CLI — behind one interface
- **AI team with daily standups** — configurable personas review your per-project ideas list on a schedule and message you with proposals and questions, each with their own name and avatar (see [Your AI team](#your-ai-team-personas--standups))
- **Headless runs** — `POST /api/sessions/:id/run` sends a message and returns the turn's final response, no WebSocket needed (the orchestration primitive behind standups)
- Structured output parsing (ACP / stream-json) for reliable messages, tool calls, and turn boundaries, with a terminal-parsing fallback
- Multiple concurrent sessions, each scoped to a project directory
- **Stop button** to cancel an in-flight turn, and input **queueing** so messages sent mid-turn run in order instead of interrupting
- **Per-session model selection** — a dynamic dropdown for providers that advertise their models (Kiro, Gemini), a free-text override for those that don't (Claude Code)
- **Installable PWA** with **push notifications** when an agent finishes — use it on your phone like Slack
- Remote access over Tailscale (HTTPS, private tailnet, no public exposure)
- File attachments, typing indicator, persistent history, and live/archived session states
- Per-provider binary auto-detection via `GET /api/health`

## Your AI team (personas & standups)

CodePipe includes a proactive layer on top of ordinary sessions: a small AI
"organization" that reviews your ideas and reports back like colleagues.

**How it fits together**

- **Personas** (sidebar → Team → gear icon): named team members with a role, a
  personality prompt, a provider/model, and an optional profile picture. One
  persona is the **lead** — their CLI runs the team's thinking, and their
  avatar fronts the team thread. Push notifications arrive under the persona's
  name and picture, like a message from a person.
- **Ideas** (project menu → Ideas): a per-project todo/idea list with quick
  capture. Statuses flow `inbox → in review → proposed → approved → done`.
- **Action items** (sidebar → Workspace → Action items, at `/actions`): a
  full-page cross-project dashboard of things only *you* can do — add API
  secrets, create accounts, make a call the team can't. Standups raise these
  automatically (deduplicated against open items) and you can add your own.
  Completing a team-raised item pings the team thread: a persona acknowledges
  and picks up whatever it was blocking.
- **Ideas board** (`/board`): a kanban over the idea lifecycle (Inbox → In
  review → Proposed → Approved → Done) with a project filter, quick capture,
  and per-card move controls. Moving a card is just
  `PATCH /api/todos/:id {status}` — scriptable like everything else.
- **Approve & build**: approving a proposal spawns a live **work session** —
  an ordinary chat running on the *proposing persona's* provider/model, titled
  after them, visible in the sidebar like any conversation. Open it to watch
  the implementation stream (or interject — it's a chat). When the turn
  finishes, the idea moves to Done on the board and the implementer announces
  it in the team thread with a push notification; if it fails, the idea stays
  on the board with the session link cleared so you can retry.
- **Ledger** (`/ledger`): every idea that reached Done, grouped by month with
  completion dates, project tags, who proposed it, and a link to the build
  session that shipped it — your shipping record.
- **Standups**: enable per project in project settings (toggle + hour). Once a
  day the team reads the open ideas, deliberates (one headless CLI turn — the
  raw discussion is kept, collapsed behind a "Team deliberation" toggle), then
  each relevant persona messages you: the lead summarizes, others ask their own
  questions. Proposals land on the matching ideas with a summary, approach, and
  effort estimate. Replying in the team thread continues the same conversation.

**Cost control**: a standup is skipped when the ideas list hasn't changed since
the last run (and scheduled runs happen at most once per day per project).
"Run standup" in the Ideas panel forces one immediately; with an empty list it
asks the team to review the project itself and suggest improvements. Manual
runs return as soon as the turn is dispatched — results arrive as persona
notifications. Team threads rotate monthly (and when the lead's provider
changes) so the resumed CLI context stays bounded; old threads remain as
history.

**Storage**: personas, todos, and standup state are JSON files under
`server/data/`, validated with zod like everything else. Avatars are stored in
`server/data/avatars/` and served at `/api/avatars/<file>`.

## Remote Access with Tailscale

CodePipe binds to localhost only — it has no built-in auth. To access it from another device (phone, tablet, another machine), you use [Tailscale](https://tailscale.com/) to securely expose it to your private tailnet. Only devices on your tailnet can reach it; nothing is exposed to the public internet.

### Prerequisites

- [Tailscale](https://tailscale.com/download) installed on the machine running CodePipe
- Tailscale installed on the device you want to access it from (e.g. your phone)
- Both devices signed into the same tailnet

### Setup

With CodePipe running (backend on port 5551, frontend on port 5552), run:

```bash
tailscale serve --bg localhost:5552
```

All traffic goes through the Vite dev server, which already proxies `/api` and `/ws` requests to the backend on port 5551. One serve rule is all you need.

Tailscale provisions a TLS certificate automatically, so you get valid HTTPS with no extra config.

For hot-module reload to work over the tailnet, the Vite dev server needs your tailnet hostname. Copy `client/.env.example` to `client/.env.remote`, set `TAILSCALE_HOST` (find it with `tailscale status`), and start the frontend with `npm run dev:remote`. These env files are gitignored — no hostnames are committed to the repo.

### Access

Open your browser on the other device and go to:

```
https://<your-machine-name>.<your-tailnet>.ts.net
```

You can find your machine's hostname with `tailscale status`.

### Stopping

To remove the serve config:

```bash
tailscale serve reset
```

## Install on your phone + notifications (PWA)

CodePipe is an installable PWA, so you can add it to your phone's home screen
and get push notifications when an agent finishes a turn — like Slack or
WhatsApp.

This requires a secure context (HTTPS). Tailscale serve provides that
automatically, so set it up as above, then:

1. **Generate Web Push keys** (once) and add them to the backend's environment:

   ```bash
   cd server
   npm run gen-vapid          # prints a public + private key
   # then set them before starting the server, e.g.:
   export VAPID_PUBLIC_KEY=...   # the printed public key
   export VAPID_PRIVATE_KEY=...  # the printed private key
   npm run dev
   ```

2. **Open the tailnet URL on your phone** (`https://<machine>.<tailnet>.ts.net`).
3. **Install it**: in your phone browser's share/menu, choose "Add to Home
   Screen". On iOS this is required before notifications will work.
4. **Open the installed app** and tap **Enable notifications** in the sidebar,
   then allow the permission prompt.

After that, when an agent finishes responding while the app is backgrounded,
you'll get a notification; tapping it opens that conversation. Notifications are
suppressed while you're actively looking at the app. The same flow works on
desktop browsers.

## Choosing a model

Each session has a model picker in the chat header. How the choices are
discovered depends on the provider — nothing is hardcoded:

- **Kiro and Gemini (ACP)**: the available models are pulled from the agent
  itself over the protocol, so the picker is a real dropdown. (The exact way
  agents advertise models is an optional ACP extension and varies, so this is
  best-effort and worth confirming against your installed CLIs.)
- **Claude Code**: the CLI has no command to enumerate models, so the picker
  offers Claude Code's documented aliases — `sonnet`, `opus`, `haiku`, `fable`
  (each always maps to the current version) — plus a **Custom…** option to pin
  a full model id (e.g. `claude-sonnet-4-6`). The choice is passed via `--model`
  on the next message. These aliases live in the Claude adapter, so updating
  them is a one-line change rather than a UI edit.

Your selection is saved per session and applied automatically when you resume.

## Stopping a response

While an agent is working, the send button becomes a **Stop** button. Stopping
cancels the in-flight turn and clears anything queued. Messages you send while
the agent is still working are queued and run in order rather than interrupting
the current turn.
