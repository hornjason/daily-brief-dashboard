/**
 * Meeting Prep Signals — GitHub Issue #429 Step 1
 *
 * Converts meeting-specific context (attendees, partners, carry-forward,
 * drive docs, objective) into typed Signal objects. These signals are
 * merged with registry signals before calling templateAll().
 *
 * This module produces ONLY signals that are unique to the meeting context.
 * Data already provided by the registry (CCSP, cases, subscriptions, product
 * lifecycle, RSS) is NOT duplicated here.
 */

import type { Signal } from '../feature-module-registry.ts'
import type { Customer } from '../types.ts'

// ── Types ───────────────────────────────────────────────────────────────────

export interface MeetingContext {
  meetingTitle: string
  meetingStart: string
  attendees: string[]
  attendeeDetails?: Array<{ email: string; displayName?: string; linkedinUrl?: string }>
  recurringEventId?: string
  objective?: string
  productFocus?: string[]
  notes?: string
}

export interface MeetingEnrichmentInput {
  customer: Customer
  meeting: MeetingContext
  /** Gemini grounding result for attendee research */
  attendeeResearch?: string
  /** Partner research/config result */
  partnerContext?: string
  /** Recommended partners table markdown */
  otherPartnersTable?: string
  /** Names of detected partners in the meeting */
  detectedPartnerNames?: string[]
  /** From recurring meeting carry-forward intel */
  carryForwardContext?: string
  /** From Drive folder scan */
  driveDocsContext?: string
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Returns true if value is a non-empty, non-whitespace string */
function hasContent(value: string | undefined | null): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

/** Truncate string to maxLen, appending "..." if truncated */
function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str
  return str.slice(0, maxLen) + '...'
}

// ── Main ────────────────────────────────────────────────────────────────────

/**
 * Convert meeting-specific context into typed signals that can be merged
 * with registry signals before calling templateAll().
 *
 * These signals represent data that only exists in the meeting context --
 * NOT data that the registry already provides (CCSP, cases, subscriptions, etc.)
 *
 * Each signal is only produced if the corresponding input data is present
 * and non-empty. Empty strings or missing fields are skipped.
 */
export function enrichMeetingSignals(input: MeetingEnrichmentInput): Signal[] {
  const signals: Signal[] = []
  const now = new Date().toISOString()
  const { customer, meeting } = input

  // 1. Meeting objective (highest relevance -- drives all content)
  if (hasContent(meeting.objective)) {
    signals.push({
      source: 'meeting-prep',
      type: 'intelligence',
      headline: `Meeting Objective: ${truncate(meeting.objective!.trim(), 80)}`,
      detail: meeting.objective!.trim(),
      rawRelevance: 0.95,
      timestamp: now,
      metadata: {
        meetingTitle: meeting.meetingTitle,
        objective: meeting.objective!.trim(),
      },
    })
  }

  // 2. Carry-forward items (critical -- must be addressed)
  if (hasContent(input.carryForwardContext)) {
    signals.push({
      source: 'meeting-prep',
      type: 'intelligence',
      headline: 'Outstanding Items from Previous Meeting',
      detail: input.carryForwardContext!.trim(),
      rawRelevance: 0.90,
      timestamp: now,
      metadata: {
        recurring: true,
        meetingTitle: meeting.meetingTitle,
      },
    })
  }

  // 3. Attendee intelligence (high -- directly actionable for THIS meeting)
  if (hasContent(input.attendeeResearch)) {
    signals.push({
      source: 'meeting-prep',
      type: 'intelligence',
      headline: `Meeting Attendees — ${customer.name}`,
      detail: input.attendeeResearch!.trim(),
      rawRelevance: 0.85,
      timestamp: now,
      metadata: {
        attendeeCount: meeting.attendees.length,
        customerName: customer.name,
        meetingTitle: meeting.meetingTitle,
      },
    })
  }

  // 4. Partner context (high -- partner in the meeting)
  if (hasContent(input.partnerContext)) {
    const partnerNames = input.detectedPartnerNames ?? []
    const nameLabel = partnerNames.length > 0
      ? partnerNames.join(', ')
      : 'Detected Partners'

    let detail = input.partnerContext!.trim()
    if (hasContent(input.otherPartnersTable)) {
      detail += '\n\n' + input.otherPartnersTable!.trim()
    }

    signals.push({
      source: 'meeting-prep',
      type: 'intelligence',
      headline: `Partner Intelligence — ${nameLabel}`,
      detail,
      rawRelevance: 0.75,
      timestamp: now,
      metadata: {
        partnerNames: partnerNames.length > 0 ? partnerNames : undefined,
        meetingTitle: meeting.meetingTitle,
      },
    })
  }

  // 5. Recent Drive documents (medium -- useful context)
  if (hasContent(input.driveDocsContext)) {
    signals.push({
      source: 'meeting-prep',
      type: 'intelligence',
      headline: 'Recent Account Documents',
      detail: input.driveDocsContext!.trim(),
      rawRelevance: 0.60,
      timestamp: now,
      metadata: {
        meetingTitle: meeting.meetingTitle,
      },
    })
  }

  return signals
}
