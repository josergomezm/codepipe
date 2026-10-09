import { describe, it, expect } from 'vitest'

import { buildActionItemsCalendar, isCalendarExportable } from './action-calendar.js'
import type { ActionItem, Project } from './schemas.js'

const PROJECT: Project = { id: '11111111-1111-4111-8111-111111111111', name: 'Demo', path: '/tmp/demo' } as Project

function item(overrides: Partial<ActionItem> = {}): ActionItem {
  return {
    id: '22222222-2222-4222-8222-222222222222',
    projectId: PROJECT.id,
    text: 'Renew the cert',
    status: 'open',
    dueDate: '2026-12-31',
    createdAt: 1_790_000_000_000,
    updatedAt: 1_791_000_000_000,
    ...overrides,
  }
}

/** Undo RFC 5545 line folding. */
function unfold(ics: string): string {
  return ics.replace(/\r\n /g, '')
}

describe('isCalendarExportable', () => {
  it('takes open tasks with a deadline only', () => {
    expect(isCalendarExportable(item())).toBe(true)
    expect(isCalendarExportable(item({ kind: 'task' }))).toBe(true)
    expect(isCalendarExportable(item({ kind: 'decision' }))).toBe(false)
    expect(isCalendarExportable(item({ status: 'done' }))).toBe(false)
    expect(isCalendarExportable(item({ dueDate: undefined }))).toBe(false)
  })
})

describe('buildActionItemsCalendar', () => {
  it('emits an all-day event with a stable UID and an exclusive end date', () => {
    const ics = buildActionItemsCalendar([item()], [PROJECT])
    expect(ics.startsWith('BEGIN:VCALENDAR\r\n')).toBe(true)
    expect(ics.endsWith('END:VCALENDAR\r\n')).toBe(true)
    expect(ics).toContain('UID:22222222-2222-4222-8222-222222222222@codepipe\r\n')
    expect(ics).toContain('DTSTART;VALUE=DATE:20261231\r\n')
    // Crosses the year boundary.
    expect(ics).toContain('DTEND;VALUE=DATE:20270101\r\n')
    expect(ics).toContain('SEQUENCE:1791000000\r\n')
    expect(ics).toContain('DTSTAMP:20261003T040000Z\r\n')
  })

  it('is identical for the same items, so re-importing matches events', () => {
    expect(buildActionItemsCalendar([item()], [PROJECT])).toBe(buildActionItemsCalendar([item()], [PROJECT]))
  })

  it('escapes text and includes notes, steps and the project', () => {
    const ics = unfold(
      buildActionItemsCalendar(
        [item({ text: 'Buy a domain; cheap, fast', notes: 'Line one\nC:\\path', steps: ['Open the registrar', 'Pay'] })],
        [PROJECT],
      ),
    )
    expect(ics).toContain('SUMMARY:Buy a domain\\; cheap\\, fast\r\n')
    expect(ics).toContain('DESCRIPTION:Line one\\nC:\\\\path\\n\\n1. Open the registrar\\n2. Pay\\n\\nFrom CodePipe — Demo\r\n')
  })

  it('folds long lines at 75 octets without splitting characters', () => {
    const ics = buildActionItemsCalendar([item({ notes: 'é'.repeat(200) })], [PROJECT])
    for (const line of ics.split('\r\n')) {
      expect(Buffer.byteLength(line, 'utf8')).toBeLessThanOrEqual(75)
      expect(line).not.toContain('�')
    }
    expect(unfold(ics)).toContain('é'.repeat(200))
  })

  it('leaves out decisions, closed items and items without a deadline', () => {
    const ics = buildActionItemsCalendar(
      [item({ kind: 'decision' }), item({ status: 'dismissed' }), item({ dueDate: undefined })],
      [PROJECT],
    )
    expect(ics).not.toContain('BEGIN:VEVENT')
  })
})
