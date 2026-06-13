# Contributing to CodePipe

Thanks for your interest in improving CodePipe! This guide covers local setup
and how to add support for a new AI CLI.

## Prerequisites

- Node.js 22+
- One or more supported AI CLIs installed and authenticated (`kiro-cli`,
  `claude`, and/or `gemini`) if you want to run end-to-end.

## Local setup

```bash
# Backend
cd server
npm install
npm run dev        # tsx watch on http://127.0.0.1:5551

# Frontend (in another terminal)
cd client
npm install
npm run dev        # Vite on http://127.0.0.1:5552
```

Open http://127.0.0.1:5552. To choose Kiro's structured transport, start the
backend with `KIRO_TRANSPORT=acp npm run dev`. See the README's Configuration
section for all env vars.

## Tests & checks

```bash
cd server
npm test                  # vitest (unit + integration)
npx tsc --noEmit          # typecheck
```

The live test `src/adapters/kiro-live.test.ts` spawns the real `kiro-cli` and
consumes credits — run it intentionally, not as part of the default suite.

CI runs typecheck + tests on Linux/macOS/Windows and builds the client; please
make sure `npm test` and `tsc --noEmit` pass locally before opening a PR.

## Project layout

```
server/src/
  adapters/      # one ICLIAdapter per provider + output parsers
  acp/           # Agent Client Protocol: jsonrpc codec, client, driver, profiles
  session-manager.ts   # process lifecycle, queueing, event → message pipeline
  websocket.ts   # WS protocol; storage.ts; routes/
client/src/      # Vue 3 + Pinia + Tailwind chat UI
```

## Adding a new provider adapter

A provider is a class implementing `ICLIAdapter` (`server/src/adapters/types.ts`),
registered in `server/src/index.ts`. The adapter's job is to turn a CLI's output
into normalized `AdapterEvent`s (`chunk`, `tool_use`, `message_complete`,
`thinking`, `cli_session`, …). Pick the transport that matches the CLI:

### 1. The CLI speaks ACP (preferred)

If the tool can run as an Agent Client Protocol agent (like `gemini --acp` or
`kiro-cli acp`), you usually don't write a parser at all:

1. Add an `AcpProfile` in `server/src/acp/profile.ts` describing its launch
   args, JSON-RPC method names, and any post-session setup (e.g. an
   auto-approve mode).
2. Create an adapter with `transport = 'acp'`, `command` = the binary, and
   `acpProfile` = your profile. Make `onData`/`notify*`/`reset` no-ops.
3. Register it in `index.ts`.

The shared `AcpSessionDriver` handles spawning, the handshake, sessions,
streaming, cancellation, and permission prompts. Streaming updates are
translated by `acp/protocol.ts` (`translateSessionUpdate`) — extend it if your
agent emits update shapes it doesn't yet cover.

### 2. The CLI has a structured/JSON output mode

Like Claude Code's `--output-format stream-json`. Implement a pure translator
(`line: string => AdapterEvent[]`) — see `adapters/claude-stream-json.ts` —
and an adapter with `nonInteractive = true` whose `onData` calls it and whose
`buildMessageCommand` builds the per-message invocation. Report the CLI's
session ID inline via a `cli_session` event so multi-turn resume works without
scraping.

### 3. The CLI only has human/TUI output (last resort)

Parse its text in `onData`. This is what `adapters/kiro.ts` +
`adapters/kiro-patterns.ts` do, and it's inherently fragile — prefer 1 or 2 if
the tool supports them.

### In all cases

- Make the binary name overridable via an env var and platform-aware (don't
  hardcode `.exe`).
- Add unit tests for your translator/profile — they're pure functions and easy
  to cover with recorded frames/lines. See `acp/*.test.ts` and
  `adapters/claude.test.ts` for patterns.
- Note any auto-approval behavior in `SECURITY.md`.

## Pull requests

Keep PRs focused, include tests for new logic, and describe how you verified
against a real CLI (or note that you couldn't). Be kind in review threads.
