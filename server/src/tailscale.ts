import { execSync, spawn } from 'child_process'
import { log } from './logger.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TailscaleServeStatus {
  hostname: string | null
  mappings: TailscaleMapping[]
}

export interface TailscaleMapping {
  tailscalePort: number
  localPort: number
  path: string
}

interface TailscaleServeJson {
  TCP?: Record<string, { HTTPS?: boolean }>
  Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }>
}

// ---------------------------------------------------------------------------
// Tailscale integration
// ---------------------------------------------------------------------------

let cachedHostname: string | null = null

/**
 * Get the Tailscale hostname for this machine.
 * Caches the result since the hostname doesn't change at runtime.
 */
export function getTailscaleHostname(): string | null {
  if (cachedHostname) return cachedHostname

  try {
    // `tailscale cert` prints the FQDN in its usage error
    const output = execSync('tailscale cert 2>&1', {
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    // Parse: For domain, use "ks-mini.tail0293ef.ts.net".
    const match = /use "([^"]+)"/.exec(output)
    if (match) {
      cachedHostname = match[1]
      return cachedHostname
    }
  } catch (err) {
    // Try parsing stderr output from the error
    const errOutput = (err as { stdout?: string; stderr?: string })?.stdout ?? ''
    const match = /use "([^"]+)"/.exec(errOutput)
    if (match) {
      cachedHostname = match[1]
      return cachedHostname
    }
  }

  // Fallback: try getting it from serve status
  try {
    const status = getServeStatus()
    if (status.hostname) {
      cachedHostname = status.hostname
      return cachedHostname
    }
  } catch {
    // Tailscale not available
  }

  return null
}

/**
 * Get the current Tailscale Serve status (all port mappings).
 * Results are cached for 5 seconds to avoid excessive shell calls.
 */
let cachedServeStatus: TailscaleServeStatus | null = null
let cacheTimestamp = 0
const CACHE_TTL_MS = 5000

export function getServeStatus(): TailscaleServeStatus {
  const now = Date.now()
  if (cachedServeStatus && (now - cacheTimestamp) < CACHE_TTL_MS) {
    return cachedServeStatus
  }

  const result: TailscaleServeStatus = { hostname: null, mappings: [] }

  try {
    const output = execSync('tailscale serve status --json', {
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    })

    const status = JSON.parse(output) as TailscaleServeJson

    if (!status.Web) {
      cachedServeStatus = result
      cacheTimestamp = now
      return result
    }

    for (const [hostPort, config] of Object.entries(status.Web)) {
      // Extract hostname from key like "ks-mini.tail0293ef.ts.net:443"
      const hostMatch = /^(.+):(\d+)$/.exec(hostPort)
      if (hostMatch) {
        result.hostname = hostMatch[1]
        const tsPort = parseInt(hostMatch[2])

        const handlers = config.Handlers ?? {}
        for (const [pathPattern, handler] of Object.entries(handlers)) {
          if (handler.Proxy) {
            // Extract local port from proxy URL like "http://localhost:5552"
            const proxyMatch = /:(\d+)/.exec(handler.Proxy)
            if (proxyMatch) {
              result.mappings.push({
                tailscalePort: tsPort,
                localPort: parseInt(proxyMatch[1]),
                path: pathPattern,
              })
            }
          }
        }
      }
    }
  } catch {
    // Tailscale not installed or serve not running
  }

  cachedServeStatus = result
  cacheTimestamp = now
  return result
}

/**
 * Check if a Tailscale Serve mapping exists for a given local port on the expected Tailscale port.
 */
export function hasServeMapping(localPort: number, tailscalePort?: number): TailscaleMapping | null {
  const status = getServeStatus()
  if (tailscalePort !== undefined) {
    return status.mappings.find((m) => m.localPort === localPort && m.tailscalePort === tailscalePort) ?? null
  }
  return status.mappings.find((m) => m.localPort === localPort) ?? null
}

/**
 * Create a Tailscale Serve mapping.
 * Maps https://hostname:tailscalePort → http://localhost:localPort
 */
export async function createServeMapping(
  tailscalePort: number,
  localPort: number,
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const args = ['serve', '--bg', '--https', String(tailscalePort), `http://127.0.0.1:${localPort}`]

    log.info('tailscale', `Creating serve mapping: tailscale ${args.join(' ')}`)

    const child = spawn('tailscale', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''

    child.stdout?.on('data', (data: Buffer) => { stdout += data.toString() })
    child.stderr?.on('data', (data: Buffer) => { stderr += data.toString() })

    child.on('close', (exitCode) => {
      if (exitCode === 0) {
        log.info('tailscale', `Serve mapping created: :${tailscalePort} → :${localPort}`)
        // Invalidate cache so next getServeStatus() picks up the new mapping
        cachedServeStatus = null
        resolve(true)
      } else {
        log.error('tailscale', `Failed to create serve mapping (exit ${exitCode}): ${stderr || stdout}`)
        resolve(false)
      }
    })

    child.on('error', (err) => {
      log.error('tailscale', `Failed to run tailscale serve`, err)
      resolve(false)
    })
  })
}

/**
 * Remove a Tailscale Serve mapping for a given HTTPS port.
 */
export async function removeServeMapping(tailscalePort: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const args = ['serve', '--https', String(tailscalePort), 'off']

    log.info('tailscale', `Removing serve mapping: tailscale ${args.join(' ')}`)

    const child = spawn('tailscale', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stderr = ''
    child.stdout?.on('data', () => {})
    child.stderr?.on('data', (data: Buffer) => { stderr += data.toString() })

    child.on('close', (exitCode) => {
      if (exitCode === 0) {
        log.info('tailscale', `Serve mapping removed for port :${tailscalePort}`)
        cachedServeStatus = null
        resolve(true)
      } else {
        log.error('tailscale', `Failed to remove serve mapping (exit ${exitCode}): ${stderr}`)
        resolve(false)
      }
    })

    child.on('error', (err) => {
      log.error('tailscale', `Failed to run tailscale serve off`, err)
      resolve(false)
    })
  })
}

/**
 * Invalidate the serve status cache so the next call fetches fresh data.
 */
export function invalidateServeCache(): void {
  cachedServeStatus = null
}

/**
 * Build the full Tailscale URL for a given port.
 */
export function buildTailscaleUrl(tailscalePort: number): string | null {
  const hostname = getTailscaleHostname()
  if (!hostname) return null

  if (tailscalePort === 443) {
    return `https://${hostname}`
  }
  return `https://${hostname}:${tailscalePort}`
}
