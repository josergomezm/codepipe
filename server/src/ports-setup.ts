import type { RunningService } from './service-manager.js'
import type { TailscaleMapping } from './tailscale.js'
import {
  CODEPIPE_FRONTEND_PORT,
  CODEPIPE_TAILSCALE_PORT,
  getCodePipeBackendPort,
  serviceReservations,
  type ProjectPortInfo,
} from './ports.js'
import { FIREBASE_DEFAULT_PORTS, detectFirebaseEmulators } from './services/firebase-detector.js'
import { PORTS_FILE, readPortsFile } from './ports-file.js'

// ---------------------------------------------------------------------------
// ports.json setup: CodePipe picks a conflict-free port set for a project
// (it's the only one that sees every project on the machine) and hands it to
// an agent chat that centralizes the repo's ports in ports.json.
// ---------------------------------------------------------------------------

/** port → who holds it */
export type TakenPorts = Map<number, string>

/** A port held outside CodePipe's stored config: declared in a repo, or handed out in a plan. */
export interface ExtraPort {
  projectId: string
  port: number
  owner: string
  kind: 'local' | 'tailscale'
}

export interface CurrentPorts {
  vite?: number
  tailscale?: number
  /** Emulator name → port, as the repo has them now (ports.json or firebase.json). */
  emulators: Record<string, number>
}

export interface PortsPlan {
  app: { vite: number; tailscale: number }
  emulators: Record<string, number>
  /** Free ports set aside for emulators that may turn up later (eventarc, tasks). */
  spare: Record<string, number>
  /** Ports that differ from what the repo uses now. */
  changes: Array<{ name: string; from: number; to: number }>
}

/**
 * Fixed slot of each emulator inside a project's 100-port block, so every
 * renumbered project has the same, easy-to-read layout.
 */
const EMULATOR_SLOTS = [
  'ui', 'hub', 'logging', 'auth', 'functions', 'firestore', 'firestoreWebsocket',
  'database', 'hosting', 'pubsub', 'storage', 'eventarc', 'tasks', 'dataconnect',
]
const SPARE_EMULATORS = ['eventarc', 'tasks']
const BLOCK_START = 10000
const BLOCK_SIZE = 100
const FIRST_VITE_PORT = 5173
const FIRST_TAILSCALE_PORT = 8443

/** Firebase's own defaults are shared by every project on defaults — never pick them. */
const FIREBASE_DEFAULTS = new Set(Object.values(FIREBASE_DEFAULT_PORTS))

/**
 * Ports other projects (and CodePipe) hold on this machine: configured dev
 * servers, stored and live service ports, active Tailscale mappings, and
 * `extra` — ports repos declare (ports.json / firebase.json) and plans
 * already handed out.
 */
export function collectTakenPorts(
  projectId: string,
  projects: ProjectPortInfo[],
  running: RunningService[],
  mappings: TailscaleMapping[],
  extra: ExtraPort[] = [],
): { local: TakenPorts; tailscale: TakenPorts } {
  const local: TakenPorts = new Map()
  const tailscale: TakenPorts = new Map()
  const own = projects.find((p) => p.id === projectId)
  const ownLocal = own?.devServer?.port

  local.set(getCodePipeBackendPort(), 'CodePipe Backend')
  local.set(CODEPIPE_FRONTEND_PORT, 'CodePipe Frontend')
  tailscale.set(CODEPIPE_TAILSCALE_PORT, 'CodePipe Frontend')

  for (const p of projects) {
    if (p.id === projectId || !p.devServer) continue
    if (!local.has(p.devServer.port)) local.set(p.devServer.port, `${p.name} (dev server)`)
    const ts = p.devServer.tailscalePort
    if (ts !== undefined && !tailscale.has(ts)) tailscale.set(ts, `${p.name} (dev server)`)
  }
  for (const r of serviceReservations(projects, running)) {
    if (r.projectId === projectId || local.has(r.port)) continue
    local.set(r.port, r.owner)
  }
  for (const m of mappings) {
    if (m.localPort === ownLocal) continue // this project's own mapping
    if (!local.has(m.localPort)) local.set(m.localPort, `a Tailscale mapping (:${m.tailscalePort})`)
    if (!tailscale.has(m.tailscalePort)) tailscale.set(m.tailscalePort, `a Tailscale mapping (→ :${m.localPort})`)
  }
  for (const e of extra) {
    if (e.projectId === projectId) continue
    const map = e.kind === 'local' ? local : tailscale
    if (!map.has(e.port)) map.set(e.port, e.owner)
  }
  return { local, tailscale }
}

function firstFree(start: number, isTaken: (port: number) => boolean): number {
  let port = start
  while (isTaken(port)) port++
  return port
}

/**
 * The ports a repo declares itself — its ports.json app ports, and its
 * emulator ports (ports.json, else firebase.json) — whether or not CodePipe
 * has a service config for them.
 */
export async function declaredPorts(project: { id: string; name: string; path: string }): Promise<ExtraPort[]> {
  const [portsFile, detection] = await Promise.all([
    readPortsFile(project.path),
    detectFirebaseEmulators(project.path),
  ])
  const out: ExtraPort[] = []
  for (const [name, port] of Object.entries(portsFile?.app ?? {})) {
    out.push({ projectId: project.id, port, owner: `${project.name} (${name})`, kind: name === 'tailscale' ? 'tailscale' : 'local' })
  }
  if (detection.found) {
    for (const [name, port] of Object.entries(detection.defaultPorts)) {
      out.push({ projectId: project.id, port, owner: `${project.name} — Firebase Emulators (${name})`, kind: 'local' })
    }
  }
  return out
}

/** Every port a plan assigns, as reservations for other projects' plans. */
export function planAsExtraPorts(projectId: string, projectName: string, plan: PortsPlan): ExtraPort[] {
  const owner = (name: string) => `${projectName} (${name}, being set up)`
  return [
    { projectId, port: plan.app.vite, owner: owner('vite'), kind: 'local' as const },
    { projectId, port: plan.app.tailscale, owner: owner('tailscale'), kind: 'tailscale' as const },
    ...Object.entries({ ...plan.emulators, ...plan.spare })
      .map(([name, port]) => ({ projectId, port, owner: owner(name), kind: 'local' as const })),
  ]
}

/**
 * Pick the project's ports. Current ports are kept when they're safe — free
 * across projects and not a shared Firebase default — so a re-run doesn't
 * churn a repo. Otherwise the emulators move to the first free 100-port block.
 */
export function planProjectPorts(current: CurrentPorts, taken: { local: TakenPorts; tailscale: TakenPorts }): PortsPlan {
  const changes: PortsPlan['changes'] = []
  const used = new Set<number>()
  const isTaken = (port: number) => taken.local.has(port) || used.has(port)

  // Dev server
  const vite = current.vite !== undefined && !taken.local.has(current.vite)
    ? current.vite
    : firstFree(FIRST_VITE_PORT, (p) => isTaken(p) || FIREBASE_DEFAULTS.has(p))
  used.add(vite)
  const tsTaken = (p: number) => taken.tailscale.has(p)
  const tailscale = current.tailscale !== undefined && !tsTaken(current.tailscale)
    ? current.tailscale
    : firstFree(FIRST_TAILSCALE_PORT, tsTaken)

  // Emulators
  const names = Object.keys(current.emulators)
  const values = Object.values(current.emulators)
  const keepEmulators = values.every((p) => !isTaken(p) && !FIREBASE_DEFAULTS.has(p))
    && new Set(values).size === values.length

  const emulators: Record<string, number> = {}
  const spare: Record<string, number> = {}
  if (names.length === 0) {
    // No Firebase emulators in this repo
  } else if (keepEmulators) {
    Object.assign(emulators, current.emulators)
    values.forEach((p) => used.add(p))
    // Set the spares aside right after the project's own ports
    const after = Math.max(...values) + 1
    for (const name of SPARE_EMULATORS) {
      if (name in emulators) continue
      spare[name] = firstFree(after, (p) => isTaken(p) || FIREBASE_DEFAULTS.has(p))
      used.add(spare[name])
    }
  } else {
    const extra = names.filter((n) => !EMULATOR_SLOTS.includes(n))
    const slotOf = (name: string) => EMULATOR_SLOTS.includes(name)
      ? EMULATOR_SLOTS.indexOf(name)
      : EMULATOR_SLOTS.length + extra.indexOf(name)
    const wanted = [...names, ...SPARE_EMULATORS.filter((n) => !names.includes(n))]
      .sort((a, b) => slotOf(a) - slotOf(b))
    const takenPorts = [...taken.local.keys(), ...used]
    for (let base = BLOCK_START; base + BLOCK_SIZE <= 65536; base += BLOCK_SIZE) {
      // A block belongs to one project: skip any block someone holds a port in.
      if (takenPorts.some((p) => p >= base && p < base + BLOCK_SIZE)) continue
      for (const n of wanted) {
        if (names.includes(n)) emulators[n] = base + slotOf(n)
        else spare[n] = base + slotOf(n)
      }
      break
    }
  }

  if (current.vite !== undefined && current.vite !== vite) changes.push({ name: 'vite', from: current.vite, to: vite })
  if (current.tailscale !== undefined && current.tailscale !== tailscale) {
    changes.push({ name: 'tailscale', from: current.tailscale, to: tailscale })
  }
  for (const [name, port] of Object.entries(emulators)) {
    const from = current.emulators[name]
    if (from !== undefined && from !== port) changes.push({ name, from, to: port })
  }

  return { app: { vite, tailscale }, emulators, spare, changes }
}

/** What CodePipe detected about the app's dev server. */
export interface DevServerSetupInfo {
  /** 'vite' | 'nuxt' | 'next' | 'sveltekit' | 'angular', or null when unknown. */
  framework: string | null
  /** Folder holding the app's package.json, relative to the repo root; null = the root. */
  dir: string | null
  /** Whether that package.json already has a dev:remote script. */
  hasDevRemote: boolean
  /** The command CodePipe runs to start the dev server. */
  startCommand: string
}

export interface PortsSetupPromptInput {
  plan: PortsPlan
  /** Whether the repo already has a ports.json (a re-run). */
  hasPortsFile: boolean
  /** Firebase setup in the repo, or null when it has none. */
  firebase: { dir: string | null } | null
  taken: TakenPorts
  devServer: DevServerSetupInfo
  /** This machine's Tailscale hostname, when known. */
  tailscaleHost: string | null
  windows: boolean
}

/**
 * Where the framework's dev server takes its host and port. Getting this
 * wrong is the usual reason a server never comes up for CodePipe: Nuxt, for
 * one, ignores vite.server.port and stays on its default 3000.
 */
function devServerBindStep(framework: string | null, ports: string): string {
  const remoteHmr = `in remote mode, HMR = { protocol: 'wss', host: TAILSCALE_HOST, clientPort: app.tailscale } (if Vite warns that server.hmr.* is deprecated, use the server.ws.* keys it names); otherwise leave HMR at its defaults`
  switch (framework) {
    case 'nuxt':
      return `   - nuxt.config: Nuxt runs its own HTTP server and ignores vite.server.port, host and strictPort — a port set only there leaves Nuxt on its default 3000. Set devServer: { host: '0.0.0.0', port: app.vite } from ${ports}. Nuxt has no strictPort (a busy port makes it pick another, and CodePipe's start then fails), so don't pass --port or set PORT/NUXT_PORT anywhere — they override devServer.
   - dev:remote is \`nuxt dev --public\` (dev stays without it). Nuxt's CLI answers its own pages — the loading screen while it builds, the error page — with 403 "this host is not allowed" for any hostname it didn't bind, which includes the Tailscale one, and --public is its only opt-out (there's no config key). Safe on a tailnet.
   - Vite settings still go under vite.server in nuxt.config: allowedHosts: true (safe on a tailnet); ${remoteHmr}.`
    case 'next':
      return `   - Next takes host and port on the command line (next dev -H 0.0.0.0 -p <port>) and package.json can't read ${ports}, so dev and dev:remote run a small dependency-free Node launcher (e.g. scripts/dev.mjs) that reads app.vite from ${ports} and spawns next dev with those flags, passing stdio through.
   - next.config: in remote mode, add TAILSCALE_HOST to allowedDevOrigins, or Next blocks its dev assets on that origin. HMR uses the page's own origin, so it works through Tailscale with no more config.`
    case 'vite':
    case 'sveltekit':
      return `   - vite.config: server.host '0.0.0.0', server.port from app.vite with strictPort: true, server.allowedHosts: true (safe on a tailnet); ${remoteHmr}.`
    default:
      return `   - Find where this project's dev server takes its host and port — its own config or CLI flags; a vite.config only counts if the server listening on the port is Vite itself. Bind 0.0.0.0 on app.vite, failing rather than moving if the port is busy (a launcher script that reads ${ports} if the port can only be a CLI flag). Allow any Host header (safe on a tailnet), and in remote mode point the HMR/live-reload websocket at wss://TAILSCALE_HOST on port app.tailscale.`
  }
}

/**
 * The agent prompt that sets a project up for CodePipe remote dev: its
 * dev:remote script, a dev server bound where CodePipe expects it, and every
 * port centralized in ports.json.
 */
export function buildPortsSetupPrompt({
  plan, hasPortsFile, firebase, taken, devServer, tailscaleHost, windows,
}: PortsSetupPromptInput): string {
  const file = firebase
    ? { app: plan.app, emulators: plan.emulators }
    : { app: plan.app }
  const firebaseJson = firebase ? `${firebase.dir ? `${firebase.dir}/` : ''}firebase.json` : null
  const takenList = [...taken.entries()]
    .sort(([a], [b]) => a - b)
    .map(([port, owner]) => `${port} (${owner})`)
    .join(', ')
  const appDir = devServer.dir ? `${devServer.dir}/` : ''
  const host = tailscaleHost ?? '<this machine\'s Tailscale hostname>'
  const vite = plan.app.vite
  const listening = windows
    ? `\`netstat -aon | findstr :${vite}\` must show LISTENING on 0.0.0.0:${vite}`
    : `\`lsof -nP -iTCP:${vite} -sTCP:LISTEN\` must show it listening on *:${vite} or 0.0.0.0:${vite}`

  const changes = plan.changes.length > 0
    ? `These differ from what the repo uses now — update every reference to the old values:\n${plan.changes.map((c) => `   - ${c.name}: ${c.from} → ${c.to}`).join('\n')}`
    : 'These match what the repo uses now, so no port numbers change — the work is centralizing them.'

  const spare = Object.entries(plan.spare)
  const spareLine = spare.length > 0
    ? `If an emulator turns up that isn't listed (step 6), use these reserved ports: ${spare.map(([n, p]) => `${n} ${p}`).join(', ')}.`
    : ''

  const firebaseSteps = firebase ? `
2. ${firebaseJson} (leave it where it is): pin every emulator port explicitly from ${PORTS_FILE} — including ui, hub, logging, and firestore.websocketPort for "firestoreWebsocket". This is the only other copy of the ports, because the Firebase CLI can't read anything else. Change nothing else in firebase.json.
` : ''

  const browserEmulators = firebase ? `
   - If browser code uses the Firebase client-SDK emulators, route them through the dev server so they stay same-origin. Proxy these paths with the dev server's proxy (Vite: server.proxy; Nuxt: nitro.devProxy; Next: rewrites), targets from "emulators" (emulator paths are globally unique, so they don't clash with app routes): /identitytoolkit.googleapis.com, /securetoken.googleapis.com and /emulator → auth; /google.firestore.v1.Firestore → firestore (with websocket support); /v0 → storage (only if the browser uses it). In the client's emulator setup, branch on remote mode: remote → connectAuthEmulator(auth, window.location.origin, { disableWarnings: true }), and for Firestore initializeFirestore(app, { host: window.location.host, ssl: true, experimentalAutoDetectLongPolling: true }) instead of connectFirestoreEmulator (it forces ssl: false, which breaks on an https page); local → the usual 127.0.0.1 connections. Callable functions from the browser go through the same origin or move to the backend — never the raw functions emulator port.` : ''

  const checkScript = firebase ? `
4. scripts/check-ports.mjs — dependency-free Node (ESM), run before every test boot (wire it into the test and e2e scripts, e.g. as a pretest script). Clear one-line errors that name the port and what it's for.
   - Fail if ${firebaseJson} no longer matches ${PORTS_FILE}: compare key by key, port values only (each emulator's "port", plus firestore.websocketPort for "firestoreWebsocket"); ignore other settings such as enabled, host or singleProjectMode. Also fail if firebase.json has an emulator port ${PORTS_FILE} doesn't list.
   - Fail loudly if a port is taken, instead of letting a test connect to another project's emulator. Two modes: when the tests start their own emulators (emulators:exec), every emulator port must be free — check both 127.0.0.1 and ::1. When the tests connect to emulators that are already running, the ports must belong to THIS project: ask the emulator hub at http://127.0.0.1:<hub port>/emulators and check that the emulators and ports it lists match ${PORTS_FILE}. If the hub doesn't answer or lists other ports, another project holds them — fail.
` : devServer.framework === 'nuxt' ? `
4. Nuxt can't refuse a busy port (step 3), so CodePipe's start check is the guard — nothing to add here.
` : `
4. The dev server must fail loudly instead of silently moving to another port (strictPort, or step 3's equivalent for this framework).
`

  const verifyEmulators = firebase
    ? ` Then start the emulators once with the project's emulators script and read the whole startup output — the "All emulators ready" table, the "Emulator Hub host: … port: …" line and the "Other reserved ports: …" line. Any port that shows up there and isn't in ${PORTS_FILE} goes into both files. Stop the emulators, run scripts/check-ports.mjs, and run the tests once.`
    : ''

  const framework = devServer.framework ? ` It's a ${devServer.framework} app` : ' The framework wasn\'t detected'
  const where = devServer.dir
    ? `${framework} in ${devServer.dir}/ (its package.json and config live there; ${PORTS_FILE} stays at the repo root).`
    : `${framework} at the repo root.`

  return `${hasPortsFile ? `Re-check this project's CodePipe setup and its ${PORTS_FILE}, and bring them in line with the ports below.` : `Set this project up for CodePipe remote dev, with its ports centralized in a single ${PORTS_FILE} at the repo root.`} CodePipe starts the dev server with \`${devServer.startCommand}\`, serves it over Tailscale HTTPS, and waits for it to listen on app.vite — if nothing listens there within 30 seconds it kills the server. Every port the project opens on this machine is declared once, in ${PORTS_FILE}; everything else reads it. CodePipe, which runs several projects on this machine, reads ${PORTS_FILE} to catch collisions between projects.${where}

Use exactly these ports — CodePipe picked them to be free across every project on this machine:

\`\`\`json
${JSON.stringify(file, null, 2)}
\`\`\`

${changes}

Ports other projects on this machine use — never pick any of these: ${takenList || '(none known)'}.${spareLine ? `\n${spareLine}` : ''}

1. ${PORTS_FILE} (repo root): ports only — no comments, no extra keys (JSON can't hold comments; the explanation goes in CLAUDE.md).
   - "app": ports that aren't Firebase. "vite" is the dev server's local port, whatever the framework (the key is "vite" for every project). "tailscale" is the Tailscale HTTPS port CodePipe serves the dev server on — not a local port, but it lives here so nothing hardcodes it. Anything else the app opens later (a preview server, a webhook receiver) gets its own key here.${firebase ? `
   - "emulators": the same names as the "emulators" section of firebase.json, so each maps straight across. The one exception is "firestoreWebsocket", which is firebase.json's emulators.firestore.websocketPort.` : ''}
${firebaseSteps}
3. The dev server and everything else read ${PORTS_FILE}; they never define ports. Read the file from the repo root (a JSON import or fs.readFileSync + JSON.parse). "Remote mode" means process.env.TAILSCALE_HOST is set.
   - ${appDir}package.json: ${devServer.hasDevRemote ? 'the dev:remote script runs' : 'add a dev:remote script that runs'} the same dev server as dev, plus any remote-only flag named below. It sets no env vars: CodePipe sets TAILSCALE_HOST and TAILSCALE_PORT itself when it starts the server, and an inline \`set X=… &&\` on Windows bakes a trailing space into the value. Remove any TAILSCALE_HOST / TAILSCALE_PORT it sets now. dev keeps working unchanged for local use.
${devServerBindStep(devServer.framework, PORTS_FILE)}${firebase ? `
   - Every emulator proxy target comes from "emulators".` : ''}
   - Tests, e2e and scripts import ${PORTS_FILE}.
   - Browser code never imports ${PORTS_FILE}. Single-origin rule: the app is used remotely through one Tailscale https origin, so ${firebase ? 'emulator traffic goes through the dev server proxy and ' : ''}the browser never connects to a localhost port (on a phone, 127.0.0.1 is the phone; an https page can't call http endpoints either). Only the dev server config and Node-side code read the file.${browserEmulators}${firebase ? `
   - Cloud Functions code never imports ${PORTS_FILE}: the functions directory is deployed on its own, so a path outside it breaks the deploy. Inside the emulator, functions get FIRESTORE_EMULATOR_HOST, FIREBASE_AUTH_EMULATOR_HOST and the like automatically — rely on those.` : ''}
   - Search the codebase for hardcoded ports (old and new values)${firebase ? ' — connect*Emulator calls, *_EMULATOR_HOST in .env files and scripts, test and e2e configs, proxy targets —' : ''} and replace each with a read from ${PORTS_FILE}${firebase ? ' (or the emulator env var, inside Cloud Functions)' : ''}.
${checkScript}
5. CLAUDE.md (create it if missing): add one line — never hardcode a port; every port comes from ${PORTS_FILE}${firebase ? ` (${firebaseJson} is the only copy, kept in sync by scripts/check-ports.mjs)` : ''}; ${firebase ? 'browser code and Cloud Functions never import' : 'browser code never imports'} it.

6. Verify it the way CodePipe runs it: from the repo root, run \`${devServer.startCommand}\` with TAILSCALE_HOST=${host} in its environment. Once it's up, check the real socket, not just the banner: ${listening}. If it came up on another port (3000, 5173, …) or only on [::1], the port isn't reaching the server that actually listens — fix that, don't change the ports. Stop it afterwards.${verifyEmulators}

Don't change Tailscale Serve mappings yourself — CodePipe creates them from ${PORTS_FILE} when it starts the dev server. Once this is done, the project's dev server config in CodePipe should be the start command above; CodePipe takes the ports from ${PORTS_FILE}.`
}
