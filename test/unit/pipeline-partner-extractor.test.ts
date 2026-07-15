// test/unit/pipeline-partner-extractor.test.ts
// GitHub Issue #993 — Pipeline partner name extraction tests
// Covers all 5 ACs: extraction count, known partners, program exclusion, dedup, associations

import { describe, test, expect, beforeAll } from 'bun:test'
import { resolve } from 'path'
import {
  extractPartnersFromPipeline,
  extractPartnersFromFile,
  type PipelineRecordInput,
  type ExtractedPartner,
} from '../../src/lib/pipeline-partner-extractor'

// ── Fixtures ───────────────────────────────────────────────────────────────────

/** Minimal pipeline records that exercise all patterns */
function makeRecords(): PipelineRecordInput[] {
  return [
    // Standard: Customer - Partner - Product
    { oppName: 'Agilent - SHI - RHEL ELS Renewal', accountName: 'Agilent Technologies, Inc.' },
    // Prefix - Customer - Partner - Product
    { oppName: 'RN - Zions Banc - CDW - RHEL/JBOSS/RUNTIMES', accountName: 'Zions Bancorporation' },
    // NN prefix - Customer - Partner - Product
    { oppName: 'NN - Hotwire - CDW - AAP', accountName: 'Hotwire Communications, LLC' },
    // Customer - Partner - (ID) - Contact
    { oppName: 'KLA - SHI - (10631389) - Travis Ross and Paul Craig', accountName: 'KLA Corporation' },
    // Level Up as valid partner
    { oppName: 'DR - NW Natural - Level Up - AAP - Network Automation - RH identified', accountName: 'Northwest Natural Holding Company' },
    // Level Up second occurrence
    { oppName: 'RHEL EUS - Qty 25 - Level Up', accountName: 'Bdo Usa, LLP' },
    // WWT
    { oppName: 'Intuitive Surgical, Inc. - Q2 Renewal - WWT', accountName: 'Intuitive Surgical, Inc.' },
    // Insight
    { oppName: 'RingCentral - Insight - RHEL Renewal (Q2)', accountName: 'Ringcentral, Inc.' },
    // Slash-separated partner pair
    { oppName: 'NN - Columbia Sportswear - Ingram/WWT - AAP - Edge growth', accountName: 'Columbia Sportswear Company' },
    // Parenthesized partner
    { oppName: 'Newmont (WWT) - AI at the Edge', accountName: 'Newmont Corporation' },
    { oppName: 'Vail (Trace3) - AAP Across Brands', accountName: 'Vail Resorts, Inc.' },
    // More CDW associations for AC-5
    { oppName: 'New - REI - Ansible - CDW', accountName: 'Recreational Equipment, Inc.' },
    { oppName: 'New - REI - ROSA - CDW', accountName: 'Recreational Equipment, Inc.' },
    { oppName: 'Renewal - Sea Gate Technology - RHEL - CDW (Primary)', accountName: 'Seagate Technology LLC' },
    { oppName: 'ITS - OpenJDK8 Support - CDW', accountName: 'Its, Inc.' },
    { oppName: 'NN - Acuity - TDS/CDW - AAP - Expansion nodes', accountName: 'Acuity Brands, Inc.' },
    { oppName: 'NN - Vizient - TDS/CDW - AAP - Server Automation', accountName: 'Vizient, Inc.' },
    // SHI additional
    { oppName: 'RN - Banner Bank - 00553477 - AAP - SHI', accountName: 'Banner Corporation' },
    { oppName: 'Renewal - SHI - Seagate Technology LLC - Acct#6440675', accountName: 'Seagate Technology LLC' },
    // Ahead
    { oppName: 'NN - Mattel - Ahead - AAP', accountName: 'Mattel, Inc.' },
    // Computacenter
    { oppName: 'NN- Xifin - Computacenter - AAP growth', accountName: 'Xifin, Inc.' },
    // Presidio
    { oppName: 'MQO-KKR-RH AI-Presidio-OB', accountName: 'KKR & Co. Inc.' },
    // Double-slash with partner
    { oppName: 'NN // Cirrus // SHI // Virtualization', accountName: 'Cirrus Logic, Inc.' },
    // Evotek
    { oppName: 'NN - Banner Health - OpenShift Virt - Evotek', accountName: 'Banner Health' },
    // Shadow-Soft
    { oppName: 'Mouser - AAP - Shadow-Soft', accountName: 'Mouser Electronics, Inc.' },
    // ePlus
    { oppName: 'NN - XPO - ePlus - OVE+ACM+AAP', accountName: 'Xpo Supply Chain, Inc.' },
    // Mainline
    { oppName: 'Pure - Mainline - OpenShift Renewal', accountName: 'Pure Storage, Inc.' },
    // PC Connection
    { oppName: 'RN - Levi\'s - PC Connection - RHEL - 00541033', accountName: 'Levi Strauss & Co.' },
    // Iolap
    { oppName: 'RN - SPP - Iolap - RHEL/VDC/AAP', accountName: 'Southwest Power Pool, Inc.' },
  ]
}

/** Records designed to produce false positives that should be EXCLUDED */
function makeFalsePositiveRecords(): PipelineRecordInput[] {
  return [
    // "Level Up Program" — Red Hat program, not a partner
    { oppName: 'NN - Dillard\'s Level Up Program -  IBM', accountName: 'Dillard\'s, Inc.' },
    // "Level UP Cloud Pak" — Red Hat program
    { oppName: 'Alliant Energy - Level UP Cloud Pak', accountName: 'Alliant Energy Corporation' },
    // "OpenShift Level Up" — Red Hat program
    { oppName: 'MQO-The Williams Companies Inc-OpenShift Level Up-OB', accountName: 'The Williams Companies Inc' },
    // CCSP royalty records — skip entirely
    { oppName: 'Global Royalty-CCSP-IBM Softlayer-CY26Q1-M1-US-MPlus Client', accountName: 'IBM' },
    { oppName: 'Local Royalty-CCSP-Arrow-CY26Q1', accountName: 'Arrow' },
  ]
}

// ── AC-1: ≥15 unique partner names from live data ──────────────────────────────

describe('AC-1: extractPartnersFromPipeline returns ≥15 unique partners', () => {
  test('fixture records produce ≥15 unique partners', () => {
    const records = makeRecords()
    const partners = extractPartnersFromPipeline(records)
    expect(partners.length).toBeGreaterThanOrEqual(15)
  })

  test('live pipeline data produces ≥15 unique partners', () => {
    const dataPath = resolve('data/cache/pipeline-data.json')
    const partners = extractPartnersFromFile(dataPath)
    expect(partners.length).toBeGreaterThanOrEqual(15)
  })

  test('fail-open on invalid input', () => {
    expect(extractPartnersFromPipeline(null as any)).toEqual([])
    expect(extractPartnersFromPipeline([] as any)).toEqual([])
    expect(extractPartnersFromFile('/nonexistent/path.json')).toEqual([])
  })
})

// ── AC-2: Known partners present ───────────────────────────────────────────────

describe('AC-2: CDW, SHI, Insight, WWT, Level Up all present', () => {
  const KNOWN_PARTNERS = ['CDW', 'SHI', 'Insight', 'WWT', 'Level Up']
  let partners: ExtractedPartner[]

  beforeAll(() => {
    partners = extractPartnersFromPipeline(makeRecords())
  })

  for (const name of KNOWN_PARTNERS) {
    test(`${name} is present in extraction results`, () => {
      const found = partners.find(p => p.name.toLowerCase() === name.toLowerCase())
      expect(found).toBeDefined()
    })
  }

  test('all 5 known partners present in live data', () => {
    const dataPath = resolve('data/cache/pipeline-data.json')
    const livePartners = extractPartnersFromFile(dataPath)
    const partnerNames = livePartners.map(p => p.name.toLowerCase())
    for (const name of KNOWN_PARTNERS) {
      expect(partnerNames).toContain(name.toLowerCase())
    }
  })
})

// ── AC-3: Red Hat program names excluded ───────────────────────────────────────

describe('AC-3: Red Hat program names excluded from results', () => {
  test('"Dillard\'s Level Up Program" does not produce partner extraction', () => {
    const records: PipelineRecordInput[] = [
      { oppName: 'NN - Dillard\'s Level Up Program -  IBM', accountName: 'Dillard\'s, Inc.' },
    ]
    const partners = extractPartnersFromPipeline(records)
    const names = partners.map(p => p.name.toLowerCase())
    // "Level Up Program" segment should be excluded
    expect(names).not.toContain('level up program')
    // "Dillard's Level Up Program" segment should be excluded
    expect(names).not.toContain("dillard's level up program")
  })

  test('"Alliant Energy Level UP Cloud Pak" does not produce partner extraction', () => {
    const records: PipelineRecordInput[] = [
      { oppName: 'Alliant Energy - Level UP Cloud Pak', accountName: 'Alliant Energy Corporation' },
    ]
    const partners = extractPartnersFromPipeline(records)
    const names = partners.map(p => p.name.toLowerCase())
    expect(names).not.toContain('level up cloud pak')
    expect(names).not.toContain('level up')
  })

  test('"OpenShift Level Up" excluded as Red Hat program', () => {
    const records: PipelineRecordInput[] = [
      { oppName: 'MQO-The Williams Companies Inc-OpenShift Level Up-OB', accountName: 'The Williams Companies Inc' },
    ]
    const partners = extractPartnersFromPipeline(records)
    const names = partners.map(p => p.name.toLowerCase())
    expect(names).not.toContain('openshift level up')
  })

  test('standalone "Level Up" IS still extracted as a valid partner', () => {
    const records: PipelineRecordInput[] = [
      { oppName: 'DR - NW Natural - Level Up - AAP', accountName: 'Northwest Natural Holding Company' },
    ]
    const partners = extractPartnersFromPipeline(records)
    const names = partners.map(p => p.name.toLowerCase())
    expect(names).toContain('level up')
  })

  test('no false positives in combined extraction', () => {
    const records = [...makeRecords(), ...makeFalsePositiveRecords()]
    const partners = extractPartnersFromPipeline(records)
    const names = partners.map(p => p.name.toLowerCase())
    expect(names).not.toContain('level up program')
    expect(names).not.toContain('level up cloud pak')
    expect(names).not.toContain('openshift level up')
    // "Level Up" standalone should still be present
    expect(names).toContain('level up')
  })
})

// ── AC-4: Deduplication handles case variations ────────────────────────────────

describe('AC-4: case-insensitive deduplication', () => {
  test('"SHI", "shi", "Shi" collapse to single entry', () => {
    const records: PipelineRecordInput[] = [
      { oppName: 'Customer A - SHI - RHEL', accountName: 'Customer A Corp' },
      { oppName: 'Customer B - shi - AAP', accountName: 'Customer B Inc.' },
      { oppName: 'Customer C - Shi - OpenShift', accountName: 'Customer C LLC' },
    ]
    const partners = extractPartnersFromPipeline(records)
    const shiEntries = partners.filter(p => p.name.toLowerCase() === 'shi')
    expect(shiEntries).toHaveLength(1)
    // All variants should be in aliases
    expect(shiEntries[0].aliases).toContain('SHI')
    expect(shiEntries[0].aliases).toContain('shi')
    expect(shiEntries[0].aliases).toContain('Shi')
  })

  test('"CDW", "cdw", "Cdw" collapse to single entry', () => {
    const records: PipelineRecordInput[] = [
      { oppName: 'Customer A - CDW - RHEL', accountName: 'Customer A Corp' },
      { oppName: 'Customer B - cdw - AAP', accountName: 'Customer B Inc.' },
      { oppName: 'Customer C - Cdw - ROSA', accountName: 'Customer C LLC' },
    ]
    const partners = extractPartnersFromPipeline(records)
    const cdwEntries = partners.filter(p => p.name.toLowerCase() === 'cdw')
    expect(cdwEntries).toHaveLength(1)
    expect(cdwEntries[0].aliases).toContain('CDW')
    expect(cdwEntries[0].aliases).toContain('cdw')
    expect(cdwEntries[0].aliases).toContain('Cdw')
  })

  test('"Ahead" and "AHEAD" collapse to single entry', () => {
    const records: PipelineRecordInput[] = [
      { oppName: 'NN - Mattel - Ahead - AAP', accountName: 'Mattel, Inc.' },
      { oppName: 'NN - Sharp - AHEAD - RHEL', accountName: 'Sharp Healthcare' },
    ]
    const partners = extractPartnersFromPipeline(records)
    const aheadEntries = partners.filter(p => p.name.toLowerCase() === 'ahead')
    expect(aheadEntries).toHaveLength(1)
    expect(aheadEntries[0].aliases).toContain('Ahead')
    expect(aheadEntries[0].aliases).toContain('AHEAD')
  })

  test('canonical name uses first-seen casing', () => {
    const records: PipelineRecordInput[] = [
      { oppName: 'Customer A - shi - RHEL', accountName: 'Customer A Corp' },
      { oppName: 'Customer B - SHI - AAP', accountName: 'Customer B Inc.' },
    ]
    const partners = extractPartnersFromPipeline(records)
    const shiEntry = partners.find(p => p.name.toLowerCase() === 'shi')
    expect(shiEntry?.name).toBe('shi') // first-seen casing preserved
  })
})

// ── AC-5: Customer associations with required fields ───────────────────────────

describe('AC-5: partner entries include customer associations', () => {
  let partners: ExtractedPartner[]

  beforeAll(() => {
    partners = extractPartnersFromPipeline(makeRecords())
  })

  test('every partner has name, customerAssociations with required fields', () => {
    for (const partner of partners) {
      expect(partner.name).toBeTruthy()
      expect(partner.aliases).toBeInstanceOf(Array)
      expect(partner.customerAssociations).toBeInstanceOf(Array)
      for (const ca of partner.customerAssociations) {
        expect(ca.customerName).toBeTruthy()
        expect(ca.oppNames).toBeInstanceOf(Array)
        expect(ca.oppNames.length).toBeGreaterThan(0)
        expect(ca.oppCount).toBeGreaterThan(0)
        expect(ca.oppCount).toBe(ca.oppNames.length)
      }
    }
  })

  test('CDW has ≥5 customer associations', () => {
    const cdw = partners.find(p => p.name.toLowerCase() === 'cdw')
    expect(cdw).toBeDefined()
    expect(cdw!.customerAssociations.length).toBeGreaterThanOrEqual(5)
  })

  test('CDW associations include expected customers', () => {
    const cdw = partners.find(p => p.name.toLowerCase() === 'cdw')
    expect(cdw).toBeDefined()
    const custNames = cdw!.customerAssociations.map(ca => ca.customerName)
    // These customers are in our fixture data
    expect(custNames).toContain('Zions Bancorporation')
    expect(custNames).toContain('Hotwire Communications, LLC')
    expect(custNames).toContain('Recreational Equipment, Inc.')
  })

  test('CDW association for REI has 2 opps', () => {
    const cdw = partners.find(p => p.name.toLowerCase() === 'cdw')
    expect(cdw).toBeDefined()
    const reiAssoc = cdw!.customerAssociations.find(ca =>
      ca.customerName.includes('Recreational Equipment')
    )
    expect(reiAssoc).toBeDefined()
    expect(reiAssoc!.oppCount).toBe(2)
    expect(reiAssoc!.oppNames).toHaveLength(2)
  })

  test('CDW has ≥5 customer associations in live data', () => {
    const dataPath = resolve('data/cache/pipeline-data.json')
    const livePartners = extractPartnersFromFile(dataPath)
    const cdw = livePartners.find(p => p.name.toLowerCase() === 'cdw')
    expect(cdw).toBeDefined()
    expect(cdw!.customerAssociations.length).toBeGreaterThanOrEqual(5)
  })

  test('associations sorted by opp count descending', () => {
    const cdw = partners.find(p => p.name.toLowerCase() === 'cdw')
    expect(cdw).toBeDefined()
    for (let i = 1; i < cdw!.customerAssociations.length; i++) {
      expect(cdw!.customerAssociations[i - 1].oppCount)
        .toBeGreaterThanOrEqual(cdw!.customerAssociations[i].oppCount)
    }
  })
})

// ── Edge case coverage ─────────────────────────────────────────────────────────

describe('edge cases', () => {
  test('slash-separated partner pairs extract both partners', () => {
    const records: PipelineRecordInput[] = [
      { oppName: 'NN - Columbia - Arrow/CDW - AAP', accountName: 'Columbia Sportswear Company' },
    ]
    const partners = extractPartnersFromPipeline(records)
    const names = partners.map(p => p.name.toLowerCase())
    expect(names).toContain('arrow')
    expect(names).toContain('cdw')
  })

  test('parenthesized partner extracted from customer segment', () => {
    const records: PipelineRecordInput[] = [
      { oppName: 'Newmont (WWT) - AI at the Edge', accountName: 'Newmont Corporation' },
    ]
    const partners = extractPartnersFromPipeline(records)
    const names = partners.map(p => p.name.toLowerCase())
    expect(names).toContain('wwt')
  })

  test('double-slash separator handled', () => {
    const records: PipelineRecordInput[] = [
      { oppName: 'NN // Cirrus // SHI // Virtualization', accountName: 'Cirrus Logic, Inc.' },
    ]
    const partners = extractPartnersFromPipeline(records)
    const names = partners.map(p => p.name.toLowerCase())
    expect(names).toContain('shi')
  })

  test('person names after IDs are not extracted as partners', () => {
    const records: PipelineRecordInput[] = [
      { oppName: 'KLA - SHI - (10631389) - Travis Ross', accountName: 'KLA Corporation' },
    ]
    const partners = extractPartnersFromPipeline(records)
    const names = partners.map(p => p.name.toLowerCase())
    expect(names).toContain('shi')
    expect(names).not.toContain('travis ross')
  })

  test('CCSP royalty records are skipped', () => {
    const records: PipelineRecordInput[] = [
      { oppName: 'Global Royalty-CCSP-IBM Softlayer-CY26Q1-M1-US-MPlus Client', accountName: 'IBM' },
    ]
    const partners = extractPartnersFromPipeline(records)
    expect(partners).toHaveLength(0)
  })

  test('paren annotations stripped — CDW (Primary) extracts CDW', () => {
    const records: PipelineRecordInput[] = [
      { oppName: 'Renewal - Seagate - RHEL - CDW (Primary)', accountName: 'Seagate Technology LLC' },
    ]
    const partners = extractPartnersFromPipeline(records)
    const names = partners.map(p => p.name.toLowerCase())
    expect(names).toContain('cdw')
  })

  test('compact dash format extracts partner', () => {
    const records: PipelineRecordInput[] = [
      { oppName: 'MQO-KKR-RH AI-Presidio-OB', accountName: 'KKR & Co. Inc.' },
    ]
    const partners = extractPartnersFromPipeline(records)
    const names = partners.map(p => p.name.toLowerCase())
    expect(names).toContain('presidio')
  })

  test('results sorted by total opp count descending', () => {
    const partners = extractPartnersFromPipeline(makeRecords())
    for (let i = 1; i < partners.length; i++) {
      const prevTotal = partners[i - 1].customerAssociations.reduce((s, ca) => s + ca.oppCount, 0)
      const currTotal = partners[i].customerAssociations.reduce((s, ca) => s + ca.oppCount, 0)
      expect(prevTotal).toBeGreaterThanOrEqual(currTotal)
    }
  })
})
