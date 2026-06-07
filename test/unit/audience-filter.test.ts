/**
 * Audience Filter — Unit Tests (#644)
 *
 * Tests audience-aware content filtering for meeting prep.
 * Three audience types: Customer, Partner, Internal.
 * Each filters evidence blocks differently before Gemini.
 */
import { describe, it, expect, beforeAll } from 'bun:test'

// Lazy import to avoid ESM TDZ issues
let filterForAudience: typeof import('../../src/lib/audience-filter.ts').filterForAudience
let detectAudienceType: typeof import('../../src/lib/audience-filter.ts').detectAudienceType
let crossReferencePartnerCustomers: typeof import('../../src/lib/audience-filter.ts').crossReferencePartnerCustomers
let AudienceType: typeof import('../../src/lib/audience-filter.ts').AudienceType

beforeAll(async () => {
  const mod = await import('../../src/lib/audience-filter.ts')
  filterForAudience = mod.filterForAudience
  detectAudienceType = mod.detectAudienceType
  crossReferencePartnerCustomers = mod.crossReferencePartnerCustomers
})

// ── Test fixtures ────────────────────────────────────────────────────────────

function makeEvidenceBlock(overrides: Partial<any> = {}): any {
  return {
    title: 'Test Block',
    source: 'pipeline',
    content: 'Some content',
    metadata: {},
    availableLevers: [],
    evidenceItems: [],
    ...overrides,
  }
}

function makeLever(overrides: Partial<any> = {}): any {
  return {
    name: 'Test Lever',
    source: 'product',
    description: 'A lever',
    ...overrides,
  }
}

function makeEvidenceItem(overrides: Partial<any> = {}): any {
  return {
    text: 'Evidence text',
    source: 'intelligence',
    ...overrides,
  }
}

function makeCustomer(overrides: Partial<any> = {}): any {
  return {
    name: 'Acme Corp',
    domain: 'acme.com',
    aliasDomains: [],
    ...overrides,
  }
}

// ── AC-1: AudienceType enum ─────────────────────────────────────────────────

describe('AudienceType', () => {
  it('supports customer, partner, and internal values', () => {
    const types: Array<'customer' | 'partner' | 'internal'> = ['customer', 'partner', 'internal']
    expect(types).toHaveLength(3)
    // The type system enforces this — just confirm filterForAudience accepts each
    const block = makeEvidenceBlock()
    for (const t of types) {
      const result = filterForAudience([block], t)
      expect(Array.isArray(result)).toBe(true)
    }
  })
})

// ── AC-2 & AC-10: Customer filter removes spiff levers ──────────────────────

describe('filterForAudience — Customer', () => {
  it('strips availableLevers with source "spiff"', () => {
    const block = makeEvidenceBlock({
      availableLevers: [
        makeLever({ name: 'Q2 Spiff', source: 'spiff' }),
        makeLever({ name: 'Product Demo', source: 'product' }),
      ],
    })

    const [filtered] = filterForAudience([block], 'customer')
    expect(filtered.availableLevers).toHaveLength(1)
    expect(filtered.availableLevers[0].name).toBe('Product Demo')
  })

  it('strips availableLevers with source "internal-incentive"', () => {
    const block = makeEvidenceBlock({
      availableLevers: [
        makeLever({ name: 'Internal Bonus', source: 'internal-incentive' }),
        makeLever({ name: 'Marketplace Credit', source: 'ecosystem' }),
      ],
    })

    const [filtered] = filterForAudience([block], 'customer')
    expect(filtered.availableLevers).toHaveLength(1)
    expect(filtered.availableLevers[0].name).toBe('Marketplace Credit')
  })

  it('strips evidence items with source "competitive-intel"', () => {
    const block = makeEvidenceBlock({
      evidenceItems: [
        makeEvidenceItem({ text: 'Competitor is weak here', source: 'competitive-intel' }),
        makeEvidenceItem({ text: 'Customer uses RHEL 9', source: 'subscriptions' }),
      ],
    })

    const [filtered] = filterForAudience([block], 'customer')
    expect(filtered.evidenceItems).toHaveLength(1)
    expect(filtered.evidenceItems[0].source).toBe('subscriptions')
  })

  it('keeps blocks with no sensitive content unchanged', () => {
    const block = makeEvidenceBlock({
      availableLevers: [makeLever({ source: 'product' })],
      evidenceItems: [makeEvidenceItem({ source: 'intelligence' })],
    })

    const [filtered] = filterForAudience([block], 'customer')
    expect(filtered.availableLevers).toHaveLength(1)
    expect(filtered.evidenceItems).toHaveLength(1)
  })
})

// ── AC-3 & AC-11: Partner filter removes pipeline $, competitive intel, spiffs

describe('filterForAudience — Partner', () => {
  it('strips availableLevers with source "spiff" or "internal-incentive"', () => {
    const block = makeEvidenceBlock({
      availableLevers: [
        makeLever({ name: 'Q2 Spiff', source: 'spiff' }),
        makeLever({ name: 'Internal Bonus', source: 'internal-incentive' }),
        makeLever({ name: 'Ecosystem Play', source: 'ecosystem' }),
        makeLever({ name: 'Marketplace Listing', source: 'marketplace' }),
      ],
    })

    const [filtered] = filterForAudience([block], 'partner')
    expect(filtered.availableLevers).toHaveLength(2)
    expect(filtered.availableLevers.map((l: any) => l.name)).toEqual([
      'Ecosystem Play',
      'Marketplace Listing',
    ])
  })

  it('strips evidence items containing pipeline dollar amounts', () => {
    const block = makeEvidenceBlock({
      evidenceItems: [
        makeEvidenceItem({ text: 'Pipeline worth $1.2M in Q3', source: 'pipeline' }),
        makeEvidenceItem({ text: 'Customer evaluating OpenShift', source: 'intelligence' }),
        makeEvidenceItem({ text: 'Deal value: $500,000', source: 'pipeline' }),
      ],
    })

    const [filtered] = filterForAudience([block], 'partner')
    expect(filtered.evidenceItems).toHaveLength(1)
    expect(filtered.evidenceItems[0].text).toBe('Customer evaluating OpenShift')
  })

  it('strips evidence items with source "competitive-intel"', () => {
    const block = makeEvidenceBlock({
      evidenceItems: [
        makeEvidenceItem({ text: 'VMware displacement opportunity', source: 'competitive-intel' }),
        makeEvidenceItem({ text: 'Using Ansible for automation', source: 'tech-stack' }),
      ],
    })

    const [filtered] = filterForAudience([block], 'partner')
    expect(filtered.evidenceItems).toHaveLength(1)
    expect(filtered.evidenceItems[0].source).toBe('tech-stack')
  })

  it('keeps partner-relevant levers (ecosystem, marketplace)', () => {
    const block = makeEvidenceBlock({
      availableLevers: [
        makeLever({ source: 'ecosystem' }),
        makeLever({ source: 'marketplace' }),
      ],
    })

    const [filtered] = filterForAudience([block], 'partner')
    expect(filtered.availableLevers).toHaveLength(2)
  })
})

// ── AC-4 & AC-12: Internal filter preserves all fields ──────────────────────

describe('filterForAudience — Internal', () => {
  it('passes all data through without filtering', () => {
    const block = makeEvidenceBlock({
      availableLevers: [
        makeLever({ source: 'spiff' }),
        makeLever({ source: 'internal-incentive' }),
        makeLever({ source: 'product' }),
      ],
      evidenceItems: [
        makeEvidenceItem({ source: 'competitive-intel' }),
        makeEvidenceItem({ text: 'Pipeline: $2M', source: 'pipeline' }),
        makeEvidenceItem({ source: 'intelligence' }),
      ],
    })

    const [filtered] = filterForAudience([block], 'internal')
    expect(filtered.availableLevers).toHaveLength(3)
    expect(filtered.evidenceItems).toHaveLength(3)
  })

  it('returns the same array reference for internal (no copy overhead)', () => {
    const blocks = [makeEvidenceBlock(), makeEvidenceBlock()]
    const filtered = filterForAudience(blocks, 'internal')
    expect(filtered).toBe(blocks)
  })
})

// ── AC-5 & AC-13: Auto-detection ────────────────────────────────────────────

describe('detectAudienceType', () => {
  const customer = makeCustomer({
    domain: 'acme.com',
    aliasDomains: ['acmeinc.com'],
  })

  it('detects Internal when only @redhat.com attendees', () => {
    const emails = ['alice@redhat.com', 'bob@redhat.com']
    expect(detectAudienceType(emails, customer)).toBe('internal')
  })

  it('detects Customer when customer domain present', () => {
    const emails = ['alice@redhat.com', 'jane@acme.com']
    expect(detectAudienceType(emails, customer)).toBe('customer')
  })

  it('detects Customer when customer alias domain present', () => {
    const emails = ['alice@redhat.com', 'jane@acmeinc.com']
    expect(detectAudienceType(emails, customer)).toBe('customer')
  })

  it('detects Partner when non-customer, non-redhat domains and no customer domains', () => {
    const emails = ['alice@redhat.com', 'partner@cdw.com']
    expect(detectAudienceType(emails, customer)).toBe('partner')
  })

  it('detects Customer when both customer and partner domains present', () => {
    // Customer takes precedence when both are present
    const emails = ['alice@redhat.com', 'jane@acme.com', 'partner@cdw.com']
    expect(detectAudienceType(emails, customer)).toBe('customer')
  })

  it('returns "internal" for empty attendee list', () => {
    expect(detectAudienceType([], customer)).toBe('internal')
  })
})

// ── AC-8, AC-9, AC-14: Partner cross-reference ─────────────────────────────

describe('crossReferencePartnerCustomers', () => {
  it('returns matches where partner specializations align with customer tech stacks', () => {
    const customers = [
      makeCustomer({
        name: 'Acme Corp',
        domain: 'acme.com',
      }),
      makeCustomer({
        name: 'Beta Inc',
        domain: 'beta.com',
      }),
    ]

    // Signal loader returns tech stack signals
    const signalLoader = (slug: string) => {
      if (slug === 'acme-corp') {
        return [
          { source: 'tech-stack', metadata: { product: 'OpenShift Container Platform' } },
          { source: 'tech-stack', metadata: { product: 'Ansible Automation Platform' } },
        ]
      }
      if (slug === 'beta-inc') {
        return [
          { source: 'tech-stack', metadata: { product: 'Red Hat Enterprise Linux' } },
        ]
      }
      return []
    }

    const partnerList = [{
      name: 'CDW',
      domain: 'cdw.com',
      aliases: [],
      specializations: ['Container Mgmt', 'Mission Critical Automation'],
      partnershipLevel: 'Advanced',
      geo: 'NA',
      country: 'US',
    }]

    const matches = crossReferencePartnerCustomers('cdw', customers, signalLoader, partnerList)

    expect(matches.length).toBeGreaterThan(0)
    // AC-9: Check returned fields
    for (const match of matches) {
      expect(match).toHaveProperty('customerName')
      expect(match).toHaveProperty('matchedProducts')
      expect(match).toHaveProperty('opportunityContext')
    }
  })

  it('returns empty array when no customers match partner specializations', () => {
    const customers = [
      makeCustomer({ name: 'Acme Corp', domain: 'acme.com' }),
    ]
    const signalLoader = () => []
    const partnerList = [{
      name: 'Unknown Partner',
      domain: 'unknown.com',
      aliases: [],
      specializations: ['Virtualization'],
      partnershipLevel: 'Ready',
      geo: 'NA',
      country: 'US',
    }]

    const matches = crossReferencePartnerCustomers('unknownpartner', customers, signalLoader, partnerList)
    expect(matches).toEqual([])
  })
})
