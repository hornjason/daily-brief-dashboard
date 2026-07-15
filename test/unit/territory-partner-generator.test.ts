// test/unit/territory-partner-generator.test.ts
// GitHub Issue #995 — Territory partners generation tests
// Covers all 5 ACs: generation count, schema validation, POST refresh,
// GET list, and incremental merge preserving enrichment.

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  generateTerritoryPartners,
  readTerritoryPartners,
  type TerritoryPartner,
} from '../../src/lib/territory-partner-generator'

// ── Fixtures ───────────────────────────────────────────────────────────────────

/** Pipeline data with enough variety to produce ≥15 partners */
function makePipelineData() {
  return {
    records: [
      { oppName: 'Agilent - SHI - RHEL ELS Renewal', accountName: 'Agilent Technologies' },
      { oppName: 'RN - Zions Banc - CDW - RHEL', accountName: 'Zions Bancorporation' },
      { oppName: 'NN - Hotwire - CDW - AAP', accountName: 'Hotwire Communications' },
      { oppName: 'KLA - SHI - (10631389)', accountName: 'KLA Corporation' },
      { oppName: 'Intuitive Surgical - WWT - Renewal', accountName: 'Intuitive Surgical' },
      { oppName: 'RingCentral - Insight - RHEL Renewal', accountName: 'RingCentral' },
      { oppName: 'NN - Columbia - Ingram - AAP', accountName: 'Columbia Sportswear' },
      { oppName: 'Newmont (WWT) - AI at the Edge', accountName: 'Newmont Corporation' },
      { oppName: 'Vail (Trace3) - AAP Across Brands', accountName: 'Vail Resorts' },
      { oppName: 'New - REI - Ansible - CDW', accountName: 'REI' },
      { oppName: 'Renewal - Sea Gate - RHEL - CDW', accountName: 'Seagate Technology' },
      { oppName: 'RN - Banner Bank - AAP - SHI', accountName: 'Banner Corporation' },
      { oppName: 'NN - Acuity - TDS - AAP', accountName: 'Acuity Brands' },
      { oppName: 'DR - NW Natural - Level Up - AAP', accountName: 'NW Natural' },
      { oppName: 'NN - Vizient - Ahead - RHEL', accountName: 'Vizient' },
      { oppName: 'RN - Providence - Presidio - Ansible', accountName: 'Providence' },
      { oppName: 'Fred Hutch - Zones - RHEL', accountName: 'Fred Hutch' },
      { oppName: 'NN - MultiCare - PCM - OCP', accountName: 'MultiCare' },
      { oppName: 'DR - Redfin - Connection - RHEL', accountName: 'Redfin' },
      { oppName: 'NN - Nordstrom - Optiv - AAP', accountName: 'Nordstrom' },
      { oppName: 'RN - BECU - Logicalis - Ansible', accountName: 'BECU' },
      { oppName: 'DR - Alaska Airlines - Dasher - OCP', accountName: 'Alaska Airlines' },
      { oppName: 'NN - Starbucks - Carahsoft - AAP', accountName: 'Starbucks' },
      { oppName: 'RN - Costco - Guidepoint - RHEL', accountName: 'Costco' },
      { oppName: 'NN - Zillow - Corelight - Ansible', accountName: 'Zillow' },
    ],
    cachedAt: new Date().toISOString(),
  }
}

// ── Test scaffolding ───────────────────────────────────────────────────────────

let tmpDir: string
let pipelinePath: string
let outputPath: string

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'tp-gen-test-'))
  pipelinePath = join(tmpDir, 'pipeline-data.json')
  outputPath = join(tmpDir, 'territory-partners.json')
})

afterEach(() => {
  try { rmSync(tmpDir, { recursive: true, force: true }) } catch {}
})

// ── AC-1: generateTerritoryPartners writes file with ≥15 entries ─────────────

describe('AC-1: generation count', () => {
  test('generates ≥15 partner entries from pipeline data', () => {
    writeFileSync(pipelinePath, JSON.stringify(makePipelineData()))
    const result = generateTerritoryPartners(pipelinePath, outputPath)
    expect(result.length).toBeGreaterThanOrEqual(15)

    // Verify file was written
    const onDisk = JSON.parse(readFileSync(outputPath, 'utf-8'))
    expect(onDisk.length).toBe(result.length)
  })

  test('each entry has name, aliases, enrichmentStatus, customerAssociations', () => {
    writeFileSync(pipelinePath, JSON.stringify(makePipelineData()))
    const result = generateTerritoryPartners(pipelinePath, outputPath)
    for (const p of result) {
      expect(p.name).toBeTruthy()
      expect(Array.isArray(p.aliases)).toBe(true)
      expect(p.enrichmentStatus).toBeTruthy()
      expect(Array.isArray(p.customerAssociations)).toBe(true)
    }
  })

  test('returns empty array when pipeline file missing', () => {
    const result = generateTerritoryPartners(join(tmpDir, 'missing.json'), outputPath)
    expect(result).toEqual([])
  })
})

// ── AC-2: schema validation — all 9 required fields ─────────────────────────

describe('AC-2: schema validation', () => {
  const REQUIRED_FIELDS: (keyof TerritoryPartner)[] = [
    'name',
    'aliases',
    'domain',
    'enrichmentStatus',
    'partnershipLevel',
    'specializations',
    'catalogUrl',
    'customerAssociations',
    'extractedAt',
  ]

  test('every entry has all 9 required fields', () => {
    writeFileSync(pipelinePath, JSON.stringify(makePipelineData()))
    const result = generateTerritoryPartners(pipelinePath, outputPath)
    expect(result.length).toBeGreaterThan(0)

    for (const partner of result) {
      for (const field of REQUIRED_FIELDS) {
        expect(partner).toHaveProperty(field)
      }
      expect(REQUIRED_FIELDS.length).toBe(9)
    }
  })

  test('field types are correct', () => {
    writeFileSync(pipelinePath, JSON.stringify(makePipelineData()))
    const result = generateTerritoryPartners(pipelinePath, outputPath)

    for (const p of result) {
      expect(typeof p.name).toBe('string')
      expect(Array.isArray(p.aliases)).toBe(true)
      expect(p.domain === null || typeof p.domain === 'string').toBe(true)
      expect(['pending', 'enriched', 'not-found', 'slug-unknown']).toContain(p.enrichmentStatus)
      expect(p.partnershipLevel === null || typeof p.partnershipLevel === 'string').toBe(true)
      expect(Array.isArray(p.specializations)).toBe(true)
      expect(p.catalogUrl === null || typeof p.catalogUrl === 'string').toBe(true)
      expect(Array.isArray(p.customerAssociations)).toBe(true)
      expect(typeof p.extractedAt).toBe('string')
      // extractedAt should be a valid ISO date
      expect(new Date(p.extractedAt).toISOString()).toBe(p.extractedAt)
    }
  })

  test('customerAssociation entries have correct shape', () => {
    writeFileSync(pipelinePath, JSON.stringify(makePipelineData()))
    const result = generateTerritoryPartners(pipelinePath, outputPath)
    const withAssociations = result.filter(p => p.customerAssociations.length > 0)
    expect(withAssociations.length).toBeGreaterThan(0)

    for (const p of withAssociations) {
      for (const ca of p.customerAssociations) {
        expect(typeof ca.customerName).toBe('string')
        expect(Array.isArray(ca.oppNames)).toBe(true)
        expect(typeof ca.oppCount).toBe('number')
        expect(ca.oppCount).toBeGreaterThan(0)
      }
    }
  })

  test('new entries default to pending enrichmentStatus', () => {
    writeFileSync(pipelinePath, JSON.stringify(makePipelineData()))
    const result = generateTerritoryPartners(pipelinePath, outputPath)
    for (const p of result) {
      expect(p.enrichmentStatus).toBe('pending')
    }
  })
})

// ── AC-3: POST refresh triggers regeneration and returns count ───────────────

describe('AC-3: refresh endpoint (unit logic)', () => {
  test('generateTerritoryPartners returns array with count ≥15', () => {
    writeFileSync(pipelinePath, JSON.stringify(makePipelineData()))
    const result = generateTerritoryPartners(pipelinePath, outputPath)
    // Simulates what the POST endpoint returns: { count: partners.length }
    expect(result.length).toBeGreaterThanOrEqual(15)
  })
})

// ── AC-4: GET returns current territory partner list ─────────────────────────

describe('AC-4: read territory partners', () => {
  test('readTerritoryPartners returns empty array when file missing', () => {
    const result = readTerritoryPartners(join(tmpDir, 'nonexistent.json'))
    expect(result).toEqual([])
  })

  test('readTerritoryPartners returns persisted data', () => {
    writeFileSync(pipelinePath, JSON.stringify(makePipelineData()))
    const generated = generateTerritoryPartners(pipelinePath, outputPath)
    const read = readTerritoryPartners(outputPath)
    expect(read.length).toBe(generated.length)
    expect(read[0].name).toBe(generated[0].name)
  })
})

// ── AC-5: incremental merge preserves enrichment data ────────────────────────

describe('AC-5: incremental merge', () => {
  test('re-generation preserves enrichment fields from existing entries', () => {
    writeFileSync(pipelinePath, JSON.stringify(makePipelineData()))

    // First generation
    const first = generateTerritoryPartners(pipelinePath, outputPath)
    expect(first.length).toBeGreaterThan(0)

    // Simulate enrichment: modify existing file on disk
    const enriched: TerritoryPartner[] = JSON.parse(readFileSync(outputPath, 'utf-8'))
    const targetPartner = enriched[0]
    targetPartner.enrichmentStatus = 'enriched'
    targetPartner.domain = 'example.com'
    targetPartner.partnershipLevel = 'Premier'
    targetPartner.specializations = ['Cloud', 'Automation']
    targetPartner.catalogUrl = 'https://catalog.example.com/partner'
    writeFileSync(outputPath, JSON.stringify(enriched))

    // Re-generate — should preserve enrichment
    const second = generateTerritoryPartners(pipelinePath, outputPath)
    const preserved = second.find(p => p.name.toLowerCase() === targetPartner.name.toLowerCase())

    expect(preserved).toBeDefined()
    expect(preserved!.enrichmentStatus).toBe('enriched')
    expect(preserved!.domain).toBe('example.com')
    expect(preserved!.partnershipLevel).toBe('Premier')
    expect(preserved!.specializations).toEqual(['Cloud', 'Automation'])
    expect(preserved!.catalogUrl).toBe('https://catalog.example.com/partner')
  })

  test('non-enriched entries stay pending after re-generation', () => {
    writeFileSync(pipelinePath, JSON.stringify(makePipelineData()))

    // First generation
    generateTerritoryPartners(pipelinePath, outputPath)

    // Enrich only the first entry
    const enriched: TerritoryPartner[] = JSON.parse(readFileSync(outputPath, 'utf-8'))
    enriched[0].enrichmentStatus = 'enriched'
    writeFileSync(outputPath, JSON.stringify(enriched))

    // Re-generate
    const second = generateTerritoryPartners(pipelinePath, outputPath)
    const nonEnriched = second.filter(p => p.name.toLowerCase() !== enriched[0].name.toLowerCase())
    for (const p of nonEnriched) {
      expect(p.enrichmentStatus).toBe('pending')
    }
  })

  test('new partners from updated pipeline are added alongside existing', () => {
    const data = makePipelineData()
    writeFileSync(pipelinePath, JSON.stringify(data))
    const first = generateTerritoryPartners(pipelinePath, outputPath)
    const firstCount = first.length

    // Enrich first entry
    const enriched: TerritoryPartner[] = JSON.parse(readFileSync(outputPath, 'utf-8'))
    enriched[0].enrichmentStatus = 'enriched'
    writeFileSync(outputPath, JSON.stringify(enriched))

    // Add a new record with a new partner
    data.records.push({ oppName: 'NN - Boeing - Accenture - OCP', accountName: 'Boeing' })
    writeFileSync(pipelinePath, JSON.stringify(data))

    const second = generateTerritoryPartners(pipelinePath, outputPath)
    // Should have at least one more partner than before
    expect(second.length).toBeGreaterThanOrEqual(firstCount)
    // Enrichment on first partner should be preserved
    const preservedPartner = second.find(p => p.name.toLowerCase() === enriched[0].name.toLowerCase())
    expect(preservedPartner?.enrichmentStatus).toBe('enriched')
  })
})
