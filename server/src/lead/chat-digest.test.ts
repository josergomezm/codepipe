import { describe, it, expect } from 'vitest'
import { clip, clipEnd, digestChat, endingHint, extractTurns, openQuestion } from './chat-digest.js'
import type { ChatMessage, Session } from '../schemas.js'

let seq = 0
const msg = (role: ChatMessage['role'], content: string, at: number, metadata?: ChatMessage['metadata']): ChatMessage => ({
  id: `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`,
  role, content, timestamp: at, status: 'complete', ...(metadata ? { metadata } : {}),
})

// Endings shaped like real chats (2026-11).
const ASKS = 'It needs `npm run deploy` in `mtmcya-dashboard`, which pushes the private config to Firestore.\n\nI haven\'t run it because it writes to the live project. Do you want me to run it?'
const UNCOMMITTED = 'I also added a pointer to it near the top of `CLAUDE.md` so future sessions read it before touching the data files. Both changes are uncommitted in that repo.'
const SHIPPED = 'Both pieces are built, committed on main and deployed; the dashboard is live with the partner slider.'
const INFO = 'Don\'t leave the US during the grace period unless counsel has planned it, because leaving ends the grace period.'

describe('openQuestion / endingHint', () => {
  it('reads a question the reply ends on as waiting on you', () => {
    expect(openQuestion(ASKS)).toBe('Do you want me to run it?')
    expect(endingHint(ASKS)).toEqual({ state: 'waiting_on_you', question: 'Do you want me to run it?' })
  })

  it('reads uncommitted / not pushed work as pending', () => {
    expect(endingHint(UNCOMMITTED)).toEqual({ state: 'pending_action' })
    // Typographic apostrophes, as agents often write them.
    expect(endingHint('Built it, but I haven’t pushed it.')).toEqual({ state: 'pending_action' })
    expect(endingHint('Before launch you’ll need to rotate the key.')).toEqual({ state: 'pending_action' })
    expect(endingHint('Done locally. Nothing has been pushed yet.')).toEqual({ state: 'pending_action' })
  })

  it('reads a shipped ending as done, and plain advice as nothing', () => {
    expect(endingHint(SHIPPED)).toEqual({ state: 'done' })
    expect(endingHint(INFO)).toBeNull()
    expect(endingHint('')).toBeNull()
  })

  it('ignores a question earlier in the reply, and "?" inside code', () => {
    expect(openQuestion('Should we split it? I did, and it works now.')).toBeNull()
    expect(endingHint('Run this:\n\n```\nfoo?bar\n```')).toBeNull()
  })

  it('judges by the end of the reply only', () => {
    const resolved = 'This was blocked on the API key. ' + 'x '.repeat(800) + 'It is deployed and live now.'
    expect(endingHint(resolved)).toEqual({ state: 'done' })
  })
})

describe('extractTurns', () => {
  it('pairs each of your messages with the final reply, skipping tools, prompts and deliberation', () => {
    const turns = extractTurns([
      msg('user', 'Build the partner page', 1),
      msg('assistant', 'Looking at the code…', 2),
      msg('tool', 'Read src/app.ts', 3),
      msg('assistant', 'Built it.', 4),
      msg('user', 'standup briefing', 5, { kind: 'prompt' }),
      msg('assistant', 'raw team output', 6, { kind: 'deliberation' }),
      msg('user', 'Deploy it', 7),
    ])
    expect(turns).toEqual([
      { you: 'Build the partner page', reply: 'Built it.', at: 1 },
      { you: 'Deploy it', reply: '', at: 7 },
    ])
  })
})

describe('clip / clipEnd', () => {
  it('cuts on word boundaries and marks the cut', () => {
    expect(clip('alpha beta gamma delta epsilon', 26)).toBe('alpha beta gamma delta …')
    expect(clipEnd('one two three four', 11)).toBe('… three four')
    expect(clip('short', 10)).toBe('short')
  })
})

describe('digestChat', () => {
  const now = Date.UTC(2026, 10, 22, 12)
  const hour = 3_600_000
  const session = (messages: ChatMessage[]): Session => ({
    id: '11111111-1111-4111-8111-111111111111', provider: 'claude', projectId: '22222222-2222-4222-8222-222222222222',
    title: 'MTM Partners MVP', createdAt: now - 72 * hour, updatedAt: now - hour, status: 'live', messages,
  })

  it('keeps the original request, the last turns, counts and the ending', () => {
    const d = digestChat(session([
      msg('user', 'Review mtmcya-partners and ship it', now - 72 * hour),
      msg('assistant', 'Reviewed.', now - 71 * hour),
      msg('user', 'Go ahead with phase 7', now - 30 * hour),
      msg('assistant', 'Phase 7 is built.', now - 29 * hour),
      msg('user', 'I agree, yes both', now - 2 * hour),
      msg('assistant', ASKS, now - hour),
    ]), now)
    expect(d.firstRequest).toBe('Review mtmcya-partners and ship it')
    expect(d.turnCount).toBe(3)
    // The first turn is among the last three: its request isn't repeated.
    expect(d.lastTurns.map((t) => t.you)).toEqual(['(the original request, above)', 'Go ahead with phase 7', 'I agree, yes both'])
    expect(d.mine24).toBe(1)
    expect(d.mine7).toBe(3)
    expect(d.attention).toEqual({ state: 'waiting_on_you', question: 'Do you want me to run it?' })
  })

  it('keeps a one-turn chat\'s reply without repeating the request', () => {
    const d = digestChat(session([msg('user', 'Pitch overview please', now - hour), msg('assistant', INFO, now)]), now)
    expect(d.lastTurns).toEqual([{ you: '(the original request, above)', reply: INFO, at: now - hour }])
  })

  it('handles a chat with no messages from you', () => {
    const d = digestChat(session([]), now)
    expect(d).toMatchObject({ turnCount: 0, firstRequest: '', lastTurns: [], attention: null })
  })
})

describe('endings from real chats', () => {
  it('keeps a question whole when it names a file', () => {
    const reply = 'If the assignment affects the petition, show your attorney first. Want me to update `case-strategy.md` §2a to record that you\'re going with "MTM owns everything"?'
    expect(openQuestion(reply)).toBe('Want me to update case-strategy.md §2a to record that you\'re going with "MTM owns everything"?')
  })

  it('reads deploy instructions as pending', () => {
    const reply = 'Deploy order\n\nWhen you deploy, the functions need to go out before the client build. Otherwise new users reach the reveal without a moon.'
    expect(endingHint(reply)).toEqual({ state: 'pending_action' })
  })
})
