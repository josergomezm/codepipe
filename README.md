# CodePipe

A web app that makes AI CLI tools look and feel like a chat application.

CodePipe wraps terminal-based AI agents — Kiro CLI, Gemini CLI, Claude Code, and eventually Codex — in a clean messaging interface. You get conversation history, multiple concurrent sessions, project-scoped workspaces, and markdown-rendered output, all while running the real CLI tools under the hood.

## How It Works

The backend spawns CLI processes using `node-pty` and parses their raw terminal output with `xterm-headless`. A WebSocket connection streams the parsed output to a Vue frontend that renders it as chat bubbles. User input goes back through the WebSocket to the terminal as keystrokes. Each conversation is a live terminal session tied to a specific project directory and AI provider.

## Tech Stack

**Backend** — Node.js, TypeScript, Express, `ws`, `node-pty`, `xterm-headless`

**Frontend** — Vue 3, Tailwind CSS, Vite, Pinia

**Storage** — JSON files (one per session, lightweight and portable)

## Supported Providers

| Provider    | Status  |
|-------------|---------|
| Kiro CLI    | First   |
| Gemini CLI  | Next    |
| Claude Code | Planned |
| Codex       | Future  |

Each provider has a dedicated adapter that handles its specific output patterns, prompt detection, and message parsing.

## Features

- Chat-style UI with conversation sidebar and message bubbles
- Multiple concurrent sessions (different terminals running in parallel)
- Project selector — pick a directory for the CLI to work in
- Persistent session history saved as JSON
- Markdown rendering for assistant output
- Typing indicator while the CLI is producing output
- Live and archived session states

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
