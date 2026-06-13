# CodePipe — Architecture Review, Parsing Rewrite & Open-Source Readiness

_Review date: 2026-06-12. Scope: full repo (server + client + specs). Headline recommendation: replace the regex-based CLI output parser with a structured protocol client (ACP for Kiro), the same class of approach Claude Code exposes via `--output-format stream-json`._

---

## 1. Executive summary

CodePipe is in good shape as an MVP. The architecture is clean: a pluggable adapter interface, a `SessionManager` that owns process lifecycle, Zod-validated schemas end to end, a debounced JSON storage layer, and a Vue front end with reconnect logic and per-session race guards. The test surface is real (≈120 cases across schemas, storage, adapters, and integration).

The single biggest weakness is exactly the one you named: **CLI response parsing.** Today the Kiro adapter scrapes human-readable terminal text line by line with a pile of regexes (`kiro-patterns.ts`) plus a multi-pass ANSI-fragment scrubber (`strip-ansi.ts`). This is inherently fragile — it guesses message boundaries, classifies tool output by eyeballing glyphs (`✓`, `●`, `↱`, `⋮`), and detects the CLI's session ID by regex-matching `--list-sessions` output. Any wording or formatting change in the CLI silently breaks it.

The fix is not "better regexes." It's to stop parsing display output and consume a **structured event stream** instead. Kiro CLI already speaks **ACP (Agent Client Protocol)** — JSON-RPC 2.0 over stdio with typed `AgentMessageChunk`, `ToolCall`, `ToolCallUpdate`, and `TurnEnd` events, plus native `session/new` / `session/load` / `session/cancel`. Adopting ACP deletes the entire heuristic layer, gives you exact message boundaries, real tool-call status, native multi-turn sessions, and a stop button — and because ACP is a cross-editor standard (Zed, JetBrains, Gemini CLI, and others implement it), it makes the adapter layer genuinely provider-agnostic rather than a per-CLI scraper.

Everything else in this document is secondary to that change, but several items are real open-source blockers — most urgently the hardcoded Windows-only binary name `kiro-cli.exe` (the app cannot run on the macOS/Linux machines most contributors use) and a hardcoded personal Tailscale hostname committed in `client/package.json`.

**Priority order:** (1) ACP parsing rewrite, (2) cross-platform + config fixes, (3) OSS hygiene (LICENSE file, CONTRIBUTING, CI, Docker), (4) reliability hardening (cancel, queueing, health check, storage scaling), (5) frontend polish.

---

## 2. The parsing problem — root-cause analysis

### What happens today

For Kiro (the only wired-up provider), each user message spawns a short-lived `kiro-cli.exe chat --no-interactive --trust-all-tools --wrap never <prompt>`. The `SessionManager` reads stdout, runs `stripAnsi`, splits on `\n`, and hands each line to `KiroAdapter.onData`, which decides per line whether it is:

- a credits line (`▸ Credits: … • Time: …`) → `message_complete`,
- a tool line (matched against ~18 regexes and glyph prefixes) → `tool_use`,
- otherwise assistant text → `chunk` (after stripping a leading `> `).

### Why it's fragile

The output being parsed is a **rendering meant for humans**, not a contract. Concretely:

- **Message boundaries are guessed.** There is no reliable "assistant turn started/ended" signal, so completion is inferred from a credits line that "sometimes appears in stdout too" (per the code comments). Streaming chunks are re-joined with `'\n'`, which can mangle whitespace and wrapped prose; `--wrap never` is a band-aid.
- **Tool detection is glyph-spotting.** Lines are classified as tool output by leading `✓ / ● / ↱ / ⋮` and phrases like `"I'll modify the following file:"`. This both misfires on assistant prose that happens to start with those characters and misses any output the regex list doesn't anticipate. There is no tool name, no parameters, no success/failure status — only a best-effort `lastToolName`.
- **ANSI handling is heuristic.** `strip-ansi.ts` runs a second and third pass to catch escape sequences split across PTY/pipe chunks (`"5;252m"` orphan tails). Necessary today, but it's defensive guessing against a stream that shouldn't need it.
- **Session ID detection is a second scrape.** After the first message, the manager spawns `kiro-cli chat --list-sessions` and regex-matches `Chat SessionId: <uuid>`. Brittle, and an extra process per session.
- **`validateAdapterEvents` silently drops** anything that fails the Zod shape — so a malformed parse can quietly lose assistant content rather than surface an error.

This is the same wall every "wrap a TUI" project hits. The way modern agentic CLIs solve it — and the thing you're reaching for when you say "like Claude Code" — is a **machine-readable output mode**.

### How Claude Code does it (for reference)

Claude Code exposes `claude -p "…" --output-format stream-json --verbose`, which emits newline-delimited JSON events (`system/init`, `assistant` message deltas, `tool_use`, `result` with usage/cost). You read NDJSON, not screen text. No glyph spotting, exact boundaries, real tool metadata, real token/cost accounting. When CodePipe adds a Claude Code adapter, that's the path.

### How Kiro does it — ACP

Kiro CLI doesn't have a JSON flag on `--no-interactive` (its headless flags are only `--no-interactive`, `--trust-all-tools`, `--trust-tools`, `--require-mcp-startup`). But it ships something better: **`kiro-cli acp`**, an Agent Client Protocol server speaking JSON-RPC 2.0 over stdin/stdout. This is what Zed and JetBrains use to drive Kiro. It is a bidirectional, persistent, structured protocol — strictly more capable than a one-shot JSON dump.

ACP maps almost one-to-one onto CodePipe's existing `AdapterEvent` model:

| CodePipe today (guessed)        | ACP (structured)                          | Win                                                        |
| ------------------------------- | ----------------------------------------- | ---------------------------------------------------------- |
| `chunk` (regex, `\n`-joined)    | `AgentMessageChunk` notification          | Exact streamed text, no re-joining or `> ` stripping       |
| `tool_use` (glyph spotting)     | `ToolCall` + `ToolCallUpdate`             | Real tool name, params, and running/complete/failed status |
| `message_complete` (credits)    | `TurnEnd` notification                    | Deterministic end-of-turn; no credits-line sniffing        |
| `--list-sessions` regex scrape  | `session/new` returns `sessionId`         | Session ID handed to you; delete the scraper entirely      |
| `--resume-id` re-spawn          | `session/load` (advertises `loadSession`) | Native multi-turn resume on a persistent process           |
| _no cancel_                     | `session/cancel`                          | A working Stop button                                      |
| attachment as `@path` string    | `session/prompt` `content[]` w/ image     | Native image/multimodal input (`promptCapabilities.image`) |
| _none_                          | `_kiro.dev/commands/*`                     | Slash commands, MCP/OAuth events (optional extensions)     |

ACP sessions persist to the same `~/.kiro/sessions/cli/` directory the adapter already knows about, now with a `<id>.jsonl` event log alongside the `<id>.json` metadata.

### Recommended design

Move from "spawn-per-message + scrape" to **one persistent `kiro-cli acp` process per CodePipe session**, wrapped in a JSON-RPC client.

1. **Add a small ACP client module** (`server/src/acp/client.ts`): frame JSON-RPC 2.0 messages over the child process's stdio, correlate request IDs to promises, and emit `session/notification` updates as typed events. This is ~150 lines and reusable across every ACP-speaking CLI.
2. **Reshape the adapter contract** around protocol events rather than raw text. Keep `AdapterEvent` as the normalized output, but have the adapter translate ACP notifications instead of implementing `onData(cleanText)`. Introduce a capability flag (e.g. `transport: 'acp' | 'pty' | 'oneshot-json'`) so the `SessionManager` knows how to drive each provider. The PTY/non-interactive paths stay for CLIs that don't speak a protocol yet.
3. **Lifecycle:** on session create → `initialize` → `session/new` (store the returned `sessionId` directly, deleting `detectCliSessionIdFromList`). On message → `session/prompt`. On reconnect/revive → `session/load`. On stop → `session/cancel`. On delete/shutdown → terminate the process.
4. **Delete** `kiro-patterns.ts`, the glyph/credits regex layer, and most of `strip-ansi.ts`'s defensive passes (ANSI is irrelevant on a JSON-RPC channel). Keep a thin strip-ansi only for any legacy PTY adapter.
5. **Tests get easier and deterministic:** replay recorded JSON-RPC frames instead of recorded terminal dumps. Convert `kiro-live.test.ts` to drive real `kiro-cli acp` and assert on typed events.

This is a contained, high-leverage change: the public `AdapterEvent` type and the front end barely move, while the fragile internals get replaced by a typed contract.

> Note on auth: ACP runs under your normal interactive Kiro credentials (no API key required), unlike `--no-interactive` headless mode, which the docs say needs `KIRO_API_KEY` (Pro/Pro+/Power). Worth confirming against your local `kiro-cli acp` before committing — run it once and capture an `initialize` exchange.

---

## 3. Gap analysis

Severity: **P0** blocks open-sourcing / breaks on other machines · **P1** important reliability or UX · **P2** polish.

### Correctness & reliability

- **P0 — Hardcoded `kiro-cli.exe`.** `KiroAdapter.command = 'kiro-cli.exe'` only resolves on Windows. On macOS/Linux (your machine, and most contributors') the binary is `kiro-cli`. Resolve the binary per-platform, or via config/`which`, or accept a full path. This alone prevents the project running for most people.
- **P1 — No cancel / interrupt.** Once a message is in flight there's no way to stop it; the only "stop" is sending a new message, which kills the in-flight child and silently drops its response. ACP `session/cancel` fixes this.
- **P1 — No input queueing / busy state.** Sending while the CLI is still responding kills the previous process. Either queue messages or reject input with a clear "still working" state until `TurnEnd`/idle.
- **P1 — Silent event drops.** `validateAdapterEvents` discards invalid events with only a warn log; under a parser regression this loses user-visible content with no signal. At minimum surface a system message when drops happen.
- **P2 — Chunk concatenation.** Assistant chunks are joined with `'\n'`; with a real streamed protocol, append exact substrings instead so formatting/whitespace is preserved and you can render markdown incrementally.

### Security & trust boundary

- **P1 — `--trust-all-tools` is the only mode.** The CLI auto-approves every tool call (file writes, shell, MCP). That's reasonable for a localhost dev tool but must be loud in the README and ideally configurable (`--trust-tools=read,grep` for a safer default). ACP also lets you surface tool calls for approval in the UI later.
- **P1 — No auth, even over Tailscale.** Documented as intentional (trust boundary = tailnet), which is fine, but anyone on the tailnet gets full code-execution on the host. Call this out explicitly in SECURITY.md and consider optional Tailscale-identity gating (already on the roadmap).
- **P2 — Path handling.** `formatAttachment` and project paths flow into spawned processes; with `shell: false` you avoid shell injection (good), but validate that project paths are within allowed roots before spawning.

### Cross-platform & config

- **P0 — Personal Tailscale host committed.** `client/package.json` → `"dev:remote": "set TAILSCALE_HOST=ks-mini.tail0293ef.ts.net && vite"`. This leaks your machine name and only works on Windows (`set` syntax). Move to a `.env`/config value and use a cross-platform runner (e.g. `cross-env`) or document the env var instead of hardcoding.
- **P1 — No config file.** Server port (5551), client port (5552), data dir, default provider, and binary paths are implicit. A single `codepipe.config.{json,yaml}` (or env vars) is needed before others can deploy it. Already on the roadmap — promote it.
- **P2 — Unused heavy deps.** `@xterm/headless` and `@xterm/addon-serialize` are dependencies but the current Kiro non-interactive path doesn't use them (reserved for future PTY adapters). Either wire them up or drop them to slim install size; note the design doc still describes an xterm-headless parsing path that the code no longer takes.

### Session management

- **P1 — Session-ID detection via `--list-sessions` scrape** disappears entirely under ACP (`session/new` returns it). High-value cleanup.
- **P2 — Auto-title & rename.** Titles are auto-generated (`New kiro session`); `RenameSessionRequestSchema` exists but the roadmap lists rename/auto-title as unbuilt. Cheap, high-perceived-value.

### Storage & scaling

- **P1 — Verify append cost.** Confirm whether `appendMessage` rewrites the entire session file each call (common with JSON-file stores). If so, long sessions get O(n²) write behavior. The ACP `.jsonl` event-log model is a good template — append-only lines, plus a small index file for fast listing (both on the roadmap).
- **P2 — No pagination.** Whole message history is sent on connect (`type: 'history'`). Fine now; paginate before large sessions.

### Frontend

- **P2 — Markdown only renders on completion.** Streaming shows raw text, then re-renders. Acceptable, and a stable chunk stream would let you render incrementally. `markdown-it` is correctly configured with `html: false` (XSS-safe) — keep it.
- **P2 — Roadmap polish items** (syntax highlighting, copy-code button, keyboard shortcuts, mobile layout, tool-call expandable panels) become much easier once ACP gives you structured tool calls with status.

### Testing & CI

- **P1 — No CI.** There's a real test suite but nothing runs it on push. A GitHub Actions workflow (lint + typecheck + `vitest run` on server, `vue-tsc` build on client, matrix over OS) is table stakes for OSS.
- **P2 — Adapter snapshot/replay harness.** On the roadmap; trivial and far more robust once inputs are JSON-RPC frames rather than terminal dumps.

---

## 4. Open-source readiness checklist

You already have an MIT license declared in `server/package.json` and a clear README. To be a project others can adopt and contribute to:

**Repository hygiene (P0–P1)**

- [ ] **`LICENSE` file** at repo root (currently only declared in package.json — needs the actual file).
- [ ] **`CONTRIBUTING.md`** — dev setup, how to run, how to add an adapter, test/PR expectations.
- [ ] **`CODE_OF_CONDUCT.md`** (Contributor Covenant is the standard).
- [ ] **`SECURITY.md`** — explicit trust model (localhost/tailnet, `--trust-all-tools` implications), how to report vulnerabilities.
- [ ] **Issue/PR templates** under `.github/`.
- [ ] **`CHANGELOG.md`** + semantic-version release tags.
- [ ] Remove personal data (Tailscale hostname) and add a root `package.json` with workspace scripts so `npm install && npm run dev` works from the top.

**CI / release (P1)**

- [ ] GitHub Actions: typecheck, lint, server tests, client build — matrix on macOS/Linux/Windows (catches the `.exe` class of bug).
- [ ] Optional: prebuilt release artifacts and a `Dockerfile` (roadmap) for one-command run.

**Product completeness for adopters (P1–P2)**

- [ ] **Provider auto-detection + health checks** — detect which CLIs are installed (`which kiro-cli`/`claude`/`gemini`), only show available providers, verify the binary responds before creating a session. Currently a hard 404-style failure path.
- [ ] **Config file / env** for ports, data dir, binary paths, default provider.
- [ ] **`GET /api/health`** endpoint (roadmap) for monitoring and the health checks above.
- [ ] **First-run experience** — a short "install a supported CLI, then…" flow; today a fresh clone with no CLI installed fails opaquely.

**Docs & discoverability (P2)**

- [ ] Screenshots / a short demo GIF in the README (huge for adoption).
- [ ] An **adapter authoring guide** — the pluggable adapter system is the project's best selling point; document "implement an ACP/PTY/JSON adapter in N steps."
- [ ] Move the `.kiro/specs` and steering docs into `docs/` (or keep, but link them) so the design rationale is discoverable.
- [ ] Opt-in, clearly-disclosed telemetry only — never on by default (roadmap already says opt-in; good).

---

## 5. Suggested roadmap (phased)

**Phase 1 — Fix the foundation (this is the headline).**
ACP client module → reshape adapter contract around protocol events → port Kiro to `kiro-cli acp` → delete `kiro-patterns.ts`, the `--list-sessions` scraper, and the ANSI second-pass hacks → add `session/cancel` (Stop button) and native `session/load` resume. Convert adapter tests to JSON-RPC replay.

**Phase 2 — Make it run anywhere.**
Cross-platform binary resolution (kill `.exe`), config file + env, remove the hardcoded Tailscale host, provider auto-detection + health checks, `/api/health`.

**Phase 3 — OSS launch hygiene.**
LICENSE/CONTRIBUTING/SECURITY/CoC files, GitHub Actions CI (OS matrix), issue templates, README screenshots, adapter authoring guide, Docker.

**Phase 4 — Reliability & scale.**
Input queueing/busy state, surface dropped-event errors, append-only storage + session index + pagination, graceful shutdown polish.

**Phase 5 — Provider breadth & polish.**
Claude Code adapter via `--output-format stream-json` (or ACP), Gemini CLI (also ACP-capable), then the UI polish set: structured tool-call panels, syntax highlighting, copy-code, rename/auto-title, keyboard shortcuts, mobile layout.

### Quick wins you can land today (low effort, high signal)

- Replace `kiro-cli.exe` with platform-aware resolution.
- Strip the personal Tailscale host out of `client/package.json`.
- Add the `LICENSE` file and a one-line `GET /api/health`.
- Add a GitHub Actions workflow running the existing tests.
- Surface a system message when `validateAdapterEvents` drops anything, instead of only logging.

---

_The ACP rewrite is the change that makes everything downstream easier — structured tool calls feed the UI, deterministic turn boundaries feed storage and status, native sessions delete two brittle subsystems, and a standard protocol turns "adapters" from bespoke scrapers into thin protocol clients. I'd start there._
