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

  // Strategy: find all header-like elements, then filter by background color.
  // Seismic DocCenter uses styled divs/headers for section breaks.
  // Try increasingly broad selectors until we find red headers.

  const headerCandidateSelectors = [
    // Seismic-specific patterns (most likely)
    '[class*="section-header"]',
    '[class*="SectionHeader"]',
    '[class*="category-header"]',
    '[class*="CategoryHeader"]',
    '[class*="doc-header"]',
    '[class*="DocHeader"]',
    // Generic styled header patterns
    'h2[style*="background"]',
    'h3[style*="background"]',
    'div[class*="header"][style*="background"]',
    // Broader: any element with a red-ish background (evaluated via JS below)
  ]

  // First pass: try class-based selectors
  let headerLocator: Locator | null = null
  let headerCount = 0

  for (const selector of headerCandidateSelectors) {
    const candidate = page.locator(selector)
    const count = await candidate.count()
    if (count >= 2) {
      headerLocator = candidate
      headerCount = count
      console.log(`[product-scraper] Found ${count} headers with selector: ${selector}`)
      break
    }
  }

  // Second pass: use JavaScript to find elements with red-ish backgrounds
  if (!headerLocator || headerCount < 2) {
    console.log('[product-scraper] Class-based selectors found <2 headers, scanning by computed background color...')

    const redHeaderInfo = await page.evaluate(() => {
      const results: Array<{ index: number; text: string; tag: string; className: string }> = []
      // Walk all elements and check computed background color
      const all = document.querySelectorAll('*')
      for (let i = 0; i < all.length; i++) {
        const el = all[i] as HTMLElement
        const style = window.getComputedStyle(el)
        const bg = style.backgroundColor
        // Match red-ish backgrounds: rgb(r, g, b) where r > 150, g < 80, b < 80
        const match = bg.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/)
        if (match) {
          const [, r, g, b] = match.map(Number)
          if (r > 150 && g < 80 && b < 80) {
            const text = el.textContent?.trim().slice(0, 200) ?? ''
            if (text.length > 2) {
              results.push({
                index: i,
                text,
                tag: el.tagName.toLowerCase(),
                className: el.className?.toString().slice(0, 200) ?? '',
              })
            }
          }
        }
      }
      return results
    })

    console.log(`[product-scraper] Found ${redHeaderInfo.length} elements with red backgrounds`)
    for (const h of redHeaderInfo.slice(0, 10)) {
      console.log(`  [${h.tag}.${h.className.slice(0, 60)}] "${h.text.slice(0, 80)}"`)
    }

    // If we found red elements, use their className to build a selector
    if (redHeaderInfo.length >= 2) {
      // Group by className to find the most common pattern
      const classGroups = new Map<string, number>()
      for (const h of redHeaderInfo) {
        const key = h.className.split(/\s+/)[0] || h.tag
        classGroups.set(key, (classGroups.get(key) ?? 0) + 1)
      }

      // Use the most common class
      let bestClass = ''
      let bestCount = 0
      for (const [cls, count] of classGroups) {
        if (count > bestCount) {
          bestClass = cls
          bestCount = count
        }
      }

      if (bestClass && bestCount >= 2) {
        const selector = bestClass.includes(' ') ? `[class^="${bestClass}"]` : `.${bestClass}`
        headerLocator = page.locator(selector)
        headerCount = await headerLocator.count()
        console.log(`[product-scraper] Using derived selector: ${selector} (${headerCount} matches)`)
      }
    }
  }

  // If still no headers found, fall back to extracting all page links as one section
  if (!headerLocator || headerCount < 2) {
    console.warn('[product-scraper] Could not identify red header bars. Extracting all page links as single section.')
    const allItems = await extractLinkList(page.locator('main, [role="main"], #content, body'))
    if (allItems.length > 0) {
      sections['all-content'] = {
        title: 'All Content',
        type: 'links',
        items: allItems,
      }
    }
    return sections
  }

  // Extract content between each pair of headers
  for (let i = 0; i < headerCount; i++) {
    const header = headerLocator.nth(i)
    const title = (await header.innerText().catch(() => '')).trim()
    if (!title || isGarbage(title)) continue

    const sectionKey = slugify(title)

    // Scroll to header to trigger lazy loading
    try {
      await header.scrollIntoViewIfNeeded({ timeout: 3000 })
      await page.waitForTimeout(800) // Allow lazy content to load
    } catch {
      // Scroll may fail for fixed elements
    }

    // Get the bounding box of this header and the next header (or page end)
    // to define the content region between them
    const headerBox = await header.boundingBox()
    let nextHeaderBox: { x: number; y: number; width: number; height: number } | null = null
    if (i < headerCount - 1) {
      nextHeaderBox = await headerLocator.nth(i + 1).boundingBox()
    }

    // Extract content between this header and the next using JS
    const sectionContent = await page.evaluate(
      ({ headerY, nextY }) => {
        // Find all elements whose top is between headerY and nextY
        const els = document.querySelectorAll('a[href], [class*="card"], [class*="Card"], table, [role="button"][aria-expanded]')
        const items: Array<{ tag: string; text: string; href: string }> = []
        for (const el of els) {
          const rect = el.getBoundingClientRect()
          const scrollY = window.scrollY
          const absTop = rect.top + scrollY
          if (absTop > headerY && (nextY === null || absTop < nextY)) {
            const text = (el.textContent ?? '').trim().slice(0, 300)
            const href = (el as HTMLAnchorElement).href ?? ''
            if (text) items.push({ tag: el.tagName.toLowerCase(), text, href })
          }
        }
        return items
      },
      {
        headerY: headerBox?.y ?? 0,
        nextY: nextHeaderBox?.y ?? null,
      },
    )

    // Build section from extracted content
    const contentContainer = page.locator(`text="${title}"`).first().locator('xpath=following-sibling::*').first()
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

  // Try to find sidebar container
  const sidebarSelectors = [
    '[class*="sidebar"]',
    '[class*="Sidebar"]',
    '[class*="side-panel"]',
    '[class*="SidePanel"]',
    'aside',
    '[role="complementary"]',
  ]

  let sidebar: Locator | null = null
  for (const sel of sidebarSelectors) {
    const candidate = page.locator(sel)
    if ((await candidate.count()) > 0) {
      sidebar = candidate.first()
      break
    }
  }

  if (!sidebar) {
    console.log('[product-scraper] No sidebar found')
    return result
  }

  console.log('[product-scraper] Extracting sidebar content...')

  // Extract all links from sidebar
  const allSidebarLinks = await extractLinkList(sidebar)

  for (const link of allSidebarLinks) {
    const nameLower = link.name.toLowerCase()

    // Classify links
    if (nameLower.includes('tdp') || nameLower.includes('technical decision')) {
      result.tdpLinks.push(link)
    } else if (nameLower.includes('slack') || nameLower.includes('#')) {
      result.slackChannels.push(link.name)
    } else {
      result.links.push(link)
    }
  }

  // Extract contact info -- look for email patterns
  const sidebarText = await sidebar.innerText().catch(() => '')
  const emailMatches = sidebarText.match(/[\w.-]+@[\w.-]+\.\w+/g)
  if (emailMatches) {
    for (const email of emailMatches) {
      result.contacts.push({ name: email.split('@')[0], email })
    }
  }

  // Look for Slack channel patterns
  const slackMatches = sidebarText.match(/#[a-z0-9_-]+/gi)
  if (slackMatches) {
    for (const ch of slackMatches) {
      if (!result.slackChannels.includes(ch)) {
        result.slackChannels.push(ch)
      }
    }
  }

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

  // Try to get description from a subtitle or first paragraph after title
  let description = ''
  const descSelectors = [
    '[class*="subtitle"]',
    '[class*="Subtitle"]',
    '[class*="description"]',
    '[class*="Description"]',
    'h1 + p',
    '[class*="page-title"] + p',
  ]

  for (const sel of descSelectors) {
    const el = page.locator(sel).first()
    if ((await el.count()) > 0) {
      description = (await el.innerText().catch(() => '')).trim()
      if (description) break
    }
  }

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
