/**
 * REG-394/395: CCSP account name deduplication
 *
 * Verifies that buildCCSPSummary normalizes account names so
 * "Crowdstrike" and "CROWDSTRIKE" merge into a single entry,
 * using the first-seen casing as the display name.
 */
import { describe, it, expect } from 'bun:test'
import { buildCCSPSummary } from '../../src/customer-service.ts'
import type { CCSPRecord } from '../../src/sheets.ts'

function makeRecord(overrides: Partial<CCSPRecord>): CCSPRecord {
  return {
    accountName: 'Test Account',
    cloudPartner: 'AWS',
    acvPlus: 1000,
    ae: 'Jane Doe',
    quarter: '2026-Q1',
    productOfferingGroup: 'OPENSHIFT',
    ...overrides,
  } as CCSPRecord
}

describe('buildCCSPSummary — account name dedup (#395)', () => {
  it('merges accounts with different casing into one entry', () => {
    const records: CCSPRecord[] = [
      makeRecord({ accountName: 'Crowdstrike', acvPlus: 500 }),
      makeRecord({ accountName: 'CROWDSTRIKE', acvPlus: 300 }),
      makeRecord({ accountName: 'crowdstrike', acvPlus: 200 }),
    ]
    const summary = buildCCSPSummary(records, new Date().toISOString(), false)

    // Should produce exactly one customer entry
    expect(summary.byCustomer.length).toBe(1)
    expect(summary.byCustomer[0].acv).toBe(1000)
  })

  it('uses first-seen casing as display name', () => {
    const records: CCSPRecord[] = [
      makeRecord({ accountName: 'CrowdStrike', acvPlus: 500 }),
      makeRecord({ accountName: 'CROWDSTRIKE', acvPlus: 300 }),
    ]
    const summary = buildCCSPSummary(records, new Date().toISOString(), false)

    expect(summary.byCustomer[0].name).toBe('CrowdStrike')
  })

  it('merges per-AE customer maps with normalized names', () => {
    const records: CCSPRecord[] = [
      makeRecord({ accountName: 'Crowdstrike', ae: 'Jane Doe', acvPlus: 500 }),
      makeRecord({ accountName: 'CROWDSTRIKE', ae: 'Jane Doe', acvPlus: 300 }),
    ]
    const summary = buildCCSPSummary(records, new Date().toISOString(), false)

    const janeAE = summary.byAE.find(a => a.ae === 'Jane Doe')
    expect(janeAE).toBeDefined()
    // topAccounts should have one merged entry, not two
    expect(janeAE!.topAccounts.length).toBe(1)
    expect(janeAE!.topAccounts[0].acv).toBe(800)
  })

  it('merges per-account partner breakdown with normalized names', () => {
    const records: CCSPRecord[] = [
      makeRecord({ accountName: 'Crowdstrike', cloudPartner: 'AWS', acvPlus: 500 }),
      makeRecord({ accountName: 'CROWDSTRIKE', cloudPartner: 'Google', acvPlus: 300 }),
    ]
    const summary = buildCCSPSummary(records, new Date().toISOString(), false)

    expect(summary.byCustomer.length).toBe(1)
    expect(summary.byCustomer[0].partners.length).toBe(2)
    const awsPartner = summary.byCustomer[0].partners.find(p => p.partner === 'AWS')
    expect(awsPartner?.acv).toBe(500)
  })

  it('keeps distinct accounts separate', () => {
    const records: CCSPRecord[] = [
      makeRecord({ accountName: 'Crowdstrike', acvPlus: 500 }),
      makeRecord({ accountName: 'Palo Alto Networks', acvPlus: 700 }),
    ]
    const summary = buildCCSPSummary(records, new Date().toISOString(), false)

    expect(summary.byCustomer.length).toBe(2)
  })
})
