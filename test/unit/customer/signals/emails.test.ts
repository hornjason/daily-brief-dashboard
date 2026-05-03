// BKL-ARCH-23: emails signal source — emailLimit cap + silentContacts placement + classification.

import { describe, it, expect } from 'bun:test'
import { emailsSource } from '../../../../src/customer/signals/emails.ts'
import { makeCtx } from './_helpers.ts'
import type { EmailHighlight, Customer } from '../../../../src/types.ts'
import type { EmailIntelligence, SilentContact } from '../../../../src/email-extraction.ts'

const customer: Customer = { name: 'Acme' }

describe('emailsSource', () => {
  it('caps rendered email lines at ctx.emailLimit', () => {
    const items: EmailHighlight[] = Array.from({ length: 8 }, (_, i) => ({
      customer: 'Acme', subject: `s${i}`, from: `a${i}@x.com`, date: '2026-05-01', snippet: '', actionRequired: false,
    }))
    const xml = emailsSource.render(
      { kind: 'emails', status: { syncedDate: '2026-05-02', staleness: 'ok', lastSuccess: null, lastError: null }, items, classifications: new Map(), silentContacts: [] },
      makeCtx({ emailLimit: 3 }),
    )
    // Only first 3 subjects should appear
    expect(xml).toContain('s0')
    expect(xml).toContain('s2')
    expect(xml).not.toContain('s3')
    // Header still says the full count, not the capped count (legacy behaviour)
    expect(xml).toContain('count="8"')
  })

  it('appends [ACTION REQUIRED] for actionRequired emails when no classification', () => {
    const items: EmailHighlight[] = [
      { customer: 'Acme', subject: 'Help', from: 'a@x.com', date: '2026-05-01', snippet: '', actionRequired: true },
    ]
    const xml = emailsSource.render(
      { kind: 'emails', status: { syncedDate: '2026-05-02', staleness: 'ok', lastSuccess: null, lastError: null }, items, classifications: new Map(), silentContacts: [] },
      makeCtx(),
    )
    expect(xml).toContain('[ACTION REQUIRED]')
  })

  it('uses classification tag instead of [ACTION REQUIRED] when intel present', () => {
    const items: EmailHighlight[] = [
      { customer: 'Acme', subject: 'Q', from: 'a@x.com', date: '2026-05-01', snippet: '', actionRequired: true },
    ]
    const intel: EmailIntelligence = {
      classification: 'RESPONSE_NEEDED', action_items: [], competitive_mentions: [], stakeholder_signals: [],
    }
    const xml = emailsSource.render(
      { kind: 'emails', status: { syncedDate: '2026-05-02', staleness: 'ok', lastSuccess: null, lastError: null }, items, classifications: new Map([['a@x.com|Q|2026-05-01', intel]]), silentContacts: [] },
      makeCtx(),
    )
    expect(xml).toContain('[RESPONSE_NEEDED]')
    expect(xml).not.toContain('[ACTION REQUIRED]')
  })

  it('renders silent_contacts block AFTER all email lines and BEFORE </source>', () => {
    const items: EmailHighlight[] = [
      { customer: 'Acme', subject: 's', from: 'a@x.com', date: '2026-05-01', snippet: '', actionRequired: false },
    ]
    const silentContacts: SilentContact[] = [
      { email: 'sleep@x.com', name: 'Sleeper', lastContact: '2026-02-01', daysSilent: 90, previousFrequency: 4, currentFrequency: 0 },
    ]
    const xml = emailsSource.render(
      { kind: 'emails', status: { syncedDate: '2026-05-02', staleness: 'ok', lastSuccess: null, lastError: null }, items, classifications: new Map(), silentContacts },
      makeCtx(),
    )
    const silentIdx = xml.indexOf('<silent_contacts>')
    const closeIdx  = xml.indexOf('</source>')
    expect(silentIdx).toBeGreaterThan(0)
    expect(silentIdx).toBeLessThan(closeIdx)
    expect(xml).toContain('Sleeper: 90d silent (was 4/mo, now 0/mo)')
  })
})
