/**
 * src/supportable-extract.test.ts
 *
 * Contract tests for the supportable HTML parser and name-matching utilities
 * extracted from supportable-scraper.ts into supportable-extract.ts.
 *
 * These tests run without Playwright or a live browser — they work only with
 * raw HTML strings and pure functions.
 *
 * Coverage:
 *   - parseHtmlTable: valid subscription table, too few matching columns,
 *     empty HTML, multiple tables (picks best match)
 *   - stripLegalSuffix: common legal suffixes removed, no suffix unchanged
 *   - buildNameCandidates: full legal name, already stripped, abbreviation
 *     dots ("U.S." → "US"), progressive word stripping
 */

import { describe, test, expect } from 'bun:test'
import { parseHtmlTable, stripLegalSuffix, buildNameCandidates, SUBSCRIPTION_COLUMN_PATTERNS } from './supportable-extract.ts'
import { makeSupportableTable } from './fixtures/supportable-table.ts'

// ── parseHtmlTable ────────────────────────────────────────────────────────────

describe('parseHtmlTable', () => {
  test('extracts rows from a valid subscription table', () => {
    const html = makeSupportableTable([
      { sku: 'MCT1234', status: 'Active', customerNumber: 'CUST001' },
      { sku: 'MCT5678', status: 'Expired', customerNumber: 'CUST002' },
    ])
    const rows = parseHtmlTable(html)
    expect(rows).toHaveLength(2)
    expect(rows[0]['SKU']).toBe('MCT1234')
    expect(rows[0]['Status']).toBe('Active')
    expect(rows[0]['Customer Number']).toBe('CUST001')
    expect(rows[1]['SKU']).toBe('MCT5678')
  })

  test('returns [] for empty HTML', () => {
    expect(parseHtmlTable('')).toEqual([])
    expect(parseHtmlTable('<div>no table here</div>')).toEqual([])
  })

  test('returns [] when table has fewer than 3 matching column patterns', () => {
    // Table with only 2 subscription columns — should not be identified
    const html = `
      <table>
        <thead><tr><th>SKU</th><th>Status</th><th>Irrelevant</th></tr></thead>
        <tbody><tr><td>MCT1234</td><td>Active</td><td>foo</td></tr></tbody>
      </table>
    `
    const rows = parseHtmlTable(html)
    expect(rows).toEqual([])
  })

  test('picks the table with the most matching subscription column patterns', () => {
    // First table: only 2 subscription columns
    // Second table: all 10 subscription columns
    const html = `
      <table>
        <thead><tr><th>SKU</th><th>Status</th><th>Color</th></tr></thead>
        <tbody><tr><td>WRONG</td><td>WRONG</td><td>red</td></tr></tbody>
      </table>
      ${makeSupportableTable([{ sku: 'MCT9999', status: 'Active' }])}
    `
    const rows = parseHtmlTable(html)
    expect(rows).toHaveLength(1)
    expect(rows[0]['SKU']).toBe('MCT9999')
  })

  test('skips rows where all cells are empty', () => {
    const html = `
      <table>
        <thead><tr>
          <th>SKU</th><th>Ordered Item</th><th>Product Description</th>
          <th>Quantity</th><th>Status</th><th>Start Date</th>
          <th>End Date</th><th>Contract</th><th>Customer Number</th><th>Account Number</th>
        </tr></thead>
        <tbody>
          <tr><td></td><td></td><td></td><td></td><td></td><td></td><td></td><td></td><td></td><td></td></tr>
          <tr><td>MCT1234</td><td>RHEL</td><td>Server</td><td>10</td><td>Active</td><td>2025-01-01</td><td>2026-01-01</td><td>12345</td><td>CUST001</td><td>ACC001</td></tr>
        </tbody>
      </table>
    `
    const rows = parseHtmlTable(html)
    expect(rows).toHaveLength(1)
    expect(rows[0]['SKU']).toBe('MCT1234')
  })

  test('maps cells to header keys correctly', () => {
    const html = makeSupportableTable([{
      sku: 'SKU-X',
      orderedItem: 'OI-X',
      productDescription: 'PD-X',
      quantity: '5',
      status: 'Active',
      startDate: '2025-06-01',
      endDate: '2026-06-01',
      contract: 'C-X',
      customerNumber: 'CN-X',
      accountNumber: 'AN-X',
    }])
    const rows = parseHtmlTable(html)
    expect(rows).toHaveLength(1)
    const r = rows[0]
    expect(r['SKU']).toBe('SKU-X')
    expect(r['Ordered Item']).toBe('OI-X')
    expect(r['Product Description']).toBe('PD-X')
    expect(r['Quantity']).toBe('5')
    expect(r['Contract']).toBe('C-X')
    expect(r['Account Number']).toBe('AN-X')
  })

  test('SUBSCRIPTION_COLUMN_PATTERNS has 11 patterns', () => {
    // Regression: do not silently reduce the pattern list
    expect(SUBSCRIPTION_COLUMN_PATTERNS).toHaveLength(11)
  })
})

// ── stripLegalSuffix ──────────────────────────────────────────────────────────

describe('stripLegalSuffix', () => {
  test('"Foo, Inc." → "Foo"', () => {
    expect(stripLegalSuffix('Foo, Inc.')).toBe('Foo')
  })

  test('"Bar LLC" → "Bar"', () => {
    expect(stripLegalSuffix('Bar LLC')).toBe('Bar')
  })

  test('"Baz Corp." → "Baz"', () => {
    expect(stripLegalSuffix('Baz Corp.')).toBe('Baz')
  })

  test('"Acme Ltd." → "Acme"', () => {
    expect(stripLegalSuffix('Acme Ltd.')).toBe('Acme')
  })

  test('"Widgets Incorporated" → "Widgets"', () => {
    expect(stripLegalSuffix('Widgets Incorporated')).toBe('Widgets')
  })

  test('"Global Limited" → "Global"', () => {
    expect(stripLegalSuffix('Global Limited')).toBe('Global')
  })

  test('no suffix returns name unchanged', () => {
    expect(stripLegalSuffix('Bespin Global')).toBe('Bespin Global')
    expect(stripLegalSuffix('Red Hat')).toBe('Red Hat')
  })

  test('trims trailing whitespace', () => {
    expect(stripLegalSuffix('Foo Inc.  ')).toBe('Foo')
  })
})

// ── buildNameCandidates ───────────────────────────────────────────────────────

describe('buildNameCandidates', () => {
  test('strips legal suffix from customer name', () => {
    const candidates = buildNameCandidates('Acme, Inc.')
    expect(candidates).toContain('Acme')
  })

  test('already-stripped name produces itself as candidate', () => {
    const candidates = buildNameCandidates('Red Hat')
    expect(candidates[0]).toBe('Red Hat')
  })

  test('abbreviation dots "U.S." → "US"', () => {
    const candidates = buildNameCandidates('Bespin Global U.S.')
    // The normalized form with dots stripped should be first
    expect(candidates[0]).toBe('Bespin Global US')
  })

  test('progressive word stripping removes one word at a time from right', () => {
    const candidates = buildNameCandidates('Intrado Life Safety')
    // Should contain progressively shorter forms
    expect(candidates).toContain('Intrado Life')
    expect(candidates).toContain('Intrado')
  })

  test('does not include candidates shorter than 4 characters', () => {
    const candidates = buildNameCandidates('Foo Bar Baz')
    // "Foo" is 3 chars — should not appear
    expect(candidates).not.toContain('Foo')
    // "Foo Bar" is fine
    expect(candidates).toContain('Foo Bar')
  })

  test('supportableName override uses override as base instead of customerName', () => {
    const candidates = buildNameCandidates('Acme, Inc.', 'Acme Incorporated')
    // When override is given, the override name is used as base (not stripped from customerName)
    expect(candidates[0]).toBe('Acme Incorporated')
    // Progressive stripping generates "Acme" from "Acme Incorporated" — that is correct
    expect(candidates).toContain('Acme')
    // The override-derived base (not the customerName) should be the first candidate
    expect(candidates.indexOf('Acme Incorporated')).toBe(0)
  })

  test('deduplicates identical candidates', () => {
    // A name that normalizes to the same string after suffix stripping
    const candidates = buildNameCandidates('GlobalTech')
    const seen = new Set(candidates)
    expect(candidates.length).toBe(seen.size)
  })

  test('multi-word name with abbreviation dots produces progressive fallbacks', () => {
    const candidates = buildNameCandidates('Omnivision Technologies')
    // "Omnivision Technologies" → after strip → "Omnivision Technologies"
    // then progressive: "Omnivision"
    expect(candidates).toContain('Omnivision')
  })
})
