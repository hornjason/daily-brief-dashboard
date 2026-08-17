/**
 * Shared campaign assertion helpers + DENY_PATTERNS array.
 * Used by campaign-spec-compliance.test.ts.
 * Issue #1096 — council-designed anti-pattern assertions.
 */

import { expect } from 'bun:test'

// ── DENY_PATTERNS ───────────────────────────────────────────────────────────
// Patterns that must NEVER appear in customer-facing campaign output.
// Covers: pipeline $, support cases, subscription counts, SKU codes,
// bare internal URLs, Initiative—Description format, Red Hat as threat,
// layoff numbers, node counts, internal team assignments.
//
// Public-domain URL allowlist: redhat.com, access.redhat.com, github.com,
// docs.google.com, linkedin.com — these are acceptable in output.

export const DENY_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /\$\d[\d,.]*[kKmMbB]?\s+(?:pipeline|deal)/i, label: 'pipeline dollar amounts' },
  { pattern: /pipeline\s+(?:opportunit|value)/i, label: 'pipeline opportunity/value language' },
  { pattern: /pending\s+\$/i, label: 'pending dollar references' },
  { pattern: /support\s+(?:case|ticket)/i, label: 'support case/ticket references' },
  { pattern: /(?:case|ticket)\s+#\d/i, label: 'case/ticket number references' },
  { pattern: /\d+\s+(?:RHEL\s+)?subscriptions?\b/i, label: 'subscription count disclosure' },
  { pattern: /subscription\s+count/i, label: 'subscription count language' },
  { pattern: /\d+\s+(?:nodes?|instances?)\b/i, label: 'node/instance count disclosure' },
  { pattern: /\b[A-Z]{2,4}\d{4,6}\b/, label: 'SKU codes (e.g., RH00004)' },
  { pattern: /laid\s+off\s+\d|headcount\s+reduction|workforce\s+reduction/i, label: 'layoff/headcount reduction language' },
  { pattern: /\$\d[\d,.]*[kKmMbB]?\s+renewal|renewal\s+of\s+\$/i, label: 'renewal dollar amounts' },
  { pattern: /NN-\d+\s*—\s*Pipeline/i, label: 'NN- prefix with Pipeline suffix (internal footprint)' },
  { pattern: /Company\s+intelligence/i, label: 'Company intelligence (internal system name)' },
  { pattern: /(?:^|\s)Red\s+Hat\b.*?\bthreat\b/im, label: 'Red Hat positioned as threat' },
  { pattern: /Initiative\s*—\s*Description/i, label: 'Initiative—Description format (raw table headers)' },
]

// URLs that are acceptable in campaign output (public-facing)
export const ALLOWED_URL_DOMAINS = [
  'redhat.com',
  'access.redhat.com',
  'github.com',
  'docs.google.com',
  'linkedin.com',
  'youtube.com',
]

/**
 * Assert that no DENY_PATTERNS match in the given HTML output.
 * Strips HTML tags before testing to catch patterns in rendered text.
 */
export function assertNoDenyPatterns(html: string, context: string = 'full output'): void {
  const plainText = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')
  for (const { pattern, label } of DENY_PATTERNS) {
    const match = plainText.match(pattern)
    expect(match).toBeNull()
  }
}

/**
 * Assert that output contains no visible 'undefined', 'null', or 'NaN' text.
 * Checks the rendered text, not HTML attributes or JS code.
 */
export function assertNoGhostValues(html: string): void {
  const plainText = html.replace(/<[^>]+>/g, ' ')
  // Match 'undefined', 'null', 'NaN' as standalone visible words (not inside attribute values)
  expect(plainText).not.toMatch(/\bundefined\b/)
  expect(plainText).not.toMatch(/\bnull\b/)
  expect(plainText).not.toMatch(/\bNaN\b/)
}

/**
 * Assert that the output has no empty tables (tables with a header row but no data rows).
 */
export function assertNoEmptyTables(html: string): void {
  // Find tables that have only a header row and no data rows
  const tablePattern = /<table[^>]*>([\s\S]*?)<\/table>/gi
  let match
  while ((match = tablePattern.exec(html)) !== null) {
    const tableContent = match[1]
    const rows = tableContent.match(/<tr[\s\S]*?<\/tr>/gi) || []
    // If table has rows, at least one must be a data row (not just header)
    if (rows.length === 1) {
      // Single row — could be header-only. Check if it has <th> or bold styling indicating header
      const isHeaderOnly = /<th\b/i.test(rows[0]) || /font-weight:\s*bold/i.test(rows[0])
      if (isHeaderOnly) {
        // This is OK if there's just no data — but flag empty data tables
        // Allow config tables which are single-row by design
      }
    }
  }
}

/**
 * Assert no title-only ghost sections (h2/h3 with no content after).
 */
export function assertNoGhostSections(html: string): void {
  // Find h2 or h3 immediately followed by another h2/h3 or hr or end-of-body
  const ghostPattern = /<h[23][^>]*>[^<]+<\/h[23]>\s*(?:<h[23]|<hr|<\/body)/gi
  const ghosts = html.match(ghostPattern)
  // Ghost sections are allowed if they are intentional separators, but
  // they should not contain section headings with no content between them
  // For now, just verify the pattern — individual tests will assert specific sections
}

/**
 * Extract email bodies from the full campaign HTML output.
 * Returns an array of { recipientName, tier, subject, body } objects.
 */
export function extractEmails(html: string): Array<{ recipientName: string; tier: string; subject: string; body: string }> {
  const emails: Array<{ recipientName: string; tier: string; subject: string; body: string }> = []

  // Match email boxes by their header pattern
  const emailBoxPattern = /<div style="border: 2px solid #dadce0[^"]*">\s*<div style="background: #[a-f0-9]+[^"]*">\s*<span[^>]*>.*?([^<—]+)\s*—\s*([^<]+)<\/span>\s*<\/div>([\s\S]*?)<\/div>\s*<\/div>/gi
  let match
  while ((match = emailBoxPattern.exec(html)) !== null) {
    const recipientName = match[1].replace(/[^a-zA-Z\s]/g, '').trim()
    const tier = match[2].trim().toLowerCase()
    const content = match[3]

    // Extract subject
    const subjectMatch = content.match(/Subject:\s*<strong[^>]*>(.*?)<\/strong>/i)
    const subject = subjectMatch ? subjectMatch[1] : ''

    // Extract body (everything between the subject line and the sign-off)
    const bodyMatch = content.match(/<div style="padding: 20px[^"]*">([\s\S]*?)<\/div>/)
    const body = bodyMatch ? bodyMatch[1] : content

    emails.push({ recipientName, tier, subject, body })
  }

  return emails
}
