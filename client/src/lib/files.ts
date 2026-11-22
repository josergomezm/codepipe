import type { FileEntry, FileKind } from '@/api/client'

/** Mirrors server/src/project-files.ts fileKind, for paths we only know by name. */
const EXT_KIND: Record<string, FileKind> = {
  mp4: 'video', webm: 'video', mov: 'video', m4v: 'video', ogv: 'video', mkv: 'video',
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', svg: 'image', avif: 'image', bmp: 'image', ico: 'image',
  mp3: 'audio', wav: 'audio', ogg: 'audio', m4a: 'audio', aac: 'audio', flac: 'audio', opus: 'audio',
  pdf: 'pdf',
  md: 'markdown', markdown: 'markdown', mdx: 'markdown',
}
const BINARY_EXTS = new Set(['zip', 'gz', 'tgz', '7z', 'rar', 'exe', 'dll', 'so', 'bin', 'woff', 'woff2', 'ttf', 'otf', 'psd', 'ai', 'sketch', 'fig', 'docx', 'xlsx', 'pptx', 'db', 'sqlite'])

export function kindOf(name: string): FileKind {
  const lower = name.toLowerCase()
  const dot = lower.lastIndexOf('.')
  const ext = dot >= 0 ? lower.slice(dot + 1) : ''
  if (EXT_KIND[ext]) return EXT_KIND[ext]
  return BINARY_EXTS.has(ext) ? 'other' : 'text'
}

export function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

export function dirName(path: string): string {
  const i = path.lastIndexOf('/')
  return i === -1 ? '' : path.slice(0, i)
}

/** A FileEntry for a path we only know by name (e.g. clicked in chat). */
export function entryForPath(path: string): FileEntry {
  const name = baseName(path)
  return { name, path, type: 'file', kind: kindOf(name), mtime: 0 }
}

export function formatSize(bytes?: number): string {
  if (bytes == null) return ''
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB']
  let n = bytes / 1024
  let u = 0
  while (n >= 1024 && u < units.length - 1) { n /= 1024; u++ }
  return `${n < 10 ? n.toFixed(1) : Math.round(n)} ${units[u]}`
}

export function formatWhen(ms: number): string {
  if (!ms) return ''
  const d = new Date(ms)
  const now = new Date()
  const sameDay = d.toDateString() === now.toDateString()
  if (sameDay) return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  const sameYear = d.getFullYear() === now.getFullYear()
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) })
}

/** "Today" / "Yesterday" / "Mon, Nov 18" — for grouping media by day. */
export function dayLabel(ms: number): string {
  const d = new Date(ms)
  const today = new Date()
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const diffDays = Math.round((startOf(today) - startOf(d)) / 86_400_000)
  if (diffDays === 0) return 'Today'
  if (diffDays === 1) return 'Yesterday'
  return d.toLocaleDateString(undefined, {
    weekday: 'short', month: 'short', day: 'numeric',
    ...(d.getFullYear() === today.getFullYear() ? {} : { year: 'numeric' }),
  })
}

/** Text previews stop here; bigger files offer a download instead. */
export const MAX_TEXT_PREVIEW = 1024 * 1024
