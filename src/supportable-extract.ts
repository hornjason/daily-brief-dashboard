/**
 * src/supportable-extract.ts
 *
 * Pure parsing logic extracted from supportable-scraper.ts.
 *
 * WHY THIS FILE EXISTS:
 * The HTML table parser (parseHtmlTable) and name-matching utilities
 * (stripLegalSuffix, buildNameCandidates) are pure functions with no Playwright
 * dependencies. Extracting them here allows contract tests to run without a
 * live browser session, and makes the scraper logic testable in isolation.
 *
 * SYNC CONTRACT:
 * When modifying parseHtmlTable, SUBSCRIPTION_COLUMN_PATTERNS, stripLegalSuffix,
 * or buildNameCandidates in supportable-scraper.ts, update this file too.
 * These exports are the testable mirror of the scraper's internal functions.
 */

// ── APEX table column identification ─────────────────────────────────────────

/**
 * Regex-based column patterns that identify the subscription data table.
 * At least 3 must match the table's header row for it to be the target table.
 */
export const SUBSCRIPTION_COLUMN_PATTERNS = [
  /\bsku\b/i,
  /\bordered\s*item\b/i,
  /\bproduct\s*description\b/i,
  /\bquantity\b/i,
  /\bstatus\b/i,
  /\bstart\s*date\b/i,
  /\bend\s*date\b/i,
  /\bcontract/i,
  /\bcustomer\s*number\b/i,
  /\baccount\s*number\b/i,
  /\binternal\s*sku\b/i,
]

// ── HTML table parser ─────────────────────────────────────────────────────────

/**
 * Parse subscription data from raw HTML string using regex.
 * Finds the APEX Interactive Report table by matching column headers,
 * then extracts rows into Record<string, string>[] — same format as parseCsvToObjects.
 *
 * This avoids all DOM interaction (no clicks, no element attachment),
 * making it safe for parallel page scraping.
 */
export function parseHtmlTable(html: string): Record<string, string>[] {
  // Find all <table ...>...</table> blocks
  const tableRegex = /<table[^>]*>([\s\S]*?)<\/table>/gi
  let bestHeaders: string[] = []
  let bestBodyHtml = ''
  let bestMatchCount = 0

  let tableMatch: RegExpExecArray | null
  while ((tableMatch = tableRegex.exec(html)) !== null) {
    const tableHtml = tableMatch[1]

    // Extract header cells from <th> elements
    const thRegex = /<th[^>]*>([\s\S]*?)<\/th>/gi
    const headers: string[] = []
    let thMatch: RegExpExecArray | null
    while ((thMatch = thRegex.exec(tableHtml)) !== null) {
      // Strip HTML tags from header content
      const headerText = thMatch[1].replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ').trim()
      headers.push(headerText)
    }

    if (headers.length === 0) continue

    // Count how many subscription column patterns match this table's headers
    const matchCount = SUBSCRIPTION_COLUMN_PATTERNS.filter(pat =>
      headers.some(h => pat.test(h))
    ).length

    if (matchCount > bestMatchCount) {
      bestMatchCount = matchCount
      bestHeaders = headers

      // Extract the tbody content (or full table content if no tbody)
      const tbodyMatch = tableHtml.match(/<tbody[^>]*>([\s\S]*?)<\/tbody>/i)
      bestBodyHtml = tbodyMatch ? tbodyMatch[1] : tableHtml
    }
  }

  // Need at least 3 matching columns to be confident this is the subscription table
  if (bestMatchCount < 3 || bestHeaders.length === 0) {
    return []
  }

  // Extract rows from the body
  const rows: Record<string, string>[] = []
  const trRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi
  let trMatch: RegExpExecArray | null
  while ((trMatch = trRegex.exec(bestBodyHtml)) !== null) {
    const rowHtml = trMatch[1]

    // Extract <td> cells
    const tdRegex = /<td[^>]*>([\s\S]*?)<\/td>/gi
    const cells: string[] = []
    let tdMatch: RegExpExecArray | null
    while ((tdMatch = tdRegex.exec(rowHtml)) !== null) {
      const cellText = tdMatch[1]
        .replace(/<[^>]*>/g, '')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&nbsp;/g, ' ')
        .trim()
      cells.push(cellText)
    }

    // Skip empty rows or rows that are all empty strings
    if (cells.length === 0 || cells.every(c => !c)) continue

    // Skip rows with fewer cells than headers (layout/spacer rows)
    if (cells.length < bestHeaders.length - 2) continue

    const obj: Record<string, string> = {}
    bestHeaders.forEach((h, idx) => { obj[h] = cells[idx] ?? '' })
    rows.push(obj)
  }

  return rows
}

// ── Name-matching utilities ───────────────────────────────────────────────────

/**
 * Strip common legal entity suffixes from a customer name.
 * "Recreational Equipment, Inc." → "Recreational Equipment"
 * "Bespin Global LLC" → "Bespin Global"
 *
 * Supportable often indexes without the suffix, so searching
 * "Recreational Equipment%" succeeds where the full name fails.
 * When supportableName override is set we skip this — the override is exact.
 */
export function stripLegalSuffix(name: string): string {
  return name
    .replace(/,?\s+(Inc\.?|LLC\.?|L\.L\.C\.?|Corp\.?|Ltd\.?|Incorporated|Limited|Co\.?|Company)\s*$/i, '')
    .trim()
}

/**
 * Build a deduplicated list of fallback search terms for Supportable name-search.
 * Handles cases where the customer name uses punctuation Supportable strips:
 *   "Bespin Global U.S." → tries "Bespin Global US" (dots stripped from abbreviations)
 *   "Omnivision Technologies" → tries "Omnivision" (first word only, as last resort)
 */
export function buildNameCandidates(customerName: string, supportableName?: string): string[] {
  const candidates: string[] = []
  const add = (t: string) => { const s = t.trim(); if (s && !candidates.includes(s)) candidates.push(s) }

  // Base terms: use supportableName override if set, otherwise derive from customerName
  const baseName = supportableName?.trim() || stripLegalSuffix(customerName)

  // Normalize abbreviation dots: "U.S." → "US", "U.K." → "UK"
  const normalized = baseName.replace(/\b([A-Za-z])\.([A-Za-z])\.?/g, '$1$2').replace(/\b([A-Za-z])\.\B/g, '$1').trim()
  add(normalized)

  // Progressive word-stripping fallback: remove one word at a time from the right
  // "Intrado Life & Safety" → "Intrado Life &" → "Intrado Life" → "Intrado"
  // Stops when fewer than 2 words remain or word length < 4 chars
  const words = normalized.split(/\s+/)
  for (let end = words.length - 1; end >= 1; end--) {
    const shorter = words.slice(0, end).join(' ').trim()
    if (shorter.length >= 4) add(shorter)
  }

  // If using customerName (no override), also include the un-normalized base
  if (!supportableName?.trim()) {
    const base = stripLegalSuffix(customerName)
    add(base)
  }

  return candidates
}
