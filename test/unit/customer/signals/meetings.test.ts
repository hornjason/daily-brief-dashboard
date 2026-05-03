// BKL-ARCH-23: meetings signal source — upcoming-only filter, prep enrichment.

import { describe, it, expect } from 'bun:test'
import { meetingsSource } from '../../../../src/customer/signals/meetings.ts'
import { makeCtx } from './_helpers.ts'
import type { CalendarEvent, Customer } from '../../../../src/types.ts'
import type { MeetingPrep } from '../../../../src/calendar-extraction.ts'

const customer: Customer = { name: 'Acme' }

const future = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
const past   = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()

describe('meetingsSource', () => {
  it('collect filters to upcoming meetings (returns null when all past)', async () => {
    const meetings: CalendarEvent[] = [
      { title: 'Old', start: past, end: past, needsPrep: true },
    ]
    expect(await meetingsSource.collect({ customer, meetings })).toBeNull()
  })

  it('collect builds prep map keyed by `${title}|${start}`', async () => {
    const meetings: CalendarEvent[] = [
      { title: 'QBR', start: future, end: future, attendees: ['a@x.com'], needsPrep: true },
    ]
    const prep: MeetingPrep = {
      meeting: { title: 'QBR', start: future, attendees: ['a@x.com'] },
      attendeeContext: [], openActionItems: [],
      healthSignals: { cases: '', renewals: '', pipeline: '' },
      competitiveContext: [],
      stakeholderCoverage: { engaged: [], missing: [], silent: [] },
    }
    const bundle = await meetingsSource.collect({ customer, meetings, meetingPreps: [prep] })
    expect(bundle?.preps.get(`QBR|${future}`)).toBeDefined()
  })

  it('render emits attendee_context / health_signals / silent_attendees / missing_stakeholders blocks when prep set', () => {
    const meetings: CalendarEvent[] = [
      { title: 'QBR', start: '2026-06-01T15:00:00.000Z', end: '2026-06-01T16:00:00.000Z', attendees: ['a@x.com', 'b@x.com'], needsPrep: true },
    ]
    const preps = new Map<string, MeetingPrep>([
      [`QBR|2026-06-01T15:00:00.000Z`, {
        meeting: { title: 'QBR', start: '2026-06-01T15:00:00.000Z', attendees: ['a@x.com'] },
        attendeeContext: [{ name: 'a@x.com', lastInteraction: '2026-05-01', emailFrequency: 'weekly' }],
        openActionItems: [],
        healthSignals: { cases: '1 open', renewals: '0', pipeline: '$0' },
        competitiveContext: ['VMware'],
        stakeholderCoverage: { engaged: [], missing: ['cfo@x.com'], silent: ['carol@x.com'] },
      }],
    ])
    const xml = meetingsSource.render(
      { kind: 'meetings', status: { syncedDate: '2026-05-02', staleness: 'ok', lastSuccess: null, lastError: null }, items: meetings, preps },
      makeCtx(),
    )
    expect(xml).toContain('<source type="calendar" window="next_30_days" count="1">')
    expect(xml).toContain('<attendee_context>')
    expect(xml).toContain('<health_signals cases="1 open" renewals="0" />')
    expect(xml).toContain('<competitive_context>VMware</competitive_context>')
    expect(xml).toContain('<silent_attendees>carol@x.com</silent_attendees>')
    expect(xml).toContain('<missing_stakeholders>cfo@x.com</missing_stakeholders>')
  })
})
