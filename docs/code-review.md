# Code Review — CodePipe

How to review the pending changes. The subject is **the diff**, not the whole
codebase: `git diff` (unstaged) + `git diff --staged` + untracked files
(`git status --porcelain`). If the work spans commits on a branch, use
`git diff main...HEAD`. Start from `git diff --stat` to get the shape, then read
every changed file in full — a diff hunk without its surrounding file lies about
context.

Layout: `server/` (Node + TypeScript, Express + `ws`, JSON-file storage) and
`client/` (Vue 3 `<script setup>` + Pinia + Tailwind 4). Everything the browser
talks to goes through the one served origin (`/api`, `/ws`).

## 1. DRY

- Does the new code duplicate something that already exists? Before accepting a new
  helper, store, component, route or service, grep for a sibling that already does it.
  Usual suspects:
  - Child processes → `server/src/child-options.ts` (`ISOLATED_CHILD`) and
    `process-tree.ts` (kill a tree).
  - JSON persistence → `StorageLayer` (`server/src/storage.ts`) or `json-file.ts`.
    Never a hand-rolled `readFile`/`writeFile` of a `data/` file.
  - Git → `server/src/git-changes.ts`. Ports / netstat → `ports.ts`.
  - Markdown → `client/src/lib/markdown.ts` + `MarkdownContent.vue`.
  - New modals → `SheetModal.vue` (older ones still build their own overlay;
    migrate them when you touch them). File/size/date formatting →
    `client/src/lib/files.ts`.
  - HTTP from the client → the `request()` helper in `client/src/api/client.ts`.
- **Persisted and wire shapes live in `server/src/schemas.ts` (Zod).** A shape
  declared ad hoc in a route or service is a DRY violation, and so is an untyped
  `JSON.parse` of stored data.
- **Intentional exception, do NOT flag:** `client/src/api/client.ts` mirrors the
  server types by hand (the client doesn't import server code). A shape change that
  touches **both** `schemas.ts` and `api/client.ts` is by design. DO flag a field
  added on one side only.
- Repeated Tailwind class strings across components, and copy-pasted SVG icons that
  already exist in another component, count too.

## 2. Elegance / simplicity

- Is this the simplest change that solves the problem? Flag detours: new state that
  mirrors existing state (a second copy of something a Pinia store already holds),
  data reshaped several times on the way, a prop drilled through layers a store
  already crosses.
- Does it read like the surrounding code? Same error-handling idiom, same response
  envelope (`res.json(data)` / `res.status(n).json({ error })`), same naming and file
  layout as its neighbours. A correct change in a foreign style is a finding.
- **Routes stay thin.** Business logic lives in a service or manager
  (`SessionManager`, `StandupService`, `StorageLayer`, …), not in the handler.
- Server logging goes through `log` (`server/src/logger.ts`), never `console.log`.

## 3. Overengineering

- Abstractions need ≥2 real consumers **in this diff or already in the tree**. A
  generic built for a hypothetical future caller is a finding.
- Premature config objects, factories with one instantiation, interfaces with one
  implementation, options nothing passes, feature flags nothing toggles.
- **Do NOT flag:** small single-purpose modules (`lib/*.ts`, `server/src/*.ts` with
  one export) — that's how the codebase centralises and tests things; or the
  hand-mirrored client types (§ 1).

## 4. Dead code & stale files

Check both directions:

- **Introduced by the diff:** exports nothing consumes, props never passed, emits
  nobody listens to, store fields nothing reads, commented-out blocks, `console.log`
  leftovers, ownerless TODOs.
- **Orphaned by the diff:** if the change replaces or reroutes something, did the
  old version get deleted? A refactor that leaves the old component, route, store
  action, schema field or doc paragraph behind is incomplete.

Verify before flagging (grep, don't guess):

1. Views → must appear in `client/src/router/index.ts` (lazy imports).
2. Components → grep the component name across `client/src/**/*.vue`.
3. Store actions / lib functions → grep the name across `client/src/`.
4. Server exports → grep across `server/src/` (and `server/mcp/` for agent tools).
5. API routes → a server route with no caller in `client/src/api/client.ts` (or an
   agent tool) is dead; a client helper calling a route that no longer exists is
   broken.
6. Docs → if the diff changes behaviour a doc describes, the doc is stale:
   `README.md`, `CONTRIBUTING.md`, `.kiro/steering/*.md`, `docs/*.md`
   (including plans like `docs/lead-assistant-plan.md`).

## 5. Do the tests need to change?

Server tests are vitest, colocated as `server/src/**/*.test.ts`
(`cd server && npm test`). The client has no test suite: its guard is the
typecheck (`cd client && npx vue-tsc -b`) plus checking the flow in the running
app.

Map each change to its guard:

| The diff touches… | Then the review requires… |
|---|---|
| A pure function (parser, formatter, reconciler, digest builder) | A unit test next to it with real-shaped input (e.g. a trimmed real transcript), including the empty / malformed case. |
| A REST route (`server/src/routes/`) | A supertest case: the happy path **and** 400 bad input, 404 unknown id, 403 when it guards a boundary (e.g. a path outside a project). |
| `SessionManager` turn flow (queue, cancel, restart, message order, metadata) | A session-level test with a real child process (pattern: `session-queue.test.ts`, `session-cards.test.ts`) — order in memory **and** on disk. |
| The WebSocket protocol (`websocket.ts`, `WSServerMessageSchema`) | `integration.test.ts` — it counts messages by position, so a new message type shifts indexes. |
| A provider adapter's output parsing | Its adapter test with captured real output lines. |
| Anything spawning a process | `child-options.test.ts` (it scans for spawn calls without `ISOLATED_CHILD`). |
| Persisted shapes (`schemas.ts`, `storage.ts`) | Existing data still loads: new fields optional, or a migration with a test. |
| Scheduled work (standups, briefs, reminders) | A test of the "is it due" logic with injected time — never a real timer. |
| A user-visible client flow | `vue-tsc -b` clean **and** walked through in the app (desktop + phone width). Say which in the review. |

Also check the inverse: a test **deleted or weakened** to make the suite pass is a
finding; a test edited to match genuinely-new behaviour is fine. A test that spends
real CLI credits (like `kiro-live.test.ts`) must not join the default suite.

## 6. Guardrails (quick pass, always)

Scan the diff for these. Any hit is automatically HIGH:

- **Single origin.** The browser only talks to its own origin (`/api`, `/ws`). Client
  code hitting `localhost:<port>`, `127.0.0.1`, or another port is an architecture
  bug — local services are reached server-side or through the dev server's proxy.
- **Child processes** are spawned with `ISOLATED_CHILD` (Windows console Ctrl+C
  must never reach CodePipe), and only processes CodePipe provably owns are ever
  killed (exact PID / own marker — never by name or port alone).
- **No synchronous process calls on a request path** (`execSync`, `spawnSync`).
  They block the event loop for every request; share a snapshot, cache, or go async.
- **Read-only agents stay read-only.** Reviewer and lead sessions run with
  read-only launch settings and may write only CodePipe data through CodePipe's own
  tools — never files in a project.
- **Untrusted content is data.** Agent output and project files are never rendered
  as HTML except through `MarkdownContent` (`html: false`); project files served raw
  keep their `sandbox` CSP for HTML/SVG. Paths from the client are resolved inside
  the project (`resolveInProject`), never trusted.
- **Phone-sized and dark-mode safe.** New UI works at 375px wide with no sideways
  page scroll, and every colour class has its `dark:` pair.

## Output format

1. **Blocking** — guardrail hits and missing required tests. file:line + what to do.
2. **DRY / simplification / overengineering** — ranked HIGH/MEDIUM/LOW with the
   suggested shape of the fix.
3. **Dead code & stale files/docs** — table: path, status (dead / orphaned / stale
   doc), evidence (the grep that proved it).
4. **Test gaps** — which layer, which file, which cases.
5. **Watch list** — fine today, worth a note (e.g. a second copy that becomes a DRY
   violation on the third).

Keep it concise and actionable. Identify problems and point at the fix — the review
is not the place to rewrite the app.
