import { Router } from 'express'
import { readdir, readFile, stat } from 'fs/promises'
import path from 'path'

import { CRASH_DIR, DATA_DIR, log, recentLogLines } from '../logger.js'
import { recentHealthSamples, sampleHealth } from '../health.js'
import { SUPERVISED } from '../env.js'

/** Written by scripts/supervise.mjs — one JSON object per line. */
export const RESTARTS_FILE = path.join(DATA_DIR, 'restarts.jsonl')

export interface CrashSummary {
  file: string
  time: string
  kind: string
  message: string
  sizeBytes: number
}

/** First line of a crash report is a JSON header; pull the headline from it. */
async function summarizeCrash(file: string): Promise<CrashSummary> {
  const full = path.join(CRASH_DIR, file)
  const [text, info] = await Promise.all([readFile(full, 'utf8'), stat(full)])
  let time = info.mtime.toISOString()
  let kind = 'unknown'
  let message = ''
  try {
    const header = JSON.parse(text.slice(0, text.indexOf('\n'))) as {
      time?: string; kind?: string; error?: { name?: string; message?: string; value?: string }
    }
    time = header.time ?? time
    kind = header.kind ?? kind
    message = header.error?.message ?? header.error?.value ?? ''
    if (header.error?.name && header.error.message) message = `${header.error.name}: ${header.error.message}`
  } catch {
    /* not a JSON header — keep defaults */
  }
  return { file, time, kind, message, sizeBytes: info.size }
}

async function listCrashFiles(): Promise<string[]> {
  try {
    return (await readdir(CRASH_DIR)).filter((f) => f.endsWith('.log')).sort().reverse()
  } catch {
    return [] // no crashes yet
  }
}

async function readRestarts(limit = 50): Promise<unknown[]> {
  try {
    const lines = (await readFile(RESTARTS_FILE, 'utf8')).trim().split('\n').filter(Boolean)
    return lines.slice(-limit).reverse().flatMap((l) => {
      try { return [JSON.parse(l)] } catch { return [] }
    })
  } catch {
    return []
  }
}

/** GET /api/diagnostics — server health, crash reports and supervisor restarts. */
export function createDiagnosticsRoutes(getCounts: () => Record<string, number>): Router {
  const router = Router()

  router.get('/', async (_req, res) => {
    try {
      const crashFiles = await listCrashFiles()
      const crashes = await Promise.all(crashFiles.slice(0, 50).map(summarizeCrash))
      res.json({
        process: {
          pid: process.pid,
          node: process.version,
          platform: `${process.platform} ${process.arch}`,
          startedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
          supervised: SUPERVISED,
        },
        current: sampleHealth(getCounts(), false),
        samples: recentHealthSamples(),
        crashes,
        restarts: await readRestarts(),
        recentProblems: recentLogLines().filter((l) => /\[(WARN |ERROR|FATAL)\]/.test(l)).slice(-100).reverse(),
      })
    } catch (err) {
      log.error('api', 'Failed to build diagnostics', err)
      res.status(500).json({ error: 'Failed to build diagnostics' })
    }
  })

  // GET /api/diagnostics/crashes/:file — full crash report text
  router.get('/crashes/:file', async (req, res) => {
    const { file } = req.params
    // Only names from the listing are served — no paths, no traversal.
    if (!(await listCrashFiles()).includes(file)) {
      res.status(404).json({ error: 'Crash report not found' })
      return
    }
    try {
      res.type('text/plain').send(await readFile(path.join(CRASH_DIR, file), 'utf8'))
    } catch (err) {
      log.error('api', `Failed to read crash report ${file}`, err)
      res.status(500).json({ error: 'Failed to read crash report' })
    }
  })

  return router
}
