// test/unit/ccsp-row-filter.test.ts — Issue #15 Step 1
//
// Golden-file unit tests for the pure CCSP territory + quarter filter.
// Fixture: 60 rows = 3 territories × 5 quarters × 4 rows/territory-quarter.

import { test, expect, describe } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { filterRowsForAe } from '../../src/ccsp-row-filter.ts'
import { parseCsvToObjects } from '../../src/csv-parse.ts'

const FIXTURE_PATH = resolve(import.meta.dir, '../fixtures/ccsp-pod-sample.csv')

function loadFixture(): Record<string, string>[] {
  return parseCsvToObjects(readFileSync(FIXTURE_PATH, 'utf-8'))
}

describe('filterRowsForAe — golden-file fixture', () => {
  test('fixture sanity: 60 rows, expected territory + quarter columns', () => {
    const rows = loadFixture()
    expect(rows.length).toBe(60)
    expect(rows[0]).toHaveProperty('Account Territory Name')
    expect(rows[0]).toHaveProperty('Opportunity fiscal Year Quarter')
  })

  test('1) single territory, subset of quarters → correct row count', () => {
    const rows = loadFixture()
    // 1 territory × 2 quarters × 4 rows = 8
    const out = filterRowsForAe(
      rows,
      ['WEST_COMM_CORP_NORTHWEST_TERR01'],
      ['2025-Q2', '2025-Q3'],
    )
    expect(out.length).toBe(8)
    for (const r of out) {
      expect(r['Account Territory Name']).toBe('WEST_COMM_CORP_NORTHWEST_TERR01')
      expect(['2025-Q2', '2025-Q3']).toContain(r['Opportunity fiscal Year Quarter'])
    }
  })

  test('2) two territories, all quarters → combined row count', () => {
    const rows = loadFixture()
    // 2 territories × 5 quarters × 4 rows = 40
    const out = filterRowsForAe(
      rows,
      [
        'WEST_COMM_CORP_NORTHWEST_TERR01',
        'WEST_COMM_CORP_NORTHWEST_TERR02',
      ],
      ['2025-Q2', '2025-Q3', '2025-Q4', '2026-Q1', '2026-Q2'],
    )
    expect(out.length).toBe(40)
    const seenTerrs = new Set(out.map(r => r['Account Territory Name']))
    expect(seenTerrs.size).toBe(2)
  })

  test('3) validTerritories = [] → returns all input rows unchanged', () => {
    const rows = loadFixture()
    // With empty territories, territory filter is skipped. Quarter filter
    // still applies — pass all 5 quarters so every row matches and we get
    // all 60 back unchanged.
    const out = filterRowsForAe(
      rows,
      [],
      ['2025-Q2', '2025-Q3', '2025-Q4', '2026-Q1', '2026-Q2'],
    )
    expect(out.length).toBe(60)
    expect(out).toEqual(rows)
  })

  test('4) quarter column with different capitalization still filters', () => {
    // Mutate header: "Opportunity fiscal Year Quarter" → "Opportunity Fiscal Year Quarter"
    const csv = readFileSync(FIXTURE_PATH, 'utf-8').replace(
      'Opportunity fiscal Year Quarter',
      'Opportunity Fiscal Year Quarter',
    )
    const rows = parseCsvToObjects(csv)
    expect(rows[0]).toHaveProperty('Opportunity Fiscal Year Quarter')

    const out = filterRowsForAe(
      rows,
      ['WEST_COMM_CORP_NORTHWEST_TERR01'],
      ['2026-Q1'],
    )
    // 1 territory × 1 quarter × 4 rows = 4
    expect(out.length).toBe(4)
    for (const r of out) {
      expect(r['Opportunity Fiscal Year Quarter']).toBe('2026-Q1')
    }
  })

  test('5) territory column absent → returns all input rows unchanged', () => {
    // Strip both territory column variants from the header.
    const csv = readFileSync(FIXTURE_PATH, 'utf-8')
    const lines = csv.split('\n')
    // Drop the second column ("Account Territory Name") from header and every data row.
    const stripped = lines
      .filter(l => l.length > 0)
      .map(l => {
        const cols = l.split(',')
        cols.splice(1, 1)
        return cols.join(',')
      })
      .join('\n')
    const rows = parseCsvToObjects(stripped)
    expect(rows[0]).not.toHaveProperty('Account Territory Name')
    expect(rows[0]).not.toHaveProperty('Account Territory')

    const out = filterRowsForAe(
      rows,
      ['WEST_COMM_CORP_NORTHWEST_TERR01'],
      ['2025-Q2', '2025-Q3', '2025-Q4', '2026-Q1', '2026-Q2'],
    )
    // No territory column → return input unchanged. Quarter filter must NOT be
    // applied either (the brief specifies "returns all input rows unchanged"
    // when the territory column is absent).
    expect(out.length).toBe(rows.length)
    expect(out).toEqual(rows)
  })
})
