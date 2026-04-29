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

CodePipe binds to localhost only. For remote access, use Tailscale serve to proxy the local port to your tailnet. No auth layer is built into the app — Tailscale handles that.

## Storage

JSON file-based storage. One file per session, one config file for projects. Simple and sufficient for the expected scale (hundreds of conversations, not thousands). Can be swapped for a database later if needed, but unlikely to be necessary.
