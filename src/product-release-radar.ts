/**
 * Product Release Radar — Wave 4 Phase 1
 *
 * Scraping + summarization pipeline for Red Hat product release intelligence.
 * Separate from product-intelligence.ts (which handles Q&A chat via BKL-AI16).
 *
 * Pipeline per product:
 *   1. Fetch HTML from public seed URLs + customSources (static fetch; Playwright fallback)
 *   2. Fetch contentHubUrl with RH bearer token (authenticated content hub)
 *   3. Strip HTML to plain text
 *   4. Optionally follow embedded links for deeper context (followLinks=true)
 *   5. Compute content hash for cache dedup
 *   6. Synthesize with Gemini (non-grounded) to extract version/dates/summary
 *   7. Cache to data/cache/product-intel/{slug}-summary.json
 *   8. Fire alert if new version detected
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { resolve } from 'path'
import { createHash } from 'crypto'
import { recordGeminiUsage } from './gemini-cost-tracker.ts'
import { getGeminiToken } from './gemini-auth.ts'
import { getGeminiModel } from './settings-api.ts'

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ProductIntelConfig {
  // BKL-UX-PRODUCT-FOLDER-CONFIG-01: the legacy parent-folder field has been
  // removed from this interface — the parent folder is now sourced from
  // existing AE records via getProductIntelParentFolderId() so there is one
  // source of truth. The field may still exist in the live config file on
  // disk; it's just no longer read by code.
  products: ProductConfig[]
}

export interface ProductConfig {
  slug: string
  displayName: string
  shortName: string
  driveFolder: string | null
  marketingDoc: string | null
  followLinks: boolean
  refreshIntervalHours: number
  customSources: string[]
  seeds: {
    lifecycleUrl: string
    releaseNotesUrl: string
    contentHubUrl: string | null
    atomFeedUrl: string | null
  }
}

export interface ProductSummary {
  slug: string
  displayName: string
  shortName: string
  currentVersion: string | null
  gaDate: string | null
  eolDate: string | null
  summaryText: string
  summaryBullets: string[]
  sources: string[]
  contentHash: string
  synthesizedAt: string
  refreshedAt: string
}

export interface ProductAlert {
  id: string          // "{slug}-{version}"
  slug: string
  version: string
  detectedAt: string
  acknowledged: boolean
  deckAdded: boolean
}

// ── Paths ─────────────────────────────────────────────────────────────────────

const DATA_DIR       = process.env.DATA_DIR       ?? resolve(import.meta.dir, '../data')
const CONFIG_DIR     = process.env.CONFIG_DIR      ?? resolve(import.meta.dir, '../config')
const CACHE_DIR      = resolve(process.env.CACHE_DIR ?? resolve(DATA_DIR, 'cache'), 'product-intel')
const PRODUCT_INTEL_CONFIG_PATH = resolve(CONFIG_DIR, 'product-intel-config.json')
const PRODUCT_ALERTS_PATH       = resolve(CONFIG_DIR, 'product-alerts.json')
const CONTENT_RH_SESSION_PATH   = resolve(process.env.RH_PROFILE_DIR ?? resolve(DATA_DIR, 'rh-profile'), 'content-rh-session.json')

// ── Config ────────────────────────────────────────────────────────────────────

export function loadProductIntelConfig(): ProductIntelConfig {
  try {
    const raw = readFileSync(PRODUCT_INTEL_CONFIG_PATH, 'utf-8')
    return JSON.parse(raw) as ProductIntelConfig
  } catch (e: any) {
    console.warn('[product-release-radar] could not load product config:', e?.message)
    return { products: [] }
  }
}

export function loadProductConfig(): ProductConfig[] {
  return loadProductIntelConfig().products
}

/**
 * BKL-UX-PRODUCT-FOLDER-CONFIG-01: source the product intel Drive parent
 * folder from existing AE records. Returns the first AE's parentFolderId
 * (the first-wins folder enforced by BKL-UX-FOLDER-LOCK-01) or null if no
 * AE has one configured. This replaces the old
 * ProductIntelConfig.driveParentFolderId field — there is one parent
 * folder, sourced from AE records.
 */
export function getProductIntelParentFolderId(): string | null {
  try {
    const aesPath = resolve(CONFIG_DIR, 'aes.json')
    const raw = readFileSync(aesPath, 'utf-8')
    const parsed = JSON.parse(raw) as { aes?: Array<{ parentFolderId?: string | null }> }
    const list = parsed.aes ?? []
    for (const ae of list) {
      const id = (ae.parentFolderId ?? '').toString().trim()
      if (id.length > 0) return id
    }
    return null
  } catch {
    return null
  }
}

export function saveProductConfig(products: ProductConfig[]): void {
  // Preserve root-level fields (e.g. driveParentFolderId) when writing back
  const existing = loadProductIntelConfig()
  mkdirSync(CONFIG_DIR, { recursive: true })
  writeFileSync(PRODUCT_INTEL_CONFIG_PATH, JSON.stringify({ ...existing, products }, null, 2), { mode: 0o600 })
}

// ── RH portal token (for content.redhat.com authenticated pages) ──────────────

async function getRhBearerToken(): Promise<string | null> {
  try {
    // Reuse the existing offline token exchange pattern from rh-auth.ts
    const offlineToken = process.env.REDHAT_OFFLINE_TOKEN
    if (!offlineToken) return null
    const res = await fetch('https://sso.redhat.com/auth/realms/redhat-external/protocol/openid-connect/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type:    'refresh_token',
        client_id:     'rhsm-api',
        refresh_token: offlineToken,
      }),
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) return null
    const data = await res.json() as any
    return data.access_token ?? null
  } catch {
    return null
  }
}

// ── Scraping ──────────────────────────────────────────────────────────────────

/** Fetch a URL with optional RH bearer token. Returns stripped plain text (max 6000 chars). */
export async function scrapeProductPage(url: string, bearerToken?: string | null): Promise<string> {
  let text = ''
  try {
    const headers: Record<string, string> = {
      'User-Agent': 'Mozilla/5.0 (compatible; PAI-Dashboard/1.0)',
    }
    if (bearerToken) {
      headers['Authorization'] = `Bearer ${bearerToken}`
    }
    const res = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(15_000),
    })
    if (res.ok) {
      const html = await res.text()
      text = html
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/\s{2,}/g, ' ')
        .trim()
        .slice(0, 6000)
    }
  } catch (e: any) {
    console.warn(`[product-release-radar] static fetch failed for ${url}:`, e?.message)
  }

  // Playwright fallback if static fetch returned < 200 chars of useful content
  if (text.length < 200) {
    console.log(`[product-release-radar] static fetch thin (${text.length} chars) — trying Playwright for ${url}`)
    try {
      const { chromium } = await import('@playwright/test')
      const browser = await chromium.launch({ headless: true })
      try {
        const page = await browser.newPage()
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20_000 })
        const html = await page.content()
        text = html
          .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
          .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
          .replace(/<[^>]+>/g, ' ')
          .replace(/&nbsp;/g, ' ')
          .replace(/\s{2,}/g, ' ')
          .trim()
          .slice(0, 6000)
        await page.close()
      } finally {
        await browser.close()
      }
    } catch (e: any) {
      console.warn(`[product-release-radar] Playwright fallback failed for ${url}:`, e?.message)
    }
  }

  return text
}

/** Scrape content.redhat.com pages with session cookie restore for employee-gated content. */
async function scrapeContentHubPage(url: string): Promise<string> {
  // Static fetch first
  let text = ''
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PAI-Dashboard/1.0)' },
      signal: AbortSignal.timeout(15_000),
    })
    if (res.ok) {
      const html = await res.text()
      text = html
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/\s{2,}/g, ' ')
        .trim()
        .slice(0, 6000)
    }
  } catch {}

  if (text.length >= 3000) return text

  // Playwright with session cookies
  console.log(`[product-release-radar] content hub static fetch thin (${text.length} chars) — trying Playwright with session cookies for ${url}`)
  try {
    const { chromium } = await import('@playwright/test')
    const browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu-compositing'],
      env: { ...process.env, DISPLAY: process.env.DISPLAY ?? ':99' },
    })
    try {
      const ctx = await browser.newContext()
      // Restore session cookies if available
      if (existsSync(CONTENT_RH_SESSION_PATH)) {
        try {
          const saved = JSON.parse(readFileSync(CONTENT_RH_SESSION_PATH, 'utf-8'))
          if (saved.cookies?.length) {
            const rhCookies = saved.cookies.filter((ck: any) => ck.domain?.includes('.redhat.com'))
            await ctx.addCookies(rhCookies)
            console.log(`[product-release-radar] restored ${rhCookies.length} content.redhat.com cookies`)
          }
        } catch (e: any) {
          console.warn('[product-release-radar] could not restore content.redhat.com cookies:', e?.message)
        }
      }
      const page = await ctx.newPage()
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25_000 })
      await page.waitForTimeout(3000)
      const html = await page.content()
      text = html
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/\s{2,}/g, ' ')
        .trim()
        .slice(0, 6000)
      await page.close()
      await ctx.close()
    } finally {
      await browser.close()
    }
  } catch (e: any) {
    console.warn(`[product-release-radar] Playwright content hub fetch failed for ${url}:`, e?.message)
  }
  return text
}

/**
 * Extract hyperlinks from HTML content and fetch up to maxLinks of them.
 * Used when followLinks=true in product config.
 */
async function followLinksInContent(html: string, baseUrl: string, maxLinks = 5): Promise<string> {
  const linkRegex = /href="(https?:\/\/[^"]+\.redhat\.com[^"]*?)"/gi
  const links: string[] = []
  let match: RegExpExecArray | null
  while ((match = linkRegex.exec(html)) !== null && links.length < maxLinks) {
    const url = match[1]
    // Only follow .redhat.com links (trust boundary)
    if (!links.includes(url) && url !== baseUrl) {
      links.push(url)
    }
  }

  const parts: string[] = []
  for (const link of links) {
    try {
      const text = await scrapeProductPage(link)
      if (text.length > 100) {
        parts.push(`--- Linked resource: ${link} ---\n${text.slice(0, 2000)}`)
      }
    } catch {
      // silent — link following is best-effort
    }
  }
  return parts.join('\n\n')
}

// ── Gemini synthesis (non-grounded) ──────────────────────────────────────────

export async function synthesizeWithGemini(
  productName: string,
  rawContent: string,
): Promise<{
  version: string | null
  gaDate: string | null
  eolDate: string | null
  summary: string
  bullets: string[]
}> {
  const project  = process.env.GOOGLE_CLOUD_PROJECT
  const location = process.env.GOOGLE_CLOUD_LOCATION ?? 'us-central1'
  const model    = getGeminiModel()
  if (!project) throw new Error('GOOGLE_CLOUD_PROJECT not set — required for Gemini via Vertex AI')

  const token = await getGeminiToken()
  const url = `https://${location}-aiplatform.googleapis.com/v1/projects/${project}/locations/${location}/publishers/google/models/${model}:generateContent`

  const systemPrompt = `You are a Red Hat product analyst. Extract structured information from Red Hat product documentation and release notes.
Always respond with valid JSON matching exactly this schema:
{
  "version": "string or null — the current GA version (e.g. '9.5', '4.17', '2.5')",
  "gaDate": "string or null — general availability date in YYYY-MM-DD format if found",
  "eolDate": "string or null — end of life date in YYYY-MM-DD format if found",
  "summary": "string — 2-3 sentences describing current release status and key highlights",
  "bullets": ["array of 3-5 bullet point strings highlighting key features or lifecycle facts"]
}`

  const userPrompt = `Product: ${productName}

Documentation content:
${rawContent}

Extract the current version, GA date, EOL date, a 2-3 sentence summary, and 3-5 bullet points from the above content. If a field cannot be determined, use null.`

  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(60_000),
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
      generationConfig: {
        temperature:     0.3,
        maxOutputTokens: 1024,
        thinkingConfig:  { thinkingBudget: 0 },
      },
    }),
  })

  if (!res.ok) {
    const err = await res.text()
    console.error(`[product-release-radar] Gemini error ${res.status}: ${err.replace(/Bearer\s+\S+/gi, 'Bearer [redacted]').slice(0, 200)}`)
    throw new Error(`Gemini API error ${res.status}`)
  }

  const json = await res.json() as any

  // Record token usage for cost tracking (BKL-M52)
  const usage = json.usageMetadata
  if (usage) {
    recordGeminiUsage({
      timestamp:    new Date().toISOString(),
      callType:     'product-release-radar',
      customerName: productName,
      inputTokens:  usage.promptTokenCount ?? 0,
      outputTokens: usage.candidatesTokenCount ?? 0,
      model,
    })
  }

  const text = json.candidates?.[0]?.content?.parts?.[0]?.text ?? ''

  // Extract JSON from response (may be wrapped in ```json blocks)
  const jsonMatch = text.match(/```json\s*([\s\S]*?)\s*```/) ?? text.match(/(\{[\s\S]*\})/)
  if (!jsonMatch) {
    console.warn('[product-release-radar] Gemini response did not contain valid JSON — returning defaults')
    return { version: null, gaDate: null, eolDate: null, summary: text.slice(0, 300) || 'No summary available.', bullets: [] }
  }

  try {
    const parsed = JSON.parse(jsonMatch[1] ?? jsonMatch[0])
    return {
      version: parsed.version ?? null,
      gaDate:  parsed.gaDate  ?? null,
      eolDate: parsed.eolDate ?? null,
      summary: parsed.summary ?? '',
      bullets: Array.isArray(parsed.bullets) ? parsed.bullets : [],
    }
  } catch {
    return { version: null, gaDate: null, eolDate: null, summary: '', bullets: [] }
  }
}

// ── Cache helpers ─────────────────────────────────────────────────────────────

export function getCachedSummary(slug: string): ProductSummary | null {
  const cachePath = resolve(CACHE_DIR, `${slug}-summary.json`)
  try {
    if (existsSync(cachePath)) {
      return JSON.parse(readFileSync(cachePath, 'utf-8')) as ProductSummary
    }
  } catch {}
  return null
}

export function writeSummaryCache(summary: ProductSummary): void {
  mkdirSync(CACHE_DIR, { recursive: true })
  const cachePath = resolve(CACHE_DIR, `${summary.slug}-summary.json`)
  writeFileSync(cachePath, JSON.stringify(summary, null, 2), { mode: 0o600 })
}

// ── Alert helpers ─────────────────────────────────────────────────────────────

export function getProductAlerts(): ProductAlert[] {
  try {
    if (existsSync(PRODUCT_ALERTS_PATH)) {
      return JSON.parse(readFileSync(PRODUCT_ALERTS_PATH, 'utf-8')) as ProductAlert[]
    }
  } catch {}
  return []
}

function writeProductAlerts(alerts: ProductAlert[]): void {
  mkdirSync(CONFIG_DIR, { recursive: true })
  writeFileSync(PRODUCT_ALERTS_PATH, JSON.stringify(alerts, null, 2), { mode: 0o600 })
}

export function checkAndFireAlert(summary: ProductSummary): void {
  if (!summary.currentVersion) return

  const alertId = `${summary.slug}-${summary.currentVersion}`
  const alerts  = getProductAlerts()

  const existing = alerts.find(a => a.id === alertId)
  if (existing) return  // alert already exists for this version

  const newAlert: ProductAlert = {
    id:           alertId,
    slug:         summary.slug,
    version:      summary.currentVersion,
    detectedAt:   new Date().toISOString(),
    acknowledged: false,
    deckAdded:    false,
  }

  alerts.push(newAlert)
  writeProductAlerts(alerts)
  console.log(`[product-release-radar] new version alert: ${alertId}`)
}

export function acknowledgeAlert(id: string): void {
  const alerts  = getProductAlerts()
  const updated = alerts.map(a => a.id === id ? { ...a, acknowledged: true } : a)
  writeProductAlerts(updated)
}

// ── Core pipeline ─────────────────────────────────────────────────────────────

export async function fetchProductSummary(slug: string): Promise<ProductSummary> {
  const config = loadProductConfig()
  const product = config.find(p => p.slug === slug)
  if (!product) throw new Error(`Unknown product slug: ${slug}`)

  // Get RH bearer token for content hub (best-effort — null if unavailable)
  const rhToken = await getRhBearerToken()

  // Build list of all URLs to scrape:
  //   1. Lifecycle + release notes (public)
  //   2. Content hub URL (authenticated via RH token)
  //   3. Custom sources added by Jason (public)
  const publicUrls = [product.seeds.lifecycleUrl, product.seeds.releaseNotesUrl].filter(Boolean)
  const customUrls = (product.customSources ?? []).filter(Boolean)
  const contentHubUrl = product.seeds.contentHubUrl

  const parts: string[] = []
  const allSources: string[] = []

  // Scrape public URLs
  for (const url of [...publicUrls, ...customUrls]) {
    try {
      let html = ''
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PAI-Dashboard/1.0)' },
        signal: AbortSignal.timeout(15_000),
      })
      if (res.ok) html = await res.text()
      const text = html
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/\s{2,}/g, ' ')
        .trim()
        .slice(0, 6000)

      if (text.length > 100) {
        parts.push(`--- Source: ${url} ---\n${text}`)
        allSources.push(url)
        console.log(`[product-release-radar] ${slug}: scraped ${text.length} chars from ${url}`)

        // Follow links if enabled (best-effort, .redhat.com only)
        if (product.followLinks && html.length > 0) {
          const linked = await followLinksInContent(html, url, 3)
          if (linked) {
            parts.push(linked)
            console.log(`[product-release-radar] ${slug}: followLinks added ${linked.length} chars`)
          }
        }
      } else {
        console.log(`[product-release-radar] ${slug}: thin content (${text.length} chars) from ${url}`)
      }
    } catch (e: any) {
      console.warn(`[product-release-radar] scrape failed for ${url}:`, e?.message)
    }
  }

  // Scrape content hub URL — Playwright always allowed (it's a SPA, static fetch is thin)
  if (contentHubUrl) {
    try {
      const text = await scrapeContentHubPage(contentHubUrl)
      if (text.length > 100) {
        parts.push(`--- Content Hub: ${contentHubUrl} ---\n${text}`)
        allSources.push(contentHubUrl)
        console.log(`[product-release-radar] ${slug}: content hub scraped ${text.length} chars from ${contentHubUrl}`)
      } else {
        console.log(`[product-release-radar] ${slug}: content hub thin (${text.length} chars) — ${contentHubUrl}`)
      }
    } catch (e: any) {
      console.warn(`[product-release-radar] content hub fetch failed for ${contentHubUrl}:`, e?.message)
    }
  }

  const rawContent = parts.join('\n\n').slice(0, 10000)

  // Compute content hash for cache dedup
  const contentHash = createHash('sha256').update(rawContent).digest('hex').slice(0, 16)

  // Check cache — skip synthesis if content unchanged
  const cached = getCachedSummary(slug)
  if (cached && cached.contentHash === contentHash) {
    console.log(`[product-release-radar] ${slug}: content unchanged (hash ${contentHash}) — returning cache`)
    const refreshed = { ...cached, refreshedAt: new Date().toISOString() }
    writeSummaryCache(refreshed)
    return refreshed
  }

  // Synthesize with Gemini
  console.log(`[product-release-radar] ${slug}: synthesizing with Gemini (content hash ${contentHash})`)
  const synthesis = await synthesizeWithGemini(product.displayName, rawContent)

  const now = new Date().toISOString()
  // Auto-detect current version from docsBaseUrl redirect — more reliable than parsing release notes HTML
  let detectedVersion: string | null = synthesis.version
  if (product.seeds.docsBaseUrl) {
    try {
      const versionRes = await fetch(product.seeds.docsBaseUrl, {
        redirect: 'follow',
        signal: AbortSignal.timeout(8000),
      })
      // Final URL after redirect is e.g. .../openshift_container_platform/4.21 or .../red_hat_enterprise_linux/10
      const finalUrl = versionRes.url
      const versionMatch = finalUrl.match(/\/(\d+(?:\.\d+)*)\/?\s*$/)
      if (versionMatch) {
        detectedVersion = versionMatch[1]
        console.log(`[product-release-radar] ${slug}: auto-detected version ${detectedVersion} from docsBaseUrl redirect`)
      }
    } catch (e: any) {
      console.warn(`[product-release-radar] ${slug}: docsBaseUrl version detection failed — ${e?.message}`)
    }
  }

  const summary: ProductSummary = {
    slug:           product.slug,
    displayName:    product.displayName,
    shortName:      product.shortName,
    currentVersion: detectedVersion,
    gaDate:         synthesis.gaDate,
    eolDate:        synthesis.eolDate,
    summaryText:    synthesis.summary,
    summaryBullets: synthesis.bullets,
    sources:        allSources,
    contentHash,
    synthesizedAt:  now,
    refreshedAt:    now,
  }

  writeSummaryCache(summary)
  checkAndFireAlert(summary)

  return summary
}

// ── Bulk operations ───────────────────────────────────────────────────────────

export function getAllProductSummaries(): ProductSummary[] {
  const config = loadProductConfig()
  const summaries: ProductSummary[] = []
  for (const product of config) {
    const cached = getCachedSummary(product.slug)
    if (cached) summaries.push(cached)
  }
  return summaries
}

export async function refreshAllProducts(): Promise<void> {
  const config = loadProductConfig()
  console.log(`[product-release-radar] weekly refresh started — ${config.length} products`)
  for (const product of config) {
    try {
      await fetchProductSummary(product.slug)
      console.log(`[product-release-radar] refreshed: ${product.slug}`)
    } catch (e: any) {
      console.error(`[product-release-radar] failed to refresh ${product.slug}:`, e?.message)
    }
  }
  console.log('[product-release-radar] weekly refresh completed')
}
