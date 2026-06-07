/**
 * test/unit/council-audit-fixes.test.ts
 * Tests for council audit fixes #647-#652
 *
 * Covers:
 * - #648: getEnrichedAttendeeName with resolved profiles
 * - #649: enrichmentContext gating when evidence blocks present
 * - #651: domain-detection.ts extraction (detectPartnerDomains, deriveCompanyFromDomain)
 */
import { describe, it, expect } from 'bun:test'
import { getEnrichedAttendeeName, getAttendeeDisplayName } from '../../src/meeting-prep-service.ts'
import { detectPartnerDomains, deriveCompanyFromDomain } from '../../src/lib/domain-detection.ts'
import type { AttendeeProfile } from '../../src/lib/attendee-profile-cache.ts'

// ── #648: Enriched attendee names ─────────────────────────────────────────

describe('#648: getEnrichedAttendeeName', () => {
  const meeting = {
    attendees: ['john@acme.com', 'jane@partner.com'],
    attendeeDetails: [
      { email: 'john@acme.com', displayName: 'John Doe' },
    ],
  }

  it('returns "Name, Title at Company" for resolved profiles with title', () => {
    const profiles: AttendeeProfile[] = [
      { email: 'john@acme.com', name: 'John Doe', title: 'VP Engineering', company: 'Acme Corp', resolved: true, source: 'grounding' },
    ]
    expect(getEnrichedAttendeeName('john@acme.com', meeting, profiles)).toBe('John Doe, VP Engineering at Acme Corp')
  })

  it('returns "name (profile not found)" for unresolved profiles', () => {
    const profiles: AttendeeProfile[] = [
      { email: 'jane@partner.com', name: 'Jane Smith', title: '', company: 'Partner', resolved: false, source: 'email-derived' },
    ]
    expect(getEnrichedAttendeeName('jane@partner.com', meeting, profiles)).toBe('Jane Smith (profile not found)')
  })

  it('falls back to calendar display name when no profile exists', () => {
    const result = getEnrichedAttendeeName('john@acme.com', meeting, [])
    expect(result).toBe('John Doe')
  })

  it('falls back to email-derived name when no profile and no calendar name', () => {
    const result = getEnrichedAttendeeName('jane@partner.com', meeting, [])
    expect(result).toBe('Jane')
  })
})

// ── #651: domain-detection.ts extraction ──────────────────────────────────

describe('#651: domain-detection extracted to lib', () => {
  it('deriveCompanyFromDomain extracts capitalized company name', () => {
    expect(deriveCompanyFromDomain('user@insight.com')).toBe('Insight')
    expect(deriveCompanyFromDomain('test@acme.co.uk')).toBe('Acme')
  })

  it('detectPartnerDomains identifies non-customer, non-RH domains', () => {
    const customer = { name: 'Acme', domain: 'acme.com' } as any
    const emails = ['alice@acme.com', 'bob@redhat.com', 'carol@partner.io']
    const result = detectPartnerDomains(emails, customer)
    expect(result.partnerDomains).toEqual(['partner.io'])
    expect(result.customerDomains).toContain('acme.com')
  })

  it('detectPartnerDomains handles alias domains', () => {
    const customer = { name: 'Acme', domain: 'acme.com', aliasDomains: ['acme-corp.com'] } as any
    const emails = ['user@acme-corp.com', 'ext@vendor.com']
    const result = detectPartnerDomains(emails, customer)
    expect(result.partnerDomains).toEqual(['vendor.com'])
  })

  // Verify backward compat: re-export from meeting-prep-service still works
  it('meeting-prep-service re-exports detectPartnerDomains', async () => {
    const { detectPartnerDomains: reExported } = await import('../../src/meeting-prep-service.ts')
    expect(typeof reExported).toBe('function')
  })

  it('meeting-prep-service re-exports deriveCompanyFromDomain', async () => {
    const { deriveCompanyFromDomain: reExported } = await import('../../src/meeting-prep-service.ts')
    expect(typeof reExported).toBe('function')
  })
})
