# CodePipe — Product Overview

CodePipe is a web application that wraps AI-powered CLI tools (Kiro CLI, Gemini CLI, Claude Code, Codex) in a chat-style interface. Instead of interacting with these tools through a raw terminal, users get a familiar messaging UI — conversation sidebar, chat bubbles, typing indicators, markdown rendering.

## Why

Terminal-based AI agents are powerful but the UX is rough. You lose conversation history when you close the terminal, you can't easily manage multiple sessions, and the raw ANSI output isn't pleasant to read. CodePipe solves this by putting a chat frontend on top of the real CLI tools, keeping all their capabilities intact.

## How It Works

The backend spawns actual CLI processes using `node-pty` and parses their terminal output with `xterm-headless`. A WebSocket connection streams parsed output to a Vue frontend that renders it as chat messages. User input typed in the browser gets sent back through the WebSocket to the pty as keystrokes.

Each conversation is a live terminal session running one of the supported CLI tools in a specific project directory.

## Core Concepts

- **Session**: A single conversation with an AI CLI tool. Has a provider (Kiro/Gemini/Claude/Codex), a project path, and a message history. Sessions can be live (pty running) or archived (pty exited, history preserved).
- **Project**: A named reference to a directory path on the host machine. When starting a session, the CLI spawns with that directory as its working directory.
- **Provider**: One of the supported AI CLI tools. Each provider has its own adapter that knows how to parse its specific output patterns.
- **CLI Adapter**: A pluggable parser layer that understands a specific CLI's output format — prompt patterns, message boundaries, tool-use blocks, etc.

## Provider Priority

1. Kiro CLI (primary, developed first)
2. Gemini CLI
3. Claude Code
4. Codex (future)

## Networking

CodePipe binds to localhost only. For remote access, use Tailscale Serve to proxy local ports to your tailnet. No auth layer is built into the app — Tailscale handles that.

### Tailscale Setup

**Tailnet hostname**: Detected automatically at runtime via `tailscale cert`

**Ports**:
- Backend (Express + WebSocket): `5551`
- Frontend (Vite dev server): `5552`

**Running Tailscale Serve**:
```
tailscale serve 5552
```
This maps `https://<hostname>` → `http://127.0.0.1:5552`. Tailscale terminates TLS and proxies both HTTP and WebSocket traffic. CodePipe will auto-create this mapping if missing when you start a dev server.

**Starting the dev server for remote access**:
```cmd
set TAILSCALE_HOST=ks-mini.tail0293ef.ts.net & npm run dev
```
This enables Vite's HMR over the tunnel. Without `TAILSCALE_HOST` set, the dev server works normally for local development. When started via CodePipe's UI, these env vars are injected automatically.

**Multiple projects on one machine**: Use different Tailscale Serve HTTPS ports:
```cmd
tailscale serve --bg --https 443 http://127.0.0.1:5552
tailscale serve --bg --https 8443 http://127.0.0.1:5173
```
Set `TAILSCALE_PORT` to match the assigned HTTPS port for each project (defaults to `443` if unset). CodePipe creates these mappings automatically when starting a dev server.

### How HMR Works Over Tailscale

Vite's HMR WebSocket normally connects back to the same host/port that served the page. When behind Tailscale Serve, the browser loads the page over HTTPS on port 443, so the HMR client needs to know:
- Use `wss://` (secure WebSocket, since Tailscale terminates TLS)
- Connect to the Tailscale hostname (not localhost)
- Use port 443 (or the configured HTTPS port), not Vite's actual listen port

The `vite.config.ts` handles this via `TAILSCALE_HOST` and `TAILSCALE_PORT` environment variables. When unset, HMR uses its default behavior for local dev.

### Important Notes

- Tailscale Serve must be running (`tailscale serve status` to check)
- The Vite server must bind to `0.0.0.0` (already configured) so Tailscale can reach it
- `allowedHosts: true` is set in vite config — safe on a tailnet since only authenticated tailnet members can reach it
- The app's own WebSocket (`/ws` for pty streaming) is proxied by Vite to the backend on 5551, and this chain works through Tailscale since Vite handles the WS upgrade

## Storage

JSON file-based storage. One file per session, one config file for projects. Simple and sufficient for the expected scale (hundreds of conversations, not thousands). Can be swapped for a database later if needed, but unlikely to be necessary.
