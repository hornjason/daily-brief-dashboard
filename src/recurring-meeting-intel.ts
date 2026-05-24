/**
 * Recurring Meeting Intelligence
 * GitHub Issue #269
 *
 * Detects recurring meeting series via recurringEventId,
 * extracts action items from previous prep docs, and builds
 * carry-forward context for the next prep generation.
 *
 * Pure domain logic — no I/O, no Google API calls.
 */

import type { CalendarEvent } from './types.ts'

// ── Types ────────────────────────────────────────────────────────────────────

export interface PrepHistoryWithSeries {
  meetingTitle: string
  meetingStart: string
  docUrl: string
  title: string
  generatedAt: string
  customerName?: string
  recurringEventId?: string
  actionItems?: string[]
}

// ── Series Detection ─────────────────────────────────────────────────────────

export function detectRecurringSeries(
  events: CalendarEvent[]
): Map<string, CalendarEvent[]> {
  const series = new Map<string, CalendarEvent[]>()

  for (const ev of events) {
    if (!ev.recurringEventId) continue
    const existing = series.get(ev.recurringEventId) ?? []
    existing.push(ev)
    series.set(ev.recurringEventId, existing)
  }

  return series
}

// ── Action Item Extraction ───────────────────────────────────────────────────

export function extractActionItems(prepContent: string): string[] {
  const items: string[] = []

  // Find the Action Items section (### 10. Action Items or ## 10. Action Items)
  const sectionRegex = /#{2,3}\s+\d+\.\s+Action Items\b/i
  const match = sectionRegex.exec(prepContent)
  if (!match) return items

  // Get content from the action items header to the next section header or end
  const afterHeader = prepContent.slice(match.index + match[0].length)
  const nextSection = afterHeader.search(/^#{2,3}\s+/m)
  const sectionContent = nextSection > -1
    ? afterHeader.slice(0, nextSection)
    : afterHeader

  // Parse table rows: | Who | Action | When |
  const tableRowRegex = /^\|\s*([^|]+)\|\s*([^|]+)\|\s*([^|]+)\|$/gm
  let rowMatch
  while ((rowMatch = tableRowRegex.exec(sectionContent)) !== null) {
    const who = rowMatch[1].trim()
    const action = rowMatch[2].trim()
    const when = rowMatch[3].trim()

    // Skip header/separator rows
    if (who === 'Who' || /^[-:]+$/.test(who)) continue
    if (/^[-:|\s]+$/.test(rowMatch[0])) continue

    items.push(`${who}: ${action} (${when})`)
  }

  // Also parse bullet-style items: - Name: Action (when)
  const bulletRegex = /^[-*]\s+(.+)$/gm
  let bulletMatch
  while ((bulletMatch = bulletRegex.exec(sectionContent)) !== null) {
    const text = bulletMatch[1].trim()
    if (text && !items.some(i => i.includes(text.split(':')[0]))) {
      items.push(text)
    }
  }

  return items
}

// ── Previous Prep Lookup ─────────────────────────────────────────────────────

export function findPreviousPrepForSeries(
  recurringEventId: string,
  currentMeetingStart: string,
  history: PrepHistoryWithSeries[]
): PrepHistoryWithSeries | null {
  const seriesHistory = history
    .filter(h =>
      h.recurringEventId === recurringEventId &&
      h.meetingStart !== currentMeetingStart
    )
    .sort((a, b) =>
      new Date(b.generatedAt).getTime() - new Date(a.generatedAt).getTime()
    )

  return seriesHistory[0] ?? null
}

// ── Carry-Forward Context Builder ────────────────────────────────────────────

export function buildCarryForwardContext(
  actionItems: string[],
  previousMeetingDate: string
): string {
  if (actionItems.length === 0) return ''

  const dateStr = new Date(previousMeetingDate).toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  })

  const itemList = actionItems.map(item => `- ${item}`).join('\n')

  return `## Outstanding from Last Meeting (${dateStr})
The following action items were identified in the previous meeting prep. Follow up on their status:

${itemList}

Use these outstanding items to inform discussion questions — ask about progress on each commitment.`
}
