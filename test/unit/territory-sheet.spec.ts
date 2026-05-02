import { describe, test, expect } from 'bun:test'
import { podKeyFromTerritoryCode } from '../../src/bootstrap/territory-sheet.ts'
import { synthesizeSfReportFromPipelineRecords } from '../../src/bootstrap/territory-sheet.ts'

describe('podKeyFromTerritoryCode', () => {
  test('East territory code normalizes to pod key', () => {
    expect(podKeyFromTerritoryCode('East_Comm_Corp_Pod1_Terr01')).toBe('EAST_COMM_CORP_POD01')
  })
  test('bare territory code returns empty string', () => {
    expect(podKeyFromTerritoryCode('')).toBe('')
  })
})

describe('synthesizeSfReportFromPipelineRecords', () => {
  test('single record with one product returns correct headers and row', () => {
    const records = [{
      oppId: 'OPP001', oppNumber: 'OP-001', oppName: 'Test Opp', accountName: 'Acme',
      closeDate: '2026-06-30', forecastCategory: 'Commit', acv: 50000, owner: 'Jason',
      renewal: false, offeringGroup: 'RHEL', probability: 75, products: ['RHEL Server'],
      territory: 'East_Comm_Corp_Pod1_Terr01'
    }] as any
    const result = synthesizeSfReportFromPipelineRecords(records)
    expect(result.headers).toContain('Opportunity ID')
    expect(result.rows).toHaveLength(1)
    expect(result.rows[0][0]).toBe('OPP001')
    expect(result.rows[0][11]).toBe('RHEL Server')
  })
  test('record with empty products array emits one row with empty product cell', () => {
    const records = [{
      oppId: 'OPP002', oppNumber: 'OP-002', oppName: 'Empty', accountName: 'Foo',
      closeDate: '2026-07-01', forecastCategory: 'Pipeline', acv: 0, owner: 'Jane',
      renewal: true, offeringGroup: 'ANS', probability: 10, products: [],
      territory: ''
    }] as any
    const result = synthesizeSfReportFromPipelineRecords(records)
    expect(result.rows).toHaveLength(1)
    expect(result.rows[0][11]).toBe('')
  })
})
