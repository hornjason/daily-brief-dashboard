/**
 * SalesHub Knowledge Base Filters
 *
 * Runtime filters to prevent template text and broken entries from the
 * SalesHub scraper from reaching users. These patterns come from the
 * SalesHub UI chrome that the scraper captures as content.
 *
 * Used by: customer-solution-context.ts, signal-templates.ts
 */

const TEMPLATE_WIN_PATTERNS = [
  'Real customer stories',
  '0 item(s) selected',
  'Displaying slide',
]

/**
 * Returns true if the customerWin string is real content (not template text).
 */
export function isValidCustomerWin(win: string): boolean {
  if (!win || win.trim().length === 0) return false
  return !TEMPLATE_WIN_PATTERNS.some(pattern => win.includes(pattern))
}

/**
 * Returns true if the whatToShare asset has a usable URL and real name.
 * Rejects empty URLs, javascript: URLs, section headers, and UI artifacts.
 */
export function isValidAsset(asset: { name: string; url: string }): boolean {
  if (!asset) return false
  const { name, url } = asset

  // Reject empty or javascript: URLs
  if (!url || url.trim().length === 0 || url === 'javascript:void(0)') return false

  // Reject section header names
  if (name.startsWith('What to show') || name.includes('→')) return false

  // Reject UI artifacts
  if (name === '0 item(s) selected') return false
  if (name === 'Displaying slide 1 of 1') return false

  return true
}

/**
 * Returns true if the extracted metric has a number in value and meaningful context.
 * Filters out noise from automated metric extraction.
 */
export function isValidMetric(metric: { value: string; context: string }): boolean {
  return /\d/.test(metric.value) && metric.context.length > 5
}
