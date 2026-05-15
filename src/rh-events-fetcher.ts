/**
 * Red Hat Events Fetcher
 * GitHub Issue #202 — Events module that reads Red Hat marketing events
 *
 * Fetches and parses Red Hat marketing events from a Google Doc.
 * Tags events with product keywords and region for filtering.
 */

import { existsSync, writeFileSync, mkdirSync } from 'fs'
import { resolve } from 'path'
import { makeAuth } from './google.ts'
import { google } from 'googleapis'

const CACHE_DIR = resolve(process.env.CACHE_DIR ?? 'data/cache', 'events')
const CACHE_PATH = resolve(CACHE_DIR, 'rh-events.json')

// Google Doc ID for NA Revenue Marketing Newsletter
const DOC_ID = '1sPwm0yxryjG14xXob5n7MVAMYGmX-ULbIGJglTrJls8'

// ── Types ────────────────────────────────────────────────────────────────────

export interface RHEvent {
  name: string                      // "Red Hat Tech Day w/ Intel"
  date: string                      // ISO date or "June 4, 2026"
  format: 'in-person' | 'virtual' | 'hybrid'
  location: string | null           // "Houston, TX" (null for virtual)
  region: 'northeast' | 'southeast' | 'central' | 'west' | 'canada' | 'national'
  productTags: string[]             // ["AAP", "OCP", etc.]
  registrationUrl: string | null    // extracted if "Reg Page" has a URL
  description: string               // raw line content for context
}

export interface EventsCache {
  events: RHEvent[]
  fetchedAt: string
  docId: string
}

// ── Product Keyword Mapping ──────────────────────────────────────────────────

const PRODUCT_KEYWORDS: Record<string, string[]> = {
  AAP: ['ansible', 'aap', 'automation platform'],
  OCP: ['openshift', 'ocp', 'kubernetes'],
  RHEL: ['rhel', 'enterprise linux', 'virtualization'],
  RHOAI: ['openshift ai', 'rhoai', 'instructlab', 'ai workshop'],
}

/**
 * Tag event with product keywords by scanning name
 */
function tagWithProducts(name: string): string[] {
  const text = name.toLowerCase()
  const tags: string[] = []

  for (const [tag, keywords] of Object.entries(PRODUCT_KEYWORDS)) {
    if (keywords.some(kw => text.includes(kw))) {
      tags.push(tag)
    }
  }

  return tags.length > 0 ? tags : ['General']
}

// ── Event Parsing ────────────────────────────────────────────────────────────

/**
 * Parse date from natural language format
 * Examples: "June 4", "May 27", "June 9-11"
 */
function parseEventDate(dateStr: string): string {
  // Try to parse natural language date
  const monthNames = ['january', 'february', 'march', 'april', 'may', 'june',
                      'july', 'august', 'september', 'october', 'november', 'december']

  // Match patterns like "June 4" or "May 27-29" (just grab first date)
  const match = dateStr.match(/(\w+)\s+(\d+)/i)
  if (match) {
    const monthName = match[1].toLowerCase()
    const day = match[2]
    const monthIndex = monthNames.findIndex(m => m.startsWith(monthName))

    if (monthIndex >= 0) {
      // Assume current year
      const year = new Date().getFullYear()
      const date = new Date(year, monthIndex, parseInt(day))
      return date.toISOString().split('T')[0]
    }
  }

  // Fallback to original string
  return dateStr
}

/**
 * Extract location from event line
 * Patterns: "Houston, TX" or "Denver, CO"
 */
function extractLocation(text: string): string | null {
  // Match City, ST pattern
  const match = text.match(/([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*),\s+([A-Z]{2})\b/)
  return match ? `${match[1]}, ${match[2]}` : null
}

/**
 * Extract registration URL from HTML content
 * Looks for <a> tags with "Reg Page" text
 */
function extractRegUrlFromHTML(htmlLine: string): string | null {
  // Match <a href="...">Reg Page</a> or <a href="...">Reg page</a>
  const match = htmlLine.match(/<a[^>]+href=["']([^"']+)["'][^>]*>Reg\s+[Pp]age<\/a>/i)
  return match ? match[1].trim() : null
}

/**
 * Determine region from section header
 */
function getRegionFromHeader(header: string): RHEvent['region'] | null {
  const lower = header.toLowerCase()
  if (lower.includes('northeast')) return 'northeast'
  if (lower.includes('southeast')) return 'southeast'
  if (lower.includes('central')) return 'central'
  if (lower.includes('west')) return 'west'
  if (lower.includes('canada')) return 'canada'
  // "NA Events & Resources by Program" → national (product-specific)
  if (lower.includes('na events') || lower.includes('by program')) return 'national'
  return null
}

/**
 * Parse a single event line from HTML
 */
function parseEventLine(htmlLine: string, region: RHEvent['region']): RHEvent | null {
  // Strip HTML tags to get plain text for most parsing
  const plainText = htmlLine.replace(/<[^>]+>/g, '').trim()

  // Must start with * and contain :
  if (!plainText.startsWith('*') || !plainText.includes(':')) {
    return null
  }

  // Extract date
  const datePart = plainText.match(/\*\s*([^:]+):/)
  if (!datePart) return null
  const date = parseEventDate(datePart[1].trim())

  // Split by | separator
  const parts = plainText.split('|').map(p => p.trim())
  if (parts.length < 2) return null

  // First part has date + format
  const firstPart = parts[0]
  let format: RHEvent['format'] = 'in-person'
  if (firstPart.toLowerCase().includes('virtual')) {
    format = 'virtual'
  } else if (firstPart.toLowerCase().includes('hybrid')) {
    format = 'hybrid'
  }

  // Second part is the event name
  const name = parts[1]?.trim() ?? ''
  if (!name) return null

  // Try to extract location
  const location = extractLocation(plainText)

  // Virtual events are always national
  const finalRegion = format === 'virtual' ? 'national' : region

  // Extract registration URL from HTML (before stripping tags)
  const registrationUrl = extractRegUrlFromHTML(htmlLine)

  // Tag with products
  const productTags = tagWithProducts(name)

  return {
    name,
    date,
    format,
    location,
    region: finalRegion,
    productTags,
    registrationUrl,
    description: plainText,
  }
}

/**
 * Parse Google Doc HTML into events
 */
function parseDocHTML(html: string): RHEvent[] {
  const events: RHEvent[] = []

  // Google Docs exports as single-line HTML. Split by block elements to find sections.
  // Insert newlines before headings and list items for easier parsing
  const normalized = html
    .replace(/<h[1-6][^>]*>/gi, '\n<HEADING>')
    .replace(/<\/h[1-6]>/gi, '</HEADING>\n')
    .replace(/<li[^>]*>/gi, '\n<LI>')
    .replace(/<\/li>/gi, '</LI>\n')
    .replace(/<p[^>]*>/gi, '\n<P>')
    .replace(/<\/p>/gi, '</P>\n')
    .replace(/<hr[^>]*>/gi, '\n<HR>\n')

  const lines = normalized.split('\n')
  let currentRegion: RHEvent['region'] | null = null

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue

    // Strip HTML for text analysis but keep original for URL extraction
    const plainText = trimmed.replace(/<[^>]+>/g, '').trim()

    // Check for region header
    const detectedRegion = getRegionFromHeader(plainText)
    if (detectedRegion) {
      currentRegion = detectedRegion
      continue
    }

    if (!currentRegion) continue

    // Try to parse as event line (pass HTML for URL extraction)
    const event = parseEventLine(trimmed, currentRegion)
    if (event) {
      events.push(event)
    }
  }

  return events
}

// ── Fetch Events ─────────────────────────────────────────────────────────────

/**
 * Fetch Red Hat events from Google Doc and write to cache
 */
export async function fetchRHEvents(): Promise<void> {
  // Ensure cache directory exists
  if (!existsSync(CACHE_DIR)) {
    mkdirSync(CACHE_DIR, { recursive: true })
  }

  try {
    console.log(`[rh-events] fetching from Google Doc ${DOC_ID}`)

    const tokenPath = resolve(process.env.DATA_DIR ?? 'data', 'token.json')
    const auth = await makeAuth(tokenPath)
    const drive = google.drive({ version: 'v3', auth })

    // Export doc as HTML to preserve hyperlinks
    const res = await drive.files.export({
      fileId: DOC_ID,
      mimeType: 'text/html',
    })

    const html = res.data as string

    // Parse events from HTML
    const events = parseDocHTML(html)

    console.log(`[rh-events] parsed ${events.length} events`)

    // Write cache
    const cache: EventsCache = {
      events,
      fetchedAt: new Date().toISOString(),
      docId: DOC_ID,
    }

    writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2), { mode: 0o600 })
    console.log(`[rh-events] wrote cache: ${events.length} events`)
  } catch (e: any) {
    console.error(`[rh-events] fetch error:`, e?.message ?? e)
    throw e
  }
}
