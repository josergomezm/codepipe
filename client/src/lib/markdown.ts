import MarkdownIt from 'markdown-it'

/**
 * The one markdown renderer for chat messages and the file viewer.
 *
 * On top of markdown-it it:
 *  - wraps tables in a horizontally scrollable frame (wide tables no longer
 *    get clipped by the bubble),
 *  - gives fenced code a header with the language and a copy button,
 *  - marks inline `code` that looks like a file path, and relative links, as
 *    openable files (`data-file-path`) — MarkdownContent turns clicks on them
 *    into an `open-file` event.
 *
 * html stays off: message content is agent output, never trusted markup.
 */
const md = new MarkdownIt({ html: false, linkify: true, breaks: true })

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/**
 * `src/app.ts`, `./docs/plan.md:42`, `.review/2026-11-18/clip.mp4` → the
 * project-relative path (line suffix dropped). Anything with spaces, a URL
 * scheme, or no extension-ish last segment is left alone.
 */
export function filePathFromCode(text: string): string | null {
  const t = text.trim()
  if (t.length < 3 || t.length > 260 || /\s/.test(t)) return null
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) return null
  const withoutLine = t.replace(/:\d+(?::\d+)?(?:-\d+)?$/, '')
  // Needs a file-ish last segment: name.ext (ext 1-8 alnum chars).
  if (!/(^|[\\/])[^\\/]*[^\\/.]\.[a-z0-9]{1,8}$/i.test(withoutLine)) return null
  // Bare "foo.bar" with no slash: only if it looks like a filename, not a.b.c code.
  if (!/[\\/]/.test(withoutLine) && !/^[\w.-]+\.(md|mdx|json|ya?ml|toml|txt|ts|tsx|js|mjs|vue|py|go|rs|html|css|png|jpe?g|gif|webp|svg|mp4|webm|mov|mp3|wav|pdf|csv|env|lock|sh|ps1|bat)$/i.test(withoutLine)) return null
  // Absolute paths can't be mapped onto the project reliably.
  if (/^([a-z]:)?[\\/]/i.test(withoutLine) || withoutLine.startsWith('~')) return null
  return withoutLine.replace(/\\/g, '/').replace(/^\.\//, '')
}

// Tables: scrollable frame.
md.renderer.rules.table_open = () => '<div class="md-table"><table>\n'
md.renderer.rules.table_close = () => '</table></div>\n'

// Fenced code: header with language + copy button. The code text is read
// from the sibling <code> on click, so nothing is duplicated into attributes.
const defaultFence = md.renderer.rules.fence!
md.renderer.rules.fence = (tokens, idx, options, env, self) => {
  const token = tokens[idx]
  const lang = token.info.trim().split(/\s+/)[0] ?? ''
  const body = defaultFence(tokens, idx, options, env, self)
  return `<div class="md-code"><div class="md-code-head"><span>${escapeAttr(lang || 'text')}</span>`
    + `<button type="button" class="md-copy" data-copy>Copy</button></div>${body}</div>\n`
}

// Inline code that names a file → clickable.
md.renderer.rules.code_inline = (tokens, idx) => {
  const content = tokens[idx].content
  const escaped = md.utils.escapeHtml(content)
  const file = filePathFromCode(content)
  return file
    ? `<code class="md-file" data-file-path="${escapeAttr(file)}" title="Open ${escapeAttr(file)}">${escaped}</code>`
    : `<code>${escaped}</code>`
}

// Links: external ones open a new window; relative ones are project files.
const defaultLinkOpen = md.renderer.rules.link_open
  ?? ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options))
md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  const token = tokens[idx]
  const href = token.attrGet('href') ?? ''
  const isRelativeFile = href && !/^[a-z][a-z0-9+.-]*:/i.test(href) && !href.startsWith('#') && !href.startsWith('/') && !href.startsWith('//')
  if (isRelativeFile) {
    const file = decodeURI(href.split('#')[0].split('?')[0]).replace(/^\.\//, '')
    const base = (env as { basePath?: string } | undefined)?.basePath
    token.attrSet('data-file-path', base ? joinPath(base, file) : file)
    token.attrSet('class', 'md-file')
  } else {
    token.attrSet('target', '_blank')
    token.attrSet('rel', 'noopener')
  }
  return defaultLinkOpen(tokens, idx, options, env, self)
}

// Relative images inside a rendered project markdown file → served from the project.
const defaultImage = md.renderer.rules.image!
md.renderer.rules.image = (tokens, idx, options, env, self) => {
  const token = tokens[idx]
  const src = token.attrGet('src') ?? ''
  const e = env as { basePath?: string; rawUrl?: (p: string) => string } | undefined
  if (e?.rawUrl && src && !/^[a-z][a-z0-9+.-]*:/i.test(src) && !src.startsWith('/')) {
    token.attrSet('src', e.rawUrl(joinPath(e.basePath ?? '', decodeURI(src))))
  }
  token.attrSet('loading', 'lazy')
  return defaultImage(tokens, idx, options, env, self)
}

/** Join a project-relative dir and a relative path, resolving `.`/`..`. */
export function joinPath(dir: string, rel: string): string {
  const out: string[] = []
  for (const seg of `${dir}/${rel}`.split('/')) {
    if (!seg || seg === '.') continue
    if (seg === '..') out.pop()
    else out.push(seg)
  }
  return out.join('/')
}

export interface RenderEnv {
  /** Directory of the markdown file, for resolving its relative links/images. */
  basePath?: string
  rawUrl?: (path: string) => string
}

export function renderMarkdown(source: string, env: RenderEnv = {}): string {
  return md.render(source, env)
}
