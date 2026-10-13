import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, readdir, readFile } from 'fs/promises'
import path from 'path'
import os from 'os'

import { atomicWriteJson, FileLocks } from './json-file.js'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'codepipe-json-file-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('atomicWriteJson', () => {
  it('writes pretty JSON and leaves no temp file behind', async () => {
    const file = path.join(dir, 'x.json')
    await atomicWriteJson(file, { a: 1, b: ['c'] })
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ a: 1, b: ['c'] })
    expect((await readFile(file, 'utf8')).includes('\n  "a": 1')).toBe(true)
    expect(await readdir(dir)).toEqual(['x.json'])
  })

  it('replaces a longer previous file completely', async () => {
    const file = path.join(dir, 'x.json')
    await atomicWriteJson(file, { padding: 'x'.repeat(500) })
    await atomicWriteJson(file, { short: true })
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ short: true })
  })
})

describe('FileLocks', () => {
  it('serializes operations on the same path, in arrival order', async () => {
    const locks = new FileLocks()
    const order: string[] = []
    const slow = locks.runExclusive('a', async () => {
      await new Promise((r) => setTimeout(r, 30))
      order.push('slow')
      return 1
    })
    const fast = locks.runExclusive('a', async () => {
      order.push('fast')
      return 2
    })
    expect(await Promise.all([slow, fast])).toEqual([1, 2])
    expect(order).toEqual(['slow', 'fast'])
  })

  it('runs different paths concurrently and survives a failure', async () => {
    const locks = new FileLocks()
    const order: string[] = []
    const a = locks.runExclusive('a', async () => {
      await new Promise((r) => setTimeout(r, 30))
      order.push('a')
    })
    const b = locks.runExclusive('b', async () => {
      order.push('b')
    })
    await Promise.all([a, b])
    expect(order).toEqual(['b', 'a'])

    await expect(locks.runExclusive('a', async () => { throw new Error('boom') })).rejects.toThrow('boom')
    expect(await locks.runExclusive('a', async () => 'after')).toBe('after')
  })
})
