/**
 * src/rh-scraper-extract.ts
 *
 * Pure DOM-parsing logic extracted from the rh-scraper page.evaluate() callback.
 *
 * WHY THIS FILE EXISTS:
 * page.evaluate() runs inside the Playwright browser context — the callback is
 * serialised to a string and executed in Chromium. Because of this, you cannot
 * import Node modules inside it, and you cannot call it directly from a test.
 *
 * This file exports extractCasesFromDocument(), which is a pure function that
 * accepts a Document object and an account number. It mirrors the logic inside
 * the page.evaluate() callback in rh-scraper.ts exactly, so it can be tested
 * with a virtual DOM (happy-dom in bun:test) without a live browser session.
 *
 * SYNC CONTRACT:
 * rh-scraper.ts's page.evaluate() callback and extractCasesFromDocument() MUST
 * stay logically identical. When you modify the scraping logic in one, update
 * the other. The column index map below is the canonical reference.
 *
 * Portal table columns (14 total, 0-indexed):
 *   [0] checkbox     [1] case#     [2] summary     [3] opened-by
 *   [4] modified     [5] severity  [6] status      [7] (unused)
 *   [8] product      [9-13] (unused)
 */

export interface RawCaseRow {
  caseNumber: string
  summary: string
  status: string
  severity: string
  accountNumber: string
  product: string
}

/**
 * Extract open support cases from a fully-rendered portal case-list Document.
 *
 * Mirrors the page.evaluate() callback in runRhScrape() exactly.
 * Skips rows that:
 *   - have no anchor matching `a[href*="/case/"]`
 *   - have a case number that does not match 7–10 digits
 *   - have status "closed" (case-insensitive)
 */
export function extractCasesFromDocument(doc: Document, accountNumber: string): RawCaseRow[] {
  const results: RawCaseRow[] = []

  const rows = doc.querySelectorAll('table tbody tr')
  for (const row of rows) {
    const caseLink = row.querySelector('a[href*="/case/"]') as HTMLAnchorElement | null
    if (!caseLink) continue

    const caseNumber = caseLink.textContent?.trim() ?? ''
    if (!/^\d{7,10}$/.test(caseNumber)) continue

    const cells = Array.from(row.querySelectorAll('td')).map(
      (td) => td.textContent?.trim() ?? '',
    )

    // Column indices — MUST match rh-scraper.ts page.evaluate() callback
    const status = cells[6] ?? ''
    if (status.toLowerCase() === 'closed') continue

    results.push({
      caseNumber,
      summary:       cells[2] ?? '',
      status,
      severity:      cells[5] ?? '',
      product:       cells[8] ?? '',
      accountNumber,
    })
  }

  return results
}
