import { promises as fs } from 'fs'
import path from 'path'

/**
 * Read-only access to the files inside a project folder, for the Files tab:
 * folder listings, a "recent media" index, and resolving a file to stream.
 *
 * Every path here is relative to the project root and is refused if it
 * resolves (symlinks included) to anywhere outside it.
 */

export type FileKind = 'video' | 'image' | 'audio' | 'pdf' | 'markdown' | 'text' | 'other'

export interface FileEntry {
  name: string
  /** Project-relative, forward slashes. */
  path: string
  type: 'dir' | 'file'
  kind?: FileKind
  size?: number
  /** ms since epoch */
  mtime: number
}

export interface DirListing {
  path: string
  entries: FileEntry[]
}

export interface MediaIndex {
  /** The newest `limit` matches. */
  files: FileEntry[]
  /** How many matched in all (before `limit`). */
  total: number
  /** True when the walk stopped early (very large project). */
  truncated: boolean
}

const EXT_KIND: Record<string, FileKind> = {
  mp4: 'video', webm: 'video', mov: 'video', m4v: 'video', ogv: 'video', mkv: 'video',
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', svg: 'image', avif: 'image', bmp: 'image', ico: 'image',
  mp3: 'audio', wav: 'audio', ogg: 'audio', m4a: 'audio', aac: 'audio', flac: 'audio', opus: 'audio',
  pdf: 'pdf',
  md: 'markdown', markdown: 'markdown', mdx: 'markdown',
}

const TEXT_EXTS = new Set([
  'txt', 'json', 'jsonc', 'json5', 'yaml', 'yml', 'toml', 'ini', 'env', 'csv', 'tsv', 'log', 'xml', 'html', 'htm', 'css', 'scss',
  'js', 'mjs', 'cjs', 'jsx', 'ts', 'mts', 'cts', 'tsx', 'vue', 'svelte', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'swift', 'c', 'h',
  'cpp', 'hpp', 'cs', 'php', 'sh', 'bash', 'zsh', 'ps1', 'bat', 'cmd', 'sql', 'graphql', 'gql', 'rules', 'srt', 'vtt',
  'gitignore', 'dockerfile', 'lock',
])

export function fileKind(name: string): FileKind {
  const lower = name.toLowerCase()
  const dot = lower.lastIndexOf('.')
  const ext = dot >= 0 ? lower.slice(dot + 1) : lower
  if (EXT_KIND[ext]) return EXT_KIND[ext]
  if (TEXT_EXTS.has(ext) || dot <= 0) return 'text'
  return 'other'
}

/** Never listed or walked: noise, and potentially huge. */
const HIDDEN_DIRS = new Set(['.git', 'node_modules'])
/** Skipped by the media walk only (still browsable): build output and caches. */
const WALK_SKIP_DIRS = new Set([...HIDDEN_DIRS, 'dist', 'build', '.next', '.nuxt', '.cache', '.turbo', 'coverage', '.firebase', '__pycache__', '.venv', 'venv', 'test-results', 'playwright-report'])

export class PathOutsideProjectError extends Error {
  constructor() { super('Path is outside the project') }
}

function toRel(root: string, abs: string): string {
  return path.relative(root, abs).split(path.sep).join('/')
}

function isInside(root: string, abs: string): boolean {
  const rel = path.relative(root, abs)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

/**
 * Resolve a project-relative path to an absolute one, following symlinks, and
 * throw PathOutsideProjectError if it lands outside the project. ENOENT
 * propagates as-is.
 */
export async function resolveInProject(projectRoot: string, relPath: string): Promise<string> {
  const root = await fs.realpath(projectRoot)
  const cleaned = (relPath ?? '').replace(/\\/g, '/').replace(/^\/+/, '')
  const joined = path.resolve(root, cleaned)
  if (!isInside(root, joined)) throw new PathOutsideProjectError()
  const real = await fs.realpath(joined)
  if (!isInside(root, real)) throw new PathOutsideProjectError()
  // Hidden dirs are hidden everywhere, not only in listings.
  if (toRel(root, real).split('/').some((seg) => seg === '.git')) throw new PathOutsideProjectError()
  return real
}

export async function listDir(projectRoot: string, relPath: string): Promise<DirListing> {
  const root = await fs.realpath(projectRoot)
  const dir = await resolveInProject(root, relPath)
  const dirents = await fs.readdir(dir, { withFileTypes: true })
  const entries: FileEntry[] = []
  await Promise.all(dirents.map(async (d) => {
    if (HIDDEN_DIRS.has(d.name)) return
    const abs = path.join(dir, d.name)
    try {
      const st = await fs.stat(abs)
      const rel = toRel(root, abs)
      if (st.isDirectory()) entries.push({ name: d.name, path: rel, type: 'dir', mtime: st.mtimeMs })
      else if (st.isFile()) entries.push({ name: d.name, path: rel, type: 'file', kind: fileKind(d.name), size: st.size, mtime: st.mtimeMs })
    } catch { /* broken symlink, permission denied */ }
  }))
  entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name, undefined, { numeric: true }) : a.type === 'dir' ? -1 : 1))
  return { path: toRel(root, dir), entries }
}

export const MEDIA_KINDS: readonly FileKind[] = ['video', 'image', 'audio', 'pdf']

/**
 * Media files in the project (video, image, audio, pdf — or just `kinds`),
 * newest first. Bounded so a huge tree can't stall the server.
 */
export async function indexMedia(
  projectRoot: string,
  opts: { kinds?: readonly FileKind[]; limit?: number; maxFiles?: number; maxDirs?: number; maxDepth?: number } = {},
): Promise<MediaIndex> {
  const { limit = 400, maxFiles = 20000, maxDirs = 50000, maxDepth = 32 } = opts
  const wanted = new Set<FileKind>(opts.kinds?.length ? opts.kinds : MEDIA_KINDS)
  const root = await fs.realpath(projectRoot)
  const files: FileEntry[] = []
  let dirsVisited = 0
  let truncated = false

  async function visit(abs: string, depth: number, next: { abs: string; depth: number }[]): Promise<void> {
    let dirents
    try { dirents = await fs.readdir(abs, { withFileTypes: true }) } catch { return }
    const stats: Promise<void>[] = []
    for (const d of dirents) {
      const child = path.join(abs, d.name)
      if (d.isDirectory()) {
        if (WALK_SKIP_DIRS.has(d.name)) continue
        if (depth + 1 <= maxDepth) next.push({ abs: child, depth: depth + 1 })
        else truncated = true
      } else if (d.isFile()) {
        const kind = fileKind(d.name)
        if (!wanted.has(kind)) continue
        if (files.length + stats.length >= maxFiles) { truncated = true; continue }
        stats.push(fs.stat(child).then((st) => {
          files.push({ name: d.name, path: toRel(root, child), type: 'file', kind, size: st.size, mtime: st.mtimeMs })
        }, () => {}))
      }
    }
    await Promise.all(stats)
  }

  // Breadth-first, a batch of folders at a time: shallow folders (where
  // people keep renders) are always covered before a cap can cut in.
  const BATCH = 64
  let queue: { abs: string; depth: number }[] = [{ abs: root, depth: 0 }]
  while (queue.length && !truncated) {
    const next: { abs: string; depth: number }[] = []
    for (let i = 0; i < queue.length; i += BATCH) {
      const batch = queue.slice(i, i + BATCH)
      if (dirsVisited + batch.length > maxDirs || files.length >= maxFiles) { truncated = true; break }
      dirsVisited += batch.length
      await Promise.all(batch.map((q) => visit(q.abs, q.depth, next)))
    }
    queue = next
  }

  files.sort((a, b) => b.mtime - a.mtime)
  return { files: files.slice(0, limit), total: files.length, truncated }
}
