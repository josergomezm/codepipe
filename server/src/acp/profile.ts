/**
 * ACP dialect profiles.
 *
 * The Agent Client Protocol is a standard, but agents differ in surface
 * details — method names especially. Kiro follows the spec's `session/*`
 * naming; other agents may use bare `newSession`/`prompt`/`cancel` or need a
 * post-session call (e.g. an auto-approve mode). A profile captures those
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
   * Kiro uses `session/set_model`. Unset =
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
