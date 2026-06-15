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
import { readFileSync, mkdirSync, existsSync } from 'fs'
import { resolve } from 'path'
import { writeJsonAtomic } from '../src/lib/atomic-write.ts'
import { BASE_CHROMIUM_ARGS } from '../src/browser-utils.ts'
import type {
  ProductPage,
  ProductSection,
  SectionItem,
} from '../src/types/saleshub-product-types.ts'

// ── Constants ────────────────────────────────────────────────────────────────

const PROFILE_DIR = process.env.RH_PROFILE_DIR ?? '/data/rh-profile'
const CACHE_DIR = process.env.CACHE_DIR ?? '/data/cache'
const CHROMIUM_PATH = '/ms-playwright/chromium-1208/chrome-linux/chrome'

// Default product page URL -- OpenShift Virtualization (update with correct URL when known)
const DEFAULT_URL =
  'https://saleshub.redhat.com/apps/doccenter/1d1918e9-b5b0-4428-b8fc-87e02ad44156/doc/%252Fdd04d516a5-19b3-48c9-e01a-d2bf52939de4%252FdfMmNhNDhiYjktY'

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
): Promise<Record<string, ProductSection>> {
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

  const SIDEBAR_SKIP = ['ask on slack', 'contact us', 'content details', 'content properties', 'reviews', 'tdp and tactic']
  const PRODUCT_TITLE_SKIP = ['red hat'] // Skip the product title itself

  const allSectionHeaders = await page.evaluate(({ sidebarSkip, titleSkip }) => {
    const headers: Array<{ text: string; y: number; isDivider: boolean }> = []

    // 1. Red dividers
    const dividers = document.querySelectorAll('.seismic-page-divider-view')
    for (const el of dividers) {
      const text = (el.textContent || '').trim()
      if (text.length > 2) {
        const rect = el.getBoundingClientRect()
        headers.push({ text, y: Math.round(rect.top + window.scrollY), isDivider: true })
      }
    }

    // 2. Non-divider h1 headings that are content sections
    const h1s = document.querySelectorAll('h1')
    for (const el of h1s) {
      const text = (el.textContent || '').trim()
      if (text.length < 3) continue
      const textLower = text.toLowerCase()
      // Skip sidebar headings
      if (sidebarSkip.some((s: string) => textLower.startsWith(s))) continue
      // Skip the product title
      if (titleSkip.some((s: string) => textLower.startsWith(s))) continue
      // Skip if this is already a divider
      if (el.classList.contains('seismic-page-divider-view')) continue
      // Skip if it's inside a card or list item
      if (el.closest('[class*="card"], [class*="Card"], li')) continue

      const rect = el.getBoundingClientRect()
      const y = Math.round(rect.top + window.scrollY)
      // Only include if not already captured by a divider at the same y
      if (!headers.some(h => Math.abs(h.y - y) < 20)) {
        headers.push({ text, y, isDivider: false })
      }
    }

    // 3. h2 sub-section headings (for cloud provider sections)
    const h2s = document.querySelectorAll('h2')
    for (const el of h2s) {
      const text = (el.textContent || '').trim()
      if (text.length < 3) continue
      const rect = el.getBoundingClientRect()
      const y = Math.round(rect.top + window.scrollY)
      if (!headers.some(h => Math.abs(h.y - y) < 20)) {
        headers.push({ text, y, isDivider: false })
      }
    }

    // Sort by y-position
    headers.sort((a, b) => a.y - b.y)
    return headers
  }, { sidebarSkip: SIDEBAR_SKIP, titleSkip: PRODUCT_TITLE_SKIP })

  console.log(`[product-scraper] Found ${allSectionHeaders.length} section headers:`)
  for (const h of allSectionHeaders) {
    const marker = h.isDivider ? '🔴' : '  '
    console.log(`  ${marker} [y=${h.y}] "${h.text.slice(0, 60)}"`)
  }

  if (allSectionHeaders.length < 2) {
    console.warn('[product-scraper] Found <2 section headers. Extracting all page links as single section.')
    const allItems = await extractLinkList(page.locator('main, [role="main"], #content, body'))
    if (allItems.length > 0) {
      sections['all-content'] = { title: 'All Content', type: 'links', items: allItems }
    }
    return sections
  }

  // Extract content between each pair of section headers using y-position ranges
  for (let i = 0; i < allSectionHeaders.length; i++) {
    const sh = allSectionHeaders[i]
    const title = sh.text
    if (!title || isGarbage(title)) continue

    const sectionKey = slugify(title)
    const headerY = sh.y
    const nextY = i < allSectionHeaders.length - 1 ? allSectionHeaders[i + 1].y : null

    // Scroll to section to trigger lazy loading
    try {
      await page.evaluate((y) => window.scrollTo(0, y - 100), headerY)
      await page.waitForTimeout(800)
    } catch { /* scroll may fail */ }

    // Extract all links and content elements between this header and the next
    // Filter by x-position: only include elements in the main content area (left ~75% of page)
    // This excludes sidebar ToC links that share the same y-position range
    const sectionContent = await page.evaluate(
      ({ headerY, nextY }) => {
        const pageWidth = document.documentElement.clientWidth
        const mainContentMaxX = pageWidth * 0.75 // Sidebar is roughly in the rightmost 25%

        const els = document.querySelectorAll('a[href], [class*="card"], [class*="Card"], table, [role="button"][aria-expanded]')
        const items: Array<{ tag: string; text: string; href: string }> = []
        const seen = new Set<string>()
        for (const el of els) {
          const rect = el.getBoundingClientRect()
          const scrollY = window.scrollY
          const absTop = rect.top + scrollY
          const absLeft = rect.left

          // Must be in y-range AND in the main content area (not sidebar)
          if (absTop > headerY && (nextY === null || absTop < nextY) && absLeft < mainContentMaxX) {
            const text = (el.textContent ?? '').trim().slice(0, 300)
            const href = (el as HTMLAnchorElement).href ?? ''
            // Skip very short text, ToC navigation items, and workspace links
            if (text.length < 4) continue
            if (href.includes('/app#/workspace')) continue
            // Skip items that look like other section headers (ToC leaks)
            if (/^(Product news|Business decks|Technical decks|Key resources|Demos & Videos|Customer References|Top \w+ resources)$/i.test(text)) continue

            const key = text.slice(0, 50) + '|' + href
            if (!seen.has(key)) {
              seen.add(key)
              items.push({ tag: el.tagName.toLowerCase(), text, href })
            }
          }
        }
        return items
      },
      { headerY, nextY },
    )

    // Try structured extraction first
    const contentContainer = page.locator(`text="${title.slice(0, 50)}"`).first().locator('xpath=following-sibling::*').first()
    const type = await detectSectionType(contentContainer).catch(() => 'mixed' as const)

    let items: SectionItem[] = []
    let subsections: ProductSection[] | undefined

    switch (type) {
      case 'cards':
        items = await extractCardCarousel(contentContainer).catch(() => [])
        break
      case 'table':
        items = await extractDataTable(contentContainer).catch(() => [])
        break
      case 'accordion':
        subsections = await extractAccordionSections(page, contentContainer).catch(() => [])
        break
      case 'links':
        items = await extractLinkList(contentContainer).catch(() => [])
        break
      default:
        items = await extractLinkList(contentContainer).catch(() => [])
        break
    }

    // If structured extraction yielded nothing, fall back to sectionContent from JS evaluation
    if (items.length === 0 && (!subsections || subsections.length === 0)) {
      for (const sc of sectionContent) {
        if (isGarbage(sc.text)) continue
        // Deduplicate by text
        if (items.some((it) => it.name === sc.text)) continue
        items.push({
          name: sc.text.slice(0, 200),
          url: sc.href.startsWith('http') ? sc.href : undefined,
        })
      }
    }

    if (items.length > 0 || (subsections && subsections.length > 0)) {
      sections[sectionKey] = {
        title,
        type,
        items,
        subsections: subsections?.length ? subsections : undefined,
      }
      console.log(`[product-scraper] Section "${title}" (${type}): ${items.length} items, ${subsections?.length ?? 0} subsections`)
    }
  }

  return sections
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

// ── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const url = process.argv[2] || DEFAULT_URL
  console.log(`[product-scraper] Starting product page scrape`)
  console.log(`[product-scraper] URL: ${url}`)

  // Load session state
  const sessionStatePath = resolve(PROFILE_DIR, 'session-state.json')
  if (!existsSync(sessionStatePath)) {
    throw new Error(`[product-scraper] No session-state.json at ${sessionStatePath}`)
  }

  const sessionState = JSON.parse(readFileSync(sessionStatePath, 'utf-8'))
  console.log(`[product-scraper] Loaded ${sessionState.cookies?.length ?? 0} cookies from session state`)

  // Launch browser with same pattern as scrape-saleshub.ts
  const browser = await chromium.launch({
    headless: true,
    executablePath: CHROMIUM_PATH,
    args: [
      ...BASE_CHROMIUM_ARGS,
      '--disable-blink-features=AutomationControlled',
      '--headless=new',
    ],
  })

  const context = await browser.newContext({
    storageState: sessionState,
    userAgent:
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  })

  try {
    const page = await context.newPage()

    // Navigate to product page
    console.log('[product-scraper] Navigating to product page...')
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

    // Extract red header sections
    console.log('[product-scraper] Extracting sections by red header bars...')
    const sections = await extractRedHeaderSections(page)
    console.log(`[product-scraper] Extracted ${Object.keys(sections).length} sections`)

    // Extract sidebar
    console.log('[product-scraper] Extracting sidebar...')
    const sidebar = await extractSidebar(page)

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
    const configOutputDir = resolve('config-templates', 'saleshub-products', productSlug)

    mkdirSync(cacheOutputDir, { recursive: true })
    mkdirSync(configOutputDir, { recursive: true })

    const cachePath = resolve(cacheOutputDir, '_product.json')
    const configPath = resolve(configOutputDir, '_product.json')

    writeJsonAtomic(cachePath, productPage)
    writeJsonAtomic(configPath, productPage)

    console.log(`\n[product-scraper] Written to:`)
    console.log(`  ${cachePath}`)
    console.log(`  ${configPath}`)
    console.log('[product-scraper] Done.')
  } finally {
    await context.close()
    await browser.close()
  }
}

main().catch((err) => {
  console.error('[product-scraper] Fatal error:', err)
  process.exit(1)
})
