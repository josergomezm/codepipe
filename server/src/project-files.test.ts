import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { fileKind, indexMedia, listDir, resolveInProject, PathOutsideProjectError } from './project-files.js'

describe('fileKind', () => {
  it('classifies by extension', () => {
    expect(fileKind('clip.MP4')).toBe('video')
    expect(fileKind('logo.png')).toBe('image')
    expect(fileKind('vo.mp3')).toBe('audio')
    expect(fileKind('deck.pdf')).toBe('pdf')
    expect(fileKind('README.md')).toBe('markdown')
    expect(fileKind('app.ts')).toBe('text')
    expect(fileKind('Makefile')).toBe('text')
    expect(fileKind('archive.zip')).toBe('other')
  })
})

describe('project files', () => {
  let root: string
  let outside: string

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'codepipe-files-'))
    outside = mkdtempSync(join(tmpdir(), 'codepipe-outside-'))
    writeFileSync(join(outside, 'secret.txt'), 'no')
    mkdirSync(join(root, '.review', '2026-11-18'), { recursive: true })
    mkdirSync(join(root, 'node_modules', 'pkg'), { recursive: true })
    mkdirSync(join(root, '.git'))
    mkdirSync(join(root, 'brands'))
    writeFileSync(join(root, '.git', 'config'), '')
    writeFileSync(join(root, 'node_modules', 'pkg', 'demo.mp4'), '')
    writeFileSync(join(root, '.review', '2026-11-18', 'new.mp4'), 'x')
    writeFileSync(join(root, 'brands', 'old.png'), 'x')
    writeFileSync(join(root, 'brands', 'notes.md'), '# hi')
    writeFileSync(join(root, 'README.md'), '# readme')
    const old = new Date('2026-01-01')
    utimesSync(join(root, 'brands', 'old.png'), old, old)
  })

  afterAll(() => {
    rmSync(root, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  })

  it('lists folders first, hides .git and node_modules, keeps other dot folders', async () => {
    const listing = await listDir(root, '')
    expect(listing.path).toBe('')
    expect(listing.entries.map((e) => e.name)).toEqual(['.review', 'brands', 'README.md'])
    expect(listing.entries[2]).toMatchObject({ type: 'file', kind: 'markdown', path: 'README.md' })
  })

  it('lists a subfolder with project-relative paths', async () => {
    const listing = await listDir(root, 'brands')
    expect(listing.entries.map((e) => e.path)).toEqual(['brands/notes.md', 'brands/old.png'])
  })

  it('indexes media newest first, skipping node_modules', async () => {
    const { files, total, truncated } = await indexMedia(root)
    expect(truncated).toBe(false)
    expect(total).toBe(2)
    expect((await indexMedia(root, { kinds: ['video'] })).files.map((f) => f.name)).toEqual(['new.mp4'])
    expect(files.map((f) => f.path)).toEqual(['.review/2026-11-18/new.mp4', 'brands/old.png'])
  })

  it('refuses paths that escape the project or reach into .git', async () => {
    await expect(resolveInProject(root, '../' + outside.split(/[\\/]/).pop() + '/secret.txt')).rejects.toBeInstanceOf(PathOutsideProjectError)
    await expect(resolveInProject(root, outside)).rejects.toBeInstanceOf(PathOutsideProjectError)
    await expect(resolveInProject(root, '.git/config')).rejects.toBeInstanceOf(PathOutsideProjectError)
    await expect(resolveInProject(root, 'brands/../README.md')).resolves.toMatch(/README\.md$/)
  })
})
