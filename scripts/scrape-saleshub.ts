/**
 * scripts/scrape-saleshub.ts — SalesHub full content scraper (#358)
 *
 * Three-pass scraper for Red Hat SalesHub (Seismic platform):
 *   Pass 1: Product pages (21+) — click accordion expanders, extract TDP content
 *   Pass 2: Sales Play pages — discover from DocCenter homepage, extract description + linked TDPs
 *   Pass 3: Sales Tactic pages — discover from DocCenter homepage, extract structured sections
 *
 * Uses session-state.json cookies from the daemon's browser profile to
 * authenticate via a separate Chromium instance (avoids profile lock).
 *
 * Output:
 *   /data/cache/saleshub/{product-slug}.json per product
 *   /data/cache/saleshub/saleshub-products.json index
 *   /data/cache/saleshub/saleshub-knowledge.json full knowledge base
 *   config-templates/saleshub-knowledge.json (for container distribution)
 *
 * Called by sync-l3-daemon.ts via saleshub-trigger file mechanism.
 */

import { chromium } from '@playwright/test'
import type { Browser, BrowserContext, Page } from '@playwright/test'
import { readFileSync, mkdirSync, existsSync, copyFileSync } from 'fs'
import { resolve } from 'path'
import { toSlug } from '../src/cache-layer.ts'
import { writeJsonAtomic } from '../src/lib/atomic-write.ts'
import { BASE_CHROMIUM_ARGS } from '../src/browser-utils.ts'
import {
  parseTdpSectionsFromText,
  parseSalesTacticSections,
  parseTdpPageSections,
  parseSalesPlayPageSections,
  buildSalesHubKnowledge,
  type SalesHubKnowledge,
  type ScrapedSalesPlay,
  type ScrapedSalesTactic,
  type ScrapedTdpPage,
} from './saleshub-knowledge-extraction.ts'
import { discoverAllPages } from './saleshub-page-discovery.ts'

const PROFILE_DIR = process.env.RH_PROFILE_DIR ?? '/data/rh-profile'
const CACHE_DIR = process.env.CACHE_DIR ?? '/data/cache'
const OUTPUT_DIR = resolve(CACHE_DIR, 'saleshub')
const SALESHUB_URL = 'https://saleshub.redhat.com'
const DOCCENTER_PROFILE = '1d1918e9-b5b0-4428-b8fc-87e02ad44156'
const CHROMIUM_PATH = '/ms-playwright/chromium-1208/chrome-linux/chrome'

// Wait times for SPA rendering
const INITIAL_SPA_WAIT_MS = 12_000
const POST_EXPAND_WAIT_MS = 3_000

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

// ── Pass 1: Product Page Extraction (with accordion expansion) ───────────────

async function clickAccordionExpanders(page: Page): Promise<number> {
  // Click all elements matching text="arrow down" to expand accordion sections
  let clickedCount = 0
  try {
    const arrowElements = await page.getByText('arrow down').all()
    console.log(`[scrape-saleshub] Found ${arrowElements.length} accordion expanders`)
    for (const el of arrowElements) {
      try {
        await el.click({ timeout: 2_000 })
        clickedCount++
      } catch {
        // Element may not be clickable or visible — skip
      }
    }
    if (clickedCount > 0) {
      console.log(`[scrape-saleshub] Clicked ${clickedCount} expanders, waiting for content…`)
      await page.waitForTimeout(POST_EXPAND_WAIT_MS)
    }
  } catch (e: any) {
    console.warn(`[scrape-saleshub] Accordion expansion warning: ${e.message}`)
  }
  return clickedCount
}

async function extractProductPage(page: Page, productName: string, productUrl: string): Promise<SalesHubProduct | null> {
  try {
    console.log(`[scrape-saleshub] Scraping product: ${productName}`)
    await page.goto(productUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 })

    // Wait for initial SPA render (Seismic needs time)
    await page.waitForTimeout(INITIAL_SPA_WAIT_MS)

    // Click accordion expanders to reveal TDP/tactic content
    const expandedCount = await clickAccordionExpanders(page)
    if (expandedCount > 0) {
      console.log(`[scrape-saleshub] Expanded ${expandedCount} accordion sections on ${productName}`)
    }

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

      return { headings, links, description, mainText: mainText.slice(0, 30000) }
    })

    // Parse TDP sections from headings (original approach)
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

    // Also parse TDP/tactic sections from the expanded main text using extraction module
    const mainText = data.mainText
    const tdpSectionNames = new Set(tdpSections.map(t => t.name))

    const textParsedTdps = parseTdpSectionsFromText(mainText)
    for (const tdp of textParsedTdps) {
      if (!tdpSectionNames.has(tdp.name)) {
        tdpSections.push(tdp)
        tdpSectionNames.add(tdp.name)
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

    const product: SalesHubProduct = {
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

    console.log(`[scrape-saleshub] ${productName}: ${tdpSections.length} TDPs, ${salesTactics.length} tactics, ${googleDocsUrls.length} docs`)
    return product
  } catch (e: any) {
    console.error(`[scrape-saleshub] Failed to scrape ${productName}: ${e.message}`)
    return null
  }
}

// ── Pass 1.5: TDP Page Structured Extraction (#366) ────────────────────────

async function extractTdpPage(page: Page, tdpName: string, tdpUrl: string): Promise<ScrapedTdpPage | null> {
  try {
    console.log(`[scrape-saleshub] Scraping TDP page: ${tdpName}`)
    await page.goto(tdpUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 })
    await page.waitForTimeout(INITIAL_SPA_WAIT_MS)

    // Expand accordions to reveal all sections
    await clickAccordionExpanders(page)

    const data = await page.evaluate(() => {
      const mainEl = document.querySelector('main, [role="main"], body') as HTMLElement
      const mainText = mainEl?.innerText ?? ''

      const links = Array.from(document.querySelectorAll('a[href]')).map(a => ({
        text: a.textContent?.trim() ?? '',
        href: a.getAttribute('href') ?? '',
      })).filter(l => l.text && l.href && !l.href.startsWith('#') && !l.href.startsWith('javascript'))

      return { mainText: mainText.slice(0, 30000), links }
    })

    const sections = parseTdpPageSections(data.mainText, data.links)
    sections.name = tdpName

    console.log(`[scrape-saleshub] TDP ${tdpName}: ${sections.customerWins.length} wins, ${sections.whatToSay.length} say, ${sections.whatToShare.length} share, ${sections.whatToShow.length} show`)
    return sections
  } catch (e: any) {
    console.error(`[scrape-saleshub] Failed to scrape TDP page ${tdpName}: ${e.message}`)
    return null
  }
}

// ── Pass 2: Sales Play Page Extraction ───────────────────────────────────────

async function discoverSalesPlayLinks(page: Page): Promise<Array<{ name: string; url: string }>> {
  console.log('[scrape-saleshub] Discovering Sales Play pages from DocCenter…')

  // Navigate to DocCenter and use the "Sales Play" filter sidebar to find tagged content
  // The DocCenter page text shows filter categories including "Sales Play" with named plays
  const doccenterUrl = `${SALESHUB_URL}/apps/doccenter/${DOCCENTER_PROFILE}/main///`
  await page.goto(doccenterUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 })
  await page.waitForTimeout(INITIAL_SPA_WAIT_MS)

  // Known Sales Play names from SalesHub (from DocCenter filter sidebar)
  const knownPlays = [
    'Build and Run Applications',
    'Modernize Infrastructure',
    'The AI-Ready Enterprise',
    'Sovereignty',
    'IT Operations Efficiency',
  ]

  // Find links to pages tagged as Sales Plays
  const links = await page.evaluate((plays) => {
    const items: { name: string; url: string }[] = []
    const allLinks = document.querySelectorAll('a[href]')
    allLinks.forEach(a => {
      const text = a.textContent?.trim() ?? ''
      const href = a.getAttribute('href') ?? ''
      if (!href.includes('doccenter') || !href.includes('lf')) return
      for (const play of plays) {
        if (text.toLowerCase().includes(play.toLowerCase())) {
          items.push({
            name: play,
            url: href.startsWith('http') ? href : `${window.location.origin}${href}`,
          })
          break
        }
      }
    })
    const seen = new Set<string>()
    return items.filter(i => {
      if (seen.has(i.name)) return false
      seen.add(i.name)
      return true
    })
  }, knownPlays)

  console.log(`[scrape-saleshub] Found ${links.length} Sales Play pages`)

  // If no links found on DocCenter, create placeholder entries from known plays
  if (links.length === 0) {
    console.log('[scrape-saleshub] No Sales Play links found — using known play names as placeholders')
    return knownPlays.map(name => ({ name, url: '' }))
  }

  return links
}

async function extractSalesPlayPage(browser: Browser, sessionState: object, playName: string, playUrl: string): Promise<ScrapedSalesPlay | null> {
  // If no URL (placeholder entry), return the play with just the name
  if (!playUrl) {
    console.log(`[scrape-saleshub] Sales Play placeholder: ${playName}`)
    return { name: playName, description: '', linkedTdps: [], url: '' }
  }

  // Fresh context per Sales Play — shared context accumulates Seismic SPA state
  // from 21+ prior product/TDP navigations that prevents sidebar cards from rendering
  const freshContext = await browser.newContext({
    storageState: sessionState as any,
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  })
  const page = await freshContext.newPage()
  try {
    console.log(`[scrape-saleshub] Scraping Sales Play: ${playName}`)
    await page.goto(playUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 })
    await page.waitForTimeout(INITIAL_SPA_WAIT_MS)

    // Extract sidebar TDP alignment BEFORE accordion expansion (#381)
    // Must use Link/Content URL (not DocCenter URL) for sidebar to render correctly
    // Try to find a redirect to Link/Content format, or extract from current page
    await page.waitForTimeout(3_000)
    const sidebarTdpNames = await page.evaluate(() => {
      const names: string[] = []
      // Look for aria-labels that match TDP names (sidebar cards)
      const KNOWN_TDP_PARTS = ['AI Platform', 'Server', 'Container', 'Automation', 'App Platform', 'Virtualization', 'Operating System']
      const cardItems = document.querySelectorAll('li[aria-label]')
      for (const li of cardItems) {
        const label = li.getAttribute('aria-label') ?? ''
        if (label.startsWith('Open ')) {
          const name = label.replace('Open ', '')
          if (name.length > 2 && KNOWN_TDP_PARTS.some(k => name.includes(k)) && !names.includes(name)) {
            names.push(name)
          }
        }
      }
      return { names, totalAriaItems: cardItems.length }
    })
    if (sidebarTdpNames.names.length > 0) {
      console.log(`[scrape-saleshub] ${playName}: pre-accordion sidebar TDPs: ${sidebarTdpNames.names.join(', ')}`)
    } else {
      console.log(`[scrape-saleshub] ${playName}: no sidebar TDPs found (${sidebarTdpNames.totalAriaItems} aria-label items)`)
    }

    // Expand accordions (this destroys sidebar DOM)
    await clickAccordionExpanders(page)

    const data = await page.evaluate(() => {
      // Use document.body to include sidebar content (#381)
      const mainText = document.body?.innerText ?? ''

      // Extract description — first meaningful paragraph
      let description = ''
      const paragraphs = document.querySelectorAll('p, div > span')
      for (const p of paragraphs) {
        const text = p.textContent?.trim() ?? ''
        if (text.length > 50 && !text.includes('Rating') && !text.includes('Review')) {
          description = text.slice(0, 2000)
          break
        }
      }

      // Extract all links for TDP/product cross-references
      const links = Array.from(document.querySelectorAll('a[href]')).map(a => ({
        text: a.textContent?.trim() ?? '',
        href: a.getAttribute('href') ?? '',
      }))

      return { description, mainText: mainText.slice(0, 20000), links }
    })

    // Identify linked TDPs from page text and links
    const knownTdps = ['AI Platform', 'App Platform', 'Automation', 'Virtualization', 'Server/Cloud OS', 'Container Mgmt']
    const linkedTdps: string[] = []
    for (const tdp of knownTdps) {
      if (data.mainText.toLowerCase().includes(tdp.toLowerCase())) {
        linkedTdps.push(tdp)
      }
    }

    // Extract structured sections (#367)
    const sections = parseSalesPlayPageSections(data.mainText, data.links)

    // Use pre-accordion sidebar extraction (most reliable), fall back to text parsing
    const tdpAlignment = sidebarTdpNames.names.length > 0
      ? sidebarTdpNames.names
      : sections.tdpAlignment
    if (tdpAlignment.length > 0) {
      console.log(`[scrape-saleshub] ${playName}: tdpAlignment = ${tdpAlignment.join(', ')}`)
    } else {
      console.log(`[scrape-saleshub] ${playName}: tdpAlignment empty`)
    }

    return {
      name: playName,
      description: data.description,
      linkedTdps,
      url: playUrl,
      customerLens: sections.customerLens,
      realWorldExamples: sections.realWorldExamples,
      emailTemplateUrl: sections.emailTemplateUrl,
      discoveryQuestionsUrl: sections.discoveryQuestionsUrl,
      introPitchDeckUrl: sections.introPitchDeckUrl,
      personaSection: sections.personaSection,
      tdpAlignment,
      regionalCampaigns: sections.regionalCampaigns,
    }
  } catch (e: any) {
    console.error(`[scrape-saleshub] Failed to scrape Sales Play ${playName}: ${e.message}`)
    return null
  } finally {
    await freshContext.close()
  }
}

// ── Pass 3: Sales Tactic Page Extraction ─────────────────────────────────────

async function discoverSalesTacticLinks(page: Page): Promise<Array<{ name: string; url: string }>> {
  console.log('[scrape-saleshub] Discovering Sales Tactic pages…')

  // Navigate to SalesHub homepage where Sales Tactics section has links
  await page.goto(`${SALESHUB_URL}/apps/home`, { waitUntil: 'domcontentloaded', timeout: 60_000 })
  await page.waitForTimeout(INITIAL_SPA_WAIT_MS)

  // Known tactic names from DocCenter filter sidebar
  const knownTactics = [
    'Agentic AI', 'Inference at Scale', 'Production AI', 'Sovereign (Private) AI',
    'AIOps', 'Optimize and Modernize IT Ops', 'Automate at Scale', 'Network Automation',
    'VMware Migration', 'Cloud-Native Adoption', 'Application Modernization',
    'Platform Engineering', 'Developer Productivity', 'Edge Computing',
    'Digital Sovereignty', 'Supply Chain Security', 'Security Automation',
    'Observability', 'Database Modernization', 'Infrastructure as Code',
  ]

  const links = await page.evaluate((tactics) => {
    const items: { name: string; url: string }[] = []
    const allLinks = document.querySelectorAll('a[href]')
    allLinks.forEach(a => {
      const text = a.textContent?.trim() ?? ''
      const href = a.getAttribute('href') ?? ''
      if (!href.includes('doccenter') || !href.includes('lf')) return
      for (const tactic of tactics) {
        if (text.toLowerCase().includes(tactic.toLowerCase())) {
          items.push({
            name: tactic,
            url: href.startsWith('http') ? href : `${window.location.origin}${href}`,
          })
          break
        }
      }
    })
    const seen = new Set<string>()
    return items.filter(i => {
      if (seen.has(i.name)) return false
      seen.add(i.name)
      return true
    })
  }, knownTactics)

  console.log(`[scrape-saleshub] Found ${links.length} Sales Tactic pages from homepage`)

  // Also check "frequently used" section which has tactic pages we visited
  if (links.length < 5) {
    console.log('[scrape-saleshub] Few tactic links found — tactic pages extracted from product TDP sections instead')
  }

  return links
}

async function extractSalesTacticPage(page: Page, tacticName: string, tacticUrl: string): Promise<ScrapedSalesTactic | null> {
  try {
    console.log(`[scrape-saleshub] Scraping Sales Tactic: ${tacticName}`)
    await page.goto(tacticUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 })
    await page.waitForTimeout(INITIAL_SPA_WAIT_MS)

    // Expand accordions
    await clickAccordionExpanders(page)

    const mainText = await page.evaluate(() => {
      const mainEl = document.querySelector('main, [role="main"], body') as HTMLElement
      return mainEl?.innerText ?? ''
    })

    // Extract structured sections
    const sections = parseSalesTacticSections(mainText)

    // Extract links for whatToShare
    const pageLinks = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('a[href]')).map(a => ({
        text: a.textContent?.trim() ?? '',
        href: a.getAttribute('href') ?? '',
      })).filter(l => l.text && l.href && l.text.length > 3 && !l.href.startsWith('#') && !l.href.startsWith('javascript'))
    })

    // Enrich whatToShare with actual URLs from page links
    const enrichedShares: Array<{ name: string; url: string; type: string }> = []
    for (const share of sections.whatToShare) {
      // Try to find a matching link
      const matchingLink = pageLinks.find(l =>
        l.text.toLowerCase().includes(share.name.toLowerCase().slice(0, 20)) ||
        share.name.toLowerCase().includes(l.text.toLowerCase().slice(0, 20)),
      )
      enrichedShares.push({
        name: share.name,
        url: matchingLink?.href ?? '',
        type: matchingLink ? classifyUrl(matchingLink.href) : 'seismic',
      })
    }

    // Also find shareable assets from links that look like decks/docs
    for (const link of pageLinks) {
      const lower = link.text.toLowerCase()
      if ((lower.includes('deck') || lower.includes('presentation') ||
           lower.includes('guide') || lower.includes('whitepaper') ||
           lower.includes('infographic') || lower.includes('cheat sheet')) &&
          !enrichedShares.some(s => s.url === link.href)) {
        enrichedShares.push({
          name: link.text,
          url: link.href,
          type: classifyUrl(link.href),
        })
      }
    }

    // Determine parent TDP from page content
    const knownTdps = ['AI Platform', 'App Platform', 'Automation', 'Virtualization', 'Server/Cloud OS', 'Container Mgmt']
    let parentTdp = ''
    const mainTextLower = mainText.toLowerCase()

    // Try to find "Supporting TDPs" section
    const tdpSectionMatch = mainText.match(/Supporting TDPs[\s\S]*?(?=\n\n|\n[A-Z]|$)/i)
    if (tdpSectionMatch) {
      for (const tdp of knownTdps) {
        if (tdpSectionMatch[0].toLowerCase().includes(tdp.toLowerCase())) {
          parentTdp = tdp
          break
        }
      }
    }

    // Fallback: infer from content keywords
    if (!parentTdp) {
      if (mainTextLower.includes('ansible') || mainTextLower.includes('automation platform')) parentTdp = 'Automation'
      else if (mainTextLower.includes('openshift') || mainTextLower.includes('kubernetes')) parentTdp = 'App Platform'
      else if (mainTextLower.includes('rhel') || mainTextLower.includes('enterprise linux')) parentTdp = 'Server/Cloud OS'
      else if (mainTextLower.includes('virtualization') || mainTextLower.includes('vmware')) parentTdp = 'Virtualization'
      else if (mainTextLower.includes('edge') || mainTextLower.includes('microshift')) parentTdp = 'Edge'
      else if (mainTextLower.includes('ai') || mainTextLower.includes('machine learning')) parentTdp = 'AI'
    }

    return {
      name: tacticName,
      talkTrack: sections.talkTrack,
      customerWins: sections.customerWins,
      whatToSay: sections.whatToSay,
      whatToShare: enrichedShares,
      parentTdp,
      url: tacticUrl,
    }
  } catch (e: any) {
    console.error(`[scrape-saleshub] Failed to scrape Sales Tactic ${tacticName}: ${e.message}`)
    return null
  }
}

// ── Main Scrape Function ─────────────────────────────────────────────────────

export interface SalesHubScrapeResult {
  products: SalesHubProduct[]
  knowledge: SalesHubKnowledge
}

export async function scrapeSalesHub(): Promise<SalesHubScrapeResult> {
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
  const salesPlays: ScrapedSalesPlay[] = []
  const tactics: ScrapedSalesTactic[] = []
  const tdpPages: ScrapedTdpPage[] = []

  try {
    // ── API-based Page Discovery (run FIRST while session is fresh) ────────
    console.log('[scrape-saleshub] === DISCOVERING PAGES VIA SEISMIC API ===')
    const discoveryPage = await context.newPage()
    const discovered = await discoverAllPages(discoveryPage)
    await discoveryPage.close()
    console.log(`[scrape-saleshub] Discovered: ${discovered.tactics.length} tactics, ${discovered.plays.length} plays, ${discovered.tdps.length} TDPs`)

    // ── Pass 1: Product Pages ──────────────────────────────────────────────
    console.log('[scrape-saleshub] === PASS 1: Product Pages ===')
    const listingPage = await context.newPage()
    const productsUrl = `${SALESHUB_URL}/apps/doccenter/${DOCCENTER_PROFILE}/doc/%252Fdd04d516a5-19b3-48c9-e01a-d2bf52939de4%252FdfMmNhNDhiYjktYzE1Ny00ZjgyLWJlYjUtNTdhY2NjZmY5Y2Rh%252CPT0%253D%252CUGFnZSBSSFNI%252Flf3e41b707-4f29-4a23-9ee9-27736d70c8eb//`

    await listingPage.goto(productsUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 })
    await listingPage.waitForTimeout(8_000)

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

    // Scrape each product page with accordion expansion
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

    // ── Pass 1.5: TDP Pages (#366) ────────────────────────────────────────────
    console.log(`[scrape-saleshub] === PASS 1.5: TDP Pages (${discovered.tdps.length} discovered) ===`)
    for (let i = 0; i < discovered.tdps.length; i++) {
      const tdp = discovered.tdps[i]
      console.log(`[scrape-saleshub] (${i + 1}/${discovered.tdps.length}) TDP: ${tdp.name}`)

      const tdpPage = await extractTdpPage(scrapePage, tdp.name, tdp.url)
      if (tdpPage) {
        tdpPages.push(tdpPage)
      }

      await scrapePage.waitForTimeout(1_000)
    }

    // ── Pass 1.9: Home page tile URLs (#381) ──────────────────────────────
    // DocCenter URLs from page discovery load wrong pages for Sales Plays.
    // The home page iframes have correct /Link/Content/ URLs that render sidebar cards.
    console.log(`[scrape-saleshub] === PASS 1.9: Home Page Tile URLs ===`)
    const homePlayUrls = new Map<string, string>()
    try {
      await scrapePage.goto('https://saleshub.redhat.com/apps/home?anchorId=350c3ac4-2f1b-4541-b3df-a65d0e1f70fd', {
        waitUntil: 'domcontentloaded', timeout: 60_000,
      })
      await scrapePage.waitForTimeout(8_000)
      for (let s = 0; s < 10; s++) {
        await scrapePage.evaluate(() => window.scrollBy(0, 800))
        await scrapePage.waitForTimeout(1_500)
      }
      // Sales Plays are in Frame 2 (index 2)
      const frames = scrapePage.frames()
      if (frames.length > 2) {
        const tileData = await frames[2].evaluate(() => {
          const results: Array<{ linkText: string; href: string }> = []
          for (const a of document.querySelectorAll('a')) {
            if (a.textContent?.trim() === 'Sales Play Page') {
              results.push({ linkText: 'Sales Play Page', href: a.getAttribute('href') ?? '' })
            }
          }
          return results
        })
        // Map discovered play names to Link/Content URLs by order
        const knownPlays = discovered.plays.map(p => p.name)
        for (let j = 0; j < Math.min(knownPlays.length, tileData.length); j++) {
          if (tileData[j].href) {
            homePlayUrls.set(knownPlays[j], tileData[j].href)
            console.log(`[scrape-saleshub] ${knownPlays[j]} → ${tileData[j].href.slice(0, 80)}`)
          }
        }
      }
    } catch (e: any) {
      console.log(`[scrape-saleshub] Home page tile scan failed: ${e.message} — falling back to DocCenter URLs`)
    }

    // ── Pass 2: Sales Play Pages ─────────────────────────────────────────────
    console.log(`[scrape-saleshub] === PASS 2: Sales Play Pages (${discovered.plays.length} discovered) ===`)
    const playLinks = discovered.plays

    for (let i = 0; i < playLinks.length; i++) {
      const pl = playLinks[i]
      // Prefer Link/Content URL from home page tiles (renders sidebar correctly)
      const playUrl = homePlayUrls.get(pl.name) || pl.url
      console.log(`[scrape-saleshub] (${i + 1}/${playLinks.length}) Sales Play: ${pl.name}`)

      const play = await extractSalesPlayPage(browser, sessionState, pl.name, playUrl)
      if (play) {
        salesPlays.push(play)
      }

      await scrapePage.waitForTimeout(1_000)
    }

    // ── Pass 3: Sales Tactic Pages ───────────────────────────────────────────
    console.log(`[scrape-saleshub] === PASS 3: Sales Tactic Pages (${discovered.tactics.length} discovered) ===`)
    const tacticLinks = discovered.tactics

    for (let i = 0; i < tacticLinks.length; i++) {
      const tl = tacticLinks[i]
      console.log(`[scrape-saleshub] (${i + 1}/${tacticLinks.length}) Sales Tactic: ${tl.name}`)

      const tactic = await extractSalesTacticPage(scrapePage, tl.name, tl.url)
      if (tactic) {
        tactics.push(tactic)
      }

      await scrapePage.waitForTimeout(1_000)
    }

    await scrapePage.close()

    // ── Build Knowledge Base ─────────────────────────────────────────────────
    console.log('[scrape-saleshub] Building knowledge base…')
    const knowledge = buildSalesHubKnowledge(products, salesPlays, tactics, tdpPages)

    // Write knowledge file to cache
    const knowledgePath = resolve(OUTPUT_DIR, 'saleshub-knowledge.json')
    writeJsonAtomic(knowledgePath, knowledge)

    // Also copy to config-templates for container distribution
    const configTemplatesDir = resolve(process.cwd(), 'config-templates')
    if (existsSync(configTemplatesDir)) {
      const templatePath = resolve(configTemplatesDir, 'saleshub-knowledge.json')
      writeJsonAtomic(templatePath, knowledge)
      console.log(`[scrape-saleshub] Knowledge file also written to ${templatePath}`)
    }

    // Write combined product index (backward compatible)
    const index = {
      scrapedAt: new Date().toISOString(),
      productCount: products.length,
      salesPlayCount: salesPlays.length,
      tacticCount: tactics.length,
      tdpCount: knowledge.tdps.length,
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

    console.log(`[scrape-saleshub] === SCRAPE COMPLETE ===`)
    console.log(`  Products: ${products.length}`)
    console.log(`  Sales Plays: ${salesPlays.length}`)
    console.log(`  Sales Tactics: ${tactics.length}`)
    console.log(`  TDPs (aggregated): ${knowledge.tdps.length}`)
    console.log(`  Knowledge file: ${knowledgePath}`)

    // Log products with 0 TDP sections for troubleshooting
    const noTdpProducts = products.filter(p => p.tdpSections.length === 0)
    if (noTdpProducts.length > 0) {
      console.log(`[scrape-saleshub] Products with 0 TDP sections:`)
      for (const p of noTdpProducts) {
        console.log(`  - ${p.name}`)
      }
    }

    return { products, knowledge }

  } finally {
    await context.close()
    await browser.close()
  }
}

// Direct execution
if (import.meta.main) {
  const args = new Set(process.argv.slice(2))

  if (args.has('--help')) {
    console.log(`Usage: bun scripts/scrape-saleshub.ts [flags]
  --tdp-only        Run discovery + TDP page extraction only (skip products, plays, tactics)
  --discovery-only  Run discovery only — show what URLs would be scraped, then exit
  --help            Show this help`)
    process.exit(0)
  }

  if (args.has('--discovery-only')) {
    // Quick discovery check — no page scraping
    ;(async () => {
      const sessionStatePath = resolve(PROFILE_DIR, 'session-state.json')
      const sessionState = JSON.parse(readFileSync(sessionStatePath, 'utf-8'))
      const browser = await chromium.launch({ headless: true, executablePath: CHROMIUM_PATH, args: [...BASE_CHROMIUM_ARGS, '--headless=new'] })
      const context = await browser.newContext({ storageState: sessionState, userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36' })
      const page = await context.newPage()
      const discovered = await discoverAllPages(page)
      console.log(`\nDiscovered:`)
      console.log(`  TDPs: ${discovered.tdps.length}`)
      for (const t of discovered.tdps) console.log(`    - ${t.name}: ${t.url.slice(0, 80)}`)
      console.log(`  Tactics: ${discovered.tactics.length}`)
      for (const t of discovered.tactics) console.log(`    - ${t.name}`)
      console.log(`  Plays: ${discovered.plays.length}`)
      for (const p of discovered.plays) console.log(`    - ${p.name}`)
      await context.close()
      await browser.close()
    })().catch(e => { console.error('Discovery failed:', e.message); process.exit(1) })
  } else if (args.has('--tdp-only')) {
    // TDP-only mode — discovery + TDP extraction, merge into existing knowledge
    ;(async () => {
      const sessionStatePath = resolve(PROFILE_DIR, 'session-state.json')
      const sessionState = JSON.parse(readFileSync(sessionStatePath, 'utf-8'))
      console.log(`[scrape-saleshub] TDP-only mode — ${sessionState.cookies?.length ?? 0} cookies loaded`)
      const browser = await chromium.launch({ headless: true, executablePath: CHROMIUM_PATH, args: [...BASE_CHROMIUM_ARGS, '--disable-blink-features=AutomationControlled', '--headless=new'] })
      const context = await browser.newContext({ storageState: sessionState, userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' })

      // Discovery
      const discoveryPage = await context.newPage()
      const discovered = await discoverAllPages(discoveryPage)
      await discoveryPage.close()
      console.log(`[scrape-saleshub] Discovered ${discovered.tdps.length} TDPs`)

      if (discovered.tdps.length === 0) {
        console.error('[scrape-saleshub] ZERO TDPs discovered — check discoverAllPages() against current SalesHub DOM')
        await context.close(); await browser.close()
        process.exit(1)
      }

      // Extract TDP pages only
      const tdpPages: ScrapedTdpPage[] = []
      const page = await context.newPage()
      for (let i = 0; i < discovered.tdps.length; i++) {
        const tdp = discovered.tdps[i]
        console.log(`[scrape-saleshub] (${i + 1}/${discovered.tdps.length}) TDP: ${tdp.name}`)
        const tdpPage = await extractTdpPage(page, tdp.name, tdp.url)
        if (tdpPage) {
          console.log(`  → ${tdpPage.customerWins.length} wins, ${tdpPage.whatToSay.length} say, ${tdpPage.whatToShare.length} share, ${tdpPage.whatToShow.length} show, ${tdpPage.services.length} services`)
          tdpPages.push(tdpPage)
        } else {
          console.log(`  → FAILED — null returned`)
        }
        await page.waitForTimeout(1_000)
      }
      await page.close()
      await context.close()
      await browser.close()

      // Load existing knowledge and merge TDP data
      const knowledgePath = resolve(OUTPUT_DIR, 'saleshub-knowledge.json')
      if (existsSync(knowledgePath)) {
        const existing = JSON.parse(readFileSync(knowledgePath, 'utf-8')) as SalesHubKnowledge
        // Re-build with existing products/plays/tactics + new TDP pages
        const merged = buildSalesHubKnowledge([], existing.salesPlays as any, existing.tactics as any, tdpPages)
        // Preserve existing TDP descriptions and tactics from products pass
        for (const existingTdp of existing.tdps) {
          const mergedTdp = merged.tdps.find(t => t.name === existingTdp.name)
          if (mergedTdp) {
            if (!mergedTdp.description && existingTdp.description) mergedTdp.description = existingTdp.description
            if (mergedTdp.tactics.length === 0 && existingTdp.tactics.length > 0) mergedTdp.tactics = existingTdp.tactics
            if (mergedTdp.products.length === 0 && existingTdp.products.length > 0) mergedTdp.products = existingTdp.products
          }
        }
        writeJsonAtomic(knowledgePath, merged)
        console.log(`\n[done] Merged TDP data into ${knowledgePath}`)
        for (const t of merged.tdps) {
          console.log(`  ${t.name}: ${t.whatToShare?.length ?? 0} share, ${t.services?.length ?? 0} services, ${t.whatToShow?.length ?? 0} show`)
        }
      } else {
        console.error(`[scrape-saleshub] No existing knowledge at ${knowledgePath} — run full scrape first`)
      }
    })().catch(e => { console.error('TDP-only scrape failed:', e.message); process.exit(1) })
  } else {
    // Full scrape (default)
    scrapeSalesHub()
      .then(result => {
        console.log(`\nSalesHub scrape completed successfully.`)
        console.log(`Knowledge base: ${result.knowledge.products.length} products, ${result.knowledge.tdps.length} TDPs, ${result.knowledge.tactics.length} tactics, ${result.knowledge.salesPlays.length} plays`)
      })
      .catch(err => {
        console.error('[scrape-saleshub] Fatal:', err)
        process.exit(1)
      })
  }
}
