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
  summary: string                   // descriptive text after metadata (if any)
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

// ── Metadata / Location Patterns ─────────────────────────────────────────────

/** Parts matching these are metadata, not the event name */
const METADATA_PATTERNS = [
  /reg\s*page/i,
  /reg\s*list/i,
  /reg\s*report/i,
  /event\s*lead/i,
  /event\s*overview/i,
  /marketing\s*lead/i,
  /planning\s*deck/i,
  /sales\s*invite/i,
  /social\s*link/i,
  /social\s*copy/i,
  /invite\s*copy/i,
  /^social$/i,
  /^pdf(\s+email)?$/i,
  /^\s*pdf\s*$/i,
  /event\s*features?:/i,
]

/** Matches location + time patterns like "Cambridge, MA 2:00pm to 4:30pm" */
const LOCATION_TIME_PATTERN = /[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*,\s+[A-Z]{2}\b/
const TIME_PATTERN = /\d{1,2}:\d{2}\s*(?:am|pm)/i

/**
 * Check if a part looks like a location/time string rather than an event name
 */
function isLocationTimePart(part: string): boolean {
  return LOCATION_TIME_PATTERN.test(part) || TIME_PATTERN.test(part)
}

/**
 * Check if a part is metadata (not the event name)
 */
function isMetadataPart(part: string): boolean {
  return METADATA_PATTERNS.some(p => p.test(part.trim()))
}

// ── Garbage Pattern Filtering ────────────────────────────────────────────────

const GARBAGE_PATTERNS = [
  /^social$/i,
  /^full version/i,
  /^short cut/i,
  /^bookmark/i,
  /^revamp\s+\w+$/i,        // "Revamp RHEL", "Revamp AAP", etc.
  /more\s+details/i,        // "More details coming soon", "More details"
  /details\s+coming/i,      // "details coming soon"
  /^html$/i,                // standalone "HTML" metadata label
  /^pdf$/i,                 // standalone "PDF" metadata label
  /ancillary\s+event/i,     // sub-event descriptions, not main events
  /^(?:january|february|march|april|may|june|july|august|september|october|november|december)\s+\d+\s*:/i,
  // Raw input lines starting with "June 3:" etc. — these are unparsed source lines
]

/**
 * Check if an event name looks like garbage/navigation
 */
function isGarbageEvent(name: string): boolean {
  return GARBAGE_PATTERNS.some(pattern => pattern.test(name.trim()))
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
 * Returns null if the date string doesn't look valid (for garbage filtering)
 */
function parseEventDate(dateStr: string): string | null {
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

  // Return null for unparseable dates (garbage entries)
  return null
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

const STATE_TO_REGION: Record<string, RHEvent['region']> = {
  // Northeast
  CT: 'northeast', DE: 'northeast', MA: 'northeast', MD: 'northeast', ME: 'northeast',
  NH: 'northeast', NJ: 'northeast', NY: 'northeast', PA: 'northeast', RI: 'northeast',
  VT: 'northeast', VA: 'northeast', DC: 'northeast',
  // Southeast
  AL: 'southeast', AR: 'southeast', FL: 'southeast', GA: 'southeast', KY: 'southeast',
  LA: 'southeast', MS: 'southeast', NC: 'southeast', SC: 'southeast', TN: 'southeast',
  WV: 'southeast', PR: 'southeast',
  // Central
  IA: 'central', IL: 'central', IN: 'central', KS: 'central', MI: 'central',
  MN: 'central', MO: 'central', ND: 'central', NE: 'central', OH: 'central',
  OK: 'central', SD: 'central', TX: 'central', WI: 'central',
  // West
  AK: 'west', AZ: 'west', CA: 'west', CO: 'west', HI: 'west', ID: 'west',
  MT: 'west', NM: 'west', NV: 'west', OR: 'west', UT: 'west', WA: 'west', WY: 'west',
  // Canada
  AB: 'canada', BC: 'canada', MB: 'canada', NB: 'canada', NL: 'canada',
  NS: 'canada', NT: 'canada', NU: 'canada', ON: 'canada', PE: 'canada',
  QC: 'canada', SK: 'canada', YT: 'canada',
}

function getRegionFromLocation(location: string | null): RHEvent['region'] | null {
  if (!location) return null
  const stateMatch = location.match(/,\s*([A-Z]{2})\b/)
  if (!stateMatch) return null
  return STATE_TO_REGION[stateMatch[1]] ?? null
}

/**
 * Unwrap Google redirect URLs
 * Extracts the actual URL from google.com/url?q= wrappers
 */
function unwrapGoogleUrl(url: string): string {
  if (url.includes('google.com/url?')) {
    const match = url.match(/[?&]q=([^&]+)/)
    if (match) return decodeURIComponent(match[1])
  }
  return url
}

/**
 * Extract registration URL from HTML content
 * Looks for <a> tags with "Reg Page" text
 */
function extractRegUrlFromHTML(htmlLine: string): string | null {
  // Match <a href="...">Reg Page</a> or <a href="...">Reg page</a>
  const match = htmlLine.match(/<a[^>]+href=["']([^"']+)["'][^>]*>Reg\s+[Pp]age<\/a>/i)
  if (!match) return null

  const wrappedUrl = match[1].trim()
  return unwrapGoogleUrl(wrappedUrl)
}

/** Patterns for links that are NOT registration/event info URLs */
const SKIP_LINK_PATTERNS = [
  /\.pdf$/i,
  /^mailto:/i,
  /^#/,                      // Google Doc internal anchors
  /social/i,
  /planning\s*deck/i,
]

interface ExtractedLink {
  url: string
  text: string
}

/**
 * Extract all <a> links from HTML, returning url + anchor text.
 * Filters out metadata links (PDFs, mailto, social, internal anchors).
 * Unwraps Google redirect URLs.
 */
function extractAllLinks(htmlLine: string): ExtractedLink[] {
  const results: ExtractedLink[] = []
  const re = /<a[^>]+href=["']([^"']+)["'][^>]*>(.*?)<\/a>/gi
  let m: RegExpExecArray | null

  while ((m = re.exec(htmlLine)) !== null) {
    const rawUrl = m[1].trim()
    const text = m[2].replace(/<[^>]+>/g, '').trim()

    // Skip metadata links
    if (SKIP_LINK_PATTERNS.some(p => p.test(rawUrl) || p.test(text))) continue

    const url = unwrapGoogleUrl(rawUrl)
    if (url) results.push({ url, text })
  }

  return results
}

/**
 * Extract the best registration/event URL from HTML.
 * Priority:
 *   1. Explicit "Reg Page" link
 *   2. A descriptive link (3+ words, not metadata) — the event name is often hyperlinked
 */
function extractBestUrl(htmlLine: string): { url: string; linkName: string | null } | null {
  // 1. Try explicit "Reg Page" link first
  const regPage = extractRegUrlFromHTML(htmlLine)
  if (regPage) return { url: regPage, linkName: null }

  // 2. Try descriptive links (event name is often the link text)
  const links = extractAllLinks(htmlLine)
  for (const link of links) {
    const words = link.text.split(/\s+/).length
    if (words >= 3 && !isMetadataPart(link.text) && !isLocationTimePart(link.text)) {
      return { url: link.url, linkName: link.text }
    }
  }

  return null
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
  // Strip HTML tags and decode entities to get plain text
  const plainText = htmlLine.replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&rsquo;/g, "'").replace(/&ldquo;/g, '"')
    .replace(/&rdquo;/g, '"').replace(/&mdash;/g, '—').replace(/&ndash;/g, '–')
    .replace(/&#\d+;/g, m => String.fromCharCode(parseInt(m.slice(2, -1))))
    .trim()

  // Must contain a date pattern and In-Person/Virtual/Hybrid
  const hasFormat = /in-person|virtual|hybrid/i.test(plainText)
  if (!hasFormat) return null

  // Strip leading list markers (*, LI:, etc.)
  const cleaned = plainText.replace(/^(?:LI:|NEW!?\s*|\*)\s*/i, '').trim()

  // Extract date
  const datePart = cleaned.match(/^([^:]+):/)
  if (!datePart) return null
  const date = parseEventDate(datePart[1].trim())

  // Skip if date couldn't be parsed (garbage entry)
  if (!date) return null

  // Split by | separator
  const parts = cleaned.split('|').map(p => p.trim())
  if (parts.length < 2) return null

  // First part has date + format
  const firstPart = parts[0]
  let format: RHEvent['format'] = 'in-person'
  if (firstPart.toLowerCase().includes('virtual')) {
    format = 'virtual'
  } else if (firstPart.toLowerCase().includes('hybrid')) {
    format = 'hybrid'
  }

  // ── Extract URLs from HTML before stripping tags ──────────────────────────
  const urlInfo = extractBestUrl(htmlLine)
  const registrationUrl = urlInfo?.url ?? null

  // ── Identify the event name ──────────────────────────────────────────────
  // Priority 1: If the HTML had a descriptive hyperlink, use its text as name
  // Priority 2: Score pipe-separated parts and pick the best candidate
  const candidates = parts.slice(1)
  let bestName = ''
  let bestScore = -1
  let bestIndex = -1

  // If we got a name from a hyperlink, prefer it
  if (urlInfo?.linkName) {
    bestName = urlInfo.linkName
    // Find which candidate index matches this link text (for summary exclusion)
    for (let i = 0; i < candidates.length; i++) {
      if (candidates[i].trim().includes(urlInfo.linkName)) {
        bestIndex = i
        break
      }
    }
  }

  // Fall back to scoring if no link-derived name
  if (!bestName) {
    for (let i = 0; i < candidates.length; i++) {
      const part = candidates[i].trim()
      if (!part) continue

      // Skip metadata parts
      if (isMetadataPart(part)) continue

      // Skip location/time parts
      if (isLocationTimePart(part)) continue

      // Score: word count + length, heavily penalize short parts
      const words = part.split(/\s+/).length
      if (words < 3) continue

      const score = words * 10 + part.length

      if (score > bestScore) {
        bestScore = score
        bestName = part
        bestIndex = i
      }
    }
  }

  // If best name is garbage, try harder: use any hyperlinked text from the HTML
  if (!bestName || isGarbageEvent(bestName)) {
    const links = extractAllLinks(htmlLine)
    for (const link of links) {
      const words = link.text.split(/\s+/).length
      if (words >= 3 && !isMetadataPart(link.text) && !isLocationTimePart(link.text) && !isGarbageEvent(link.text)) {
        bestName = link.text
        break
      }
    }
  }

  const name = bestName
  if (!name) return null

  // Filter garbage events
  if (isGarbageEvent(name)) return null

  // Try to extract location from ANY part (not just parts[0])
  const location = extractLocation(plainText)

  // Derive region from location (state → region mapping) — more accurate than doc section headers
  // Virtual events are always national
  const locationRegion = getRegionFromLocation(location)
  const finalRegion = format === 'virtual' ? 'national' : (locationRegion ?? region)

  // Tag with products
  const productTags = tagWithProducts(name)

  // ── Build clean summary ──────────────────────────────────────────────────
  // Exclude: parts[0] (date+format), the name part, metadata, and locations
  const summaryParts = candidates
    .filter((p, i) => {
      if (i === bestIndex) return false           // already shown as title
      const trimmed = p.trim()
      if (!trimmed) return false
      if (isMetadataPart(trimmed)) return false
      if (isLocationTimePart(trimmed)) return false
      if (LOCATION_TIME_PATTERN.test(trimmed)) return false
      return true
    })
    .join(' ')
    .trim()

  // Clean summary: if it looks like a raw pipe-separated source line, discard it
  const cleanSummary = (summaryParts.includes('|') || summaryParts === plainText)
    ? ''
    : summaryParts

  return {
    name,
    date,
    format,
    location,
    region: finalRegion,
    productTags,
    registrationUrl,
    description: plainText,
    summary: cleanSummary,
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

    // Strip HTML and decode entities for text analysis, keep original for URL extraction
    const plainText = trimmed.replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&rsquo;/g, "'")
      .trim()

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
