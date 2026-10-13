import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, readFile } from 'fs/promises'
import path from 'path'
import os from 'os'

import {
  PROVIDER_SETTINGS_SPECS,
  cleanProviderOverrides,
  getProviderSettingsSpec,
  resolveSettings,
  settingsToArgs,
  specToJson,
  validateProviderOverrides,
  validateSettingValues,
} from './provider-settings.js'
import { ProviderSettingsStore } from './provider-settings-store.js'

describe('provider settings specs', () => {
  it('cover every provider with an adapter, each with a verified docs date', () => {
    expect(PROVIDER_SETTINGS_SPECS.map((s) => s.provider).sort()).toEqual(['claude', 'gemini', 'kiro'])
    for (const spec of PROVIDER_SETTINGS_SPECS) {
      expect(spec.docsCheckedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      expect(spec.docsCheckedAgainst.length).toBeGreaterThan(0)
      expect(spec.docsUrl).toMatch(/^https:\/\//)
    }
  })

  it('declare unique keys, enum options that include the default, and an extraArgs escape hatch', () => {
    for (const spec of PROVIDER_SETTINGS_SPECS) {
      const keys = spec.settings.map((s) => s.key)
      expect(new Set(keys).size).toBe(keys.length)
      expect(keys[keys.length - 1]).toBe('extraArgs')
      for (const s of spec.settings) {
        if (s.type === 'enum') {
          expect(s.options?.map((o) => o.value)).toContain(s.default)
        }
        for (const set of [s.choices, s.suggestions]) {
          if (!set) continue
          const values = set.map((o) => o.value)
          expect(new Set(values).size).toBe(values.length)
        }
        if (s.suggestions) expect(s.type).toBe('string')
        if (s.choices) expect(s.type).toBe('list')
      }
    }
  })

  it('serialize without the arg builders', () => {
    const json = specToJson(getProviderSettingsSpec('claude')!)
    for (const s of json.settings) expect('args' in s).toBe(false)
    expect(json.docsCheckedOn).toBe(getProviderSettingsSpec('claude')!.docsCheckedOn)
    expect(typeof (json as { inactive?: unknown }).inactive).not.toBe('function')
  })

  it('mark Kiro settings inactive while the server runs Kiro over ACP', () => {
    const saved = process.env['KIRO_TRANSPORT']
    try {
      delete process.env['KIRO_TRANSPORT']
      expect(specToJson(getProviderSettingsSpec('kiro')!).inactive).toBeUndefined()
      process.env['KIRO_TRANSPORT'] = 'acp'
      expect(specToJson(getProviderSettingsSpec('kiro')!).inactive).toMatch(/ACP/)
    } finally {
      if (saved === undefined) delete process.env['KIRO_TRANSPORT']
      else process.env['KIRO_TRANSPORT'] = saved
    }
  })
})

describe('cleanProviderOverrides', () => {
  it('clears on null/undefined and on all-empty layers', () => {
    expect(cleanProviderOverrides(undefined)).toEqual({ ok: true, overrides: undefined })
    expect(cleanProviderOverrides(null)).toEqual({ ok: true, overrides: undefined })
    expect(cleanProviderOverrides({})).toEqual({ ok: true, overrides: undefined })
    expect(cleanProviderOverrides({ claude: {}, kiro: {} })).toEqual({ ok: true, overrides: undefined })
  })

  it('keeps valid layers and reports errors as one message', () => {
    expect(cleanProviderOverrides({ claude: { permissionMode: 'plan' }, kiro: {} })).toEqual({
      ok: true,
      overrides: { claude: { permissionMode: 'plan' } },
    })
    const bad = cleanProviderOverrides({ claude: { permissionMode: 'nah', nope: 1 } })
    expect(bad).toEqual({ ok: false, error: expect.stringMatching(/^claude: .*; claude: /) })
  })
})

describe('validateSettingValues', () => {
  it('accepts well-typed values and trims strings and lists', () => {
    const r = validateSettingValues('claude', {
      permissionMode: 'plan',
      skipPermissions: true,
      allowedTools: [' Read ', '', 'Bash(git:*)'],
      appendSystemPrompt: '  be terse ',
    })
    expect(r).toEqual({
      ok: true,
      values: { permissionMode: 'plan', skipPermissions: true, allowedTools: ['Read', 'Bash(git:*)'], appendSystemPrompt: 'be terse' },
    })
  })

  it('rejects unknown keys, wrong types and enum values off the list', () => {
    const r = validateSettingValues('claude', { nope: 1, skipPermissions: 'yes', permissionMode: 'yolo', allowedTools: 'Read' })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.errors).toHaveLength(4)
      expect(r.errors.join('\n')).toMatch(/Unknown setting "nope"/)
      expect(r.errors.join('\n')).toMatch(/"permissionMode" must be one of/)
    }
  })

  it('rejects providers without settings and non-object input', () => {
    expect(validateSettingValues('codex', {}).ok).toBe(false)
    expect(validateSettingValues('kiro', []).ok).toBe(false)
  })

  it('validates a per-provider override map, dropping empty layers', () => {
    const r = validateProviderOverrides({ kiro: { trustAllTools: false }, claude: {} })
    expect(r).toEqual({ ok: true, overrides: { kiro: { trustAllTools: false } } })
    const bad = validateProviderOverrides({ gemini: { mode: 'turbo' } })
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.errors[0]).toMatch(/^gemini: /)
  })
})

describe('resolveSettings', () => {
  const saved = { ...process.env }
  beforeEach(() => {
    delete process.env['CLAUDE_PERMISSION_MODE']
    delete process.env['CLAUDE_EXTRA_ARGS']
  })
  afterEach(() => {
    process.env = { ...saved }
  })

  it('starts from the spec defaults', () => {
    const { values, sources } = resolveSettings('kiro')
    expect(values['trustAllTools']).toBe(true)
    expect(values['extraArgs']).toEqual([])
    expect(sources['trustAllTools']).toBe('default')
  })

  it('reads env fallbacks when no layer sets a value', () => {
    process.env['CLAUDE_PERMISSION_MODE'] = 'plan'
    process.env['CLAUDE_EXTRA_ARGS'] = '--a  --b'
    const { values, sources } = resolveSettings('claude')
    expect(values['permissionMode']).toBe('plan')
    expect(values['extraArgs']).toEqual(['--a', '--b'])
    expect(sources['permissionMode']).toBe('env')
    expect(sources['extraArgs']).toBe('env')
  })

  it('ignores an env value that is not a valid option', () => {
    process.env['CLAUDE_PERMISSION_MODE'] = 'yolo'
    expect(resolveSettings('claude').values['permissionMode']).toBe('acceptEdits')
  })

  it('layers global < project < persona, tracking the winning source', () => {
    process.env['CLAUDE_PERMISSION_MODE'] = 'plan'
    const { values, sources } = resolveSettings('claude', {
      global: { permissionMode: 'acceptEdits', skipPermissions: true },
      project: { permissionMode: 'dontAsk', allowedTools: ['Read'] },
      persona: { permissionMode: 'bypassPermissions' },
    })
    expect(values['permissionMode']).toBe('bypassPermissions')
    expect(sources['permissionMode']).toBe('persona')
    expect(values['skipPermissions']).toBe(true)
    expect(sources['skipPermissions']).toBe('global')
    expect(values['allowedTools']).toEqual(['Read'])
    expect(sources['allowedTools']).toBe('project')
    expect(sources['appendSystemPrompt']).toBe('default')
  })

  it('returns nothing for a provider without a spec', () => {
    expect(resolveSettings('codex', { global: { x: 'y' } })).toEqual({ values: {}, sources: {} })
  })
})

describe('settingsToArgs', () => {
  it('emits flags in spec order with extra args last', () => {
    const args = settingsToArgs('gemini', {
      skipPermissions: true,
      mode: 'plan',
      sandbox: true,
      effort: '',
      agent: '',
      extraArgs: ['--x'],
    })
    expect(args).toEqual(['--dangerously-skip-permissions', '--mode', 'plan', '--sandbox', '--x'])
  })

  it('fills missing keys from the defaults', () => {
    expect(settingsToArgs('kiro', {})).toEqual(['--trust-all-tools'])
    expect(settingsToArgs('kiro', { trustAllTools: false })).toEqual(['--trust-tools='])
  })
})

describe('ProviderSettingsStore', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'codepipe-settings-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('starts empty without a file, persists sets, and reloads them', async () => {
    const store = new ProviderSettingsStore({ dataDir: dir })
    await store.load()
    expect(store.get('claude')).toEqual({})

    await store.set('claude', { permissionMode: 'plan' })
    await store.set('kiro', { trustAllTools: false, trustTools: ['fs_read'] })
    const onDisk = JSON.parse(await readFile(path.join(dir, 'provider-settings.json'), 'utf8'))
    expect(onDisk).toEqual({
      version: 1,
      providers: { claude: { permissionMode: 'plan' }, kiro: { trustAllTools: false, trustTools: ['fs_read'] } },
    })

    const reloaded = new ProviderSettingsStore({ dataDir: dir })
    await reloaded.load()
    expect(reloaded.get('kiro')).toEqual({ trustAllTools: false, trustTools: ['fs_read'] })
    // get() hands out copies
    reloaded.get('kiro')['trustAllTools'] = true
    expect(reloaded.get('kiro')['trustAllTools']).toBe(false)
  })

  it('clears a provider when set to no overrides', async () => {
    const store = new ProviderSettingsStore({ dataDir: dir })
    await store.load()
    await store.set('claude', { permissionMode: 'plan' })
    await store.set('claude', {})
    expect(store.all()).toEqual({})
    const onDisk = JSON.parse(await readFile(path.join(dir, 'provider-settings.json'), 'utf8'))
    expect(onDisk.providers).toEqual({})
  })
})
