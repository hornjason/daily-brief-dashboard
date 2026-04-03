/**
 * src/csv-parse.ts
 *
 * Shared CSV parsing utilities used by multiple scrapers.
 *
 * WHY THIS FILE EXISTS:
 * supportable-scraper.ts, sf-scraper.ts, and ccsp-scraper.ts all contained
 * near-identical copies of splitCsvLines and parseCsvRow. This module is the
 * single canonical implementation — extracted so contract tests can cover the
 * shared logic once, and scrapers import from here instead of duplicating code.
 *
 * IMPLEMENTATIONS:
 *   splitCsvLines  — supports RFC 4180 multiline quoted fields AND \r\n endings.
 *                    Uses the supportable-scraper version (handles both \r\n and
 *                    embedded newlines inside quotes correctly).
 *   parseCsvRow    — RFC 4180 field parsing with "" escaped-quote support.
 *   parseCsvToObjects — full CSV → Record<string,string>[] with BOM stripping.
 *   parseCsvToSfReport — SF-specific format: { headers, rows } with footer filtering.
 */

/**
 * Split CSV text into logical lines, keeping quoted fields that contain
 * embedded newlines intact (RFC 4180 multi-line field support).
 * Also handles \r\n line endings correctly.
 */
export function splitCsvLines(text: string): string[] {
  const lines: string[] = []
  let current = ''
  let inQuotes = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch === '"') { inQuotes = !inQuotes; current += ch }
    else if ((ch === '\n' || ch === '\r') && !inQuotes) {
      if (ch === '\r' && text[i + 1] === '\n') i++
      if (current.trim()) lines.push(current)
      current = ''
    } else { current += ch }
  }
  if (current.trim()) lines.push(current)
  return lines
}

/** Parse one CSV line into field values, handling double-quoted fields and escaped quotes (""). */
export function parseCsvRow(line: string): string[] {
  const fields: string[] = []
  let current = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { current += '"'; i++ } else { inQuotes = false }
      } else { current += ch }
    } else {
      if (ch === '"') { inQuotes = true }
      else if (ch === ',') { fields.push(current.trim()); current = '' }
      else { current += ch }
    }
  }
  fields.push(current.trim())
  return fields
}

/** Parse full CSV text into an array of objects keyed by the header row values. */
export function parseCsvToObjects(text: string): Record<string, string>[] {
  // Strip UTF-8 BOM that Oracle APEX sometimes prepends — without this the first
  // header becomes "\uFEFFName" instead of "Name", breaking all column lookups.
  const clean = text.startsWith('\uFEFF') ? text.slice(1) : text
  const lines = splitCsvLines(clean)
  if (lines.length < 2) return []
  const headers = parseCsvRow(lines[0])
  const rows: Record<string, string>[] = []
  for (let i = 1; i < lines.length; i++) {
    const cells = parseCsvRow(lines[i])
    if (cells.length === 0 || cells.every(c => !c.trim())) continue
    const obj: Record<string, string> = {}
    headers.forEach((h, idx) => { obj[h] = cells[idx] ?? '' })
    rows.push(obj)
  }
  return rows
}

/** Parse full CSV text into { headers, rows } matching SfReportRow shape. */
export function parseCsvToSfReport(text: string): { headers: string[]; rows: string[][] } {
  // Strip UTF-8 BOM
  const clean = text.startsWith('\uFEFF') ? text.slice(1) : text
  const lines = splitCsvLines(clean)
  if (lines.length === 0) return { headers: [], rows: [] }

  const headers = parseCsvRow(lines[0])
  const rows: string[][] = []
  for (let i = 1; i < lines.length; i++) {
    const row = parseCsvRow(lines[i])
    // Skip empty rows and SF summary/footer rows (fewer fields than headers)
    if (row.length >= headers.length - 1 && row.some(c => c.length > 0)) {
      // Pad short rows to match header length
      while (row.length < headers.length) row.push('')
      rows.push(row)
    }
  }
  return { headers, rows }
}
