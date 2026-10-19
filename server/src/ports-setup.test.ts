import { describe, it, expect } from 'vitest'
import { buildPortsSetupPrompt, collectTakenPorts, planAsExtraPorts, planProjectPorts, type TakenPorts } from './ports-setup.js'
import { devServerFromPortsFile } from './project-ports.js'
import type { ProjectPortInfo } from './ports.js'

const none = () => ({ local: new Map() as TakenPorts, tailscale: new Map() as TakenPorts })

const ON_DEFAULTS = { auth: 9099, firestore: 8080, firestoreWebsocket: 9150, ui: 4000, hub: 4400, logging: 4500 }

describe('planProjectPorts', () => {
  it('keeps ports that are already unique, so a re-run changes nothing', () => {
    const emulators = { ui: 10100, hub: 10101, auth: 10103 }
    const plan = planProjectPorts({ vite: 5174, tailscale: 51644, emulators }, none())
    expect(plan.app).toEqual({ vite: 5174, tailscale: 51644 })
    expect(plan.emulators).toEqual(emulators)
    expect(plan.changes).toEqual([])
    expect(Object.keys(plan.spare).sort()).toEqual(['eventarc', 'tasks'])
    for (const p of Object.values(plan.spare)) expect(Object.values(emulators)).not.toContain(p)
  })

  it('moves a project on Firebase defaults into the first free block', () => {
    const taken = none()
    taken.local.set(10003, 'Dirumed App — Firebase Emulators (auth)') // block 10000's auth slot
    const plan = planProjectPorts({ vite: 5173, tailscale: 5173, emulators: ON_DEFAULTS }, taken)
    expect(plan.emulators).toEqual({
      ui: 10100, hub: 10101, logging: 10102, auth: 10103, firestore: 10105, firestoreWebsocket: 10106,
    })
    expect(plan.spare).toEqual({ eventarc: 10111, tasks: 10112 })
    expect(plan.changes).toContainEqual({ name: 'auth', from: 9099, to: 10103 })
    expect(plan.app.vite).toBe(5173)
  })

  it('skips a whole block when another project holds any port in it', () => {
    const taken = none()
    taken.local.set(10050, 'Stadium Photo Hunt — Firebase Emulators (database)')
    const plan = planProjectPorts({ vite: 5173, tailscale: 5173, emulators: { hub: 4400 } }, taken)
    expect(plan.emulators).toEqual({ hub: 10101 })
  })

  it('moves the dev server off a port another project holds', () => {
    const taken = none()
    taken.local.set(5173, 'Teremu App (dev server)')
    taken.local.set(5174, 'Dirumed App (dev server)')
    taken.tailscale.set(8443, 'HDEC Website (dev server)')
    const plan = planProjectPorts({ vite: 5173, emulators: {} }, taken)
    expect(plan.app).toEqual({ vite: 5175, tailscale: 8444 })
    expect(plan.changes).toEqual([{ name: 'vite', from: 5173, to: 5175 }])
    expect(plan.spare).toEqual({})
  })
})

describe('collectTakenPorts', () => {
  const projects: ProjectPortInfo[] = [
    { id: 'me', name: 'Me', devServer: { port: 5173, tailscalePort: 5173 }, services: [{ label: 'Firebase Emulators', ports: { auth: 9099 } }] },
    { id: 'other', name: 'Other', devServer: { port: 5174, tailscalePort: 8443 }, services: [{ label: 'Firebase Emulators', ports: { auth: 9299 } }] },
  ]

  it("lists other projects' ports and CodePipe's, never this project's own", () => {
    const taken = collectTakenPorts('me', projects, [], [
      { tailscalePort: 5173, localPort: 5173 } as never, // this project's own mapping
      { tailscalePort: 9443, localPort: 3000 } as never,
    ])
    expect([...taken.local.keys()].sort((a, b) => a - b)).toEqual([3000, 5174, 5551, 5552, 9299])
    expect([...taken.tailscale.keys()].sort((a, b) => a - b)).toEqual([443, 8443, 9443])
  })

  it("counts ports other repos declare and other projects' handed-out plans", () => {
    const otherPlan = planProjectPorts({ vite: 5180, tailscale: 8450, emulators: { hub: 4400 } }, none())
    const taken = collectTakenPorts('me', projects, [], [], [
      { projectId: 'other', port: 4400, owner: 'Other — Firebase Emulators (hub)', kind: 'local' },
      { projectId: 'me', port: 4401, owner: 'Me — Firebase Emulators (ui)', kind: 'local' },
      ...planAsExtraPorts('later', 'Later', otherPlan),
    ])
    expect(taken.local.get(4400)).toBe('Other — Firebase Emulators (hub)')
    expect(taken.local.has(4401)).toBe(false)
    expect(taken.local.get(10001)).toBe('Later (hub, being set up)')
    expect(taken.tailscale.get(8450)).toBe('Later (tailscale, being set up)')
    // …so the next plan lands in the next block
    expect(planProjectPorts({ emulators: { hub: 4400 } }, taken).emulators).toEqual({ hub: 10101 })
  })
})

describe('buildPortsSetupPrompt', () => {
  const viteApp = { framework: 'vite', dir: null, hasDevRemote: true, startCommand: 'npm run dev:remote' }
  const base = { tailscaleHost: 'box.tail1.ts.net', windows: true, devServer: viteApp }

  it('hands the agent the exact ports, the changes and the enforcement steps', () => {
    const taken = none()
    const plan = planProjectPorts({ vite: 5173, tailscale: 5173, emulators: ON_DEFAULTS }, taken)
    const prompt = buildPortsSetupPrompt({ ...base, plan, hasPortsFile: false, firebase: { dir: 'firebase' }, taken: taken.local })
    expect(prompt).toContain(JSON.stringify({ app: plan.app, emulators: plan.emulators }, null, 2))
    expect(prompt).toContain('auth: 9099 → 10003')
    expect(prompt).toContain('firebase/firebase.json')
    expect(prompt).toContain('scripts/check-ports.mjs')
    expect(prompt).toContain('CLAUDE.md')
    expect(prompt).toContain('/identitytoolkit.googleapis.com')
  })

  it('leaves the emulator steps out of a repo without Firebase', () => {
    const plan = planProjectPorts({ vite: 5180, tailscale: 8450, emulators: {} }, none())
    const prompt = buildPortsSetupPrompt({ ...base, plan, hasPortsFile: true, firebase: null, taken: new Map() })
    expect(prompt).not.toContain('check-ports.mjs')
    expect(prompt).not.toContain('"emulators"')
    expect(prompt).not.toContain('identitytoolkit')
    expect(prompt).toContain('no port numbers change')
  })

  it("puts a Nuxt app's port in devServer, where Nuxt reads it", () => {
    const plan = planProjectPorts({ vite: 2999, tailscale: 2999, emulators: {} }, none())
    const prompt = buildPortsSetupPrompt({
      ...base, plan, hasPortsFile: true, firebase: null, taken: new Map(),
      devServer: { framework: 'nuxt', dir: 'www', hasDevRemote: true, startCommand: 'npm run dev:remote --prefix www' },
    })
    expect(prompt).toContain("devServer: { host: '0.0.0.0', port: app.vite }")
    expect(prompt).toContain('ignores vite.server.port')
    expect(prompt).toContain('`nuxt dev --public`')
    expect(prompt).toContain('www/package.json')
    expect(prompt).toContain('`npm run dev:remote --prefix www`')
    expect(prompt).toContain('netstat -aon | findstr :2999')
  })

  it('has a new project add dev:remote without baking env vars into it', () => {
    const plan = planProjectPorts({ emulators: {} }, none())
    const prompt = buildPortsSetupPrompt({
      ...base, plan, hasPortsFile: false, firebase: null, taken: new Map(),
      devServer: { framework: 'next', dir: null, hasDevRemote: false, startCommand: 'pnpm run dev:remote' },
    })
    expect(prompt).toContain('add a dev:remote script')
    expect(prompt).toContain('CodePipe sets TAILSCALE_HOST and TAILSCALE_PORT itself')
    expect(prompt).toContain('next dev -H 0.0.0.0')
    expect(prompt).toContain('allowedDevOrigins')
    expect(prompt).toContain('TAILSCALE_HOST=box.tail1.ts.net')
  })
})

describe('devServerFromPortsFile', () => {
  const devServer = { startCommand: 'npm run dev:remote', port: 5173, tailscalePort: 5173 }

  it('applies app.vite and app.tailscale from ports.json', () => {
    expect(devServerFromPortsFile(devServer, { app: { vite: 5180, tailscale: 8450 }, emulators: {} }))
      .toEqual({ ...devServer, port: 5180, tailscalePort: 8450 })
  })

  it('returns null when nothing changes or there is no dev server to update', () => {
    expect(devServerFromPortsFile(devServer, { app: { vite: 5173 }, emulators: {} })).toBeNull()
    expect(devServerFromPortsFile(undefined, { app: { vite: 5180 }, emulators: {} })).toBeNull()
    expect(devServerFromPortsFile(devServer, null)).toBeNull()
  })
})
