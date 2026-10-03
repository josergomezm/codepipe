/**
 * Process environment, settled before anything else runs.
 *
 * 1. Load server/.env (VAPID keys, LOG_LEVEL, HEALTH_* …) before anything
 *    reads process.env. ES modules evaluate their imports first, so this must
 *    be the very first import in index.ts: modules like logger.ts read their
 *    settings when they load. A missing file is fine.
 * 2. Take the supervisor's variables out of process.env. They're meant for
 *    this process only, but everything the server starts (CLIs, agents' tool
 *    shells, dev servers) inherits process.env — and TSX_TSCONFIG_PATH would
 *    make any `tsx` run in the user's projects compile with CodePipe's
 *    tsconfig. tsx's loader has already read it by the time this runs.
 */
try {
  process.loadEnvFile('./.env')
} catch {
  /* no .env file — fine */
}

/** True when running under scripts/supervise.mjs (`npm run serve`). */
export const SUPERVISED = process.env['CODEPIPE_SUPERVISED'] === '1'

for (const name of ['CODEPIPE_SUPERVISED', 'TSX_TSCONFIG_PATH']) {
  delete process.env[name]
}
