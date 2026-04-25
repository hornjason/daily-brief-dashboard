import { describe, expect, test } from 'bun:test'
import { parsePipelineRows, buildPipelineSummary } from './pipeline.ts'

const HEADERS = [
  'Opportunity Number',
  'Account Name',
  'Opportunity Name',
  'ACV Opportunity',
  'Close Date',
  'Forecast Category',
  'Opportunity Owner',
  'Renewal',
  'Offering Group',
  'Probability (%)',
  'Product Description',
]

function makeRow(overrides: Partial<Record<(typeof HEADERS)[number], any>> = {}): any[] {
  const defaults: Record<string, any> = {
    'Opportunity Number': 'OPP-001',
    'Account Name': 'Acme Corp',
    'Opportunity Name': 'Acme Deal 2026',
    'ACV Opportunity': 50000,
    'Close Date': '2026-06-30',
    'Forecast Category': 'Commit',
    'Opportunity Owner': 'Alice Smith',
    'Renewal': '1',
    'Offering Group': 'RHEL',
    'Probability (%)': 90,
    'Product Description': 'RHEL Server',
  }
  const merged = { ...defaults, ...overrides }
  return HEADERS.map((h) => merged[h] ?? '')
}

describe('parsePipelineRows', () => {
  test('returns empty array for fewer than 2 rows', () => {
    expect(parsePipelineRows([])).toEqual([])
    expect(parsePipelineRows([HEADERS])).toEqual([])
  })

  test('parses a single data row correctly', () => {
    const rows = [HEADERS, makeRow()]
    const result = parsePipelineRows(rows)
    expect(result).toHaveLength(1)
    expect(result[0].oppNumber).toBe('OPP-001')
    expect(result[0].accountName).toBe('Acme Corp')
    expect(result[0].acv).toBe(50000)
    expect(result[0].forecastCategory).toBe('Commit')
    expect(result[0].renewal).toBe(true)
  })

  test('deduplicates rows with the same opportunity number', () => {
    const rows = [
      HEADERS,
      makeRow({ 'Opportunity Number': 'OPP-001', 'Product Description': 'RHEL Server' }),
      makeRow({ 'Opportunity Number': 'OPP-001', 'Product Description': 'RHEL Workstation' }),
      makeRow({ 'Opportunity Number': 'OPP-002', 'Account Name': 'Globex' }),
    ]
    const result = parsePipelineRows(rows)
    expect(result).toHaveLength(2)
    // Products from both rows collected on OPP-001
    const opp1 = result.find(r => r.oppNumber === 'OPP-001')
    expect(opp1?.products).toContain('RHEL Server')
    expect(opp1?.products).toContain('RHEL Workstation')
  })

  test('coerces renewal values correctly', () => {
    const rows = [HEADERS, makeRow({ 'Renewal': 1 })]
    expect(parsePipelineRows(rows)[0].renewal).toBe(true)

    const rows2 = [HEADERS, makeRow({ 'Renewal': '0' })]
    expect(parsePipelineRows(rows2)[0].renewal).toBe(false)
  })

  test('parses SF "feature included"/"feature not included" renewal strings', () => {
    const yes = [HEADERS, makeRow({ 'Renewal': 'feature included' })]
    expect(parsePipelineRows(yes)[0].renewal).toBe(true)

    const no = [HEADERS, makeRow({ 'Renewal': 'feature not included' })]
    expect(parsePipelineRows(no)[0].renewal).toBe(false)
  })

  test('parses ACV with currency prefix and commas (SF format)', () => {
    const rows = [HEADERS, makeRow({ 'ACV Opportunity': 'USD 1,050,000.00' })]
    expect(parsePipelineRows(rows)[0].acv).toBe(1_050_000)
  })

  test('skips fully empty rows', () => {
    const emptyRow = HEADERS.map(() => '')
    const rows = [HEADERS, makeRow(), emptyRow, makeRow({ 'Opportunity Number': 'OPP-002' })]
    const result = parsePipelineRows(rows)
    expect(result).toHaveLength(2)
  })
})

describe('buildPipelineSummary', () => {
  const records = [
    {
      oppNumber: 'OPP-001', accountName: 'Acme', oppName: 'Acme Commit',
      acv: 100_000, closeDate: '2026-06-30', forecastCategory: 'Commit',
      owner: 'Alice', renewal: false, offeringGroup: 'RHEL', probability: 90, products: [],
    },
    {
      oppNumber: 'OPP-002', accountName: 'Globex', oppName: 'Globex BC',
      acv: 50_000, closeDate: '2026-09-30', forecastCategory: 'Best Case',
      owner: 'Bob', renewal: true, offeringGroup: 'OCP', probability: 60, products: [],
    },
    {
      oppNumber: 'OPP-003', accountName: 'Initech', oppName: 'Initech Commit',
      acv: 25_000, closeDate: '2026-03-31', forecastCategory: 'Commit',
      owner: 'Alice', renewal: false, offeringGroup: 'AAP', probability: 95, products: [],
    },
  ]

  test('groups ACV correctly by forecast stage', () => {
    const summary = buildPipelineSummary(records, null)
    const commitStage = summary.byStage.find((s: any) => s.stage === 'Commit')
    expect(commitStage?.acv).toBe(125_000)  // OPP-001 + OPP-003
    const bcStage = summary.byStage.find((s: any) => s.stage === 'Best Case')
    expect(bcStage?.acv).toBe(50_000)
  })

  test('returns totals across all records', () => {
    const summary = buildPipelineSummary(records, null)
    expect(summary.totalAcv).toBe(175_000)
    expect(summary.openCount).toBe(3)
  })

  test('openCount and totalAcv exclude closed records', () => {
    const withClosed = [
      ...records,
      {
        oppNumber: 'OPP-004', accountName: 'Closed Co', oppName: 'Closed Deal',
        acv: 999_000, closeDate: '2026-01-31', forecastCategory: 'Closed',
        owner: 'Alice', renewal: false, offeringGroup: 'RHEL', probability: 0, products: [],
      },
    ]
    const summary = buildPipelineSummary(withClosed, null)
    expect(summary.openCount).toBe(3)        // closed opp excluded
    expect(summary.totalAcv).toBe(175_000)   // closed ACV excluded
  })

  test('surfaces top opportunities sorted by ACV descending', () => {
    const summary = buildPipelineSummary(records, null)
    expect(summary.topOpps[0].acv).toBeGreaterThanOrEqual(summary.topOpps[1]?.acv ?? 0)
  })
})
