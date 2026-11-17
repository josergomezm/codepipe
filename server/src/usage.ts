/**
 * Plan usage and limits, read from each provider CLI's own `/usage` command.
 *
 *   - Claude Code: `claude -p /usage --output-format json` — session, weekly
 *     and per-model windows as "<label>: N% used · resets <when>" lines.
 *   - Kiro: `kiro-cli chat --v2 --no-interactive /usage` — plan, reset date
 *     and credits used of the plan's allowance (the v3 engine sends slash
 *     commands to the model as a prompt instead of running them).
 *   - Antigravity: `agy -p /usage --output-format json` — structured
 *     `command.data.groups`.
 *
 * None of these is a model turn (no cost, no tokens). Results are cached so
 * the sidebar meter can poll cheaply; the modal forces a fresher read.
 */

import { execFile } from 'child_process'
import { homedir, platform } from 'os'

import type { ProviderType } from './schemas.js'
import { ISOLATED_CHILD } from './child-options.js'
import { resolveClaudeBinary } from './adapters/claude.js'
import { resolveKiroBinary } from './adapters/kiro.js'
import { resolveAgyBinary } from './adapters/gemini.js'
import { stripAnsi } from './adapters/strip-ansi.js'
import { log } from './logger.js'

export interface UsageWindow {
  /** As the CLI names it, e.g. "Current session", "Current week (all models)", "Credits". */
  label: string
  /** 0–100 (may exceed 100 when over); null when the CLI gives no percentage. */
  usedPercent: number | null
  /** When it resets, as the CLI words it (e.g. "Nov 21, 12am (America/New_York)"). */
  resets?: string
  /** Extra figure, e.g. "2000.00 of 2000 credits". */
  detail?: string
}

export interface ProviderUsage {
  provider: ProviderType
  status: 'ok' | 'error'
  /** Plan name when the CLI reports one (e.g. "KIRO PRO+", "Subscription"). */
  plan?: string
  windows: UsageWindow[]
  /** Other short lines worth showing (e.g. "Last 24h · 4860 requests · 8 sessions"). */
  notes: string[]
  error?: string
  /** Epoch ms of this reading. */
  checkedAt: number
}

// ---------------------------------------------------------------------------
// Parsers (pure — unit tested)
// ---------------------------------------------------------------------------

const PERCENT_LINE = /^(.+?):\s*(\d+(?:\.\d+)?)%\s*used(?:\s*[·•|-]\s*resets\s+(.+))?$/i

/** Parse the text Claude Code's `/usage` prints. */
export function parseClaudeUsage(text: string): Omit<ProviderUsage, 'provider' | 'checkedAt' | 'status'> {
  const lines = stripAnsi(text).split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  const windows: UsageWindow[] = []
  const notes: string[] = []
  let plan: string | undefined
  for (const line of lines) {
    const m = PERCENT_LINE.exec(line)
    if (m) {
      windows.push({ label: m[1].trim(), usedPercent: Number(m[2]), resets: m[3]?.trim() || undefined })
      continue
    }
    if (/using your subscription/i.test(line)) plan = 'Subscription'
    else if (/api (key|usage)|pay.as.you.go/i.test(line) && !plan) plan = 'API'
    // "Last 24h · 4860 requests · 8 sessions"
    if (/^Last \S+ · /.test(line)) notes.push(line)
  }
  return { plan, windows, notes }
}

/** Parse the text Kiro's `/usage` prints. */
export function parseKiroUsage(text: string): Omit<ProviderUsage, 'provider' | 'checkedAt' | 'status'> {
  const lines = stripAnsi(text).split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  const windows: UsageWindow[] = []
  const notes: string[] = []
  let plan: string | undefined
  let resets: string | undefined
  for (const line of lines) {
    // "Estimated Usage | resets on 2026-12-01 | KIRO PRO+"
    const head = /usage\s*\|\s*resets on\s+([^|]+?)\s*(?:\|\s*(.+))?$/i.exec(line)
    if (head) {
      resets = head[1].trim()
      plan = head[2]?.trim() || plan
      continue
    }
    // "Credits (2000.00 of 2000 covered in plan), 100.0%"
    const credits = /^(.+?)\s*\(\s*([\d.,]+)\s+of\s+([\d.,]+)[^)]*\)\s*,?\s*(\d+(?:\.\d+)?)%/.exec(line)
    if (credits) {
      windows.push({
        label: credits[1].trim(),
        usedPercent: Number(credits[4]),
        detail: `${credits[2]} of ${credits[3]}`,
      })
      continue
    }
    if (/limit|overage|bonus/i.test(line) && !/https?:\/\//.test(line)) notes.push(line)
  }
  for (const w of windows) w.resets ??= resets
  return { plan, windows, notes }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

const LABEL_KEYS = ['label', 'displayName', 'display_name', 'title', 'name', 'model', 'id']

function labelOf(o: Record<string, unknown>): string | undefined {
  for (const k of LABEL_KEYS) if (typeof o[k] === 'string' && (o[k] as string).trim()) return (o[k] as string).trim()
  return undefined
}

/** A used percentage from whatever fraction/percent field the object carries. */
function usedPercentOf(o: Record<string, unknown>): number | null {
  for (const [k, v] of Object.entries(o)) {
    if (typeof v !== 'number' || !Number.isFinite(v)) continue
    if (/remaining.*(fraction|ratio)/i.test(k)) return Math.round((1 - v) * 1000) / 10
    if (/remaining.*percent/i.test(k)) return Math.round((100 - v) * 10) / 10
    if (/(used|usage|utilization).*(fraction|ratio)|^utilization$/i.test(k)) return Math.round(v * 1000) / 10
    if (/(used|usage).*percent|percent.*used/i.test(k)) return v
  }
  return null
}

function resetsOf(o: Record<string, unknown>): string | undefined {
  for (const [k, v] of Object.entries(o)) {
    if (!/reset/i.test(k)) continue
    if (typeof v === 'string' && v.trim()) return v.trim()
    if (typeof v === 'number' && v > 0) return new Date(v < 1e12 ? v * 1000 : v).toISOString()
  }
  return undefined
}

/**
 * Parse Antigravity's `/usage` JSON. The group shape isn't documented, so
 * this walks it for anything that carries a label and a used/remaining
 * fraction or percentage.
 */
export function parseAgyUsage(json: string): Omit<ProviderUsage, 'provider' | 'checkedAt' | 'status'> {
  const parsed: unknown = JSON.parse(json)
  const data = isRecord(parsed) && isRecord(parsed['command']) ? parsed['command']['data'] : undefined
  const groups = isRecord(data) && Array.isArray(data['groups']) ? data['groups'] : []
  const windows: UsageWindow[] = []
  let plan: string | undefined
  if (isRecord(data)) {
    const p = data['plan'] ?? data['tier'] ?? data['subscription']
    if (typeof p === 'string' && p.trim()) plan = p.trim()
  }

  const walk = (node: unknown, prefix: string | undefined, depth: number) => {
    if (depth > 5) return
    if (Array.isArray(node)) {
      for (const n of node) walk(n, prefix, depth + 1)
      return
    }
    if (!isRecord(node)) return
    const label = labelOf(node)
    const used = usedPercentOf(node)
    if (used !== null) {
      const full = [prefix, label].filter(Boolean).join(' · ') || 'Quota'
      windows.push({ label: full, usedPercent: used, resets: resetsOf(node) })
    }
    for (const v of Object.values(node)) {
      if (typeof v === 'object' && v !== null) walk(v, used !== null ? prefix : label ?? prefix, depth + 1)
    }
  }
  walk(groups, undefined, 0)

  const notes = windows.length === 0 ? ['Antigravity reported no quota groups for this account.'] : []
  return { plan, windows, notes }
}

// ---------------------------------------------------------------------------
// Running the CLIs
// ---------------------------------------------------------------------------

const RUN_TIMEOUT_MS = 60_000

function run(command: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      {
        cwd: homedir(),
        timeout: RUN_TIMEOUT_MS,
        maxBuffer: 4 * 1024 * 1024,
        encoding: 'utf8',
        // An npm-installed `claude.cmd` can only be started through a shell.
        shell: platform() === 'win32' && /\.(cmd|bat)$/i.test(command),
        env: { ...process.env, NO_COLOR: '1' },
        ...ISOLATED_CHILD,
      },
      (err, stdout, stderr) => {
        if (err && !stdout.trim()) {
          const detail = stripAnsi(stderr || err.message).trim().split(/\r?\n/).slice(-3).join(' ')
          return reject(new Error(detail || 'command failed'))
        }
        resolve({ stdout, stderr: stderr ?? '' })
      },
    )
  })
}

type Reader = () => Promise<Omit<ProviderUsage, 'provider' | 'checkedAt' | 'status'>>

const READERS: Partial<Record<ProviderType, Reader>> = {
  claude: async () => {
    const { stdout } = await run(resolveClaudeBinary(), ['-p', '/usage', '--output-format', 'json'])
    const line = stdout.split(/\r?\n/).find((l) => l.trim().startsWith('{'))
    if (!line) throw new Error('No /usage output')
    const json = JSON.parse(line) as { result?: unknown }
    if (typeof json.result !== 'string') throw new Error('No /usage output')
    return parseClaudeUsage(json.result)
  },
  kiro: async () => {
    // Kiro prints parts of the report on stderr.
    const { stdout, stderr } = await run(resolveKiroBinary(), ['chat', '--v2', '--no-interactive', '/usage'])
    return parseKiroUsage(`${stdout}\n${stderr}`)
  },
  gemini: async () => {
    const { stdout } = await run(resolveAgyBinary(), ['-p', '/usage', '--output-format', 'json'])
    const line = stdout.split(/\r?\n/).find((l) => l.trim().startsWith('{'))
    if (!line) throw new Error('No /usage output')
    return parseAgyUsage(line)
  },
}

/** Providers with a usage reader, in display order. */
export const USAGE_PROVIDERS = Object.keys(READERS) as ProviderType[]

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

/** A reading younger than this is served as is. */
const FRESH_MS = 5 * 60_000
/** A forced refresh still reuses a reading this recent. */
const MIN_REFRESH_MS = 20_000

export class UsageService {
  private readonly cache = new Map<ProviderType, ProviderUsage>()
  private readonly inFlight = new Map<ProviderType, Promise<ProviderUsage>>()

  constructor(private readonly readers: Partial<Record<ProviderType, Reader>> = READERS) {}

  /** Every provider's usage; `refresh` re-reads anything older than a few seconds. */
  async getAll(opts: { refresh?: boolean } = {}): Promise<ProviderUsage[]> {
    const providers = Object.keys(this.readers) as ProviderType[]
    return Promise.all(providers.map((p) => this.get(p, opts.refresh ?? false)))
  }

  private get(provider: ProviderType, refresh: boolean): Promise<ProviderUsage> {
    const cached = this.cache.get(provider)
    const maxAge = refresh ? MIN_REFRESH_MS : FRESH_MS
    if (cached && Date.now() - cached.checkedAt < maxAge) return Promise.resolve(cached)
    const pending = this.inFlight.get(provider)
    if (pending) return pending

    const reader = this.readers[provider]!
    const p = reader()
      .then((r): ProviderUsage => ({ provider, status: 'ok', ...r, checkedAt: Date.now() }))
      .catch((err: unknown): ProviderUsage => {
        const message = err instanceof Error ? err.message : String(err)
        log.warn('usage', `Failed to read ${provider} usage: ${message}`)
        // Keep showing the last good reading's numbers alongside the error.
        return {
          provider,
          status: 'error',
          plan: cached?.plan,
          windows: cached?.windows ?? [],
          notes: [],
          error: message,
          checkedAt: Date.now(),
        }
      })
      .then((r) => {
        this.cache.set(provider, r)
        this.inFlight.delete(provider)
        return r
      })
    this.inFlight.set(provider, p)
    return p
  }
}
