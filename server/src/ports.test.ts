import { describe, it, expect, vi } from 'vitest'
import { checkPortConflicts, serviceReservations, type ProjectPortInfo } from './ports.js'
import type { RunningService } from './service-manager.js'

// No real `tailscale serve status` in tests — no active mappings.
vi.mock('./tailscale.js', () => ({
  getServeStatus: () => ({ hostname: null, mappings: [] }),
}))

const emulators = (ports: Record<string, number>) => [{ label: 'Firebase Emulators', ports }]

const alpha: ProjectPortInfo = { id: 'alpha', name: 'Alpha', services: emulators({ firestore: 8080, hub: 4400 }) }
const beta: ProjectPortInfo = { id: 'beta', name: 'Beta', services: emulators({ firestore: 8080, auth: 9099 }) }

describe('checkPortConflicts with stored service ports', () => {
  it('flags another project whose stored emulator ports overlap, with nothing running', () => {
    const projects = [alpha, beta]
    const conflicts = checkPortConflicts(8080, 30000, projects, 'beta', serviceReservations(projects))
    expect(conflicts).toEqual([
      { port: 8080, type: 'local', owner: 'Alpha — Firebase Emulators (firestore)' },
    ])
  })

  it('does not flag a project against its own stored ports', () => {
    const projects = [alpha]
    expect(checkPortConflicts(4400, 30000, projects, 'alpha', serviceReservations(projects))).toEqual([])
  })
})

describe('serviceReservations', () => {
  const running = (projectId: string, ports: Record<string, number>): RunningService => ({
    projectId,
    serviceId: 'svc',
    label: 'Firebase Emulators',
    state: {
      status: 'running',
      ports: Object.fromEntries(Object.entries(ports).map(([k, port]) => [k, { host: '127.0.0.1', port }])),
      logs: [],
    },
  })

  it('lists a port held both stored and live once, plus live ports that drifted', () => {
    const reserved = serviceReservations([alpha], [running('alpha', { firestore: 8080, hub: 4401 })])
    expect(reserved.map((r) => r.port).sort()).toEqual([4400, 4401, 8080])
    expect(reserved.every((r) => r.projectId === 'alpha')).toBe(true)
  })
})
