# CodePipe — Frontend

Vue 3 + Tailwind CSS single-page application. Chat-style interface for interacting with AI CLI tools.

## Tech Stack

- **Framework**: Vue 3 with Composition API + `<script setup>`
- **Styling**: Tailwind CSS
- **Build**: Vite
- **State**: Pinia for global state (sessions, projects, active session)
- **Routing**: Vue Router (minimal — mostly sidebar-driven navigation)
- **Markdown**: A markdown renderer for message content (e.g., `markdown-it` or `marked`)
- **WebSocket**: Native WebSocket API or a thin wrapper

## Layout

Inspired by ChatGPT / Claude Cowork style:

```
┌──────────────┬─────────────────────────────────┐
│              │                                 │
│   Sidebar    │         Chat Area               │
│              │                                 │
│  - Sessions  │   ┌─────────────────────────┐   │
│  - Projects  │   │  Message bubbles        │   │
│  - Settings  │   │  (scrollable)           │   │
│              │   │                         │   │
│              │   │  ...                    │   │
│              │   │                         │   │
│              │   │  [typing indicator]     │   │
│              │   └─────────────────────────┘   │
│              │                                 │
│              │   ┌─────────────────────────┐   │
│              │   │ [project ▾] [provider ▾]│   │
│              │   │ Message input box       │   │
│              │   └─────────────────────────┘   │
└──────────────┴─────────────────────────────────┘
```

### Sidebar

- List of sessions grouped or sorted by recency
- Live sessions show an active indicator
- Archived sessions are accessible but visually distinct
- "New conversation" button at the top
- Project management section (add/remove project paths)

### Chat Area

- Messages rendered as bubbles — user on the right, assistant on the left
- Assistant messages render markdown (code blocks, lists, bold, etc.)
- Typing indicator shows when the CLI is producing output between chunks
- Auto-scroll to bottom on new messages, with a "scroll to bottom" button if the user scrolls up

### Input Area

- Text input with Enter to send, Shift+Enter for newlines
- Project selector dropdown (shows saved projects + "choose folder" option)
- Provider selector (Kiro / Gemini / Claude Code / Codex)
- Project and provider selectors are most relevant when starting a new conversation but remain visible

## Component Structure (rough)

```
App.vue
├── AppSidebar.vue
│   ├── SessionList.vue
│   ├── ProjectList.vue
│   └── NewSessionButton.vue
├── ChatView.vue
│   ├── MessageList.vue
│   │   ├── ChatBubble.vue
│   │   └── TypingIndicator.vue
│   └── ChatInput.vue
│       ├── ProjectSelector.vue
│       └── ProviderSelector.vue
└── SettingsView.vue (future)
```

## Conventions

- Use Composition API with `<script setup>` everywhere
- Tailwind for all styling — no scoped CSS unless absolutely necessary
- Keep components small and focused
- WebSocket connection logic lives in a composable (`useSession` or similar), not in components
- Pinia store handles session list, active session, project list
- Dark mode friendly from the start (Tailwind dark: variants)
