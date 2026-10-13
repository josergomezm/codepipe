/**
 * The on-disk safety rules every JSON file under data/ follows, in one
 * place: writes land atomically (temp file + rename, with the Windows
 * fallback), and read-modify-write transactions on the same path run one
 * at a time. StorageLayer and the smaller stores (provider settings…) share
 * these so a fix here reaches every file.
 */

import { writeFile, rename, unlink } from 'fs/promises'
import { randomUUID } from 'crypto'

/**
 * Write `data` as pretty JSON, atomically: a sibling `<file>.tmp.<uuid>` is
 * written first and renamed over the target, so a crash mid-write leaves
 * the old file intact (StorageLayer sweeps orphaned `.tmp.` files at
 * startup). On Windows the rename can fail while the target is locked, so
 * it falls back to a truncating direct write.
 */
export async function atomicWriteJson(filePath: string, data: unknown): Promise<void> {
  const json = JSON.stringify(data, null, 2)
  const tempPath = filePath + '.tmp.' + randomUUID()
  try {
    await writeFile(tempPath, json, 'utf-8')
    await rename(tempPath, filePath)
  } catch {
    try {
      await unlink(tempPath)
    } catch {
      // Temp file may not exist
    }
    await writeFile(filePath, json, { encoding: 'utf-8', flag: 'w' })
  }
}

/**
 * Per-path exclusivity: `runExclusive` runs `fn` once every earlier call for
 * the same path has settled, in arrival order, so load → mutate → write is
 * safe under concurrency — the lock covers the whole transaction. A failed
 * operation doesn't poison the chain. NOT reentrant: never nest calls on the
 * same path.
 */
export class FileLocks {
  private readonly chains = new Map<string, Promise<void>>()

  runExclusive<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(filePath) ?? Promise.resolve()
    const next = prev.then(fn, fn)
    this.chains.set(
      filePath,
      next.then(
        () => undefined,
        () => undefined,
      ),
    )
    return next
  }

  /** Resolves once every operation queued so far has settled (never rejects). */
  async whenIdle(): Promise<void> {
    await Promise.all([...this.chains.values()])
  }
}
