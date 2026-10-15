import { existsSync } from 'fs'
import { readFile, readdir } from 'fs/promises'
import path from 'path'
import type { ProjectServiceConfig } from '../schemas.js'
import { readPortsFile } from '../ports-file.js'
import type { PortParser, ServiceState } from '../service-manager.js'
import { randomUUID } from 'crypto'

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

/**
 * Firebase's built-in default ports — used when firebase.json configures an
 * emulator without an explicit port. Identical for every project, which is
 * why two projects on defaults collide.
 */
export const FIREBASE_DEFAULT_PORTS: Record<string, number> = {
  auth: 9099,
  functions: 5001,
  firestore: 8080,
  database: 9000,
  hosting: 5000,
  pubsub: 8085,
  storage: 9199,
  eventarc: 9299,
  dataconnect: 9399,
  tasks: 9499,
  ui: 4000,
  hub: 4400,
  logging: 4500,
  // Not an emulator entry: firebase.json's emulators.firestore.websocketPort
  firestoreWebsocket: 9150,
}

export interface FirebaseDetectionResult {
  found: boolean
  firebaseDir: string | null       // relative path from project root
  scriptDir: string | null         // relative dir holding the package.json with the script
  scriptName: string | null        // npm script name
  startCommand: string | null
  defaultPorts: Record<string, number>
  /** Where defaultPorts came from: the project's ports.json, or firebase.json (+ defaults). */
  portsSource: 'ports.json' | 'firebase.json' | null
}

/**
 * Scan a project for firebase.json and a matching emulators script.
 */
export async function detectFirebaseEmulators(projectPath: string): Promise<FirebaseDetectionResult> {
  const result: FirebaseDetectionResult = {
    found: false,
    firebaseDir: null,
    scriptDir: null,
    scriptName: null,
    startCommand: null,
    defaultPorts: {},
    portsSource: null,
  }

  // Search root and immediate subdirs for firebase.json
  const firebasePath = await findFirebaseJson(projectPath)
  if (!firebasePath) return result

  result.found = true
  const firebaseDir = path.dirname(firebasePath)
  result.firebaseDir = path.relative(projectPath, firebaseDir) || null

  // A project's ports.json is its declaration of every emulator port —
  // firebase.json is only a copy of it.
  const portsFile = await readPortsFile(projectPath)
  if (portsFile && Object.keys(portsFile.emulators).length > 0) {
    result.defaultPorts = { ...portsFile.emulators }
    result.portsSource = 'ports.json'
  } else {
    result.defaultPorts = await readFirebaseJsonPorts(firebasePath)
    if (Object.keys(result.defaultPorts).length > 0) result.portsSource = 'firebase.json'
  }

  // Find a package.json with an emulators script
  const scriptInfo = await findEmulatorsScript(firebaseDir, projectPath)
  if (scriptInfo) {
    result.scriptName = scriptInfo.scriptName
    result.startCommand = scriptInfo.command
    result.scriptDir = scriptInfo.dir
  }

  return result
}

/**
 * The ports firebase.json's emulators will bind: explicit ports win,
 * otherwise Firebase's built-in defaults apply — including the ports the
 * suite opens on its own (hub, logging, Firestore websocket).
 */
async function readFirebaseJsonPorts(firebasePath: string): Promise<Record<string, number>> {
  const ports: Record<string, number> = {}
  try {
    const config = JSON.parse(await readFile(firebasePath, 'utf-8'))
    if (!config.emulators) return ports
    for (const [service, cfg] of Object.entries(config.emulators)) {
      const obj = (cfg && typeof cfg === 'object' ? cfg : {}) as Record<string, unknown>
      if (typeof obj.port === 'number') {
        ports[service] = obj.port
      } else if (obj.enabled !== false && FIREBASE_DEFAULT_PORTS[service] !== undefined) {
        ports[service] = FIREBASE_DEFAULT_PORTS[service]
      }
      if (service === 'firestore' && service in ports) {
        ports['firestoreWebsocket'] = typeof obj.websocketPort === 'number'
          ? obj.websocketPort
          : FIREBASE_DEFAULT_PORTS['firestoreWebsocket']
      }
    }
    // The hub, logging and UI run alongside the others unless configured
    for (const always of ['ui', 'hub', 'logging']) {
      if (!(always in config.emulators)) ports[always] = FIREBASE_DEFAULT_PORTS[always]
    }
  } catch {
    // Invalid firebase.json — still detected, just no ports
  }
  return ports
}

/**
 * Build a ProjectServiceConfig from detection results.
 */
export function buildFirebaseServiceConfig(detection: FirebaseDetectionResult): ProjectServiceConfig | null {
  if (!detection.found || !detection.startCommand) return null
  return {
    id: randomUUID(),
    type: 'firebase-emulators',
    label: 'Firebase Emulators',
    startCommand: detection.startCommand,
    // The command is a bare `npm run <script>`, so it must run in the directory
    // that actually owns that script — not necessarily the firebase.json dir.
    cwd: detection.scriptDir ?? detection.firebaseDir ?? undefined,
    ports: Object.keys(detection.defaultPorts).length > 0 ? { ...detection.defaultPorts } : undefined,
  }
}

// ---------------------------------------------------------------------------
// Persisted ports
// ---------------------------------------------------------------------------

function samePorts(a: Record<string, number> | undefined, b: Record<string, number>): boolean {
  const aKeys = Object.keys(a ?? {})
  return aKeys.length === Object.keys(b).length && aKeys.every((k) => a![k] === b[k])
}

/**
 * Store detected firebase.json ports on a project's firebase-emulators
 * services. Returns the updated services list, or null when nothing changed.
 * A detection that read no ports (firebase.json gone or unparseable) leaves
 * the stored ports alone rather than wiping them.
 */
export function applyFirebasePorts(
  services: ProjectServiceConfig[] | undefined,
  detection: FirebaseDetectionResult,
): ProjectServiceConfig[] | null {
  if (!detection.found || Object.keys(detection.defaultPorts).length === 0) return null
  let changed = false
  const next = (services ?? []).map((svc) => {
    if (svc.type !== 'firebase-emulators' || samePorts(svc.ports, detection.defaultPorts)) return svc
    changed = true
    return { ...svc, ports: { ...detection.defaultPorts } }
  })
  return changed ? next : null
}

// ---------------------------------------------------------------------------
// Port parser (for stdout parsing at runtime)
// ---------------------------------------------------------------------------

/**
 * Parses Firebase emulator stdout for port assignments and UI URL.
 *
 * Expects ANSI-stripped lines (ServiceManager does that before parsing), like:
 *   │ Authentication │ 127.0.0.1:9099 │ http://127.0.0.1:4000/auth │
 *   │ Firestore      │ 127.0.0.1:8080 │ http://127.0.0.1:4000/firestore │
 *   i  View Emulator UI at http://127.0.0.1:4000/
 *     Emulator Hub host: 127.0.0.1 port: 4400
 */
export const firebasePortParser: PortParser = (line: string, state: ServiceState) => {
  // Port table row: │ ServiceName │ host:port │ …
  const portMatch = /^\s*[│|]\s*([A-Za-z][A-Za-z ]*?)\s*[│|]\s*([\d.]+):(\d+)\s*[│|]/.exec(line)
  if (portMatch) {
    const service = portMatch[1].trim().toLowerCase().replace(/\s+/g, '-')
    state.ports[service] = { host: portMatch[2], port: parseInt(portMatch[3]) }
    return
  }

  // The hub is reported outside the table
  const hubMatch = /Emulator Hub host:\s*([\d.]+)\s+port:\s*(\d+)/.exec(line)
  if (hubMatch) {
    state.ports['hub'] = { host: hubMatch[1], port: parseInt(hubMatch[2]) }
    return
  }

  // Emulator UI URL
  const uiMatch = /View Emulator UI at (https?:\/\/[^\s]+)/.exec(line)
  if (uiMatch) {
    state.uiUrl = uiMatch[1]
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function findFirebaseJson(projectPath: string): Promise<string | null> {
  // Check root
  const rootPath = path.join(projectPath, 'firebase.json')
  if (existsSync(rootPath)) return rootPath

  // Check immediate subdirs
  try {
    const entries = await readdir(projectPath, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name.startsWith('.')) continue
      const sub = path.join(projectPath, entry.name, 'firebase.json')
      if (existsSync(sub)) return sub
    }
  } catch {
    // Can't read dir
  }

  return null
}

async function findEmulatorsScript(
  firebaseDir: string,
  projectPath: string,
): Promise<{ scriptName: string; command: string; dir: string | null } | null> {
  // Look for package.json in firebaseDir, then project root
  const candidates = [firebaseDir]
  if (firebaseDir !== projectPath) candidates.push(projectPath)

  for (const dir of candidates) {
    const pkgPath = path.join(dir, 'package.json')
    if (!existsSync(pkgPath)) continue

    try {
      const raw = await readFile(pkgPath, 'utf-8')
      const pkg = JSON.parse(raw)
      const scripts = (pkg.scripts ?? {}) as Record<string, string>

      // Find a script whose value contains "firebase emulators:start"
      for (const [name, cmd] of Object.entries(scripts)) {
        if (cmd.includes('firebase emulators:start') || cmd.includes('firebase emulators:exec')) {
          const pm = detectPm(dir, projectPath)
          // No --prefix/--cwd flag here: the service config carries the
          // directory as its own `cwd`, and passing both made npm resolve
          // <dir>/<dir> and fail with ENOENT.
          const command = pm === 'npm' ? `npm run ${name}` : `${pm} run ${name}`
          return { scriptName: name, command, dir: path.relative(projectPath, dir) || null }
        }
      }
    } catch {
      // Invalid JSON
    }
  }

  return null
}

function detectPm(dir: string, projectRoot: string): string {
  for (const d of [projectRoot, dir]) {
    if (existsSync(path.join(d, 'bun.lockb')) || existsSync(path.join(d, 'bun.lock'))) return 'bun'
    if (existsSync(path.join(d, 'pnpm-lock.yaml'))) return 'pnpm'
    if (existsSync(path.join(d, 'yarn.lock'))) return 'yarn'
  }
  return 'npm'
}
