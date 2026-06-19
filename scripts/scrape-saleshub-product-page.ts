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
import { resolve, relative } from 'path'
import type { BrowserContext } from '@playwright/test'
import { writeJsonAtomic } from '../src/lib/atomic-write.ts'
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

// ── Constants ────────────────────────────────────────────────────────────────

const PROFILE_DIR = process.env.RH_PROFILE_DIR ?? '/data/rh-profile'
const CACHE_DIR = process.env.CACHE_DIR ?? '/data/cache'
const CHROMIUM_PATH = process.env.CHROMIUM_PATH ?? '/ms-playwright/chromium-1208/chrome-linux/chrome'
const PROFILE_VERSION_ID = '1d1918e9-b5b0-4428-b8fc-87e02ad44156'
const MAX_DOWNLOADS_PER_PRODUCT = 100
const SKIP_FORMATS = new Set(['JSON', 'MP4', 'MOV', 'WEBM', 'ZIP', 'PNG', 'YouTube', 'URL'])
const SKIP_LANGUAGE_PATTERNS = [/\bde\b|\bfr\b|\bes\b|\bit\b|\bpt\b|\bja\b|\bko\b|\bzh\b/i]
const skipDownloads = process.argv.includes('--skip-downloads')

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
      textContent: string
      isAccordion: boolean
    }> = []

    let currentTitle = ''
    let currentLinks: Array<{ text: string; href: string }> = []
    let currentText = ''
    let isAccordion = false

    for (const widget of widgets) {
      const cls = widget.className || ''
      const isDivider = cls.includes('seismic-page-widget-divider')
      const isCover = cls.includes('seismic-page-widget-cover')
      const isParagraph = cls.includes('seismic-page-widget-paragraph')
      const isAccordionWidget = cls.includes('seismic-page-widget-accordion')

      if (isDivider) {
        // Save previous section if it has content
        if (currentTitle && currentTitle !== '__pending__' && (currentLinks.length > 0 || currentText)) {
          result.push({ title: currentTitle, widgetClass: cls, links: currentLinks, textContent: currentText, isAccordion })
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
        currentText = ''
        isAccordion = false
        continue
      }

      if (isCover) continue // Skip product banner

      // Content widget — extract links
      const isContentWidget = !isDivider && !isCover

      if (isContentWidget) {
        // Handle accordion widgets specially — each has its own title
        if (isAccordionWidget) {
          // Save previous section
          if (currentTitle && currentTitle !== '__pending__' && (currentLinks.length > 0 || currentText)) {
            result.push({ title: currentTitle, widgetClass: '', links: currentLinks, textContent: currentText, isAccordion })
          }
          isAccordion = true
          const accTitle = widget.querySelector('.seismic-page-divider-view')
          currentTitle = accTitle ? (accTitle.textContent || '').trim() : 'Untitled'
          currentLinks = []
          currentText = ''
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
              result.push({ title: subTitle, widgetClass: '', links: subLinks, textContent: '', isAccordion: false })
            }
          }
          // Don't add to currentLinks — we already split into sub-sections
          continue
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
    if (currentTitle && (currentLinks.length > 0 || currentText)) {
      result.push({ title: currentTitle, widgetClass: '', links: currentLinks, textContent: currentText, isAccordion })
    }

    return result
  })

  console.log(`[product-scraper] Found ${widgetSections.length} widget sections:`)
  for (const ws of widgetSections) {
    console.log(`  "${ws.title.slice(0, 50)}" — ${ws.links.length} links, ${ws.textContent.length} chars text${ws.isAccordion ? ' [accordion]' : ''}`)
  }

  if (widgetSections.length < 1) {
    console.warn('[product-scraper] No widget sections found. Falling back to all page links.')
    const allItems = await extractLinkList(page.locator('main, [role="main"], #content, body'))
    if (allItems.length > 0) {
      sections['all-content'] = { title: 'All Content', type: 'links', items: allItems }
    }
    return sections
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
      items.push({ name: link.text, url: link.href })
    }

    const type: ProductSection['type'] = ws.isAccordion ? 'accordion' : 'mixed'

    if (items.length > 0) {
      sections[sectionKey] = {
        title,
        textContent: ws.textContent || undefined,
        type,
        items,
      }
      console.log(`[product-scraper] Section "${title}" (${type}): ${items.length} items`)
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

// ── Per-product document download (SC-2) ────────────────────────────────────

async function downloadProductDocuments(
  page: Page,
  context: BrowserContext,
  sections: Record<string, ProductSection>,
  productSlug: string,
  authCtx: { auth: string; headers: Record<string, string>; searchUrl: string },
): Promise<void> {
  // ── Phase 1: Expand all accordion sections on the product page ──────────
  // Expand ANY collapsed accordions — not just Domain sections (AC-1, ANTI-2)
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

  // Collect all downloadable items from ALL sections (ANTI-2: not Domain-only)
  const downloadQueue: Array<{ item: SectionItem; sectionKey: string; sectionTitle: string }> = []
  for (const [sectionKey, section] of Object.entries(sections)) {
    for (const item of section.items) {
      // Skip items without a URL — can't download without a reference
      if (!item.url) continue

      // Skip formats that are not downloadable documents (AC-A1)
      const itemFormat = ((item as any).format ?? '').toUpperCase()
      const seismicType = ((item as any).seismicContentType ?? '').toLowerCase()
      if (itemFormat && SKIP_FORMATS.has(itemFormat)) {
        console.log(`[product-scraper] Skipping ${itemFormat}: ${item.name.slice(0, 50)}`)
        continue
      }
      // Also check URL patterns for skip formats
      const urlLower = item.url.toLowerCase()
      if (urlLower.includes('youtube.com') || urlLower.includes('youtu.be')) {
        console.log(`[product-scraper] Skipping YouTube: ${item.name.slice(0, 50)}`)
        continue
      }

      // Skip non-English documents
      const isNonEnglish = SKIP_LANGUAGE_PATTERNS.some(p => p.test(item.name))
      if (isNonEnglish) {
        console.log(`[product-scraper] Skipping non-English: ${item.name.slice(0, 50)}`)
        continue
      }

      downloadQueue.push({ item, sectionKey, sectionTitle: section.title })
    }
  }

  console.log(`[product-scraper] Download queue: ${downloadQueue.length} items from ${Object.keys(sections).length} sections`)

  // ── Phase 3: Download each item — viewer PRIMARY, three-dot FALLBACK ────
  for (const { item, sectionKey, sectionTitle } of downloadQueue) {
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
            const downloadPromise = dlPage.waitForEvent('download', { timeout: 30_000 })
            await downloadBtn.click()
            const dl = await downloadPromise
            const suggestedName = dl.suggestedFilename()
            const ext = suggestedName.includes('.') ? suggestedName.split('.').pop()! : 'pdf'
            const filename = sanitizeFilename(`${item.name}.${ext}`)
            const localPath = resolve(sectionDir, filename)
            await dl.saveAs(localPath)
            downloaded++
            consecutiveFailures = 0
            console.log(`[product-scraper] (${totalProcessed}/${downloadQueue.length}) OK ${filename} (viewer download)`)
            succeeded = true
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

          const downloadPromise = page.waitForEvent('download', { timeout: 30_000 })
          await downloadOption.click()

          const dl = await downloadPromise
          const suggestedName = dl.suggestedFilename()
          const ext = suggestedName.includes('.') ? suggestedName.split('.').pop()! : 'pdf'
          const filename = sanitizeFilename(`${item.name}.${ext}`)
          const localPath = resolve(sectionDir, filename)
          await dl.saveAs(localPath)
          downloaded++
          consecutiveFailures = 0
          console.log(`[product-scraper] (${totalProcessed}/${downloadQueue.length}) OK ${filename} (three-dot fallback)`)
          succeeded = true
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

    if (!succeeded) {
      consecutiveFailures++
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

  // ── Write failed downloads manifest ──────────────────────────────────────
  if (failedDownloads.length > 0) {
    const manifestPath = resolve(productDir, '_failed-downloads.json')
    writeJsonAtomic(manifestPath, {
      timestamp: new Date().toISOString(),
      productSlug,
      totalAttempted: totalProcessed,
      totalFailed: failedDownloads.length,
      failures: failedDownloads,
    })
    console.warn(`[product-scraper] Failed downloads manifest written to ${manifestPath}`)
  }

  console.log(`[product-scraper] Downloads complete: ${downloaded} new, ${skipped} cached, ${errors} errors`)
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

    // Extract red header sections (DOM — structure + text + accordion links)
    console.log('[product-scraper] Extracting sections by red header bars...')
    const sections = await extractRedHeaderSections(page)
    console.log(`[product-scraper] Extracted ${Object.keys(sections).length} sections from DOM`)

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

          const items: SectionItem[] = docs.map(doc => ({
            name: doc.name,
            url: doc.downloadUrl || undefined,
            itemType: contentType.toLowerCase().replace(/\s+/g, '-'),
            description: `${doc.distributionTerms || ''} | ${doc.salesStage || ''}`.trim().replace(/^\||\|$/g, '').trim() || undefined,
            contentId: (doc as any).contentId || undefined,
            versionId: doc.versionId || undefined,
            format: (doc as any).format || undefined,
            seismicContentType: contentType,
          } as any))

          if (sections[sectionKey]) {
            // Merge with existing section — add API docs to existing items
            const existingNames = new Set(sections[sectionKey].items.map(i => i.name.slice(0, 50)))
            for (const item of items) {
              if (!existingNames.has(item.name.slice(0, 50))) {
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

        console.log(`[product-scraper] After API merge: ${Object.keys(sections).length} total sections`)
      } catch (e: any) {
        console.warn(`[product-scraper] Seismic API query failed — DOM-only results: ${e.message}`)
      }
    } else {
      console.warn('[product-scraper] Could not capture Seismic auth — using DOM-only results')
    }

    // Extract sidebar
    console.log('[product-scraper] Extracting sidebar...')
    const sidebar = await extractSidebar(page)

    // Step 5: Download documents into per-product directory (SC-2)
    if (!skipDownloads && authCtx) {
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
    const configOutputDir = resolve('config-templates', 'saleshub-products', productSlug)

    mkdirSync(cacheOutputDir, { recursive: true })
    mkdirSync(configOutputDir, { recursive: true })

    const cachePath = resolve(cacheOutputDir, '_product.json')
    const configPath = resolve(configOutputDir, '_product.json')

    writeJsonAtomic(cachePath, productPage)
    writeJsonAtomic(configPath, productPage)

    // Write CDS inventory (#833)
    if (cdsDocuments.length > 0) {
      writeJsonAtomic(resolve(configOutputDir, '_cds-inventory.json'), cdsDocuments)
    }

    // Write completeness report (#837)
    const downloaded = existsSync(resolve(configOutputDir, 'downloads'))
      ? require('child_process').execSync(`find ${resolve(configOutputDir, 'downloads')} -type f | wc -l`).toString().trim()
      : '0'
    const completeness = generateCompletenessReport(
      header.name, cdsDocuments, totalItems, parseInt(downloaded), delta,
    )
    writeJsonAtomic(resolve(configOutputDir, '_completeness.json'), completeness)
    console.log(`[product-scraper] Completeness: ${completeness.status} (CDS: ${completeness.cdsItemCount}, DOM: ${completeness.domItemCount}, downloaded: ${completeness.downloadedCount}, missing: ${completeness.missingItems.length})`)

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
