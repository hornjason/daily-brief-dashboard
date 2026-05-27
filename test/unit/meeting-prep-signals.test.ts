/**
 * Unit tests for enrichMeetingSignals()
 * GitHub Issue #429 — Step 1: Meeting-specific signal enrichment
 *
 * Tests the conversion of meeting-specific context (attendees, partners,
 * carry-forward, drive docs, objective) into typed Signal objects that
 * can be merged with registry signals before calling templateAll().
 */

import { describe, expect, test } from 'bun:test'
import {
  enrichMeetingSignals,
  type MeetingContext,
  type MeetingEnrichmentInput,
} from '../../src/lib/meeting-prep-signals.ts'

// ── Helpers ─────────────────────────────────────────────────────────────────

function baseMeeting(): MeetingContext {
  return {
    meetingTitle: 'Q3 Strategy Review',
    meetingStart: '2026-05-27T10:00:00Z',
    attendees: ['alice@acme.com', 'bob@redhat.com'],
  }
}

function baseInput(overrides: Partial<MeetingEnrichmentInput> = {}): MeetingEnrichmentInput {
  return {
    customer: { name: 'Acme Corp', slug: 'acme-corp' } as any,
    meeting: baseMeeting(),
    ...overrides,
  }
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('enrichMeetingSignals', () => {
  test('returns empty array when all inputs are empty/missing', () => {
    const signals = enrichMeetingSignals(baseInput())
    expect(signals).toEqual([])
  })

  test('produces attendee signal when attendeeResearch is provided', () => {
    const signals = enrichMeetingSignals(baseInput({
      attendeeResearch: '- **Alice Smith**, VP Engineering at Acme Corp — leads cloud migration',
    }))

    expect(signals).toHaveLength(1)
    const sig = signals[0]
    expect(sig.source).toBe('meeting-prep')
    expect(sig.type).toBe('intelligence')
    expect(sig.headline).toContain('Meeting Attendees')
    expect(sig.headline).toContain('Acme Corp')
    expect(sig.rawRelevance).toBe(0.85)
    expect(sig.detail).toContain('Alice Smith')
    expect(sig.metadata?.customerName).toBe('Acme Corp')
    expect(sig.metadata?.meetingTitle).toBe('Q3 Strategy Review')
  })

  test('produces partner signal when partnerContext is provided', () => {
    const signals = enrichMeetingSignals(baseInput({
      partnerContext: '**Cisco**\n- Partnership Level: Premier\n- Specializations: Network Automation',
      detectedPartnerNames: ['Cisco'],
    }))

    expect(signals).toHaveLength(1)
    const sig = signals[0]
    expect(sig.source).toBe('meeting-prep')
    expect(sig.type).toBe('intelligence')
    expect(sig.headline).toContain('Partner Intelligence')
    expect(sig.headline).toContain('Cisco')
    expect(sig.rawRelevance).toBe(0.75)
    expect(sig.metadata?.partnerNames).toEqual(['Cisco'])
    expect(sig.metadata?.meetingTitle).toBe('Q3 Strategy Review')
  })

  test('includes otherPartnersTable in partner signal detail when present', () => {
    const signals = enrichMeetingSignals(baseInput({
      partnerContext: '**Cisco** — Premier Partner',
      detectedPartnerNames: ['Cisco'],
      otherPartnersTable: '| Partner | Specializations |\n|---|---|\n| Dell | Server Cloud |',
    }))

    expect(signals).toHaveLength(1)
    expect(signals[0].detail).toContain('Dell')
    expect(signals[0].detail).toContain('Server Cloud')
  })

  test('produces carry-forward signal when carryForwardContext is provided', () => {
    const signals = enrichMeetingSignals(baseInput({
      meeting: { ...baseMeeting(), recurringEventId: 'series-123' },
      carryForwardContext: '## Outstanding Items\n- Follow up on POC timeline\n- Share pricing proposal',
    }))

    expect(signals).toHaveLength(1)
    const sig = signals[0]
    expect(sig.source).toBe('meeting-prep')
    expect(sig.type).toBe('intelligence')
    expect(sig.headline).toBe('Outstanding Items from Previous Meeting')
    expect(sig.rawRelevance).toBe(0.90)
    expect(sig.detail).toContain('POC timeline')
    expect(sig.metadata?.recurring).toBe(true)
    expect(sig.metadata?.meetingTitle).toBe('Q3 Strategy Review')
  })

  test('produces drive docs signal when driveDocsContext is provided', () => {
    const signals = enrichMeetingSignals(baseInput({
      driveDocsContext: '## Account Notes & Recent Documents\n### Migration Plan (modified 05/20/2026)\nPhase 1 complete...',
    }))

    expect(signals).toHaveLength(1)
    const sig = signals[0]
    expect(sig.source).toBe('meeting-prep')
    expect(sig.type).toBe('intelligence')
    expect(sig.headline).toBe('Recent Account Documents')
    expect(sig.rawRelevance).toBe(0.60)
    expect(sig.detail).toContain('Migration Plan')
    expect(sig.metadata?.meetingTitle).toBe('Q3 Strategy Review')
  })

  test('produces objective signal when objective is provided', () => {
    const signals = enrichMeetingSignals(baseInput({
      meeting: { ...baseMeeting(), objective: 'Discuss OpenShift expansion to production clusters and timeline for Q4 rollout' },
    }))

    expect(signals).toHaveLength(1)
    const sig = signals[0]
    expect(sig.source).toBe('meeting-prep')
    expect(sig.type).toBe('intelligence')
    expect(sig.headline).toContain('Meeting Objective:')
    expect(sig.headline).toContain('Discuss OpenShift expansion')
    expect(sig.rawRelevance).toBe(0.95)
    expect(sig.metadata?.meetingTitle).toBe('Q3 Strategy Review')
    expect(sig.metadata?.objective).toContain('Discuss OpenShift expansion')
  })

  test('truncates objective headline to 80 characters', () => {
    const longObjective = 'A'.repeat(120)
    const signals = enrichMeetingSignals(baseInput({
      meeting: { ...baseMeeting(), objective: longObjective },
    }))

    expect(signals).toHaveLength(1)
    // "Meeting Objective: " is 19 chars + 80 truncated chars
    expect(signals[0].headline.length).toBeLessThanOrEqual(19 + 80 + 3) // +3 for "..."
  })

  test('does NOT produce signal for empty string inputs', () => {
    const signals = enrichMeetingSignals(baseInput({
      attendeeResearch: '',
      partnerContext: '',
      carryForwardContext: '',
      driveDocsContext: '',
      meeting: { ...baseMeeting(), objective: '' },
    }))

    expect(signals).toEqual([])
  })

  test('does NOT produce signal for whitespace-only inputs', () => {
    const signals = enrichMeetingSignals(baseInput({
      attendeeResearch: '   ',
      partnerContext: '  \n  ',
      carryForwardContext: '\t',
      driveDocsContext: '   ',
      meeting: { ...baseMeeting(), objective: '  ' },
    }))

    expect(signals).toEqual([])
  })

  test('all signals have source "meeting-prep" and type "intelligence"', () => {
    const signals = enrichMeetingSignals(baseInput({
      attendeeResearch: 'Alice Smith, VP Eng',
      partnerContext: 'Cisco — Premier',
      detectedPartnerNames: ['Cisco'],
      carryForwardContext: 'Follow up on POC',
      driveDocsContext: 'Migration plan doc',
      meeting: { ...baseMeeting(), objective: 'Discuss expansion', recurringEventId: 'series-1' },
    }))

    for (const sig of signals) {
      expect(sig.source).toBe('meeting-prep')
      expect(sig.type).toBe('intelligence')
    }
  })

  test('rawRelevance values match spec', () => {
    const signals = enrichMeetingSignals(baseInput({
      attendeeResearch: 'Alice Smith, VP Eng',
      partnerContext: 'Cisco — Premier',
      detectedPartnerNames: ['Cisco'],
      carryForwardContext: 'Follow up on POC',
      driveDocsContext: 'Migration plan doc',
      meeting: { ...baseMeeting(), objective: 'Discuss expansion', recurringEventId: 'series-1' },
    }))

    expect(signals).toHaveLength(5)

    const byHeadline = (prefix: string) => signals.find(s => s.headline.startsWith(prefix))

    expect(byHeadline('Meeting Objective')?.rawRelevance).toBe(0.95)
    expect(byHeadline('Outstanding Items')?.rawRelevance).toBe(0.90)
    expect(byHeadline('Meeting Attendees')?.rawRelevance).toBe(0.85)
    expect(byHeadline('Partner Intelligence')?.rawRelevance).toBe(0.75)
    expect(byHeadline('Recent Account Documents')?.rawRelevance).toBe(0.60)
  })

  test('produces all 5 signals when all inputs provided', () => {
    const signals = enrichMeetingSignals(baseInput({
      attendeeResearch: 'Alice Smith, VP Eng',
      partnerContext: 'Cisco — Premier',
      detectedPartnerNames: ['Cisco'],
      carryForwardContext: 'Follow up on POC',
      driveDocsContext: 'Migration plan doc',
      meeting: { ...baseMeeting(), objective: 'Discuss expansion', recurringEventId: 'series-1' },
    }))

    expect(signals).toHaveLength(5)

    const headlines = signals.map(s => s.headline)
    expect(headlines.some(h => h.startsWith('Meeting Objective'))).toBe(true)
    expect(headlines.some(h => h.startsWith('Outstanding Items'))).toBe(true)
    expect(headlines.some(h => h.startsWith('Meeting Attendees'))).toBe(true)
    expect(headlines.some(h => h.startsWith('Partner Intelligence'))).toBe(true)
    expect(headlines.some(h => h === 'Recent Account Documents')).toBe(true)
  })

  test('all signals have valid ISO 8601 timestamps', () => {
    const signals = enrichMeetingSignals(baseInput({
      attendeeResearch: 'Alice Smith',
      meeting: { ...baseMeeting(), objective: 'Test' },
    }))

    for (const sig of signals) {
      expect(() => new Date(sig.timestamp).toISOString()).not.toThrow()
    }
  })

  test('partner signal without detectedPartnerNames uses generic headline', () => {
    const signals = enrichMeetingSignals(baseInput({
      partnerContext: 'Unknown partner detected from domain acme-partner.com',
    }))

    expect(signals).toHaveLength(1)
    expect(signals[0].headline).toContain('Partner Intelligence')
    // Should still work without specific names
    expect(signals[0].rawRelevance).toBe(0.75)
  })

  test('attendee signal metadata includes attendee count from attendees array', () => {
    const signals = enrichMeetingSignals(baseInput({
      attendeeResearch: 'Alice Smith, VP Eng; Bob Jones, Dir Ops',
      meeting: {
        ...baseMeeting(),
        attendees: ['alice@acme.com', 'bob@acme.com', 'carol@redhat.com'],
      },
    }))

    expect(signals).toHaveLength(1)
    expect(signals[0].metadata?.attendeeCount).toBe(3)
  })
})
