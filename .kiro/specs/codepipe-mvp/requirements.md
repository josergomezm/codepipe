# Requirements: CodePipe MVP

## Requirement 1: Session Management

### 1.1 Session Creation

When a user creates a new session via `POST /api/sessions` with a valid provider and projectId:
- The request body is validated against `CreateSessionRequestSchema` (Zod)
- The referenced project exists in storage and its path is a valid directory on disk
- A pty process is spawned running the provider's CLI command in the project directory
- A Session object is created with `status: 'live'`, empty messages array, and `createdAt === updatedAt`
- The session is persisted to `data/sessions/{id}.json`
- The API returns 201 with the session object

Acceptance Criteria:
- Given a valid provider ("kiro") and an existing projectId, when POST /api/sessions is called, then a session with status "live" and the correct provider is returned with HTTP 201
- Given an invalid provider value, when POST /api/sessions is called, then HTTP 400 is returned with Zod validation errors
- Given a projectId that does not exist, when POST /api/sessions is called, then HTTP 400 is returned with "Project not found"
- Given a project whose path no longer exists on disk, when POST /api/sessions is called, then HTTP 400 is returned with "Project path does not exist"

### 1.2 Session Listing

When a user requests `GET /api/sessions`:
- All sessions are returned as `SessionMeta` objects (no messages array)
- Sessions are sorted by `updatedAt` descending (most recent first)

Acceptance Criteria:
- Given 3 sessions exist, when GET /api/sessions is called, then 3 SessionMeta objects are returned without messages arrays
- Given sessions with different updatedAt values, when GET /api/sessions is called, then sessions are sorted most recent first

### 1.3 Session Detail Retrieval

When a user requests `GET /api/sessions/:id`:
- The full session including message history is returned
- The response validates against `SessionSchema`

Acceptance Criteria:
- Given a session with 5 messages exists, when GET /api/sessions/:id is called, then the full session with all 5 messages is returned
- Given a non-existent session ID, when GET /api/sessions/:id is called, then HTTP 404 is returned

### 1.4 Session Deletion

When a user requests `DELETE /api/sessions/:id`:
- If the session is live, the pty process is killed and the session is archived
- If the session is already archived, the session file is deleted from disk

Acceptance Criteria:
- Given a live session, when DELETE is called, then the pty is killed, status becomes "archived", and HTTP 200 is returned
- Given an archived session, when DELETE is called, then the session file is removed and HTTP 200 is returned
- Given a non-existent session ID, when DELETE is called, then HTTP 404 is returned

### 1.5 Session Reconnection

When a WebSocket client connects to an existing session:
- The client receives the full message history via `{ type: 'history', data: messages }`
- For live sessions, the client then receives `{ type: 'status', data: 'idle' }` (or 'typing' if output is in progress)
- For archived sessions, the client receives `{ type: 'status', data: 'exited' }`
- Multiple browser tabs can connect to the same live session simultaneously

Acceptance Criteria:
- Given a live session with 10 messages, when a new WebSocket client connects, then it receives all 10 messages as history followed by status 'idle'
- Given an archived session, when a WebSocket client connects, then it receives history followed by status 'exited'
- Given a non-existent session ID, when a WebSocket client connects, then it receives an error message and the socket is closed
- Given 2 browser tabs connected to the same session, when a message arrives, then both tabs receive it

## Requirement 2: Real-Time Messaging

### 2.1 User Input Handling

When a user sends a message via WebSocket `{ type: 'input', data: text }`:
- The message is validated against `WSClientMessageSchema` (Zod)
- A user `ChatMessage` with `role: 'user'` and `status: 'complete'` is created
- The message is persisted to storage
- The message is broadcast to all attached WebSocket clients
- The text (with trailing newline) is written to the pty's stdin

Acceptance Criteria:
- Given a live session, when a user sends "hello", then a user ChatMessage with content "hello" is persisted and broadcast
- Given a live session, when a user sends "hello", then "hello\n" is written to the pty stdin
- Given an invalid WebSocket message format, when received, then `{ type: 'error', data: 'Invalid message format' }` is sent back
- Given an archived session, when a user tries to send input, then the input is rejected

### 2.2 CLI Output Streaming

When the CLI produces output:
- Raw pty data is parsed by xterm-headless into screen state
- The CLI adapter converts screen state into `AdapterEvent` objects
- Chunk events are accumulated into a streaming `ChatMessage` with `status: 'streaming'`
- Each chunk update is broadcast to all attached clients as `{ type: 'message', data: chatMessage }`
- Status `{ type: 'status', data: 'typing' }` is broadcast while chunks arrive

Acceptance Criteria:
- Given a live session, when the CLI produces output, then chunk messages are broadcast to all attached clients
- Given a live session, when chunks are arriving, then status 'typing' is broadcast
- Given a streaming message, when a new chunk arrives, then the message content is appended (not replaced)

### 2.3 Message Completion

When the CLI adapter detects a prompt (CLI is waiting for input):
- Any in-progress streaming message is finalized with `status: 'complete'`
- The completed message is persisted to storage
- Status `{ type: 'status', data: 'idle' }` is broadcast to all clients

Acceptance Criteria:
- Given a streaming assistant message, when prompt is detected, then the message status becomes 'complete' and is persisted
- Given prompt detection, when broadcast occurs, then all clients receive status 'idle'

### 2.4 Special Block Recognition

When the CLI adapter detects special output blocks:
- Tool-use blocks emit `tool_use` events, creating `ChatMessage` with `role: 'tool'` and `metadata.toolName`
- Thinking blocks emit `thinking` events, broadcast as transient system messages (not persisted)

Acceptance Criteria:
- Given CLI output containing a tool-use block, when parsed, then a tool ChatMessage with the correct toolName is persisted
- Given CLI output containing a thinking block, when parsed, then a system message is broadcast but not persisted

## Requirement 3: CLI Adapter System

### 3.1 Adapter Interface

Each CLI adapter implements `ICLIAdapter` with:
- `provider`: the provider type identifier
- `command`: the CLI binary name (e.g., 'kiro', 'gemini', 'claude')
- `args`: command-line arguments for the CLI
- `onScreenUpdate(screenContent)`: processes terminal screen state and returns `AdapterEvent[]`
- `reset()`: resets internal parsing state

Acceptance Criteria:
- Given a Kiro adapter instance, then it has provider 'kiro', a valid command, and implements onScreenUpdate and reset
- Given any adapter, when reset() is called, then internal state is cleared and subsequent onScreenUpdate calls start fresh

### 3.2 Prompt Detection

Each adapter defines regex patterns to detect when the CLI is waiting for user input.

Acceptance Criteria:
- Given Kiro CLI output ending with its prompt pattern, when onScreenUpdate is called, then a 'prompt_detected' event is emitted
- Given CLI output that does not end with a prompt, when onScreenUpdate is called, then no 'prompt_detected' event is emitted

### 3.3 Idempotent Screen Processing

The adapter tracks its position in the terminal output and only emits events for new content.

Acceptance Criteria:
- Given the same screen content passed to onScreenUpdate twice, then the second call returns an empty array (no duplicate events)
- Given screen content that grows incrementally, then each call only emits events for the new portion
- The adapter's internal position never moves backwards

### 3.4 Pluggable Provider Registration

New providers can be added by implementing `ICLIAdapter` and registering the adapter with the SessionManager.

Acceptance Criteria:
- Given a new adapter implementing ICLIAdapter, when registered with SessionManager, then sessions can be created with that provider
- Given an unregistered provider, when session creation is attempted, then an error is returned

## Requirement 4: Storage Layer

### 4.1 Session Persistence

Sessions are stored as individual JSON files at `data/sessions/{sessionId}.json`.

Acceptance Criteria:
- Given a new session is created, then a JSON file exists at `data/sessions/{id}.json` with valid content
- Given a session with messages, when loaded from disk, then all messages are present and ordered by timestamp
- Given the data directory does not exist on startup, then it is created automatically

### 4.2 Project Storage

Projects are stored in a single `data/projects.json` file as an array of Project objects.

Acceptance Criteria:
- Given 3 projects are added, then `data/projects.json` contains an array of 3 Project objects
- Given a project is removed, then it no longer appears in `data/projects.json`

### 4.3 Atomic File Writes

All file writes use a write-to-temp-then-rename strategy for atomicity.

Acceptance Criteria:
- Given a write operation, then a temporary file is created first, then renamed to the target path
- Given a crash during the temp file write, then the original file is preserved unchanged

### 4.4 Data Round-Trip Integrity

Data saved to storage can be loaded back without loss or corruption.

Acceptance Criteria:
- Given any valid Session object, when saved and then loaded, then the loaded object is identical to the original
- Given any valid Project object, when saved and then loaded, then the loaded object is identical to the original

### 4.5 Message Append

Messages can be appended to a session without rewriting the entire message history from scratch (though the MVP may rewrite the full file — the interface supports future optimization).

Acceptance Criteria:
- Given a session with 5 messages, when a 6th message is appended, then the session has 6 messages with the new one last
- Given a message is appended, then `session.updatedAt` is updated to the message's timestamp

## Requirement 5: Data Validation with Zod

### 5.1 Schema Definitions

All data models (Session, ChatMessage, Project, WebSocket messages, REST request bodies) are defined as Zod schemas with TypeScript types inferred via `z.infer<>`.

Acceptance Criteria:
- Given the Zod schemas, then TypeScript types are inferred without manual interface definitions
- Given a valid Session object, when validated against SessionSchema, then validation passes
- Given a Session with updatedAt < createdAt, when validated, then validation fails with a refinement error

### 5.2 REST Validation

All REST request bodies are validated with Zod schemas. Invalid payloads return HTTP 400 with formatted error messages.

Acceptance Criteria:
- Given a POST /api/sessions with missing provider field, then HTTP 400 is returned with Zod error details
- Given a POST /api/projects with a relative path, then HTTP 400 is returned indicating path must start with '/'
- Given a POST /api/projects with an empty name, then HTTP 400 is returned

### 5.3 WebSocket Validation

Incoming WebSocket messages are validated with `WSClientMessageSchema`. Invalid messages receive an error response.

Acceptance Criteria:
- Given a WebSocket message with unknown type, then `{ type: 'error', data: 'Invalid message format' }` is sent back
- Given a WebSocket message with empty input data, then validation fails and error is sent
- Given valid `{ type: 'input', data: 'hello' }`, then the message is processed normally

### 5.4 Storage Validation

Data loaded from JSON files is validated against Zod schemas to guard against corruption.

Acceptance Criteria:
- Given a corrupted session JSON file, when loaded, then a validation error is logged and a graceful fallback occurs
- Given a valid session JSON file, when loaded, then the data passes validation and is returned normally

## Requirement 6: Frontend UI

### 6.1 Chat Layout

The application has a two-panel layout: left sidebar and main chat area.

Acceptance Criteria:
- Given the app loads, then a sidebar is visible on the left and a chat area on the right
- Given the layout, then it is responsive and usable at common viewport sizes

### 6.2 Message Rendering

Messages are rendered as chat bubbles — user messages on the right, assistant messages on the left. Assistant messages render markdown content (code blocks, lists, bold, etc.).

Acceptance Criteria:
- Given a user message, then it appears as a bubble aligned to the right
- Given an assistant message with markdown, then the markdown is rendered as HTML (code blocks, bold, lists)
- Given a tool message, then it is visually distinct from user and assistant messages

### 6.3 Session Sidebar

The sidebar shows a list of sessions sorted by recency. Live sessions have an active indicator. Archived sessions are visually distinct. A "New conversation" button is at the top.

Acceptance Criteria:
- Given 5 sessions exist, then all 5 appear in the sidebar sorted by most recent
- Given a live session, then it shows an active indicator (e.g., green dot)
- Given an archived session, then it is visually dimmed or marked as archived
- Given the "New conversation" button is clicked, then a session creation flow begins

### 6.4 Input Area

The input area has a text input with Enter to send and Shift+Enter for newlines, plus project and provider selector dropdowns.

Acceptance Criteria:
- Given the user types text and presses Enter, then the message is sent
- Given the user presses Shift+Enter, then a newline is inserted (message is not sent)
- Given the input area, then project and provider selectors are visible
- Given an empty input, then the send button is disabled

### 6.5 Typing Indicator

A typing indicator is shown when the session status is 'typing' (CLI is producing output).

Acceptance Criteria:
- Given session status is 'typing', then a typing indicator is visible in the chat area
- Given session status changes to 'idle', then the typing indicator disappears

### 6.6 Auto-Scroll

The chat area auto-scrolls to the bottom when new messages arrive. If the user has scrolled up, a "scroll to bottom" button appears.

Acceptance Criteria:
- Given a new message arrives and the user is at the bottom, then the view scrolls to show the new message
- Given the user has scrolled up, then a "scroll to bottom" button is visible
- Given the user clicks "scroll to bottom", then the view scrolls to the latest message

### 6.7 Dark Mode

The UI supports dark mode using Tailwind's `dark:` variants.

Acceptance Criteria:
- Given the system is in dark mode, then the UI renders with dark backgrounds and light text
- Given the system is in light mode, then the UI renders with light backgrounds and dark text

## Requirement 7: Project Management

### 7.1 Add Project

Users can add a project via `POST /api/projects` with a name and absolute filesystem path.

Acceptance Criteria:
- Given a valid name and absolute path, when POST /api/projects is called, then a Project with a generated UUID is returned
- Given a relative path, when POST /api/projects is called, then HTTP 400 is returned
- Given a path that does not exist on disk, when POST /api/projects is called, then HTTP 400 is returned

### 7.2 List Projects

Users can list all projects via `GET /api/projects`.

Acceptance Criteria:
- Given 3 projects exist, when GET /api/projects is called, then all 3 are returned

### 7.3 Remove Project

Users can remove a project via `DELETE /api/projects/:id`.

Acceptance Criteria:
- Given an existing project with no active sessions, when DELETE is called, then the project is removed
- Given a non-existent project ID, when DELETE is called, then HTTP 404 is returned

## Requirement 8: Error Handling & Resilience

### 8.1 PTY Process Exit

When a CLI process exits (normally or abnormally):
- The session status transitions to 'archived'
- A system message with the exit code is appended
- All attached clients receive status 'exited'

Acceptance Criteria:
- Given a pty exits with code 0, then the session is archived and clients receive status 'exited'
- Given a pty exits with code 1, then a system message "CLI process exited with code 1" is appended
- Given a pty is killed by signal, then the session is archived gracefully

### 8.2 WebSocket Disconnection

When a client disconnects unexpectedly:
- The client is removed from the session's client set
- The pty continues running unaffected
- The client can reconnect and receive history replay

Acceptance Criteria:
- Given a client disconnects, then the pty keeps running
- Given a client reconnects after disconnection, then it receives the full message history

### 8.3 CLI Binary Not Found

When a session is created with a provider whose CLI is not installed:
- The session creation fails with HTTP 400
- The error message identifies the missing CLI binary

Acceptance Criteria:
- Given provider 'kiro' but kiro CLI is not installed, then HTTP 400 with "CLI binary 'kiro' not found" is returned

### 8.4 Storage Failure Resilience

When a storage write fails:
- The original file is preserved (atomic write guarantee)
- The error is logged server-side
- A system message is broadcast to attached clients
- In-memory state remains correct

Acceptance Criteria:
- Given a disk write failure, then the original session file is unchanged
- Given a disk write failure, then the server does not crash

## Requirement 9: Security

### 9.1 Localhost Binding

The server binds exclusively to `127.0.0.1`.

Acceptance Criteria:
- Given the server starts, then it only accepts connections on 127.0.0.1
- Given a request from a non-localhost address, then it is not reachable

### 9.2 Path Traversal Prevention

Project paths are validated to prevent path traversal attacks.

Acceptance Criteria:
- Given a project path containing '..', then it is rejected
- Given a relative project path, then it is rejected
- Given an absolute path without traversal, then it is accepted

### 9.3 WebSocket Origin Validation

The WebSocket server optionally validates the Origin header to prevent cross-site WebSocket hijacking.

Acceptance Criteria:
- Given a WebSocket connection with a localhost Origin, then it is accepted
- Given a WebSocket connection with a foreign Origin (when validation is enabled), then it is rejected

## Requirement 10: Performance

### 10.1 PTY Output Debouncing

PTY output is debounced (e.g., 50ms) before screen serialization to batch rapid output bursts.

Acceptance Criteria:
- Given rapid pty output (multiple data events within 50ms), then screen serialization occurs once after the burst

### 10.2 Storage Write Debouncing

Message persistence is debounced — writes occur every 500ms or on message completion, whichever comes first.

Acceptance Criteria:
- Given 10 chunks arrive within 500ms, then at most 1-2 disk writes occur (not 10)
- Given a message completes, then it is persisted immediately regardless of the debounce timer

### 10.3 Efficient Session Listing

Session listing loads only metadata, not full message arrays.

Acceptance Criteria:
- Given a session with 1000 messages, when listSessions is called, then the response does not include the messages array
- Given 50 sessions exist, when listSessions is called, then the response time is proportional to the number of sessions, not the total number of messages
