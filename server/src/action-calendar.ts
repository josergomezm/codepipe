/**
 * iCalendar (.ics) export of action items with deadlines — one all-day
 * event per open task, for importing into Google Calendar (or any other).
 *
 * Each event's UID is derived from the action item's id, so re-importing
 * the file updates events instead of duplicating them. SEQUENCE tracks the
 * item's last edit so a changed deadline wins over the imported copy.
 */

import type { ActionItem, Project } from './schemas.js'

/** Open tasks with a deadline — decisions are answered, not scheduled. */
export function isCalendarExportable(item: ActionItem): boolean {
  return item.status === 'open' && !!item.dueDate && item.kind !== 'decision'
}

/** RFC 5545 TEXT escaping. */
function escapeText(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n')
}

/** Fold lines longer than 75 octets (continuation lines start with a space). */
function fold(line: string): string {
  const bytes = Buffer.from(line, 'utf8')
  if (bytes.length <= 75) return line
  const parts: string[] = []
  let start = 0
  let limit = 75
  while (start < bytes.length) {
    let end = Math.min(start + limit, bytes.length)
    // Never split a multi-byte UTF-8 character.
    while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--
    parts.push(bytes.subarray(start, end).toString('utf8'))
    start = end
    limit = 74 // room for the leading space
  }
  return parts.join('\r\n ')
}

/** 2026-10-14 → 20261014 */
function icsDate(day: string): string {
  return day.replaceAll('-', '')
}

/** The day after (all-day DTEND is exclusive). */
function nextDay(day: string): string {
  const [y, m, d] = day.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10)
}

/** 20261009T081000Z */
function icsTimestamp(ms: number): string {
  return new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
}

/** Event body: context, steps, and where it came from. */
export function describeActionItem(item: ActionItem, projectName?: string): string {
  return [
    item.notes,
    item.steps?.length ? item.steps.map((step, i) => `${i + 1}. ${step}`).join('\n') : undefined,
    projectName ? `From CodePipe — ${projectName}` : 'From CodePipe',
  ]
    .filter(Boolean)
    .join('\n\n')
}

export function buildActionItemsCalendar(items: ActionItem[], projects: Project[]): string {
  const projectNames = new Map(projects.map((p) => [p.id, p.name]))
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//CodePipe//Action items//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'X-WR-CALNAME:CodePipe tasks',
  ]
  for (const item of items.filter(isCalendarExportable)) {
    const due = item.dueDate!
    lines.push(
      'BEGIN:VEVENT',
      `UID:${item.id}@codepipe`,
      `DTSTAMP:${icsTimestamp(item.updatedAt)}`,
      // Seconds since epoch: grows with every edit, fits a 32-bit integer.
      `SEQUENCE:${Math.floor(item.updatedAt / 1000)}`,
      `DTSTART;VALUE=DATE:${icsDate(due)}`,
      `DTEND;VALUE=DATE:${icsDate(nextDay(due))}`,
      `SUMMARY:${escapeText(item.text)}`,
      `DESCRIPTION:${escapeText(describeActionItem(item, projectNames.get(item.projectId)))}`,
      'TRANSP:TRANSPARENT',
      'END:VEVENT',
    )
  }
  lines.push('END:VCALENDAR')
  return lines.map(fold).join('\r\n') + '\r\n'
}
