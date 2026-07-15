// test/unit/partner-catalog.test.ts
// GitHub Issue #265, #996 — Partner Catalog Pipeline tests
// TDD: Tests for partner lookup, matching, signal generation, and tier filtering

import { describe, test, expect, beforeEach } from 'bun:test'
import {
  loadPartners,
  findPartnerByDomain,
  findPartnerByName,
  matchPartnersToProducts,
  type Partner,
  type PartnerCredential,
} from '../../src/lib/partner-catalog.ts'

// ── Test Data ─────────────────────────────────────────────────────────────────

const SEED_PARTNERS: Partner[] = [
  {
    name: 'Shadow-Soft, LLC / Arctiq',
    aliases: ['Shadow-Soft', 'Arctiq'],
    domain: 'shadow-soft.com',
    partnershipLevel: 'Red Hat Specialized Partner',
    specializations: ['Mission Critical Automation', 'Container Mgmt', 'Virtualization', 'Server Cloud OS'],
    geo: 'NA',
    country: 'US, Canada',
    catalogUrl: 'https://catalog.redhat.com/en/partners/detail/shadow-soft',
    sourceUrl: 'https://source.redhat.com/departments/sales/global_red_hat_specialized_partners',
    slug: 'shadow-soft',
    enrichmentStatus: 'enriched',
    credentials: [
      {
        name: 'Red Hat Ansible Automation Platform: Technical Seller',
        type: 'credential',
        product: 'Ansible Automation Platform',
        count: 12,
      },
      {
        name: 'Red Hat OpenShift Container Platform: Administrator',
        type: 'certification',
        product: 'OpenShift Container Platform',
        count: 8,
      },
    ],
  },
  {
    name: 'CDW',
    aliases: [],
    domain: 'cdw.com',
    partnershipLevel: 'Red Hat Specialized Partner',
    specializations: ['Mission Critical Automation', 'Container Mgmt'],
    geo: 'NA',
    country: 'US, Canada',
    catalogUrl: 'https://catalog.redhat.com/en/partners/detail/cdw',
    sourceUrl: 'https://source.redhat.com/departments/sales/global_red_hat_specialized_partners',
    enrichmentStatus: 'enriched',
  },
  {
    name: 'Insight Direct USA',
    aliases: ['Insight', 'Insight Enterprises'],
    domain: 'insight.com',
    partnershipLevel: 'Red Hat Specialized Partner',
    specializations: ['Mission Critical Automation'],
    geo: 'NA',
    country: 'US, Canada',
    catalogUrl: 'https://catalog.redhat.com/en/partners/detail/insight',
    sourceUrl: 'https://source.redhat.com/departments/sales/global_red_hat_specialized_partners',
    enrichmentStatus: 'enriched',
    credentials: [
      {
        name: 'Red Hat Enterprise Linux: System Administrator',
        type: 'certification',
        product: 'Red Hat Enterprise Linux',
        count: 25,
      },
    ],
  },
  // #996: Territory partners with null fields (no enrichment yet)
  {
    name: 'Acme Consulting',
    aliases: [],
    domain: null,
    partnershipLevel: null,
    specializations: [],
    enrichmentStatus: 'pending',
  },
  {
    name: 'Premier Tech Solutions',
    aliases: ['PTS'],
    domain: 'premiertech.com',
    partnershipLevel: 'Premier Business Partner',
    specializations: ['Application Platform'],
    enrichmentStatus: 'enriched',
  },
]

// ── findPartnerByDomain ─────────────────────────────────────────────────────

describe('findPartnerByDomain', () => {
  test('exact domain match', () => {
    const result = findPartnerByDomain('cdw.com', SEED_PARTNERS)
    expect(result).toBeDefined()
    expect(result!.name).toBe('CDW')
  })

  test('subdomain match (email domain)', () => {
    const result = findPartnerByDomain('mail.shadow-soft.com', SEED_PARTNERS)
    expect(result).toBeDefined()
    expect(result!.name).toBe('Shadow-Soft, LLC / Arctiq')
  })

  test('alias-based domain match', () => {
    const result = findPartnerByDomain('arctiq.ca', SEED_PARTNERS)
    // aliases check is by name containment, not domain — this should not match by domain
    expect(result).toBeUndefined()
  })

  test('unknown domain returns undefined', () => {
    const result = findPartnerByDomain('unknown-company.com', SEED_PARTNERS)
    expect(result).toBeUndefined()
  })

  test('skips partners with null domain (#996)', () => {
    const result = findPartnerByDomain('acme.com', SEED_PARTNERS)
    // Acme Consulting has null domain — should not match
    expect(result).toBeUndefined()
  })
})

// ── findPartnerByName ─────────────────────────────────────────────────────────

describe('findPartnerByName', () => {
  test('exact name match', () => {
    const result = findPartnerByName('CDW', SEED_PARTNERS)
    expect(result).toBeDefined()
    expect(result!.name).toBe('CDW')
  })

  test('case-insensitive match', () => {
    const result = findPartnerByName('cdw', SEED_PARTNERS)
    expect(result).toBeDefined()
    expect(result!.name).toBe('CDW')
  })

  test('alias match', () => {
    const result = findPartnerByName('Shadow-Soft', SEED_PARTNERS)
    expect(result).toBeDefined()
    expect(result!.name).toBe('Shadow-Soft, LLC / Arctiq')
  })

  test('alias match case-insensitive', () => {
    const result = findPartnerByName('insight', SEED_PARTNERS)
    expect(result).toBeDefined()
    expect(result!.name).toBe('Insight Direct USA')
  })

  test('unknown name returns undefined', () => {
    const result = findPartnerByName('Acme Corp', SEED_PARTNERS)
    expect(result).toBeUndefined()
  })

  test('partial name in full name matches', () => {
    const result = findPartnerByName('Insight Enterprises', SEED_PARTNERS)
    expect(result).toBeDefined()
    expect(result!.name).toBe('Insight Direct USA')
  })
})

// ── matchPartnersToProducts ─────────────────────────────────────────────────

describe('matchPartnersToProducts', () => {
  test('matches partners by specialization keyword', () => {
    const results = matchPartnersToProducts(['Ansible Automation Platform'], SEED_PARTNERS)
    // Partners with "Mission Critical Automation" specialization should match AAP
    expect(results.length).toBeGreaterThan(0)
  })

  test('matches partners by credential product', () => {
    const results = matchPartnersToProducts(['OpenShift Container Platform'], SEED_PARTNERS)
    // Shadow-Soft has an OpenShift credential
    const shadowSoft = results.find(r => r.partner.name.includes('Shadow-Soft'))
    expect(shadowSoft).toBeDefined()
    expect(shadowSoft!.matchType).toContain('credential')
  })

  test('returns empty for unmatched products', () => {
    const results = matchPartnersToProducts(['Satellite Server'], SEED_PARTNERS)
    // No partners have Satellite specialization or credentials
    expect(results.length).toBe(0)
  })

  test('includes credential depth in results', () => {
    const results = matchPartnersToProducts(['OpenShift Container Platform'], SEED_PARTNERS)
    const shadowSoft = results.find(r => r.partner.name.includes('Shadow-Soft'))
    expect(shadowSoft).toBeDefined()
    expect(shadowSoft!.credentialCount).toBeGreaterThan(0)
  })

  test('sorts by credential depth descending', () => {
    const results = matchPartnersToProducts(['Red Hat Enterprise Linux'], SEED_PARTNERS)
    if (results.length > 1) {
      for (let i = 1; i < results.length; i++) {
        expect(results[i - 1].credentialCount).toBeGreaterThanOrEqual(results[i].credentialCount)
      }
    }
  })
})

// ── Partner interface — territory-partners.json fields (#996) ────────────────

describe('Partner interface territory fields (#996)', () => {
  test('Partner supports null partnershipLevel', () => {
    const p = SEED_PARTNERS.find(p => p.name === 'Acme Consulting')!
    expect(p.partnershipLevel).toBeNull()
  })

  test('Partner supports enrichmentStatus', () => {
    const p = SEED_PARTNERS.find(p => p.name === 'Shadow-Soft, LLC / Arctiq')!
    expect(p.enrichmentStatus).toBe('enriched')
  })

  test('Partner supports null domain', () => {
    const p = SEED_PARTNERS.find(p => p.name === 'Acme Consulting')!
    expect(p.domain).toBeNull()
  })

  test('Partner supports optional geo/country', () => {
    const p = SEED_PARTNERS.find(p => p.name === 'Acme Consulting')!
    expect(p.geo).toBeUndefined()
    expect(p.country).toBeUndefined()
  })
})

// ── loadPartners ────────────────────────────────────────────────────────────

describe('loadPartners', () => {
  test('returns empty array for missing file', () => {
    const result = loadPartners('/nonexistent/path/partners.json')
    expect(result).toEqual([])
  })

  test('returns empty array for invalid JSON', () => {
    // Write a temp file with invalid JSON
    const tmpPath = '/tmp/bad-partners.json'
    require('fs').writeFileSync(tmpPath, 'not json')
    const result = loadPartners(tmpPath)
    expect(result).toEqual([])
    require('fs').unlinkSync(tmpPath)
  })

  test('loads valid partners file', () => {
    const tmpPath = '/tmp/test-partners.json'
    require('fs').writeFileSync(tmpPath, JSON.stringify(SEED_PARTNERS))
    const result = loadPartners(tmpPath)
    expect(result.length).toBe(5)
    expect(result[0].name).toBe('Shadow-Soft, LLC / Arctiq')
    require('fs').unlinkSync(tmpPath)
  })

  test('loads territory-partners.json format with nullable fields (#996)', () => {
    const tmpPath = '/tmp/test-territory-partners.json'
    const territoryPartners = [
      { name: 'Test Partner', aliases: [], domain: null, partnershipLevel: null, specializations: [], enrichmentStatus: 'pending' },
      { name: 'Enriched Partner', aliases: ['EP'], domain: 'ep.com', partnershipLevel: 'Advanced Business Partner', specializations: ['Automation'], enrichmentStatus: 'enriched', catalogUrl: 'https://catalog.redhat.com/ep' },
    ]
    require('fs').writeFileSync(tmpPath, JSON.stringify(territoryPartners))
    const result = loadPartners(tmpPath)
    expect(result.length).toBe(2)
    expect(result[0].partnershipLevel).toBeNull()
    expect(result[1].partnershipLevel).toBe('Advanced Business Partner')
    expect(result[0].enrichmentStatus).toBe('pending')
    require('fs').unlinkSync(tmpPath)
  })
})
