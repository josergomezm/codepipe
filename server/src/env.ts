/**
 * Load server/.env (VAPID keys, LOG_LEVEL, HEALTH_* …) before anything reads
 * process.env. ES modules evaluate their imports first, so this must be the
 * very first import in index.ts: modules like logger.ts read their settings
 * when they load. Uses Node's built-in loader; a missing file is fine.
 */
try {
  process.loadEnvFile('./.env')
} catch {
  /* no .env file — fine */
}
