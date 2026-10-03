/**
 * Options every child process the server starts must include.
 *
 * On Windows a console Ctrl+C goes to every process attached to the same
 * console. A child spawned normally shares the server's console, so when it
 * (or anything it runs — Kiro's tool shells, git, npm…) sends Ctrl+C to
 * interrupt its own work, the server receives SIGINT too and shuts down.
 * That was the "weekly crash": every signal shutdown in the logs happened
 * during a Kiro turn.
 *
 * `windowsHide: true` makes Node start console programs in their own hidden
 * console (CREATE_NO_WINDOW), so their Ctrl+C events stay inside it. It's a
 * no-op on macOS/Linux. child-options.test.ts reproduces the failure in a
 * real console to keep this honest.
 */
export const ISOLATED_CHILD = { windowsHide: true } as const
