# Tasks: CodePipe MVP

## Phase 1: Project Foundation & Shared Types

- [x] 1.1 Initialize backend project with TypeScript, Express, and ES modules
  - [x] 1.1.1 Create `server/` directory with `package.json` (type: module), `tsconfig.json` (strict), and install core dependencies: express, ws, node-pty, xterm-headless, zod, uuid
  - [x] 1.1.2 Create `server/src/index.ts` entry point with Express app and basic health check route (`GET /api/health`)
  - [x] 1.1.3 Add dev scripts: `dev` (tsx watch), `build` (tsc), `start` (node dist/index.js)
- [x] 1.2 Initialize frontend project with Vue 3, Tailwind, Vite, and Pinia
  - [x] 1.2.1 Scaffold `client/` directory with Vite + Vue 3 + TypeScript template
  - [x] 1.2.2 Install and configure Tailwind CSS with dark mode support (`class` strategy)
  - [x] 1.2.3 Install Pinia and Vue Router, create empty store and router files
  - [x] 1.2.4 Configure Vite proxy to forward `/api` and `/ws` requests to the backend dev server
- [x] 1.3 Define shared Zod schemas and inferred types
  - [x] 1.3.1 Create `server/src/schemas.ts` with all Zod schemas: ProviderTypeSchema, SessionStatusSchema, MessageRoleSchema, MessageStatusSchema, ChatMessageSchema, ChatMessageMetadataSchema, ProjectSchema, SessionSchema, SessionMetaSchema, WSClientMessageSchema, WSServerMessageSchema, CreateSessionRequestSchema, CreateProjectRequestSchema
  - [x] 1.3.2 Export inferred TypeScript types from schemas using `z.infer<>`
  - [x] 1.3.3 Write unit tests for schema validation: valid objects pass, invalid objects fail with correct error messages (test SessionSchema refinement for updatedAt >= createdAt)

## Phase 2: Storage Layer

- [ ] 2.1 Implement StorageLayer class
  - [ ] 2.1.1 Create `server/src/storage.ts` implementing `IStorageLayer` interface with JSON file operations
  - [ ] 2.1.2 Implement `ensureDataDir()` that creates `data/` and `data/sessions/` directories on startup if they don't exist
  - [ ] 2.1.3 Implement `atomicWrite(filePath, data)` using write-to-temp-then-rename pattern
  - [ ] 2.1.4 Implement project CRUD: `listProjects()`, `addProject()`, `removeProject()`, `getProject()` operating on `data/projects.json`
  - [ ] 2.1.5 Implement session CRUD: `saveSession()`, `getSession()`, `listSessions()` (metadata only, no messages), `deleteSession()`
  - [ ] 2.1.6 Implement `appendMessage(sessionId, message)` that loads session, appends message, updates `updatedAt`, and writes atomically
  - [ ] 2.1.7 Implement `updateSessionStatus(sessionId, status)` for transitioning live → archived
- [ ] 2.2 Add Zod validation to storage reads
  - [ ] 2.2.1 Validate loaded session data against `SessionSchema` on read, log and handle corruption gracefully
  - [ ] 2.2.2 Validate loaded project data against `z.array(ProjectSchema)` on read
- [ ] 2.3 Write storage layer tests
  - [ ] 2.3.1 Unit tests for project CRUD (add, list, get, remove)
  - [ ] 2.3.2 Unit tests for session CRUD (save, get, list metadata, delete)
  - [ ] 2.3.3 Unit tests for appendMessage (ordering, updatedAt update)
  - [ ] 2.3.4 Test atomic write behavior (verify temp file is used, original preserved on failure)
  - [ ] 2.3.5 Property-based test: session round-trip integrity (generate random Session objects with fast-check, save → load → compare)

## Phase 3: CLI Adapter System

- [ ] 3.1 Define adapter interface and registry
  - [ ] 3.1.1 Create `server/src/adapters/types.ts` with `ICLIAdapter` interface, `AdapterEvent` type union, and `AdapterFactory` type
  - [ ] 3.1.2 Create `server/src/adapters/registry.ts` with adapter registration map and `getAdapter(provider)` lookup
- [ ] 3.2 Implement Kiro CLI adapter
  - [ ] 3.2.1 Create `server/src/adapters/kiro.ts` implementing `ICLIAdapter` with Kiro CLI command, args, and prompt detection patterns
  - [ ] 3.2.2 Implement `onScreenUpdate()` with internal position tracking: diff new content from last processed position, detect prompt patterns, emit chunk/message_complete/prompt_detected events
  - [ ] 3.2.3 Implement `reset()` to clear internal parsing state
- [ ] 3.3 Write adapter tests
  - [ ] 3.3.1 Unit tests for Kiro adapter with recorded terminal output snapshots: verify correct AdapterEvent sequences for known output patterns
  - [ ] 3.3.2 Test prompt detection: verify prompt_detected is emitted when Kiro prompt pattern appears
  - [ ] 3.3.3 Test idempotent processing: same screen content passed twice produces no duplicate events
  - [ ] 3.3.4 Property-based test: adapter position monotonicity (generate random screen content sequences, verify lastProcessedPosition never decreases)

## Phase 4: Session Manager & WebSocket Server

- [ ] 4.1 Implement SessionManager
  - [ ] 4.1.1 Create `server/src/session-manager.ts` with in-memory session tracking map (`Map<string, SessionContext>`)
  - [ ] 4.1.2 Implement `createSession(provider, projectId)`: validate project, resolve adapter, spawn pty with node-pty, wire xterm-headless parser, register onExit handler, persist session
  - [ ] 4.1.3 Implement `handleInput(sessionId, text)`: create user ChatMessage, persist, broadcast, write to pty stdin
  - [ ] 4.1.4 Implement `processAdapterEvents(sessionId, events)`: process chunk/message_complete/prompt_detected/tool_use/thinking events, manage streaming message state, broadcast and persist
  - [ ] 4.1.5 Implement `attachClient(sessionId, socket)` and `detachClient(sessionId, socket)` for WebSocket client management
  - [ ] 4.1.6 Implement `getSession()`, `listSessions()`, `deleteSession()` delegating to storage with pty cleanup for live sessions
  - [ ] 4.1.7 Implement `shutdown()` to kill all pty processes and archive all live sessions
  - [ ] 4.1.8 Add PTY output debouncing (50ms) before screen serialization to batch rapid output
  - [ ] 4.1.9 Add storage write debouncing (500ms or on message completion) for message persistence
- [ ] 4.2 Implement WebSocket server
  - [ ] 4.2.1 Create `server/src/websocket.ts` with ws server attached to the Express HTTP server
  - [ ] 4.2.2 Implement connection handler: parse sessionId from query params, validate with SessionManager, attach client
  - [ ] 4.2.3 Implement history replay on connection: send `{ type: 'history' }` followed by current status
  - [ ] 4.2.4 Implement message handler: validate incoming messages with `WSClientMessageSchema.safeParse()`, route to SessionManager.handleInput
  - [ ] 4.2.5 Implement `broadcast(sessionId, message)`: iterate all attached clients for the session and send
  - [ ] 4.2.6 Implement disconnection cleanup: remove client from session's client set on socket close
- [ ] 4.3 Implement REST API routes
  - [ ] 4.3.1 Create `server/src/routes/sessions.ts` with session CRUD endpoints (GET list, POST create, GET detail, DELETE)
  - [ ] 4.3.2 Create `server/src/routes/projects.ts` with project CRUD endpoints (GET list, POST create, DELETE)
  - [ ] 4.3.3 Add Zod validation middleware for request bodies (CreateSessionRequestSchema, CreateProjectRequestSchema)
  - [ ] 4.3.4 Add path traversal validation for project paths (reject paths containing '..')
  - [ ] 4.3.5 Add project path existence check on creation (verify directory exists on disk)
- [ ] 4.4 Wire up server entry point
  - [ ] 4.4.1 Update `server/src/index.ts` to initialize StorageLayer, SessionManager, register adapters, mount REST routes, attach WebSocket server, bind to 127.0.0.1
  - [ ] 4.4.2 Add graceful shutdown handler (SIGINT/SIGTERM) that calls SessionManager.shutdown()
- [ ] 4.5 Write backend integration tests
  - [ ] 4.5.1 Test session creation via REST API with mocked pty (verify 201 response, session persisted)
  - [ ] 4.5.2 Test WebSocket connection and history replay
  - [ ] 4.5.3 Test user input flow: send via WebSocket → user message broadcast → pty write
  - [ ] 4.5.4 Test session deletion: live session → pty killed → archived; archived session → file deleted
  - [ ] 4.5.5 Test error cases: invalid provider, missing project, non-existent session

## Phase 5: Frontend — State & Composables

- [ ] 5.1 Implement Pinia stores
  - [ ] 5.1.1 Create `client/src/stores/sessions.ts` with session list, active session, messages, and status state; actions for fetchSessions, createSession, selectSession, deleteSession, upsertMessage
  - [ ] 5.1.2 Create `client/src/stores/projects.ts` with project list state; actions for fetchProjects, addProject, removeProject
- [ ] 5.2 Implement useSession composable
  - [ ] 5.2.1 Create `client/src/composables/useSession.ts` with WebSocket connection lifecycle: connect(sessionId), disconnect(), sendMessage(text)
  - [ ] 5.2.2 Handle incoming WebSocket messages: route 'history', 'message', 'status', 'error' to Pinia store actions
  - [ ] 5.2.3 Expose reactive state: isConnected, connectionError
  - [ ] 5.2.4 Implement auto-reconnect on unexpected disconnection (with backoff)
- [ ] 5.3 Create API client
  - [ ] 5.3.1 Create `client/src/api/client.ts` with typed fetch wrappers for all REST endpoints (sessions CRUD, projects CRUD)

## Phase 6: Frontend — UI Components

- [ ] 6.1 Build layout shell
  - [ ] 6.1.1 Create `App.vue` with two-panel layout (sidebar + main area) using Tailwind flex/grid
  - [ ] 6.1.2 Create `AppSidebar.vue` container component
  - [ ] 6.1.3 Set up Vue Router with a single route that renders `ChatView.vue`
- [ ] 6.2 Build sidebar components
  - [ ] 6.2.1 Create `SessionList.vue`: render sessions from Pinia store, sorted by updatedAt descending, with live/archived visual indicators
  - [ ] 6.2.2 Create `NewSessionButton.vue`: button that triggers session creation flow
  - [ ] 6.2.3 Create `ProjectList.vue`: render projects with add/remove functionality
- [ ] 6.3 Build chat area components
  - [ ] 6.3.1 Create `ChatView.vue`: container that holds MessageList and ChatInput, connects to active session via useSession composable
  - [ ] 6.3.2 Create `MessageList.vue`: scrollable message container with auto-scroll behavior and "scroll to bottom" button
  - [ ] 6.3.3 Create `ChatBubble.vue`: render individual messages as bubbles (user right-aligned, assistant left-aligned), with markdown rendering for assistant messages using markdown-it
  - [ ] 6.3.4 Create `TypingIndicator.vue`: animated indicator shown when session status is 'typing'
- [ ] 6.4 Build input area components
  - [ ] 6.4.1 Create `ChatInput.vue`: textarea with Enter-to-send, Shift+Enter for newlines, disabled send button when empty
  - [ ] 6.4.2 Create `ProjectSelector.vue`: dropdown showing saved projects
  - [ ] 6.4.3 Create `ProviderSelector.vue`: dropdown showing available providers (kiro, gemini, claude, codex)
- [ ] 6.5 Apply dark mode styling
  - [ ] 6.5.1 Add Tailwind `dark:` variants to all components for dark mode support
  - [ ] 6.5.2 Ensure consistent color scheme across light and dark modes

## Phase 7: Integration & Polish

- [ ] 7.1 End-to-end wiring
  - [ ] 7.1.1 Connect frontend session creation flow: NewSessionButton → project/provider selection → POST /api/sessions → WebSocket connect → chat ready
  - [ ] 7.1.2 Connect frontend message flow: ChatInput → WebSocket send → receive message/status updates → render in MessageList
  - [ ] 7.1.3 Connect sidebar session switching: click session → selectSession → WebSocket reconnect → history replay
  - [ ] 7.1.4 Connect session deletion: sidebar delete action → DELETE /api/sessions/:id → refresh session list
- [ ] 7.2 Error handling in frontend
  - [ ] 7.2.1 Display connection errors in the chat area (WebSocket failures, session not found)
  - [ ] 7.2.2 Display system messages from backend (pty exit, storage failures)
  - [ ] 7.2.3 Handle REST API errors with user-friendly toast or inline messages
- [ ] 7.3 Final verification
  - [ ] 7.3.1 Verify full flow: create project → create session → send message → receive response → view in chat
  - [ ] 7.3.2 Verify reconnection: refresh browser tab → history replayed → session resumes
  - [ ] 7.3.3 Verify multi-tab: open same session in two tabs → both receive messages
  - [ ] 7.3.4 Verify session lifecycle: create → chat → pty exits → session archived → viewable in sidebar
