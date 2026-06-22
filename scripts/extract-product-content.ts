#!/usr/bin/env bun
/**
 * scripts/extract-product-content.ts — Post-scrape product content extraction + enrichment (#858)
 *
 * Reads a product's _product.json (already produced by the scraper), navigates to
 * every item's URL, extracts page text, then runs Gemini enrichment on all
 * extracted content.
 *
 * Usage:
 *   bun run scripts/extract-product-content.ts <product-slug>
 *   bun run scripts/extract-product-content.ts red-hat-ansible-automation-platform
 *
 * Outputs:
 *   config-templates/saleshub-products/{slug}/_enriched.json   — Gemini enrichment results
 *   config-templates/saleshub-products/{slug}/_extraction-results.json — per-item extraction log
 */

import { chromium } from '@playwright/test'
import type { Page, BrowserContext } from '@playwright/test'
import { readFileSync, existsSync } from 'fs'
import { resolve } from 'path'
import { writeJsonAtomic } from '../src/lib/atomic-write.ts'
import { sanitizeViewerHtml } from './scrape-saleshub-product-page.ts'
import { enrichProductDocuments } from '../src/lib/saleshub-product-enrichment.ts'
import { BASE_CHROMIUM_ARGS } from '../src/browser-utils.ts'
import type {
  ProductPage,
  SectionItem,
} from '../src/types/saleshub-product-types.ts'

// ── Constants ────────────────────────────────────────────────────────────────

const PROFILE_DIR = process.env.RH_PROFILE_DIR ?? '/data/rh-profile'
const CHROMIUM_PATH = process.env.CHROMIUM_PATH ?? '/ms-playwright/chromium-1208/chrome-linux/chrome'
const NAV_TIMEOUT = 15_000
const RATE_LIMIT_MS = 2_000
const MIN_CONTENT_LENGTH = 300

// ── Types ────────────────────────────────────────────────────────────────────

type ExtractionMethod = 'tactic' | 'viewer' | 'webpage' | 'youtube' | 'section-text' | 'no-url'
type ExtractionStatus = 'extracted' | 'skipped' | 'failed'

interface ExtractionResult {
  name: string
  section: string
  domain: string
  method: ExtractionMethod
  status: ExtractionStatus
  reason: string
  contentLength: number
  url: string
}

interface ExtractionLog {
  timestamp: string
  productSlug: string
  totalItems: number
  extracted: number
  skipped: number
  failed: number
  results: ExtractionResult[]
}

interface ExtractedContent {
  name: string
  section: string
  content: string
  type: string
  domain: string
}

// ── Domain tagging ───────────────────────────────────────────────────────────

function tagDomain(name: string, sectionTitle: string): string {
  const text = `${name} ${sectionTitle}`
  if (/\bEDA\b|Event[- ]Driven/i.test(text)) return 'Event-Driven Ansible'
  if (/\bANA\b|Network\s+Automation/i.test(text)) return 'Network Automation'
  if (/\bACA\b|Cloud[- ]native|Private\s+Cloud|Public\s+Cloud/i.test(text)) return 'Hybrid Cloud Automation'
  if (/\bAVA\b|Virtualization\s+Automation/i.test(text)) return 'Virtual Infrastructure Automation'
  if (/\bAEA\b|\bEdge\b/i.test(text)) return 'Edge Automation'
  if (/\bAIOps\b/i.test(text)) return 'AIOps'
  if (/\bASA\b|Security\s+Automation/i.test(text)) return 'Security Automation'
  return 'General'
}

// ── URL classification ───────────────────────────────────────────────────────

function classifyUrl(url: string): { method: ExtractionMethod; needsAuth: boolean } {
  if (!url) return { method: 'no-url', needsAuth: false }

  try {
    const hostname = new URL(url).hostname
    if (hostname === 'saleshub.redhat.com') return { method: 'viewer', needsAuth: true }
    if (/youtube\.com|youtu\.be/i.test(hostname)) return { method: 'youtube', needsAuth: false }
    if (hostname === 'training-lms.redhat.com') return { method: 'webpage', needsAuth: true }
    if (hostname === 'reprint.forrester.com') return { method: 'webpage', needsAuth: true }
    if (/\.redhat\.com$|docs\.google\.com/i.test(hostname)) return { method: 'webpage', needsAuth: false }
    // Default: treat any other URL as a webpage
    return { method: 'webpage', needsAuth: false }
  } catch {
    return { method: 'webpage', needsAuth: false }
  }
}

// ── Extraction functions ─────────────────────────────────────────────────────

async function extractTactic(item: SectionItem): Promise<string | null> {
  if (item.description && item.description.length > 0) {
    return item.description
  }
  return null
}

async function extractWebpage(
  page: Page,
  url: string,
): Promise<{ content: string | null; reason: string }> {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT })
    await page.waitForTimeout(2_000)
    const innerText = await page.innerText('body')

    // Check for login redirect / auth-required
    const pageUrl = page.url()
    if (/login|signin|sso|auth/i.test(pageUrl) && !/redhat\.com\/en\//i.test(pageUrl)) {
      return { content: null, reason: 'auth-required — redirected to login' }
    }

    if (!innerText || innerText.length < MIN_CONTENT_LENGTH) {
      return { content: null, reason: `content too short (${innerText?.length ?? 0} chars)` }
    }

    // Check for error pages
    const lower = innerText.toLowerCase()
    if (/content\s+not\s+found/i.test(lower) || /page\s+not\s+found/i.test(lower)) {
      return { content: null, reason: 'error page (content/page not found)' }
    }

    return { content: innerText, reason: 'ok' }
  } catch (e: any) {
    return { content: null, reason: `navigation error: ${e.message?.slice(0, 100)}` }
  }
}

async function extractViewer(
  page: Page,
  url: string,
): Promise<{ content: string | null; reason: string }> {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT })
    await page.waitForTimeout(3_000)

    // Try to get HTML for richer content (preserves links)
    const html = await page.content()
    const sanitized = sanitizeViewerHtml(html)

    // Fall back to innerText if sanitized HTML is too short
    if (sanitized.length > MIN_CONTENT_LENGTH) {
      return { content: sanitized, reason: 'ok (viewer HTML)' }
    }

    // Try innerText as fallback
    const innerText = await page.innerText('body')
    if (innerText && innerText.length > MIN_CONTENT_LENGTH) {
      const lower = innerText.toLowerCase()
      if (/content\s+not\s+found/i.test(lower) || /something\s+is\s+wrong/i.test(lower)) {
        return { content: null, reason: 'viewer error page' }
      }
      return { content: innerText, reason: 'ok (viewer text)' }
    }

    return { content: null, reason: `viewer content too short (${innerText?.length ?? 0} chars)` }
  } catch (e: any) {
    return { content: null, reason: `viewer error: ${e.message?.slice(0, 100)}` }
  }
}

async function extractYouTube(
  page: Page,
  url: string,
): Promise<{ content: string | null; reason: string }> {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT })
    await page.waitForTimeout(3_000)

    const parts: string[] = []

    // Extract title
    const title = await page.title()
    if (title) parts.push(`Title: ${title}`)

    // Extract video description
    try {
      // Try expanding "Show more" in the description
      const showMore = page.locator('#expand, [aria-label="Show more"], tp-yt-paper-button#expand')
      if (await showMore.isVisible({ timeout: 2_000 }).catch(() => false)) {
        await showMore.click().catch(() => {})
        await page.waitForTimeout(1_000)
      }
      const descEl = page.locator('#description-inline-expander, #description, [id="description"]')
      const desc = await descEl.innerText({ timeout: 3_000 }).catch(() => '')
      if (desc && desc.length > 20) parts.push(`Description: ${desc}`)
    } catch { /* description not found */ }

    // Try to get transcript
    try {
      // Click "Show transcript" button
      const transcriptBtn = page.locator('button:has-text("Show transcript"), [aria-label*="transcript" i]')
      if (await transcriptBtn.isVisible({ timeout: 2_000 }).catch(() => false)) {
        await transcriptBtn.click()
        await page.waitForTimeout(2_000)
        const transcriptEl = page.locator('[class*="transcript"], ytd-transcript-segment-renderer')
        const transcript = await transcriptEl.allInnerTexts().catch(() => [] as string[])
        if (transcript.length > 0) {
          parts.push(`Transcript: ${transcript.join(' ')}`)
        }
      }
    } catch { /* transcript not available */ }

    if (parts.length === 0) {
      return { content: null, reason: 'no YouTube content found' }
    }

    return { content: parts.join('\n\n'), reason: 'ok (youtube)' }
  } catch (e: any) {
    return { content: null, reason: `youtube error: ${e.message?.slice(0, 100)}` }
  }
}

function buildSeismicViewerUrl(contentId: string): string {
  return `https://saleshub.redhat.com/Link/Content/${contentId}`
}

function buildSeismicContentUrl(contentId: string): string {
  return `https://saleshub.redhat.com/content/${contentId}`
}

async function extractNoUrl(
  page: Page,
  item: SectionItem,
): Promise<{ content: string | null; reason: string; url: string }> {
  const contentId = item.contentId
  const versionId = item.versionId

  if (!contentId || !versionId) {
    return { content: null, reason: 'no URL and no contentId/versionId', url: '' }
  }

  // Try /Link/Content/ pattern first
  const linkUrl = buildSeismicViewerUrl(contentId)
  try {
    await page.goto(linkUrl, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT })
    await page.waitForTimeout(3_000)

    const html = await page.content()
    const sanitized = sanitizeViewerHtml(html)

    if (sanitized.length > MIN_CONTENT_LENGTH) {
      return { content: sanitized, reason: 'ok (Link/Content viewer)', url: linkUrl }
    }

    const innerText = await page.innerText('body')
    if (innerText && innerText.length > MIN_CONTENT_LENGTH) {
      const lower = innerText.toLowerCase()
      if (!/content\s+not\s+found/i.test(lower) && !/something\s+is\s+wrong/i.test(lower)) {
        return { content: innerText, reason: 'ok (Link/Content text)', url: linkUrl }
      }
    }
  } catch { /* Link/Content failed, try next */ }

  // Try /content/ pattern
  const contentUrl = buildSeismicContentUrl(contentId)
  try {
    await page.goto(contentUrl, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT })
    await page.waitForTimeout(3_000)

    const html = await page.content()
    const sanitized = sanitizeViewerHtml(html)

    if (sanitized.length > MIN_CONTENT_LENGTH) {
      return { content: sanitized, reason: 'ok (/content/ viewer)', url: contentUrl }
    }

    const innerText = await page.innerText('body')
    if (innerText && innerText.length > MIN_CONTENT_LENGTH) {
      const lower = innerText.toLowerCase()
      if (!/content\s+not\s+found/i.test(lower) && !/something\s+is\s+wrong/i.test(lower)) {
        return { content: innerText, reason: 'ok (/content/ text)', url: contentUrl }
      }
    }
  } catch { /* /content/ also failed */ }

  return {
    content: null,
    reason: `no-viewer-url (contentId: ${contentId}, versionId: ${versionId})`,
    url: linkUrl,
  }
}

// ── Enrichment type mapping ──────────────────────────────────────────────────

function mapItemTypeToEnrichmentType(itemType: string | undefined, sectionKey: string): string {
  if (!itemType || itemType === 'unknown') {
    // Infer from section key
    if (/content-kit/i.test(sectionKey)) return 'content-kit'
    if (/messaging/i.test(sectionKey)) return 'messaging-guide'
    if (/battlecard|competitive/i.test(sectionKey)) return 'battlecard'
    if (/case-study/i.test(sectionKey)) return 'case-study'
    return 'content-kit' // default
  }

  switch (itemType) {
    case 'tactic': return 'content-kit'
    case 'messaging-guide': return 'messaging-guide'
    case 'sales-conversation-guide': return 'messaging-guide'
    case 'battlecard': return 'battlecard'
    case 'competitive-review': return 'competitive-review'
    case 'case-study': return 'case-study'
    default: return 'content-kit'
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const slug = process.argv[2]
  if (!slug) {
    console.error('Usage: bun run scripts/extract-product-content.ts <product-slug>')
    console.error('Example: bun run scripts/extract-product-content.ts red-hat-ansible-automation-platform')
    process.exit(1)
  }

  const productDir = resolve('config-templates', 'saleshub-products', slug)
  const productJsonPath = resolve(productDir, '_product.json')

  if (!existsSync(productJsonPath)) {
    console.error(`[extract] _product.json not found at ${productJsonPath}`)
    console.error('[extract] Run the scraper first to produce _product.json')
    process.exit(1)
  }

  const product: ProductPage = JSON.parse(readFileSync(productJsonPath, 'utf-8'))
  console.log(`[extract] Product: ${product.name} (${slug})`)

  // ── Collect ALL items from ALL sections ────────────────────────────────────
  interface ItemWithContext {
    item: SectionItem
    sectionKey: string
    sectionTitle: string
  }

  const allItems: ItemWithContext[] = []
  const sectionTexts: Array<{ sectionKey: string; sectionTitle: string; textContent: string }> = []

  for (const [sectionKey, section] of Object.entries(product.sections)) {
    // Collect items
    for (const item of section.items) {
      allItems.push({ item, sectionKey, sectionTitle: section.title })
    }

    // Collect subsection items
    if (section.subsections) {
      for (const sub of section.subsections) {
        for (const item of sub.items) {
          allItems.push({ item, sectionKey, sectionTitle: sub.title ?? section.title })
        }
      }
    }

    // Collect section textContent
    if (section.textContent && section.textContent.length > 0) {
      sectionTexts.push({ sectionKey, sectionTitle: section.title, textContent: section.textContent })
    }
  }

  const totalItems = allItems.length + sectionTexts.length
  console.log(`[extract] Found ${allItems.length} items + ${sectionTexts.length} section texts = ${totalItems} total`)

  // ── Launch browser ─────────────────────────────────────────────────────────
  const sessionStatePath = resolve(PROFILE_DIR, 'session-state.json')
  if (!existsSync(sessionStatePath)) {
    console.error(`[extract] No session-state.json at ${sessionStatePath}`)
    console.error('[extract] Session state is required for SalesHub auth')
    process.exit(1)
  }
  const sessionState = JSON.parse(readFileSync(sessionStatePath, 'utf-8'))
  console.log(`[extract] Loaded ${sessionState.cookies?.length ?? 0} cookies from session state`)

  const browser = await chromium.launch({
    headless: true,
    executablePath: CHROMIUM_PATH,
    args: [
      ...BASE_CHROMIUM_ARGS,
      '--disable-blink-features=AutomationControlled',
      '--headless=new',
    ],
  })

  const context: BrowserContext = await browser.newContext({
    storageState: sessionState,
    userAgent:
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  })

  const page = await context.newPage()

  // ── Process each item ──────────────────────────────────────────────────────
  const results: ExtractionResult[] = []
  const extractedContents: ExtractedContent[] = []
  let extractedCount = 0
  let skippedCount = 0
  let failedCount = 0

  // Process regular items
  for (let i = 0; i < allItems.length; i++) {
    const { item, sectionKey, sectionTitle } = allItems[i]
    const domain = tagDomain(item.name, sectionTitle)
    const progress = `[${i + 1}/${allItems.length}]`

    // Case 1: Tactic items — extract description directly
    if (item.itemType === 'tactic') {
      const content = await extractTactic(item)
      if (content) {
        extractedContents.push({
          name: item.name,
          section: sectionKey,
          content,
          type: mapItemTypeToEnrichmentType(item.itemType, sectionKey),
          domain,
        })
        results.push({
          name: item.name,
          section: sectionKey,
          domain,
          method: 'tactic',
          status: 'extracted',
          reason: 'tactic description',
          contentLength: content.length,
          url: item.url ?? '',
        })
        extractedCount++
        console.log(`${progress} EXTRACTED (tactic): ${item.name} — ${content.length} chars`)
      } else {
        results.push({
          name: item.name,
          section: sectionKey,
          domain,
          method: 'tactic',
          status: 'skipped',
          reason: 'tactic with no description',
          contentLength: 0,
          url: item.url ?? '',
        })
        skippedCount++
        console.log(`${progress} SKIPPED (tactic no desc): ${item.name}`)
      }
      continue
    }

    const url = item.url ?? ''
    const { method, needsAuth } = classifyUrl(url)

    // Case 6: No URL but has contentId + versionId
    if (method === 'no-url') {
      if (item.contentId && item.versionId) {
        console.log(`${progress} Trying Seismic viewer for: ${item.name}`)
        const { content, reason, url: viewerUrl } = await extractNoUrl(page, item)
        if (content) {
          extractedContents.push({
            name: item.name,
            section: sectionKey,
            content,
            type: mapItemTypeToEnrichmentType(item.itemType, sectionKey),
            domain,
          })
          results.push({
            name: item.name,
            section: sectionKey,
            domain,
            method: 'no-url',
            status: 'extracted',
            reason,
            contentLength: content.length,
            url: viewerUrl,
          })
          extractedCount++
          console.log(`${progress} EXTRACTED (no-url/viewer): ${item.name} — ${content.length} chars`)
        } else {
          results.push({
            name: item.name,
            section: sectionKey,
            domain,
            method: 'no-url',
            status: 'failed',
            reason,
            contentLength: 0,
            url: viewerUrl,
          })
          failedCount++
          console.log(`${progress} FAILED (no-url): ${item.name} — ${reason}`)
        }
        await delay(RATE_LIMIT_MS)
      } else {
        // No URL and no contentId — nothing we can do
        results.push({
          name: item.name,
          section: sectionKey,
          domain,
          method: 'no-url',
          status: 'skipped',
          reason: 'no URL and no contentId/versionId',
          contentLength: 0,
          url: '',
        })
        skippedCount++
        console.log(`${progress} SKIPPED (no URL, no contentId): ${item.name}`)
      }
      continue
    }

    // Case 4: YouTube
    if (method === 'youtube') {
      console.log(`${progress} Extracting YouTube: ${item.name}`)
      const { content, reason } = await extractYouTube(page, url)
      if (content) {
        extractedContents.push({
          name: item.name,
          section: sectionKey,
          content,
          type: mapItemTypeToEnrichmentType(item.itemType, sectionKey),
          domain,
        })
        results.push({
          name: item.name,
          section: sectionKey,
          domain,
          method: 'youtube',
          status: 'extracted',
          reason,
          contentLength: content.length,
          url,
        })
        extractedCount++
        console.log(`${progress} EXTRACTED (youtube): ${item.name} — ${content.length} chars`)
      } else {
        results.push({
          name: item.name,
          section: sectionKey,
          domain,
          method: 'youtube',
          status: 'failed',
          reason,
          contentLength: 0,
          url,
        })
        failedCount++
        console.log(`${progress} FAILED (youtube): ${item.name} — ${reason}`)
      }
      await delay(RATE_LIMIT_MS)
      continue
    }

    // Case 2: SalesHub viewer URLs
    if (method === 'viewer') {
      console.log(`${progress} Extracting viewer: ${item.name}`)
      const { content, reason } = await extractViewer(page, url)
      if (content) {
        extractedContents.push({
          name: item.name,
          section: sectionKey,
          content,
          type: mapItemTypeToEnrichmentType(item.itemType, sectionKey),
          domain,
        })
        results.push({
          name: item.name,
          section: sectionKey,
          domain,
          method: 'viewer',
          status: 'extracted',
          reason,
          contentLength: content.length,
          url,
        })
        extractedCount++
        console.log(`${progress} EXTRACTED (viewer): ${item.name} — ${content.length} chars`)
      } else {
        results.push({
          name: item.name,
          section: sectionKey,
          domain,
          method: 'viewer',
          status: 'failed',
          reason,
          contentLength: 0,
          url,
        })
        failedCount++
        console.log(`${progress} FAILED (viewer): ${item.name} — ${reason}`)
      }
      await delay(RATE_LIMIT_MS)
      continue
    }

    // Case 3 + 5: Webpage (redhat.com, docs.google.com, content.redhat.com, catalog.redhat.com,
    //              training-lms.redhat.com, reprint.forrester.com, etc.)
    if (method === 'webpage') {
      console.log(`${progress} Extracting webpage: ${item.name}`)
      const { content, reason } = await extractWebpage(page, url)
      if (content) {
        extractedContents.push({
          name: item.name,
          section: sectionKey,
          content,
          type: mapItemTypeToEnrichmentType(item.itemType, sectionKey),
          domain,
        })
        results.push({
          name: item.name,
          section: sectionKey,
          domain,
          method: 'webpage',
          status: 'extracted',
          reason,
          contentLength: content.length,
          url,
        })
        extractedCount++
        console.log(`${progress} EXTRACTED (webpage): ${item.name} — ${content.length} chars`)
      } else {
        results.push({
          name: item.name,
          section: sectionKey,
          domain,
          method: 'webpage',
          status: needsAuth ? 'skipped' : 'failed',
          reason,
          contentLength: 0,
          url,
        })
        if (needsAuth && reason.includes('auth-required')) {
          skippedCount++
          console.log(`${progress} SKIPPED (auth-required): ${item.name}`)
        } else {
          failedCount++
          console.log(`${progress} FAILED (webpage): ${item.name} — ${reason}`)
        }
      }
      await delay(RATE_LIMIT_MS)
      continue
    }
  }

  // Case 7: Process section textContent
  for (let i = 0; i < sectionTexts.length; i++) {
    const { sectionKey, sectionTitle, textContent } = sectionTexts[i]
    const domain = tagDomain(sectionTitle, sectionTitle)

    extractedContents.push({
      name: `Section: ${sectionTitle}`,
      section: sectionKey,
      content: textContent,
      type: 'content-kit',
      domain,
    })
    results.push({
      name: `Section: ${sectionTitle}`,
      section: sectionKey,
      domain,
      method: 'section-text',
      status: 'extracted',
      reason: 'section textContent',
      contentLength: textContent.length,
      url: '',
    })
    extractedCount++
    console.log(`[section ${i + 1}/${sectionTexts.length}] EXTRACTED (section-text): ${sectionTitle} — ${textContent.length} chars`)
  }

  // ── Close browser ──────────────────────────────────────────────────────────
  await page.close()
  await context.close()
  await browser.close()

  // ── Write extraction results log ───────────────────────────────────────────
  const extractionLog: ExtractionLog = {
    timestamp: new Date().toISOString(),
    productSlug: slug,
    totalItems,
    extracted: extractedCount,
    skipped: skippedCount,
    failed: failedCount,
    results,
  }

  const extractionResultsPath = resolve(productDir, '_extraction-results.json')
  writeJsonAtomic(extractionResultsPath, extractionLog)
  console.log(`\n[extract] Extraction results written to ${extractionResultsPath}`)
  console.log(`[extract] Summary: ${extractedCount} extracted, ${skippedCount} skipped, ${failedCount} failed out of ${totalItems} total`)

  // ── Run enrichment ─────────────────────────────────────────────────────────
  if (extractedContents.length === 0) {
    console.log('[extract] No content extracted — skipping enrichment')
    return
  }

  console.log(`\n[extract] Running enrichment on ${extractedContents.length} documents...`)

  const enrichmentInputs = extractedContents.map(ec => ({
    name: ec.name,
    content: ec.content,
    type: ec.type,
    cloudProvider: undefined,
  }))

  try {
    const enrichment = await enrichProductDocuments(slug, enrichmentInputs)
    const enrichedPath = resolve(productDir, '_enriched.json')
    writeJsonAtomic(enrichedPath, enrichment)
    console.log(`[extract] Enrichment results written to ${enrichedPath}`)
    console.log(`[extract] Enriched: ${enrichment.contentKits.length} content kits, ${enrichment.messagingGuides.length} messaging guides, ${enrichment.battlecards.length} battlecards, ${enrichment.caseStudies.length} case studies, ${enrichment.competitiveReviews.length} competitive reviews`)
  } catch (e: any) {
    console.error(`[extract] Enrichment failed: ${e.message}`)
    console.error('[extract] Extraction results are still saved — re-run enrichment separately')
  }
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

main().catch(e => {
  console.error(`[extract] Fatal error: ${e.message}`)
  process.exit(1)
})
