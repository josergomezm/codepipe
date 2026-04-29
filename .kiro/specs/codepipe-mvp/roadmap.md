# CodePipe — Post-MVP Roadmap

This document captures future enhancements beyond the MVP scope. These are not prioritized or scheduled — they represent directions the project could grow.

## Provider Expansion

- **Gemini CLI adapter**: Implement adapter with Gemini-specific prompt patterns and output parsing
- **Claude Code adapter**: Implement adapter for Claude Code CLI
- **Codex adapter**: Implement adapter for OpenAI Codex CLI
- **Provider auto-detection**: Detect which CLIs are installed and only show available providers
- **Provider health checks**: Verify CLI binary exists and is responsive before session creation

## Session Management Enhancements

- **Session restart**: Allow restarting an archived session (re-spawn pty in same project)
- **Session renaming**: Let users rename sessions (currently auto-generated titles)
- **Session search**: Full-text search across session message history
- **Session export**: Export session as markdown, JSON, or plain text
- **Session tagging/grouping**: Organize sessions by tags or folders beyond just projects
- **Auto-title generation**: Use the first user message or AI summary as session title

## Frontend Polish

- **Syntax highlighting**: Use a proper syntax highlighter (Shiki, Prism) for code blocks in assistant messages
- **Copy code button**: One-click copy for code blocks in messages
- **Message actions**: Copy, delete, or re-send individual messages
- **Resizable sidebar**: Drag to resize the sidebar width
- **Keyboard shortcuts**: Cmd+K for new session, Cmd+/ for sidebar toggle, etc.
- **Mobile/responsive layout**: Collapsible sidebar for narrow viewports
- **Theme customization**: Beyond dark/light — custom accent colors, font sizes
- **File attachment rendering**: If the CLI references files, render them inline
- **Image rendering**: If the CLI outputs image references, render them in the chat

## Backend Improvements

- **Database storage**: Migrate from JSON files to SQLite or similar for better query performance at scale
- **Session indexing**: Maintain a session index file for fast listing without reading individual files
- **Message pagination**: Load messages in pages rather than all at once for large sessions
- **Streaming backpressure**: Handle slow WebSocket clients without blocking the pty output pipeline
- **Graceful shutdown**: On server stop, cleanly archive all live sessions and notify clients
- **Health endpoint**: `GET /api/health` for monitoring

## Adapter System

- **Adapter hot-reload**: Add/update adapters without restarting the server
- **Adapter testing harness**: Record and replay terminal sessions for adapter development
- **Rich message types**: Parse structured output (tables, diffs, file trees) into rich UI components
- **Tool-use visualization**: Render tool calls with expandable input/output panels
- **Thinking block toggle**: Show/hide thinking blocks per user preference

## Networking & Access

- **Tailscale integration**: Auto-detect Tailscale and offer to expose via `tailscale serve`
- **Multi-user support**: Basic user identification when accessed via Tailscale (use Tailscale identity)
- **Shared sessions**: Allow multiple Tailscale users to view/interact with the same session
- **HTTPS support**: Built-in TLS for non-Tailscale deployments

## Developer Experience

- **Plugin system**: Allow third-party adapters via npm packages
- **Configuration file**: YAML/TOML config for server port, data directory, default provider, etc.
- **CLI companion**: `codepipe` CLI for starting the server, managing sessions from terminal
- **Docker packaging**: Dockerfile for easy deployment
- **Logging**: Structured logging with configurable levels (debug, info, warn, error)

## Quality & Reliability

- **End-to-end test suite**: Playwright tests for the full user flow
- **Adapter snapshot tests**: Automated regression tests using recorded terminal sessions
- **Performance benchmarks**: Measure and track message throughput, latency, memory usage
- **Error reporting**: Optional error telemetry (opt-in) for crash reporting
