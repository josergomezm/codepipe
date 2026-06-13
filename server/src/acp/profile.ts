/**
 * ACP dialect profiles.
 *
 * The Agent Client Protocol is a standard, but agents differ in surface
 * details — method names especially. Kiro follows the spec's `session/*`
 * naming; Gemini CLI uses bare `newSession`/`prompt`/`cancel` and exposes a
 * `setSessionMode` for tool auto-approval. A profile captures those
 * provider-specific bits so the driver itself stays generic.
 *
 * No imports from `../adapters` here — keeps the dependency graph acyclic
 * (adapters/types.ts imports this type, driver.ts imports the values).
 */

export interface AcpMethods {
  initialize: string
  newSession: string
  loadSession: string
  prompt: string
  cancel: string
}

/** Thin API handed to a profile's afterSession hook. */
export interface AcpSessionApi {
  request: (method: string, params?: unknown) => Promise<unknown>
  notify: (method: string, params?: unknown) => void
  sessionId: string
}

export interface AcpProfile {
  /** Launch args appended after the binary (e.g. ['acp'] or ['--acp']). */
  args: string[]
  methods: AcpMethods
  /**
   * JSON-RPC method to switch the session's model, if the agent supports it.
   * Kiro uses `session/set_model`; Gemini `unstable_setSessionModel`. Unset =
   * model switching not supported for this provider.
   */
  setModelMethod?: string
  /**
   * Optional hook run once a session exists — e.g. switch the session into an
   * auto-approve tool mode. Failures are swallowed by the driver so a missing
   * capability never breaks the session.
   */
  afterSession?: (api: AcpSessionApi) => Promise<void> | void
}

/** ACP-spec naming, as implemented by Kiro CLI (`kiro-cli acp`). */
export const SPEC_ACP_PROFILE: AcpProfile = {
  args: ['acp'],
  methods: {
    initialize: 'initialize',
    newSession: 'session/new',
    loadSession: 'session/load',
    prompt: 'session/prompt',
    cancel: 'session/cancel',
  },
  setModelMethod: 'session/set_model',
}

/**
 * Gemini CLI (`gemini --acp`). Method names follow Gemini's ACP-mode docs,
 * which differ from the spec. After a session is created it is switched to an
 * auto-approve mode so tool calls don't block (the equivalent of Kiro's
 * `--trust-all-tools`).
 *
 * NOTE: verify the exact method/param names against your installed `gemini`
 * — these reflect the published docs but the binary is the source of truth.
 * Everything here is overridable.
 */
export const GEMINI_ACP_PROFILE: AcpProfile = {
  args: ['--acp'],
  methods: {
    initialize: 'initialize',
    newSession: 'newSession',
    loadSession: 'loadSession',
    prompt: 'prompt',
    cancel: 'cancel',
  },
  setModelMethod: 'unstable_setSessionModel',
  afterSession: async ({ request, sessionId }) => {
    // Best-effort: ask Gemini to auto-approve tool calls for this session.
    await request('setSessionMode', { sessionId, modeId: 'auto-approve', mode: 'auto-approve' })
  },
}
