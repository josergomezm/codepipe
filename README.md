# CodePipe

A web app that makes AI CLI tools look and feel like a chat application.

CodePipe wraps terminal-based AI agents — Kiro CLI, Antigravity CLI, Claude Code, and eventually Codex — in a clean messaging interface. You get conversation history, multiple concurrent sessions, project-scoped workspaces, and markdown-rendered output, all while running the real CLI tools under the hood.

## Quick Start

You'll need Node.js 22+ and at least one supported AI CLI installed and authenticated (`kiro-cli`, `claude`, or `agy`).

```bash
# 1. Backend (http://127.0.0.1:5551)
cd server
npm install
npm run serve        # supervised: restarts after a crash (see Keeping it running)
                     # or `npm run dev` while working on CodePipe itself (auto-reloads)

# 2. Frontend (http://127.0.0.1:5552) — in a second terminal
cd client
npm install
npm run dev
```

Open http://127.0.0.1:5552, pick a project directory and a provider, and start chatting. To use it from your phone with notifications, see [Remote Access](#remote-access-with-tailscale) and [Install on your phone](#install-on-your-phone--notifications-pwa). For configuration options, see [Configuration](#configuration).

## Keeping it running

For everyday use, start the backend with **`npm run serve`**. It runs the server under a small supervisor (`server/scripts/supervise.mjs`) that restarts it after a crash, backing off if it crashes repeatedly. Press Ctrl+C in its window to stop: the server shuts down gracefully (saving messages, archiving chats) and the supervisor waits for it. Use `npm run dev` only while working on CodePipe itself. It reloads whenever a source file changes, including when an agent in one of your chats edits CodePipe, which restarts the server mid-reply; and if the server crashes under `dev`, it stays down until a file changes.

> **Why the server used to stop "by itself" on Windows:** a console Ctrl+C goes to every process attached to the same console window. CLIs used to share the server's console, so when one of them — or a shell or tool it ran — sent Ctrl+C to interrupt its own work, the server received it too and shut down mid-turn (every such shutdown in the logs happened during a Kiro turn). Every process the server starts now gets its own hidden console (`server/src/child-options.ts`), so their Ctrl+C can't reach the server. `child-options.test.ts` reproduces this in a real console; run it from a normal terminal, since some environments (Git Bash, some CI) ignore console Ctrl+C and skip it.

When something goes wrong, the **Diagnostics** page (sidebar → Workspace) shows:

- **Health:** uptime, memory, live chats, CLI processes and shells, and the worst event-loop stall, plus a 24-hour memory trend. A sample is also written to the log every 10 minutes, so slow leaks show up before they crash anything.
- **Crashes & restarts:** every crash report and supervisor restart. Tap one to read the full report.
- **Recent warnings & errors**.

Everything is also on disk under `server/data/`:

| Path | What's in it |
|------|--------------|
| `server.log` (+ `server.1.log` … `server.5.log`) | The full log, with ISO timestamps; rotates at 10 MB. Errors include their message, code and stack. |
| `crashes/` | One report per crash: the error and stack, what was running (chats, CLI processes, shells), memory, and the last 300 log lines. Uncaught exceptions end the process; unhandled promise rejections are reported and the server keeps running. Deaths JavaScript can't catch (out of memory, native crashes, being killed) get a report from the server's last stderr, written by the supervisor. The newest 50 are kept. |
| `restarts.jsonl` | One line per supervisor restart: time, exit code, uptime, and the matching report. |

When a CLI process fails mid-reply, the chat says so (with the CLI's own last error line) and the log records its exit code, run time and the tail of its stderr.

If a CLI goes **silent for 15 minutes** mid-reply, the chat gets a notice listing what's still running — in particular processes the reply started that outlived the process that launched them. A test run's leftover emulator or dev server is the usual culprit: it keeps the CLI's command from ever finishing, so the CLI waits forever. **Stop** (and Restart CLI) end the CLI together with everything running under it; leftovers that have already detached are listed in the notice so you can end them yourself.
Terminal shells are logged the same way (start with pid, every client attach and detach, and exit with code, uptime and who ended it). If a shell can't start (the project folder is gone, or `CODEPIPE_SHELL` is wrong), the Terminal tab shows the reason and a **Try again** button instead of retrying silently.

## How It Works

The backend runs the real CLI tool for each conversation and normalizes its output into chat messages, which it streams to a Vue frontend over a WebSocket. Each conversation is tied to a specific project directory and AI provider.

CodePipe supports three ways of talking to a CLI, chosen per adapter:

- **ACP** — for tools that speak the [Agent Client Protocol](https://agentclientprotocol.com), CodePipe drives a persistent process over JSON-RPC and reads typed events (message chunks, tool calls, turn boundaries). Kiro CLI supports it via `kiro-cli acp`.
- **stream-json** — for tools with a structured output mode, CodePipe runs one process per message and reads newline-delimited JSON events, resuming the conversation by ID. Claude Code and Antigravity CLI work this way.
- **Text parsing** — for tools with neither, CodePipe runs one process per message and parses its plain output with a per-provider adapter. This is inherently more fragile and exists as a fallback (Kiro's default transport).

## Tech Stack

**Backend** — Node.js, TypeScript, Express, `ws` (WebSocket), `web-push` (notifications). CLIs are driven over JSON-RPC (ACP) or newline-delimited JSON (`stream-json`); `node-pty` powers the project Terminal tab.

**Frontend** — Vue 3, Tailwind CSS, Vite, Pinia, plus a service worker + Web App Manifest for PWA install and push notifications.

**Storage** — JSON files: one per session, a metadata index for fast listing, and a `projects.json`. Lightweight and portable, no database required.

## Supported Providers

| Provider    | Transport                              | Status      |
|-------------|----------------------------------------|-------------|
| Kiro CLI    | ACP (`kiro-cli acp`) or text-parsing   | Implemented |
| Claude Code | stream-json (`claude -p`)              | Implemented |
| Antigravity | stream-json (`agy -p`)                 | Implemented |
| Codex       | —                                      | Future      |

Each provider has a dedicated adapter. Kiro ships in two flavors: the structured ACP transport (recommended, set `KIRO_TRANSPORT=acp`) and a legacy non-interactive text-parsing transport (default). Claude Code uses its native newline-delimited `stream-json` output. Antigravity CLI (`agy`, Google's successor to Gemini CLI) uses its own `stream-json` output the same way, resuming conversations with `--conversation <id>`. It has no ACP mode.

> The ACP details for Kiro and the Claude/Antigravity stream-json event mappings were built against published docs. Verify against your installed CLIs — the adapters are defensive and every binary/flag is overridable via env (see Configuration).

## Configuration

The server reads these environment variables:

| Variable          | Default       | Description                                                                 |
|-------------------|---------------|-----------------------------------------------------------------------------|
| `PORT`            | `5551`        | Backend HTTP/WebSocket port.                                                |
| `HOST`            | `127.0.0.1`   | Backend bind address.                                                       |
| `KIRO_TRANSPORT`  | _(unset)_     | Set to `acp` to drive Kiro CLI over the Agent Client Protocol (recommended) instead of the legacy text-parsing path. |
| `KIRO_CLI_BIN`    | platform name | Override the Kiro binary (absolute path or name on `PATH`). Defaults to `kiro-cli` (`kiro-cli.exe` on Windows). |
| `AGY_CLI_BIN`     | `agy`         | Override the Antigravity CLI binary (`agy.exe` on Windows; `GEMINI_CLI_BIN` is still honoured). |
| `CLAUDE_CLI_BIN`  | `claude`      | Override the Claude Code binary (`claude.cmd` on Windows).                 |
| `CLAUDE_PERMISSION_MODE` | `acceptEdits` | Claude Code `--permission-mode`. See SECURITY.md before broadening.   |
| `CLAUDE_EXTRA_ARGS` | _(unset)_   | Extra flags appended to Claude Code (e.g. `--dangerously-skip-permissions`). |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | _(unset)_ | Web Push keys. Generate with `npm run gen-vapid`. Push is disabled without them. |
| `VAPID_SUBJECT`   | `mailto:admin@codepipe.local` | Contact URI sent with push (a `mailto:` or `https:` URL). |
| `LOG_LEVEL`       | `info`        | `debug`, `info`, `warn`, `error` or `fatal`. |
| `LOG_MAX_BYTES`   | `10485760`    | Rotate `server.log` at this size (5 old files kept). |
| `HEALTH_INTERVAL_MS` | `600000`   | How often a health sample is logged. |
| `HEALTH_RSS_WARN_MB` | `1500`     | Log a warning when memory use passes this. |
| `CLI_STUCK_NOTICE_MINUTES` | `15` | Minutes a CLI may be silent mid-reply before the chat is told it may be stuck. |
| `CODEPIPE_CWD`    | `server/`     | (`npm run serve` only) Folder the server runs in, which is where its `data/` lives. |

`GET /api/health` reports server status plus, for each registered provider, the resolved binary and whether it appears to be installed — useful for catching a missing CLI before creating a session.

## Features

- Chat-style UI with conversation sidebar, message bubbles, and markdown rendering
- Multiple providers — Kiro CLI, Claude Code, and Antigravity CLI — behind one interface
- **AI team with daily standups** — configurable personas review your per-project ideas list on a schedule and message you with proposals and questions, each with their own name and avatar (see [Your AI team](#your-ai-team-personas--standups))
- **Headless runs** — `POST /api/sessions/:id/run` sends a message and returns the turn's final response, no WebSocket needed (the orchestration primitive behind standups)
- Structured output parsing (ACP / stream-json) for reliable messages, tool calls, and turn boundaries, with a text-parsing fallback
- Multiple concurrent sessions, each scoped to a project directory
- **Changes tab** — every uncommitted file in the chat's project (staged, unstaged, untracked) with +/- counts and an inline diff; refreshes when the agent finishes a turn
- **Terminal tab** — a real shell (PowerShell on Windows, `$SHELL` elsewhere; override with `CODEPIPE_SHELL`) in the project folder. It keeps running across tabs, reloads and devices, and replays its scrollback when you reconnect; a key bar adds Tab/Esc/Ctrl+C/arrows on phones
- **Stop button** to cancel an in-flight turn, and input **queueing** so messages sent mid-turn run in order instead of interrupting
- **Per-session model selection** — a dynamic dropdown for providers that advertise their models (Kiro, Antigravity), a free-text override for those that don't (Claude Code)
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
- **Standups**: enable per project in project settings (toggle + hour). Each
  run is an ephemeral **review pipeline**, not a resumed conversation: every
  non-lead persona takes an independent look at each new idea in its own
  fresh, read-only session (their `take` — one point, chosen well — lands on
  the idea's card and the throwaway session is deleted), then the lead
  synthesizes takes + agenda + memo in a dated session ("project standup ·
  Sep 2") that you can watch and reply to that day. Proposals land on ideas
  with a summary, approach, effort, and execution brief.
- **Continuity is state, not chat history**: the board, takes, and briefs
  persist; the team ends each standup with a **memo** (their handoff note,
  injected into the next run); and events between standups — action items you
  resolve, builds that ship — queue on an **agenda** the next standup
  acknowledges in one turn instead of a CLI turn each.

**Cost control**: a standup is skipped when the ideas list hasn't changed and
the agenda is empty (and scheduled runs happen at most once per day per
project, with catch-up after sleep). "Run standup" in the Ideas panel forces
one immediately; with an empty list it asks the team to review the project
itself. Manual runs return as soon as the pipeline is dispatched — results
arrive as persona notifications. Sessions are bounded by construction, so
there is nothing to rotate.

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

- **Kiro**: the models come from `kiro-cli chat --list-models`, narrowed to a
  short list (Auto, Opus, Sonnet, GPT 5.6). Kiro's default engine ignores
  `--model`, so picking a specific model runs that chat on Kiro's v3 engine;
  **Auto** stays on the default engine, which shows tool activity and credits.
- **Antigravity**: the models come from `agy models`, and the choice is passed
  via `--model` on each message, so switching needs no restart.
- **Claude Code**: the CLI has no command to enumerate models, so the picker
  offers Claude Code's documented aliases — `sonnet`, `opus`, `haiku`, `fable`
  (each always maps to the current version), a pinned **Opus 5.5**
  (`claude-opus-5-5`) — plus a **Custom…** option to pin
  a full model id (e.g. `claude-sonnet-4-6`). The choice is passed via `--model`
  on the next message. These aliases live in the Claude adapter, so updating
  them is a one-line change rather than a UI edit.

Your selection is saved per session and applied automatically when you resume.

## Stopping a response

While an agent is working, the send button becomes a **Stop** button. Stopping
cancels the in-flight turn and clears anything queued. Messages you send while
the agent is still working are queued and run in order rather than interrupting
the current turn.
