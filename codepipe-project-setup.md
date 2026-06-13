# CodePipe Remote Dev Setup

Drop this into any project you want to develop remotely through CodePipe.

## Quick Setup

### 1. Configure Vite for Tailscale HMR

In your `vite.config.ts` (or equivalent), add:

```ts
export default defineConfig({
  server: {
    host: '0.0.0.0',
    port: YOUR_PORT,  // e.g., 5173
    allowedHosts: true,
    hmr: process.env.TAILSCALE_HOST
      ? {
          protocol: 'wss',
          host: process.env.TAILSCALE_HOST,
          clientPort: parseInt(process.env.TAILSCALE_PORT || '443'),
        }
      : true,
  },
})
```

### 2. Add a `dev:remote` script

In `package.json`:

```json
{
  "scripts": {
    "dev:remote": "set TAILSCALE_HOST=your-host.ts.net && set TAILSCALE_PORT=YOUR_TS_PORT && vite"
  }
}
```

Replace `your-host.ts.net` with your tailnet FQDN (find it with `tailscale status`) and `YOUR_TS_PORT` with the Tailscale HTTPS port assigned to this project (see port table below).

### 3. Register Tailscale Serve (one-time)

```cmd
tailscale serve --bg --https YOUR_TS_PORT http://127.0.0.1:YOUR_PORT
```

### 4. Configure in CodePipe

In the CodePipe sidebar, click the ⋯ menu on your project → **Configure Dev Server**:
- **Start command**: `npm run dev:remote`
- **Local port**: `YOUR_PORT`
- **Tailscale port**: `YOUR_TS_PORT`

Then use **Start Dev Server** from the same menu.

## Port Allocation

| Project      | Local Port | Tailscale HTTPS Port |
|--------------|-----------|---------------------|
| CodePipe     | 5552      | 443                 |
| HDEC Website | 5173      | 8443                |
| (next)       | 5174      | 8444                |

Pick the next available port pair when adding a new project.

## How It Works

- `TAILSCALE_HOST` tells Vite's HMR client to connect via `wss://` to your Tailscale hostname
- `TAILSCALE_PORT` sets which HTTPS port the WebSocket connects on
- Tailscale Serve terminates TLS and proxies to your local dev port
- Without these env vars, `npm run dev` works normally for local development

## Non-Vite Projects

For Next.js, Nuxt, or other frameworks:
- Bind to `0.0.0.0` (usually `--hostname 0.0.0.0`)
- The HMR/WebSocket config varies per framework — check its docs
- The Tailscale Serve mapping is the same regardless of framework

## Troubleshooting

- **HMR drops frequently**: Check `tailscale serve status` is running
- **Page loads but no hot reload**: Verify `TAILSCALE_HOST` env var is set
- **WebSocket error in console**: Make sure `protocol: 'wss'` is set (not `ws`)
- **Connection refused**: Ensure the dev server binds to `0.0.0.0`, not `127.0.0.1`
