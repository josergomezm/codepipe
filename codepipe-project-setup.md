# CodePipe Remote Dev Setup

How a project gets set up to run its dev server through CodePipe, reachable
remotely (e.g. from a phone) over Tailscale HTTPS.

## Quick Setup

1. Add the project in CodePipe, open its **Settings** from the sidebar.
2. Under **Dev Server**, save a config: the start command (`npm run dev:remote`
   by convention), a local port and a Tailscale port. The Tailscale port can't
   be 443 — that's CodePipe itself. Use the suggested free one.
3. Click **Set up project for remote dev** (or **Set up ports.json** /
   **Re-check setup** in the Ports card — they open the same chat). CodePipe
   builds the prompt itself: it picks ports that are free across every
   project on the machine, knows the framework, and hands an agent the work.
4. When the chat is done, **Start Dev Server**. CodePipe creates the Tailscale
   Serve mapping, sets `TAILSCALE_HOST` / `TAILSCALE_PORT`, and waits up to 30s
   for the server to listen on its port.

Don't hand-pick ports from a table or register `tailscale serve` yourself —
CodePipe does both.

## What the setup chat leaves in the repo

- **`ports.json`** at the repo root: the single declaration of every port.
  `app.vite` is the dev server's local port (the key is `vite` whatever the
  framework), `app.tailscale` the Tailscale HTTPS port, and `emulators` the
  Firebase emulator ports when the project has them. CodePipe reads it to
  catch collisions and applies it to the dev server config on every start.
- **A `dev:remote` script** that runs the same dev server as `dev`. It sets no
  env vars: CodePipe sets `TAILSCALE_HOST` and `TAILSCALE_PORT` when it starts
  the server (and an inline `set X=… &&` in cmd bakes a trailing space into
  the value).
- **The dev server bound on `0.0.0.0:<app.vite>`**, configured where the
  framework actually reads it:

  | Framework | Host & port | Remote HMR |
  |-----------|-------------|------------|
  | Vite / SvelteKit | `vite.config` → `server.host`, `server.port`, `strictPort: true` | `server.hmr` = `wss` / `TAILSCALE_HOST` / `app.tailscale` |
  | Nuxt | `nuxt.config` → `devServer: { host, port }` (Nuxt ignores `vite.server.port`); `dev:remote` is `nuxt dev --public` | `vite.server.hmr` in `nuxt.config` |
  | Next | `next dev -H 0.0.0.0 -p <port>` via a small launcher that reads `ports.json` | same-origin; add `TAILSCALE_HOST` to `allowedDevOrigins` |

  "Remote mode" is `process.env.TAILSCALE_HOST` being set; without it the
  project runs as it always did locally.
- **Single-origin rule**: browser code never connects to a localhost port and
  never imports `ports.json` — on a phone, 127.0.0.1 is the phone. Firebase
  client-SDK emulators go through the dev server's proxy.
- A line in **CLAUDE.md**: never hardcode a port.

## Troubleshooting

- **Start fails with "came up on port 3000, but CodePipe waits for port N"**:
  the port is set somewhere the framework doesn't read (classic case: Nuxt
  with only `vite.server.port`). Re-run the remote setup.
- **"reported port N, but nothing listened on 0.0.0.0:N"**: the server bound
  only to `localhost`/`::1`. Set its host to `0.0.0.0`.
- **"Forbidden: this host is not allowed"** (Nuxt, usually while it's still
  building): Nuxt's CLI rejects the Tailscale hostname on its loading and
  error pages. Run `nuxt dev --public` in `dev:remote`.
- **Page loads but no hot reload**: HMR isn't pointed at
  `wss://<TAILSCALE_HOST>:<app.tailscale>` in remote mode.
- **Port conflict on start**: another project holds the port. Re-check setup —
  CodePipe moves this project to free ports and the chat updates references.
