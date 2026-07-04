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
  ProductEnrichment,
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
const skipApiMerge = process.argv.includes('--page-only')

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
      const itemUrl = (item.url ?? '').toLowerCase()

      // Dedup key includes URL — same name + different URL = different item
      // (e.g., Cisco under Networks vs Cisco under Security)
      const dedupeKey = normalizedName + '|' + itemUrl

      const existing = seen.get(dedupeKey)
      if (existing) {
        // Decide which to keep — prefer the one with contentId
        if (hasContentId && !existing.hasContentId) {
          toRemove.push({
            sectionKey: existing.sectionKey,
            itemIdx: existing.itemIdx,
            name: item.name,
            section: existing.sectionKey,
          })
          seen.set(dedupeKey, { sectionKey, itemIdx: i, hasContentId })
        } else {
          toRemove.push({ sectionKey, itemIdx: i, name: item.name, section: sectionKey })
        }
      } else {
        seen.set(dedupeKey, { sectionKey, itemIdx: i, hasContentId })
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

  // Check for SSO/login pages (#966)
  if (lower.includes('ssolandingpage') || lower.includes('log in | red hat content center')) return false
  if (lower.includes('sign in for red hat') && lower.includes('sign in to get started')) return false

  // Check for Seismic viewer chrome — metadata panel without document content (#966)
  if (lower.includes('share with colleagues') && lower.includes('content details') && lower.includes('content type')) {
    const textOnly = innerText.replace(/\s+/g, ' ').trim()
    if (textOnly.length < 1500) return false
  }

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

// Default product page URL -- Ansible Automation Platform (AAP)
const DEFAULT_URL =
  'https://saleshub.redhat.com/apps/doccenter/1d1918e9-b5b0-4428-b8fc-87e02ad44156/doc/%252Fdd04d516a5-19b3-48c9-e01a-d2bf52939de4%252FdfMmNhNDhiYjktYzE1Ny00ZjgyLWJlYjUtNTdhY2NjZmY5Y2Rh%252CPT0%253D%252CUGFnZSBSSFNI%252Flfd69c2062-8583-4c77-a1bf-afca6ee943de//'

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
  if (trimmed.length < 2) return true
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
          await trigger.click({ timeout: 10000 })
          await page.waitForTimeout(2000)
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
            const domainName = heading ? (heading.textContent || '').trim().replace(/\s*arrow\s*(up|down)\s*$/i, '') : ''
            if (!domainName || domainName.length < 3) continue

            // Collect document names from links inside this panel
            const docLinks = panel.querySelectorAll('a[href]')
            const docNames: string[] = []
            for (const a of docLinks) {
              const text = (a.textContent || '').trim().slice(0, 200)
              const href = (a as HTMLAnchorElement).href || ''
              if (text.length >= 2) {
                docNames.push(text)
                // (#857) Also add to currentLinks so domain docs enter the download pipeline
                if (href.startsWith('http') && !href.includes('/app#/workspace')) {
                  currentLinks.push({ text, href })
                }
              }
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
              if (text.length >= 2 && href.startsWith('http') && !href.includes('/app#/workspace')) {
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
          if (text.length >= 2 && href.startsWith('http') && !href.includes('/app#/workspace')) {
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

    sections[sectionKey] = {
      title,
      textContent: textContent || undefined,
      type,
      items,
    }
    if (items.length > 0) {
      console.log(`[product-scraper] Section "${title}" (${type}): ${items.length} items`)
    } else {
      console.log(`[product-scraper] Section "${title}" (${type}): 0 items (carousel/DocListPicker content pending)`)
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
      if (text.length >= 2 && href.startsWith('http')) {
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

// ── Product Source Inventory (Phase 1 — #972) ──────────────────────────────

interface ProductSourceItem {
  name: string
  format?: string
  group?: string
  subSection?: string
  description?: string
  itemType?: string
}

interface ProductSourceSection {
  title: string
  type: 'link-list' | 'carousel' | 'doclist-picker'
  parentSection?: string
  items: ProductSourceItem[]
}

interface ProductSourceInventory {
  name: string
  slug: string
  source: string
  sourceFiles: string[]
  createdAt: string
  sections: Record<string, ProductSourceSection>
}

async function buildProductSourceInventory(
  page: Page,
  productName: string,
): Promise<ProductSourceInventory> {
  console.log('[product-scraper] Phase 1: Building product source inventory from sidebar TOC + DOM...')

  // Step 1: Read the sidebar Table of Contents — authoritative section list.
  // The sidebar TOC always lists every section on the page regardless of
  // content type (carousels, DocListPickers, accordions).
  const sidebarTocEntries = await page.evaluate(() => {
    const entries: Array<{ title: string }> = []
    const seen = new Set<string>()

    const sidebar = document.querySelector('.articleSdk-theme-page-doubleColumn-sidebar')
      || document.querySelector('[class*="rightColumn"]')
      || document.querySelector('[class*="toc"]')

    if (!sidebar) {
      // Position-based fallback: find elements anchored to the right side
      const allEls = document.querySelectorAll('nav, [class*="sidebar"], [class*="navigation"]')
      for (const el of allEls) {
        const rect = el.getBoundingClientRect()
        if (rect.x > 800 && rect.width > 50 && rect.width < 400) {
          const links = el.querySelectorAll('a, [role="link"]')
          for (const link of links) {
            const text = (link.textContent || '').trim().replace(/\s+/g, ' ')
            if (!text || text.length < 3 || text.length > 100) continue
            if (text.includes('@') || text.startsWith('#')) continue
            if (/^(Page\s+RHSH|All\s+Sales\s+Content|Content\s+Details|Contact\s+us|Ask\s+on\s+Slack|Home|Back|Previous|Next|Search)$/i.test(text)) continue
            const key = text.toLowerCase()
            if (seen.has(key)) continue
            seen.add(key)
            entries.push({ title: text })
          }
          if (entries.length > 0) break
        }
      }
      return entries
    }

    const links = sidebar.querySelectorAll('a, [role="link"], [role="button"]')
    for (const link of links) {
      const text = (link.textContent || '').trim().replace(/\s+/g, ' ')
      if (!text || text.length < 3 || text.length > 100) continue
      if (text.includes('@') || text.startsWith('#')) continue
      if (/^(Page\s+RHSH|All\s+Sales\s+Content|Content\s+Details|Contact\s+us|Ask\s+on\s+Slack|Home|Back|Previous|Next|Search)$/i.test(text)) continue
      const key = text.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      entries.push({ title: text })
    }

    return entries
  })

  console.log(`[product-scraper] Phase 1: Sidebar TOC found ${sidebarTocEntries.length} sections`)
  for (const entry of sidebarTocEntries) {
    console.log(`  TOC: "${entry.title}"`)
  }

  // Step 2: Walk DOM widgets to extract items per section (existing logic)
  const domSections = await page.evaluate(() => {
    const results: Record<string, {
      title: string
      type: string
      parentSection?: string
      items: Array<{
        name: string
        format?: string
        group?: string
        subSection?: string
        description?: string
        itemType?: string
      }>
    }> = {}

    const mainColumn = document.querySelector('.articleSdk-theme-page-doubleColumn-main')
    if (!mainColumn) return results

    const widgets = Array.from(mainColumn.children) as HTMLElement[]
    let currentTitle = ''
    let currentKey = ''

    function toSlug(s: string): string {
      return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80)
    }

    function extractItemsFromWidget(widget: HTMLElement): Array<{
      name: string
      format?: string
      group?: string
      description?: string
      itemType?: string
    }> {
      const items: Array<{
        name: string
        format?: string
        group?: string
        description?: string
        itemType?: string
      }> = []
      const seen = new Set<string>()

      // Carousel cards
      const cards = widget.querySelectorAll('[class*="card"], [class*="Card"]')
      if (cards.length > 0) {
        for (const card of cards) {
          const titleEl = card.querySelector('[class*="title"], [class*="Title"], h3, h4, span')
          const name = (titleEl?.textContent || '').trim()
          if (!name || name.length < 3 || seen.has(name.toLowerCase())) continue
          seen.add(name.toLowerCase())
          const formatEl = card.querySelector('[class*="format"], [class*="Format"], [class*="type"]')
          const format = (formatEl?.textContent || '').trim().toUpperCase() || undefined
          items.push({ name, format, itemType: 'carousel-card' })
        }
        return items
      }

      // Table rows (DocListPicker)
      const tableRows = widget.querySelectorAll('table tr')
      if (tableRows.length > 0) {
        for (const row of tableRows) {
          const cells = row.querySelectorAll('td')
          if (cells.length === 0) continue
          const nameEl = cells[0].querySelector('a, span') || cells[0]
          const name = (nameEl?.textContent || '').trim()
          if (!name || name.length < 3 || seen.has(name.toLowerCase())) continue
          seen.add(name.toLowerCase())
          const formatEl = cells.length > 1 ? cells[cells.length - 1] : null
          const formatText = (formatEl?.textContent || '').trim().toUpperCase()
          const format = formatText && formatText.length <= 10 ? formatText : undefined
          items.push({ name, format, itemType: 'table-row' })
        }
        return items
      }

      // Links (link-list sections)
      const links = widget.querySelectorAll('a[href]')
      for (const link of links) {
        const name = (link.textContent || '').trim()
        if (!name || name.length < 3 || seen.has(name.toLowerCase())) continue
        seen.add(name.toLowerCase())
        items.push({ name, itemType: 'link' })
      }

      return items
    }

    for (const widget of widgets) {
      const cls = widget.className || ''
      const isDivider = cls.includes('seismic-page-widget-divider')
      const isCover = cls.includes('seismic-page-widget-cover')
      const isAccordionWidget = cls.includes('seismic-page-widget-accordion')

      if (isDivider) {
        const dividerText = (widget.textContent || '').trim()
        if (dividerText.length > 2) {
          currentTitle = dividerText
          currentKey = toSlug(currentTitle)
        }
        continue
      }

      if (isCover) continue

      if (isAccordionWidget) {
        const accTitle = widget.querySelector('.seismic-page-divider-view')
        const accTitleText = accTitle ? (accTitle.textContent || '').trim() : currentTitle
        const accKey = toSlug(accTitleText)

        const panels = widget.querySelectorAll('.seismic-page-accordion-viewer')
        for (const panel of panels) {
          const headingEl = panel.querySelector(
            '.seismic-page-divider-view-text, .seismic-page-accordion-viewer-new-header-title'
          )
          const panelTitle = (headingEl?.textContent || '').trim().replace(/\s+/g, ' ').replace(/\s*arrow\s*(up|down)\s*$/i, '')
          if (!panelTitle || panelTitle.length < 3) continue

          const panelKey = toSlug(panelTitle)
          const panelItems = extractItemsFromWidget(panel as HTMLElement)
          for (const item of panelItems) {
            item.subSection = panelTitle
          }

          if (!results[panelKey]) {
            results[panelKey] = {
              title: panelTitle,
              type: 'doclist-picker',
              parentSection: accTitleText !== panelTitle ? accTitleText : undefined,
              items: [],
            }
          }
          const existingNames = new Set(results[panelKey].items.map(i => i.name.toLowerCase()))
          for (const item of panelItems) {
            if (!existingNames.has(item.name.toLowerCase())) {
              results[panelKey].items.push(item)
              existingNames.add(item.name.toLowerCase())
            }
          }
        }
        continue
      }

      // Regular content widget — extract items into current section
      if (currentTitle && currentKey) {
        const items = extractItemsFromWidget(widget)
        if (items.length > 0) {
          const sectionType = widget.querySelector('[class*="card"], [class*="Card"]')
            ? 'carousel'
            : widget.querySelector('table')
              ? 'doclist-picker'
              : 'link-list'

          if (!results[currentKey]) {
            results[currentKey] = { title: currentTitle, type: sectionType as any, items: [] }
          }
          const existingNames = new Set(results[currentKey].items.map(i => i.name.toLowerCase()))
          for (const item of items) {
            if (!existingNames.has(item.name.toLowerCase())) {
              results[currentKey].items.push(item)
              existingNames.add(item.name.toLowerCase())
            }
          }
        }
      }
    }

    return results
  })

  // Step 3: Merge sidebar TOC (authoritative) with DOM-extracted items
  const productSlug = slugify(productName)
  const mergedSections: Record<string, ProductSourceSection> = {}

  // Add all DOM-extracted sections first
  for (const [key, section] of Object.entries(domSections)) {
    mergedSections[key] = section as ProductSourceSection
  }

  // For each sidebar TOC entry, ensure a section exists
  let tocOnly = 0
  for (const tocEntry of sidebarTocEntries) {
    const tocKey = tocEntry.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80)
    if (!mergedSections[tocKey]) {
      mergedSections[tocKey] = {
        title: tocEntry.title,
        type: 'link-list',
        items: [],
      }
      tocOnly++
      console.log(`[product-scraper] Phase 1: Section "${tocEntry.title}" from sidebar TOC (not in DOM widgets)`)
    }
  }

  let totalItems = 0
  for (const section of Object.values(mergedSections)) {
    totalItems += section.items.length
  }

  const inventory: ProductSourceInventory = {
    name: productName,
    slug: productSlug,
    source: 'sidebar-toc',
    sourceFiles: [],
    createdAt: new Date().toISOString(),
    sections: mergedSections,
  }

  console.log(`[product-scraper] Phase 1: Inventory built — ${Object.keys(mergedSections).length} sections (${tocOnly} from sidebar TOC only), ${totalItems} items`)
  return inventory
}

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

// ── DocListPicker activation (#920) ─────────────────────────────────────────

/**
 * Clicks DocListPicker widgets inside expanded accordion panels to trigger
 * CDS API calls that load document table rows. The CDS interception set up
 * by setupCdsInterception() passively captures documents from the API
 * responses, and extractRedHeaderSections() picks up the rendered `a[href]`
 * links from the DOM.
 */
export async function expandDomainDocListPickers(
  page: Page,
): Promise<{ activated: number; domainDocs: Map<string, Array<{ name: string; url: string }>> }> {
  console.log('[product-scraper] Activating domain DocListPickers in accordion panels...')

  // (#920 ITERATION 4) Selectors from DOM inspection of actual SalesHub page
  const accordionItems = page.locator(
    '[class*="widget-accordion"] .seismic-page-accordion-viewer'
  )
  const itemCount = await accordionItems.count()
  console.log(`[product-scraper] Found ${itemCount} accordion items in domain section`)

  if (itemCount === 0) return { activated: 0, domainDocs: new Map() }

  let activated = 0
  const domainDocs = new Map<string, Array<{ name: string; url: string }>>()

  for (let i = 0; i < itemCount; i++) {
    try {
      const item = accordionItems.nth(i)

      const heading = item.locator(
        '.seismic-page-divider-view-text, .seismic-page-accordion-viewer-new-header-title'
      ).first()
      const rawText = await heading.textContent({ timeout: 10_000 }).catch(() => '')
      const domainName = (rawText || '').trim().replace(/\s+/g, ' ').replace(/\s*arrow\s*(up|down)\s*$/i, '')
      if (!domainName || domainName.length < 3) continue

      // Find DocListPicker inside this accordion item
      const picker = item.locator('[class*="docListPicker"], [class*="DocListPicker"]').first()
      const hasPicker = await picker.count().catch(() => 0)
      if (!hasPicker) continue

      // Click to trigger CDS API call — 15s timeout for Seismic dynamic content (#967)
      await picker.scrollIntoViewIfNeeded({ timeout: 10_000 })
      await picker.click({ timeout: 15_000 })
      await page.waitForTimeout(4_000)
      activated++

      // Extract document names AND hrefs from rendered content (#939)
      const docEntries = await item.evaluate((el: Element) => {
        const entries: Array<{ name: string; url: string }> = []
        const seen = new Set<string>()

        // Helper: find the closest href for a given node
        function findHref(node: Element): string {
          // Check if the node itself is an anchor
          if (node.tagName === 'A' && (node as HTMLAnchorElement).href) {
            return (node as HTMLAnchorElement).href
          }
          // Check for anchor children (e.g., seismic-page-docListPicker-cl-list-item-name)
          const anchor = node.querySelector('a.seismic-page-docListPicker-cl-list-item-name, a[href]')
          if (anchor) return (anchor as HTMLAnchorElement).href || ''
          // Check parent row/container for an anchor
          const row = node.closest('tr') || node.closest('[class*="row"]')
          if (row) {
            const rowAnchor = row.querySelector('a.seismic-page-docListPicker-cl-list-item-name, a[href]')
            if (rowAnchor) return (rowAnchor as HTMLAnchorElement).href || ''
          }
          return ''
        }

        const selectors = [
          'table tr td:first-child',
          '[class*="row"] [class*="title"]',
          '[class*="row"] [class*="name"]',
          'table td a',
          'table td span',
          'td:first-child',
        ]
        for (const sel of selectors) {
          for (const node of el.querySelectorAll(sel)) {
            const text = (node.textContent || '').trim().slice(0, 200)
            if (text.length >= 2 && !seen.has(text)) {
              seen.add(text)
              entries.push({ name: text, url: findHref(node as Element) })
            }
          }
          if (entries.length > 0) break
        }
        if (entries.length === 0) {
          for (const row of el.querySelectorAll('tr')) {
            const text = (row.textContent || '').trim().split('\n')[0]?.trim().slice(0, 200)
            if (text && text.length >= 2 && !seen.has(text)) {
              seen.add(text)
              entries.push({ name: text, url: findHref(row as Element) })
            }
          }
        }
        return entries
      })

      if (docEntries.length > 0) {
        domainDocs.set(domainName, docEntries)
        console.log(`[product-scraper] Domain "${domainName}": ${docEntries.length} docs`)
      }
    } catch (e: any) {
      console.warn(`[product-scraper] Domain accordion ${i}: ${(e.message ?? '').slice(0, 60)}`)
    }
  }

  await page.waitForTimeout(2_000)
  console.log(`[product-scraper] Activated ${activated}/${itemCount} domain DocListPickers`)
  if (domainDocs.size > 0) {
    const totalDocs = [...domainDocs.values()].reduce((sum, entries) => sum + entries.length, 0)
    const withUrls = [...domainDocs.values()].reduce((sum, entries) => sum + entries.filter(e => e.url).length, 0)
    console.log(`[product-scraper] Domain mapping: ${totalDocs} docs (${withUrls} with URLs) across ${domainDocs.size} domains`)
  }
  return { activated, domainDocs }
}

// ── Carousel Thumbnail Click-Through (#940) ─────────────────────────────────
// Business decks and Technical decks appear as scrollable thumbnail carousels.
// Items have contentId/versionId from the CDS API but NO viewer URLs.
// Clicking a thumbnail opens the Seismic viewer — capture that URL.

async function captureCarouselViewerUrls(
  page: import('playwright').Page
): Promise<{ urls: Map<string, { url: string; sectionTitle: string }>; discoveredCards: Array<{ sectionTitle: string; cards: Array<{ name: string }> }> }> {
  const results = new Map<string, { url: string; sectionTitle: string }>()
  const productPageUrl = page.url()

  console.log('[product-scraper] (#940) Discovering carousel DOM structure...')

  // Step 1: Discover the actual carousel/card sections on the page
  const carouselInfo = await page.evaluate(() => {
    const info: Array<{
      sectionTitle: string
      cardCount: number
      sectionSelector: string
      cards: Array<{ name: string; index: number }>
    }> = []

    // Look for sections containing card grids — Seismic uses various patterns
    const sectionSelectors = [
      '[class*="seismic-page-section-cards"]',
      '[class*="card-grid"]',
      '[class*="CardGrid"]',
      '[class*="carousel"]',
      '[class*="Carousel"]',
    ]

    for (const sel of sectionSelectors) {
      const sections = document.querySelectorAll(sel)
      for (const section of sections) {
        // Find the section heading
        const heading = section.closest('[class*="widget"]')?.querySelector('h1, h2, h3, [class*="title"]')
        const title = (heading?.textContent || '').trim()

        // Find card elements within
        const cardSels = ['[class*="card"]', '[class*="Card"]', '[class*="tile"]', '[class*="Tile"]', '[role="listitem"]']
        let cards: Element[] = []
        for (const cSel of cardSels) {
          const found = section.querySelectorAll(cSel)
          if (found.length > 0) {
            cards = Array.from(found)
            break
          }
        }

        if (cards.length === 0) continue

        const cardNames = cards.map((card, idx) => {
          const nameEl = card.querySelector('h2, h3, h4, h5, [class*="title"], [class*="Title"], [class*="name"]')
          const name = (nameEl?.textContent || card.textContent || '').trim().slice(0, 200)
          return { name, index: idx }
        }).filter(c => c.name.length > 3)

        info.push({
          sectionTitle: title,
          cardCount: cards.length,
          sectionSelector: sel,
          cards: cardNames,
        })
      }
    }

    // Also check DocListPicker Viewer sections — always, not just as fallback (#973)
    {
      const existingTitles = new Set(info.map(i => i.sectionTitle))
      const viewerSections = document.querySelectorAll('[class*="docListPicker-Viewer"]')
      for (const section of viewerSections) {
        const heading = section.querySelector('h1, [class*="title"]')
        const title = (heading?.textContent || '').trim()
        if (existingTitles.has(title)) continue  // skip if already found by carousel selectors
        // Look for clickable thumbnail items
        const items = section.querySelectorAll('[class*="item"], [class*="card"], a[href], [role="button"]')
        if (items.length === 0) continue
        const cardNames = Array.from(items).map((item, idx) => {
          const name = (item.textContent || '').trim().split('\n')[0]?.trim().slice(0, 200) || ''
          return { name, index: idx }
        }).filter(c => c.name.length > 3)

        info.push({
          sectionTitle: title,
          cardCount: items.length,
          sectionSelector: '[class*="docListPicker-Viewer"]',
          cards: cardNames,
        })
      }
    }

    return info
  })

  if (carouselInfo.length === 0) {
    console.log('[product-scraper] (#940) No carousel/card sections found on page')
    return { urls: results, discoveredCards: [] }
  }

  console.log(`[product-scraper] (#940) Found ${carouselInfo.length} carousel sections:`)
  for (const section of carouselInfo) {
    console.log(`  - "${section.sectionTitle}": ${section.cardCount} cards (selector: ${section.sectionSelector})`)
    for (const card of section.cards.slice(0, 5)) {
      console.log(`    [${card.index}] ${card.name.slice(0, 80)}`)
    }
    if (section.cards.length > 5) {
      console.log(`    ... and ${section.cards.length - 5} more`)
    }
  }

  // Step 2: Filter to Business decks and Technical decks sections
  const targetSections = carouselInfo.filter(s => {
    const title = s.sectionTitle.toLowerCase()
    return title.includes('business deck') || title.includes('technical deck')
      || title.includes('business presentation') || title.includes('technical presentation')
  })

  const discoveredCards = carouselInfo.map(s => ({ sectionTitle: s.sectionTitle, cards: s.cards.map(c => ({ name: c.name })) }))

  if (targetSections.length === 0) {
    console.log('[product-scraper] (#940) No Business/Technical deck carousel sections found — skipping click-through')
    return { urls: results, discoveredCards }
  }

  console.log(`[product-scraper] (#940) Will click through ${targetSections.reduce((sum, s) => sum + s.cards.length, 0)} cards across ${targetSections.length} sections`)

  // Step 3: Click each card, capture viewer URL, go back
  for (const section of targetSections) {
    console.log(`[product-scraper] (#940) Processing section: "${section.sectionTitle}"`)

    // Re-discover cards each iteration to handle DOM changes after navigation
    const processedNames = new Set<string>()
    let scrollAttempts = 0
    const maxScrollAttempts = 10
    let hasMoreCards = true

    while (hasMoreCards && scrollAttempts < maxScrollAttempts) {
      // Find the section container by title text
      const sectionHeadings = page.locator(`h1:has-text("${section.sectionTitle}"), h2:has-text("${section.sectionTitle}")`)
      const headingCount = await sectionHeadings.count().catch(() => 0)
      if (headingCount === 0) {
        console.warn(`[product-scraper] (#940) Section heading "${section.sectionTitle}" not found — may have been lost after navigation`)
        break
      }

      // Get the parent widget/container of this heading
      const headingEl = sectionHeadings.first()
      const container = headingEl.locator('xpath=ancestor::*[contains(@class, "widget") or contains(@class, "Widget") or contains(@class, "section")]').first()
      const containerExists = (await container.count().catch(() => 0)) > 0
      const searchRoot = containerExists ? container : page.locator(`text="${section.sectionTitle}"`).first().locator('..')

      // Find cards within this section
      const cardSelectors = ['[class*="card"]', '[class*="Card"]', '[class*="tile"]', '[class*="Tile"]', '[role="listitem"]', '[class*="item"]']
      let cardLocator: import('playwright').Locator | null = null
      let cardCount = 0

      for (const cSel of cardSelectors) {
        const loc = searchRoot.locator(cSel)
        const count = await loc.count().catch(() => 0)
        if (count > 0) {
          cardLocator = loc
          cardCount = count
          break
        }
      }

      if (!cardLocator || cardCount === 0) {
        // Fallback: click by card name text from the discovery phase
        console.log(`[product-scraper] (#940) No card elements found via selectors — trying text-based clicks`)
        for (const card of section.cards) {
          if (processedNames.has(card.name)) continue
          processedNames.add(card.name)
          try {
            const textLocator = page.locator(`text="${card.name.slice(0, 60)}"`).first()
            if ((await textLocator.count()) === 0) continue

            await textLocator.scrollIntoViewIfNeeded({ timeout: 3_000 })
            await textLocator.click({ timeout: 5_000 })

            // Wait for viewer page to load
            await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {})
            await page.waitForTimeout(2_000)

            const viewerUrl = page.url()
            if (viewerUrl !== productPageUrl && viewerUrl.includes('/doccenter/')) {
              results.set(card.name, { url: viewerUrl, sectionTitle: section.sectionTitle })
              console.log(`[product-scraper] (#940)   "${card.name.slice(0, 60)}" -> ${viewerUrl.slice(0, 120)}`)
            }

            // Navigate back
            await page.goBack({ waitUntil: 'domcontentloaded', timeout: 15_000 }).catch(async () => {
              console.warn('[product-scraper] (#940) goBack failed — re-navigating to product page')
              await page.goto(productPageUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 })
            })
            await page.waitForTimeout(2_000)
          } catch (e: any) {
            console.warn(`[product-scraper] (#940) Text click failed for "${card.name.slice(0, 60)}": ${(e.message ?? '').slice(0, 80)}`)
            // Ensure we're back on the product page
            if (page.url() !== productPageUrl) {
              await page.goto(productPageUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {})
              await page.waitForTimeout(3_000)
            }
          }
        }
        break // No scrolling to do with text-based approach
      }

      // Process visible cards
      for (let i = 0; i < cardCount; i++) {
        const card = cardLocator.nth(i)
        let cardName = ''

        try {
          // Extract card name
          const nameEl = card.locator('h2, h3, h4, h5, [class*="title"], [class*="Title"], [class*="name"]').first()
          if ((await nameEl.count()) > 0) {
            cardName = (await nameEl.innerText({ timeout: 3_000 }).catch(() => '')).trim()
          }
          if (!cardName) {
            cardName = (await card.innerText({ timeout: 3_000 }).catch(() => '')).trim().split('\n')[0]?.trim() || ''
          }
          cardName = cardName.slice(0, 200)
          if (!cardName || cardName.length < 3 || processedNames.has(cardName)) continue
          processedNames.add(cardName)

          // Scroll card into view if needed
          const isVisible = await card.isVisible().catch(() => false)
          if (!isVisible) {
            await card.scrollIntoViewIfNeeded({ timeout: 3_000 }).catch(() => {})
            await page.waitForTimeout(500)
          }

          // Click the card thumbnail
          await card.click({ timeout: 5_000 })

          // Wait for viewer page to load
          await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {})
          await page.waitForTimeout(2_000)

          const viewerUrl = page.url()
          if (viewerUrl !== productPageUrl && viewerUrl.includes('/doccenter/')) {
            results.set(cardName, { url: viewerUrl, sectionTitle: section.sectionTitle })
            console.log(`[product-scraper] (#940)   "${cardName.slice(0, 60)}" -> ${viewerUrl.slice(0, 120)}`)
          } else {
            console.log(`[product-scraper] (#940)   "${cardName.slice(0, 60)}" — no viewer URL (stayed on page or unexpected URL)`)
          }

          // Go back to product page
          await page.goBack({ waitUntil: 'domcontentloaded', timeout: 15_000 }).catch(async () => {
            console.warn('[product-scraper] (#940) goBack failed — re-navigating to product page')
            await page.goto(productPageUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 })
          })
          await page.waitForTimeout(2_000)

          // Wait for section to re-render after navigation
          await page.waitForSelector(`text="${section.sectionTitle}"`, { timeout: 10_000 }).catch(() => {})
        } catch (e: any) {
          console.warn(`[product-scraper] (#940) Card ${i} ("${cardName.slice(0, 40)}"): ${(e.message ?? '').slice(0, 80)}`)
          // Ensure we're back on the product page
          if (page.url() !== productPageUrl) {
            await page.goto(productPageUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {})
            await page.waitForTimeout(3_000)
          }
        }
      }

      // Try scrolling to reveal more cards via next/prev arrows
      hasMoreCards = false
      const arrowSelectors = [
        '[class*="arrow-right"]', '[class*="arrow-next"]', '[class*="next"]',
        '[class*="Arrow"]', 'button[aria-label*="next" i]', 'button[aria-label*="Next"]',
      ]
      for (const arrowSel of arrowSelectors) {
        const arrow = searchRoot.locator(arrowSel).first()
        if ((await arrow.count().catch(() => 0)) > 0 && (await arrow.isVisible().catch(() => false))) {
          await arrow.click({ timeout: 3_000 }).catch(() => {})
          await page.waitForTimeout(1_500)
          hasMoreCards = true
          break
        }
      }

      // Alternative: horizontal scroll the carousel container
      if (!hasMoreCards) {
        try {
          const scrolled = await searchRoot.evaluate((el: Element) => {
            const scrollable = el.querySelector('[class*="scroll"], [class*="carousel"], [style*="overflow"]')
              || (el.scrollWidth > el.clientWidth ? el : null)
            if (scrollable && scrollable.scrollWidth > scrollable.clientWidth) {
              scrollable.scrollLeft += scrollable.clientWidth
              return true
            }
            return false
          })
          if (scrolled) {
            await page.waitForTimeout(1_500)
            hasMoreCards = true
          }
        } catch { /* no scrollable container */ }
      }

      scrollAttempts++
    }
  }

  console.log(`[product-scraper] (#940) Captured ${results.size} viewer URLs from carousel thumbnails`)
  return { urls: results, discoveredCards }
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

    // Seismic slide decks: HTML extraction captures div wrappers with little text.
    // Fall back to innerText when the text-to-HTML ratio is very low.
    const strippedText = sanitizedHtml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
    const textRatio = sanitizedHtml.length > 0 ? strippedText.length / sanitizedHtml.length : 0
    if (textRatio < 0.3 && innerText.length > 200) {
      return { content: innerText, contentLength: innerText.length }
    }

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

/**
 * downloadViaViewerUrl — proven browser-based download for doccenter viewer pages (#929)
 *
 * Ported from /tmp/batch-download-v2.ts (8/8 success rate).
 * Handles two paths:
 *   - PDF: Click [aria-label="Download"] → wait for download event → saveAs
 *   - PPTX/DOCX: Intercept download/formats POST for auth token + body,
 *     then POST to Seismic download API → fetch blob URL → save
 */
async function downloadViaViewerUrl(
  context: BrowserContext,
  viewerUrl: string,
  outputPath: string,
  itemName: string,
): Promise<{ success: boolean; size?: number; format?: string }> {
  const dlPage = await context.newPage()
  try {
    // Navigate to viewer page with networkidle to ensure full load
    await dlPage.goto(viewerUrl, { waitUntil: 'networkidle', timeout: 45_000 })
    await dlPage.waitForTimeout(3_000)

    // Detect file type from Content Details panel
    const fileType = await dlPage.evaluate(() => {
      const text = document.body.innerText || ''
      return text.match(/File Type\n(.+)/)?.[1]?.trim() || 'unknown'
    })

    // Check for error pages
    const pageText = await dlPage.innerText('body').catch(() => '')
    if (/content\s+not\s+found|page\s+not\s+found|404/i.test(pageText.slice(0, 500))) {
      return { success: false }
    }

    // ── PDF path: direct download event ──────────────────────────────────
    if (fileType === 'PDF') {
      const downloadPromise = dlPage.waitForEvent('download', { timeout: 20_000 })
      await dlPage.click('[aria-label="Download"]')
      const dl = await downloadPromise
      const pdfPath = outputPath.replace(/\.[^.]+$/, '.pdf')
      await dl.saveAs(pdfPath)
      const size = readFileSync(pdfPath).length
      console.log(`[product-scraper] Viewer download OK (PDF): ${itemName.slice(0, 50)} (${size} bytes)`)
      return { success: true, size, format: 'PDF' }
    }

    // ── PPTX/DOCX path: intercept formats POST, then call download API ──
    let authToken = ''
    let downloadBody: any = null

    dlPage.on('request', req => {
      if (req.url().includes('download/formats') && req.method() === 'POST') {
        authToken = req.headers().authorization || ''
        try {
          downloadBody = JSON.parse(req.postData() || '{}')
        } catch { /* ignore parse errors */ }
      }
    })

    await dlPage.click('[aria-label="Download"]')
    await dlPage.waitForTimeout(3_000)

    if (!downloadBody || !authToken) {
      console.log(`[product-scraper] Viewer download: no formats request intercepted for ${itemName.slice(0, 50)}`)
      return { success: false }
    }

    // POST to Seismic download endpoint with captured auth + body
    const postBody = {
      ContentV1: {
        repository: downloadBody.Content?.repository || 'doccenter',
        type: downloadBody.Content?.type || 'file',
        name: downloadBody.Content?.name || itemName,
        libraryContent: downloadBody.Content?.libraryContent,
      },
      ApplicationWatermarkData: downloadBody.ApplicationWatermarkData,
      Expiration: null,
      Format: fileType, // PPTX, DOCX, etc.
    }

    const resp = await fetch(
      'https://saleshub.redhat.com/gateway/services/caugs/tenants/redhat/v1/download',
      {
        method: 'POST',
        headers: { 'Authorization': authToken, 'Content-Type': 'application/json' },
        body: JSON.stringify(postBody),
      },
    )

    if (!resp.ok) {
      const errBody = await resp.text().catch(() => '')
      console.log(`[product-scraper] Viewer download POST failed: ${resp.status} — ${errBody.slice(0, 100)}`)
      return { success: false }
    }

    const contentType = resp.headers.get('content-type') || ''
    const ext = fileType.toLowerCase() || 'bin'
    const finalPath = outputPath.replace(/\.[^.]+$/, `.${ext}`)

    if (contentType.includes('json')) {
      // JSON response — contains a blob download URL
      const json = await resp.json() as Record<string, any>
      // CRITICAL: Response field is `Url` (capital U), check both cases
      const blobUrl = json.Url || json.url || json.downloadUrl || json.blobUrl
      if (!blobUrl) {
        console.log(`[product-scraper] Viewer download: no blob URL in JSON response for ${itemName.slice(0, 50)}`)
        return { success: false }
      }

      const blobResp = await fetch(blobUrl)
      if (!blobResp.ok) {
        console.log(`[product-scraper] Viewer download: blob fetch failed ${blobResp.status} for ${itemName.slice(0, 50)}`)
        return { success: false }
      }

      const buf = await blobResp.arrayBuffer()
      writeFileSync(finalPath, Buffer.from(buf))
      console.log(`[product-scraper] Viewer download OK (${fileType}): ${itemName.slice(0, 50)} (${buf.byteLength} bytes)`)
      return { success: true, size: buf.byteLength, format: fileType }
    } else {
      // Binary response — the file itself
      const buf = await resp.arrayBuffer()
      writeFileSync(finalPath, Buffer.from(buf))
      console.log(`[product-scraper] Viewer download OK (${fileType}): ${itemName.slice(0, 50)} (${buf.byteLength} bytes)`)
      return { success: true, size: buf.byteLength, format: fileType }
    }
  } catch (e: any) {
    console.warn(`[product-scraper] Viewer download error for ${itemName.slice(0, 50)}: ${(e.message ?? '').slice(0, 80)}`)
    return { success: false }
  } finally {
    await dlPage.close()
  }
}

async function downloadProductDocuments(
  page: Page,
  context: BrowserContext,
  sections: Record<string, ProductSection>,
  productSlug: string,
  authCtx: { auth: string; headers: Record<string, string>; searchUrl: string },
  manifest: PipelineManifest | null = null,
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

    // External domains — route by type (#966)
    try {
      const parsedUrl = new URL(item.url)
      const host = parsedUrl.hostname
      const isSeismic = host.includes('saleshub.redhat.com') || host.includes('seismic.com')
      const isRedHatDomain = host.includes('redhat.com')
      const isGoogleDocs = host.includes('docs.google.com') || host.includes('slides.google.com')
      const isForrester = host.includes('forrester.com')

      if (!isSeismic && !isRedHatDomain && !isGoogleDocs && !isForrester) {
        viewerSkipped++
        continue
      }

      // Google Docs/Slides — export via Drive API (#969)
      if (isGoogleDocs) {
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
          // Extract document ID from Google URL
          const docIdMatch = item.url.match(/\/d\/([a-zA-Z0-9_-]+)/)
          if (!docIdMatch) {
            console.warn(`[product-scraper] Google Docs: no document ID found in URL for "${item.name.slice(0, 40)}"`)
            viewerSkipped++
            continue
          }
          const docId = docIdMatch[1]

          // Load Google OAuth credentials
          const { makeAuth } = await import('../src/google.ts')
          const auth = makeAuth('google-token.json')
          const { token: accessToken } = await auth.getAccessToken()
          if (!accessToken) {
            console.warn(`[product-scraper] Google Docs: no OAuth token available for "${item.name.slice(0, 40)}"`)
            viewerSkipped++
            continue
          }

          // Export as plain text via Drive API
          const exportUrl = `https://www.googleapis.com/drive/v3/files/${docId}/export?mimeType=text/plain`
          const resp = await fetch(exportUrl, {
            headers: { Authorization: `Bearer ${accessToken}` },
            signal: AbortSignal.timeout(30_000),
          })

          if (resp.ok) {
            const gText = (await resp.text()).trim()
            if (gText.length > 100) {
              mkdirSync(extractDir, { recursive: true })
              writeFileSync(extractPath, gText, 'utf-8')
              viewerExtractedNames.add(sanitizeFilename(item.name).slice(0, 60))
              viewerExtracted++
              console.log(`[product-scraper] Google Drive export: ${item.name.slice(0, 50)} (${gText.length} chars)`)
            } else {
              viewerSkipped++
              console.log(`[product-scraper] Google Drive export too short: ${item.name.slice(0, 50)} (${gText.length} chars)`)
            }
          } else {
            const errBody = await resp.text().catch(() => '')
            console.warn(`[product-scraper] Google Drive export ${resp.status} for "${item.name.slice(0, 40)}": ${errBody.slice(0, 100)}`)
            viewerSkipped++
          }
        } catch (e: any) {
          console.warn(`[product-scraper] Google Drive export failed for "${item.name.slice(0, 40)}": ${(e.message ?? '').slice(0, 80)}`)
          viewerSkipped++
        }
        continue
      }

      if (!isSeismic) {
        // Fetch external content (redhat.com, forrester.com) directly via HTTP
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
            // Detect SSO/login pages — these are not real content (#966)
            if (html.includes('ssolandingpage') || html.includes('Log in | Red Hat Content Center') || html.includes('Sign in for Red Hat')) {
              console.log(`[product-scraper] SSO login page detected for "${item.name.slice(0, 50)}" — skipping HTTP extraction`)
              viewerSkipped++
              continue
            }
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
    } catch (outerErr: any) {
      console.warn(`[product-scraper] Phase 3a outer error for "${item.name?.slice(0, 40)}": ${(outerErr?.message ?? '').slice(0, 80)}`)
      viewerSkipped++
      continue
    }

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

  // ── Phase 3a2: Browser-based viewer download for doccenter items (#929) ────
  // Items with doccenter viewer URLs get downloaded via the proven browser
  // Download button pattern (PDF direct + PPTX/DOCX API intercept).
  // This runs BEFORE the generic file download loop to acquire files that
  // the old viewer click-to-download failed on (PPTX/DOCX).
  const viewerDownloadDir = resolve(productDir, 'downloads', 'viewer')
  mkdirSync(viewerDownloadDir, { recursive: true })
  const viewerDownloadedNames = new Set<string>()
  let viewerDownloaded = 0

  for (const { item, sectionKey } of downloadQueue) {
    if (!item.url) continue
    // Only target doccenter viewer URLs
    if (!item.url.includes('doccenter') || !item.url.includes('/doc/')) continue
    // Skip if already extracted via Phase 3a
    const safeName = sanitizeFilename(item.name).slice(0, 60)
    if (viewerExtractedNames.has(safeName)) continue

    // Check if already downloaded (cached)
    const safeFilename = sanitizeFilename(item.name)
    const existingInViewer = existsSync(viewerDownloadDir)
      ? readdirSync(viewerDownloadDir).filter((f: string) => f.startsWith(safeFilename.slice(0, 60)))
      : []
    if (existingInViewer.length > 0) {
      viewerDownloadedNames.add(safeName)
      viewerDownloaded++
      continue
    }

    const outputPath = resolve(viewerDownloadDir, `${safeFilename}.bin`)
    const result = await downloadViaViewerUrl(context, item.url, outputPath, item.name)
    if (result.success) {
      viewerDownloadedNames.add(safeName)
      viewerDownloaded++
      downloaded++
      consecutiveFailures = 0
      // Update pipeline manifest gate 2 (#929)
      if (manifest) {
        const ext = (result.format || 'bin').toLowerCase()
        const dlPath = outputPath.replace(/\.[^.]+$/, `.${ext}`)
        updateGate2(manifest, item.name, {
          gate2_downloaded: true,
          gate2_acquisitionMethod: 'viewer-download',
          gate2_downloadPath: dlPath,
        })
      }
    }
    // Brief pause between viewer downloads
    await new Promise(r => setTimeout(r, 1_000))
  }
  if (viewerDownloaded > 0) {
    console.log(`[product-scraper] Phase 3a2 complete: ${viewerDownloaded} viewer downloads`)
  }

  // ── Phase 3b: File downloads — SECONDARY, only for items not already extracted/downloaded ──
  for (const { item, sectionKey, sectionTitle } of downloadQueue) {
    // Skip items that already have viewer-extracted content or viewer downloads (#929)
    const safeName = sanitizeFilename(item.name).slice(0, 60)
    if (viewerExtractedNames.has(safeName) || viewerDownloadedNames.has(safeName)) {
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
          contentId: doc.Id ?? doc.ContentId ?? '',
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

// Auth-gated URL patterns — documents requiring OAuth/SSO/paywall
const AUTH_GATED_PATTERNS = [
  { pattern: /docs\.google\.com/, reason: 'Google Docs requiring OAuth' },
  { pattern: /forrester\.com/, reason: 'Forrester paywall' },
  { pattern: /content\.redhat\.com/, reason: 'Red Hat SSO required' },
  { pattern: /gartner\.com/, reason: 'Gartner paywall' },
  { pattern: /idc\.com/, reason: 'IDC paywall' },
]

function isAuthGated(url?: string): { gated: boolean; reason?: string } {
  if (!url) return { gated: false }
  for (const { pattern, reason } of AUTH_GATED_PATTERNS) {
    if (pattern.test(url)) return { gated: true, reason }
  }
  return { gated: false }
}

function generateCompletenessManifest(
  sections: Record<string, ProductSection>,
  enrichedPath: string,
  productSlug: string,
  productSourcePath?: string,
): object & { coverage?: number } {
  let enrichedNames: Set<string> | null = null
  if (existsSync(enrichedPath)) {
    try {
      const enrichment: ProductEnrichment = JSON.parse(readFileSync(enrichedPath, 'utf-8'))
      enrichedNames = new Set(
        (enrichment.documents ?? []).map(d => d.documentName.toLowerCase()),
      )
    } catch { /* enriched file unreadable — treat as no enrichment */ }
  }

  // Build a lookup of all captured items from _product.json (scraper output)
  const capturedItemNames = new Set<string>()
  const capturedItemUrls = new Map<string, string>()
  for (const section of Object.values(sections)) {
    for (const item of section.items) {
      capturedItemNames.add(item.name.toLowerCase().slice(0, 80))
      if (item.url) capturedItemUrls.set(item.name.toLowerCase().slice(0, 80), item.url)
    }
    if (section.subsections) {
      for (const sub of section.subsections) {
        for (const item of sub.items) {
          capturedItemNames.add(item.name.toLowerCase().slice(0, 80))
          if (item.url) capturedItemUrls.set(item.name.toLowerCase().slice(0, 80), item.url)
        }
      }
    }
  }

  // Phase 3 comparison: if _product-source.json exists, compare against it
  let productSource: ProductSourceInventory | null = null
  if (productSourcePath && existsSync(productSourcePath)) {
    try {
      productSource = JSON.parse(readFileSync(productSourcePath, 'utf-8'))
    } catch { /* source file unreadable */ }
  }

  if (productSource) {
    const comparisonSections: Array<{
      sectionName: string
      sectionKey: string
      sourceItemCount: number
      items: Array<{
        name: string
        status: 'CAPTURED' | 'AUTH-GATED' | 'MISSING'
        reason?: string
        enriched: boolean
      }>
    }> = []

    let totalCaptured = 0
    let totalAuthGated = 0
    let totalMissing = 0
    let totalEnriched = 0
    let missingSections: string[] = []

    // Check for sections in source that are missing from scraper output
    const scraperSectionKeys = new Set(Object.keys(sections).map(k => k.toLowerCase()))

    for (const [sourceKey, sourceSection] of Object.entries(productSource.sections)) {
      const items: typeof comparisonSections[0]['items'] = []

      for (const sourceItem of sourceSection.items) {
        const nameKey = sourceItem.name.toLowerCase().slice(0, 80)
        const enriched = enrichedNames ? enrichedNames.has(nameKey) : false

        if (capturedItemNames.has(nameKey)) {
          items.push({ name: sourceItem.name, status: 'CAPTURED', enriched })
          totalCaptured++
          if (enriched) totalEnriched++
        } else {
          // Check if the item's URL in the scraper output suggests auth-gating
          const matchedUrl = capturedItemUrls.get(nameKey)
          const authCheck = isAuthGated(matchedUrl)
          if (authCheck.gated) {
            items.push({ name: sourceItem.name, status: 'AUTH-GATED', reason: authCheck.reason, enriched: false })
            totalAuthGated++
          } else {
            items.push({ name: sourceItem.name, status: 'MISSING', enriched: false })
            totalMissing++
          }
        }
      }

      if (!scraperSectionKeys.has(sourceKey.toLowerCase())) {
        missingSections.push(sourceSection.title)
      }

      comparisonSections.push({
        sectionName: sourceSection.title,
        sectionKey: sourceKey,
        sourceItemCount: sourceSection.items.length,
        items,
      })
    }

    const coverage = totalCaptured + totalMissing > 0
      ? totalCaptured / (totalCaptured + totalMissing)
      : 1

    return {
      product: productSlug,
      generatedAt: new Date().toISOString(),
      comparedAgainst: '_product-source.json',
      sections: comparisonSections,
      missingSections,
      totals: {
        sourceItems: totalCaptured + totalAuthGated + totalMissing,
        captured: totalCaptured,
        authGated: totalAuthGated,
        missing: totalMissing,
        enriched: totalEnriched,
      },
      coverage,
      coveragePercent: Math.round(coverage * 1000) / 10,
      coverageGatePassed: coverage >= 0.8,
    }
  }

  // Fallback: original behavior when no _product-source.json exists
  const sectionResults: Array<{
    sectionName: string
    sectionKey: string
    pageVisibleCount: number
    domVisibleCount: number
    apiMergedCount: number
    capturedCount: number
    enrichedCount: number
    gap: boolean
    gapType: string | null
    items: Array<{ name: string; captured: boolean; enriched: boolean }>
  }> = []

  let totalPageVisible = 0
  let totalDomVisible = 0
  let totalApiMerged = 0
  let totalCaptured = 0
  let totalEnriched = 0
  let totalGapSections = 0

  const collectItems = (section: ProductSection): Array<{ name: string; captured: boolean; enriched: boolean; isApiOnly: boolean }> => {
    const items: Array<{ name: string; captured: boolean; enriched: boolean; isApiOnly: boolean }> = []
    for (const item of section.items) {
      const enriched = enrichedNames
        ? enrichedNames.has(item.name.toLowerCase())
        : false
      const isApiOnly = !!(item as any).seismicContentType && !(item as any)._domSource
      items.push({ name: item.name, captured: true, enriched, isApiOnly })
    }
    if (section.subsections) {
      for (const sub of section.subsections) {
        for (const item of sub.items) {
          const enriched = enrichedNames
            ? enrichedNames.has(item.name.toLowerCase())
            : false
          const isApiOnly = !!(item as any).seismicContentType && !(item as any)._domSource
          items.push({ name: item.name, captured: true, enriched, isApiOnly })
        }
      }
    }
    return items
  }

  for (const [sectionKey, section] of Object.entries(sections)) {
    const items = collectItems(section)
    const pageVisibleCount = items.length
    const domVisibleCount = items.filter(i => !i.isApiOnly).length
    const apiMergedCount = items.filter(i => i.isApiOnly).length
    const capturedCount = items.length
    const enrichedCount = items.filter(i => i.enriched).length
    const hasEnrichmentGap = enrichedNames !== null && items.some(i => !i.enriched)
    const gap = hasEnrichmentGap
    const gapType = gap ? 'enrichment_incomplete' : null

    sectionResults.push({
      sectionName: section.title,
      sectionKey,
      pageVisibleCount,
      domVisibleCount,
      apiMergedCount,
      capturedCount,
      enrichedCount,
      gap,
      gapType,
      items,
    })

    totalPageVisible += pageVisibleCount
    totalDomVisible += domVisibleCount
    totalApiMerged += apiMergedCount
    totalCaptured += capturedCount
    totalEnriched += enrichedCount
    if (gap) totalGapSections++
  }

  return {
    product: productSlug,
    generatedAt: new Date().toISOString(),
    sections: sectionResults,
    totals: {
      pageVisible: totalPageVisible,
      domVisible: totalDomVisible,
      apiMerged: totalApiMerged,
      captured: totalCaptured,
      enriched: totalEnriched,
      gapSections: totalGapSections,
    },
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

    // Scroll down to trigger lazy loading — multi-pass for SPA lazy-loaded content (#942)
    console.log('[product-scraper] Scrolling page to trigger lazy loading...')
    await page.evaluate(async () => {
      const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))
      let prevHeight = 0
      let passes = 0
      const MAX_PASSES = 8
      while (passes < MAX_PASSES) {
        const scrollHeight = document.body.scrollHeight
        if (scrollHeight === prevHeight && passes > 0) break // height stabilized
        prevHeight = scrollHeight
        const step = window.innerHeight
        for (let y = 0; y < scrollHeight; y += step) {
          window.scrollTo(0, y)
          await delay(200)
        }
        // Stay at bottom for lazy load to trigger
        window.scrollTo(0, document.body.scrollHeight)
        await delay(2000)
        passes++
      }
      window.scrollTo(0, 0)
    })
    await page.waitForTimeout(3_000)
    const finalHeight = await page.evaluate(() => document.body.scrollHeight)
    console.log(`[product-scraper] Lazy load scroll complete — final page height: ${finalHeight}px`)

    // Extract product header
    const header = await extractProductHeader(page)
    console.log(`[product-scraper] Product: "${header.name}"`)

    // Expand all accordions BEFORE DOM extraction (#874 — Gate 0)
    // Content inside collapsed accordions is invisible to extractRedHeaderSections()
    await expandAllAccordions(page)

    // Activate DocListPicker widgets to trigger CDS API loads (#920)
    const { domainDocs } = await expandDomainDocListPickers(page)

    // Screenshot audit artifact (#874 — Gate 0)
    // Saved BEFORE extractRedHeaderSections() so the screenshot shows the fully-expanded page
    const earlyProductSlug = slugify(header.name)
    const earlyConfigOutputDir = resolve('config-templates', 'saleshub-products', earlyProductSlug)
    mkdirSync(earlyConfigOutputDir, { recursive: true })
    await page.screenshot({ fullPage: true, path: resolve(earlyConfigOutputDir, '_page-screenshot.png') })
    console.log('[product-scraper] Saved page screenshot as audit artifact')

    // Phase 1 (#972): Build product source inventory from DOM BEFORE extraction
    const productSourceInventory = await buildProductSourceInventory(page, header.name)
    const screenshotName = '_page-screenshot.png'
    productSourceInventory.sourceFiles = [screenshotName]
    writeJsonAtomic(resolve(earlyConfigOutputDir, '_product-source.json'), productSourceInventory)
    const earlyCacheOutputDir = resolve(CACHE_DIR, 'saleshub', 'products', earlyProductSlug)
    mkdirSync(earlyCacheOutputDir, { recursive: true })
    writeJsonAtomic(resolve(earlyCacheOutputDir, '_product-source.json'), productSourceInventory)
    console.log(`[product-scraper] Phase 1: Wrote _product-source.json (${Object.keys(productSourceInventory.sections).length} sections)`)

    // Extract red header sections (DOM — structure + text + accordion links)
    console.log('[product-scraper] Extracting sections by red header bars...')
    const { sections, domainDocLookup } = await extractRedHeaderSections(page)
    // (#920/#939) Merge DocListPicker domain mapping into domainDocLookup + create domain sections
    for (const [domain, docEntries] of domainDocs) {
      const domainKey = slugify(domain)
      // Build or extend the domain section with items from DocListPicker
      if (!sections[domainKey]) {
        sections[domainKey] = { title: domain, type: 'cards', items: [] }
      }
      const existingNames = new Set(sections[domainKey].items.map(i => i.name.toLowerCase().slice(0, 50)))
      for (const entry of docEntries) {
        // Always populate domainDocLookup for API tagging
        domainDocLookup.set(entry.name.toLowerCase().slice(0, 50), domain)
        // Dedup: only add if not already in this domain section
        if (existingNames.has(entry.name.toLowerCase().slice(0, 50))) continue
        existingNames.add(entry.name.toLowerCase().slice(0, 50))
        const sectionItem: SectionItem = {
          name: entry.name,
          url: entry.url || undefined,
          domain,
          _domSource: true,
        } as SectionItem & { _domSource: boolean }
        sections[domainKey].items.push(sectionItem)
      }
    }
    if (domainDocs.size > 0) {
      console.log(`[product-scraper] domainDocLookup after DocListPicker merge: ${domainDocLookup.size} entries across ${new Set(domainDocLookup.values()).size} domains`)
      console.log(`[product-scraper] Created/updated ${domainDocs.size} domain sections in _product.json`)
    }
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
    // Always query to build a versionId lookup for CDS enrichment; only MERGE into sections if not --page-only
    let apiDocsByVersionId = new Map<string, DocCenterDocument & { contentId?: string; format?: string }>()
    if (authCtx) {
      try {
        const apiDocs = await queryDocumentsByProduct(page, authCtx, header.name)
        console.log(`[product-scraper] Step 4: API returned ${apiDocs.length} documents for "${header.name}"`)
        for (const doc of apiDocs) {
          if (doc.versionId) apiDocsByVersionId.set(doc.versionId, doc as any)
        }
        console.log(`[product-scraper] Step 4: Built versionId lookup (${apiDocsByVersionId.size} entries)`)
      } catch (e: any) {
        console.warn(`[product-scraper] Step 4: API query failed: ${(e.message ?? '').slice(0, 80)}`)
      }
    }
    if (skipApiMerge) {
      console.log('[product-scraper] Step 4: Skipping API section merge (--page-only mode)')
    } else if (authCtx && apiDocsByVersionId.size > 0) {
      const apiDocs = [...apiDocsByVersionId.values()]

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

          const items: SectionItem[] = docs
            .filter(doc => {
              // (#939) Skip items already placed in a domain section — avoid duplicate placement
              const domain = domainDocLookup.get(doc.name.toLowerCase().slice(0, 50))
              if (domain) {
                // Item is in a domain section — enrich the domain section item instead
                const domainKey = slugify(domain)
                if (sections[domainKey]) {
                  const domainItem = sections[domainKey].items.find(
                    i => i.name.toLowerCase().slice(0, 50) === doc.name.toLowerCase().slice(0, 50)
                  )
                  if (domainItem) {
                    if (!domainItem.contentId && (doc as any).contentId) domainItem.contentId = (doc as any).contentId
                    if (!domainItem.versionId && doc.versionId) domainItem.versionId = doc.versionId
                    if (!domainItem.url && doc.downloadUrl) domainItem.url = doc.downloadUrl
                    if (!(domainItem as any).format && (doc as any).format) (domainItem as any).format = (doc as any).format
                    if (!(domainItem as any).seismicContentType) (domainItem as any).seismicContentType = contentType
                    return false // skip adding to content-type section
                  }
                }
              }
              return true
            })
            .map(doc => {
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

    // ── Carousel thumbnail click-through for viewer URLs (#940) ──────────
    // Business decks and Technical decks items have contentId/versionId from API
    // but no viewer URLs. Click each thumbnail to discover the viewer URL.
    const { urls: carouselUrls, discoveredCards } = await captureCarouselViewerUrls(page)

    // First: add discovered card names as items to sections that are empty (#973)
    let cardsAdded = 0
    for (const { sectionTitle, cards } of discoveredCards) {
      const sectionKey = slugify(sectionTitle)
      if (!sections[sectionKey]) {
        sections[sectionKey] = { title: sectionTitle, type: 'cards', items: [] }
      }
      const section = sections[sectionKey]
      const existingNames = new Set(section.items.map(i => i.name.toLowerCase().slice(0, 50)))
      for (const card of cards) {
        if (!card.name || card.name.length < 4) continue
        const cleanName = card.name.split('\n')[0]?.trim() || card.name
        if (existingNames.has(cleanName.toLowerCase().slice(0, 50))) continue
        section.items.push({ name: cleanName })
        existingNames.add(cleanName.toLowerCase().slice(0, 50))
        cardsAdded++
      }
    }
    if (cardsAdded > 0) {
      console.log(`[product-scraper] (#940) Added ${cardsAdded} carousel card names as section items`)
    }

    // Then: assign URLs from click-through to matching items
    if (carouselUrls.size > 0) {
      let matched = 0
      let added = 0
      for (const [name, { url: viewerUrl, sectionTitle }] of carouselUrls) {
        let found = false
        for (const sectionKey of Object.keys(sections)) {
          const section = sections[sectionKey]
          if (!section) continue
          const item = section.items.find(i =>
            i.name.toLowerCase().includes(name.toLowerCase().slice(0, 50))
            || name.toLowerCase().includes(i.name.toLowerCase().slice(0, 50))
          )
          if (item) {
            if (!item.url) item.url = viewerUrl
            matched++
            found = true
            break
          }
        }
        if (!found) {
          const targetKey = slugify(sectionTitle)
          if (!sections[targetKey]) {
            sections[targetKey] = { title: sectionTitle, type: 'cards', items: [] }
          }
          sections[targetKey].items.push({ name, url: viewerUrl })
          added++
        }
      }
      console.log(`[product-scraper] (#940) Carousel URL assignment: ${matched} matched, ${added} added as new items`)
    }

    // ── CDS-driven section population (#973) ─────────────────────────────
    // DocListPicker panels load documents via CDS API (intercepted passively).
    // These documents have names, contentIds, versionIds, and sometimes originUrls.
    // Add CDS documents directly as items to their matching carousel sections.
    // Section assignment uses carousel discovery: match CDS doc names to the
    // carousel section that contains a visually-similar card.
    {
      // Build a flat list of CDS document names for matching
      const cdsNames = new Set(cdsDocuments.map(d => d.name.toLowerCase().trim()))

      // For carousel sections with 0 items, add CDS documents that aren't placed elsewhere
      const placedCdsNames = new Set<string>()
      // First pass: match CDS documents to sections by name prefix similarity
      for (const { sectionTitle, cards } of discoveredCards) {
        const sectionKey = slugify(sectionTitle)
        if (!sections[sectionKey]) {
          sections[sectionKey] = { title: sectionTitle, type: 'cards', items: [] }
        }
        const section = sections[sectionKey]
        const existingNames = new Set(section.items.map(i => i.name.toLowerCase().trim()))

        // Find CDS docs whose names contain the section title keywords
        for (const cdsDoc of cdsDocuments) {
          if (placedCdsNames.has(cdsDoc.name.toLowerCase().trim())) continue
          if (existingNames.has(cdsDoc.name.toLowerCase().trim())) {
            placedCdsNames.add(cdsDoc.name.toLowerCase().trim())
            continue
          }
          // Skip non-content formats
          if (['JSON', 'MP4', 'YouTube'].includes(cdsDoc.format)) continue

          // Match CDS doc to section if the doc name contains section-relevant keywords
          const sectionWords = sectionTitle.toLowerCase().split(/\s+/).filter(w => w.length > 3)
          const docNameLower = cdsDoc.name.toLowerCase()
          const matchScore = sectionWords.filter(w => docNameLower.includes(w)).length / Math.max(sectionWords.length, 1)

          if (matchScore >= 0.5) {
            section.items.push({
              name: cdsDoc.name,
              url: cdsDoc.originUrl || undefined,
              contentId: cdsDoc.contentId || undefined,
              versionId: cdsDoc.versionId || undefined,
              format: cdsDoc.format || undefined,
              itemType: 'cds-discovered',
            })
            existingNames.add(cdsDoc.name.toLowerCase().trim())
            placedCdsNames.add(cdsDoc.name.toLowerCase().trim())
          }
        }
      }

      // Second pass: add remaining unplaced CDS documents to a catch-all section
      const unplacedDocs = cdsDocuments.filter(d =>
        !placedCdsNames.has(d.name.toLowerCase().trim())
        && !['JSON', 'MP4', 'YouTube'].includes(d.format)
        && d.name.length > 3
      )
      if (unplacedDocs.length > 0) {
        const catchallKey = 'page-documents'
        if (!sections[catchallKey]) {
          sections[catchallKey] = { title: 'Page Documents', type: 'cards', items: [] }
        }
        const existingNames = new Set(sections[catchallKey].items.map(i => i.name.toLowerCase().trim()))
        // Also check ALL sections for already-placed items
        const allPlacedNames = new Set<string>()
        for (const sec of Object.values(sections)) {
          for (const item of sec.items) {
            allPlacedNames.add(item.name.toLowerCase().trim())
          }
        }
        for (const doc of unplacedDocs) {
          if (allPlacedNames.has(doc.name.toLowerCase().trim())) continue
          sections[catchallKey].items.push({
            name: doc.name,
            url: doc.originUrl || undefined,
            contentId: doc.contentId || undefined,
            versionId: doc.versionId || undefined,
            format: doc.format || undefined,
            itemType: 'cds-discovered',
          })
        }
        console.log(`[product-scraper] CDS catch-all: ${sections[catchallKey].items.length} unmatched documents`)
      }

      const totalCdsAdded = cdsDocuments.filter(d => placedCdsNames.has(d.name.toLowerCase().trim())).length
      console.log(`[product-scraper] CDS-driven population: ${totalCdsAdded} matched to sections, ${unplacedDocs.length} in catch-all`)

    }

    // ── CDS → API cross-reference by versionId (#973) ───────────────────
    // CDS interception captured page-visible documents. The API query has
    // downloadUrls + contentTypes. Cross-reference by versionId (UUID match)
    // to enrich CDS documents and assign them to the correct sections.
    if (cdsDocuments.length > 0) {
      let cdsMatched = 0
      let cdsAdded = 0
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
        'E-book': 'Key resources',
        'Overview': 'Key resources',
        'Case study': 'Customer References',
        'Customer go-live report': 'Customer References',
        'Customer success snapshot': 'Customer References',
        'Technical presentation': 'Technical decks',
      }

      const allExistingNames = new Set<string>()
      for (const sec of Object.values(sections)) {
        for (const item of sec.items) {
          allExistingNames.add(item.name.toLowerCase().trim())
        }
      }

      for (const doc of cdsDocuments) {
        if (!doc.name || doc.name.length < 4) continue
        if (['JSON'].includes(doc.format)) continue
        if (allExistingNames.has(doc.name.toLowerCase().trim())) {
          // Already exists — just enrich with CDS metadata
          for (const sec of Object.values(sections)) {
            const existing = sec.items.find(i => i.name.toLowerCase().trim() === doc.name.toLowerCase().trim())
            if (existing) {
              if (!existing.contentId && doc.contentId) existing.contentId = doc.contentId
              if (!existing.versionId && doc.versionId) existing.versionId = doc.versionId
              if (!existing.url && doc.originUrl) existing.url = doc.originUrl
              break
            }
          }
          continue
        }

        // Cross-reference with API by versionId to get downloadUrl + contentType
        const apiDoc = doc.versionId ? apiDocsByVersionId.get(doc.versionId) : undefined
        const downloadUrl = doc.originUrl || apiDoc?.downloadUrl || undefined
        const contentType = apiDoc?.contentType || ''
        const sectionName = typeToSection[contentType] || ''
        const contentId = doc.contentId || (apiDoc as any)?.contentId || undefined

        // Determine target section
        let targetKey = sectionName ? slugify(sectionName) : ''
        if (targetKey && !sections[targetKey]) {
          sections[targetKey] = { title: sectionName, type: 'cards', items: [] }
        }
        if (!targetKey) targetKey = 'page-documents'
        if (!sections[targetKey]) {
          sections[targetKey] = { title: 'Page Documents', type: 'cards', items: [] }
        }

        sections[targetKey].items.push({
          name: doc.name,
          url: downloadUrl,
          contentId,
          versionId: doc.versionId || undefined,
          format: doc.format || apiDoc?.contentType || undefined,
          itemType: 'cds-discovered',
        } as any)
        allExistingNames.add(doc.name.toLowerCase().trim())
        if (apiDoc) cdsMatched++
        cdsAdded++
      }
      console.log(`[product-scraper] (#973) CDS→API cross-ref: ${cdsAdded} added (${cdsMatched} matched by versionId)`)
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
      await downloadProductDocuments(page, context, sections, slugify(header.name), authCtx, manifest)
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
    writeManifest(manifest, cacheOutputDir)
    console.log(`[product-scraper] Pipeline manifest: Gate 0=${manifest.gates.gate0_domItemCount} DOM + ${manifest.gates.gate0_apiItemCount} API-only (${manifest.documents.length} total), Gate 1=${manifest.gates.gate1_scrapedCount} scraped (${(manifest.gates.gate1_passRate * 100).toFixed(0)}% pass), Gate 2=${manifest.gates.gate2_downloadedCount} downloaded`)

    // Phase 3 coverage gate (#972): check coverage BEFORE enrichment
    const productSourcePath = resolve(configOutputDir, '_product-source.json')
    let coverageGatePassed = true
    if (existsSync(productSourcePath)) {
      const preEnrichManifest = generateCompletenessManifest(sections, resolve(configOutputDir, '_enriched.json'), productSlug, productSourcePath) as any
      const coverage = preEnrichManifest.coverage ?? 1
      coverageGatePassed = coverage >= 0.8
      if (!coverageGatePassed) {
        console.warn(`[product-scraper] Coverage ${(coverage * 100).toFixed(1)}% below 80% gate — skipping enrichment`)
      } else {
        console.log(`[product-scraper] Phase 3 coverage gate: ${(coverage * 100).toFixed(1)}% (passed)`)
      }
    }

    // ── Step 6: Inline enrichment — runs in the SAME process as the scraper ──
    // This ensures scrape → extract → enrich → manifest update all happen on one machine.
    // Enrichment reads extracted/ HTML files, runs Gemini DocumentIntelligence extraction,
    // and updates the manifest with Gate 2/3 data.
    if (!coverageGatePassed) {
      console.log('[product-scraper] Step 6: Skipping inline enrichment (coverage gate failed)')
    } else {
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
              if (lower.endsWith('.pptx') || lower.endsWith('.docx')) {
                // Extract text from Office files via Python zipfile (#968)
                try {
                  const { execSync } = await import('child_process')
                  const pyScript = lower.endsWith('.pptx')
                    ? `import zipfile,re,sys;z=zipfile.ZipFile(sys.argv[1]);slides=[n for n in z.namelist() if n.startswith('ppt/slides/slide') and n.endswith('.xml')];slides.sort();text=[];
[text.append(re.sub(r'<[^>]+>',' ',z.read(s).decode('utf-8',errors='ignore'))) for s in slides];print(re.sub(r'\\s+',' ','\\n'.join(text)).strip())`
                    : `import zipfile,re,sys;z=zipfile.ZipFile(sys.argv[1]);text=re.sub(r'<[^>]+>',' ',z.read('word/document.xml').decode('utf-8',errors='ignore'));print(re.sub(r'\\s+',' ',text).strip())`
                  const extracted = execSync(`python3 -c "${pyScript}" "${filePath}"`, { maxBuffer: 50_000_000, timeout: 30_000 }).toString('utf-8').trim()
                  if (extracted.length > 100) {
                    content = extracted
                    console.log(`[product-scraper] PPTX/DOCX text extracted: ${file.slice(0, 50)} (${extracted.length} chars)`)
                  } else {
                    content = `[PDF:base64:${readFileSync(filePath).toString('base64')}]`
                    console.warn(`[product-scraper] PPTX/DOCX extraction too short (${extracted.length}), falling back to base64`)
                  }
                } catch (e: any) {
                  console.warn(`[product-scraper] PPTX/DOCX extraction failed: ${(e.message ?? '').slice(0, 60)}, falling back to base64`)
                  content = `[PDF:base64:${readFileSync(filePath).toString('base64')}]`
                }
              } else if (lower.endsWith('.pdf')) {
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
            writeJsonAtomic(resolve(cacheOutputDir, '_enriched.json'), enrichment)
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
    }

    // Generate completeness manifest (#924, #972 Phase 3) — after enrichment, before Drive upload
    const completenessManifest = generateCompletenessManifest(sections, resolve(configOutputDir, '_enriched.json'), productSlug, productSourcePath) as any
    writeJsonAtomic(resolve(configOutputDir, '_completeness-manifest.json'), completenessManifest)
    writeJsonAtomic(resolve(cacheOutputDir, '_completeness-manifest.json'), completenessManifest)
    if (completenessManifest.comparedAgainst) {
      console.log(`[product-scraper] Completeness manifest (Phase 3): ${completenessManifest.totals.captured} captured, ${completenessManifest.totals.authGated} auth-gated, ${completenessManifest.totals.missing} missing — coverage ${completenessManifest.coveragePercent}%`)
    } else {
      console.log(`[product-scraper] Completeness manifest: ${completenessManifest.totals.pageVisible} visible, ${completenessManifest.totals.enriched} enriched, ${completenessManifest.totals.gapSections} gaps`)
    }

    // Upload all product data to Drive for cross-node visibility (#874 PR 3)
    let driveProductFolderId: string | null = null
    try {
      const { uploadProductToDrive, uploadManifestToDrive, uploadProductFilesToDrive, generateDriveVerification } = await import('../src/lib/saleshub-product-drive-sync.ts')
      const enrichedPath = resolve(configOutputDir, '_enriched.json')
      const enrichedJson = existsSync(enrichedPath) ? JSON.parse(readFileSync(enrichedPath, 'utf-8')) : undefined
      driveProductFolderId = await uploadProductToDrive(productSlug, productPage, enrichedJson)
      await uploadManifestToDrive(productSlug, manifest)

      // Upload downloaded document files (PPTX/PDF) to Drive (#969)
      // Use display name (not slug) to match the folder created by uploadProductToDrive
      const downloadsDir = resolve(configOutputDir, 'downloads')
      if (existsSync(downloadsDir)) {
        const uploadResult = await uploadProductFilesToDrive(productPage.name || productSlug, downloadsDir)
        console.log(`[product-scraper] Document files uploaded to Drive: ${uploadResult.uploaded} files (${uploadResult.errors} errors)`)
      }

      // Phase 5 (#972): Drive verification — after all uploads complete
      if (driveProductFolderId && existsSync(resolve(configOutputDir, '_product-source.json'))) {
        const sourceData = JSON.parse(readFileSync(resolve(configOutputDir, '_product-source.json'), 'utf-8'))
        const driveVerification = await generateDriveVerification(productSlug, sourceData, driveProductFolderId)
        writeJsonAtomic(resolve(configOutputDir, '_drive-verification.json'), driveVerification)
        writeJsonAtomic(resolve(cacheOutputDir, '_drive-verification.json'), driveVerification)
        console.log(`[product-scraper] Phase 5: Drive verification written`)
      }
    } catch (e: any) {
      console.warn(`[product-scraper] Drive upload failed (non-blocking): ${e.message}`)
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
