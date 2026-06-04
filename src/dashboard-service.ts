/**
 * Dashboard Service — Domain Logic for Dashboard Routes
 *
 * Pure business logic extracted from dashboard-routes.ts.
 * All KPI computation, signal aggregation, territory lookup,
 * morning synthesis, and intelligence gathering live here.
 *
 * Routes file (dashboard-routes.ts) is now a thin HTTP adapter.
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'fs'
import { readdir } from 'fs/promises'
import { resolve } from 'path'
import { google } from 'googleapis'
import type { Customer } from './types.ts'
import { toSlug, readPipelineCache, readLatestBriefCache, readSheetCache } from './cache-layer.ts'
import { computeAllHealthScores, isFreeOrTrial } from './health-score.ts'
import { fetchCases } from './redhat.ts'
import { fetchCustomerEmails } from './customer.ts'
import { makeAuth, GOOGLE_UNIFIED_TOKEN_PATH, fetchCalendar } from './google.ts'
import { getRecentHistory } from './kpi-history.ts'
import { sanitizeErr } from './utils.ts'
import { callGemini } from './gemini-call.ts'
import { buildContactHistory, detectGoneSilent } from './email-extraction.ts'
import { normalizeSettings } from './region-config.ts'
import { isEnterpriseTab, extractEnterpriseAeMap, extractEnterpriseAeAccounts } from './territory-sync.ts'
import { FeatureModuleRegistry } from './feature-module-registry.ts'
import { buildTodaysMeetings } from './lib/todays-meetings.ts'
import { loadGraph } from './lib/intelligence-graph.ts'

// ── Module state ─────────────────────────────────────────────────────────────
let CACHE_DIR = ''
let RH_CASES_CACHE_PATH = ''
let DATA_SOURCES_PATH = ''
let SETTINGS_PATH = ''

// ── POD summary TTL cache ─────────────────────────────────────────────────────
interface PodSummary {
  totalCustomers: number
  totalAEs: number
  openCases: number
  openCasesByProduct: Record<string, number>
  expiringNext90Days: number
  productMix: Record<string, number>
  cachedAt: string
}
let _podSummaryCache: { data: PodSummary; at: number } | null = null
const POD_SUMMARY_TTL = 30_000

// ── Territory cache ───────────────────────────────────────────────────────────
const territoryCacheMap = new Map<string, { data: unknown; cachedAt: number }>()
const TERRITORY_CACHE_TTL_MS = 60 * 60 * 1000
const territoryNamesCacheMap = new Map<string, { data: unknown; cachedAt: number }>()

// ── Constants ─────────────────────────────────────────────────────────────────
const MORNING_SYNTHESIS_TTL_MS = 4 * 60 * 60 * 1000 // 4 hours
const TERRITORY_SHEET_ID_FALLBACK = '1wblku7v2dsnZ-DAlAq2yPkBiWsIxA6EvTcxblhjZwb8'

export function initDashboardService(opts: {
  cacheDir: string
  rhCasesCachePath: string
  dataSourcesPath: string
}): void {
  CACHE_DIR = opts.cacheDir
  RH_CASES_CACHE_PATH = opts.rhCasesCachePath
  DATA_SOURCES_PATH = opts.dataSourcesPath
  SETTINGS_PATH = resolve(DATA_SOURCES_PATH, '..', 'settings.json')
}

// ── Staleness detection (#279) ───────────────────────────────────────────────
/**
 * Check if a priority action text references a date that's already past.
 * Returns true if the action mentions a specific date more than 24h in the past.
 */
export function isActionStale(text: string): boolean {
  const datePatterns = [
    /(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s+\d{4}/gi,
    /\d{1,2}\/\d{1,2}\/\d{4}/g,
    /(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),?\s+(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2}/gi,
  ]

  for (const pattern of datePatterns) {
    const matches = text.match(pattern)
    if (matches) {
      for (const match of matches) {
        try {
          const parsed = new Date(match)
          // 24h grace period: action is stale if date is more than 24h in the past
          if (!isNaN(parsed.getTime()) && parsed.getTime() < Date.now() - 24 * 60 * 60 * 1000) {
            return true
          }
        } catch {
          // Date parsing failed - treat as not stale (conservative)
        }
      }
    }
  }

  return false
}

// ── Product name normalization ─────────────────────────────────────────────────
/**
 * Strips "Red Hat " prefix and everything from the first comma onward.
 * Kept local to avoid a cross-package import from the dashboard UI bundle.
 */
export function stripProductName(raw: string | string[]): string {
  const s = Array.isArray(raw) ? raw[0] ?? '' : raw
  return s.replace(/^Red Hat\s+/i, '').replace(/,.*$/, '').trim()
}

// ── Morning synthesis cache (BKL-AI27) ────────────────────────────────────────

export async function synthesizeMorningSummary(signals: { customer: string; type: string; severity: string; text: string }[]): Promise<string> {
  const synthCachePath = resolve(CACHE_DIR, 'morning-synthesis.json')
  // Check 4h cache
  try {
    if (existsSync(synthCachePath)) {
      const cached = JSON.parse(readFileSync(synthCachePath, 'utf-8'))
      if (cached.synthesis && cached.cachedAt && (Date.now() - new Date(cached.cachedAt).getTime()) < MORNING_SYNTHESIS_TTL_MS) {
        return cached.synthesis as string
      }
    }
  } catch { /* cache miss */ }

  const criticalCount = signals.filter(s => s.severity === 'critical').length
  const highCount     = signals.filter(s => s.severity === 'high').length
  const mediumCount   = signals.filter(s => s.severity === 'medium').length
  const signalLines   = signals.slice(0, 20).map(s => `[${s.severity.toUpperCase()}] ${s.customer}: ${s.text}`).join('\n')

  const systemPrompt = `You are a Red Hat Account Solution Architect's AI assistant. Your job is to synthesize portfolio signals into a crisp daily briefing.

Format your response as markdown with bold headers and bullet points. Keep each bullet to one line. Bold account names. Use exactly this structure:

## Priority Today
1-2 sentences on the single most important thing to address today.

## Actions
- 3 specific actions with **account names** bolded, one per line

## Watch
- 2-3 accounts to watch (renewals, competitive signals, stuck pipeline)`
  const userPrompt   = `Today's portfolio signals (${signals.length} total: ${criticalCount} critical, ${highCount} high, ${mediumCount} medium):\n\n${signalLines}\n\nWrite a structured daily briefing using the markdown format specified. Be specific with account names and actions. No fluff.`

  const result = await callGemini(systemPrompt, userPrompt, {
    callType: 'daily-briefing-synthesis',
    temperature: 0.4,
  })
  const synthesis: string = result.text

  // Cache result
  try {
    writeFileSync(synthCachePath, JSON.stringify({ synthesis, cachedAt: new Date().toISOString() }), { mode: 0o600 })
  } catch { /* non-fatal */ }

  return synthesis
}

// ── Red Hat Intelligence for Morning Brief (BKL-INTEL-204) ───────────────────

interface MeetingNewsItem {
  headline: string
  summary: string
  sourceUrl: string
  relevantCustomer: string
  relevantProduct: string
  publishedDate: string
}

interface ProductRelease {
  product: string
  version: string
  gaDate: string
}

export interface RedHatIntelligence {
  meetingNews: MeetingNewsItem[]
  releases: ProductRelease[]
  events: Array<{
    name: string
    location: string
    date: string
    nearCustomers: string[]
  }>
}

/**
 * Build Red Hat Intelligence section for morning brief.
 * GitHub Issue #204 — Surface 3 of 199-intelligence-surfaces.md
 *
 * Returns null if all subsections are empty (per design spec).
 */
export async function buildRedHatIntelligenceForMorningBrief(
  customers: Array<{ name: string; products?: string[] }>,
  calendarEvents: Array<{ title: string; start: string; customers?: string[] }>,
): Promise<RedHatIntelligence | null> {
  const { readdirSync } = require('fs')

  // ── 1. Meeting News (max 3 items) ──────────────────────────────────────────
  const meetingNews: MeetingNewsItem[] = []

  // Collect customers with meetings today
  const customersWithMeetingsToday = new Set<string>()
  for (const event of calendarEvents) {
    for (const customerName of event.customers ?? []) {
      customersWithMeetingsToday.add(customerName.toLowerCase())
    }
  }

  if (customersWithMeetingsToday.size > 0) {
    try {
      const NEWS_CACHE_DIR = resolve(process.env.CACHE_DIR ?? 'data/cache', 'news')

      if (existsSync(NEWS_CACHE_DIR)) {
        const files = readdirSync(NEWS_CACHE_DIR)

        for (const file of files) {
          if (!file.endsWith('.json')) continue

          const cachePath = resolve(NEWS_CACHE_DIR, file)
          try {
            const cacheData = JSON.parse(readFileSync(cachePath, 'utf-8'))
            const articles = cacheData.articles ?? []

            for (const article of articles) {
              // Check if this article's productTags match any product used by customers with meetings today
              const productTags = article.productTags ?? []

              for (const customer of customers) {
                if (!customersWithMeetingsToday.has(customer.name.toLowerCase())) continue

                const customerProducts = customer.products ?? []
                const matchingProduct = productTags.find((tag: string) =>
                  customerProducts.some(p => p.toLowerCase().includes(tag.toLowerCase()))
                )

                if (matchingProduct) {
                  if (article.sourceUrl && !/^https?:\/\//i.test(article.sourceUrl)) continue
                  meetingNews.push({
                    headline: article.headline,
                    summary: article.summary,
                    sourceUrl: article.sourceUrl,
                    relevantCustomer: customer.name,
                    relevantProduct: matchingProduct,
                    publishedDate: article.publishedDate,
                  })
                  break // Only add once per article
                }
              }

              if (meetingNews.length >= 3) break
            }
          } catch { /* skip invalid cache file */ }

          if (meetingNews.length >= 3) break
        }
      }
    } catch { /* news unavailable — non-fatal */ }
  }

  // If no matches to meeting customers, fall back to top 3 highest-significance news
  if (meetingNews.length === 0) {
    try {
      const NEWS_CACHE_DIR = resolve(process.env.CACHE_DIR ?? 'data/cache', 'news')

      if (existsSync(NEWS_CACHE_DIR)) {
        const allArticles: Array<{
          headline: string
          summary: string
          sourceUrl: string
          publishedDate: string
          significanceScore: number
          productTags?: string[]
        }> = []

        const files = readdirSync(NEWS_CACHE_DIR)
        for (const file of files) {
          if (!file.endsWith('.json')) continue

          const cachePath = resolve(NEWS_CACHE_DIR, file)
          try {
            const cacheData = JSON.parse(readFileSync(cachePath, 'utf-8'))
            allArticles.push(...(cacheData.articles ?? []))
          } catch { /* skip invalid cache */ }
        }

        // Sort by significanceScore desc, take top 3
        allArticles.sort((a, b) => (b.significanceScore ?? 0) - (a.significanceScore ?? 0))
        const top3 = allArticles.slice(0, 3)

        for (const article of top3) {
          meetingNews.push({
            headline: article.headline,
            summary: article.summary,
            sourceUrl: article.sourceUrl,
            relevantCustomer: '', // Generic, not customer-specific
            relevantProduct: article.productTags?.[0] ?? 'Red Hat',
            publishedDate: article.publishedDate,
          })
        }
      }
    } catch { /* news unavailable — non-fatal */ }
  }

  // ── 2. Product Releases (max 5 items, within 30 days) ─────────────────────
  const releases: ProductRelease[] = []

  try {
    const LIFECYCLE_CACHE_PATH = resolve(process.env.CACHE_DIR ?? 'data/cache', 'product-lifecycle.json')

    if (existsSync(LIFECYCLE_CACHE_PATH)) {
      const lifecycleData = JSON.parse(readFileSync(LIFECYCLE_CACHE_PATH, 'utf-8'))
      const products = lifecycleData.products ?? []

      const now = new Date()
      const thirtyDaysFromNow = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000)

      for (const product of products) {
        if (product.nextGA) {
          const gaDate = new Date(product.nextGA)
          if (gaDate >= now && gaDate <= thirtyDaysFromNow) {
            releases.push({
              product: product.product,
              version: product.nextVersion ?? 'TBD',
              gaDate: product.nextGA,
            })
          }
        }
      }

      // Sort by gaDate (soonest first), limit to 5
      releases.sort((a, b) => a.gaDate.localeCompare(b.gaDate))
      releases.splice(5)
    }
  } catch { /* product lifecycle cache unavailable — non-fatal */ }

  // ── 3. Events (stub — no data source yet) ─────────────────────────────────
  const events: Array<{ name: string; location: string; date: string; nearCustomers: string[] }> = []

  // ── Return null if all subsections are empty ──────────────────────────────
  const hasData = meetingNews.length > 0 || releases.length > 0 || events.length > 0
  if (!hasData) return null

  return {
    meetingNews,
    releases,
    events,
  }
}

// ── Territory helpers ─────────────────────────────────────────────────────────

export function getTerritorySheetId(): string {
  try {
    const ds = JSON.parse(readFileSync(DATA_SOURCES_PATH, 'utf-8'))
    return (ds.podConfig?.territorySheetId as string | undefined) ?? TERRITORY_SHEET_ID_FALLBACK
  } catch {
    return TERRITORY_SHEET_ID_FALLBACK
  }
}

export function normalizeTerritoryCustomerName(raw: string): string {
  let name = raw.trim()
  if (!name) return ''
  name = name.replace(/\s*-\s*[A-Z]{2}(\/[A-Z]{2})?$/, '')
  name = name.replace(/\s*\([^)]*\)\s*$/, '')
  const legalSuffixes = [
    /,?\s+L\.?L\.?P\.?$/i, /,?\s+P\.?T\.?Y\.?\s+LTD\.?$/i,
    /,?\s+L\.?P\.?$/i,     /,?\s+INC\.?$/i, /,?\s+LLC\.?$/i,
    /,?\s+LTD\.?$/i,       /,?\s+CORP\.?$/i, /,?\s+CO\.?$/i,
    /,?\s+PLC\.?$/i,
  ]
  for (const re of legalSuffixes) name = name.replace(re, '')
  name = name.trim().replace(/,+$/, '').trim()
  name = name.replace(/^[=+\-@]+/, '')
  name = name.trim()
  name = name.split(/\s+/).map(word => {
    if (/\d/.test(word) || /[a-z]/.test(word) || /\.[a-zA-Z]/.test(word)) return word
    return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()
  }).join(' ')
  return name
}

export function podPrefixFromTabTitle(tabTitle: string): string {
  const t = tabTitle.toLowerCase()
  if (t.includes('northwest') || t.includes('nw')) return 'WEST_COMM_CORP_NORTHWEST'
  if (t.includes('southwest') || t.includes('sw')) return 'WEST_COMM_CORP_SOUTHWEST'
  if (t.includes('north central') || t.includes('nc corp')) return 'WEST_COMM_CORP_NORTH_CENTRAL'
  if (t.includes('south central') || t.includes('sc corp')) return 'WEST_COMM_CORP_SOUTH_CENTRAL'
  return ''
}

/**
 * Derive a pod key from an East-style territory code embedded in an AE cell.
 * East codes: "East_Comm_Corp_Pod1_Terr01" → "EAST_COMM_CORP_POD01"
 * Returns empty string if the code doesn't contain a recognizable pod prefix.
 */
export function podKeyFromTerritoryCode(terrCode: string): string {
  // Strip _Terr\d+ suffix (with or without leading underscore)
  const withoutTerr = terrCode.replace(/_?Terr?\d+$/i, '')
  if (!withoutTerr) return ''
  // Uppercase and normalize
  let key = withoutTerr.toUpperCase().replace(/-/g, '_')
  // Zero-pad single digit after POD: POD1 → POD01
  key = key.replace(/POD(\d)$/, (_, d) => `POD0${d}`)
  return key
}

export function getSheetAndTypeForPod(pod: string): { sheetId: string; regionType: 'commercial' | 'enterprise' } {
  try {
    const raw = JSON.parse(readFileSync(SETTINGS_PATH, 'utf-8'))
    const settings = normalizeSettings(raw)
    for (const region of settings.regions) {
      if (pod in region.pods) {
        const match = region.territorySheetUrl.match(/\/spreadsheets\/d\/([\w-]+)/)
        if (match) return { sheetId: match[1], regionType: region.type ?? 'commercial' }
      }
    }
  } catch {
    // fall through to default
  }
  return { sheetId: getTerritorySheetId(), regionType: 'commercial' }
}

// ── Health Score computation ──────────────────────────────────────────────────

export function computeHealthScores(customers: Customer[]) {
  return computeAllHealthScores(customers, RH_CASES_CACHE_PATH)
}

export function computeSingleHealthScore(customer: Customer) {
  const scores = computeAllHealthScores([customer], RH_CASES_CACHE_PATH)
  if (!scores.length) throw new Error('Could not compute health score')
  return scores[0]
}

// ── Morning Summary aggregation ───────────────────────────────────────────────

export async function buildMorningSummary(customers: Customer[]) {
  if (!customers.length) {
    return { signals: [], summary: 'No customers configured.', customerCount: 0 }
  }

  const healthScores = computeAllHealthScores(customers, RH_CASES_CACHE_PATH)

  const signals: { customer: string; type: string; severity: 'critical' | 'high' | 'medium'; text: string }[] = []

  // Read cached data sources synchronously for expanded signal types
  let allCases: { caseNumber: string; severity: string; summary: string; accountNumber: string; daysOpen: number }[] = []
  try {
    const raw = JSON.parse(readFileSync(RH_CASES_CACHE_PATH, 'utf-8'))
    allCases = raw.cases ?? []
  } catch { /* no cached cases */ }

  const pipelineData = readPipelineCache()
  const pipelineRecords = pipelineData?.records ?? []

  // BKL-G02 signal #8: meeting today with prep needed — fetch calendar
  let calendarEvents: { title: string; start: string; needsPrep: boolean; customers?: string[] }[] = []
  try {
    const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0)
    const todayEnd = new Date(); todayEnd.setHours(23, 59, 59, 999)
    const events = await fetchCalendar(customers)
    calendarEvents = events.filter(ev => {
      const start = new Date(ev.start)
      return start >= todayStart && start <= todayEnd && ev.customers && ev.customers.length > 0
    })
  } catch { /* calendar unavailable — skip prep signals */ }

  // Build customer account-number lookup
  const customerAccountNums = new Map<string, Set<string>>()
  for (const cu of customers) {
    const slug = toSlug(cu.name)
    try {
      const sheetData = JSON.parse(readFileSync(resolve(CACHE_DIR, `${slug}-sheets.json`), 'utf-8'))
      const nums = new Set<string>()
      for (const row of sheetData.rows ?? []) {
        if (row.accountNumber) nums.add(String(row.accountNumber))
      }
      customerAccountNums.set(cu.name, nums)
    } catch { /* no sheet data */ }
  }

  for (const hs of healthScores) {
    // 1. Sev1/Sev2 cases (critical/high)
    const acctNums = customerAccountNums.get(hs.name) ?? new Set()
    const customerCases = allCases.filter(ca => acctNums.has(ca.accountNumber))
    for (const ca of customerCases.filter(ca => ca.severity === '1')) {
      signals.push({ customer: hs.name, type: 'case-sev1', severity: 'critical', text: `Sev1 case #${ca.caseNumber}: ${ca.summary}` })
    }
    for (const ca of customerCases.filter(ca => ca.severity === '2')) {
      signals.push({ customer: hs.name, type: 'case-sev2', severity: 'high', text: `Sev2 case #${ca.caseNumber}: ${ca.summary}` })
    }

    // 2. Subscription expiring <60d (high)
    if (hs.breakdown.subscriptions.score <= 40) {
      signals.push({ customer: hs.name, type: 'renewal', severity: 'high', text: hs.breakdown.subscriptions.signal })
    }

    // 3. Gone-silent contacts (medium)
    if (hs.breakdown.emails.score <= 10) {
      signals.push({ customer: hs.name, type: 'gone-silent', severity: 'medium', text: hs.breakdown.emails.signal })
    }

    // 4. No meetings in >30d (medium)
    if (hs.breakdown.meetings.score <= 10) {
      signals.push({ customer: hs.name, type: 'engagement', severity: 'medium', text: hs.breakdown.meetings.signal })
    }

    // 5. Pipeline deal stuck >30d past close date (high)
    const custPipeline = pipelineRecords.filter(p =>
      p.accountName.toLowerCase().includes(hs.name.toLowerCase()) ||
      hs.name.toLowerCase().includes(p.accountName.toLowerCase())
    )
    const today = new Date()
    for (const opp of custPipeline) {
      if (!opp.closeDate) continue
      // Skip CCSP usage/royalty reports — these are consumption entries, not sales opportunities
      if (/ccsp|royalty|usage.period/i.test(opp.oppName ?? '')) continue
      const closeDate = new Date(opp.closeDate)
      const daysPast = Math.floor((today.getTime() - closeDate.getTime()) / 86_400_000)
      if (daysPast > 30) {
        signals.push({ customer: hs.name, type: 'pipeline-stuck', severity: 'high', text: `Pipeline deal "${opp.oppName}" stuck ${daysPast}d past close date` })
      }
    }

    // 6. Competitor mentions (medium) — from latest brief cache
    const briefCache = readLatestBriefCache(hs.name)
    if (briefCache?.text) {
      const competitorPattern = /competitor|competitive|vmware|aws|azure|microsoft|oracle|ibm/i
      if (competitorPattern.test(briefCache.text)) {
        const match = briefCache.text.match(/competitive[^.]*\./i)?.[0] ?? 'Competitive signals detected in latest brief'
        signals.push({ customer: hs.name, type: 'competitor', severity: 'medium', text: match.slice(0, 120) })
      }
    }

    // 7. Cloud spend anomaly (medium)
    if (hs.breakdown.cloudSpend.score <= 30) {
      signals.push({ customer: hs.name, type: 'cloud-anomaly', severity: 'medium', text: hs.breakdown.cloudSpend.signal })
    }

    // 8. Meeting today with prep needed (BKL-G02)
    const todayMeetings = calendarEvents.filter(ev =>
      ev.needsPrep && (ev.customers ?? []).some(c => c.toLowerCase() === hs.name.toLowerCase())
    )
    for (const ev of todayMeetings) {
      signals.push({ customer: hs.name, type: 'meeting-prep', severity: 'medium', text: `Meeting today: "${ev.title}" — prepare talking points` })
    }
  }

  const severityOrder: Record<string, number> = { critical: 0, high: 1, medium: 2 }
  signals.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity])

  const criticalCount = signals.filter(s => s.severity === 'critical').length
  const attentionCount = signals.filter(s => s.severity !== 'medium').length
  const summary = signals.length === 0
    ? `All clear across ${customers.length} accounts`
    : `${attentionCount} account${attentionCount !== 1 ? 's' : ''} need attention${criticalCount ? `, ${criticalCount} critical` : ''}`

  // Gemini synthesis layer (BKL-AI27) — 4h cached
  let synthesis: string | undefined
  try {
    synthesis = await synthesizeMorningSummary(signals)
  } catch (e: any) {
    console.warn('[dashboard-service] Morning synthesis failed (non-fatal):', e.message)
  }

  // BKL-INTEL-204: Red Hat Intelligence section
  const redHatIntelligence = await buildRedHatIntelligenceForMorningBrief(customers, calendarEvents)

  // #609: Today's Meetings with signal density
  const todaysMeetings = buildTodaysMeetings(
    calendarEvents,
    customers,
    (slug: string) => loadGraph(slug, CACHE_DIR),
  )

  const response: Record<string, unknown> = { signals, summary, customerCount: customers.length }
  if (synthesis) response.synthesis = synthesis
  if (redHatIntelligence) response.redHatIntelligence = redHatIntelligence
  if (todaysMeetings.length > 0) response.todaysMeetings = todaysMeetings
  return response
}

// ── Priority Action computation ───────────────────────────────────────────────

export function computePriorityAction(customer: Customer, customers: Customer[]) {
  const healthScores = computeAllHealthScores([customer], RH_CASES_CACHE_PATH)
  const hs = healthScores[0]
  if (!hs) return { action: null }

  let action: { text: string; severity: 'critical' | 'high' | 'medium'; source: string } | null = null

  if (hs.breakdown.cases.score === 0) {
    action = { text: `Review and escalate: ${hs.breakdown.cases.signal}`, severity: 'critical', source: 'cases' }
  } else if (hs.breakdown.subscriptions.score <= 20) {
    action = { text: `Address renewal: ${hs.breakdown.subscriptions.signal}`, severity: 'high', source: 'subscriptions' }
  } else if (hs.breakdown.meetings.score <= 10) {
    action = { text: `Re-engage: ${hs.breakdown.meetings.signal}`, severity: 'medium', source: 'meetings' }
  } else if (hs.breakdown.pipeline.score <= 30) {
    action = { text: `Pipeline attention: ${hs.breakdown.pipeline.signal}`, severity: 'medium', source: 'pipeline' }
  }

  // BKL-G03: Fallback to brief's "## Priority Action" section when health-score thresholds don't trigger
  if (!action) {
    const briefCache = readLatestBriefCache(customer.name)
    if (briefCache?.text) {
      const match = briefCache.text.match(/^## Priority Action\n(.+)/m)
      if (match) {
        const text = match[1].replace(/^[-*]\s*/, '').replace(/\[Source: [^\]]+\]/g, '').trim()
        if (text && !isActionStale(text)) {
          action = { text, severity: 'medium', source: 'brief' }
        }
      }
    }
  }

  return { action }
}

// ── Stakeholder engagement ────────────────────────────────────────────────────

export async function computeStakeholderEngagement(customer: Customer) {
  const emails = await fetchCustomerEmails(customer)
  const rawEmails = emails.map(e => ({ from: e.from, date: e.date }))
  const history = buildContactHistory(rawEmails)
  const silent = detectGoneSilent(history)
  const silentMap = new Map(silent.map(s => [s.email, s]))

  // Compute per-contact 30/60/90d email counts from raw emails
  const emailsByContact = new Map<string, Date[]>()
  for (const e of rawEmails) {
    const addr = (e.from.match(/<([^>]+)>/)?.[1] ?? e.from).toLowerCase().trim()
    if (!addr.includes('@')) continue
    const arr = emailsByContact.get(addr) ?? []
    arr.push(new Date(e.date))
    emailsByContact.set(addr, arr)
  }
  const now = Date.now()

  const contacts = history.map(h => {
    const s = silentMap.get(h.email)
    const daysSilent = s?.daysSilent ?? Math.floor((now - new Date(h.lastEmailDate).getTime()) / (1000 * 60 * 60 * 24))
    const frequency = daysSilent <= 7 ? 'weekly' : daysSilent <= 30 ? 'monthly' : 'silent'
    const dates = emailsByContact.get(h.email) ?? []
    const d30 = 30 * 86_400_000
    const d60 = 60 * 86_400_000
    const d90 = 90 * 86_400_000
    return {
      name: h.name ?? h.email,
      email: h.email,
      lastContact: h.lastEmailDate,
      frequency,
      daysSilent,
      emailCount30d: dates.filter(d => now - d.getTime() <= d30).length,
      emailCount60d: dates.filter(d => now - d.getTime() <= d60).length,
      emailCount90d: dates.filter(d => now - d.getTime() <= d90).length,
    }
  })

  return { contacts }
}

// ── Temporal delta computation ────────────────────────────────────────────────

export async function computeTemporalDelta(customerName: string) {
  const slug = toSlug(customerName)

  // Async readdir to avoid blocking the event loop
  const files = (await readdir(CACHE_DIR))
    .filter((f) => f.startsWith(slug + '-') && !f.endsWith('-sheets.json') && f.endsWith('.json'))
    .sort()
    .reverse()

  if (files.length < 2) {
    return { hasPrevious: false, message: 'First brief — no prior data to compare' }
  }

  const current = JSON.parse(readFileSync(resolve(CACHE_DIR, files[0]), 'utf-8'))
  const previous = JSON.parse(readFileSync(resolve(CACHE_DIR, files[1]), 'utf-8'))
  const prevDate = files[1].replace(`${slug}-`, '').replace('.json', '')

  const currentText: string = current.text ?? ''
  const previousText: string = previous.text ?? ''

  // Split by ## headings and compare sections
  const parseHeadings = (text: string): Map<string, string> => {
    const map = new Map<string, string>()
    const parts = text.split(/^(## .+)$/m)
    for (let i = 1; i < parts.length; i += 2) {
      const heading = parts[i].replace(/^## /, '').trim()
      const body = (parts[i + 1] ?? '').trim()
      map.set(heading, body)
    }
    return map
  }

  const currentSections = parseHeadings(currentText)
  const previousSections = parseHeadings(previousText)
  const changes: { section: string; type: 'new' | 'changed' | 'removed'; summary: string; details: string[] }[] = []

  // Derive a human-readable summary from change type and detail facts
  const deriveSummary = (type: 'new' | 'changed' | 'removed', details: string[]): string => {
    if (type === 'removed') return 'Section removed'
    if (details.length === 0) {
      return type === 'new' ? 'New section' : 'Minor update'
    }
    const top = details[0].toLowerCase()
    if (/sev\s*[12]|severity\s*[12]|critical.*case/.test(top)) return 'Critical case activity'
    if (/sev\s*[34]|severity\s*[34]|case/.test(top)) return 'Case activity'
    if (/\$[\d,.]+[KMB]?.*(?:pipeline|acv|opport)/i.test(details[0]) || /(?:pipeline|acv|opport).*\$[\d,.]+[KMB]?/i.test(details[0])) return 'Pipeline change'
    if (/\$[\d,.]+[KMB]?/.test(details[0])) return 'Financial update'
    if (/renew|expir/i.test(top)) return 'Renewal activity'
    if (/meeting|scheduled|spoke/i.test(top)) return 'Meeting activity'
    if (/contact|stakeholder/i.test(top)) return 'Stakeholder change'
    return details.length === 1 ? '1 new item' : `${details.length} new items`
  }

  // Extract key facts from section text for content-level diffs
  const extractFacts = (text: string): string[] => {
    const facts: string[] = []
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean)
    for (const line of lines) {
      const clean = line.replace(/^[-*•]\s*/, '').replace(/^\d+\.\s*/, '').replace(/\*{1,2}/g, '')
      if (!clean || clean === '---') continue
      if (clean.match(/(?:case|sev\s*\d|severity\s*\d).{0,80}/i)) { facts.push(clean); continue }
      if (clean.match(/\$[\d,.]+[KMB]?/i)) { facts.push(clean); continue }
      if (clean.match(/(?:contact|meeting|spoke|scheduled|attendee|stakeholder).{0,60}/i)) { facts.push(clean); continue }
      if (clean.match(/(?:renew|expir|pipeline|opportunity|close date|forecast).{0,60}/i)) { facts.push(clean); continue }
      if (line.match(/^[-*•]/) && clean.length > 10) { facts.push(clean) }
    }
    return facts.slice(0, 5)
  }

  // Check for new or changed sections
  for (const [heading, body] of currentSections) {
    const prevBody = previousSections.get(heading)
    if (prevBody === undefined) {
      const details = extractFacts(body)
      changes.push({ section: heading, type: 'new', summary: deriveSummary('new', details), details })
    } else if (prevBody !== body) {
      const prevLines = new Set(prevBody.split('\n').map(l => l.trim()).filter(Boolean))
      const newLines = body.split('\n').map(l => l.trim()).filter(Boolean).filter(l => !prevLines.has(l))
      const details = extractFacts(newLines.join('\n'))
      if (details.length === 0 && newLines.length > 0) {
        const fallbacks = newLines
          .filter(l => l.length > 5)
          .slice(0, 2)
          .map(l => l.replace(/^[-*•]\s*/, '').replace(/\*{1,2}/g, ''))
        details.push(...fallbacks)
      }
      changes.push({ section: heading, type: 'changed', summary: deriveSummary('changed', details), details })
    }
  }

  // Check for removed sections
  for (const heading of previousSections.keys()) {
    if (!currentSections.has(heading)) {
      changes.push({ section: heading, type: 'removed', summary: deriveSummary('removed', []), details: [] })
    }
  }

  return { hasPrevious: true, lastBriefDate: prevDate, changes }
}

// ── Data freshness dashboard ──────────────────────────────────────────────────

// GitHub Issue #406 — Data source transparency: show WHERE data comes from
const SOURCE_DESCRIPTIONS: Record<string, string> = {
  'ccsp': 'Google Drive CSV (L3 sync)',
  'pipeline': 'Google Drive CSV (L3 sync)',
  'subscriptions': 'Google Sheets (SF Bookings)',
  'cases': 'Red Hat Portal (browser scraper)',
  'news-radar': 'Web search (Gemini-powered)',
  'rh-rss': 'RSS/Atom feeds (27 configured)',
  'rh-events': 'Email newsletter parser',
  'product-intel': 'redhat.com releases API',
  'product-lifecycle': 'Red Hat product lifecycle data',
  'value-maps': 'Built-in slide deck (30 products)',
  'tech-stack': 'Gemini analysis of customer signals',
  'cloud-marketplace': 'Partner catalog newsletter',
  'emails': 'Gmail API (OAuth)',
  'intelligence': 'Gemini analysis (on-demand)',
  'account-plan': 'Gemini analysis (on-demand)',
  'customer-docs': 'Google Drive documents',
  'customer-product-intel': 'Product + customer signal synthesis',
  'playbook': 'Gemini-generated engagement plan',
  'campaigns': 'Gemini-generated email campaigns',
  'meeting-prep': 'Gemini-generated meeting prep',
  'tools': 'Built-in business value tools',
}

export function computeFreshnessStatus() {
  const allStatus = FeatureModuleRegistry.getStatus()
  const allModules = FeatureModuleRegistry.list()

  const calculateStatus = (lastChecked: string | null, intervalMs: number | null, recordCount: number | null): 'fresh' | 'stale' | 'critical' | 'unknown' => {
    if (!intervalMs) {
      if (lastChecked) return 'fresh'
      if (recordCount && recordCount > 0) return 'fresh'
      return 'unknown'
    }
    if (!lastChecked) return 'critical'
    const ageMs = Date.now() - new Date(lastChecked).getTime()
    if (ageMs < intervalMs) return 'fresh'
    if (ageMs < intervalMs * 2) return 'stale'
    return 'critical'
  }

  const sources = allModules
    .filter((m: any) => m.displayName !== m.name)
    .map((module: any) => {
      const status: any = allStatus[module.name] ?? { lastRun: null, lastSuccess: null, lastError: null, state: 'idle', recordCount: null }
      const lastChecked = status.lastChecked ?? status.lastRun ?? status.lastSuccess
      return {
        name: module.name,
        displayName: module.displayName ?? module.name,
        sourceDescription: SOURCE_DESCRIPTIONS[module.name] ?? null,
        lastChecked,
        lastChanged: status.lastChanged ?? lastChecked,
        recordCount: status.recordCount ?? null,
        intervalMinutes: module.refreshInterval ? Math.round(module.refreshInterval / 60_000) : null,
        refreshEndpoint: module.refreshEndpoint ?? null,
        status: status.state === 'error' || status.state === 'failed' ? 'critical' as const : calculateStatus(lastChecked, module.refreshInterval, status.recordCount),
        state: status.state,
        error: status.lastError,
      }
    })

  return { sources }
}

// ── KPI history ───────────────────────────────────────────────────────────────

export function computeKpiHistory(days: number) {
  const validDays = Math.min(Math.max(days, 1), 90)
  const history = getRecentHistory(validDays)
  return { snapshots: history }
}

// ── Aggregated KPIs ───────────────────────────────────────────────────────────

export async function computeAggregatedKPIs(customers: Customer[]) {
  // Fetch cases and calendar in parallel
  const [allCases, calendarEvents] = await Promise.all([
    fetchCases().catch(() => []),
    fetchCalendar(customers).catch(() => []),
  ])

  // BKL-UI-02: apply the same attribution filter as KPICasesModal (BKL-CASES-01)
  // so the KPI card count matches the modal body count. ADR-018: inactive filtered
  // at load time in server-state.ts; cases with no matching account are excluded.
  const attributedCases = allCases.filter((ca) =>
    customers.some((cu) =>
      (cu.accountNumbers ?? []).map(String).includes(String(ca.accountNumber))
    )
  )
  const sev1Count = attributedCases.filter((ca) => ca.severity === '1').length

  // Count meetings
  const today = new Date().toDateString()
  const now = new Date()
  const dayOfWeek = now.getDay()
  const monday = new Date(now)
  monday.setDate(now.getDate() - (dayOfWeek === 0 ? 6 : dayOfWeek - 1))
  monday.setHours(0, 0, 0, 0)
  const sunday = new Date(monday)
  sunday.setDate(monday.getDate() + 7)

  // Only count customer-matched meetings (consistent with CalendarStrip display)
  const customerEvents = calendarEvents.filter((ev) => ev.customers && ev.customers.length > 0)
  const meetingsToday = customerEvents.filter(
    (ev) => new Date(ev.start).toDateString() === today
  ).length
  const meetingsThisWeek = customerEvents.filter((ev) => {
    const d = new Date(ev.start)
    return d >= monday && d < sunday
  }).length

  // Aggregate products from cached sheet data
  const allProductDescriptions = new Set<string>()
  let totalLicenses = 0
  let renewalsWithin90Days = 0
  const nowMs = Date.now()
  for (const customer of customers) {
    const cached = readSheetCache(customer.name)
    if (cached) {
      for (const p of cached.rows) {
        allProductDescriptions.add(p.productDescription)
        totalLicenses += p.quantity
        if (p.endDate) {
          // BKL-M45: exclude free/trial from renewalsWithin90Days
          if (isFreeOrTrial(p)) continue
          const daysLeft = Math.ceil((new Date(p.endDate).getTime() - nowMs) / 86_400_000)
          if (daysLeft <= 90) renewalsWithin90Days++
        }
      }
    }
  }

  return {
    openCasesTotal: attributedCases.length,
    sev1Count,
    meetingsToday,
    meetingsThisWeek,
    renewalsWithin90Days,
    totalAccounts: customers.length,
    totalProducts: allProductDescriptions.size,
    totalLicenses,
  }
}

// ── POD summary ───────────────────────────────────────────────────────────────

export function computePodSummary(customers: Customer[], aes: any[]) {
  // Serve from 30s TTL cache
  if (_podSummaryCache && Date.now() - _podSummaryCache.at < POD_SUMMARY_TTL) {
    return _podSummaryCache.data
  }

  // Deduplicate customers by lowercased name (same customer may appear under 2 AEs)
  const seenNames = new Set<string>()
  const uniqueCustomers = customers.filter(cu => {
    const key = cu.name.toLowerCase()
    if (seenNames.has(key)) return false
    seenNames.add(key)
    return true
  })

  // Read cases from disk cache (same pattern as /api/morning-summary)
  let rawCases: Array<{ severity: string; product?: string; status?: string }> = []
  try {
    const casesRaw = JSON.parse(readFileSync(RH_CASES_CACHE_PATH, 'utf-8'))
    rawCases = casesRaw.cases ?? []
  } catch { /* no cached cases */ }

  // Only count open cases (exclude closed/resolved — same filter as fetchCases)
  const openCases = rawCases.filter(ca => {
    const s = (ca.status ?? '').toLowerCase()
    return !s.includes('closed') && !s.includes('resolved')
  })

  const openCasesByProduct: Record<string, number> = {}
  for (const ca of openCases) {
    const prod = ca.product ? stripProductName(ca.product) : 'Unknown'
    openCasesByProduct[prod] = (openCasesByProduct[prod] ?? 0) + 1
  }

  // Walk per-customer sheet caches for subscription metrics
  const nowMs = Date.now()
  let expiringNext90Days = 0
  const productMix: Record<string, number> = {}

  for (const cu of uniqueCustomers) {
    const cached = readSheetCache(cu.name)
    if (!cached) continue
    const productsForCustomer = new Set<string>()
    for (const row of cached.rows) {
      const stripped = stripProductName(row.productDescription)
      productsForCustomer.add(stripped)
      if (row.endDate) {
        const daysLeft = Math.ceil((new Date(row.endDate).getTime() - nowMs) / 86_400_000)
        if (daysLeft >= 0 && daysLeft <= 90) expiringNext90Days++
      }
    }
    for (const prod of productsForCustomer) {
      productMix[prod] = (productMix[prod] ?? 0) + 1
    }
  }

  const data: PodSummary = {
    totalCustomers: uniqueCustomers.length,
    totalAEs: aes.length,
    openCases: openCases.length,
    openCasesByProduct,
    expiringNext90Days,
    productMix,
    cachedAt: new Date().toISOString(),
  }

  _podSummaryCache = { data, at: Date.now() }
  return data
}

// ── Territory lookup ──────────────────────────────────────────────────────────

export async function lookupTerritoryNames(pod: string, forceRefresh: boolean = false) {
  if (!pod || !/^[A-Z0-9_]+$/.test(pod)) {
    throw new Error('Invalid pod format')
  }

  if (!forceRefresh) {
    const cached = territoryNamesCacheMap.get(pod)
    if (cached && Date.now() - cached.cachedAt < TERRITORY_CACHE_TTL_MS) {
      return cached.data
    }
  }

  const auth = makeAuth(GOOGLE_UNIFIED_TOKEN_PATH)
  if (!auth) throw new Error('Google auth not configured')

  const sheetsClient = google.sheets({ version: 'v4', auth })
  const { sheetId, regionType } = getSheetAndTypeForPod(pod)
  const meta = await sheetsClient.spreadsheets.get({ spreadsheetId: sheetId })
  const tabNames = (meta.data.sheets ?? [])
    .filter(s => !s.properties?.hidden)
    .map(s => s.properties?.title ?? '')

  const territories: { num: string; aeName: string }[] = []

  if (regionType === 'enterprise') {
    // Enterprise path: find the tab detected by isEnterpriseTab, extract AE map
    for (const tabTitle of tabNames) {
      const probeResp = await sheetsClient.spreadsheets.values.get({
        spreadsheetId: sheetId,
        range: `'${tabTitle}'!A1:Z25`,
      })
      const probeRows: string[][] = (probeResp.data.values ?? []).map((r: any[]) =>
        r.map((cell: any) => String(cell ?? '').trim())
      )
      const detected = isEnterpriseTab(probeRows)
      if (!detected) continue

      // Full fetch for this enterprise tab
      const fullResp = await sheetsClient.spreadsheets.values.get({
        spreadsheetId: sheetId,
        range: `'${tabTitle}'!A1:Z200`,
      })
      const fullRows: string[][] = (fullResp.data.values ?? []).map((r: any[]) =>
        r.map((cell: any) => String(cell ?? '').trim())
      )
      const aeTerrMap = extractEnterpriseAeMap(fullRows)
      for (const [aeName, terrCodes] of Object.entries(aeTerrMap)) {
        for (const terrCode of terrCodes) {
          const m = terrCode.match(/Terr(\d+)/i)
          if (!m) continue
          const num = m[1].padStart(2, '0')
          territories.push({ num, aeName })
        }
      }
      break // Only one enterprise tab expected
    }
  } else {
    // Commercial path: scan ALL tabs for "Account Executive" header,
    // then derive pod key from territory code in the AE cell.
    for (const tabTitle of tabNames) {
      if (tabTitle.toLowerCase().includes('accounts a')) continue

      const probeResp = await sheetsClient.spreadsheets.values.get({
        spreadsheetId: sheetId,
        range: `'${tabTitle}'!A1:Z10`,
      })
      const probeRows: string[][] = (probeResp.data.values ?? []).map((r: any[]) =>
        r.map((cell: any) => String(cell ?? '').trim())
      )

      // Find "Account Executive" header row
      let headerRowIdx = -1
      for (let r = 0; r < probeRows.length; r++) {
        if (probeRows[r].some(cell => /^account executive$/i.test(cell))) { headerRowIdx = r; break }
      }
      if (headerRowIdx === -1) continue

      const aeNameRow = probeRows[headerRowIdx + 1] ?? []
      const headerRow = probeRows[headerRowIdx] ?? []
      const aeCols = headerRow
        .map((cell, idx) => ({ cell, idx }))
        .filter(({ cell }) => /^account executive$/i.test(cell))
        .map(({ idx }) => idx)

      // Determine pod key for this tab — try territory-code derivation first, fall back to tab-title keywords
      let tabPodKey = ''
      for (const col of aeCols) {
        const aeCell = aeNameRow[col] ?? ''
        if (!aeCell) continue
        const terrCodeMatch = aeCell.match(/([A-Za-z][A-Za-z0-9_]+_Terr?\d+)/i)
        if (terrCodeMatch) {
          tabPodKey = podKeyFromTerritoryCode(terrCodeMatch[1])
          if (tabPodKey) break
        }
      }
      if (!tabPodKey) {
        tabPodKey = podPrefixFromTabTitle(tabTitle)
      }

      if (tabPodKey !== pod) continue

      // Full fetch for this tab
      const resp = await sheetsClient.spreadsheets.values.get({
        spreadsheetId: sheetId,
        range: `'${tabTitle}'!A1:Z60`,
      })
      const rows: string[][] = (resp.data.values ?? []).map((r: any[]) =>
        r.map((c: any) => String(c ?? '').trim())
      )

      let fullHeaderIdx = -1
      for (let r = 0; r < rows.length; r++) {
        if (rows[r].some(cell => /^account executive$/i.test(cell))) { fullHeaderIdx = r; break }
      }
      if (fullHeaderIdx === -1) continue

      const fullAeNameRow = rows[fullHeaderIdx + 1] ?? []
      const fullHeaderRow = rows[fullHeaderIdx] ?? []
      const fullAeCols = fullHeaderRow
        .map((cell, idx) => ({ cell, idx }))
        .filter(({ cell }) => /^account executive$/i.test(cell))
        .map(({ idx }) => idx)

      for (const col of fullAeCols) {
        const aeCell = fullAeNameRow[col] ?? ''
        if (!aeCell) continue
        let aeName = aeCell; let terrCode = ''
        if (aeCell.includes('\n')) {
          const parts = aeCell.split('\n'); aeName = parts[0].trim(); terrCode = parts[1]?.trim() ?? ''
        } else {
          const terrMatch = aeCell.match(/Terr(\d+)/i)
          if (terrMatch) { aeName = aeCell.replace(/\s*Terr\d+\s*/i, '').trim(); terrCode = terrMatch[0] }
        }
        if (!aeName || /^TBH$/i.test(aeName.trim())) continue
        const terrNumMatch = terrCode.match(/Terr(\d+)/i)
        if (!terrNumMatch) continue
        const num = terrNumMatch[1].padStart(2, '0')
        territories.push({ num, aeName })
      }
      break
    }
  }

  territories.sort((a, b) => a.num.localeCompare(b.num))
  console.log(`[territory-names] ${pod}: ${territories.length} territories`)
  const result = { territories }
  territoryNamesCacheMap.set(pod, { data: result, cachedAt: Date.now() })
  return result
}

export async function lookupTerritory(requestedTerritory: string, forceRefresh: boolean = false) {
  if (!requestedTerritory || !/^[A-Z0-9_]+$/.test(requestedTerritory)) {
    throw new Error('Invalid territory format')
  }

  if (!forceRefresh) {
    const cached = territoryCacheMap.get(requestedTerritory)
    if (cached && Date.now() - cached.cachedAt < TERRITORY_CACHE_TTL_MS) {
      return cached.data
    }
  }

  const auth = makeAuth(GOOGLE_UNIFIED_TOKEN_PATH)
  if (!auth) throw new Error('Google auth not configured')

  const sheetsClient = google.sheets({ version: 'v4', auth })

  // Derive the pod key from the territory string (strip _TERR\d+ suffix)
  const podFromTerritory = requestedTerritory.replace(/_TERR\d+$/, '')
  const { sheetId, regionType } = getSheetAndTypeForPod(podFromTerritory)

  // Get all tab names
  const meta = await sheetsClient.spreadsheets.get({ spreadsheetId: sheetId })
  const tabNames = (meta.data.sheets ?? []).map(s => s.properties?.title ?? '')

  if (regionType === 'enterprise') {
    // Enterprise path: find the enterprise tab, extract AE map, match by terr number
    const terrNumMatch = requestedTerritory.match(/_TERR(\d+)$/)
    if (!terrNumMatch) throw new Error(`Cannot parse territory number from ${requestedTerritory}`)
    const requestedNum = terrNumMatch[1].padStart(2, '0')

    for (const tabTitle of tabNames) {
      const probeResp = await sheetsClient.spreadsheets.values.get({
        spreadsheetId: sheetId,
        range: `'${tabTitle}'!A1:Z25`,
      })
      const probeRows: string[][] = (probeResp.data.values ?? []).map((r: any[]) =>
        r.map((cell: any) => String(cell ?? '').trim())
      )
      if (!isEnterpriseTab(probeRows)) continue

      const fullResp = await sheetsClient.spreadsheets.values.get({
        spreadsheetId: sheetId,
        range: `'${tabTitle}'!A1:Z200`,
      })
      const fullRows: string[][] = (fullResp.data.values ?? []).map((r: any[]) =>
        r.map((cell: any) => String(cell ?? '').trim())
      )
      const aeTerrMap = extractEnterpriseAeMap(fullRows)

      for (const [aeName, terrCodes] of Object.entries(aeTerrMap)) {
        // Match by territory number (handles both "Ter01" and "Terr01" formats)
        const match = terrCodes.find(tc => {
          const m = tc.match(/(\d{1,2})/)
          return m && m[1].padStart(2, '0') === requestedNum
        })
        if (!match) continue
        // Extract accounts for this AE from the enterprise sheet column (BKL-UX92)
        const accounts = extractEnterpriseAeAccounts(fullRows, aeName)
        console.log(`[territory-lookup] ${requestedTerritory}: ${aeName} (enterprise, ${accounts.length} accounts)`)
        const lookupResult = { aeName, accounts, tableauTerritory: requestedTerritory }
        territoryCacheMap.set(requestedTerritory, { data: lookupResult, cachedAt: Date.now() })
        return lookupResult
      }
      break // Only one enterprise tab expected
    }

    throw new Error(`Territory ${requestedTerritory} not found in enterprise sheet`)
  }

  // Commercial path: scan ALL tabs (mirrors territory-names commercial path).
  for (const tabTitle of tabNames) {
    if (tabTitle.toLowerCase().includes('accounts a')) continue

    // Probe A1:Z10 for "Account Executive" header and derive pod key
    const probeResp = await sheetsClient.spreadsheets.values.get({
      spreadsheetId: sheetId,
      range: `'${tabTitle}'!A1:Z10`,
    })
    const probeRows: string[][] = (probeResp.data.values ?? []).map((r: any[]) =>
      r.map((cell: any) => String(cell ?? '').trim())
    )

    let probeHeaderIdx = -1
    for (let r = 0; r < probeRows.length; r++) {
      if (probeRows[r].some(cell => /^account executive$/i.test(cell))) { probeHeaderIdx = r; break }
    }
    if (probeHeaderIdx === -1) continue

    const probeAeNameRow = probeRows[probeHeaderIdx + 1] ?? []
    const probeHeaderRow = probeRows[probeHeaderIdx] ?? []
    const probeAeCols = probeHeaderRow
      .map((cell, idx) => ({ cell, idx }))
      .filter(({ cell }) => /^account executive$/i.test(cell))
      .map(({ idx }) => idx)

    // Derive pod key — try territory-code derivation first (East), fall back to tab-title keywords (West)
    let tabPodKey = ''
    for (const col of probeAeCols) {
      const aeCell = probeAeNameRow[col] ?? ''
      if (!aeCell) continue
      const terrCodeMatch = aeCell.match(/([A-Za-z][A-Za-z0-9_]+_Terr?\d+)/i)
      if (terrCodeMatch) {
        tabPodKey = podKeyFromTerritoryCode(terrCodeMatch[1])
        if (tabPodKey) break
      }
    }
    if (!tabPodKey) tabPodKey = podPrefixFromTabTitle(tabTitle)
    if (!tabPodKey || tabPodKey !== podFromTerritory) continue

    // Matched tab — full fetch
    const resp = await sheetsClient.spreadsheets.values.get({
      spreadsheetId: sheetId,
      range: `'${tabTitle}'!A1:Z60`,
    })
    const rows: string[][] = (resp.data.values ?? []).map((r: any[]) =>
      r.map((c: any) => String(c ?? '').trim())
    )

    // Find "Account Executive" header row
    let headerRowIdx = -1
    for (let r = 0; r < rows.length; r++) {
      if (rows[r].some(cell => /^account executive$/i.test(cell))) { headerRowIdx = r; break }
    }
    if (headerRowIdx === -1) continue

    const aeNameRowIdx = headerRowIdx + 1
    const accountsStartIdx = aeNameRowIdx + 1
    const headerRow = rows[headerRowIdx] ?? []
    const aeNameRow = rows[aeNameRowIdx] ?? []

    const aeCols = headerRow
      .map((cell, idx) => ({ cell, idx }))
      .filter(({ cell }) => /^account executive$/i.test(cell))
      .map(({ idx }) => idx)

    for (const col of aeCols) {
      const aeCell = aeNameRow[col] ?? ''
      if (!aeCell) continue

      let aeName = aeCell
      let terrCode = ''
      if (aeCell.includes('\n')) {
        const parts = aeCell.split('\n')
        aeName = parts[0].trim()
        terrCode = parts[1]?.trim() ?? ''
      } else {
        const terrMatch = aeCell.match(/\bTerr(\d+)\b/i)
        if (terrMatch) {
          aeName = aeCell.replace(/\s*Terr\d+\s*/i, '').trim()
          terrCode = terrMatch[0]
        }
      }

      if (!aeName || /^TBH$/i.test(aeName.trim())) continue

      const terrNumMatch = terrCode.match(/Terr(\d+)/i)
      if (!terrNumMatch) continue
      const terrNum: string = terrNumMatch[1].padStart(2, '0')
      const tableauTerritory: string = `${tabPodKey}_TERR${terrNum}`

      if (tableauTerritory !== requestedTerritory) continue

      // Found the matching AE — extract accounts
      const accounts: string[] = []
      for (let r = accountsStartIdx; r < rows.length; r++) {
        const cell = rows[r][col] ?? ''
        if (!cell) continue
        if (/^\d{1,3}$/.test(cell)) break
        if (/^Account\s+S[Aa]/i.test(cell)) break
        if (/^(Support|Partner Sales|\d+ of \d+)$/i.test(cell)) break
        if (/^(Openshift|Ansible|Rhel|Ai)\s+(SSP|SSA)/i.test(cell)) break
        const normalized = normalizeTerritoryCustomerName(cell)
        if (normalized) accounts.push(normalized)
      }

      console.log(`[territory-lookup] ${requestedTerritory}: ${aeName}, ${accounts.length} accounts`)
      const lookupResult = { aeName, accounts, tableauTerritory }
      territoryCacheMap.set(requestedTerritory, { data: lookupResult, cachedAt: Date.now() })
      return lookupResult
    }
  }

  throw new Error(`Territory ${requestedTerritory} not found in sheet`)
}
