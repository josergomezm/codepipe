# CodePipe — Backend

Node.js + TypeScript backend. Handles process management, terminal parsing, storage, and real-time communication with the frontend.

## Tech Stack

- **Runtime**: Node.js with TypeScript
- **HTTP**: Express (REST endpoints for sessions, projects, config)
- **WebSocket**: `ws` library for real-time pty ↔ browser streaming
- **Terminal**: `node-pty` for spawning CLI processes, `xterm-headless` for parsing terminal output
- **Storage**: JSON files via `lowdb` or a thin fs wrapper

## Architecture

```
Frontend (WebSocket) ↔ WebSocket Server ↔ SessionManager ↔ PTY Instance
                                              ↓
Frontend (REST)      ↔ Express Routes    ↔ StorageLayer (JSON files)
```

### Key Components

**SessionManager**
Central orchestrator. Creates, tracks, and destroys sessions. Each session owns a pty instance and a CLI adapter. Handles reconnection when a browser tab refreshes and reattaches to a live session.

**CLI Adapters**
Pluggable parsers, one per provider. Each adapter receives parsed terminal screen state from xterm-headless and converts it into normalized chat messages. Adapters define:
- The command to launch the CLI (e.g., `kiro`, `gemini`, `claude`)
- Prompt detection patterns (how to know the CLI is waiting for input)
- Message boundary detection (how to split output into discrete messages)
- Special block recognition (tool use, code blocks, thinking indicators)

Adapter interface should be simple and consistent so adding a new provider is mostly pattern-matching work.

**StorageLayer**
Reads/writes JSON files in a `data/` directory:
- `data/projects.json` — array of `{ id, name, path }` objects
- `data/sessions/{sessionId}.json` — session metadata + message array

No complex querying needed. Load file, update in memory, write back.

## REST Endpoints (rough shape)

- `GET /api/sessions` — list all sessions (metadata only)
- `POST /api/sessions` — create a new session (provider + project)
- `GET /api/sessions/:id` — get session with message history
- `DELETE /api/sessions/:id` — archive/delete a session
- `GET /api/projects` — list projects
- `POST /api/projects` — add a project
- `DELETE /api/projects/:id` — remove a project

## WebSocket Protocol

- Client connects to `ws://localhost:{port}/ws?sessionId={id}`
- Server → Client: `{ type: 'message', data: ChatMessage }` for new chunks
- Server → Client: `{ type: 'status', data: 'typing' | 'idle' | 'exited' }` for session state
- Client → Server: `{ type: 'input', data: string }` for user keystrokes

## Data Shapes

```ts
interface Session {
  id: string
  provider: 'kiro' | 'gemini' | 'claude' | 'codex'
  projectId: string
  title: string
  createdAt: number
  updatedAt: number
  status: 'live' | 'archived'
  messages: ChatMessage[]
}

interface ChatMessage {
  id: string
  role: 'user' | 'assistant' | 'system' | 'tool'
  content: string
  timestamp: number
  status: 'streaming' | 'complete'
}

interface Project {
  id: string
  name: string
  path: string
}
```

## Conventions

- Use ES modules (`"type": "module"` in package.json)
- Strict TypeScript config
- Keep adapters in `src/adapters/`, one file per provider
- Keep route handlers thin — business logic lives in the SessionManager and StorageLayer
- Error handling: don't crash on pty errors, surface them as system messages in the chat
