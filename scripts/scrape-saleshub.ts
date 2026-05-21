/**
 * scripts/scrape-saleshub.ts — SalesHub product page scraper
 *
 * Scrapes all 21+ product pages from Red Hat SalesHub (Seismic platform).
 * Extracts: product descriptions, TDP/Sales Tactics sections, value props,
 * Google Docs/Slides URLs, and key resources.
 *
 * Uses session-state.json cookies from the daemon's browser profile to
 * authenticate via a separate Chromium instance (avoids profile lock).
 *
 * Output: /data/cache/saleshub/{product-slug}.json per product
 *         /data/cache/saleshub/saleshub-products.json index
 *
 * Called by sync-l3-daemon.ts via saleshub-trigger file mechanism.
 */

import { chromium } from '@playwright/test'
import type { BrowserContext, Page } from '@playwright/test'
import { readFileSync, mkdirSync, existsSync } from 'fs'
import { resolve } from 'path'
import { toSlug } from '../src/cache-layer.ts'
import { writeJsonAtomic } from '../src/lib/atomic-write.ts'
import { BASE_CHROMIUM_ARGS } from '../src/browser-utils.ts'

const PROFILE_DIR = process.env.RH_PROFILE_DIR ?? '/data/rh-profile'
const CACHE_DIR = process.env.CACHE_DIR ?? '/data/cache'
const OUTPUT_DIR = resolve(CACHE_DIR, 'saleshub')
const SALESHUB_URL = 'https://saleshub.redhat.com'
const DOCCENTER_PROFILE = '1d1918e9-b5b0-4428-b8fc-87e02ad44156'
const CHROMIUM_PATH = '/ms-playwright/chromium-1208/chrome-linux/chrome'

export interface SalesHubProduct {
  slug: string
  name: string
  description: string
  url: string
  tdpSections: TdpSection[]
  salesTactics: SalesTacticSection[]
  googleDocsUrls: string[]
  keyResources: ResourceLink[]
  decks: ResourceLink[]
  scrapedAt: string
}

interface TdpSection {
  name: string
  description: string
}

interface SalesTacticSection {
  name: string
  description: string
}

interface ResourceLink {
  text: string
  url: string
  type: 'google-docs' | 'google-slides' | 'pdf' | 'external' | 'seismic'
}

function classifyUrl(url: string): ResourceLink['type'] {
  if (url.includes('docs.google.com/document')) return 'google-docs'
  if (url.includes('docs.google.com/presentation')) return 'google-slides'
  if (url.includes('drive.google.com')) return 'google-docs'
  if (url.endsWith('.pdf') || url.includes('/pdf/')) return 'pdf'
  if (url.includes('saleshub.redhat.com') || url.includes('seismic.com')) return 'seismic'
  return 'external'
}

async function extractProductPage(page: Page, productName: string, productUrl: string): Promise<SalesHubProduct | null> {
  try {
    console.log(`[scrape-saleshub] Scraping: ${productName}`)
    await page.goto(productUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 })
    await page.waitForTimeout(5_000)

    const data = await page.evaluate(() => {
      const mainEl = document.querySelector('main, [role="main"], body') as HTMLElement
      const mainText = mainEl?.innerText ?? ''

      // Extract headings with their parent text
      const headings = Array.from(document.querySelectorAll('h1, h2, h3, h4')).map(h => ({
        level: h.tagName,
        text: h.textContent?.trim() ?? '',
        nextText: h.nextElementSibling?.textContent?.trim()?.slice(0, 500) ?? '',
      }))

      // Extract all links
      const links = Array.from(document.querySelectorAll('a[href]')).map(a => ({
        text: a.textContent?.trim() ?? '',
        href: a.getAttribute('href') ?? '',
      })).filter(l => l.text && l.href && !l.href.startsWith('#') && !l.href.startsWith('javascript'))

      // Find the main description (text after the first H1 product name)
      let description = ''
      const h1 = document.querySelector('h1')
      if (h1) {
        let el = h1.nextElementSibling
        const descParts: string[] = []
        while (el && el.tagName !== 'H1' && el.tagName !== 'H2') {
          const text = el.textContent?.trim()
          if (text && text.length > 10 && !text.includes('Rating') && !text.includes('Add Review')) {
            descParts.push(text)
          }
          el = el.nextElementSibling
        }
        description = descParts.join('\n').slice(0, 2000)
      }

      return { headings, links, description, mainText: mainText.slice(0, 20000) }
    })

    // Parse TDP sections from headings
    const tdpSections: TdpSection[] = []
    const salesTactics: SalesTacticSection[] = []

    let inTdpSection = false
    let inTacticSection = false

    for (let i = 0; i < data.headings.length; i++) {
      const h = data.headings[i]
      const text = h.text.toLowerCase()

      if (text.includes('tdp') && !text.includes('cheatsheet')) {
        inTdpSection = true
        inTacticSection = false
        if (h.nextText && h.nextText.length > 20) {
          tdpSections.push({ name: h.text, description: h.nextText })
        }
        continue
      }

      if (text.includes('tactic') || text.includes('sales tactic')) {
        inTacticSection = true
        inTdpSection = false
        continue
      }

      if (inTdpSection && h.level !== 'H1' && h.text.length > 5 && h.nextText.length > 20) {
        tdpSections.push({ name: h.text, description: h.nextText })
      }

      if (inTacticSection && h.level !== 'H1' && h.text.length > 5 && h.nextText.length > 20) {
        salesTactics.push({ name: h.text, description: h.nextText })
      }

      // Reset section tracking on major headings
      if (h.level === 'H1' || h.level === 'H2') {
        if (!text.includes('tdp') && !text.includes('tactic') && !text.includes('sales')) {
          inTdpSection = false
          inTacticSection = false
        }
      }
    }

    // Also parse TDP/tactic sections from the main text using pattern matching
    const tdpPattern = /([A-Z][^:\n]{5,80})\s*\n\s*((?:This|The)\s+[^.]+\.(?:[^.]+\.){0,3})/g
    const mainText = data.mainText
    const tdpSectionNames = new Set(tdpSections.map(t => t.name))

    // Look for "2026 ... TDP & Sales tactics" section in text
    const tdpAreaMatch = mainText.match(/(?:TDP|Technology Decision Point)[\s\S]*?(?=(?:Product Features|Deployment options|$))/i)
    if (tdpAreaMatch) {
      const tdpArea = tdpAreaMatch[0]
      const lines = tdpArea.split('\n').filter(l => l.trim().length > 0)
      let currentName = ''
      for (const line of lines) {
        const trimmed = line.trim()
        if (trimmed.length < 100 && trimmed.length > 5 && !trimmed.startsWith('This') && !trimmed.startsWith('The') && !trimmed.includes('item(s)')) {
          currentName = trimmed
        } else if (currentName && trimmed.length > 50 && (trimmed.startsWith('This') || trimmed.startsWith('The'))) {
          if (!tdpSectionNames.has(currentName)) {
            tdpSections.push({ name: currentName, description: trimmed })
            tdpSectionNames.add(currentName)
          }
          currentName = ''
        }
      }
    }

    // Extract Google Docs/Slides URLs
    const googleDocsUrls = data.links
      .filter(l => l.href.includes('docs.google.com') || l.href.includes('drive.google.com'))
      .map(l => l.href)

    // Extract key resources
    const keyResources: ResourceLink[] = data.links
      .filter(l => {
        const t = l.text.toLowerCase()
        return (t.includes('resource') || t.includes('guide') || t.includes('whitepaper') ||
                t.includes('webinar') || t.includes('lab') || t.includes('success') ||
                t.includes('competitive') || t.includes('website') || t.includes('release')) &&
               l.href.length > 10
      })
      .map(l => ({ text: l.text, url: l.href, type: classifyUrl(l.href) }))

    // Extract decks
    const decks: ResourceLink[] = data.links
      .filter(l => {
        const t = l.text.toLowerCase()
        return (t.includes('deck') || t.includes('presentation') || t.includes('overview') ||
                t.includes('customer deck') || t.includes('cheatsheet')) &&
               l.href.length > 10
      })
      .map(l => ({ text: l.text, url: l.href, type: classifyUrl(l.href) }))

    const slug = toSlug(productName)

    return {
      slug,
      name: productName,
      description: data.description,
      url: productUrl,
      tdpSections,
      salesTactics,
      googleDocsUrls,
      keyResources,
      decks,
      scrapedAt: new Date().toISOString(),
    }
  } catch (e: any) {
    console.error(`[scrape-saleshub] Failed to scrape ${productName}: ${e.message}`)
    return null
  }
}

export async function scrapeSalesHub(): Promise<SalesHubProduct[]> {
  const sessionStatePath = resolve(PROFILE_DIR, 'session-state.json')
  if (!existsSync(sessionStatePath)) {
    throw new Error(`[scrape-saleshub] No session-state.json at ${sessionStatePath}`)
  }

  const sessionState = JSON.parse(readFileSync(sessionStatePath, 'utf-8'))
  console.log(`[scrape-saleshub] Starting — ${sessionState.cookies?.length ?? 0} cookies loaded`)

  mkdirSync(OUTPUT_DIR, { recursive: true })

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
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  })

  const products: SalesHubProduct[] = []

  try {
    // Step 1: Navigate to Products listing and discover all product page URLs
    console.log('[scrape-saleshub] Discovering product pages from Products listing…')
    const listingPage = await context.newPage()
    const productsUrl = `${SALESHUB_URL}/apps/doccenter/${DOCCENTER_PROFILE}/doc/%252Fdd04d516a5-19b3-48c9-e01a-d2bf52939de4%252FdfMmNhNDhiYjktYzE1Ny00ZjgyLWJlYjUtNTdhY2NjZmY5Y2Rh%252CPT0%253D%252CUGFnZSBSSFNI%252Flf3e41b707-4f29-4a23-9ee9-27736d70c8eb//`

    await listingPage.goto(productsUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 })
    await listingPage.waitForTimeout(8_000)

    // Extract product names and their URLs from the listing
    const productLinks = await listingPage.evaluate(() => {
      const items: { name: string; url: string }[] = []
      const links = document.querySelectorAll('a[href]')
      links.forEach(a => {
        const text = a.textContent?.trim() ?? ''
        const href = a.getAttribute('href') ?? ''
        if (text.length > 5 && href.includes('doccenter') && href.includes('lf') &&
            !text.includes('All Sales Content') && !text.includes('Products') &&
            !text.includes('Search') && !text.includes('Home') && !text.includes('DocCenter') &&
            !text.includes('Help') && !text.includes('back') && !text.includes('Engagement') &&
            !text.includes('Insight') && !text.includes('Learning') && !text.includes('Skills') &&
            !text.includes('WorkSpace') && !text.includes('HomePage') &&
            !text.includes('Rating') && !text.includes('Review') && !text.includes('Share') &&
            !text.includes('Content Details') && !text.includes('Content Properties') &&
            !text.includes('Collapsed')) {
          items.push({ name: text, url: href.startsWith('http') ? href : `${window.location.origin}${href}` })
        }
      })
      // Dedupe by name
      const seen = new Set<string>()
      return items.filter(i => {
        if (seen.has(i.name)) return false
        seen.add(i.name)
        return true
      })
    })

    console.log(`[scrape-saleshub] Found ${productLinks.length} product pages`)
    for (const pl of productLinks) {
      console.log(`  - ${pl.name}`)
    }

    await listingPage.close()

    // Step 2: Scrape each product page
    const scrapePage = await context.newPage()

    for (let i = 0; i < productLinks.length; i++) {
      const pl = productLinks[i]
      console.log(`[scrape-saleshub] (${i + 1}/${productLinks.length}) ${pl.name}`)

      const product = await extractProductPage(scrapePage, pl.name, pl.url)
      if (product) {
        products.push(product)

        writeJsonAtomic(resolve(OUTPUT_DIR, `${product.slug}.json`), product)
      }

      // Brief pause between pages
      await scrapePage.waitForTimeout(1_000)
    }

    await scrapePage.close()

    // Step 3: Write combined index
    const index = {
      scrapedAt: new Date().toISOString(),
      productCount: products.length,
      products: products.map(p => ({
        slug: p.slug,
        name: p.name,
        tdpCount: p.tdpSections.length,
        tacticCount: p.salesTactics.length,
        googleDocsCount: p.googleDocsUrls.length,
        deckCount: p.decks.length,
      })),
    }

    writeJsonAtomic(resolve(OUTPUT_DIR, 'saleshub-products.json'), index)
    console.log(`[scrape-saleshub] Done — scraped ${products.length} products, saved to ${OUTPUT_DIR}/`)

  } finally {
    await context.close()
    await browser.close()
  }

  return products
}

// Direct execution
if (import.meta.main) {
  scrapeSalesHub().catch(err => {
    console.error('[scrape-saleshub] Fatal:', err)
    process.exit(1)
  })
}
