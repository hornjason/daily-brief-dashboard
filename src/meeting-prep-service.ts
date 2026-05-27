/**
 * Meeting Prep Service — Domain Logic for Meeting Prep Generation
 *
 * Pure business logic extracted from meeting-prep-routes.ts.
 * All Gemini prompts, signal processing, intelligence gathering,
 * attendee research, and meeting prep orchestration live here.
 *
 * Routes file (meeting-prep-routes.ts) is now a thin HTTP adapter.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { resolve } from 'path'
import { Readable } from 'stream'
import { google } from 'googleapis'
import { callGemini } from './gemini-call.ts'
import { validateAndRetry, formatFailureFeedback, type QualityScorecard } from './gemini-quality-gate.ts'
import { meetingPrepValidator } from './quality-validators/meeting-prep-validator.ts'
import { driveClient } from './lib/drive-client.ts'
import { findCustomerDriveFolder } from './lib/customer-folder.ts'
import { toSlug } from './cache-layer.ts'
import { makeAuth, GOOGLE_UNIFIED_TOKEN_PATH } from './google.ts'
import { assembleMeetingPrep } from './calendar-extraction.ts'
import { loadCustomerSignals } from './lib/signal-loader.ts'
import { FeatureModuleRegistry } from './feature-module-registry.ts'
import { getAccountTeam, toPromptContext } from './account-team.ts'
import { getValueMap } from './value-map-loader.ts'
import { fetchCases } from './redhat.ts'
import type { Customer, CalendarEvent, SupportCase, CustomerSubscription } from './types.ts'
import { writeJsonAtomic } from './lib/atomic-write.ts'
import { readProductLifecycleCache } from './product-lifecycle.ts'
import { getAllProductSummaries } from './product-release-radar.ts'
import { getCachedCustomerProductIntel } from './customer-product-intel.ts'
import { getTdpByName, getSalesPlayByName } from './lib/saleshub-knowledge-loader.ts'
// expansion-opportunities removed from meeting prep (#426) — data feeds into enrichment context
import { runIntelligencePipeline, getJobStatus } from './account-intelligence.ts'
import { readCCSPCache } from './cache-layer.ts'
import { generateMeetingPrepHTML } from './meeting-prep-html-template.ts'
import { buildEnrichmentPromptContext, buildSalesAlignmentBlock } from './meeting-prep-enrichment.ts'
import { readPlaybook } from './playbook-generator.ts'
import { CACHE_DIR, DATA_CONFIG_DIR } from './lib/paths.ts'
import {
  extractActionItems,
  findPreviousPrepForSeries,
  buildCarryForwardContext,
  type PrepHistoryWithSeries,
} from './recurring-meeting-intel.ts'

// ── Config ────────────────────────────────────────────────────────────────────

const CONFIG_DIR = DATA_CONFIG_DIR

// ── Types ─────────────────────────────────────────────────────────────────────

export interface MeetingPrepRequest {
  meetingTitle: string
  meetingStart: string
  attendees: string[]
  attendeeDetails?: Array<{ email: string; displayName?: string; linkedinUrl?: string }>
  recurringEventId?: string // #269: for series tracking
  context?: {
    objective?: string
    productFocus?: string[]
    notes?: string
    driveDocUrls?: string[]
  }
}

export interface MeetingPrepResult {
  docUrl: string
  title: string
  generatedAt: string
}

export interface PrepHistoryEntry {
  meetingTitle: string
  meetingStart: string
  docUrl: string
  title: string
  generatedAt: string
  customerName?: string
  recurringEventId?: string // #269: series tracking
  actionItems?: string[]    // #269: extracted for carry-forward
}

interface PartnerConfig {
  name: string
  aliases: string[]
  domain: string
  partnershipLevel: string
  specializations: string[]
  geo: string
  country: string
  catalogUrl?: string
  sourceUrl?: string
}

interface ProductRoadmapEntry {
  product: string
  displayName: string
  nextVersion: string
  expectedDate: string
  highlights: string[]
  source: string
}

// ── Partner & Product Config Loaders ──────────────────────────────────────────

function loadProductRoadmap(): ProductRoadmapEntry[] {
  const roadmapPath = resolve(CONFIG_DIR, 'product-roadmap.json')
  if (!existsSync(roadmapPath)) return []
  try {
    const data = JSON.parse(readFileSync(roadmapPath, 'utf-8'))
    return data.releases ?? []
  } catch { return [] }
}

function loadPartnerConfig(): PartnerConfig[] {
  const configPath = resolve(CONFIG_DIR, 'partners.json')
  if (!existsSync(configPath)) return []
  try { return JSON.parse(readFileSync(configPath, 'utf-8')) } catch { return [] }
}

function findPartner(domain: string, partners: PartnerConfig[]): PartnerConfig | undefined {
  return partners.find(p => domain.endsWith(p.domain) || p.aliases.some(a => domain.includes(a.toLowerCase())))
}

// ── RSS Feed Loading ──────────────────────────────────────────────────────────

function loadRSSFeedItems(): Array<{ title: string; link: string; pubDate: string; source: string; productTags: string[] }> {
  const rssPath = resolve(CACHE_DIR, 'rss', 'rh-feeds.json')
  if (!existsSync(rssPath)) return []
  try {
    const cache = JSON.parse(readFileSync(rssPath, 'utf-8'))
    const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000
    return (cache.items ?? []).filter((item: any) =>
      new Date(item.pubDate).getTime() >= thirtyDaysAgo
    )
  } catch { return [] }
}

// ── Cache Helpers ─────────────────────────────────────────────────────────────

export function getPrepCacheDir(slug: string): string {
  return resolve(CACHE_DIR, 'meeting-prep')
}

export function getHistoryPath(slug: string): string {
  return resolve(getPrepCacheDir(slug), `${slug}-history.json`)
}

export function readHistory(slug: string): PrepHistoryEntry[] {
  const path = getHistoryPath(slug)
  if (!existsSync(path)) return []
  try {
    return JSON.parse(readFileSync(path, 'utf-8'))
  } catch {
    return []
  }
}

export function appendHistory(slug: string, entry: PrepHistoryEntry): void {
  const dir = getPrepCacheDir(slug)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })

  const history = readHistory(slug)
  history.unshift(entry) // newest first
  writeJsonAtomic(getHistoryPath(slug), history)
}

// ── CCSP Context Builder ──────────────────────────────────────────────────────

export function buildCCSPContext(customer: Customer): string {
  const cache = readCCSPCache()
  if (!cache?.records?.length) return ''

  const customerRecords = cache.records.filter(r =>
    r.accountName?.toLowerCase() === customer.name.toLowerCase()
  )
  if (customerRecords.length === 0) return ''

  const clouds = [...new Set(customerRecords.map(r => r.cloudPartner).filter(Boolean))]
  const products = [...new Set(customerRecords.map(r => r.productOfferingGroup).filter(Boolean))]
  const totalACV = customerRecords.reduce((s, r) => s + (r.acvPlus || 0), 0)
  const quarters = [...new Set(customerRecords.map(r => r.quarter).filter(Boolean))].sort()

  const lines: string[] = []
  lines.push(`Cloud Platforms: ${clouds.join(', ') || 'Unknown'}`)
  lines.push(`Cloud Products: ${products.join(', ') || 'Not specified'}`)
  lines.push(`Total Cloud ACV: $${Math.round(totalACV).toLocaleString()}`)
  lines.push(`Data Period: ${quarters[0] ?? '?'} to ${quarters[quarters.length - 1] ?? '?'}`)

  // Break down by cloud partner
  for (const cloud of clouds) {
    const cloudRecords = customerRecords.filter(r => r.cloudPartner === cloud)
    const cloudACV = cloudRecords.reduce((s, r) => s + (r.acvPlus || 0), 0)
    const cloudProducts = [...new Set(cloudRecords.map(r => r.productOfferingGroup).filter(Boolean))]
    lines.push(`  ${cloud}: $${Math.round(cloudACV).toLocaleString()} — ${cloudProducts.join(', ') || 'unspecified products'}`)
  }

  return lines.join('\n')
}

// ── Attendee & Partner Detection ──────────────────────────────────────────────

export function deriveCompanyFromDomain(email: string): string {
  const domain = email.split('@')[1] ?? ''
  const company = domain.split('.')[0] ?? ''
  return company.charAt(0).toUpperCase() + company.slice(1)
}

export function getAttendeeDisplayName(meeting: { attendees: string[]; attendeeDetails?: Array<{ email: string; displayName?: string; linkedinUrl?: string }> }, email: string): string {
  const detail = (meeting.attendeeDetails ?? []).find(d => d.email === email)
  if (detail?.displayName) return detail.displayName
  // Derive from email: courtney.jimenez@insight.com → Courtney Jimenez
  const local = email.split('@')[0] ?? ''
  return local.split(/[._-]/).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
}

export function detectPartnerDomains(
  attendeeEmails: string[],
  customer: Customer
): { partnerDomains: string[]; customerDomains: string[] } {
  const customerDomains = [customer.domain, ...(customer.aliasDomains ?? [])].filter(Boolean) as string[]
  const externalEmails = attendeeEmails.filter(e => !e.endsWith('@redhat.com'))

  const partnerDomains = new Set<string>()
  for (const email of externalEmails) {
    const domain = email.split('@')[1] ?? ''
    if (domain && !customerDomains.some(cd => domain.endsWith(cd))) {
      partnerDomains.add(domain)
    }
  }

  return { partnerDomains: [...partnerDomains], customerDomains }
}

// ── Product Slug Inference ────────────────────────────────────────────────────

export function getCustomerProductSlugs(customer: Customer): string[] {
  const { readSheetCache } = require('./cache-layer.ts')
  const subCache = readSheetCache(customer.name)
  if (!subCache?.rows) return []
  try {
    const nameToSlug: Record<string, string> = {
      'openshift': 'ocp', 'rhel': 'rhel', 'enterprise linux': 'rhel',
      'ansible': 'aap', 'satellite': 'satellite', 'quay': 'quay',
      'openshift ai': 'rhoai', 'developer hub': 'rhdh',
      'advanced cluster security': 'acs', 'advanced cluster management': 'acm',
    }
    const slugs: string[] = []
    const productNames = [...new Set(subCache.rows.map((r: any) => r.productDescription ?? '').filter(Boolean))] as string[]
    for (const name of productNames) {
      const lower = name.toLowerCase()
      for (const [key, val] of Object.entries(nameToSlug)) {
        if (lower.includes(key)) { slugs.push(val); break }
      }
    }
    return [...new Set(slugs)]
  } catch { return [] }
}

// ── Value Map Context Builder ─────────────────────────────────────────────────

export function buildValueMapContext(customer: Customer): string {
  const { readSheetCache } = require('./cache-layer.ts')
  const subCache = readSheetCache(customer.name)

  let productSlugs: string[] = []

  if (subCache?.rows) {
    try {
      // Extract product slugs from subscription data
      const productNames = [...new Set(
        subCache.rows.map((r: any) => r.productDescription ?? '').filter(Boolean)
      )] as string[]

      // Map product names to slugs
      const nameToSlug: Record<string, string> = {
        'openshift': 'ocp',
        'rhel': 'rhel',
        'enterprise linux': 'rhel',
        'ansible': 'aap',
        'satellite': 'satellite',
        'quay': 'quay',
        'openshift ai': 'rhoai',
        'developer hub': 'rhdh',
        'advanced cluster security': 'acs',
        'advanced cluster management': 'acm',
      }

      for (const name of productNames) {
        const lower = name.toLowerCase()
        for (const [key, val] of Object.entries(nameToSlug)) {
          if (lower.includes(key)) {
            productSlugs.push(val)
            break
          }
        }
      }
    } catch { /* no subscription data */ }
  }

  // If no subscriptions found, don't filter — but log a warning
  if (productSlugs.length === 0) {
    console.warn(`[meeting-prep] No subscription data found for ${customer.name} — showing all products`)
  }

  const sections: string[] = []
  for (const ps of [...new Set(productSlugs)]) {
    const valueMap = getValueMap(ps)
    if (valueMap) {
      // Truncate to keep prompt reasonable
      sections.push(`### ${ps.toUpperCase()}\n${valueMap.slice(0, 2000)}`)
    }
  }

  return sections.length > 0 ? sections.join('\n\n') : ''
}

// ── Intelligence Context Builder ──────────────────────────────────────────────

export function buildIntelligenceContext(slug: string): string {
  const intelPath = resolve(CACHE_DIR, 'intelligence', `${slug}.json`)
  if (!existsSync(intelPath)) return ''

  try {
    const intel = JSON.parse(readFileSync(intelPath, 'utf-8'))
    // Extract key sections from intelligence cache
    const parts: string[] = []

    // Cache uses 'company'/'industry' (current) or 'companyIntelligence'/'industryAnalysis' (legacy)
    const companyText = intel.company ?? intel.companyIntelligence
    if (companyText) {
      parts.push(typeof companyText === 'string'
        ? companyText.slice(0, 5000)
        : JSON.stringify(companyText).slice(0, 5000))
    }

    const industryText = intel.industry ?? intel.industryAnalysis
    if (industryText) {
      parts.push(typeof industryText === 'string'
        ? industryText.slice(0, 3000)
        : JSON.stringify(industryText).slice(0, 3000))
    }

    return parts.join('\n\n')
  } catch {
    return ''
  }
}

// ── Recent Interactions Context Builder (#426) ──────────────────────────────

/**
 * Synthesize recent interactions from:
 * 1. ALL prep history for the customer (not just recurring series)
 * 2. Drive docs context (passed in as string)
 * 3. Recurring carry-forward (if applicable — prepended as first bullet)
 *
 * Returns structured text for injection into Gemini prompt.
 */
export function buildRecentInteractionsContext(
  slug: string,
  carryForwardContext: string,
  driveDocsContext: string,
): string {
  const history = readHistory(slug)
  const parts: string[] = []

  // 1. Carry-forward from recurring meetings — becomes first bullet
  if (carryForwardContext) {
    parts.push(carryForwardContext)
  }

  // 2. Past prep history — ALL meetings for this customer, last 5
  if (history.length > 0) {
    const recentHistory = history.slice(0, 5)
    const historyLines = recentHistory.map(h => {
      const date = new Date(h.meetingStart).toLocaleDateString('en-US', {
        month: 'short', day: 'numeric', year: 'numeric',
      })
      const actions = (h.actionItems ?? []).slice(0, 3)
      const actionSummary = actions.length > 0
        ? ` — Key items: ${actions.join('; ')}`
        : ''
      return `- ${date}: "${h.meetingTitle}"${actionSummary}${h.docUrl ? ` [doc](${h.docUrl})` : ''}`
    })
    parts.push(`## Past Meeting Prep History (last ${recentHistory.length})\n${historyLines.join('\n')}`)
  }

  // 3. Drive docs context
  if (driveDocsContext) {
    parts.push(driveDocsContext)
  }

  return parts.join('\n\n')
}

// ── Fallback Attendee Table ───────────────────────────────────────────────────

export function buildFallbackAttendeeTable(
  attendees: string[],
  prepData: any,
  meeting?: { attendeeDetails?: Array<{ email: string; displayName?: string; linkedinUrl?: string }> }
): string {
  if (attendees.length === 0) return 'No attendees listed'

  const rows = attendees.map(attendee => {
    const name = meeting ? getAttendeeDisplayName(meeting as any, attendee) : attendee
    const company = deriveCompanyFromDomain(attendee)
    const ctx = prepData?.attendeeContext?.find(
      (ac: any) => ac.name === attendee
    )
    const lastInteraction = ctx?.lastInteraction ?? 'Unknown'

    return `| ${name} | ${company} | Last interaction: ${lastInteraction} | — |`
  })

  return `| Name & Title | Company | Background | Engagement Angle |\n|------|------|-----------|------------------|\n${rows.join('\n')}`
}

// ── Meeting Prep Assembly (from calendar data) ────────────────────────────────

export async function assembleMeetingPrepForMeeting(
  customer: Customer,
  meeting: { meetingTitle: string; meetingStart: string; attendees: string[] }
) {
  // Import needed types
  const { readEmailCache, readSheetCache } = await import('./cache-layer.ts')
  const slug = toSlug(customer.name)

  // Read cached data
  const emails = readEmailCache(slug) ?? []
  const cases = await fetchCases({ includeAll: false }).catch(() => [])
  const customerCases = cases.filter((sc: SupportCase) =>
    (customer.accountNumbers ?? []).map(String).includes(String(sc.accountNumber))
  )

  // Read subscription cache (ProductSubscription from sheet cache)
  let subscriptions: CustomerSubscription[] = []
  try {
    const subCache = readSheetCache(customer.name)
    if (subCache?.rows) {
      // Map ProductSubscription to CustomerSubscription shape
      subscriptions = subCache.rows.map((r: any) => {
        const endDate = r.endDate ?? ''
        const daysLeft = endDate
          ? Math.ceil((new Date(endDate).getTime() - Date.now()) / (1000 * 60 * 60 * 24))
          : NaN
        return {
          subscriptionNumber: r.sku ?? '',
          productName: r.productDescription ?? '',
          quantity: r.quantity ?? 0,
          endDate,
          daysLeft,
          status: r.status ?? 'Active',
        } satisfies CustomerSubscription
      })
    }
  } catch { /* no subscriptions cached */ }

  // Build a synthetic CalendarEvent array with just this meeting
  const syntheticMeetings: CalendarEvent[] = [{
    title: meeting.meetingTitle,
    start: meeting.meetingStart,
    end: meeting.meetingStart, // Not critical for prep assembly
    attendees: meeting.attendees,
    needsPrep: true,
    customers: [customer.name],
  }]

  const preps = assembleMeetingPrep(syntheticMeetings, emails, customerCases, subscriptions)
  return preps[0] ?? null
}

// ── Core Generation Logic ─────────────────────────────────────────────────────

export async function generateMeetingPrep(
  customer: Customer,
  meeting: MeetingPrepRequest
): Promise<MeetingPrepResult> {
  const slug = toSlug(customer.name)
  const meetingDate = new Date(meeting.meetingStart)
  const dateStr = meetingDate.toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  })

  console.log(`[meeting-prep] Generating prep for ${customer.name} — "${meeting.meetingTitle}" on ${dateStr}`)

  // ── Step 0: Pre-flight signal refresh (#285) ──────────────────────────
  await FeatureModuleRegistry.refreshStaleSignals(slug).catch(() => {})

  // ── Step 1: Gather all context in parallel ──────────────────────────────

  const [
    meetingPrepData,
    signalData,
    casesData,
  ] = await Promise.all([
    // assembleMeetingPrep for attendee context + health signals
    assembleMeetingPrepForMeeting(customer, meeting),
    // Customer signals (intelligence, product intel, etc.)
    loadCustomerSignals(slug, customer.name, { ensureFresh: true }).catch((e) => {
      console.warn(`[meeting-prep] Signal loading failed:`, e.message)
      return { signals: {}, registrySignals: [], loaded: [], missing: [] }
    }),
    // Support cases
    fetchCases({ includeAll: false }).catch(() => [] as SupportCase[]),
  ])

  // Account team
  const accountTeam = getAccountTeam(customer)
  const teamContext = toPromptContext(accountTeam)

  // Account plan from signal loader (existing cached data from Drive)
  const accountPlanContext = (signalData.signals as any)?.accountPlan
    ? (typeof (signalData.signals as any).accountPlan === 'string'
        ? (signalData.signals as any).accountPlan.slice(0, 4000)
        : '')
    : ''

  // Intelligence cache — generate on-the-fly if missing, then poll until complete
  let intelligenceContext = buildIntelligenceContext(slug)
  if (!intelligenceContext) {
    console.log(`[meeting-prep] Intelligence missing for ${customer.name} — generating on the fly...`)
    try {
      runIntelligencePipeline(customer.name, true)
      // Poll for completion (pipeline is fire-and-forget internally)
      const maxWaitMs = 120_000
      const pollIntervalMs = 3_000
      const startTime = Date.now()
      while (Date.now() - startTime < maxWaitMs) {
        await new Promise(r => setTimeout(r, pollIntervalMs))
        const job = getJobStatus(customer.name)
        if (job?.status === 'complete' || job?.status === 'complete_no_drive_folder' || job?.status === 'error') break
      }
      intelligenceContext = buildIntelligenceContext(slug)
      console.log(`[meeting-prep] Intelligence generated for ${customer.name} (${intelligenceContext.length} chars)`)
    } catch (e: any) {
      console.warn(`[meeting-prep] Intelligence generation failed for ${customer.name}:`, e?.message ?? e)
    }
  }

  // ── Step 1a: Recurring meeting carry-forward (#269) ────────────────────
  let carryForwardContext = ''
  const isRecurring = !!meeting.recurringEventId
  if (isRecurring) {
    console.log(`[meeting-prep] Recurring meeting detected (series: ${meeting.recurringEventId})`)
    const history = readHistory(slug) as PrepHistoryWithSeries[]
    const previousPrep = findPreviousPrepForSeries(
      meeting.recurringEventId!,
      meeting.meetingStart,
      history
    )

    if (previousPrep) {
      // Try to read the cached content for action item extraction
      const contentPath = resolve(CACHE_DIR, 'meeting-prep', `${slug}-latest.json`)
      let actionItems: string[] = previousPrep.actionItems ?? []

      if (actionItems.length === 0 && existsSync(contentPath)) {
        try {
          const cached = JSON.parse(readFileSync(contentPath, 'utf-8'))
          if (cached.content) {
            actionItems = extractActionItems(cached.content)
          }
        } catch { /* no cached content */ }
      }

      carryForwardContext = buildCarryForwardContext(actionItems, previousPrep.meetingStart)
      if (carryForwardContext) {
        console.log(`[meeting-prep] Carry-forward: ${actionItems.length} action items from ${previousPrep.meetingStart}`)
      }
    }
  }

  // ── Step 1a-2: Scan customer Drive folder for recent docs (#269) ──────
  let driveDocsContext = ''
  try {
    const customerFolderId = await findCustomerDriveFolder(customer)
    const auth = makeAuth(GOOGLE_UNIFIED_TOKEN_PATH)
    const drive = google.drive({ version: 'v3', auth })

    // Find docs modified since last prep (or last 14 days)
    const lastPrepHistory = readHistory(slug)
    const lastPrepDate = lastPrepHistory[0]?.generatedAt
    const sinceDate = lastPrepDate
      ? new Date(lastPrepDate)
      : new Date(Date.now() - 14 * 24 * 60 * 60 * 1000)

    const recentDocs = await drive.files.list({
      q: `'${customerFolderId}' in parents and mimeType = 'application/vnd.google-apps.document' and modifiedTime > '${sinceDate.toISOString()}' and trashed = false`,
      fields: 'files(id,name,modifiedTime,webViewLink)',
      pageSize: 10,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    })

    const docs = recentDocs.data.files ?? []
    if (docs.length > 0) {
      // Extract text from recent docs (capped)
      const docTexts: string[] = []
      for (const doc of docs.slice(0, 5)) {
        try {
          const exported = await drive.files.export({
            fileId: doc.id!,
            mimeType: 'text/plain',
          })
          const text = typeof exported.data === 'string'
            ? exported.data.slice(0, 2000)
            : ''
          if (text) {
            docTexts.push(`### ${doc.name} (modified ${new Date(doc.modifiedTime!).toLocaleDateString()})\n${text}`)
          }
        } catch { /* skip unreadable docs */ }
      }
      if (docTexts.length > 0) {
        driveDocsContext = `## Account Notes & Recent Documents\nThe following documents were found in the customer's Drive folder, modified since the last prep:\n\n${docTexts.join('\n\n')}`
        console.log(`[meeting-prep] Drive scan: ${docTexts.length} recent docs found for ${customer.name}`)
      }
    }
  } catch (e: any) {
    console.warn(`[meeting-prep] Drive folder scan failed for ${customer.name}:`, e.message)
  }

  // ── Step 1b: Load additional data sources ──────────────────────────────

  // Determine product focus: explicit context > subscription data > inferred from objective
  let productSlugs = meeting.context?.productFocus?.length
    ? meeting.context.productFocus
    : getCustomerProductSlugs(customer)

  // If still empty, infer from meeting objective/title/notes
  if (productSlugs.length === 0) {
    const contextText = [meeting.meetingTitle, meeting.context?.objective, meeting.context?.notes].filter(Boolean).join(' ').toLowerCase()
    const keywordToSlug: Record<string, string> = {
      'openshift': 'ocp', 'ocp': 'ocp', 'kubernetes': 'ocp', 'k8s': 'ocp', 'container': 'ocp',
      'ansible': 'aap', 'aap': 'aap', 'automation': 'aap', 'playbook': 'aap', 'lightspeed': 'aap',
      'rhel': 'rhel', 'enterprise linux': 'rhel', 'linux': 'rhel',
      'satellite': 'satellite', 'quay': 'quay',
      'openshift ai': 'rhoai', 'rhoai': 'rhoai', 'ai platform': 'rhoai',
      'virtualization': 'ocp-virt', 'virt': 'ocp-virt', 'vmware': 'ocp-virt',
      'acs': 'acs', 'advanced cluster security': 'acs',
      'acm': 'acm', 'advanced cluster management': 'acm',
    }
    for (const [keyword, slug] of Object.entries(keywordToSlug)) {
      if (contextText.includes(keyword) && !productSlugs.includes(slug)) {
        productSlugs.push(slug)
      }
    }
    if (productSlugs.length > 0) {
      console.log(`[meeting-prep] Inferred products from context: ${productSlugs.join(', ')}`)
    }
  }

  // CCSP cloud spend data
  const ccspContext = buildCCSPContext(customer)
  if (ccspContext) {
    console.log(`[meeting-prep] CCSP data found for ${customer.name}`)
  }

  const lifecycleCache = readProductLifecycleCache()
  const productSummaries = getAllProductSummaries()
  const rssItems = loadRSSFeedItems()

  // Internal roadmap data (manually maintained release dates)
  const roadmapData = loadProductRoadmap()

  // Filter RSS to relevant products
  const relevantRSS = rssItems
    .filter(item => productSlugs.length === 0 || (item.productTags ?? []).some(tag => productSlugs.includes(tag.toLowerCase())))
    .slice(0, 10)

  // ── Step 2: Research attendees via Gemini with grounding ─────────────────

  const attendeeEmails = meeting.attendees.filter(e => !e.endsWith('@redhat.com'))
  const { partnerDomains, customerDomains } = detectPartnerDomains(meeting.attendees, customer)

  // Load partner config and match detected domains
  const partnerConfigs = loadPartnerConfig()
  const detectedPartners: PartnerConfig[] = []
  for (const pd of partnerDomains) {
    const match = findPartner(pd, partnerConfigs)
    if (match) detectedPartners.push(match)
  }

  let attendeeResearch = ''
  let partnerResearch = ''
  let otherPartnersTable = ''

  // Separate customer attendees from partner attendees
  const customerAttendees = attendeeEmails.filter(e => {
    const domain = e.split('@')[1] ?? ''
    return customerDomains.some(cd => domain.endsWith(cd))
  })
  const partnerAttendees = attendeeEmails.filter(e => !customerAttendees.includes(e))

  if (customerAttendees.length > 0) {
    // Research customer attendees deeply via LinkedIn
    try {
      const attendeeLines = customerAttendees.map(email => {
        const name = getAttendeeDisplayName(meeting, email)
        const detail = (meeting.attendeeDetails ?? []).find(d => d.email === email)
        if (detail?.linkedinUrl) {
          return `- "${name}" at ${customer.name} (${email}) — Research this LinkedIn profile: ${detail.linkedinUrl}`
        }
        return `- "${name}" at ${customer.name} (${email}) — search: "${name}" site:linkedin.com ${customer.name}`
      }).join('\n')

      const attendeeResult = await callGemini(
        'You are an expert sales intelligence researcher. For each attendee, find their LinkedIn profile at the specified company. Return detailed, specific information. If you cannot find someone, state "Profile not found" — never guess or return a wrong person.',
        `Research these customer attendees from ${customer.name}:
${attendeeLines}

For each attendee, provide:
1. **Full Name & Title** — current title at ${customer.name}
Return ONE bullet line per person in this exact format:
- **Full Name**, Current Title at Company — one key insight (career highlight, certification, or recent signal)

Do NOT use a table. One bullet per person. Keep each bullet to one line.`,
        {
          callType: 'meeting-prep-attendee-research',
          customerName: customer.name,
          model: 'full',
          grounding: true,
          timeoutMs: 60_000,
        }
      )
      attendeeResearch = attendeeResult.text
    } catch (e: any) {
      console.warn(`[meeting-prep] Attendee research failed:`, e.message)
      attendeeResearch = buildFallbackAttendeeTable(customerAttendees, meetingPrepData, meeting)
    }
  }

  // For partner attendees, just list names — the Partner section covers their company
  if (partnerAttendees.length > 0 && !attendeeResearch) {
    const rows = partnerAttendees.map(email => {
      const name = getAttendeeDisplayName(meeting, email)
      const company = deriveCompanyFromDomain(email)
      return `| ${name} | ${company} | Partner/integrator representative | See Partners & Integrators section |`
    }).join('\n')
    attendeeResearch = `| Name | Company | Role | Notes |\n|---|---|---|---|\n${rows}`
  } else if (partnerAttendees.length > 0) {
    // Append partner attendees as simple rows to existing customer attendee table
    const partnerRows = partnerAttendees.map(email => {
      const name = getAttendeeDisplayName(meeting, email)
      const company = deriveCompanyFromDomain(email)
      return `| ${name} (${company}) | Partner representative | See Partners & Integrators section | Discuss their role in this engagement |`
    }).join('\n')
    attendeeResearch += '\n' + partnerRows
  }

  // ── Step 2b: Partner context from config or grounding ────────────────────

  if (partnerDomains.length > 0) {
    if (detectedPartners.length > 0) {
      // Use config data — no Gemini call needed
      partnerResearch = detectedPartners.map(p =>
        `**${p.name}**\n- Partnership Level: ${p.partnershipLevel}\n- Specializations: ${p.specializations.join(', ')}\n- Geo: ${p.country}\n- Catalog: ${p.catalogUrl ?? 'N/A'}`
      ).join('\n\n')

      // Also find recommended partners for the product focus
      const specToProduct: Record<string, string[]> = {
        'Mission Critical Automation': ['aap'],
        'Container Mgmt': ['ocp'],
        'Application Platform': ['ocp', 'rhdh'],
        'Virtualization': ['ocp'],
        'Server Cloud': ['rhel'],
        'Server Cloud OS': ['rhel'],
      }
      const relevantPartners = partnerConfigs.filter(p =>
        !detectedPartners.includes(p) &&
        p.specializations.some(s => (specToProduct[s] ?? []).some(ps => productSlugs.includes(ps)))
      )
      if (relevantPartners.length > 0) {
        const partnerRows = relevantPartners.slice(0, 8).map(p => {
          const link = p.catalogUrl ? `[Catalog](${p.catalogUrl})` : (p.sourceUrl ? `[Profile](${p.sourceUrl})` : '—')
          return `| ${p.name} | ${p.specializations.join(', ')} | ${p.country || p.geo || '—'} | ${link} |`
        }).join('\n')
        otherPartnersTable = `\n\n**Other Certified Partners for These Products:**\n| Partner | Specializations | Region | Link |\n|---|---|---|---|\n${partnerRows}`
      }
    } else {
      // Unknown partner — single Gemini grounding search for the company
      try {
        const partnerResult = await callGemini(
          'You are a B2B sales intelligence researcher. Research this company and describe their business and any Red Hat partnership status. Be concise — 3-4 lines max.',
          `Research: ${partnerDomains.join(', ')} — what do they do? Are they a Red Hat partner?`,
          { callType: 'meeting-prep-partner-research', customerName: customer.name, model: 'full', grounding: true, timeoutMs: 30_000 }
        )
        partnerResearch = partnerResult.text
      } catch { partnerResearch = `Partner domains identified: ${partnerDomains.join(', ')}` }
    }
  }

  // ── Step 3: Filter cases to this customer ──────────────────────────────

  const customerCases = casesData.filter((sc) =>
    (customer.accountNumbers ?? []).map(String).includes(String(sc.accountNumber))
  )
  const caseSummary = customerCases.length > 0
    ? customerCases.map(sc => `- ${sc.summary} (Sev${sc.severity}, ${sc.status})`).join('\n')
    : 'No open support cases'

  // ── Step 4: Check for existing playbook (ADR-026 derived view) ──────────
  const playbook = readPlaybook(slug)
  let prepContent: string
  let qualityScorecard: QualityScorecard | undefined

  if (playbook) {
    console.log(`[meeting-prep] Found playbook for ${customer.name} — generating derived meeting prep`)

    // Build attendee filter: match against key relationships and team members
    const attendeeNames = meeting.attendees
      .map(email => getAttendeeDisplayName(meeting, email))
      .filter(n => !n.endsWith('@redhat.com'))

    // Extract relevant playbook sections
    const strategicPosition = playbook.sections.strategicPosition.content
    const currentPriorities = playbook.sections.currentPriorities.content
    const expansionOpps = playbook.sections.expansionOpportunities.content
    const renewalsRisk = playbook.sections.renewalsAndRisk.content

    // Filter key relationships by attendees in this meeting
    const keyRelationships = playbook.sections.keyRelationships.content
      .split('\n')
      .filter(line => {
        const lowerLine = line.toLowerCase()
        return attendeeNames.some(name => lowerLine.includes(name.toLowerCase()))
      })
      .join('\n')

    // Filter product alignment to products in focus
    const relevantProducts = playbook.sections.productAlignment.products
      .filter(p => productSlugs.length === 0 || productSlugs.includes(p.productSlug))
      .map(p => `**${p.displayName}**\n- Use Case: ${p.useCase}\n- Proof Points: ${p.proofPoints}\n- What's New: ${p.whatsNew}\n- Lifecycle: ${p.lifecycle}\n${p.featureTalkingPoints ? `- Feature Highlights: ${p.featureTalkingPoints}` : ''}`)
      .join('\n\n')

    // Get recent engagement history (last 5 entries)
    const recentEngagement = playbook.sections.engagementHistory.entries
      .slice(0, 5)
      .map(e => `- ${e.date}: ${e.summary}${e.attendees.length ? ` (${e.attendees.join(', ')})` : ''}`)
      .join('\n')

    // Filter open action items to those relevant for this meeting
    const openActions = playbook.sections.openActionItems.items
      .filter(item => item.status === 'open')
      .map(item => `- ${item.text} (Owner: ${item.owner})`)
      .join('\n')

    // ── Build enrichment context for prompt injection (#426) ──────────
    const enrichmentContext = buildEnrichmentPromptContext(customer, productSlugs, {
      productSummaries, rssItems: relevantRSS, customerSlug: slug,
      getValueMapFn: getValueMap,
      getIntelFn: getCachedCustomerProductIntel,
      getSheetCacheFn: (name: string) => {
        try { return JSON.parse(readFileSync(resolve(CACHE_DIR, `${toSlug(name)}-sheets.json`), 'utf-8')) } catch { return null }
      },
      lifecycleCache, roadmapData,
    })

    // ── Build recent interactions context (#426) ──────────────────────
    const recentInteractionsContext = buildRecentInteractionsContext(slug, carryForwardContext, driveDocsContext)

    // Build shorter, focused Gemini prompt using playbook intelligence
    const derivedSystemPrompt = `You are generating a focused Red Hat sales meeting prep document — 7 sections, scannable in 3-5 minutes. The playbook has already synthesized customer context — your job is to craft a meeting-specific narrative that guides the account team through THIS specific meeting.

FOCUS RULE (CRITICAL):
- The meeting goal/objective is the PRIMARY FILTER for all content. If the meeting is about an Ansible renewal, the Value Play, Discussion Questions, and Action Items must CENTER on Ansible — not spread across every product the customer has. Other products may appear as secondary context ONLY if directly relevant to the meeting topic.
- Include the specific subscription details for the product(s) relevant to the meeting goal: product name, quantity, expiration date, renewal opportunity ID, and current pricing/quote status.

FORMAT RULES:
- EXACTLY 7 numbered sections in this order: Meeting Objective, Who's in the Room, Recent Interactions, Value Play, Discussion Questions, Open Items (conditional), Action Items
- NO markdown tables in ANY section — all sections use bullets and narrative
- Commercial data (subscriptions, renewals, pipeline, CCSP) must appear WITHIN discussion questions — no dedicated commercial section
- Value Play is ONE paragraph using Command of the Message style — a teaching point focused on the meeting's stated objective
- Discussion Questions must name specific attendees and include a PURPOSE for each question
- Open Items section: ONLY include if there are active cases or urgent renewals relevant to THIS meeting. If nothing actionable, OMIT the section entirely.
- Action Items use bullets with phase markers (Pre-meeting/During/Post-meeting), specific names, and dates`

    const derivedUserPrompt = `Generate a 7-section meeting prep for this specific meeting using the existing customer playbook:

## Meeting Details
- Customer: ${customer.name}
- Meeting: ${meeting.meetingTitle}
- Date: ${dateStr}
- Attendees: ${attendeeNames.join(', ') || 'Not specified'}
${teamContext ? `\n${teamContext}` : ''}
${meeting.context?.objective ? `\n## MEETING OBJECTIVE\n${meeting.context.objective}\n` : ''}
${meeting.context?.notes ? `\n## ADDITIONAL CONTEXT\n${meeting.context.notes}\n` : ''}

## From Customer Playbook

### Strategic Position (established intelligence)
${strategicPosition}

### Current Priorities (from playbook)
${currentPriorities}

### Key Relationships (filtered to meeting attendees)
${keyRelationships || 'No key relationships match this meeting\'s attendees'}

### Product Alignment (products in focus for this meeting)
${relevantProducts || 'No product alignment data for meeting focus products'}

### Recent Engagement History
${recentEngagement || 'No recent engagement history'}

### Open Action Items (relevant to this meeting)
${openActions || 'No open action items'}

### Expansion Opportunities (from playbook)
${expansionOpps}

### Solution Plays (from playbook)
${(() => {
  const plays = playbook.deterministic?.solutionPlays ?? []
  return plays.length > 0
    ? plays.map((p: any) =>
        `- **${p.playName}** (${p.tdp}, ${p.confidence}): ${p.triggerTechnologies.join(', ')}${p.talkTrack ? `\n  Talk track: ${p.talkTrack.slice(0, 200)}` : ''}`
      ).join('\n')
    : 'No solution plays identified'
})()}

### Tactical Recommendations (from SalesHub knowledge)
${(() => {
  const plays = playbook.deterministic?.solutionPlays ?? []
  if (plays.length === 0) return 'No tactical recommendations — no solution plays matched'
  const recs: string[] = []
  for (const play of plays) {
    const tdpNode = getTdpByName(play.tdp)
    const salesPlay = getSalesPlayByName(play.playName)

    if (tdpNode?.whatToShow?.length) {
      recs.push(`**Recommended Demos (${play.tdp}):**`)
      for (const demo of tdpNode.whatToShow.slice(0, 3)) {
        recs.push(`- [${demo.name}](${demo.url}) — ${demo.type}`)
      }
    }

    const examples = (play as any).realWorldExamples ?? salesPlay?.realWorldExamples ?? []
    if (examples.length > 0) {
      recs.push(`**Reference Case Studies (${play.playName}):**`)
      for (const ex of examples.slice(0, 3)) {
        recs.push(`- ${ex.customer} — ${ex.outcome}`)
      }
    }

    if (tdpNode?.services?.length) {
      recs.push(`**Services to Propose (${play.tdp}):**`)
      for (const svc of tdpNode.services.slice(0, 3)) {
        recs.push(`- ${svc.name}: ${svc.description}`)
      }
    }
  }
  return recs.length > 0 ? recs.join('\n') : 'No tactical recommendations available for matched plays'
})()}

### Renewals & Risk (from playbook)
${renewalsRisk}

## Additional Context for This Meeting

### Meeting Attendees (full research)
${attendeeResearch || 'No attendee research available'}

### Open Support Cases
${caseSummary}

${ccspContext ? `### Cloud Consumption & Spend (CCSP)\n${ccspContext}` : ''}

${enrichmentContext ? `### Product & Market Intelligence (for contextual use in Discussion Questions and Value Play)\n${enrichmentContext}` : ''}

${recentInteractionsContext ? `### Recent Interactions & History\n${recentInteractionsContext}` : ''}

---

${isRecurring ? `This is a RECURRING meeting (series ID: ${meeting.recurringEventId}). Outstanding items from the last meeting are in Recent Interactions above — reference them in discussion questions and check their status.\n\n` : ''}Generate the document with these EXACT 7 sections:

# Meeting Prep: ${customer.name} — ${meeting.meetingTitle}
**${dateStr}** | Prepared for: ${accountTeam.find(m => m.role === 'ae')?.name || accountTeam[0]?.name || 'Account Team'}${isRecurring ? `\n*Recurring meeting — outstanding items carried forward in Recent Interactions*` : ''}

### 1. Meeting Objective
[2-3 lines: restate the meeting purpose in context of the playbook's strategic position. Be specific about what needs to happen in THIS meeting.]

### 2. Who's in the Room
[One bullet per person. NO table. Format: "- **Full Name**, Title — one key insight from LinkedIn research or prior interactions". ONLY list people on the calendar invite — do NOT list the full account team. The account team context is for YOUR reference when crafting questions and action items, not for this section.]

### 3. Recent Interactions
[3-5 bullets synthesized from the Recent Interactions & History context above. If this is a recurring meeting, the FIRST bullet must be carry-forward items marked OUTSTANDING. Each bullet: date, what was discussed and decided (not just "meeting happened"), one-line summary. When referencing news or press releases, include the source URL as a markdown link.]

### 4. Value Play
[ONE paragraph, Command of the Message style. A teaching point tailored to THIS meeting's attendees and agenda. Reference specific playbook data — products, quantities, renewal dates, case numbers. This should be the thing the AE says in the first 2 minutes to establish credibility and frame the conversation.]

### 5. Discussion Questions
[5-7 bullet points. Each bullet: **Attendee Name (Title):** Question text — PURPOSE: why this question matters, citing specific commercial data (subscription quantities, renewal dates, pipeline amounts, CCSP cloud spend). Weave commercial data INTO the questions naturally.]

### 6. Open Items
[CONDITIONAL — only include if there are active support cases or renewals within 90 days relevant to THIS meeting. If nothing actionable, OMIT this section entirely. Use bullets, not tables.]

### 7. Action Items
[Bullet points with phase markers and specific names:]
- **Pre-meeting:** [Name] — [action] (by [date])
- **During meeting:** [Name/Team] — [action]
- **Post-meeting (within N days/weeks):** [Name] — [action]
[Minimum 3 items with specific team member names and dates.]`

    // Shorter Gemini call — playbook is primary context
    const geminiResult = await callGemini(derivedSystemPrompt, derivedUserPrompt, {
      callType: 'meeting-prep-derived-from-playbook',
      customerName: customer.name,
      model: 'full',
      timeoutMs: 90_000, // Shorter timeout — less synthesis needed
    })

    // Quality gate (ADR-024) — validate and retry if below threshold
    const gateResult = await validateAndRetry(
      geminiResult.text,
      { validator: meetingPrepValidator },
      async (failures) => {
        const feedback = formatFailureFeedback(failures)
        const retryResult = await callGemini(
          derivedSystemPrompt,
          derivedUserPrompt + '\n\n' + feedback,
          {
            callType: 'meeting-prep-derived-from-playbook',
            customerName: customer.name,
            model: 'full',
            timeoutMs: 90_000,
          }
        )
        return retryResult.text
      }
    )
    prepContent = gateResult.output
    qualityScorecard = gateResult.scorecard
  } else {
    // ── No playbook: standard generation flow ──────────────────────────────
    console.log(`[meeting-prep] No playbook for ${customer.name} — using standard generation flow`)

    // ── Build enrichment context for prompt injection (#426) ──────────
    const enrichmentContext = buildEnrichmentPromptContext(customer, productSlugs, {
      productSummaries, rssItems: relevantRSS, customerSlug: slug,
      getValueMapFn: getValueMap,
      getIntelFn: getCachedCustomerProductIntel,
      getSheetCacheFn: (name: string) => {
        try { return JSON.parse(readFileSync(resolve(CACHE_DIR, `${toSlug(name)}-sheets.json`), 'utf-8')) } catch { return null }
      },
      lifecycleCache, roadmapData,
    })

    // ── Build recent interactions context (#426) ──────────────────────
    const recentInteractionsContext = buildRecentInteractionsContext(slug, carryForwardContext, driveDocsContext)

    const systemPrompt = `You are generating a Red Hat sales meeting prep document — 7 sections, scannable in 3-5 minutes. Every line must help the account team sell.

FOCUS RULE (CRITICAL):
- The meeting goal/objective is the PRIMARY FILTER for all content. If the meeting is about an Ansible renewal, the Value Play, Discussion Questions, and Action Items must CENTER on Ansible — not spread across every product the customer has. Other products may appear as secondary context ONLY if directly relevant to the meeting topic.
- Include the specific subscription details for the product(s) relevant to the meeting goal: product name, quantity, expiration date, renewal opportunity ID, and current pricing/quote status.

FORMAT RULES:
- EXACTLY 7 numbered sections in this order: Meeting Objective, Who's in the Room, Recent Interactions, Value Play, Discussion Questions, Open Items (conditional), Action Items
- NO markdown tables in ANY section — all sections use bullets and narrative
- Commercial data (subscriptions, renewals, pipeline, CCSP) must appear WITHIN discussion questions — no dedicated commercial section
- Value Play is ONE paragraph using Command of the Message style — a teaching point focused on the meeting's stated objective
- Discussion Questions must name specific attendees and include a PURPOSE for each question
- Open Items section: ONLY include if there are active cases or urgent renewals relevant to THIS meeting. If nothing actionable, OMIT the section entirely.
- Action Items use bullets with phase markers (Pre-meeting/During/Post-meeting), specific names, and dates
- Every claim MUST cite specific customer data (goals, infrastructure, case numbers, renewal dates, subscription quantities)
- NO generic value statements. "Improves efficiency" is forbidden. Be specific.
- Only include products the customer subscribes to in the Value Play.`

    const userPrompt = `Generate a 7-section meeting prep for:

## Meeting Details
- Customer: ${customer.name}
- Meeting: ${meeting.meetingTitle}
- Date: ${dateStr}
- Attendees: ${attendeeEmails.map(e => getAttendeeDisplayName(meeting, e)).join(', ') || 'Not specified'}
${teamContext ? `\n${teamContext}` : ''}
${meeting.context?.objective ? `\n## MEETING OBJECTIVE (from account team — THIS IS THE #1 PRIORITY)\n${meeting.context.objective}\n` : ''}
${meeting.context?.notes ? `\n## ADDITIONAL CONTEXT (from account team)\n${meeting.context.notes}\n` : ''}
${meeting.context?.productFocus?.length ? `\n## PRODUCT FOCUS (account team specified)\nFocus ALL content on these products: ${meeting.context.productFocus.join(', ')}.\n` : ''}

## Customer Subscriptions
${(() => {
  const { readSheetCache } = require('./cache-layer.ts')
  const sc = readSheetCache(customer.name)
  if (!sc?.rows?.length) return 'No subscription data available'
  return sc.rows.map((r: any) => `- ${r.productDescription ?? 'Unknown'}: ${r.quantity ?? '?'} units (expires ${r.endDate ?? '?'})`).join('\n')
})()}

## Customer Intelligence
${intelligenceContext || 'Data not available — generate intelligence for this customer'}

${ccspContext ? `## Cloud Consumption & Spend (CCSP)\n${ccspContext}\nWeave this data into Discussion Questions to recommend cloud-specific Red Hat services.` : ''}

${accountPlanContext ? `## Account Plan & Notes\n${accountPlanContext}` : ''}

## Attendee Research
${attendeeResearch || 'No attendee research available'}

## Open Support Cases
${caseSummary}

## Health Signals
- Open Cases: ${meetingPrepData?.healthSignals?.cases || 'Unknown'}
- Renewals: ${meetingPrepData?.healthSignals?.renewals || 'Unknown'}

${enrichmentContext ? `## Product & Market Intelligence (use contextually in Discussion Questions and Value Play)\n${enrichmentContext}` : ''}

${recentInteractionsContext ? `## Recent Interactions & History (synthesize into Section 3)\n${recentInteractionsContext}` : ''}

${partnerResearch ? `## Partner Context\n${partnerResearch}` : ''}

---

${isRecurring ? `This is a RECURRING meeting (series ID: ${meeting.recurringEventId}). Outstanding items are in Recent Interactions above — reference them in discussion questions and check their status.\n\n` : ''}Generate the document with these EXACT 7 sections:

# Meeting Prep: ${customer.name} — ${meeting.meetingTitle}
**${dateStr}** | Prepared for: ${accountTeam.find(m => m.role === 'ae')?.name || accountTeam[0]?.name || 'Account Team'}${isRecurring ? `\n*Recurring meeting — outstanding items carried forward in Recent Interactions*` : ''}

### 1. Meeting Objective
[2-3 lines: state the meeting purpose. If attendees are from a partner/integrator, focus on the partnership objective for ${customer.name}.]

### 2. Who's in the Room
[One bullet per person. NO table. Format: "- **Full Name**, Title — one key insight from LinkedIn research or prior interactions". ONLY list people on the calendar invite — do NOT list the full account team. The account team context is for YOUR reference when crafting questions and action items, not for this section.]

### 3. Recent Interactions
[3-5 bullets synthesized from the Recent Interactions & History context above. If this is a recurring meeting, the FIRST bullet must be carry-forward items marked OUTSTANDING. Each bullet: date, what was discussed and decided (not just "meeting happened"), one-line summary. When referencing news or press releases, include the source URL as a markdown link.]

### 4. Value Play
[ONE paragraph, Command of the Message style. Cross-reference value maps and product intelligence against the customer's stated goals. A teaching point that establishes credibility and frames the conversation. Reference specific data — products, quantities, renewal dates.]

### 5. Discussion Questions
[5-7 bullet points. Each bullet: **Attendee Name (Title):** Question text — PURPOSE: why this question matters, citing specific commercial data (subscription quantities, renewal dates, pipeline amounts, CCSP cloud spend). Weave commercial data INTO the questions naturally. Questions should ADVANCE THE SALE — discover budget, timeline, decision criteria, competitive alternatives.]

### 6. Open Items
[CONDITIONAL — only include if there are active support cases or renewals within 90 days relevant to THIS meeting. If nothing actionable, OMIT this section entirely. Use bullets, not tables.]

### 7. Action Items
[Bullet points with phase markers and specific names:]
- **Pre-meeting:** [Name] — [action] (by [date])
- **During meeting:** [Name/Team] — [action]
- **Post-meeting (within N days/weeks):** [Name] — [action]
[Minimum 3 items with specific team member names and dates. Include "share X blog post with Y" items from product intelligence.]`

    const geminiResult = await callGemini(systemPrompt, userPrompt, {
      callType: 'meeting-prep-synthesis',
      customerName: customer.name,
      model: 'full',
      timeoutMs: 120_000,
    })

    // Quality gate (ADR-024) — validate and retry if below threshold
    const gateResult = await validateAndRetry(
      geminiResult.text,
      { validator: meetingPrepValidator },
      async (failures) => {
        const feedback = formatFailureFeedback(failures)
        const retryResult = await callGemini(
          systemPrompt,
          userPrompt + '\n\n' + feedback,
          {
            callType: 'meeting-prep-synthesis',
            customerName: customer.name,
            model: 'full',
            timeoutMs: 120_000,
          }
        )
        return retryResult.text
      }
    )
    prepContent = gateResult.output
    qualityScorecard = gateResult.scorecard
  }

  // ── Step 4b: Inject deterministic Sales Alignment block (#445) ─────────
  const salesAlignmentBlock = buildSalesAlignmentBlock(productSlugs, slug)
  if (salesAlignmentBlock) {
    // Insert after "### 4. Value Play" section, before "### 5. Discussion Questions"
    const section5Marker = '### 5.'
    const idx = prepContent.indexOf(section5Marker)
    if (idx !== -1) {
      prepContent = prepContent.slice(0, idx) + '\n' + salesAlignmentBlock + '\n\n' + prepContent.slice(idx)
      console.log(`[meeting-prep] Sales alignment block injected for ${customer.name}`)
    } else {
      // Fallback: append after the Value Play section by finding ### 5 pattern
      const altMarker = '### 5 '
      const altIdx = prepContent.indexOf(altMarker)
      if (altIdx !== -1) {
        prepContent = prepContent.slice(0, altIdx) + '\n' + salesAlignmentBlock + '\n\n' + prepContent.slice(altIdx)
        console.log(`[meeting-prep] Sales alignment block injected (alt marker) for ${customer.name}`)
      } else {
        // Last resort: append to end
        prepContent += '\n\n' + salesAlignmentBlock
        console.log(`[meeting-prep] Sales alignment block appended for ${customer.name} (no section 5 marker found)`)
      }
    }
  }

  // ── Step 5: Save to Google Drive as HTML-imported Google Doc ────────────

  let docUrl = ''
  const docTitle = `Meeting Prep — ${meeting.meetingTitle} — ${meetingDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`

  try {
    const customerFolderId = await findCustomerDriveFolder(customer)
    const prepFolderId = await driveClient.ensureChildFolder(customerFolderId, 'Meeting Prep')

    // Generate styled HTML from Gemini's markdown output
    const htmlContent = generateMeetingPrepHTML(prepContent, {
      customerName: customer.name,
      meetingTitle: meeting.meetingTitle,
      dateStr,
      preparedFor: accountTeam.find(m => m.role === 'ae')?.name || accountTeam[0]?.name || 'Account Team',
    })

    // Delete existing docs with same name (like upsertDoc replace mode)
    const auth = makeAuth(GOOGLE_UNIFIED_TOKEN_PATH)
    const drive = google.drive({ version: 'v3', auth })
    const DOC_MIME = 'application/vnd.google-apps.document'

    const existing = await drive.files.list({
      q: `'${prepFolderId}' in parents and name = '${docTitle.replace(/'/g, "\\'")}' and mimeType = '${DOC_MIME}' and trashed = false`,
      fields: 'files(id)',
      pageSize: 10,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    })
    for (const f of existing.data.files ?? []) {
      if (f.id) await drive.files.delete({ fileId: f.id, supportsAllDrives: true } as any)
    }

    // Create Google Doc from HTML — single API call, perfect formatting
    const docResponse = await drive.files.create({
      requestBody: {
        name: docTitle,
        mimeType: DOC_MIME,
        parents: [prepFolderId],
      },
      media: {
        mimeType: 'text/html',
        body: Readable.from(Buffer.from(htmlContent)),
      },
      fields: 'id,webViewLink',
      supportsAllDrives: true,
    })

    docUrl = docResponse.data.webViewLink ?? `https://docs.google.com/document/d/${docResponse.data.id}/edit`
    console.log(`[meeting-prep] Doc created: ${docUrl}`)
  } catch (e: any) {
    console.warn(`[meeting-prep] Drive doc creation failed:`, e.message)
    // Continue without Drive doc — still return the generated content
    docUrl = ''
  }

  // ── Step 6: Cache the result ──────────────────────────────────────────────

  const generatedAt = new Date().toISOString()
  const generatedActionItems = extractActionItems(prepContent)
  const entry: PrepHistoryEntry = {
    meetingTitle: meeting.meetingTitle,
    meetingStart: meeting.meetingStart,
    docUrl,
    title: docTitle,
    generatedAt,
    customerName: customer.name,
    recurringEventId: meeting.recurringEventId,
    actionItems: generatedActionItems.length > 0 ? generatedActionItems : undefined,
  }

  appendHistory(slug, entry)

  // Also cache the full content for offline access
  const contentCacheDir = resolve(CACHE_DIR, 'meeting-prep')
  if (!existsSync(contentCacheDir)) mkdirSync(contentCacheDir, { recursive: true })
  const contentPath = resolve(contentCacheDir, `${slug}-latest.json`)
  writeJsonAtomic(contentPath, {
    ...entry,
    content: prepContent,
    qualityScorecard,
  })

  return { docUrl, title: docTitle, generatedAt }
}
