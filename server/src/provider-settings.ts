/**
 * Per-provider launch settings — the flags each CLI is started with.
 *
 * Every provider declares a small, typed set of settings (permission mode,
 * tool trust, effort, extra args…). Each setting knows how to turn its value
 * into CLI args, so adapters just splice `settingsToArgs()` into their
 * command line. The declarations double as the UI schema: the client renders
 * the settings page straight from them, VS Code style.
 *
 * Values resolve in layers, later wins:
 *   spec default → env var (legacy config) → global → project → persona
 * Each layer stores only the keys it overrides.
 *
 * Keep `docsCheckedOn` honest: it's the date the flag list was last verified
 * against the CLI (its `--help` or reference docs), shown at the bottom of
 * the settings page so a stale entry is obvious.
 */

import type { ProviderType } from './schemas.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SettingValue = string | boolean | string[]
export type SettingValues = Record<string, SettingValue>
export type SettingSource = 'default' | 'env' | 'global' | 'project' | 'persona'

export interface SettingOption {
  value: string
  label: string
  /** Shown when this option is selected (e.g. it broadens tool access). */
  caution?: string
}

export interface ProviderSettingSpec {
  key: string
  label: string
  description: string
  /** `list` is a string[] — tool names, raw flags… entered one per line / space-separated. */
  type: 'enum' | 'boolean' | 'string' | 'list'
  options?: SettingOption[]
  /**
   * For lists: known entries rendered as toggles. The value may still hold
   * entries outside this set (patterns, custom tool names).
   */
  choices?: SettingOption[]
  /** For strings: common values offered in a picker, with a custom escape hatch. */
  suggestions?: SettingOption[]
  default: SettingValue
  /** Env var consulted when no layer sets the value (the pre-UI configuration). */
  env?: string
  /** For booleans: shown while the value is true. */
  caution?: string
  /** For strings: a multi-line editor (system prompts…). */
  multiline?: boolean
  /**
   * CLI args for a value. Gets every resolved value too, for settings that
   * depend on another (Kiro's trusted-tool list only applies when
   * trust-all is off).
   */
  args: (value: SettingValue, all: SettingValues) => string[]
}

export interface ProviderSettingsSpec {
  provider: ProviderType
  /** Where the flags are documented. */
  docsUrl: string
  /** Date (YYYY-MM-DD) the flag list below was last checked against the CLI. */
  docsCheckedOn: string
  /** What it was checked against (CLI version, `--help`, docs page…). */
  docsCheckedAgainst: string
  /** Shown above the settings, e.g. which transport they apply to. */
  note?: string
  /**
   * Why these settings are not in effect right now, if they aren't — e.g.
   * the server runs the provider over a transport that ignores them.
   * Evaluated per request, since it depends on the server's configuration.
   */
  inactive?: () => string | null
  settings: ProviderSettingSpec[]
}

/** The spec as sent to the client — no functions. */
export type ProviderSettingsSpecJson = Omit<ProviderSettingsSpec, 'settings' | 'inactive'> & {
  settings: Omit<ProviderSettingSpec, 'args'>[]
  /** Set when the settings are currently not in effect (see ProviderSettingsSpec.inactive). */
  inactive?: string
}

export interface ResolvedSettings {
  values: SettingValues
  sources: Record<string, SettingSource>
}

// ---------------------------------------------------------------------------
// Helpers for specs
// ---------------------------------------------------------------------------

const asString = (v: SettingValue): string => (typeof v === 'string' ? v : '')
const asList = (v: SettingValue): string[] => (Array.isArray(v) ? v : [])

/** `--flag value` when the string is non-empty, nothing otherwise. */
const stringFlag = (flag: string) => (v: SettingValue): string[] => {
  const s = asString(v).trim()
  return s.length > 0 ? [flag, s] : []
}
/** `--flag` when true. */
const boolFlag = (flag: string) => (v: SettingValue): string[] => (v === true ? [flag] : [])
/** Raw extra args, appended as given. */
const rawArgs = (v: SettingValue): string[] => asList(v)

const EFFORT_OPTIONS: SettingOption[] = [
  { value: '', label: 'CLI default' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'Extra high' },
  { value: 'max', label: 'Max' },
]

const EXTRA_ARGS_SPEC = (env?: string): ProviderSettingSpec => ({
  key: 'extraArgs',
  label: 'Extra arguments',
  description: 'Raw flags appended to every launch, exactly as typed. For anything the settings above don\'t cover.',
  type: 'list',
  default: [],
  ...(env ? { env } : {}),
  args: rawArgs,
})

// ---------------------------------------------------------------------------
// Provider specs
// ---------------------------------------------------------------------------

// The variadic flags (--allowedTools, --disallowedTools) come first in the
// spec so a non-variadic option always follows them and nothing positional
// gets swallowed.
/**
 * Claude Code's built-in tools that matter for permissions — the names are
 * the exact strings permission rules use (code.claude.com/docs/en/tools-reference).
 */
const CLAUDE_TOOL_CHOICES: SettingOption[] = [
  { value: 'Bash', label: 'Bash', caution: 'Any shell command.' },
  { value: 'PowerShell', label: 'PowerShell', caution: 'Any PowerShell command.' },
  { value: 'Edit', label: 'Edit' },
  { value: 'Write', label: 'Write' },
  { value: 'NotebookEdit', label: 'NotebookEdit' },
  { value: 'Read', label: 'Read' },
  { value: 'Glob', label: 'Glob' },
  { value: 'Grep', label: 'Grep' },
  { value: 'LSP', label: 'LSP' },
  { value: 'WebFetch', label: 'WebFetch' },
  { value: 'WebSearch', label: 'WebSearch' },
  { value: 'Agent', label: 'Agent (subagents)' },
  { value: 'Skill', label: 'Skill' },
  { value: 'Monitor', label: 'Monitor' },
  { value: 'EnterWorktree', label: 'EnterWorktree' },
  { value: 'Artifact', label: 'Artifact' },
]

const CLAUDE_SPEC: ProviderSettingsSpec = {
  provider: 'claude',
  docsUrl: 'https://code.claude.com/docs/en/cli-reference',
  docsCheckedOn: '2026-10-13',
  docsCheckedAgainst: '`claude --help` (Claude Code 2.1.282) and the tools reference at code.claude.com',
  settings: [
    {
      key: 'allowedTools',
      label: 'Allowed tools',
      description: 'Tools pre-approved without prompting. A whole tool, or a pattern like Bash(git *) for one command family. CodePipe\'s own MCP tools are always added.',
      type: 'list',
      choices: [
        ...CLAUDE_TOOL_CHOICES,
        { value: 'Bash(git *)', label: 'git commands' },
        { value: 'Bash(npm *)', label: 'npm commands' },
        { value: 'Bash(npx *)', label: 'npx commands' },
        { value: 'Bash(node *)', label: 'node' },
        { value: 'Bash(python *)', label: 'python' },
      ],
      default: [],
      // The adapter merges CodePipe's MCP tool names into this list first.
      args: (v) => (asList(v).length > 0 ? ['--allowedTools', asList(v).join(',')] : []),
    },
    {
      key: 'disallowedTools',
      label: 'Disallowed tools',
      description: 'Tools the agent can never use. A whole tool, or a pattern like Bash(rm *) for one command family.',
      type: 'list',
      choices: [
        ...CLAUDE_TOOL_CHOICES.map(({ caution: _c, ...o }) => o),
        { value: 'Bash(rm *)', label: 'rm' },
        { value: 'Bash(git push *)', label: 'git push' },
        { value: 'Bash(sudo *)', label: 'sudo' },
        { value: 'Bash(curl *)', label: 'curl' },
      ],
      default: [],
      args: (v) => (asList(v).length > 0 ? ['--disallowedTools', ...asList(v)] : []),
    },
    {
      key: 'permissionMode',
      label: 'Permission mode',
      description: 'How Claude Code handles tool approvals. Print mode can\'t ask, so anything not pre-approved by the mode is denied.',
      type: 'enum',
      options: [
        { value: 'default', label: 'Default (ask — denied headless)' },
        { value: 'acceptEdits', label: 'Accept edits' },
        { value: 'auto', label: 'Auto' },
        { value: 'plan', label: 'Plan (read-only)' },
        { value: 'dontAsk', label: 'Don\'t ask (deny unlisted)' },
        { value: 'manual', label: 'Manual' },
        {
          value: 'bypassPermissions',
          label: 'Bypass permissions',
          caution: 'Every tool runs without approval, including shell commands. See SECURITY.md.',
        },
      ],
      default: 'acceptEdits',
      env: 'CLAUDE_PERMISSION_MODE',
      args: stringFlag('--permission-mode'),
    },
    {
      key: 'skipPermissions',
      label: 'Skip all permission checks',
      description: 'Adds --dangerously-skip-permissions: full autonomy (Bash, network, everything).',
      type: 'boolean',
      default: false,
      caution: 'Nothing is gated. Only for projects where you trust the agent completely.',
      args: boolFlag('--dangerously-skip-permissions'),
    },
    {
      key: 'appendSystemPrompt',
      label: 'Append to system prompt',
      description: 'Extra standing instructions, added to Claude Code\'s default system prompt on every turn.',
      type: 'string',
      multiline: true,
      default: '',
      args: stringFlag('--append-system-prompt'),
    },
    {
      key: 'fallbackModel',
      label: 'Fallback model',
      description: 'Model to fall back to automatically when the selected one is overloaded.',
      type: 'string',
      suggestions: [
        { value: '', label: 'None' },
        { value: 'sonnet', label: 'Sonnet (latest)' },
        { value: 'opus', label: 'Opus (latest)' },
        { value: 'haiku', label: 'Haiku (latest)' },
        { value: 'fable', label: 'Fable (latest)' },
      ],
      default: '',
      args: stringFlag('--fallback-model'),
    },
    EXTRA_ARGS_SPEC('CLAUDE_EXTRA_ARGS'),
  ],
}

/**
 * Kiro's built-in tools, by the names `--trust-tools` takes
 * (kiro.dev/docs/reference/built-in-tools; `fs_read` / `fs_write` /
 * `execute_bash` are the aliases the CLI's own help uses).
 */
const KIRO_TOOL_CHOICES: SettingOption[] = [
  { value: 'fs_read', label: 'Read files' },
  { value: 'fs_write', label: 'Write files' },
  { value: 'execute_bash', label: 'Shell commands', caution: 'Any shell command.' },
  { value: 'glob', label: 'Find files' },
  { value: 'grep', label: 'Search contents' },
  { value: 'code', label: 'Code intelligence' },
  { value: 'web_search', label: 'Web search' },
  { value: 'web_fetch', label: 'Web fetch' },
  { value: 'subagent', label: 'Subagents' },
  { value: 'delegate', label: 'Background agents' },
  { value: 'use_aws', label: 'AWS CLI' },
  { value: 'tool_search', label: 'MCP tool search' },
  { value: 'knowledge', label: 'Knowledge base' },
  { value: 'thinking', label: 'Thinking' },
  { value: 'todo', label: 'To-do list' },
  { value: 'introspect', label: 'Kiro docs' },
  { value: 'report', label: 'Report issue' },
]

const KIRO_SPEC: ProviderSettingsSpec = {
  provider: 'kiro',
  docsUrl: 'https://kiro.dev/docs/cli/chat/',
  docsCheckedOn: '2026-10-13',
  docsCheckedAgainst: '`kiro-cli chat --help` (kiro-cli-chat 2.30.0) and the built-in tools reference at kiro.dev',
  note: 'Applies to the non-interactive transport (`kiro-cli chat --no-interactive`).',
  inactive: () =>
    (process.env['KIRO_TRANSPORT'] ?? '').toLowerCase() === 'acp'
      ? 'Not in effect: this server runs Kiro over ACP (KIRO_TRANSPORT=acp), where tool approvals are answered over the protocol and these flags are not passed. They apply again if the server is started without KIRO_TRANSPORT.'
      : null,
  settings: [
    {
      key: 'trustAllTools',
      label: 'Trust all tools',
      description: 'Adds --trust-all-tools: the agent runs any tool without confirmation. Off, only the trusted tools below run; everything else is denied (non-interactive mode can\'t prompt).',
      type: 'boolean',
      default: true,
      caution: 'Any tool, including shell commands, runs without approval.',
      args: boolFlag('--trust-all-tools'),
    },
    {
      key: 'trustTools',
      label: 'Trusted tools',
      description: 'With trust-all off: the only tools that run without asking. Empty trusts none. MCP tools can be added by name.',
      type: 'list',
      choices: KIRO_TOOL_CHOICES,
      default: [],
      args: (v, all) => (all['trustAllTools'] === true ? [] : [`--trust-tools=${asList(v).join(',')}`]),
    },
    {
      key: 'agent',
      label: 'Agent profile',
      description: 'Kiro agent to run as (--agent). `kiro-cli agent list` shows the ones installed, including your custom agents.',
      type: 'string',
      suggestions: [
        { value: '', label: 'Default agent' },
        { value: 'kiro_default', label: 'kiro_default (built-in)' },
        { value: 'kiro_planner', label: 'kiro_planner (built-in)' },
        { value: 'kiro_help', label: 'kiro_help (built-in)' },
      ],
      default: '',
      args: stringFlag('--agent'),
    },
    {
      key: 'effort',
      label: 'Effort',
      description: 'Initial reasoning effort (--effort).',
      type: 'enum',
      options: EFFORT_OPTIONS,
      default: '',
      args: stringFlag('--effort'),
    },
    EXTRA_ARGS_SPEC(),
  ],
}

const GEMINI_SPEC: ProviderSettingsSpec = {
  provider: 'gemini',
  docsUrl: 'https://antigravity.google/docs/cli',
  docsCheckedOn: '2026-10-13',
  docsCheckedAgainst: '`agy --help`, Antigravity CLI 1.3.2',
  settings: [
    {
      key: 'skipPermissions',
      label: 'Auto-approve tool permissions',
      description: 'Adds --dangerously-skip-permissions. Headless mode can\'t prompt, so with this off agy silently denies shell commands, even in accept-edits mode.',
      type: 'boolean',
      default: true,
      caution: 'Every tool permission request is approved, including shell commands.',
      args: boolFlag('--dangerously-skip-permissions'),
    },
    {
      key: 'mode',
      label: 'Execution mode',
      description: 'Agent execution mode for the session (--mode).',
      type: 'enum',
      options: [
        { value: '', label: 'CLI default' },
        { value: 'accept-edits', label: 'Accept edits' },
        { value: 'plan', label: 'Plan' },
      ],
      default: '',
      args: stringFlag('--mode'),
    },
    {
      key: 'sandbox',
      label: 'Sandbox',
      description: 'Run with terminal restrictions enabled (--sandbox).',
      type: 'boolean',
      default: false,
      args: boolFlag('--sandbox'),
    },
    {
      key: 'effort',
      label: 'Effort',
      description: 'Reasoning effort for the session (--effort).',
      type: 'enum',
      options: EFFORT_OPTIONS,
      default: '',
      args: stringFlag('--effort'),
    },
    {
      key: 'agent',
      label: 'Agent',
      description: 'Agent for the session (--agent). `agy agents` lists them.',
      type: 'string',
      default: '',
      args: stringFlag('--agent'),
    },
    EXTRA_ARGS_SPEC(),
  ],
}

/** Providers with launch settings — those with a server adapter. */
export const PROVIDER_SETTINGS_SPECS: readonly ProviderSettingsSpec[] = [CLAUDE_SPEC, KIRO_SPEC, GEMINI_SPEC]

export function getProviderSettingsSpec(provider: ProviderType): ProviderSettingsSpec | undefined {
  return PROVIDER_SETTINGS_SPECS.find((s) => s.provider === provider)
}

/** Strip the arg builders for the wire, and evaluate `inactive` for this server. */
export function specToJson(spec: ProviderSettingsSpec): ProviderSettingsSpecJson {
  const { inactive, ...rest } = spec
  const reason = inactive?.() ?? null
  return {
    ...rest,
    settings: spec.settings.map(({ args: _args, ...s }) => s),
    ...(reason ? { inactive: reason } : {}),
  }
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export type ValidationResult = { ok: true; values: SettingValues } | { ok: false; errors: string[] }

/**
 * Check one layer's overrides against the provider's spec: known keys, right
 * types, enum values from the list. Strings are trimmed, list entries
 * trimmed and emptied out. Keys set to their spec default are kept — an
 * explicit override that matches the default still pins it against env.
 */
export function validateSettingValues(provider: ProviderType, input: unknown): ValidationResult {
  const spec = getProviderSettingsSpec(provider)
  if (!spec) return { ok: false, errors: [`Provider "${provider}" has no launch settings`] }
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false, errors: ['Settings must be an object'] }
  }

  const errors: string[] = []
  const values: SettingValues = {}
  for (const [key, raw] of Object.entries(input as Record<string, unknown>)) {
    const setting = spec.settings.find((s) => s.key === key)
    if (!setting) {
      errors.push(`Unknown setting "${key}"`)
      continue
    }
    switch (setting.type) {
      case 'boolean':
        if (typeof raw !== 'boolean') errors.push(`"${key}" must be true or false`)
        else values[key] = raw
        break
      case 'string':
        if (typeof raw !== 'string') errors.push(`"${key}" must be a string`)
        else values[key] = raw.trim()
        break
      case 'enum': {
        if (typeof raw !== 'string') {
          errors.push(`"${key}" must be a string`)
          break
        }
        const allowed = setting.options?.map((o) => o.value) ?? []
        if (!allowed.includes(raw)) errors.push(`"${key}" must be one of: ${allowed.map((a) => a || '(default)').join(', ')}`)
        else values[key] = raw
        break
      }
      case 'list':
        if (!Array.isArray(raw) || raw.some((e) => typeof e !== 'string')) {
          errors.push(`"${key}" must be a list of strings`)
        } else {
          values[key] = (raw as string[]).map((e) => e.trim()).filter((e) => e.length > 0)
        }
        break
    }
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, values }
}

/**
 * Clean a `providerSettings` field from a request body for storage: null or
 * undefined clears it, an empty map (or one whose layers are all empty)
 * becomes undefined, anything else is validated against the specs.
 */
export function cleanProviderOverrides(
  input: unknown,
): { ok: true; overrides: Partial<Record<ProviderType, SettingValues>> | undefined } | { ok: false; error: string } {
  if (input === undefined || input === null) return { ok: true, overrides: undefined }
  const result = validateProviderOverrides(input)
  if (!result.ok) return { ok: false, error: result.errors.join('; ') }
  return { ok: true, overrides: Object.keys(result.overrides).length > 0 ? result.overrides : undefined }
}

/** Validate a `{ provider: values }` map, as stored on projects and personas. */
export function validateProviderOverrides(
  input: unknown,
): { ok: true; overrides: Partial<Record<ProviderType, SettingValues>> } | { ok: false; errors: string[] } {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false, errors: ['providerSettings must be an object keyed by provider'] }
  }
  const errors: string[] = []
  const overrides: Partial<Record<ProviderType, SettingValues>> = {}
  for (const [provider, values] of Object.entries(input as Record<string, unknown>)) {
    const result = validateSettingValues(provider as ProviderType, values)
    if (!result.ok) errors.push(...result.errors.map((e) => `${provider}: ${e}`))
    else if (Object.keys(result.values).length > 0) overrides[provider as ProviderType] = result.values
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, overrides }
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/** Read a setting's env fallback, parsed for its type. Unset/blank → undefined. */
function envValue(setting: ProviderSettingSpec): SettingValue | undefined {
  if (!setting.env) return undefined
  const raw = process.env[setting.env]
  if (raw === undefined || raw.trim().length === 0) return undefined
  const trimmed = raw.trim()
  switch (setting.type) {
    case 'boolean':
      return ['1', 'true', 'yes', 'on'].includes(trimmed.toLowerCase())
    case 'list':
      return trimmed.split(/\s+/)
    case 'enum':
      return setting.options?.some((o) => o.value === trimmed) ? trimmed : undefined
    default:
      return trimmed
  }
}

export interface SettingLayers {
  global?: SettingValues
  project?: SettingValues
  persona?: SettingValues
}

/**
 * Merge the layers over the spec defaults (and env fallbacks), reporting
 * where each value came from. Unknown keys in a layer are ignored — the
 * routes validate on write, and a spec can drop a setting later.
 */
export function resolveSettings(provider: ProviderType, layers: SettingLayers = {}): ResolvedSettings {
  const spec = getProviderSettingsSpec(provider)
  const values: SettingValues = {}
  const sources: Record<string, SettingSource> = {}
  if (!spec) return { values, sources }

  for (const setting of spec.settings) {
    let value = setting.default
    let source: SettingSource = 'default'
    const fromEnv = envValue(setting)
    if (fromEnv !== undefined) {
      value = fromEnv
      source = 'env'
    }
    for (const layer of ['global', 'project', 'persona'] as const) {
      const v = layers[layer]?.[setting.key]
      if (v !== undefined) {
        value = v
        source = layer
      }
    }
    values[setting.key] = value
    sources[setting.key] = source
  }
  return { values, sources }
}

/** CLI args for resolved values, in spec order (extra args come last by construction). */
export function settingsToArgs(provider: ProviderType, values: SettingValues): string[] {
  const spec = getProviderSettingsSpec(provider)
  if (!spec) return []
  // Fill the gaps first, so a setting that depends on another sees its default.
  const full: SettingValues = {}
  for (const setting of spec.settings) full[setting.key] = values[setting.key] ?? setting.default
  const args: string[] = []
  for (const setting of spec.settings) {
    args.push(...setting.args(full[setting.key]!, full))
  }
  return args
}

/** Resolved defaults for an adapter called without explicit settings (tests, legacy callers). */
export function defaultSettings(provider: ProviderType): SettingValues {
  return resolveSettings(provider).values
}
