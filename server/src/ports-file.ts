import { readFile } from 'fs/promises'
import path from 'path'
import { z } from 'zod'

// ---------------------------------------------------------------------------
// ports.json — a project's single declaration of every port it opens on this
// machine. Lives at the repo root; the project's own consumers (vite.config,
// tests, scripts) read it, and firebase.json holds the only copy.
//
//   app        ports that aren't Firebase: "vite" (dev server), "tailscale"
//              (the Tailscale HTTPS port it's served on), anything else later
//   emulators  firebase.json emulator names; "firestoreWebsocket" is
//              firebase.json's emulators.firestore.websocketPort
// ---------------------------------------------------------------------------

export const PORTS_FILE = 'ports.json'

const PortMapSchema = z.record(z.string(), z.number().int().positive().max(65535))

export const PortsFileSchema = z.object({
  app: PortMapSchema.default({}),
  emulators: PortMapSchema.default({}),
})

export type PortsFile = z.infer<typeof PortsFileSchema>

/** Read a project's ports.json; null when it's missing or malformed. */
export async function readPortsFile(projectPath: string): Promise<PortsFile | null> {
  let raw: string
  try {
    raw = await readFile(path.join(projectPath, PORTS_FILE), 'utf-8')
  } catch {
    return null
  }
  try {
    const parsed = PortsFileSchema.safeParse(JSON.parse(raw))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}
