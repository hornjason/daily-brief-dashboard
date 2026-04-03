/**
 * src/csv-parse.test.ts
 *
 * Contract tests for the shared CSV parsing utilities in csv-parse.ts.
 *
 * These tests verify the canonical implementation used by supportable-scraper,
 * sf-scraper, and ccsp-scraper. Any change to csv-parse.ts that breaks these
 * tests will break all three scrapers simultaneously.
 *
 * Coverage:
 *   - splitCsvLines: simple lines, RFC 4180 multiline, \r\n endings, empty input
 *   - parseCsvRow: simple, quoted with commas, escaped quotes, empty fields, trailing comma
 *   - parseCsvToObjects: happy path, BOM-prefixed CSV, empty rows filtered, short rows
 *   - parseCsvToSfReport: header extraction, footer row filtering
 *   - REGRESSION GUARDS: multiline quoted fields, UTF-8 BOM stripping
 */

import { describe, test, expect } from 'bun:test'
import { splitCsvLines, parseCsvRow, parseCsvToObjects, parseCsvToSfReport } from './csv-parse.ts'

// ── splitCsvLines ─────────────────────────────────────────────────────────────

describe('splitCsvLines', () => {
  test('splits simple newline-delimited lines', () => {
    const result = splitCsvLines('a,b,c\n1,2,3\n4,5,6')
    expect(result).toEqual(['a,b,c', '1,2,3', '4,5,6'])
  })

  test('handles \\r\\n line endings', () => {
    const result = splitCsvLines('Name,Value\r\nFoo,1\r\nBar,2')
    expect(result).toEqual(['Name,Value', 'Foo,1', 'Bar,2'])
  })

  test('keeps quoted fields with embedded newlines intact (RFC 4180)', () => {
    const csv = 'Name,Desc\n"Foo","Line 1\nLine 2"\n"Bar","Simple"'
    const result = splitCsvLines(csv)
    expect(result).toHaveLength(3)
    expect(result[1]).toBe('"Foo","Line 1\nLine 2"')
    expect(result[2]).toBe('"Bar","Simple"')
  })

  test('skips blank lines', () => {
    const result = splitCsvLines('a,b\n\nc,d\n\n')
    expect(result).toEqual(['a,b', 'c,d'])
  })

  test('returns empty array for empty input', () => {
    expect(splitCsvLines('')).toEqual([])
  })

  test('returns single line with no newlines', () => {
    expect(splitCsvLines('only,one,line')).toEqual(['only,one,line'])
  })
})

// ── parseCsvRow ───────────────────────────────────────────────────────────────

describe('parseCsvRow', () => {
  test('splits simple unquoted fields', () => {
    expect(parseCsvRow('a,b,c')).toEqual(['a', 'b', 'c'])
  })

  test('handles quoted field containing a comma', () => {
    expect(parseCsvRow('"Acme, Inc.",foo,bar')).toEqual(['Acme, Inc.', 'foo', 'bar'])
  })

  test('handles escaped double-quote inside quoted field', () => {
    expect(parseCsvRow('"He said ""hello""",next')).toEqual(['He said "hello"', 'next'])
  })

  test('empty field between commas', () => {
    expect(parseCsvRow('a,,c')).toEqual(['a', '', 'c'])
  })

  test('trailing comma produces empty last field', () => {
    expect(parseCsvRow('a,b,')).toEqual(['a', 'b', ''])
  })

  test('single field with no commas', () => {
    expect(parseCsvRow('hello')).toEqual(['hello'])
  })

  test('trims whitespace from unquoted fields', () => {
    expect(parseCsvRow(' a , b , c ')).toEqual(['a', 'b', 'c'])
  })
})

// ── parseCsvToObjects ─────────────────────────────────────────────────────────

describe('parseCsvToObjects', () => {
  test('happy path: header row + data rows', () => {
    const csv = 'Name,Value\nFoo,1\nBar,2'
    const rows = parseCsvToObjects(csv)
    expect(rows).toHaveLength(2)
    expect(rows[0]).toEqual({ Name: 'Foo', Value: '1' })
    expect(rows[1]).toEqual({ Name: 'Bar', Value: '2' })
  })

  test('strips UTF-8 BOM from first header', () => {
    const csv = '\uFEFFName,Value\nFoo,1'
    const rows = parseCsvToObjects(csv)
    expect(Object.keys(rows[0])[0]).toBe('Name')
  })

  test('skips entirely empty rows', () => {
    const csv = 'Name,Value\nFoo,1\n   \nBar,2'
    const rows = parseCsvToObjects(csv)
    expect(rows).toHaveLength(2)
  })

  test('skips rows where all cells are empty strings', () => {
    const csv = 'Name,Value\n,\nFoo,1'
    const rows = parseCsvToObjects(csv)
    expect(rows).toHaveLength(1)
    expect(rows[0].Name).toBe('Foo')
  })

  test('pads missing cells to empty string when row is shorter than headers', () => {
    const csv = 'A,B,C\n1,2'
    const rows = parseCsvToObjects(csv)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toEqual({ A: '1', B: '2', C: '' })
  })

  test('returns empty array when input has fewer than 2 lines', () => {
    expect(parseCsvToObjects('')).toEqual([])
    expect(parseCsvToObjects('Name,Value')).toEqual([])
  })

  test('handles quoted fields with embedded commas', () => {
    const csv = 'Name,Address\n"Smith, John","123 Main St"'
    const rows = parseCsvToObjects(csv)
    expect(rows[0].Name).toBe('Smith, John')
    expect(rows[0].Address).toBe('123 Main St')
  })
})

// ── parseCsvToSfReport ────────────────────────────────────────────────────────

describe('parseCsvToSfReport', () => {
  test('extracts headers from first line', () => {
    const csv = 'Opportunity,Stage,Amount\nDeal A,Closed Won,10000\nDeal B,Prospecting,5000'
    const { headers } = parseCsvToSfReport(csv)
    expect(headers).toEqual(['Opportunity', 'Stage', 'Amount'])
  })

  test('extracts data rows', () => {
    const csv = 'Name,Value\nFoo,1\nBar,2'
    const { rows } = parseCsvToSfReport(csv)
    expect(rows).toHaveLength(2)
    expect(rows[0]).toEqual(['Foo', '1'])
    expect(rows[1]).toEqual(['Bar', '2'])
  })

  test('filters footer rows with fewer fields than headers', () => {
    // SF reports often have a "Total" summary row with only 1-2 fields
    const csv = 'Name,Value,Extra\nFoo,1,a\nTotal'
    const { headers, rows } = parseCsvToSfReport(csv)
    expect(headers).toHaveLength(3)
    // "Total" row has only 1 field — 2 fewer than headers (threshold is headers.length - 1 = 2)
    expect(rows).toHaveLength(1)
    expect(rows[0][0]).toBe('Foo')
  })

  test('pads short rows to match header length', () => {
    // Row with exactly headers.length - 1 fields should be kept and padded
    const csv = 'A,B,C\n1,2'
    const { headers, rows } = parseCsvToSfReport(csv)
    expect(headers).toHaveLength(3)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toEqual(['1', '2', ''])
  })

  test('returns empty result for empty input', () => {
    expect(parseCsvToSfReport('')).toEqual({ headers: [], rows: [] })
  })

  test('strips UTF-8 BOM from first header in SF report', () => {
    const csv = '\uFEFFName,Value\nFoo,1'
    const { headers } = parseCsvToSfReport(csv)
    expect(headers[0]).toBe('Name')
  })

  test('skips rows that are entirely empty', () => {
    const csv = 'Name,Value\nFoo,1\n,\nBar,2'
    const { rows } = parseCsvToSfReport(csv)
    // Both data rows have enough fields; empty row (,) has 2 fields matching headers count
    // but all cells are empty — row.some(c => c.length > 0) filters it
    expect(rows.every(r => r.some(c => c.length > 0))).toBe(true)
  })
})

// ── REGRESSION GUARDS ─────────────────────────────────────────────────────────
//
// These tests protect against the most common real-world failure modes.
// If either fails after a change to csv-parse.ts, you have introduced a
// regression that will corrupt APEX/Salesforce data in production.

describe('regression guards', () => {
  test('RFC 4180: quoted field with embedded newline', () => {
    const csv = 'Name,Desc\n"Foo","Line 1\nLine 2"\n"Bar","Simple"'
    const rows = parseCsvToObjects(csv)
    expect(rows).toHaveLength(2)
    expect(rows[0].Desc).toBe('Line 1\nLine 2')
  })

  test('UTF-8 BOM is stripped from first header', () => {
    const csv = '\uFEFFName,Value\nFoo,1'
    const rows = parseCsvToObjects(csv)
    expect(Object.keys(rows[0])[0]).toBe('Name')  // not \uFEFFName
  })

  test('\\r\\n line endings do not corrupt field values', () => {
    const csv = 'SKU,Status\r\nRH00001,Active\r\nRH00002,Expired'
    const rows = parseCsvToObjects(csv)
    expect(rows).toHaveLength(2)
    // Ensure \r did not get appended to a value
    expect(rows[0].SKU).toBe('RH00001')
    expect(rows[0].Status).toBe('Active')
  })

  test('double-quoted comma in APEX subscription field does not split column', () => {
    // Typical APEX export: "Acme, Inc." appears in Customer Name column
    const csv = 'Customer,SKU\n"Acme, Inc.",RH-00001'
    const rows = parseCsvToObjects(csv)
    expect(rows).toHaveLength(1)
    expect(rows[0].Customer).toBe('Acme, Inc.')
    expect(rows[0].SKU).toBe('RH-00001')
  })
})
