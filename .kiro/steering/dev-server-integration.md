# CodePipe — Dev Server Integration

This document describes how CodePipe projects can expose their local dev servers for remote preview via Tailscale, and how the UI should surface this.

## Project Dev Server Config

Projects managed by CodePipe can optionally define a dev server configuration. This enables:
- A clickable link in the UI to preview the running app
- Start/stop controls for the dev server
- Status indicators (running / stopped)

### Data Model Extension

Add an optional `devServer` field to the Project schema:

```ts
interface ProjectDevServer {
  /** Command to start the dev server (e.g., "npm run dev:remote") */
  startCommand: string
  /** Local port the dev server listens on */
  port: number
  /** Tailscale HTTPS port mapped to this dev server (default: 443) */
  tailscalePort?: number
  /** Working directory relative to project path (default: project root) */
  cwd?: string
}

interface Project {
  id: string
  name: string
  path: string
  devServer?: ProjectDevServer
}
```

The remote URL is derived: `https://ks-mini.tail0293ef.ts.net[:tailscalePort]`

### Storage

The `devServer` field is stored in `data/projects.json` alongside existing project data. Example:

```json
{
  "id": "cbb76368-e200-4f6c-ac93-03778151bfcb",
  "name": "HDEC Website",
  "path": "C:\\Users\\Kitsune\\Documents\\hdec.org",
  "devServer": {
    "startCommand": "npm run dev:remote",
    "port": 5173,
    "tailscalePort": 8443
  }
}
```

## UI Behavior

### Project List (Sidebar)

Replace the simple delete (X) button with a three-dot (⋯) action menu per project:
- **Open Dev Server** — opens the Tailscale URL in a new tab (only shown if devServer is configured)
- **Start Dev Server** — starts the dev server process (shown if stopped)
- **Stop Dev Server** — stops the running dev server (shown if running)
- **Configure Dev Server** — edit startCommand, port, tailscalePort
- **Delete Project** — remove from CodePipe

Show a small green dot or link icon next to projects with a running dev server.

### Chat View (Header / Session Info)

When a session is associated with a project that has a running dev server, show a small external-link icon or chip in the chat header area linking to the Tailscale URL. This gives quick access to preview changes as the AI makes them.

### Dev Server Lifecycle

The backend manages dev server processes via node-pty (same as AI CLI sessions):
- `POST /api/projects/:id/dev-server/start` — spawns the process
- `POST /api/projects/:id/dev-server/stop` — kills it
- `GET /api/projects/:id/dev-server/status` — returns running/stopped + port info

Dev server processes are independent of chat sessions — they persist until explicitly stopped or the backend restarts.

## Tailscale Serve Setup for Downstream Projects

Each project that wants remote dev preview needs:

1. **Vite config with HMR tunnel support** (or equivalent for other frameworks):
   ```ts
   server: {
     host: '0.0.0.0',
     port: YOUR_PORT,
     hmr: process.env.TAILSCALE_HOST
       ? {
           protocol: 'wss',
           host: process.env.TAILSCALE_HOST,
           clientPort: parseInt(process.env.TAILSCALE_PORT || '443'),
         }
       : true,
   }
   ```

2. **A `dev:remote` script** in package.json:
   ```json
   "dev:remote": "set TAILSCALE_HOST=ks-mini.tail0293ef.ts.net && set TAILSCALE_PORT=8443 && vite"
   ```

3. **Tailscale Serve mapping** (one-time setup per project):
   ```cmd
   tailscale serve --bg --https 8443 http://127.0.0.1:YOUR_PORT
   ```

## Port Allocation Convention

To avoid conflicts across multiple projects:

| Project     | Local Port | Tailscale HTTPS Port |
|-------------|-----------|---------------------|
| CodePipe    | 5552      | 443 (default)       |
| HDEC Website| 5173      | 8443                |
| (next)      | 5174      | 8444                |

## Environment Variables

- `TAILSCALE_HOST` — the tailnet FQDN (e.g., `ks-mini.tail0293ef.ts.net`)
- `TAILSCALE_PORT` — the Tailscale HTTPS port for this project (defaults to 443)

These are set by the `dev:remote` script or injected by CodePipe when it starts a dev server on the project's behalf.
