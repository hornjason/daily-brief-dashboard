/**
 * Meeting Prep API — GitHub Issue #229
 *
 * Three endpoints:
 * - GET  /api/customer/:name/meetings          — calendar events for this customer
 * - POST /api/customer/:name/meeting-prep/generate — generate a meeting prep doc
 * - GET  /api/customer/:name/meeting-prep/history  — previously generated prep docs
 *
 * Follows campaigns-routes.ts pattern: generation function, cache read/write,
 * Drive doc creation, in-flight guard.
 */

import { Hono } from 'hono'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { resolve } from 'path'
import { Readable } from 'stream'
import { google } from 'googleapis'
import { callGemini } from './gemini-call.ts'
import { driveClient } from './lib/drive-client.ts'
import { findCustomerDriveFolder } from './lib/customer-folder.ts'
import { customers } from './server-state.ts'
import { toSlug } from './cache-layer.ts'
import { sanitizeErr } from './utils.ts'
import { fetchCalendar, makeAuth, GOOGLE_UNIFIED_TOKEN_PATH } from './google.ts'
import { fetchCustomerMeetings } from './customer.ts'
import { assembleMeetingPrep } from './calendar-extraction.ts'
import { loadCustomerSignals } from './lib/signal-loader.ts'
import { getAccountTeam, toPromptContext } from './account-team.ts'
import { getValueMap } from './value-map-loader.ts'
import { fetchCases } from './redhat.ts'
import type { Customer, CalendarEvent, SupportCase, CustomerSubscription } from './types.ts'
import { writeJsonAtomic } from './lib/atomic-write.ts'
import { readProductLifecycleCache } from './product-lifecycle.ts'
import { getAllProductSummaries } from './product-release-radar.ts'
import { getCachedCustomerProductIntel } from './customer-product-intel.ts'
import { getCachedExpansionOpportunities } from './expansion-opportunities.ts'
import { runIntelligencePipeline, getJobStatus } from './account-intelligence.ts'
import { readCCSPCache } from './cache-layer.ts'
import { generateMeetingPrepHTML } from './meeting-prep-html-template.ts'

// ── Config ────────────────────────────────────────────────────────────────────

const CACHE_DIR = process.env.CACHE_DIR ?? resolve(import.meta.dir, '../data/cache')
const CONFIG_DIR = process.env.CONFIG_DIR ?? resolve(import.meta.dir, '../data/config')

// ── Partner config ────────────────────────────────────────────────────────────

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

function loadProductRoadmap(): ProductRoadmapEntry[] {
  const roadmapPath = resolve(CONFIG_DIR, 'product-roadmap.json')
  if (!existsSync(roadmapPath)) return []
  try {
    const data = JSON.parse(readFileSync(roadmapPath, 'utf-8'))
    return data.releases ?? []
  } catch { return [] }
}

function buildCCSPContext(customer: Customer): string {
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

function loadPartnerConfig(): PartnerConfig[] {
  const configPath = resolve(CONFIG_DIR, 'partners.json')
  if (!existsSync(configPath)) return []
  try { return JSON.parse(readFileSync(configPath, 'utf-8')) } catch { return [] }
}

function findPartner(domain: string, partners: PartnerConfig[]): PartnerConfig | undefined {
  return partners.find(p => domain.endsWith(p.domain) || p.aliases.some(a => domain.includes(a.toLowerCase())))
}

// ── In-flight guard ──────────────────────────────────────────────────────────

const _prepInFlight = new Set<string>()

// ── Types ─────────────────────────────────────────────────────────────────────

interface PrepHistoryEntry {
  meetingTitle: string
  meetingStart: string
  docUrl: string
  title: string
  generatedAt: string
  customerName?: string
}

// ── Cache helpers ─────────────────────────────────────────────────────────────

function getPrepCacheDir(slug: string): string {
  return resolve(CACHE_DIR, 'meeting-prep')
}

function getHistoryPath(slug: string): string {
  return resolve(getPrepCacheDir(slug), `${slug}-history.json`)
}

function readHistory(slug: string): PrepHistoryEntry[] {
  const path = getHistoryPath(slug)
  if (!existsSync(path)) return []
  try {
    return JSON.parse(readFileSync(path, 'utf-8'))
  } catch {
    return []
  }
}

function appendHistory(slug: string, entry: PrepHistoryEntry): void {
  const dir = getPrepCacheDir(slug)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })

  const history = readHistory(slug)
  history.unshift(entry) // newest first
  writeJsonAtomic(getHistoryPath(slug), history)
}

// ── Route factory ────────────────────────────────────────────────────────────

function findCustomerByNameOrSlug(name: string): Customer | undefined {
  const lower = name.toLowerCase()
  return customers.find(cu => cu.name.toLowerCase() === lower) ??
    customers.find(cu => toSlug(cu.name) === lower)
}

export function createMeetingPrepRouter() {
  const router = new Hono()

  // ── GET /api/customer/:name/meetings ────────────────────────────────────
  // Returns meetings filtered to this customer + all meetings for "browse all"
  router.get('/api/customer/:name/meetings', async (c) => {
    const customerName = decodeURIComponent(c.req.param('name'))
    const customer = findCustomerByNameOrSlug(customerName)

    if (!customer) {
      return c.json({ error: `Customer "${customerName}" not found` }, 404)
    }

    try {
      // Fetch customer-specific meetings and all calendar events in parallel
      const [customerMeetings, allEvents] = await Promise.all([
        fetchCustomerMeetings(customer),
        fetchCalendar(customers, true),
      ])

      return c.json({
        meetings: customerMeetings,
        allMeetings: allEvents,
      })
    } catch (e: any) {
      console.error(`[meeting-prep] Failed to fetch meetings for ${customerName}:`, e.message)
      return c.json({ meetings: [], allMeetings: [], error: sanitizeErr(e) }, 500)
    }
  })

  // ── POST /api/customer/:name/meeting-prep/generate ──────────────────────
  router.post('/api/customer/:name/meeting-prep/generate', async (c) => {
    const customerName = decodeURIComponent(c.req.param('name'))
    const customer = findCustomerByNameOrSlug(customerName)

    if (!customer) {
      return c.json({ error: `Customer "${customerName}" not found` }, 404)
    }

    const body = await c.req.json<{
      meetingTitle: string
      meetingStart: string
      attendees: string[]
      context?: {
        objective?: string
        productFocus?: string[]
        notes?: string
        driveDocUrls?: string[]
      }
    }>()

    if (!body.meetingTitle || !body.meetingStart) {
      return c.json({ error: 'meetingTitle and meetingStart are required' }, 400)
    }

    const slug = toSlug(customer.name)
    const guardKey = `${slug}:${body.meetingTitle}:${body.meetingStart}`

    if (_prepInFlight.has(guardKey)) {
      return c.json({ error: 'Meeting prep generation already in progress for this meeting' }, 409)
    }

    _prepInFlight.add(guardKey)

    try {
      const result = await generateMeetingPrep(customer, body)
      return c.json(result)
    } catch (e: any) {
      console.error(`[meeting-prep] Generation failed for ${customerName}:`, e.message)
      return c.json({ error: sanitizeErr(e) }, 500)
    } finally {
      _prepInFlight.delete(guardKey)
    }
  })

  // ── GET /api/customer/:name/meeting-prep/history ────────────────────────
  router.get('/api/customer/:name/meeting-prep/history', async (c) => {
    const customerName = decodeURIComponent(c.req.param('name'))
    const customer = findCustomerByNameOrSlug(customerName)

    if (!customer) {
      return c.json({ error: `Customer "${customerName}" not found` }, 404)
    }

    const slug = toSlug(customer.name)
    const history = readHistory(slug).map(entry => ({
      ...entry,
      customerName: entry.customerName || customer.name,
    }))

    return c.json({ history })
  })

  // ── DELETE /api/customer/:name/meeting-prep/:index ─────────────────────
  // Removes a prep doc from history and optionally deletes the Google Drive file
  router.delete('/api/customer/:name/meeting-prep/:index', async (c) => {
    const customerName = decodeURIComponent(c.req.param('name'))
    const customer = findCustomerByNameOrSlug(customerName)

    if (!customer) {
      return c.json({ error: `Customer "${customerName}" not found` }, 404)
    }

    const index = parseInt(c.req.param('index'))
    const slug = toSlug(customer.name)
    const history = readHistory(slug)

    if (isNaN(index) || index < 0 || index >= history.length) {
      return c.json({ error: 'Invalid history index' }, 400)
    }

    const entry = history[index]

    // Delete from Google Drive if docUrl exists
    if (entry.docUrl) {
      try {
        // Extract doc ID from URL
        const docIdMatch = entry.docUrl.match(/\/d\/([a-zA-Z0-9_-]+)/)
        if (docIdMatch?.[1]) {
          const auth = makeAuth(GOOGLE_UNIFIED_TOKEN_PATH)
          const drive = google.drive({ version: 'v3', auth })
          await drive.files.delete({ fileId: docIdMatch[1], supportsAllDrives: true } as any)
          console.log(`[meeting-prep] Deleted Drive doc: ${docIdMatch[1]}`)
        }
      } catch (e: any) {
        console.warn(`[meeting-prep] Drive delete failed (continuing):`, e?.message ?? e)
        // Continue to remove from history even if Drive delete fails
      }
    }

    // Remove from history — use writeFileSync directly because writeJsonAtomic's
    // stale-overwrite guard blocks writing [] to a non-empty file (legitimate delete of last entry)
    history.splice(index, 1)
    const dir = getPrepCacheDir(slug)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    writeFileSync(getHistoryPath(slug), JSON.stringify(history, null, 2), { mode: 0o600 })

    return c.json({ deleted: true, remaining: history.length })
  })

  return router
}

// ── Generation logic ─────────────────────────────────────────────────────────

function deriveCompanyFromDomain(email: string): string {
  const domain = email.split('@')[1] ?? ''
  const company = domain.split('.')[0] ?? ''
  return company.charAt(0).toUpperCase() + company.slice(1)
}

function getAttendeeDisplayName(meeting: { attendees: string[]; attendeeDetails?: Array<{ email: string; displayName?: string }> }, email: string): string {
  const detail = (meeting.attendeeDetails ?? []).find(d => d.email === email)
  if (detail?.displayName) return detail.displayName
  // Derive from email: courtney.jimenez@insight.com → Courtney Jimenez
  const local = email.split('@')[0] ?? ''
  return local.split(/[._-]/).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
}

function detectPartnerDomains(
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

function getCustomerProductSlugs(customer: Customer): string[] {
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

async function generateMeetingPrep(
  customer: Customer,
  meeting: {
    meetingTitle: string
    meetingStart: string
    attendees: string[]
    attendeeDetails?: Array<{ email: string; displayName?: string }>
    context?: {
      objective?: string
      productFocus?: string[]
      notes?: string
      driveDocUrls?: string[]
    }
  }
): Promise<{ docUrl: string; title: string; generatedAt: string }> {
  const slug = toSlug(customer.name)
  const meetingDate = new Date(meeting.meetingStart)
  const dateStr = meetingDate.toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  })

  console.log(`[meeting-prep] Generating prep for ${customer.name} — "${meeting.meetingTitle}" on ${dateStr}`)

  // ── Step 1: Gather all context in parallel ──────────────────────────────

  const [
    meetingPrepData,
    signalData,
    casesData,
  ] = await Promise.all([
    // assembleMeetingPrep for attendee context + health signals
    assembleMeetingPrepForMeeting(customer, meeting),
    // Customer signals (intelligence, product intel, etc.)
    loadCustomerSignals(slug, customer.name).catch((e) => {
      console.warn(`[meeting-prep] Signal loading failed:`, e.message)
      return { signals: {}, registrySignals: [], loaded: [], missing: [] }
    }),
    // Support cases
    fetchCases({ includeAll: false }).catch(() => [] as SupportCase[]),
  ])

  // Account team
  const accountTeam = getAccountTeam(customer)
  const teamContext = toPromptContext(accountTeam)

  // Value map for products customer uses
  const valueMapSections = buildValueMapContext(customer)

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
  const expansionOpps = getCachedExpansionOpportunities(slug)

  // Internal roadmap data (manually maintained release dates)
  const roadmapData = loadProductRoadmap()

  // Customer-product intel (per product)
  const customerProductIntel: string[] = []
  for (const ps of productSlugs) {
    const intel = getCachedCustomerProductIntel(ps, slug)
    if (intel && intel.relevanceScore !== 'NONE') {
      customerProductIntel.push(
        `**${ps.toUpperCase()}** (${intel.relevanceScore}): ${intel.priorityAction}` +
        (intel.featureTalkingPoints?.length
          ? '\n' + intel.featureTalkingPoints.slice(0, 3).map(f => `  - ${f.feature} (${f.status}): ${f.reason}`).join('\n')
          : '')
      )
    }
  }

  // Build context strings
  const lifecycleContext = lifecycleCache?.products?.length
    ? lifecycleCache.products
        .filter(p => productSlugs.length === 0 || productSlugs.includes(p.slug))
        .map(p => {
          // Merge roadmap data — current version override + next version
          const roadmap = roadmapData.find(r => r.product === p.slug)
          const currentVer = (roadmap as any)?.currentVersionOverride ?? p.currentVersion
          const nextVer = roadmap?.nextVersion ?? p.nextVersion
          const nextDate = roadmap?.expectedDate ?? p.nextExpected?.slice(0, 10)
          const highlights = roadmap?.highlights?.length ? ` — ${roadmap.highlights.slice(0, 3).join(', ')}` : ''
          return `${p.displayName}: v${currentVer} (GA: ${p.gaDate?.slice(0, 10) ?? '?'}, EOL: ${p.eolDate?.slice(0, 10) ?? '?'})${nextVer ? ` → Next: v${nextVer} (expected ${nextDate ?? 'TBD'})${highlights}` : ''}`
        })
        .join('\n')
    : ''

  const releaseRadarContext = productSummaries
    .filter(p => productSlugs.length === 0 || productSlugs.includes(p.slug))
    .map(p => `**${p.displayName}** (${p.currentVersion ?? 'unknown'}):\n${(p.summaryBullets ?? []).slice(0, 3).map(b => `  - ${b}`).join('\n')}`)
    .join('\n\n')

  const relevantRSS = rssItems
    .filter(item => productSlugs.length === 0 || (item.productTags ?? []).some(tag => productSlugs.includes(tag.toLowerCase())))
    .slice(0, 10)
  const rssContext = relevantRSS.length
    ? relevantRSS.map(item => `- [${item.source}] ${item.title} (${new Date(item.pubDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })})\n  ${item.link}`).join('\n')
    : ''

  const productIntelContext = customerProductIntel.length
    ? customerProductIntel.join('\n\n')
    : ''

  const expansionContext = expansionOpps?.recommendations?.length
    ? expansionOpps.recommendations.map(r => `- **${r.product}** (${r.confidence}): ${r.why}`).join('\n')
    : ''

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
        return `- "${name}" at ${customer.name} (${email}) — search: "${name}" site:linkedin.com ${customer.name}`
      }).join('\n')

      const attendeeResult = await callGemini(
        'You are an expert sales intelligence researcher. For each attendee, find their LinkedIn profile at the specified company. Return detailed, specific information. If you cannot find someone, state "Profile not found" — never guess or return a wrong person.',
        `Research these customer attendees from ${customer.name}:
${attendeeLines}

For each attendee, provide:
1. **Full Name & Title** — current title at ${customer.name}
2. **Background** — career history, key skills, certifications
3. **Key Signals** — buyer intent indicators, conference talks, Red Hat experience
4. **Engagement Angle** — specific talking points for this meeting

Format as a markdown table:
| Name & Title | Background | Key Signals | Engagement Angle |
|---|---|---|---|`,
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
      const productSlugs = getCustomerProductSlugs(customer)
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
        partnerResearch += '\n\n**Other Certified Partners for These Products:**\n' +
          relevantPartners.slice(0, 5).map(p => `- ${p.name}: ${p.specializations.join(', ')}`).join('\n')
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

  // ── Step 4: Synthesize full meeting prep document via Gemini ─────────────

  const systemPrompt = `You are generating a Red Hat sales positioning document for a customer meeting. This is NOT an information dump — every line must help the account team sell.

RULES:
- Every claim MUST cite specific customer data (their goals, infrastructure, case numbers, renewal dates, subscription quantities)
- NO generic value statements. "Improves efficiency" is forbidden. "Reduces Taylor Fresh Foods' playbook creation time by 60% across their 10 AAP managed nodes (Forrester TEI)" is required.
- Cross-reference the business value map data against the customer's stated goals — match each value prop to a SPECIFIC customer objective
- ALL data sections use markdown tables with | delimiters and |---| separator rows
- Keep each section to 3-8 lines max (not counting table rows)
- If data is missing: ONE line: "Data not available — generate intelligence for this customer"
- Only include products the customer subscribes to. Do NOT add products they don't have unless specifically listed under Expansion Opportunities.`

  const userPrompt = `Generate a sales positioning meeting prep for:

## Meeting Details
- Customer: ${customer.name}
- Meeting: ${meeting.meetingTitle}
- Date: ${dateStr}
- Attendees: ${attendeeEmails.map(e => getAttendeeDisplayName(meeting, e)).join(', ') || 'Not specified'}
${teamContext ? `\n${teamContext}` : ''}
${meeting.context?.objective ? `\n## MEETING OBJECTIVE (from account team — THIS IS THE #1 PRIORITY)\n${meeting.context.objective}\n` : ''}
${meeting.context?.notes ? `\n## ADDITIONAL CONTEXT (from account team)\n${meeting.context.notes}\n` : ''}
${meeting.context?.productFocus?.length ? `\n## PRODUCT FOCUS (account team specified)\nFocus ALL content on these products: ${meeting.context.productFocus.join(', ')}. Other products should only appear in Expansion Opportunities if relevant.\n` : ''}

## Customer Subscriptions (ONLY show these products)
${(() => {
  const { readSheetCache } = require('./cache-layer.ts')
  const sc = readSheetCache(customer.name)
  if (!sc?.rows?.length) return 'No subscription data available'
  return sc.rows.map((r: any) => `- ${r.productDescription ?? 'Unknown'}: ${r.quantity ?? '?'} units (expires ${r.endDate ?? '?'})`).join('\n')
})()}

## Customer Intelligence
${intelligenceContext || 'Data not available — generate intelligence for this customer'}

${ccspContext ? `## Cloud Consumption & Spend (CCSP)\n${ccspContext}\nUse this data to recommend cloud-specific Red Hat services (ROSA for AWS, ARO for Azure, OSD for GCP) and position cross-cloud consistency with OpenShift.` : ''}

${accountPlanContext ? `## Account Plan & Notes\n${accountPlanContext}` : ''}

## Business Value Maps (for subscribed products)
${valueMapSections || 'No value map data available'}

## Product Announcements (subscribed products only)
${releaseRadarContext || 'No release data available'}

## Product Lifecycle
${lifecycleContext || 'No lifecycle data available'}

## Recent Red Hat News
${rssContext || 'No recent news available'}

## Expansion Opportunities
${expansionContext || 'No expansion analysis available'}

## Partner Context
${partnerResearch || 'No partner information'}

## Attendee Research
${attendeeResearch || 'No attendee research available'}

## Health Signals
- Open Cases: ${meetingPrepData?.healthSignals?.cases || 'Unknown'}
- Renewals: ${meetingPrepData?.healthSignals?.renewals || 'Unknown'}

## Open Support Cases
${caseSummary}

---

Generate the document with these EXACT 10 sections:

# Meeting Prep: ${customer.name} — ${meeting.meetingTitle}
**${dateStr}** | Prepared for: ${accountTeam.find(m => m.role === 'ae')?.name || accountTeam[0]?.name || 'Account Team'}

### 1. Meeting Objective
[State the meeting purpose. If attendees are from a partner/integrator, focus on the partnership objective for ${customer.name}. 2-3 lines max.]

### 2. ${detectedPartners.length > 0 ? 'Partner Context' : 'Meeting Attendees'}
${detectedPartners.length > 0
  ? `[For the partner(s) in this meeting, show:
| Partner | Specialization | Role with ${customer.name} | Recommended Focus |
|---|---|---|---|
Also note other certified partners that could help. Skip individual attendee profiles.]`
  : `[Customer attendees table:
| Name & Title | Background | Key Signals | Engagement Angle |
|---|---|---|---|]`}

### 3. Customer Snapshot
[3-5 bullet points from intelligence: infrastructure, strategic direction, key initiatives. Be specific.]

### 4. Why Red Hat
[THIS IS THE MOST IMPORTANT SECTION. Cross-reference value maps against customer goals:]
| Customer Goal | Red Hat Solution | Business Impact | Proof Point |
|---|---|---|---|
[Every row must cite a specific customer goal from the intelligence data AND a specific metric from the value map. Minimum 3 rows, maximum 6.]

### 5. What's New
[ONLY products the customer subscribes to. No other products.]
| Product | Announcement | Why It Matters for ${customer.name} |
|---|---|---|
[Each "Why It Matters" must reference specific customer data — their infrastructure, goals, or pain points.]

### 6. Product Lifecycle
| Product | Current | Next Version | Next Expected | EOL Date |
|---|---|---|---|---|
[ONLY subscribed products. Flag EOL within 12 months.]

### 7. Expansion Opportunities
[Products the customer DOESN'T have but SHOULD based on real signals:]
| Product | Signal | Business Case | Next Step |
|---|---|---|
[Only include if there's a real signal. If no expansion signals, state "No expansion signals identified."]

### 8. Discussion Questions
| For | Question | Purpose |
|---|---|---|
[7-10 questions. "For" = specific attendee name. "Purpose" = cite the specific signal. Questions should ADVANCE THE SALE — discover budget, timeline, decision criteria, competitive alternatives.]

### 9. Open Cases & Renewals
| Type | Detail | Status | Action |
|---|---|---|---|
[Cases and renewals with specific recommended actions. Renewals within 90 days = URGENT.]

### 10. Action Items
| Who | Action | When |
|---|---|---|
[Specific team member names. Pre/during/post meeting. Include "share X blog post with Y" items from news section.]`

  const geminiResult = await callGemini(systemPrompt, userPrompt, {
    callType: 'meeting-prep-synthesis',
    customerName: customer.name,
    model: 'full',
    timeoutMs: 120_000,
  })

  const prepContent = geminiResult.text

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
  const entry: PrepHistoryEntry = {
    meetingTitle: meeting.meetingTitle,
    meetingStart: meeting.meetingStart,
    docUrl,
    title: docTitle,
    generatedAt,
    customerName: customer.name,
  }

  appendHistory(slug, entry)

  // Also cache the full content for offline access
  const contentCacheDir = resolve(CACHE_DIR, 'meeting-prep')
  if (!existsSync(contentCacheDir)) mkdirSync(contentCacheDir, { recursive: true })
  const contentPath = resolve(contentCacheDir, `${slug}-latest.json`)
  writeJsonAtomic(contentPath, {
    ...entry,
    content: prepContent,
  })

  return { docUrl, title: docTitle, generatedAt }
}

// ── Helper: assemble meeting prep data for a specific meeting ──────────────

async function assembleMeetingPrepForMeeting(
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

// ── Helper: build value map context from customer subscriptions ────────────

function buildValueMapContext(customer: Customer): string {
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

// ── Helper: build intelligence context from cache ──────────────────────────

function buildIntelligenceContext(slug: string): string {
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

// ── Helper: fallback attendee table when Gemini grounding fails ────────────

function buildFallbackAttendeeTable(
  attendees: string[],
  prepData: any,
  meeting?: { attendeeDetails?: Array<{ email: string; displayName?: string }> }
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
