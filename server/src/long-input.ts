/**
 * One-shot CLIs get the message as a command-line argument, and Windows caps
 * a whole command line at ~32k characters — a long paste or the lead's brief
 * prompt failed with `spawn ENAMETOOLONG`. Input over the limit goes into a
 * file instead, handed to the CLI as an attachment (which every adapter can
 * already read: Kiro inlines `@file`, Claude gets `--add-dir`), with a short
 * note telling the agent to read it. The transcript keeps the original text.
 */
import { mkdir, readdir, stat, unlink, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import path from 'path'
import { randomUUID } from 'crypto'

/**
 * Longest message passed inline — well under the limit, leaving room for
 * flags, paths and Windows argument escaping (each " becomes \").
 */
export const MAX_INLINE_INPUT_CHARS = 12_000
const SPILL_DIR = path.join(tmpdir(), 'codepipe-messages')
/** Spilled files older than this are removed on the next spill. */
const KEEP_MS = 24 * 60 * 60 * 1000

export const SPILLED_NOTE =
  'My message was too long to pass on the command line, so it is in the attached file. Read the whole file first and treat its contents as my message.'

export interface CliInput {
  text: string
  attachments?: { path: string; mimeType: string }[]
}

/** The input as it should reach the CLI: unchanged, or spilled to a file. */
export async function fitForCommandLine(input: CliInput, dir = SPILL_DIR): Promise<CliInput> {
  if (input.text.length <= MAX_INLINE_INPUT_CHARS) return input
  await mkdir(dir, { recursive: true })
  await removeOld(dir)
  const file = path.join(dir, `${randomUUID()}.md`)
  await writeFile(file, input.text, 'utf-8')
  return { text: SPILLED_NOTE, attachments: [...(input.attachments ?? []), { path: file, mimeType: 'text/markdown' }] }
}

async function removeOld(dir: string): Promise<void> {
  const cutoff = Date.now() - KEEP_MS
  for (const name of await readdir(dir).catch(() => [] as string[])) {
    const file = path.join(dir, name)
    try {
      if ((await stat(file)).mtimeMs < cutoff) await unlink(file)
    } catch { /* gone already */ }
  }
}
