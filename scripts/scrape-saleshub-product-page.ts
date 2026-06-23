#!/usr/bin/env bun
/**
 * scripts/scrape-saleshub-product-page.ts -- SalesHub product page scraper (#819)
 *
 * Navigates to a SalesHub product page, walks red header bars to discover sections,
 * extracts all content (links, text, cards, tables, accordions) per section.
 *
 * Reuses auth + browser infrastructure from scrape-saleshub.ts / saleshub-content-discovery.ts.
 *
 * Usage:
 *   bun run scripts/scrape-saleshub-product-page.ts [product-page-url]
 *
 * Defaults to prompting for a URL if none provided.
 */

import { chromium } from '@playwright/test'
import type { Page, Locator } from '@playwright/test'
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'fs'
import { resolve, relative } from 'path'
import type { BrowserContext } from '@playwright/test'
import { writeJsonAtomic } from '../src/lib/atomic-write.ts'
import {
  createManifest,
  addGate0Entry,
  updateGate1,
  updateGate2,
  computeGateSummary,
  writeManifest,
  readManifest,
  type PipelineManifest,
} from '../src/lib/pipeline-manifest.ts'
import { BASE_CHROMIUM_ARGS } from '../src/browser-utils.ts'
import {
  captureSeismicAuth,
  parseDocumentsFromApiResponse,
  type DocCenterDocument,
} from './saleshub-content-discovery.ts'
import type {
  ProductPage,
  ProductSection,
  SectionItem,
} from '../src/types/saleshub-product-types.ts'

// ── Load .env when running standalone (not via container --env-file) ─────────
// Gemini credentials and Google OAuth paths are needed for inline enrichment
// and Drive upload but aren't available unless .env is loaded explicitly.
const _envPath = resolve(import.meta.dir, '../.env')
if (!process.env.GEMINI_SERVICE_ACCOUNT_KEY && existsSync(_envPath)) {
  for (const line of readFileSync(_envPath, 'utf-8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/)
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2]
  }
}

// ── Constants ────────────────────────────────────────────────────────────────

const PROFILE_DIR = process.env.RH_PROFILE_DIR ?? '/data/rh-profile'
const CACHE_DIR = process.env.CACHE_DIR ?? '/data/cache'
const CHROMIUM_PATH = process.env.CHROMIUM_PATH ?? '/ms-playwright/chromium-1208/chrome-linux/chrome'
const PROFILE_VERSION_ID = '1d1918e9-b5b0-4428-b8fc-87e02ad44156'
const MAX_DOWNLOADS_PER_PRODUCT = 100
const SKIP_FORMATS = new Set(['JSON', 'MP4', 'MOV', 'WEBM', 'ZIP', 'PNG', 'YouTube', 'URL'])
// Two-tier language filter (#872):
// Tier 1: Common non-English words that appear in SalesHub document titles
const NON_ENGLISH_WORDS = /acelere|começe|comience|motivos|migrar|máquinas|fluxos|maneiras|faça|débuter|einstieg|ergebnisse|gestisci|introduzione|vantaggi|virtualisierung|비즈니스|仮想化|자동화|empresa\s+automatizada/i
// Tier 2: ISO language code suffixes in parentheses, e.g. "(fr)", "(pt-BR)"
const ISO_LANGUAGE_CODE_PATTERN = /\((?:de|fr|es|it|pt|pt-br|ja|ko|zh|zh-cn|zh-tw)\)$/i
// #856: Safety net — catch any unhandled promise rejections from download
// timeouts instead of crashing the process. The per-promise .catch() below
// is the real fix; this is defense-in-depth.
process.on('unhandledRejection', (reason: any) => {
  console.error('[product-scraper] Unhandled rejection (caught by safety net):', reason?.message ?? reason)
})

const skipDownloads = process.argv.includes('--skip-downloads')

// ── Exported pure helpers (tested in saleshub-product-download.test.ts) ─────

/** A downloadable item collected from product sections */
export interface DownloadableItem {
  name: string
  format: string
  sectionKey: string
  versionId: string
  contentId: string
}

/** Returns true if the format should be skipped (non-document formats) */
export function isSkippedFormat(format: string): boolean {
  if (!format) return true
  return SKIP_FORMATS.has(format)
}

/**
 * Returns true if the document name indicates a non-English document (#872).
 *
 * Two-tier detection:
 *  1. Check for common non-English words in the title (catches "Acelere os resultados")
 *  2. Check for ISO language code suffix, e.g. "(fr)", "(pt-BR)"
 *
 * When metadata.language is available, callers should check that FIRST
 * before falling back to this name-based heuristic.
 */
export function isNonEnglishDoc(name: string): boolean {
  if (NON_ENGLISH_WORDS.test(name)) return true
  if (ISO_LANGUAGE_CODE_PATTERN.test(name.trim())) return true
  return false
}

/**
 * Returns true if an item's metadata language field indicates non-English (#872).
 * Primary check — use before falling back to isNonEnglishDoc() name heuristic.
 */
export function isNonEnglishByMetadata(item: { language?: string }): boolean {
  if (!item.language) return false
  const lang = item.language.toLowerCase().trim()
  if (!lang || lang === 'en' || lang === 'en-us' || lang === 'en-gb') return false
  return true
}

/** Builds a Seismic download URL from versionId and contentId */
export function buildDownloadUrl(versionId: string, contentId: string): string {
  return `https://saleshub.redhat.com/api/doccenter/download/${contentId}/${versionId}`
}

/** Checks whether an item has the required fields for API-based download (#857) */
export function shouldAttemptApiDownload(item: { contentId?: string; versionId?: string }): boolean {
  return Boolean(item.contentId && item.versionId)
}

/** Builds a local filesystem path for a downloaded document */
export function buildLocalPath(
  productDir: string,
  sectionKey: string,
  docName: string,
  format: string,
): string {
  const sanitized = docName.replace(/[\/\\?%*:|"<>]/g, '_').slice(0, 200)
  const ext = format.toLowerCase()
  return `${productDir}/downloads/${sectionKey}/${sanitized}.${ext}`
}

/**
 * Collects all downloadable items from product sections.
 * Filters: must have versionId + contentId, non-skipped format, English-only.
 * Deduplicates by versionId.
 */
export function collectDownloadableItems(
  sections: Record<string, ProductSection>,
): DownloadableItem[] {
  const seen = new Set<string>()
  const items: DownloadableItem[] = []

  for (const [sectionKey, section] of Object.entries(sections)) {
    for (const item of section.items) {
      const si = item as any
      if (!si.versionId || !si.contentId) continue
      const format = si.format ?? ''
      if (isSkippedFormat(format)) continue
      // #872: Two-tier language filter — metadata first, then name heuristic
      if (isNonEnglishByMetadata(si)) continue
      if (isNonEnglishDoc(item.name)) continue
      if (seen.has(si.versionId)) continue
      seen.add(si.versionId)

      items.push({
        name: item.name,
        format,
        sectionKey,
        versionId: si.versionId,
        contentId: si.contentId,
      })
    }
  }

  return items
}

/**
 * Deduplicates items across all sections by normalized name (#873).
 * When duplicates are found, keeps the entry with more metadata (contentId > no contentId).
 * Returns { sections (mutated), removed } for manifest tracking.
 */
export function deduplicateAcrossSections(
  sections: Record<string, ProductSection>,
): { removed: Array<{ name: string; section: string }> } {
  const seen = new Map<string, { sectionKey: string; itemIdx: number; hasContentId: boolean }>()
  const toRemove: Array<{ sectionKey: string; itemIdx: number; name: string; section: string }> = []

  for (const [sectionKey, section] of Object.entries(sections)) {
    for (let i = 0; i < section.items.length; i++) {
      const item = section.items[i]
      const normalizedName = item.name.toLowerCase().trim()
      const hasContentId = Boolean((item as any).contentId)

      const existing = seen.get(normalizedName)
      if (existing) {
        // Decide which to keep — prefer the one with contentId
        if (hasContentId && !existing.hasContentId) {
          // Current is better — remove the existing one
          toRemove.push({
            sectionKey: existing.sectionKey,
            itemIdx: existing.itemIdx,
            name: item.name,
            section: existing.sectionKey,
          })
          seen.set(normalizedName, { sectionKey, itemIdx: i, hasContentId })
        } else {
          // Existing is same or better — remove current
          toRemove.push({ sectionKey, itemIdx: i, name: item.name, section: sectionKey })
        }
      } else {
        seen.set(normalizedName, { sectionKey, itemIdx: i, hasContentId })
      }
    }
  }

  // Remove duplicates in reverse index order to avoid index shifting
  const bySectionKey = new Map<string, number[]>()
  for (const entry of toRemove) {
    if (!bySectionKey.has(entry.sectionKey)) bySectionKey.set(entry.sectionKey, [])
    bySectionKey.get(entry.sectionKey)!.push(entry.itemIdx)
  }
  for (const [sectionKey, indices] of bySectionKey) {
    const sorted = indices.sort((a, b) => b - a) // reverse order
    for (const idx of sorted) {
      sections[sectionKey].items.splice(idx, 1)
    }
  }

  return {
    removed: toRemove.map(r => ({ name: r.name, section: r.section })),
  }
}

/**
 * Auth canary check — validates auth before the full download loop (#874).
 * Picks the first downloadable item, attempts one API download, and checks
 * for 401/403 or login-page redirects. Returns { ok, reason?, skipped? }.
 * Accepts an optional fetchFn for testing (defaults to global fetch).
 */
export async function authCanaryCheck(
  authCtx: { auth: string; headers: Record<string, string>; searchUrl: string },
  sections: Record<string, ProductSection>,
  fetchFn: typeof fetch = fetch,
): Promise<{ ok: boolean; reason?: string; skipped?: boolean }> {
  const items = collectDownloadableItems(sections)
  if (items.length === 0) {
    return { ok: true, skipped: true }
  }

  const canary = items[0]
  const url = buildDownloadUrl(canary.versionId, canary.contentId)

  try {
    const resp = await fetchFn(url, {
      headers: authCtx.headers,
      redirect: 'follow',
    })

    if (resp.status === 401 || resp.status === 403) {
      return { ok: false, reason: `AUTH CANARY FAILED: ${resp.status}` }
    }

    if (resp.redirected && resp.url && /login|auth|sso/i.test(resp.url)) {
      return { ok: false, reason: `AUTH CANARY FAILED: redirected to login page (${resp.url})` }
    }

    return { ok: true }
  } catch (err: any) {
    return { ok: false, reason: `AUTH CANARY FAILED: fetch error — ${err.message ?? err}` }
  }
}

// ── Exported viewer content extraction helpers (tested in viewer-content-extractor.test.ts) ──

/** Patterns matching Seismic navigation chrome elements to strip from viewer HTML */
const SEISMIC_CHROME_PATTERNS = [
  /class="[^"]*seismic-header[^"]*"/i,
  /class="[^"]*seismic-footer[^"]*"/i,
  /class="[^"]*seismic-navigation[^"]*"/i,
  /class="[^"]*seismic-toolbar[^"]*"/i,
  /class="[^"]*seismic-page-toolbar[^"]*"/i,
  /class="[^"]*articleSdk-theme-page-doubleColumn-sidebar[^"]*"/i,
]

/** Session/token keywords that flag a <meta> tag for removal */
const SESSION_TOKEN_KEYWORDS = [
  'csrf', 'token', 'auth', 'session', 'nonce', 'xsrf',
]

/**
 * Sanitizes viewer page HTML for enrichment (#859).
 * Removes: <script>, <style>, <noscript> tags and content;
 *          <meta> tags containing session/token strings;
 *          Seismic navigation chrome (header, footer, sidebar, toolbar).
 * Preserves: document content body with <a href> hyperlinks.
 */
export function sanitizeViewerHtml(html: string): string {
  if (!html) return ''

  let result = html

  // 1. Remove <script> tags and content (including multiline)
  result = result.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
  // Handle self-closing script tags
  result = result.replace(/<script[^>]*\/>/gi, '')

  // 2. Remove <style> tags and content
  result = result.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')

  // 3. Remove <noscript> tags and content
  result = result.replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, '')

  // 4. Remove <meta> tags containing session/token strings
  result = result.replace(/<meta[^>]*>/gi, (match) => {
    const lower = match.toLowerCase()
    const hasToken = SESSION_TOKEN_KEYWORDS.some(kw => lower.includes(kw))
    return hasToken ? '' : match
  })

  // 5. Remove Seismic navigation chrome elements
  // Match elements with chrome class patterns and remove them and their content
  for (const pattern of SEISMIC_CHROME_PATTERNS) {
    // Build a regex that matches the opening tag with the chrome class,
    // captures the tag name, and removes everything through the closing tag
    result = result.replace(
      new RegExp(
        '<(nav|div|header|footer|aside)\\b[^>]*' + pattern.source + '[^>]*>[\\s\\S]*?<\\/\\1>',
        'gi',
      ),
      '',
    )
  }

  // 5a. Remove inline event handlers (onclick, onload, onerror, etc.) (#874)
  result = result.replace(/\s+on\w+="[^"]*"/gi, '')
  result = result.replace(/\s+on\w+='[^']*'/gi, '')

  // 5b. Remove sensitive data-attributes (#874)
  result = result.replace(/\s+data-(session|user|token|auth|csrf|tracking)[\w-]*="[^"]*"/gi, '')

  // 6. Clean up excessive whitespace from removals
  result = result.replace(/\n{3,}/g, '\n\n').trim()

  return result
}

/**
 * Checks if page inner text represents enrichable content (#859).
 * Returns false for: short content (<=500 chars), "content not found" pages,
 *                     "page not found" / 404 pages, YouTube embeds.
 */
export function isEnrichableContent(innerText: string): boolean {
  if (!innerText || innerText.length <= 500) return false

  // Check for "content not found" or "page not found" error pages
  const lower = innerText.toLowerCase()
  if (/content\s+not\s+found/i.test(lower)) return false
  if (/page\s+not\s+found/i.test(lower)) return false
  if (/^404\b/.test(innerText.trim())) return false

  // Check for YouTube embed pages
  if (/youtube\.com|youtu\.be/i.test(lower)) return false
  if (/watch\s+this\s+video\s+on\s+youtube/i.test(lower)) return false

  return true
}

// ── Navigation Page Detection (#874 follow-through) ─────────────────────────

/** Maximum sub-pages to follow from a single navigation page */
const MAX_SUB_PAGES = 10

/** Text length threshold — pages with more text are likely documents, not nav pages */
const NAV_PAGE_TEXT_LIMIT = 2000

/** Minimum internal links to qualify as a navigation/listing page */
const NAV_PAGE_MIN_LINKS = 3

/**
 * Extract internal (saleshub/seismic) links from raw HTML.
 * Parses <a href="..."> tags and filters to allowed domains.
 * Deduplicates by URL. Returns up to MAX_SUB_PAGES links.
 */
export function extractSubPageLinks(html: string): Array<{ name: string; url: string }> {
  const linkRegex = /<a\s+[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi
  const seen = new Set<string>()
  const links: Array<{ name: string; url: string }> = []

  let match: RegExpExecArray | null
  while ((match = linkRegex.exec(html)) !== null) {
    const href = match[1].trim()
    const rawText = match[2].replace(/<[^>]+>/g, '').trim()

    // Skip empty/hash-only hrefs
    if (!href || href === '#') continue

    // Only allow saleshub.redhat.com or seismic.com domains
    try {
      const url = new URL(href)
      if (!url.hostname.includes('saleshub.redhat.com') && !url.hostname.includes('seismic.com')) continue
    } catch {
      // Relative URL or invalid — skip (we require absolute URLs from page HTML)
      continue
    }

    // Deduplicate
    if (seen.has(href)) continue
    seen.add(href)

    const name = rawText || href
    links.push({ name, url: href })

    if (links.length >= MAX_SUB_PAGES) break
  }

  return links
}

/**
 * Detect whether a page is a navigation/listing page rather than a document.
 * A navigation page has:
 * - Short inner text (< NAV_PAGE_TEXT_LIMIT chars)
 * - 3+ internal links to saleshub.redhat.com or seismic.com
 *
 * Returns { isNavPage, links } where links are the extracted sub-page URLs.
 */
export function detectNavigationPage(
  innerText: string,
  html: string,
): { isNavPage: boolean; links: Array<{ name: string; url: string }> } {
  // If the page has substantial text content, it's a document page
  if (innerText.length >= NAV_PAGE_TEXT_LIMIT) {
    return { isNavPage: false, links: [] }
  }

  const links = extractSubPageLinks(html)

  return {
    isNavPage: links.length >= NAV_PAGE_MIN_LINKS,
    links,
  }
}

// Default product page URL -- OpenShift Virtualization (update with correct URL when known)
const DEFAULT_URL =
  'https://saleshub.redhat.com/apps/doccenter/1d1918e9-b5b0-4428-b8fc-87e02ad44156/doc/%252Fdd04d516a5-19b3-48c9-e01a-d2bf52939de4%252FdfMmNhNDhiYjktYzE1Ny00ZjgyLWJlYjUtNTdhY2NjZmY5Y2Rh%252CPT0%253D%252CUGFnZSBSSFNI%252Flf65319736-66ee-4ac2-92d5-6f720eb20d0d//'

function sanitizeFilename(name: string): string {
  return name.replace(/[/\\?%*:|"<>]/g, '_').slice(0, 200)
}

// ── Garbage Filters ──────────────────────────────────────────────────────────

const GARBAGE_PATTERNS = [
  /^arrow\s+(down|up|left|right)$/i,
  /item\(s\)\s*selected/i,
  /^displaying\s+slide\s+\d+\s+of\s+\d+$/i,
  /^sort$/i,
  /^columns$/i,
  /^show\s+(more|less)$/i,
  /^previous$/i,
  /^next$/i,
]

function isGarbage(text: string): boolean {
  const trimmed = text.trim()
  if (trimmed.length < 3) return true
  if (/^\s*$/.test(trimmed)) return true
  return GARBAGE_PATTERNS.some((p) => p.test(trimmed))
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
}

// ── Extraction Helpers ───────────────────────────────────────────────────────

/**
 * Extract all link items from a container element.
 * Finds <a> tags and builds SectionItem for each.
 */
async function extractLinkList(container: Locator): Promise<SectionItem[]> {
  const items: SectionItem[] = []
  const links = container.locator('a[href]')
  const count = await links.count()

  for (let i = 0; i < count; i++) {
    const link = links.nth(i)
    const name = (await link.innerText().catch(() => '')).trim()
    const href = (await link.getAttribute('href')) ?? ''

    if (!name || isGarbage(name)) continue

    const url = href.startsWith('http') ? href : href ? `https://saleshub.redhat.com${href}` : undefined

    items.push({ name, url: url || undefined })
  }

  return items
}

/**
 * Extract card carousel items.
 * Cards typically have a thumbnail image and a title, sometimes in a card-like container.
 * Tries multiple common Seismic card patterns.
 */
async function extractCardCarousel(container: Locator): Promise<SectionItem[]> {
  const items: SectionItem[] = []

  // Try common card selectors -- Seismic uses various card patterns
  const cardSelectors = [
    '[class*="card"]',
    '[class*="Card"]',
    '[class*="tile"]',
    '[class*="Tile"]',
    '[class*="carousel-item"]',
    '[class*="slide"]',
    '[role="listitem"]',
  ]

  for (const selector of cardSelectors) {
    const cards = container.locator(selector)
    const count = await cards.count()
    if (count === 0) continue

    for (let i = 0; i < count; i++) {
      const card = cards.nth(i)

      // Get card title -- try heading, then link text, then aria-label
      let name = ''
      const heading = card.locator('h2, h3, h4, h5, [class*="title"], [class*="Title"]').first()
      if ((await heading.count()) > 0) {
        name = (await heading.innerText().catch(() => '')).trim()
      }
      if (!name) {
        const link = card.locator('a').first()
        if ((await link.count()) > 0) {
          name = (await link.innerText().catch(() => '')).trim()
        }
      }
      if (!name) {
        name = (await card.getAttribute('aria-label')) ?? ''
      }

      if (!name || isGarbage(name)) continue

      // Get URL from first link in card
      const cardLink = card.locator('a[href]').first()
      let url: string | undefined
      if ((await cardLink.count()) > 0) {
        const href = (await cardLink.getAttribute('href')) ?? ''
        url = href.startsWith('http')
          ? href
          : href
            ? `https://saleshub.redhat.com${href}`
            : undefined
      }

      // Get description
      const descEl = card.locator('p, [class*="desc"], [class*="Desc"], [class*="summary"]').first()
      const description = (await descEl.innerText().catch(() => '')).trim() || undefined

      items.push({ name, url, description })
    }

    if (items.length > 0) break // Use the first selector that produces results
  }

  return items
}

/**
 * Extract data table rows.
 * Tables may have column headers and sortable columns.
 */
async function extractDataTable(container: Locator): Promise<SectionItem[]> {
  const items: SectionItem[] = []

  // Try standard table rows
  const rows = container.locator('table tbody tr, [role="row"]')
  const rowCount = await rows.count()

  if (rowCount === 0) {
    // Fallback: try grid-like structures
    const gridItems = container.locator('[role="gridcell"] a, [class*="row"] a[href]')
    const gridCount = await gridItems.count()
    for (let i = 0; i < gridCount; i++) {
      const link = gridItems.nth(i)
      const name = (await link.innerText().catch(() => '')).trim()
      const href = (await link.getAttribute('href')) ?? ''
      if (!name || isGarbage(name)) continue
      const url = href.startsWith('http') ? href : href ? `https://saleshub.redhat.com${href}` : undefined
      items.push({ name, url: url || undefined })
    }
    return items
  }

  for (let i = 0; i < rowCount; i++) {
    const row = rows.nth(i)
    const cells = row.locator('td, [role="gridcell"]')
    const cellCount = await cells.count()
    if (cellCount === 0) continue

    // First cell with a link is the primary item
    const firstLink = row.locator('a[href]').first()
    let name = ''
    let url: string | undefined

    if ((await firstLink.count()) > 0) {
      name = (await firstLink.innerText().catch(() => '')).trim()
      const href = (await firstLink.getAttribute('href')) ?? ''
      url = href.startsWith('http') ? href : href ? `https://saleshub.redhat.com${href}` : undefined
    } else {
      // No link -- use first cell text
      name = (await cells.first().innerText().catch(() => '')).trim()
    }

    if (!name || isGarbage(name)) continue

    // Second cell often has a description or type
    let description: string | undefined
    if (cellCount > 1) {
      description = (await cells.nth(1).innerText().catch(() => '')).trim() || undefined
    }

    items.push({ name, url: url || undefined, description })
  }

  return items
}

/**
 * Extract expandable/accordion sections.
 * Clicks each expand trigger, waits for content, then extracts children.
 */
async function extractAccordionSections(
  page: Page,
  container: Locator,
): Promise<ProductSection[]> {
  const sections: ProductSection[] = []

  // Common accordion trigger selectors
  const triggerSelectors = [
    '[class*="accordion"] [class*="header"]',
    '[class*="Accordion"] [class*="Header"]',
    '[class*="expandable"] [class*="trigger"]',
    '[role="button"][aria-expanded]',
    'details summary',
    '[class*="collapsible"] [class*="title"]',
  ]

  for (const selector of triggerSelectors) {
    const triggers = container.locator(selector)
    const count = await triggers.count()
    if (count === 0) continue

    for (let i = 0; i < count; i++) {
      const trigger = triggers.nth(i)
      const title = (await trigger.innerText().catch(() => '')).trim()
      if (!title || isGarbage(title)) continue

      // Check if already expanded
      const expanded = await trigger.getAttribute('aria-expanded')
      if (expanded !== 'true') {
        try {
          await trigger.click({ timeout: 3000 })
          await page.waitForTimeout(500) // Wait for expand animation
        } catch {
          // Click failed -- may be non-interactive
        }
      }

      // Extract content from the expanded area
      const parent = trigger.locator('..')
      const contentArea = parent.locator(
        '[class*="content"], [class*="Content"], [class*="body"], [class*="Body"], [class*="panel"], [class*="Panel"]',
      ).first()

      let items: SectionItem[] = []
      if ((await contentArea.count()) > 0) {
        items = await extractLinkList(contentArea)
      }

      if (items.length > 0 || title) {
        sections.push({
          title,
          type: 'accordion',
          items,
        })
      }
    }

    if (sections.length > 0) break
  }

  return sections
}

/**
 * Detect the content type of a section by examining DOM structure.
 */
async function detectSectionType(
  container: Locator,
): Promise<ProductSection['type']> {
  // Check for data table
  if ((await container.locator('table, [role="grid"]').count()) > 0) {
    return 'table'
  }

  // Check for card carousel
  if (
    (await container.locator('[class*="carousel"], [class*="Carousel"], [class*="slider"]').count()) > 0 ||
    (await container.locator('[class*="card"], [class*="Card"], [class*="tile"]').count()) > 2
  ) {
    return 'cards'
  }

  // Check for accordion
  if (
    (await container.locator('[class*="accordion"], [class*="Accordion"], [role="button"][aria-expanded], details').count()) > 0
  ) {
    return 'accordion'
  }

  // Check for link list (multiple links in a list-like structure)
  const linkCount = await container.locator('a[href]').count()
  const listItems = await container.locator('li, [role="listitem"]').count()
  if (linkCount > 2 && listItems > 2) {
    return 'links'
  }

  // Check for plain text content
  const text = (await container.innerText().catch(() => '')).trim()
  if (text.length > 50 && linkCount <= 2) {
    return 'text'
  }

  return 'mixed'
}

// ── Main Section Extraction ──────────────────────────────────────────────────

/**
 * Walk all red header bars on the page and extract content between them.
 *
 * Red header bars in Seismic DocCenter are section dividers with a distinctive
 * red/dark-red background and white text. This function tries multiple CSS
 * selectors to locate them, then extracts content between each pair.
 *
 * ASSUMPTION: The exact CSS classes are unknown until we run against a real page.
 * These selectors are best guesses based on typical Seismic DocCenter patterns.
 * They will need tuning after a first run.
 */
async function extractRedHeaderSections(
  page: Page,
): Promise<{ sections: Record<string, ProductSection>; domainDocLookup: Map<string, string> }> {
  const sections: Record<string, ProductSection> = {}

  // Strategy: Combine red divider bars (.seismic-page-divider-view) with
  // non-divider h1 content headings (Business decks, Key resources, etc.)
  // to build a complete section map. Sort by y-position and extract content
  // between each pair.
  //
  // Discovered from real DOM (2026-06-15):
  //   - Red dividers: h1.seismic-page-divider-view (Product news, Customer References, etc.)
  //   - Content headings: h1.seismic-page-docListPicker-Viewer-title (Business decks, etc.)
  //   - Sidebar headings to SKIP: "Ask on Slack:", "Contact us:", "Content Details", etc.

  // DOM-container approach: Seismic DocCenter renders the main content area as a flat list
  // of `articleSdk-theme-page-WidgetContainer` siblings. Each widget is either:
  //   - seismic-page-widget-cover (product title)
  //   - seismic-page-widget-paragraph (text content)
  //   - seismic-page-widget-divider (red header bar — section separator)
  //   - homepage-widgets-loaded (content: decks, resources, cards)
  //   - seismic-page-widget-accordion (expandable: services, training)
  //
  // Pattern: divider widget → content widget(s) → next divider. Extract links from
  // the content widget's DOM children, not by geometric positioning.

  const widgetSections = await page.evaluate(() => {
    const mainColumn = document.querySelector('.articleSdk-theme-page-doubleColumn-main')
    if (!mainColumn) return []

    const widgets = Array.from(mainColumn.children) as HTMLElement[]
    const result: Array<{
      title: string
      widgetClass: string
      links: Array<{ text: string; href: string }>
      tableRows: Array<{ name: string; description: string }>
      textContent: string
      isAccordion: boolean
      /** For accordion widgets: maps accordion heading → document names under it (#858) */
      domainDocMap: Array<{ domain: string; docNames: string[] }>
    }> = []

    let currentTitle = ''
    let currentLinks: Array<{ text: string; href: string }> = []
    let currentTableRows: Array<{ name: string; description: string }> = []
    let currentText = ''
    let isAccordion = false
    let currentDomainDocMap: Array<{ domain: string; docNames: string[] }> = []

    for (const widget of widgets) {
      const cls = widget.className || ''
      const isDivider = cls.includes('seismic-page-widget-divider')
      const isCover = cls.includes('seismic-page-widget-cover')
      const isParagraph = cls.includes('seismic-page-widget-paragraph')
      const isAccordionWidget = cls.includes('seismic-page-widget-accordion')

      if (isDivider) {
        // Save previous section if it has content
        if (currentTitle && currentTitle !== '__pending__' && (currentLinks.length > 0 || currentTableRows.length > 0 || currentText)) {
          result.push({ title: currentTitle, widgetClass: cls, links: currentLinks, tableRows: currentTableRows, textContent: currentText, isAccordion, domainDocMap: currentDomainDocMap })
        }
        // Start new section from divider text
        const dividerText = (widget.textContent || '').trim()
        if (dividerText.length > 2) {
          currentTitle = dividerText
        } else {
          // Empty divider — next content widget provides the title
          currentTitle = '__pending__'
        }
        currentLinks = []
        currentTableRows = []
        currentText = ''
        isAccordion = false
        currentDomainDocMap = []
        continue
      }

      if (isCover) continue // Skip product banner

      // Content widget — extract links
      const isContentWidget = !isDivider && !isCover

      if (isContentWidget) {
        // Handle accordion widgets specially — each has its own title
        if (isAccordionWidget) {
          // Save previous section
          if (currentTitle && currentTitle !== '__pending__' && (currentLinks.length > 0 || currentTableRows.length > 0 || currentText)) {
            result.push({ title: currentTitle, widgetClass: '', links: currentLinks, tableRows: currentTableRows, textContent: currentText, isAccordion, domainDocMap: currentDomainDocMap })
          }
          isAccordion = true
          const accTitle = widget.querySelector('.seismic-page-divider-view')
          currentTitle = accTitle ? (accTitle.textContent || '').trim() : 'Untitled'
          currentLinks = []
          currentTableRows = []
          currentText = ''
          currentDomainDocMap = []

          // (#858 Fix 2) Extract domain-to-document mapping from accordion sub-sections.
          // Each accordion panel has a heading (domain name) and a DocListPicker table
          // with document names. Build a mapping so CDS-intercepted documents can be
          // tagged with their domain.
          const accordionPanels = widget.querySelectorAll(
            '[class*="accordion"] [class*="panel"], ' +
            '[class*="accordion"] [class*="content"], ' +
            '[class*="Accordion"] [class*="Panel"], ' +
            '[class*="expandable"] [class*="content"]'
          )
          for (const panel of accordionPanels) {
            // Find the heading for this accordion panel — look for the trigger/header sibling
            const parentItem = panel.closest(
              '[class*="accordion-item"], [class*="AccordionItem"], ' +
              '[class*="expandable-item"], [class*="pf-v5-c-accordion__expanded-content"]'
            ) || panel.parentElement
            if (!parentItem) continue
            const heading = parentItem.querySelector(
              '[class*="header"], [class*="trigger"], [class*="toggle"], ' +
              '[class*="Header"], button[class*="accordion"]'
            )
            const domainName = heading ? (heading.textContent || '').trim() : ''
            if (!domainName || domainName.length < 3) continue

            // Collect document names from links inside this panel
            const docLinks = panel.querySelectorAll('a[href]')
            const docNames: string[] = []
            for (const a of docLinks) {
              const text = (a.textContent || '').trim().slice(0, 200)
              if (text.length > 3) docNames.push(text)
            }
            if (docNames.length > 0) {
              currentDomainDocMap.push({ domain: domainName, docNames })
            }
          }
        }

        // If title is pending (after empty divider), use this widget's own heading
        if (currentTitle === '__pending__' || !currentTitle) {
          // Look for h1/h2 heading inside this widget
          const heading = widget.querySelector('h1, h2')
          if (heading) {
            currentTitle = (heading.textContent || '').trim()
          } else {
            currentTitle = 'Untitled Section'
          }
        }

        // If this widget contains MULTIPLE sub-sections (e.g., "Business decks" + "Technical decks" side by side)
        // Check for multiple h1 headings within the widget
        const h1s = widget.querySelectorAll('h1')
        if (h1s.length >= 2 && !isAccordionWidget) {
          // Multiple sub-sections in one widget — split by h1
          for (const h1 of h1s) {
            const subTitle = (h1.textContent || '').trim()
            if (subTitle.length < 3) continue
            // Find the container that holds this h1 and its content
            const subContainer = h1.closest('[class*="docListPicker"], [class*="DocListPicker"]') || h1.parentElement
            if (!subContainer) continue
            const subLinks: Array<{text: string, href: string}> = []
            const subAnchors = subContainer.querySelectorAll('a[href]')
            for (const a of subAnchors) {
              const text = (a.textContent || '').trim().slice(0, 200)
              const href = (a as HTMLAnchorElement).href || ''
              if (text.length > 3 && href.startsWith('http') && !href.includes('/app#/workspace')) {
                subLinks.push({ text, href })
              }
            }
            if (subLinks.length > 0 || subTitle) {
              result.push({ title: subTitle, widgetClass: '', links: subLinks, tableRows: [], textContent: '', isAccordion: false, domainDocMap: [] })
            }
          }
          // Don't add to currentLinks — we already split into sub-sections
          continue
        }

        // (#858 Fix 1) Extract table rows — TDP & Sales Tactics tables have
        // two-column rows: tactic name + rich description, with no links.
        const tables = widget.querySelectorAll('table')
        for (const table of tables) {
          const rows = table.querySelectorAll('tbody tr, tr')
          for (const row of rows) {
            const cells = row.querySelectorAll('td')
            if (cells.length < 2) continue
            const name = (cells[0].textContent || '').trim()
            const description = (cells[1].textContent || '').trim()
            if (name.length > 3 && description.length > 10) {
              currentTableRows.push({ name: name.slice(0, 200), description: description.slice(0, 2000) })
            }
          }
        }

        // Extract all links from this widget
        const anchors = widget.querySelectorAll('a[href]')
        for (const a of anchors) {
          const text = (a.textContent || '').trim().slice(0, 200)
          const href = (a as HTMLAnchorElement).href || ''
          if (text.length > 3 && href.startsWith('http') && !href.includes('/app#/workspace')) {
            currentLinks.push({ text, href })
          }
        }

        // Extract text content for paragraph widgets
        if (isParagraph) {
          const pText = (widget.textContent || '').trim()
          if (pText.length > 10) currentText = pText.slice(0, 1000)
        }
      }
    }

    // Don't forget the last section
    if (currentTitle && (currentLinks.length > 0 || currentTableRows.length > 0 || currentText)) {
      result.push({ title: currentTitle, widgetClass: '', links: currentLinks, tableRows: currentTableRows, textContent: currentText, isAccordion, domainDocMap: currentDomainDocMap })
    }

    return result
  })

  console.log(`[product-scraper] Found ${widgetSections.length} widget sections:`)
  for (const ws of widgetSections) {
    const tableInfo = ws.tableRows.length > 0 ? `, ${ws.tableRows.length} table rows` : ''
    const domainInfo = ws.domainDocMap.length > 0 ? `, ${ws.domainDocMap.length} domain maps` : ''
    console.log(`  "${ws.title.slice(0, 50)}" — ${ws.links.length} links${tableInfo}${domainInfo}, ${ws.textContent.length} chars text${ws.isAccordion ? ' [accordion]' : ''}`)
  }

  if (widgetSections.length < 1) {
    console.warn('[product-scraper] No widget sections found. Falling back to all page links.')
    const allItems = await extractLinkList(page.locator('main, [role="main"], #content, body'))
    if (allItems.length > 0) {
      sections['all-content'] = { title: 'All Content', type: 'links', items: allItems }
    }
    return { sections, domainDocLookup: new Map() }
  }

  // (#858 Fix 2) Build a global domain-to-document-name mapping from all accordion sections.
  // This will be used later to tag CDS-intercepted and API-merged documents with their domain.
  const domainDocLookup = new Map<string, string>() // docName (lowercased, first 50 chars) → domain
  for (const ws of widgetSections) {
    for (const { domain, docNames } of ws.domainDocMap) {
      for (const docName of docNames) {
        domainDocLookup.set(docName.toLowerCase().slice(0, 50), domain)
      }
    }
  }
  if (domainDocLookup.size > 0) {
    console.log(`[product-scraper] Domain-document mapping: ${domainDocLookup.size} documents across ${new Set(domainDocLookup.values()).size} domains`)
  }

  // Convert widget sections to ProductSection objects
  for (const ws of widgetSections) {
    const title = ws.title
    if (!title || title === '__pre-divider__' || isGarbage(title)) continue

    const sectionKey = slugify(title)

    // Deduplicate links
    const seen = new Set<string>()
    const items: SectionItem[] = []
    for (const link of ws.links) {
      if (isGarbage(link.text)) continue
      const key = link.text.slice(0, 50) + '|' + link.href
      if (seen.has(key)) continue
      seen.add(key)
      const item: SectionItem = { name: link.text, url: link.href }
      // Tag with domain if this document appears in a domain accordion (#858)
      const domain = domainDocLookup.get(link.text.toLowerCase().slice(0, 50))
      if (domain) item.domain = domain
      items.push(item)
    }

    // (#858 Fix 1) Add table rows as SectionItem entries with itemType 'tactic'
    for (const row of ws.tableRows) {
      if (isGarbage(row.name)) continue
      const key = row.name.slice(0, 50) + '|__table__'
      if (seen.has(key)) continue
      seen.add(key)
      items.push({ name: row.name, description: row.description, itemType: 'tactic' })
    }

    const type: ProductSection['type'] = ws.isAccordion ? 'accordion'
      : ws.tableRows.length > 0 ? 'table'
      : 'mixed'

    // Build textContent — include table row descriptions for TDP sections (#858)
    let textContent = ws.textContent || ''
    if (ws.tableRows.length > 0) {
      const tableText = ws.tableRows.map(r => `${r.name}: ${r.description}`).join('\n\n')
      textContent = textContent ? `${textContent}\n\n${tableText}` : tableText
    }

    if (items.length > 0) {
      sections[sectionKey] = {
        title,
        textContent: textContent || undefined,
        type,
        items,
      }
      console.log(`[product-scraper] Section "${title}" (${type}): ${items.length} items`)
    }
  }

  return { sections, domainDocLookup }
}

/**
 * Extract sidebar widgets: TDP links, contacts, Slack channels, product links.
 */
async function extractSidebar(page: Page): Promise<{
  tdpLinks: Array<{ name: string; url?: string }>
  contacts: Array<{ name: string; email?: string; role?: string }>
  slackChannels: string[]
  links: Array<{ name: string; url?: string }>
}> {
  const result = {
    tdpLinks: [] as Array<{ name: string; url?: string }>,
    contacts: [] as Array<{ name: string; email?: string; role?: string }>,
    slackChannels: [] as string[],
    links: [] as Array<{ name: string; url?: string }>,
  }

  // Seismic DocCenter puts TDPs, Slack, Contacts in the page body, not a CSS sidebar.
  // Extract by searching the full page text for known patterns.
  console.log('[product-scraper] Extracting sidebar content...')

  const sidebarData = await page.evaluate(() => {
    const fullText = document.body.innerText || ''
    const data = {
      tdpNames: [] as string[],
      emails: [] as string[],
      slackChannels: [] as string[],
      sidebarLinks: [] as Array<{name: string, url: string}>,
    }

    // Find TDP names — look for the "TDP and Tactic" section
    const tdpMatch = fullText.match(/TDP and Tactic[s]?\s*\n([\s\S]*?)(?=\n(?:Product news|Business decks|$))/i)
    if (tdpMatch) {
      const tdpBlock = tdpMatch[1]
      const lines = tdpBlock.split('\n').map(l => l.trim()).filter(l => l.length > 3 && !l.includes('item(s) selected'))
      data.tdpNames = lines
    }

    // Find emails
    const emailMatches = fullText.match(/[\w.-]+@[\w.-]+\.\w+/g)
    if (emailMatches) data.emails = [...new Set(emailMatches)]

    // Find Slack channels
    const slackMatches = fullText.match(/#[a-z][a-z0-9_-]+/gi)
    if (slackMatches) data.slackChannels = [...new Set(slackMatches)]

    // Find sidebar links (product page links, learning paths, etc.)
    // Look for links near "Contact us" or in the right-side area
    const rightLinks = document.querySelectorAll('[class*="navigationPicker"] a[href], [class*="brand-link"] a[href]')
    for (const el of rightLinks) {
      const text = (el.textContent || '').trim()
      const href = (el as HTMLAnchorElement).href || ''
      if (text.length > 3 && href.startsWith('http')) {
        data.sidebarLinks.push({ name: text.slice(0, 100), url: href })
      }
    }

    return data
  })

  // TDP links
  for (const name of sidebarData.tdpNames) {
    result.tdpLinks.push({ name })
  }

  // Contacts
  for (const email of sidebarData.emails) {
    result.contacts.push({ name: email.split('@')[0], email })
  }

  // Slack channels
  result.slackChannels = sidebarData.slackChannels

  // Other links
  result.links = sidebarData.sidebarLinks

  console.log(
    `[product-scraper] Sidebar: ${result.tdpLinks.length} TDPs, ${result.contacts.length} contacts, ${result.slackChannels.length} Slack channels, ${result.links.length} other links`,
  )

  return result
}

/**
 * Extract the product name and description from the page header area.
 */
async function extractProductHeader(page: Page): Promise<{ name: string; description: string }> {
  // Try common header patterns
  const headerSelectors = [
    'h1',
    '[class*="page-title"]',
    '[class*="PageTitle"]',
    '[class*="doc-title"]',
    '[class*="DocTitle"]',
  ]

  let name = ''
  for (const sel of headerSelectors) {
    const el = page.locator(sel).first()
    if ((await el.count()) > 0) {
      name = (await el.innerText().catch(() => '')).trim()
      if (name) break
    }
  }

  // Get description — first substantial text block before the first red divider
  let description = ''
  try {
    description = await page.evaluate((productName) => {
      // Find the first red divider position
      const firstDivider = document.querySelector('.seismic-page-divider-view')
      const dividerY = firstDivider ? firstDivider.getBoundingClientRect().top + window.scrollY : Infinity

      // Look for paragraph or text-block elements BEFORE the first divider
      const candidates = document.querySelectorAll('p, [class*="text-block"], [class*="TextBlock"], [class*="seismic-page-text"]')
      for (const el of candidates) {
        const rect = el.getBoundingClientRect()
        const y = rect.top + window.scrollY
        if (y >= dividerY) break // Past the first divider
        const text = (el.textContent || '').trim()
        // Must be substantial, not the title, not navigation
        if (text.length > 50 && !text.startsWith(productName) && !text.includes('Skip to Main') &&
            !text.includes('All Sales Content') && !text.includes('Page RHSH')) {
          return text.slice(0, 500)
        }
      }
      return ''
    }, name)
  } catch { /* description is optional */ }

  return { name: name || 'Unknown Product', description }
}

// ── Seismic API: Query documents by product name ────────────────────────────

async function queryDocumentsByProduct(
  page: Page,
  authCtx: { auth: string; searchUrl: string; headers: Record<string, string> },
  productName: string,
): Promise<DocCenterDocument[]> {
  const body = {
    SearchTerm: '',
    Page: { PageIndex: 0, PageSize: 100 },
    Sort: 'Standard',
    Filter: {
      AppType: 'DocCenter',
      SeismicProperties: [{ PropName: 'ProfileVersions', Values: [PROFILE_VERSION_ID] }],
      ExcludedAppTypes: ['ControlCenter', 'NewsCenter', 'WorkSpace'],
      ExcludeFolder: false,
      Folder: { FolderPath: 'root', ProfileVersionId: PROFILE_VERSION_ID },
      IncludeSubFolder: true,
      CustomProperties: [
        { PropName: 'Product', Values: [productName] },
      ],
    },
    DynamicFilter: { operator: 'and', conditions: [] },
    IncludeAppTypeFacet: true,
    DisableDidYouMean: false,
    SortOrder: 'default',
    EnableMultiFacetSearch: true,
    PermissionWorkflow: { WorkflowType: 'view' },
    Options: { WithAggregation: false, WithDocument: true },
  }

  const response = await page.evaluate(async (args) => {
    const res = await fetch(args.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: args.auth,
        profileversionid: args.pvid,
        teamsiteid: args.tsid ?? '1',
        'x-seismic-route': args.route ?? '',
        seismicclientname: args.client ?? '',
      },
      body: JSON.stringify(args.body),
    })
    return res.json()
  }, {
    url: authCtx.searchUrl,
    auth: authCtx.auth,
    pvid: PROFILE_VERSION_ID,
    tsid: authCtx.headers.teamsiteid,
    route: authCtx.headers['x-seismic-route'],
    client: authCtx.headers.seismicclientname,
    body,
  })

  return parseDocumentsFromApiResponse(response)
}

// ── Main ─────────────────────────────────────────────────────────────────────

// ── Accordion expansion (#874) ──────────────────────────────────────────────

/**
 * Expands all collapsed accordion sections on a product page.
 * Must be called BEFORE extractRedHeaderSections() so DOM extraction
 * sees content inside collapsed accordions.
 */
export async function expandAllAccordions(page: Page): Promise<number> {
  console.log('[product-scraper] Expanding all accordion sections on page...')

  const collapsedAccordions = page.locator(
    '[class*="accordion"] [class*="chevron-down"], ' +
    '[class*="accordion"][class*="collapsed"], ' +
    '[class*="expandable"]:not([class*="expanded"])'
  )
  const accordionCount = await collapsedAccordions.count()
  console.log(`[product-scraper] Found ${accordionCount} collapsed accordion sections`)
  for (let a = 0; a < accordionCount; a++) {
    try {
      const accordion = collapsedAccordions.nth(a)
      await accordion.click()
      await page.waitForTimeout(800)
    } catch (e: any) {
      console.warn(`[product-scraper] Could not expand accordion ${a}: ${(e.message ?? '').slice(0, 60)}`)
    }
  }
  await page.waitForTimeout(1_500)
  return accordionCount
}

// ── Per-product document download (SC-2) ────────────────────────────────────

// ── Viewer Follow-Through Extraction (#874) ─────────────────────────────────
// When a viewer URL points to a navigation/listing page instead of a document,
// follow internal links to find the actual documents (one level deep).

/** Content selectors for Seismic viewer pages — most specific first */
const VIEWER_CONTENT_SELECTORS = [
  '.articleSdk-theme-page-doubleColumn-main',
  '.seismic-page-content',
  '[class*="document-content"]',
  '[class*="viewer-content"]',
  '[role="main"]',
  'main',
  'article',
]

/**
 * Extract content from a single viewer page.
 * Returns sanitized HTML if enrichable, or null with a skip reason.
 */
async function extractSinglePage(
  context: BrowserContext,
  url: string,
): Promise<{ content: string | null; reason?: string; contentLength?: number }> {
  const page = await context.newPage()
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    await page.waitForTimeout(3_000)

    const innerText = await page.innerText('body').catch(() => '')

    // Check for content-not-found pages
    if (/content\s+not\s+found|page\s+not\s+found|error\s+404/i.test(innerText.slice(0, 500))) {
      return { content: null, reason: 'Content not found' }
    }

    // Check for iframe-only pages
    const hasIframes = await page.locator('iframe').count()
    if (hasIframes > 0 && innerText.length <= 500) {
      return { content: null, reason: 'iframe-only page' }
    }

    // Content validation
    if (!isEnrichableContent(innerText)) {
      // Not enrichable — but might be a navigation page
      const bodyHtml = await page.evaluate(() => document.body.innerHTML).catch(() => '')
      const navResult = detectNavigationPage(innerText, bodyHtml)
      if (navResult.isNavPage) {
        return { content: null, reason: '__nav_page__', contentLength: navResult.links.length }
      }
      return { content: null, reason: `Insufficient content (${innerText.length} chars)`, contentLength: innerText.length }
    }

    // Extract content via page.evaluate()
    const rawHtml = await page.evaluate((selectors) => {
      for (const sel of selectors) {
        const el = document.querySelector(sel)
        if (el && el.innerHTML.length > 200) return el.innerHTML
      }
      return document.body.innerHTML
    }, VIEWER_CONTENT_SELECTORS)

    const sanitizedHtml = sanitizeViewerHtml(rawHtml)
    if (sanitizedHtml.length < 100) {
      return { content: null, reason: `Sanitized content too short (${sanitizedHtml.length} chars)`, contentLength: sanitizedHtml.length }
    }

    return { content: sanitizedHtml, contentLength: sanitizedHtml.length }
  } finally {
    await page.close()
  }
}

/**
 * Extract viewer content with follow-through for navigation pages.
 *
 * When a URL opens a document page → extract content directly.
 * When a URL opens a navigation/listing page → follow internal links
 * one level deep and extract each sub-page document.
 *
 * Maximum follow depth: 1 level. Maximum sub-pages per parent: 10.
 * Only follows links to saleshub.redhat.com or seismic.com domains.
 */
async function extractWithFollowThrough(
  context: BrowserContext,
  item: SectionItem,
  sectionKey: string,
  productDir: string,
): Promise<{
  extracted: Array<{ name: string; content: string; followedFrom?: string; filePath?: string }>
  skipped: string[]
}> {
  const extracted: Array<{ name: string; content: string; followedFrom?: string; filePath?: string }> = []
  const skipped: string[] = []
  const sectionSlug = slugify(sectionKey)
  const extractDir = resolve(productDir, 'extracted', sectionSlug)

  if (!item.url) {
    skipped.push(`${item.name}: No URL`)
    return { extracted, skipped }
  }

  // Try direct extraction first
  const directResult = await extractSinglePage(context, item.url)

  if (directResult.content) {
    // Direct extraction succeeded — it's a document page
    const extractFilename = `${sanitizeFilename(item.name)}.html`
    const extractPath = resolve(extractDir, extractFilename)
    mkdirSync(extractDir, { recursive: true })
    writeFileSync(extractPath, directResult.content, 'utf-8')
    extracted.push({
      name: item.name,
      content: directResult.content,
      filePath: relative(productDir, extractPath),
    })
    console.log(`[product-scraper] Extracted: ${item.name.slice(0, 50)} (${directResult.contentLength} chars)`)
    return { extracted, skipped }
  }

  // Not directly enrichable — check if it's a navigation page
  if (directResult.reason !== '__nav_page__') {
    // Not a nav page either — genuinely unenrichable
    skipped.push(`${item.name}: ${directResult.reason}`)
    return { extracted, skipped }
  }

  // It's a navigation page — follow through to sub-pages
  console.log(`[product-scraper] Navigation page detected: ${item.name.slice(0, 50)} — following ${directResult.contentLength} links`)

  // Re-open the page to get the links (extractSinglePage closed it)
  const navPage = await context.newPage()
  let subPageLinks: Array<{ name: string; url: string }> = []
  try {
    await navPage.goto(item.url, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    await navPage.waitForTimeout(3_000)
    const bodyHtml = await navPage.evaluate(() => document.body.innerHTML).catch(() => '')
    subPageLinks = extractSubPageLinks(bodyHtml)
  } finally {
    await navPage.close()
  }

  // Follow each sub-page link sequentially (max MAX_SUB_PAGES)
  for (const link of subPageLinks.slice(0, MAX_SUB_PAGES)) {
    try {
      const subResult = await extractSinglePage(context, link.url)
      if (subResult.content) {
        const subName = `${sanitizeFilename(item.name)}--${sanitizeFilename(link.name)}`
        const subFilename = `${subName}.html`
        const subPath = resolve(extractDir, subFilename)
        mkdirSync(extractDir, { recursive: true })
        writeFileSync(subPath, subResult.content, 'utf-8')
        extracted.push({
          name: `${item.name} > ${link.name}`,
          content: subResult.content,
          followedFrom: item.name,
          filePath: relative(productDir, subPath),
        })
        console.log(`[product-scraper] Followed ${item.name.slice(0, 30)} -> ${link.name.slice(0, 30)} (${subResult.contentLength} chars)`)
      } else {
        skipped.push(`${item.name} > ${link.name}: ${subResult.reason}`)
      }
    } catch (e: any) {
      skipped.push(`${item.name} > ${link.name}: ${(e.message ?? 'Unknown error').slice(0, 100)}`)
      console.warn(`[product-scraper] Sub-page failed: ${link.name.slice(0, 50)}: ${(e.message ?? '').slice(0, 80)}`)
    }

    // Brief pause between sub-page extractions
    await new Promise(r => setTimeout(r, 500))
  }

  if (extracted.length === 0) {
    skipped.push(`${item.name}: Navigation page with 0 enrichable sub-pages`)
  }

  return { extracted, skipped }
}

async function downloadProductDocuments(
  page: Page,
  context: BrowserContext,
  sections: Record<string, ProductSection>,
  productSlug: string,
  authCtx: { auth: string; headers: Record<string, string>; searchUrl: string },
): Promise<void> {
  // ── Phase 1: Expand all accordion sections (safety net — may re-collapse) ──
  await expandAllAccordions(page)

  // ── Phase 1b: Auth canary — fail fast if auth is expired (#874) ──────────
  const canary = await authCanaryCheck(authCtx, sections)
  if (!canary.ok) {
    console.log(`[product-scraper] ${canary.reason} — skipping all downloads`)
    return
  }

  // ── Phase 2: Build download queue from ALL sections ─────────────────────
  // Iterate all sections from the scraped page data (AC-1, ANTI-2: all sections,
  // not just Domains). Each item with a URL gets a viewer download attempt first,
  // followed by a three-dot menu fallback if the viewer fails.
  const productDir = resolve('config-templates', 'saleshub-products', productSlug)
  let downloaded = 0
  let skipped = 0
  let errors = 0
  let consecutiveFailures = 0
  const CIRCUIT_BREAKER = 5
  let totalProcessed = 0
  const failedDownloads: Array<{ name: string; section: string; format: string; versionId: string; error: string; attempts: number }> = []

  // Build cross-section contentId/versionId lookup (#857)
  // API merge groups by content type, but DOM items are in different sections.
  // This ensures every item gets contentId/versionId if ANY matching item has it.
  const idLookup = new Map<string, { contentId: string; versionId: string }>()
  for (const section of Object.values(sections)) {
    for (const item of section.items) {
      if (item.contentId && item.versionId) {
        idLookup.set(item.name.toLowerCase().slice(0, 50), { contentId: item.contentId, versionId: item.versionId })
      }
    }
  }
  if (idLookup.size > 0) {
    for (const section of Object.values(sections)) {
      for (const item of section.items) {
        if (!item.contentId || !item.versionId) {
          const match = idLookup.get(item.name.toLowerCase().slice(0, 50))
          if (match) { item.contentId = match.contentId; item.versionId = match.versionId }
        }
      }
    }
    console.log(`[product-scraper] Cross-section ID propagation: ${idLookup.size} items with contentId`)
  }

  // Collect all downloadable items from ALL sections (ANTI-2: not Domain-only)
  const downloadQueue: Array<{ item: SectionItem; sectionKey: string; sectionTitle: string }> = []
  for (const [sectionKey, section] of Object.entries(sections)) {
    for (const item of section.items) {
      // Items with contentId+versionId can be downloaded via API even without a URL (#857)
      const hasApiPath = Boolean(item.contentId && item.versionId)
      if (!item.url && !hasApiPath) continue

      // Skip formats that are not downloadable documents (AC-A1)
      const itemFormat = ((item as any).format ?? '').toUpperCase()
      const seismicType = ((item as any).seismicContentType ?? '').toLowerCase()
      if (itemFormat && SKIP_FORMATS.has(itemFormat)) {
        console.log(`[product-scraper] Skipping ${itemFormat}: ${item.name.slice(0, 50)}`)
        continue
      }
      // Also check URL patterns for skip formats
      const urlLower = (item.url ?? '').toLowerCase()
      if (urlLower.includes('youtube.com') || urlLower.includes('youtu.be')) {
        console.log(`[product-scraper] Skipping YouTube: ${item.name.slice(0, 50)}`)
        continue
      }

      // Skip non-English documents
      const isNonEnglish = isNonEnglishDoc(item.name)
      if (isNonEnglish) {
        console.log(`[product-scraper] Skipping non-English: ${item.name.slice(0, 50)}`)
        continue
      }

      downloadQueue.push({ item, sectionKey, sectionTitle: section.title })
    }
  }

  console.log(`[product-scraper] Download queue: ${downloadQueue.length} items from ${Object.keys(sections).length} sections`)

  // ── Phase 3 (REORDERED): Viewer extraction FIRST — inline content is primary ──
  // Run viewer extraction with follow-through on ALL queued items BEFORE trying downloads.
  // This is the primary acquisition path — downloads are the fallback.
  console.log('[product-scraper] Phase 3a: Inline viewer extraction (primary path)...')
  const viewerExtractedNames = new Set<string>()
  let viewerExtracted = 0
  let viewerSkipped = 0

  for (const { item, sectionKey, sectionTitle } of downloadQueue) {
    if (!item.url) continue

    const urlLower = (item.url ?? '').toLowerCase()
    if (urlLower.includes('youtube.com') || urlLower.includes('youtu.be')) continue

    // External Red Hat domains — fetch directly via HTTP instead of Seismic viewer
    try {
      const parsedUrl = new URL(item.url)
      const host = parsedUrl.hostname
      const isSeismic = host.includes('saleshub.redhat.com') || host.includes('seismic.com')
      const isRedHatDomain = host.includes('redhat.com') || host.includes('google.com')

      if (!isSeismic && !isRedHatDomain) {
        viewerSkipped++
        continue
      }

      if (!isSeismic) {
        // Fetch external Red Hat domain content directly via HTTP
        const sectionSlugE = slugify(sectionTitle)
        const extractDir = resolve(productDir, 'extracted', sectionSlugE)
        const extractFilename = `${sanitizeFilename(item.name)}.html`
        const extractPath = resolve(extractDir, extractFilename)
        if (existsSync(extractPath)) {
          viewerExtractedNames.add(sanitizeFilename(item.name).slice(0, 60))
          viewerExtracted++
          continue
        }

        try {
          const resp = await fetch(item.url, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' },
            redirect: 'follow',
            signal: AbortSignal.timeout(15_000),
          })
          if (resp.ok) {
            const html = await resp.text()
            const cleaned = sanitizeViewerHtml(html)
            // Extract meaningful text — skip if too short
            const textOnly = cleaned.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
            if (textOnly.length > 300) {
              mkdirSync(extractDir, { recursive: true })
              writeFileSync(extractPath, cleaned, 'utf-8')
              viewerExtractedNames.add(sanitizeFilename(item.name).slice(0, 60))
              viewerExtracted++
              console.log(`[product-scraper] HTTP extracted: ${item.name.slice(0, 50)} from ${host} (${textOnly.length} chars)`)
            } else {
              viewerSkipped++
            }
          } else {
            viewerSkipped++
          }
        } catch {
          viewerSkipped++
        }
        continue
      }
    } catch { viewerSkipped++; continue }

    // Check if already extracted (cached)
    const sectionSlugE = slugify(sectionTitle)
    const extractDir = resolve(productDir, 'extracted', sectionSlugE)
    const extractFilename = `${sanitizeFilename(item.name)}.html`
    const extractPath = resolve(extractDir, extractFilename)
    if (existsSync(extractPath)) {
      viewerExtractedNames.add(sanitizeFilename(item.name).slice(0, 60))
      viewerExtracted++
      continue
    }

    // Use extractWithFollowThrough for inline content extraction
    try {
      const result = await extractWithFollowThrough(context, item, sectionKey, productDir)
      if (result.extracted.length > 0) {
        for (const ext of result.extracted) {
          viewerExtractedNames.add(sanitizeFilename(ext.name).slice(0, 60))
        }
        viewerExtracted += result.extracted.length
        console.log(`[product-scraper] Viewer extracted: ${item.name.slice(0, 50)} (${result.extracted.length} doc${result.extracted.length > 1 ? 's' : ''})`)
      } else {
        viewerSkipped++
      }
    } catch (e: any) {
      console.warn(`[product-scraper] Viewer extraction failed for ${item.name.slice(0, 40)}: ${(e.message ?? '').slice(0, 60)}`)
      viewerSkipped++
    }
  }
  console.log(`[product-scraper] Phase 3a complete: ${viewerExtracted} extracted, ${viewerSkipped} skipped`)

  // ── Phase 3b: File downloads — SECONDARY, only for items not already extracted ──
  for (const { item, sectionKey, sectionTitle } of downloadQueue) {
    // Skip items that already have viewer-extracted content
    const safeName = sanitizeFilename(item.name).slice(0, 60)
    if (viewerExtractedNames.has(safeName)) {
      continue
    }
    if (consecutiveFailures >= CIRCUIT_BREAKER) {
      console.log(`[product-scraper] Circuit breaker: ${CIRCUIT_BREAKER} consecutive failures — stopping downloads`)
      break
    }
    if (totalProcessed >= MAX_DOWNLOADS_PER_PRODUCT) {
      console.log(`[product-scraper] Reached MAX_DOWNLOADS_PER_PRODUCT (${MAX_DOWNLOADS_PER_PRODUCT}) — stopping`)
      break
    }

    totalProcessed++

    // Create section-specific download directory
    const sectionSlug = slugify(sectionTitle)
    const sectionDir = resolve(productDir, 'downloads', sectionSlug)
    mkdirSync(sectionDir, { recursive: true })

    // Check if cached — look for any file with matching name prefix
    const safePrefix = sanitizeFilename(item.name).slice(0, 60)
    const existingFiles = existsSync(sectionDir)
      ? (await import('fs')).readdirSync(sectionDir).filter((f: string) => f.startsWith(safePrefix))
      : []
    if (existingFiles.length > 0) {
      skipped++
      consecutiveFailures = 0
      continue
    }

    let succeeded = false
    let lastError = ''

    // ── PRIMARY: Viewer click-to-download ─────────────────────────────────
    // Open the item's viewer page in a new tab, find Download button, download.
    // This works for Google Doc-sourced content where the viewer renders a Download button.
    if (item.url) {
      try {
        const dlPage = await context.newPage()
        try {
          await dlPage.goto(item.url, { waitUntil: 'domcontentloaded', timeout: 30_000 })
          await dlPage.waitForTimeout(3_000)

          // Look for a Download button on the viewer page
          const downloadBtnSelectors = [
            'button:has-text("Download")',
            '[aria-label*="download" i]',
            '[aria-label*="Download"]',
            'a:has-text("Download")',
            '[class*="download" i]',
            'text=Download',
          ]

          let downloadBtn: Locator | null = null
          for (const sel of downloadBtnSelectors) {
            const candidate = dlPage.locator(sel).first()
            if (await candidate.isVisible({ timeout: 2_000 }).catch(() => false)) {
              downloadBtn = candidate
              break
            }
          }

          // Check if viewer page shows "Content not found" or similar error
          const pageText = await dlPage.innerText('body').catch(() => '')
          const isContentNotFound = /content\s+not\s+found|page\s+not\s+found|error|404/i.test(pageText.slice(0, 500))

          if (downloadBtn && !isContentNotFound) {
            const downloadPromise = dlPage.waitForEvent('download', { timeout: 30_000 }).catch(() => null)
            await downloadBtn.click()
            const dl = await downloadPromise
            if (!dl) {
              lastError = 'Viewer: Download event timed out'
            } else {
              const suggestedName = dl.suggestedFilename()
              const ext = suggestedName.includes('.') ? suggestedName.split('.').pop()! : 'pdf'
              const filename = sanitizeFilename(`${item.name}.${ext}`)
              const localPath = resolve(sectionDir, filename)
              await dl.saveAs(localPath)
              downloaded++
              consecutiveFailures = 0
              console.log(`[product-scraper] (${totalProcessed}/${downloadQueue.length}) OK ${filename} (viewer download)`)
              succeeded = true
            }
          } else {
            lastError = isContentNotFound ? 'Viewer: Content not found' : 'Viewer: No Download button found'
          }
        } finally {
          await dlPage.close()
        }
      } catch (e: any) {
        lastError = `Viewer: ${(e.message ?? 'Unknown error').slice(0, 100)}`
      }
    }

    // ── FALLBACK: Three-dot DocListPicker menu on the product page ─────────
    // When the viewer page shows "Content not found" or lacks a Download button,
    // try downloading via the three-dot menu in the DocListPicker table row.
    // This path stays on the product page (ANTI-1: no navigation away).
    if (!succeeded) {
      console.log(`[product-scraper] (${totalProcessed}) Viewer failed: ${lastError.slice(0, 60)} — trying three-dot fallback`)
      try {
        // Find the document row on the product page by matching the item name
        // Search in all DocListPicker tables on the page
        const docRow = page.locator(`tr:has-text("${item.name.slice(0, 40).replace(/"/g, '\\"')}"), [role="row"]:has-text("${item.name.slice(0, 40).replace(/"/g, '\\"')}")`)
          .first()

        if (await docRow.isVisible({ timeout: 3_000 }).catch(() => false)) {
          // Hover to reveal action icons
          await docRow.hover()
          await page.waitForTimeout(500)

          // Find the three-dot menu button
          const menuSelectors = [
            '[class*="more"]',
            '[class*="menu"]:not([role="menu"])',
            '[aria-label*="more" i]',
            '[aria-label*="More"]',
            '[aria-label*="action" i]',
            '[class*="action"] button:last-child',
            '[class*="kebab"]',
            '[class*="ellipsis"]',
          ]

          let menuBtn: Locator | null = null
          for (const sel of menuSelectors) {
            const candidate = docRow.locator(sel).first()
            if (await candidate.isVisible({ timeout: 1_000 }).catch(() => false)) {
              menuBtn = candidate
              break
            }
          }

          // Fallback: last button in the row
          if (!menuBtn) {
            const lastBtn = docRow.locator('button').last()
            if (await lastBtn.isVisible({ timeout: 1_000 }).catch(() => false)) {
              menuBtn = lastBtn
            }
          }

          if (!menuBtn) {
            lastError = 'Fallback: No three-dot menu button found in row'
            throw new Error(lastError)
          }

          await menuBtn.click()
          await page.waitForTimeout(500)

          // Find "Download" in the dropdown
          const dropdownSelectors = [
            '[class*="dropdown"]',
            '[class*="menu"][role="menu"]',
            '[role="menu"]',
            '[role="listbox"]',
            '[class*="popup"]',
            '[class*="popover"]',
            '[class*="overlay"]',
          ]

          let downloadOption: Locator | null = null
          for (const sel of dropdownSelectors) {
            const dropdown = page.locator(sel)
            if (await dropdown.isVisible({ timeout: 2_000 }).catch(() => false)) {
              const dlOpt = dropdown.locator('text=Download').first()
              if (await dlOpt.isVisible({ timeout: 1_000 }).catch(() => false)) {
                downloadOption = dlOpt
                break
              }
            }
          }

          if (!downloadOption) {
            const anyDownload = page.getByText('Download', { exact: true }).first()
            if (await anyDownload.isVisible({ timeout: 1_000 }).catch(() => false)) {
              downloadOption = anyDownload
            }
          }

          if (!downloadOption) {
            lastError = 'Fallback: No "Download" in three-dot dropdown'
            await page.keyboard.press('Escape')
            await page.waitForTimeout(300)
            throw new Error(lastError)
          }

          const downloadPromise = page.waitForEvent('download', { timeout: 30_000 }).catch(() => null)
          await downloadOption.click()

          const dl = await downloadPromise
          if (!dl) {
            lastError = 'Fallback: Download event timed out'
          } else {
            const suggestedName = dl.suggestedFilename()
            const ext = suggestedName.includes('.') ? suggestedName.split('.').pop()! : 'pdf'
            const filename = sanitizeFilename(`${item.name}.${ext}`)
            const localPath = resolve(sectionDir, filename)
            await dl.saveAs(localPath)
            downloaded++
            consecutiveFailures = 0
            console.log(`[product-scraper] (${totalProcessed}/${downloadQueue.length}) OK ${filename} (three-dot fallback)`)
            succeeded = true
          }
        } else {
          lastError = 'Fallback: Document row not found on product page'
        }
      } catch (e: any) {
        if (!lastError.startsWith('Fallback:')) {
          lastError = `Fallback: ${(e.message ?? 'Unknown error').slice(0, 100)}`
        }
        // Dismiss any open dropdown
        try {
          await page.keyboard.press('Escape')
          await page.waitForTimeout(300)
        } catch { /* ignore */ }
      }
    }

    // -- FALLBACK 3: Seismic DocCenter API download (#857) --------------------
    // When both viewer and three-dot methods fail, try downloading directly via
    // the Seismic DocCenter download API. Requires both contentId and versionId.
    // Uses the browser context's cookies (SSO session) to authenticate.
    if (!succeeded && shouldAttemptApiDownload(item)) {
      const apiContentId = item.contentId!
      const apiVersionId = item.versionId!
      const apiUrl = buildDownloadUrl(apiVersionId, apiContentId)
      console.log(`[product-scraper] (${totalProcessed}) Trying API download: ${item.name.slice(0, 50)}`)
      try {
        const apiPage = await context.newPage()
        try {
          // Navigate to the download URL — the browser context carries SSO cookies
          const downloadPromise = apiPage.waitForEvent('download', { timeout: 30_000 }).catch(() => null)
          await apiPage.goto(apiUrl, { waitUntil: 'commit', timeout: 30_000 })

          const dl = await downloadPromise
          if (dl) {
            const suggestedName = dl.suggestedFilename()
            const ext = suggestedName.includes('.') ? suggestedName.split('.').pop()! : 'pdf'
            const filename = sanitizeFilename(`${item.name}.${ext}`)
            const localPath = resolve(sectionDir, filename)
            await dl.saveAs(localPath)
            downloaded++
            consecutiveFailures = 0
            console.log(`[product-scraper] (${totalProcessed}/${downloadQueue.length}) OK ${filename} (API download)`)
            succeeded = true
          } else {
            // Download event didn't fire — try reading the response body directly
            // Some API downloads return the file content as a response body
            const response = await apiPage.waitForResponse(
              resp => resp.url().includes('/download/') || resp.url().includes('/blob'),
              { timeout: 10_000 },
            ).catch(() => null)

            if (response && response.ok()) {
              const contentDisposition = response.headers()['content-disposition'] ?? ''
              const body = await response.body().catch(() => null)
              if (body && body.length > 0) {
                // Determine extension from content-disposition or default to pdf
                let ext = 'pdf'
                const filenameMatch = contentDisposition.match(/filename[^;=\n]*=(['"]?)([^'"\n;]+)\1/)
                if (filenameMatch?.[2]) {
                  const suggested = filenameMatch[2]
                  ext = suggested.includes('.') ? suggested.split('.').pop()! : 'pdf'
                }
                const filename = sanitizeFilename(`${item.name}.${ext}`)
                const localPath = resolve(sectionDir, filename)
                writeFileSync(localPath, body)
                downloaded++
                consecutiveFailures = 0
                console.log(`[product-scraper] (${totalProcessed}/${downloadQueue.length}) OK ${filename} (API response body)`)
                succeeded = true
              } else {
                lastError = 'API: Response body empty'
              }
            } else {
              lastError = `API: No download event and no valid response (status: ${response?.status() ?? 'none'})`
            }
          }
        } finally {
          await apiPage.close()
        }
      } catch (e: any) {
        lastError = `API: ${(e.message ?? 'Unknown error').slice(0, 100)}`
        console.warn(`[product-scraper] (${totalProcessed}) API fallback error: ${lastError}`)
      }
    }

    if (!succeeded) {
      // Only count items with contentId toward circuit breaker — items without
      // IDs (webpages, webinars, press releases) can never succeed via API (#857)
      if (item.contentId && item.versionId) consecutiveFailures++
      console.warn(`[product-scraper] (${totalProcessed}) FAIL ${item.name.slice(0, 50)}: ${lastError.slice(0, 80)}`)
      errors++
      failedDownloads.push({
        name: item.name,
        section: sectionKey,
        format: (item as any).format ?? '',
        versionId: item.versionId ?? '',
        error: lastError,
        attempts: 1,
      })
    }

    // Brief pause between items to avoid rate-limiting
    await new Promise(r => setTimeout(r, 1_000))
  }

  // Failed downloads tracked in unified pipeline manifest (#874)
  // _failed-downloads.json removed — data now in _pipeline-manifest.json

  console.log(`[product-scraper] Downloads complete: ${downloaded} new, ${skipped} cached, ${errors} errors`)

  // Phase 4 removed — viewer extraction now runs as Phase 3a (PRIMARY path) above.
  // Downloads (Phase 3b) are the SECONDARY fallback.
}


// ── CDS Network Interception (#833) ─────────────────────────────────────────

interface CdsDocument {
  name: string
  format: string
  contentId: string
  versionId: string
  originUrl: string
}

function setupCdsInterception(page: import('@playwright/test').Page): CdsDocument[] {
  const documents: CdsDocument[] = []
  page.on('response', async (res) => {
    const url = res.url()
    if (!url.includes('/cds/') || !url.includes('publishedcontents')) return
    try {
      const body = await res.json()
      for (const doc of body?.Documents ?? []) {
        documents.push({
          name: doc.Name ?? '',
          format: doc.Format ?? '',
          contentId: doc.ContentId ?? '',
          versionId: doc.VersionId ?? '',
          originUrl: doc.OriginUrl ?? '',
        })
      }
    } catch { /* non-JSON response */ }
  })
  return documents
}

// ── Delta Detection (#838) ──────────────────────────────────────────────────

interface DeltaReport {
  newItems: string[]
  updatedItems: string[]
  unchangedItems: string[]
}

function computeDelta(
  cdsDocuments: CdsDocument[],
  existingProduct: ProductPage | null,
): DeltaReport {
  const report: DeltaReport = { newItems: [], updatedItems: [], unchangedItems: [] }
  if (!existingProduct) {
    report.newItems = cdsDocuments.map(d => d.name)
    return report
  }

  const existingByName = new Map<string, string>()
  for (const sec of Object.values(existingProduct.sections)) {
    for (const item of sec.items) {
      existingByName.set(item.name.toLowerCase().slice(0, 50), item.versionId ?? '')
    }
  }

  for (const doc of cdsDocuments) {
    const key = doc.name.toLowerCase().slice(0, 50)
    const existing = existingByName.get(key)
    if (existing === undefined) {
      report.newItems.push(doc.name)
    } else if (existing !== doc.versionId && doc.versionId) {
      report.updatedItems.push(doc.name)
    } else {
      report.unchangedItems.push(doc.name)
    }
  }

  return report
}

// ── Completeness Validation (#837) ──────────────────────────────────────────

interface CompletenessReport {
  product: string
  scrapedAt: string
  cdsItemCount: number
  domItemCount: number
  downloadedCount: number
  status: 'COMPLETE' | 'INCOMPLETE'
  missingItems: Array<{ name: string; format: string; reason: string }>
  delta?: DeltaReport
}

function generateCompletenessReport(
  productName: string,
  cdsDocuments: CdsDocument[],
  domItemCount: number,
  downloadedCount: number,
  delta?: DeltaReport,
): CompletenessReport {
  const missing: CompletenessReport['missingItems'] = []

  for (const doc of cdsDocuments) {
    const isGoogleDoc = doc.originUrl.includes('docs.google.com')
    if (!doc.versionId && !isGoogleDoc) {
      missing.push({ name: doc.name, format: doc.format, reason: 'No versionId — not in search API index' })
    }
  }

  return {
    product: productName,
    scrapedAt: new Date().toISOString(),
    cdsItemCount: cdsDocuments.length,
    domItemCount,
    downloadedCount,
    status: missing.length === 0 && domItemCount > 0 ? 'COMPLETE' : 'INCOMPLETE',
    missingItems: missing,
    delta,
  }
}

export async function scrapeProductPage(
  url: string = DEFAULT_URL,
  externalContext?: BrowserContext,
): Promise<void> {
  console.log(`[product-scraper] Starting product page scrape`)
  console.log(`[product-scraper] URL: ${url}`)

  let browser: any = null
  let context: BrowserContext

  if (externalContext) {
    context = externalContext
    console.log('[product-scraper] Using external browser context (sync daemon)')
  } else {
    const sessionStatePath = resolve(PROFILE_DIR, 'session-state.json')
    if (!existsSync(sessionStatePath)) {
      throw new Error(`[product-scraper] No session-state.json at ${sessionStatePath}`)
    }
    const sessionState = JSON.parse(readFileSync(sessionStatePath, 'utf-8'))
    console.log(`[product-scraper] Loaded ${sessionState.cookies?.length ?? 0} cookies from session state`)

    browser = await chromium.launch({
      headless: true,
      executablePath: CHROMIUM_PATH,
      args: [
        ...BASE_CHROMIUM_ARGS,
        '--disable-blink-features=AutomationControlled',
        '--headless=new',
      ],
    })

    context = await browser.newContext({
      storageState: sessionState,
      acceptDownloads: true,
      userAgent:
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    })
  }

  try {
    const page = await context.newPage()

    // CDS interception — capture DocListPicker document inventory during page load (#833)
    const cdsDocuments = setupCdsInterception(page)

    // Load existing product data for delta detection (#838)
    let existingProduct: ProductPage | null = null
    try {
      const existingPath = resolve('config-templates', 'saleshub-products', slugify(url.split('/lf')[1]?.slice(0, 20) ?? 'unknown'), '_product.json')
      if (existsSync(existingPath)) {
        existingProduct = JSON.parse(readFileSync(existingPath, 'utf-8'))
      }
    } catch { /* no existing data */ }

    // Step 1: Capture Seismic auth FIRST (navigates to DocCenter main page)
    console.log('[product-scraper] Step 1: Capturing Seismic auth token...')
    const authCtx = await captureSeismicAuth(page)
    if (authCtx) {
      console.log(`[product-scraper] Auth captured (${authCtx.auth.length} chars)`)
    } else {
      console.warn('[product-scraper] Auth capture failed — will use DOM-only extraction')
    }

    // Step 2: Navigate to product page
    console.log('[product-scraper] Step 2: Navigating to product page...')
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 })

    // Wait for page to render -- Seismic SPA needs time to hydrate
    console.log('[product-scraper] Waiting for page to fully render...')
    await page.waitForTimeout(8_000)

    // Try to wait for a title element to appear
    try {
      await page.waitForSelector('h1, [class*="title"], [class*="Title"]', { timeout: 15_000 })
    } catch {
      console.warn('[product-scraper] Title element not found within timeout -- proceeding anyway')
    }

    // Scroll down to trigger lazy loading
    console.log('[product-scraper] Scrolling page to trigger lazy loading...')
    await page.evaluate(async () => {
      const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))
      const scrollHeight = document.body.scrollHeight
      const step = window.innerHeight
      for (let y = 0; y < scrollHeight; y += step) {
        window.scrollTo(0, y)
        await delay(300)
      }
      window.scrollTo(0, 0)
    })
    await page.waitForTimeout(2_000)

    // Extract product header
    const header = await extractProductHeader(page)
    console.log(`[product-scraper] Product: "${header.name}"`)

    // Expand all accordions BEFORE DOM extraction (#874 — Gate 0)
    // Content inside collapsed accordions is invisible to extractRedHeaderSections()
    await expandAllAccordions(page)

    // Screenshot audit artifact (#874 — Gate 0)
    // Saved BEFORE extractRedHeaderSections() so the screenshot shows the fully-expanded page
    const earlyProductSlug = slugify(header.name)
    const earlyConfigOutputDir = resolve('config-templates', 'saleshub-products', earlyProductSlug)
    mkdirSync(earlyConfigOutputDir, { recursive: true })
    await page.screenshot({ fullPage: true, path: resolve(earlyConfigOutputDir, '_page-screenshot.png') })
    console.log('[product-scraper] Saved page screenshot as audit artifact')

    // Extract red header sections (DOM — structure + text + accordion links)
    console.log('[product-scraper] Extracting sections by red header bars...')
    const { sections, domainDocLookup } = await extractRedHeaderSections(page)
    console.log(`[product-scraper] Extracted ${Object.keys(sections).length} sections from DOM`)

    // ── Pipeline manifest: Gate 0 — DOM visibility (#874) ─────────────────
    let manifest = createManifest(slugify(header.name), header.name)
    for (const [sectionKey, section] of Object.entries(sections)) {
      for (const item of section.items) {
        addGate0Entry(manifest, item.name, sectionKey, ['dom'])
      }
    }
    console.log(`[product-scraper] Manifest Gate 0: ${manifest.documents.length} DOM items registered`)

    // Query Seismic API for document list by product name (using auth captured in Step 1)
    if (authCtx) {
      console.log('[product-scraper] Step 4: Querying Seismic API for product documents...')
      try {
        const apiDocs = await queryDocumentsByProduct(page, authCtx, header.name)
        console.log(`[product-scraper] API returned ${apiDocs.length} documents for "${header.name}"`)

        // Group documents by content type → create/enhance sections
        const docsByType = new Map<string, DocCenterDocument[]>()
        for (const doc of apiDocs) {
          const type = doc.contentType || 'Other'
          if (!docsByType.has(type)) docsByType.set(type, [])
          docsByType.get(type)!.push(doc)
        }

        // Map content types to section names
        const typeToSection: Record<string, string> = {
          'Business presentation': 'Business decks',
          'Cheatsheet': 'Resources',
          'Competitive review': 'Competitive',
          'Battlecard': 'Competitive',
          'Reference architecture': 'Technical resources',
          'Campaign guide': 'Campaign resources',
          'Email': 'Email templates',
          'Template': 'Templates',
          'Datasheet': 'Resources',
          'Video': 'Demos & Videos',
        }

        for (const [contentType, docs] of docsByType) {
          const sectionName = typeToSection[contentType] || contentType
          const sectionKey = slugify(sectionName)

          const items: SectionItem[] = docs.map(doc => {
            const item: any = {
              name: doc.name,
              url: doc.downloadUrl || undefined,
              itemType: contentType.toLowerCase().replace(/\s+/g, '-'),
              description: `${doc.distributionTerms || ''} | ${doc.salesStage || ''}`.trim().replace(/^\||\|$/g, '').trim() || undefined,
              contentId: (doc as any).contentId || undefined,
              versionId: doc.versionId || undefined,
              format: (doc as any).format || undefined,
              seismicContentType: contentType,
            }
            // (#858 Fix 2) Tag API documents with their Domain accordion section
            const domain = domainDocLookup.get(doc.name.toLowerCase().slice(0, 50))
            if (domain) item.domain = domain
            return item
          })

          if (sections[sectionKey]) {
            // Merge with existing section — add API docs, update existing with contentId/versionId
            const existingByName = new Map(sections[sectionKey].items.map((i, idx) => [i.name.slice(0, 50), idx]))
            for (const item of items) {
              const existingIdx = existingByName.get(item.name.slice(0, 50))
              if (existingIdx !== undefined) {
                // Update existing item with contentId/versionId from API (#857)
                const existing = sections[sectionKey].items[existingIdx]
                if (!existing.contentId && item.contentId) existing.contentId = item.contentId
                if (!existing.versionId && item.versionId) existing.versionId = item.versionId
                if (!existing.format && (item as any).format) (existing as any).format = (item as any).format
              } else {
                sections[sectionKey].items.push(item)
              }
            }
          } else {
            sections[sectionKey] = {
              title: sectionName,
              type: 'cards',
              items,
            }
          }
        }

        // Update manifest: add API-discovered items not already in manifest
        for (const [sectionKey, section] of Object.entries(sections)) {
          for (const item of section.items) {
            const existing = manifest.documents.find(d => d.name === item.name)
            if (existing) {
              // Update source to include 'api' if it came from API merge
              if (!existing.source.includes('api')) existing.source.push('api')
            } else {
              addGate0Entry(manifest, item.name, sectionKey, ['api'])
            }
          }
        }

        console.log(`[product-scraper] After API merge: ${Object.keys(sections).length} total sections`)
      } catch (e: any) {
        console.warn(`[product-scraper] Seismic API query failed — DOM-only results: ${e.message}`)
      }
    } else {
      console.warn('[product-scraper] Could not capture Seismic auth — using DOM-only results')
    }

    // (#858 Fix 2) Final pass: tag any remaining untagged items with their domain.
    // Items may have been added via API merge without domain tags if they were grouped
    // by content type rather than by accordion section.
    if (domainDocLookup.size > 0) {
      let tagged = 0
      for (const section of Object.values(sections)) {
        for (const item of section.items) {
          if (!item.domain) {
            const domain = domainDocLookup.get(item.name.toLowerCase().slice(0, 50))
            if (domain) {
              item.domain = domain
              tagged++
            }
          }
        }
      }
      if (tagged > 0) {
        console.log(`[product-scraper] Domain tagging: ${tagged} items tagged in final pass`)
      }
    }

    // ── Dedup across all sections (#873) ──────────────────────────────────
    console.log('[product-scraper] Deduplicating items across sections...')
    const dedupResult = deduplicateAcrossSections(sections)
    for (const removed of dedupResult.removed) {
      updateGate1(manifest, removed.name, { gate1_deduped: false })
    }
    if (dedupResult.removed.length > 0) {
      console.log(`[product-scraper] Dedup: removed ${dedupResult.removed.length} duplicate items`)
    }

    // ── Language filter across all sections (#872) ─────────────────────────
    let languageFiltered = 0
    for (const [sectionKey, section] of Object.entries(sections)) {
      for (const item of section.items) {
        const si = item as any
        if (isNonEnglishByMetadata(si) || isNonEnglishDoc(item.name)) {
          updateGate1(manifest, item.name, { language: si.language ?? 'non-en' })
          updateGate2(manifest, item.name, { gate2_skippedReason: 'non-english' })
          languageFiltered++
        }
      }
    }
    if (languageFiltered > 0) {
      console.log(`[product-scraper] Language filter: ${languageFiltered} non-English items flagged`)
    }

    // ── Gate 1 blocking check (#874) ───────────────────────────────────────
    computeGateSummary(manifest)
    const configOutputDir = resolve('config-templates', 'saleshub-products', slugify(header.name))
    mkdirSync(configOutputDir, { recursive: true })

    if (manifest.gates.gate1_blocked) {
      const passPct = (manifest.gates.gate1_passRate * 100).toFixed(1)
      console.log(`[product-scraper] GATE 1 BLOCKED: Only ${passPct}% of page items captured (threshold: 80%)`)
      manifest.gates.gate1_blocked = true
      writeManifest(manifest, configOutputDir)
      // Still write _product.json for debugging, but skip downloads + enrichment
      console.log('[product-scraper] Skipping downloads and enrichment due to Gate 1 block')
    }

    // Extract sidebar
    console.log('[product-scraper] Extracting sidebar...')
    const sidebar = await extractSidebar(page)

    // Step 5: Download documents into per-product directory (SC-2)
    if (manifest.gates.gate1_blocked) {
      console.log('[product-scraper] Skipping downloads (Gate 1 blocked)')
    } else if (!skipDownloads && authCtx) {
      console.log('[product-scraper] Step 5: Downloading documents into product directory...')
      await downloadProductDocuments(page, context, sections, slugify(header.name), authCtx)
    } else if (skipDownloads) {
      console.log('[product-scraper] Skipping downloads (--skip-downloads flag)')
    } else {
      console.log('[product-scraper] Skipping downloads (no auth captured)')
    }

    // CDS inventory logging (#833)
    if (cdsDocuments.length > 0) {
      console.log(`[product-scraper] CDS inventory: ${cdsDocuments.length} DocListPicker documents intercepted`)
      const googleDocs = cdsDocuments.filter(d => d.originUrl.includes('docs.google.com'))
      console.log(`[product-scraper] CDS: ${googleDocs.length} Google Docs, ${cdsDocuments.length - googleDocs.length} Seismic-hosted`)
    }

    // Delta detection (#838)
    const delta = computeDelta(cdsDocuments, existingProduct)
    if (existingProduct) {
      console.log(`[product-scraper] Delta: ${delta.newItems.length} new, ${delta.updatedItems.length} updated, ${delta.unchangedItems.length} unchanged`)
    }

    // Build ProductPage object
    const productSlug = slugify(header.name)
    const productPage: ProductPage = {
      name: header.name,
      slug: productSlug,
      description: header.description,
      pageUrl: url,
      scrapedAt: new Date().toISOString(),
      tdpLinks: sidebar.tdpLinks,
      contacts: sidebar.contacts,
      slackChannels: sidebar.slackChannels,
      sections,
    }

    // Count total items
    let totalItems = 0
    for (const section of Object.values(sections)) {
      totalItems += section.items.length
      if (section.subsections) {
        for (const sub of section.subsections) {
          totalItems += sub.items.length
        }
      }
    }

    console.log(`\n[product-scraper] === Summary ===`)
    console.log(`  Product: ${productPage.name}`)
    console.log(`  Slug: ${productSlug}`)
    console.log(`  Sections: ${Object.keys(sections).length}`)
    console.log(`  Total items: ${totalItems}`)
    console.log(`  TDP links: ${sidebar.tdpLinks.length}`)
    console.log(`  Contacts: ${sidebar.contacts.length}`)
    console.log(`  Slack channels: ${sidebar.slackChannels.length}`)

    // Write output files
    const cacheOutputDir = resolve(CACHE_DIR, 'saleshub', 'products', productSlug)

    mkdirSync(cacheOutputDir, { recursive: true })
    // configOutputDir already created above at Gate 1 check

    const cachePath = resolve(cacheOutputDir, '_product.json')
    const configPath = resolve(configOutputDir, '_product.json')

    writeJsonAtomic(cachePath, productPage)
    writeJsonAtomic(configPath, productPage)

    // Write CDS inventory (#833)
    if (cdsDocuments.length > 0) {
      writeJsonAtomic(resolve(configOutputDir, '_cds-inventory.json'), cdsDocuments)
    }

    // Write unified pipeline manifest (#874) — replaces _completeness.json
    computeGateSummary(manifest)
    writeManifest(manifest, configOutputDir)
    console.log(`[product-scraper] Pipeline manifest: Gate 0=${manifest.gates.gate0_domItemCount} DOM, Gate 1=${manifest.gates.gate1_scrapedCount} scraped (${(manifest.gates.gate1_passRate * 100).toFixed(0)}% pass), Gate 2=${manifest.gates.gate2_downloadedCount} downloaded`)

    // ── Step 6: Inline enrichment — runs in the SAME process as the scraper ──
    // This ensures scrape → extract → enrich → manifest update all happen on one machine.
    // Enrichment reads extracted/ HTML files, runs Gemini DocumentIntelligence extraction,
    // and updates the manifest with Gate 2/3 data.
    console.log('[product-scraper] Step 6: Running inline enrichment...')
    try {
      const { enrichProductDocuments } = await import('../src/lib/saleshub-product-enrichment.ts')

      // Collect documents from extracted/ directory (same logic as enrich endpoint)
      const enrichDocs: Array<{ name: string; content: string; type: string; cloudProvider?: string }> = []
      const extractedDir = resolve(configOutputDir, 'extracted')
      if (existsSync(extractedDir)) {
        const eSubs = readdirSync(extractedDir, { withFileTypes: true }).filter(d => d.isDirectory())
        for (const eSub of eSubs) {
          const eSubPath = resolve(extractedDir, eSub.name)
          const eFiles = readdirSync(eSubPath).filter(f =>
            f.endsWith('.html') || f.endsWith('.txt') || f.endsWith('.md')
          )
          for (const file of eFiles) {
            const content = readFileSync(resolve(eSubPath, file), 'utf-8')
            enrichDocs.push({
              name: file.replace(/\.(html|txt|md)$/, ''),
              content,
              type: 'content-kit',
            })
          }
        }
      }

      // Also collect from downloads/ if any files were downloaded
      const dlDir = resolve(configOutputDir, 'downloads')
      if (existsSync(dlDir)) {
        const dlSubs = readdirSync(dlDir, { withFileTypes: true }).filter(d => d.isDirectory())
        for (const dlSub of dlSubs) {
          const dlSubPath = resolve(dlDir, dlSub.name)
          const dlFiles = readdirSync(dlSubPath).filter(f => {
            const lower = f.toLowerCase()
            return lower.endsWith('.html') || lower.endsWith('.pdf') || lower.endsWith('.docx') || lower.endsWith('.pptx')
          })
          for (const file of dlFiles) {
            const filePath = resolve(dlSubPath, file)
            const lower = file.toLowerCase()
            let content: string
            if (lower.endsWith('.pdf') || lower.endsWith('.docx') || lower.endsWith('.pptx')) {
              content = `[PDF:base64:${readFileSync(filePath).toString('base64')}]`
            } else {
              content = readFileSync(filePath, 'utf-8')
            }
            enrichDocs.push({
              name: file.replace(/\.(html|pdf|docx|pptx)$/i, ''),
              content,
              type: 'content-kit',
            })
          }
        }
      }

      if (enrichDocs.length > 0) {
        console.log(`[product-scraper] Enriching ${enrichDocs.length} documents inline...`)
        const enrichment = await enrichProductDocuments(productSlug, enrichDocs, undefined, configOutputDir)
        if (enrichment) {
          writeJsonAtomic(resolve(configOutputDir, '_enriched.json'), enrichment)
          console.log(`[product-scraper] Enrichment complete: ${enrichment.documents?.length ?? 0} documents enriched`)

          // Re-read manifest from disk (enrichment already wrote Gate 3 data)
          const updatedManifest = readManifest(configOutputDir)
          if (updatedManifest) {
            manifest = updatedManifest
          }
        }
      } else {
        console.log('[product-scraper] No documents to enrich')
      }
    } catch (e: any) {
      console.warn(`[product-scraper] Inline enrichment failed (non-blocking): ${e.message}`)
    }

    // Upload manifest + enriched data to Drive for cross-node visibility (#874 PR 3)
    try {
      const { uploadManifestToDrive } = await import('../src/lib/saleshub-product-drive-sync.ts')
      await uploadManifestToDrive(productSlug, manifest)
    } catch (e: any) {
      console.warn(`[product-scraper] Manifest Drive upload failed (non-blocking): ${e.message}`)
    }

    console.log(`\n[product-scraper] Written to:`)
    console.log(`  ${cachePath}`)
    console.log(`  ${configPath}`)
    console.log('[product-scraper] Done.')
  } finally {
    if (!externalContext) {
      await context.close()
      if (browser) await browser.close()
    }
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2).filter(a => !a.startsWith('--'))
  const url = args[0] || DEFAULT_URL
  scrapeProductPage(url).catch((err) => {
    console.error('[product-scraper] Fatal error:', err)
    process.exit(1)
  })
}
