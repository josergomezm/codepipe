import { existsSync } from 'fs'
import { readFile, readdir } from 'fs/promises'
import path from 'path'
import type { ProjectServiceConfig } from '../schemas.js'
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
const FIREBASE_DEFAULT_PORTS: Record<string, number> = {
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
}

export interface FirebaseDetectionResult {
  found: boolean
  firebaseDir: string | null       // relative path from project root
  scriptName: string | null        // npm script name
  startCommand: string | null
  defaultPorts: Record<string, number>
}

/**
 * Scan a project for firebase.json and a matching emulators script.
 */
export async function detectFirebaseEmulators(projectPath: string): Promise<FirebaseDetectionResult> {
  const result: FirebaseDetectionResult = {
    found: false,
    firebaseDir: null,
    scriptName: null,
    startCommand: null,
    defaultPorts: {},
  }

  // Search root and immediate subdirs for firebase.json
  const firebasePath = await findFirebaseJson(projectPath)
  if (!firebasePath) return result

  result.found = true
  const firebaseDir = path.dirname(firebasePath)
  result.firebaseDir = path.relative(projectPath, firebaseDir) || null

  // Parse firebase.json for the ports the emulators will actually bind:
  // explicit ports win, otherwise Firebase's built-in defaults apply.
  try {
    const raw = await readFile(firebasePath, 'utf-8')
    const config = JSON.parse(raw)
    if (config.emulators) {
      for (const [service, cfg] of Object.entries(config.emulators)) {
        const obj = (cfg && typeof cfg === 'object' ? cfg : {}) as Record<string, unknown>
        if (typeof obj.port === 'number') {
          result.defaultPorts[service] = obj.port
        } else if (obj.enabled !== false && FIREBASE_DEFAULT_PORTS[service] !== undefined) {
          result.defaultPorts[service] = FIREBASE_DEFAULT_PORTS[service]
        }
      }
      // The emulator hub always runs alongside the emulators
      if (result.defaultPorts['hub'] === undefined) {
        result.defaultPorts['hub'] = FIREBASE_DEFAULT_PORTS['hub']
      }
    }
  } catch {
    // Invalid firebase.json — still detected, just no ports
  }

  // Find a package.json with an emulators script
  const scriptInfo = await findEmulatorsScript(firebaseDir, projectPath)
  if (scriptInfo) {
    result.scriptName = scriptInfo.scriptName
    result.startCommand = scriptInfo.command
  }

  return result
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
    cwd: detection.firebaseDir ?? undefined,
  }
}

// ---------------------------------------------------------------------------
// Port parser (for stdout parsing at runtime)
// ---------------------------------------------------------------------------

/**
 * Parses Firebase emulator stdout for port assignments and UI URL.
 *
 * Matches lines like:
 *   │ Authentication 127.0.0.1:9099
 *   │ Firestore      127.0.0.1:8080
 *   i  View Emulator UI at http://127.0.0.1:4000/
 */
export const firebasePortParser: PortParser = (line: string, state: ServiceState) => {
  // Port table row: │ ServiceName  host:port
  const portMatch = /[│|]\s+(\w[\w\s]*\w)\s+([\d.]+):(\d+)/.exec(line)
  if (portMatch) {
    const service = portMatch[1].trim().toLowerCase().replace(/\s+/g, '-')
    state.ports[service] = { host: portMatch[2], port: parseInt(portMatch[3]) }
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
): Promise<{ scriptName: string; command: string } | null> {
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
          const subDir = path.relative(projectPath, dir) || null
          const run = pm === 'npm' ? `npm run ${name}` : `${pm} run ${name}`
          const command = subDir
            ? (pm === 'npm' ? `${run} --prefix ${subDir}` : `${run} --cwd ${subDir}`)
            : run
          return { scriptName: name, command }
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
