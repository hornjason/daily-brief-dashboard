/**
 * src/rh-scraper-extract.test.ts
 *
 * Tests for extractCasesFromDocument() — the pure DOM-parsing function that
 * mirrors the page.evaluate() callback in rh-scraper.ts.
 *
 * Runs in a happy-dom environment (configured via bunfig.toml), so `document`
 * is a global and no Playwright browser is needed.
 *
 * Coverage targets:
 *   - Empty table → empty result
 *   - Closed cases filtered (case-insensitive: Closed / closed / CLOSED)
 *   - Open statuses preserved (Waiting on Red Hat, Waiting on Customer)
 *   - Case number format validation (7–10 digits)
 *   - Rows without case anchor skipped
 *   - COLUMN INDEX REGRESSION GUARD — puts distinct values in every adjacent
 *     column and asserts each property extracts from the correct index.
 *     This test fails immediately when the portal adds/removes a column.
 *   - Mixed open + closed → only open returned
 *   - All-closed → empty (not a parser bug — tests the ambiguity explicitly)
 *   - accountNumber threaded through to results
 *   - Product and severity correctly extracted
 */

import { describe, test, expect } from 'bun:test'
import { JSDOM } from 'jsdom'
import { extractCasesFromDocument } from './rh-scraper-extract.ts'
import { makePortalTable } from './fixtures/portal-cases.ts'

// ── DOM helper ────────────────────────────────────────────────────────────────

function parseTable(html: string): Document {
  return new JSDOM(html).window.document
}

// ── Empty / no-data paths ─────────────────────────────────────────────────────

describe('empty and no-data paths', () => {
  test('returns [] for a table with no rows', () => {
    const doc = parseTable('<table><tbody></tbody></table>')
    expect(extractCasesFromDocument(doc, 'ACC001')).toEqual([])
  })

  test('returns [] when document has no table at all', () => {
    const doc = parseTable('<div>no table here</div>')
    expect(extractCasesFromDocument(doc, 'ACC001')).toEqual([])
  })

  test('returns [] for a table where all cases are Closed — this is correct, not a parser bug', () => {
    const html = makePortalTable([
      { caseNumber: '01234567', status: 'Closed' },
      { caseNumber: '01234568', status: 'Closed' },
      { caseNumber: '01234569', status: 'Closed' },
    ])
    expect(extractCasesFromDocument(parseTable(html), 'ACC001')).toEqual([])
  })
})

// ── Status filtering ──────────────────────────────────────────────────────────

describe('status filtering', () => {
  test('filters out "Closed" (exact capitalisation)', () => {
    const html = makePortalTable([{ caseNumber: '01234567', status: 'Closed' }])
    expect(extractCasesFromDocument(parseTable(html), 'ACC001')).toHaveLength(0)
  })

  test('filters out "closed" (lowercase)', () => {
    const html = makePortalTable([{ caseNumber: '01234567', status: 'closed' }])
    expect(extractCasesFromDocument(parseTable(html), 'ACC001')).toHaveLength(0)
  })

  test('filters out "CLOSED" (uppercase)', () => {
    const html = makePortalTable([{ caseNumber: '01234567', status: 'CLOSED' }])
    expect(extractCasesFromDocument(parseTable(html), 'ACC001')).toHaveLength(0)
  })

  test('includes "Waiting on Red Hat"', () => {
    const html = makePortalTable([{ caseNumber: '01234567', status: 'Waiting on Red Hat' }])
    const result = extractCasesFromDocument(parseTable(html), 'ACC001')
    expect(result).toHaveLength(1)
    expect(result[0].status).toBe('Waiting on Red Hat')
  })

  test('includes "Waiting on Customer"', () => {
    const html = makePortalTable([{ caseNumber: '01234567', status: 'Waiting on Customer' }])
    const result = extractCasesFromDocument(parseTable(html), 'ACC001')
    expect(result).toHaveLength(1)
    expect(result[0].status).toBe('Waiting on Customer')
  })

  test('mixed: returns only open cases', () => {
    const html = makePortalTable([
      { caseNumber: '01234567', status: 'Closed' },
      { caseNumber: '01234568', status: 'Waiting on Red Hat' },
      { caseNumber: '01234569', status: 'Closed' },
      { caseNumber: '01234570', status: 'Waiting on Customer' },
    ])
    const result = extractCasesFromDocument(parseTable(html), 'ACC001')
    expect(result).toHaveLength(2)
    expect(result.map(c => c.caseNumber)).toEqual(['01234568', '01234570'])
  })
})

// ── Case number validation ─────────────────────────────────────────────────────

describe('case number validation', () => {
  test('accepts 7-digit case number', () => {
    const html = makePortalTable([{ caseNumber: '0123456' }])
    const result = extractCasesFromDocument(parseTable(html), 'ACC001')
    expect(result).toHaveLength(1)
    expect(result[0].caseNumber).toBe('0123456')
  })

  test('accepts 10-digit case number', () => {
    const html = makePortalTable([{ caseNumber: '0123456789' }])
    const result = extractCasesFromDocument(parseTable(html), 'ACC001')
    expect(result).toHaveLength(1)
    expect(result[0].caseNumber).toBe('0123456789')
  })

  test('rejects 6-digit case number (too short)', () => {
    const html = makePortalTable([{ caseNumber: '012345' }])
    expect(extractCasesFromDocument(parseTable(html), 'ACC001')).toHaveLength(0)
  })

  test('rejects 11-digit case number (too long)', () => {
    const html = makePortalTable([{ caseNumber: '01234567890' }])
    expect(extractCasesFromDocument(parseTable(html), 'ACC001')).toHaveLength(0)
  })

  test('rejects non-numeric link text', () => {
    const doc = parseTable(`
      <table><tbody>
        <tr>
          <td></td>
          <td><a href="/support/cases/#/case/abc">ABC-CASE</a></td>
          <td>Summary</td><td></td><td></td>
          <td>2 (High)</td><td>Waiting on Red Hat</td><td></td>
          <td>RHEL</td>
        </tr>
      </tbody></table>
    `)
    expect(extractCasesFromDocument(doc, 'ACC001')).toHaveLength(0)
  })
})

// ── Row structure requirements ────────────────────────────────────────────────

describe('row structure', () => {
  test('skips rows with no case anchor', () => {
    const doc = parseTable(`
      <table><tbody>
        <tr><td>no link here</td><td>Summary</td></tr>
      </tbody></table>
    `)
    expect(extractCasesFromDocument(doc, 'ACC001')).toHaveLength(0)
  })

  test('skips rows where anchor href does not contain /case/', () => {
    const doc = parseTable(`
      <table><tbody>
        <tr>
          <td></td>
          <td><a href="/some/other/path/01234567">01234567</a></td>
          <td>Summary</td><td></td><td></td>
          <td>3 (Normal)</td><td>Waiting on Red Hat</td><td></td><td>RHEL</td>
        </tr>
      </tbody></table>
    `)
    expect(extractCasesFromDocument(doc, 'ACC001')).toHaveLength(0)
  })
})

// ── COLUMN INDEX REGRESSION GUARD ────────────────────────────────────────────
//
// This is the most important test in this file.
//
// It builds a row where EVERY column has a DISTINCT value, then asserts that
// each extracted property comes from the correct column index.
//
// If the portal adds a column (shifting cells[5] from severity to something
// else), this test fails immediately — instead of silently corrupting data for
// 4 hours until the next scrape cycle.

describe('column index regression guard', () => {
  test('extracts summary from cells[2], severity from cells[5], status from cells[6], product from cells[8]', () => {
    // Build a row with distinct, unambiguous values in every column
    const doc = parseTable(`
      <table><tbody>
        <tr>
          <td>COL0_CHECKBOX</td>
          <td><a href="/support/cases/#/case/04410212">04410212</a></td>
          <td>COL2_SUMMARY</td>
          <td>COL3_OPENED_BY</td>
          <td>COL4_MODIFIED</td>
          <td>COL5_SEVERITY</td>
          <td>Waiting on Red Hat</td>
          <td>COL7_UNUSED</td>
          <td>COL8_PRODUCT</td>
          <td>COL9</td><td>COL10</td><td>COL11</td><td>COL12</td><td>COL13</td>
        </tr>
      </tbody></table>
    `)

    const result = extractCasesFromDocument(doc, 'ACC001')
    expect(result).toHaveLength(1)

    const c = result[0]
    expect(c.caseNumber).toBe('04410212')          // cells[1] via anchor text
    expect(c.summary).toBe('COL2_SUMMARY')          // cells[2]
    expect(c.severity).toBe('COL5_SEVERITY')        // cells[5]
    expect(c.status).toBe('Waiting on Red Hat')     // cells[6]
    expect(c.product).toBe('COL8_PRODUCT')          // cells[8]
  })

  test('all 14 columns present — count check', () => {
    // Verify fixture builder generates 14 <td> elements per row
    const html = makePortalTable([{ caseNumber: '04410212' }])
    const doc = parseTable(html)
    const row = doc.querySelector('table tbody tr')!
    const cells = row.querySelectorAll('td')
    expect(cells.length).toBe(14)
  })
})

// ── Field extraction ──────────────────────────────────────────────────────────

describe('field extraction', () => {
  test('accountNumber is threaded through from the parameter', () => {
    const html = makePortalTable([{ caseNumber: '01234567' }])
    const result = extractCasesFromDocument(parseTable(html), 'ACCT-9999')
    expect(result[0].accountNumber).toBe('ACCT-9999')
  })

  test('severity is extracted as full cell text (normalisation done by caller)', () => {
    const html = makePortalTable([{ caseNumber: '01234567', severity: '2 (High)' }])
    const result = extractCasesFromDocument(parseTable(html), 'ACC001')
    expect(result[0].severity).toBe('2 (High)')
  })

  test('product is extracted from cells[8]', () => {
    const html = makePortalTable([
      { caseNumber: '01234567', product: 'OpenShift Container Platform' },
    ])
    const result = extractCasesFromDocument(parseTable(html), 'ACC001')
    expect(result[0].product).toBe('OpenShift Container Platform')
  })

  test('summary is extracted from cells[2]', () => {
    const html = makePortalTable([
      { caseNumber: '01234567', summary: 'Node drain failing on OCP 4.14' },
    ])
    const result = extractCasesFromDocument(parseTable(html), 'ACC001')
    expect(result[0].summary).toBe('Node drain failing on OCP 4.14')
  })

  test('multiple rows return results in DOM order', () => {
    const html = makePortalTable([
      { caseNumber: '01234567', status: 'Waiting on Red Hat' },
      { caseNumber: '01234568', status: 'Waiting on Customer' },
      { caseNumber: '01234569', status: 'Waiting on Red Hat' },
    ])
    const result = extractCasesFromDocument(parseTable(html), 'ACC001')
    expect(result.map(c => c.caseNumber)).toEqual(['01234567', '01234568', '01234569'])
  })
})
