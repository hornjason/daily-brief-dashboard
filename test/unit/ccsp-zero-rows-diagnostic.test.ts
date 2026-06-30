// REG-CCSP-ZERO-ROWS-01: Regression test for misleading error message when zero rows.
//
// Issue #923: When CCSP scrape returns zero rows, the code path should produce
// a clear diagnostic message "CCSP scrape returned 0 rows — verify Tableau
// authentication and data availability" instead of showing column validation
// errors with empty arrays.
//
// This test verifies:
// 1. Zero-row diagnostic message appears
// 2. Column validation is skipped (no misleading "missing required columns" message)

import { test, expect, describe } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '../..')
const CCSP_SCRAPER_TS = readFileSync(resolve(ROOT, 'src/ccsp-scraper.ts'), 'utf-8')

describe('REG-CCSP-ZERO-ROWS-01 — Zero rows produce clear diagnostic', () => {
  test('Zero-row diagnostic message exists in code', () => {
    expect(CCSP_SCRAPER_TS).toContain('CCSP scrape returned 0 rows')
    expect(CCSP_SCRAPER_TS).toContain('verify Tableau authentication and data availability')
  })

  test('Zero-row diagnostic appears BEFORE placeholder write', () => {
    // The diagnostic log should come before the "No CCSP data available" placeholder
    const diagnosticIdx = CCSP_SCRAPER_TS.indexOf('CCSP scrape returned 0 rows')
    const placeholderIdx = CCSP_SCRAPER_TS.indexOf('No CCSP data available')
    expect(diagnosticIdx).toBeGreaterThan(-1)
    expect(placeholderIdx).toBeGreaterThan(-1)
    expect(diagnosticIdx).toBeLessThan(placeholderIdx)
  })

  test('BKL-M51 column validation wrapped in guard checking allRows.length > 0', () => {
    // Find the BKL-M51 validation block
    const bklIdx = CCSP_SCRAPER_TS.indexOf('BKL-M51')
    expect(bklIdx).toBeGreaterThan(-1)

    // Extract ~500 chars after BKL-M51 comment to capture the validation logic
    const slice = CCSP_SCRAPER_TS.slice(bklIdx, bklIdx + 500)

    // Should have the guard condition before hasAccountCol check
    expect(slice).toMatch(/if\s*\(\s*allRows\.length\s*>\s*0\s*\)/)
  })

  test('Column validation guard prevents execution when allRows is empty', () => {
    // The "missing required columns" message should only appear inside the guarded block
    const missingColIdx = CCSP_SCRAPER_TS.indexOf('missing required columns')
    expect(missingColIdx).toBeGreaterThan(-1)

    // Find the nearest guard before this message
    const beforeMissing = CCSP_SCRAPER_TS.slice(0, missingColIdx)
    const lastGuard = beforeMissing.lastIndexOf('if (allRows.length > 0)')

    // Verify the guard exists and comes before the validation
    expect(lastGuard).toBeGreaterThan(-1)
    expect(lastGuard).toBeLessThan(missingColIdx)
  })
})
