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

## Networking

CodePipe runs on localhost. For remote access, use [Tailscale serve](https://tailscale.com/kb/1242/tailscale-serve) to securely expose it to your tailnet — no built-in auth needed.
