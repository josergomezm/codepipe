/**
 * Periodic health sampling.
 *
 * Every HEALTH_INTERVAL_MS a sample is logged (tag `health`): memory, the
 * event loop's worst delay, and counts of live chats, CLI processes, ACP
 * agents and terminal shells. A crash that happens about once a week is
 * usually a slow leak or a stuck process, and this makes the trend visible
 * in the log and on the Diagnostics page long before the crash.
 *
 * Samples are also kept in memory (last 24 h) for /api/diagnostics.
 */

import { monitorEventLoopDelay } from 'perf_hooks'
import { log } from './logger.js'

const HEALTH_INTERVAL_MS = Number(process.env['HEALTH_INTERVAL_MS'] ?? 10 * 60 * 1000)
const MAX_SAMPLES = Math.ceil((24 * 60 * 60 * 1000) / HEALTH_INTERVAL_MS)

/** Warn when resident memory passes this (MB). */
const RSS_WARN_MB = Number(process.env['HEALTH_RSS_WARN_MB'] ?? 1500)
/** Warn when the event loop was blocked longer than this (ms) in a window. */
const LOOP_DELAY_WARN_MS = 2000

export interface HealthSample {
  time: string
  uptimeSeconds: number
  rssMb: number
  heapUsedMb: number
  /** Worst event-loop delay since the previous sample. */
  maxLoopDelayMs: number
  [count: string]: number | string
}

const samples: HealthSample[] = []
const loopDelay = monitorEventLoopDelay({ resolution: 50 })

const mb = (bytes: number) => Math.round(bytes / (1024 * 1024))

/**
 * Take a sample now. `counts` comes from the managers (sessions, processes…).
 * Periodic samples reset the loop-delay window; on-demand ones (the
 * Diagnostics page) pass `resetWindow: false` so they don't disturb it.
 */
export function sampleHealth(counts: Record<string, number>, resetWindow = true): HealthSample {
  const mem = process.memoryUsage()
  const sample: HealthSample = {
    time: new Date().toISOString(),
    uptimeSeconds: Math.round(process.uptime()),
    rssMb: mb(mem.rss),
    heapUsedMb: mb(mem.heapUsed),
    maxLoopDelayMs: Math.round(loopDelay.max / 1e6),
    ...counts,
  }
  if (resetWindow) loopDelay.reset()
  return sample
}

/** Start sampling. Returns a stop function. */
export function startHealthMonitor(getCounts: () => Record<string, number>): () => void {
  loopDelay.enable()
  const timer = setInterval(() => {
    let sample: HealthSample
    try {
      sample = sampleHealth(getCounts())
    } catch (err) {
      log.error('health', 'Failed to sample health', err)
      return
    }
    samples.push(sample)
    if (samples.length > MAX_SAMPLES) samples.shift()

    log.info('health', 'sample', sample)
    if (sample.rssMb > RSS_WARN_MB) log.warn('health', `High memory use: ${sample.rssMb} MB resident`)
    if (sample.maxLoopDelayMs > LOOP_DELAY_WARN_MS) {
      log.warn('health', `Event loop was blocked for ${sample.maxLoopDelayMs} ms — something ran synchronously for too long`)
    }
  }, HEALTH_INTERVAL_MS)
  timer.unref()
  return () => {
    clearInterval(timer)
    loopDelay.disable()
  }
}

export function recentHealthSamples(): HealthSample[] {
  return [...samples]
}
