import { readFileSync, existsSync } from 'fs'
import { writeJsonAtomic } from './lib/atomic-write.ts'
import { resolve } from 'path'
import { createHash } from 'crypto'
import { streamSSE } from 'hono/streaming'
import { Hono } from 'hono'
import { fetchCalendar, GOOGLE_UNIFIED_TOKEN_PATH } from './google.ts'
import { fetchCases, fetchCustomerCases, fetchCustomerSubscriptions, fetchCaseLatestComment } from './redhat.ts'
import { fetchCustomerMeetings, fetchCustomerEmails, fetchCustomerDocs, generateBrief } from './customer.ts'
import { fetchCustomerSheetData, fetchCustomerSheetRaw, fetchCCSPData, fetchCustomerAccountNumbers } from './sheets.ts'
import type { CCSPRecord } from './sheets.ts'
import { buildPipelineSummary, fetchPipelineData } from './pipeline.ts'
import type { PipelineRecord } from './pipeline.ts'
import { customers, aes, CUSTOMERS_PATH } from './server-state.ts'
import { lastCcspError } from './ccsp-scraper.ts'
import { sfSyncError } from './sf-scraper.ts'
import { runIntelligencePipeline, getJobStatus, getRunningJob, getAllJobs, requeueJob, validateIntelligenceDocContent, checkStoredDocsTrashed, discoverExistingIntelDocs, getIntelligenceCacheEntry, writeIntelligenceDiscoveryCache } from './account-intelligence.ts'
import { queryProductIntelligence } from './product-intelligence.ts'
import type { ProductKey } from './product-intelligence.ts'
import { readBriefCache, writeBriefCache, readLatestBriefCache, readSheetCache, writeSheetCache, readCCSPCache, writeCCSPCache, readPipelineCache, writePipelineCache, BRIEF_CACHE_TTL_MS, toSlug, isCCSPCacheStale } from './cache-layer.ts'
import { sanitizeErr, normalizeForQuery } from './utils.ts'
import { getCachedExpansionOpportunities, generateExpansionOpportunities, toCustomerSlug as toExpansionSlug } from './expansion-opportunities.ts'
import { writeCustomerDocsCorpus } from './customer-docs-corpus.ts'
import { generateAndSaveAccountPlan, readAccountPlan } from './account-plan.ts'
import { getAiConfig } from './settings-api.ts'

// ── Module state ─────────────────────────────────────────────────────────────
let CACHE_DIR = ''

// ── BKL-AI06: Batch intelligence generation state ────────────────────────────
let _batchState: {
  running: boolean
  total: number
  completed: number
  failed: number
  current: string | null
  startedAt: string | null
  completedAt: string | null
  errors: { customer: string; error: string }[]
} = { running: false, total: 0, completed: 0, failed: 0, current: null, startedAt: null, completedAt: null, errors: [] }

// In-flight dedup for /api/briefs/pregen-all. Keyed on podId (or '__global__'
// when no podId is supplied). Two concurrent requests for the same POD — e.g.
// different AEs in the same POD both triggering pregen after bootstrap — will
// otherwise duplicate the Gemini + Drive calls across every customer in the
// POD. Entries are removed in a finally block when the background task ends.
const _pregenInFlight = new Set<string>()

export function initCustomerRoutes(opts: {
  cacheDir: string
  customersPath: string
}): void {
  CACHE_DIR = opts.cacheDir
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function extractBriefSummary(text: string): { overview: string; talkingPoints: string[]; openCasesNote: string } {
  // Account Overview section
  const overviewMatch = text.match(/## Account Overview\n([\s\S]*?)(?=\n##)/)
  const overview = overviewMatch ? overviewMatch[1].trim().slice(0, 400) : ''

  // Talking Points bullets — header varies e.g. "## Talking Points & Prep (Mar 24 ...)"
  const talkingMatch = text.match(/## Talking Points[^\n]*\n([\s\S]*?)(?=\n##|$)/)
  const talkingPoints = talkingMatch
    ? talkingMatch[1].split('\n').filter((l) => /^[-*]|\d+\./.test(l.trim())).map((l) => l.replace(/^[-*\d.]+\s*\*{0,2}/, '').replace(/\*{0,2}$/, '').trim().slice(0, 120)).filter(Boolean).slice(0, 4)
    : []

  // Open cases note
  const casesMatch = text.match(/## Open Support Cases\n([\s\S]*?)(?=\n##)/)
  const openCasesNote = casesMatch ? casesMatch[1].trim().slice(0, 200) : ''

  return { overview, talkingPoints, openCasesNote }
}

function buildCCSPSummary(records: CCSPRecord[], cachedAt: string, sourceWarning: boolean) {
  const byCustomer    = new Map<string, number>()
  const byQuarter     = new Map<string, number>()
  const byPartner     = new Map<string, number>()
  const custPartner   = new Map<string, Map<string, number>>()
  const byAE          = new Map<string, { acv: number; byQuarter: Map<string, number>; byCustomer: Map<string, number> }>()
  let totalAcv = 0

  for (const r of records) {
    byCustomer.set(r.accountName, (byCustomer.get(r.accountName) ?? 0) + r.acvPlus)
    if (r.quarter) byQuarter.set(r.quarter, (byQuarter.get(r.quarter) ?? 0) + r.acvPlus)
    byPartner.set(r.cloudPartner, (byPartner.get(r.cloudPartner) ?? 0) + r.acvPlus)
    totalAcv += r.acvPlus
    // Per-account partner breakdown
    if (!custPartner.has(r.accountName)) custPartner.set(r.accountName, new Map())
    const pm = custPartner.get(r.accountName)!
    pm.set(r.cloudPartner, (pm.get(r.cloudPartner) ?? 0) + r.acvPlus)
    // Per-AE aggregation (BKL-W2-28)
    if (r.ae) {
      if (!byAE.has(r.ae)) byAE.set(r.ae, { acv: 0, byQuarter: new Map(), byCustomer: new Map() })
      const aeData = byAE.get(r.ae)!
      aeData.acv += r.acvPlus
      if (r.quarter) aeData.byQuarter.set(r.quarter, (aeData.byQuarter.get(r.quarter) ?? 0) + r.acvPlus)
      aeData.byCustomer.set(r.accountName, (aeData.byCustomer.get(r.accountName) ?? 0) + r.acvPlus)
    }
  }

  const sortedCustomers = [...byCustomer.entries()].sort((a, b) => b[1] - a[1])

  return {
    totalAcv,
    cachedAt,
    sourceWarning,
    byCustomer: sortedCustomers.map(([name, acv]) => ({
      name,
      acv,
      partners: [...(custPartner.get(name)?.entries() ?? [])]
        .sort((a, b) => b[1] - a[1])
        .map(([partner, acv]) => ({ partner, acv })),
    })),
    byQuarter: [...byQuarter.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([quarter, acv]) => ({ quarter, acv })),
    byPartner: [...byPartner.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([partner, acv]) => ({ partner, acv })),
    byAE: [...byAE.entries()].map(([ae, data]) => ({
      ae,
      acv: data.acv,
      byQuarter: [...data.byQuarter.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([quarter, acv]) => ({ quarter, acv })),
      topAccounts: [...data.byCustomer.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([name, acv]) => ({ name, acv })),
    })),
  }
}

// BKL-M05: Query-oriented normalizer — differs from normalizeForMatch by also stripping long business-line phrases (life and safety, digital media) for substring overlap matching against cached CCSP/pipeline records.
// Shared fuzzy name normalizer for customer URL-param queries against cached records.
// Strips common legal suffixes and punctuation for substring overlap matching.
// GET /api/pipeline — Open opportunity pipeline from Drive XLS
// BKL-SF-01: Filter cached pipeline records to configured AEs.
// Primary: match record.territory against ae.tableauTerritories (exact, case-insensitive).
// Fallback: owner-name prefix match for records without a territory field (backward compat with pre-territory cache).
function filterToAEs(records: PipelineRecord[]): PipelineRecord[] {
  if (!aes.length) return records
  // Pre-compute territory lookup: lowercase territory string → true
  const aeTerritorySet = new Set<string>()
  for (const ae of aes) {
    for (const t of ae.tableauTerritories ?? []) aeTerritorySet.add(t.toLowerCase())
  }
  // Pre-compute name parts for fallback matching
  const aeParts = aes.map(a => {
    const parts = a.name.toLowerCase().split(/\s+/)
    return { full: a.name.toLowerCase(), first: parts[0] ?? '', last: parts.slice(1).join(' ') }
  })
  return records.filter(r => {
    // Primary: territory match
    if (r.territory && aeTerritorySet.has(r.territory.toLowerCase())) return true
    // Fallback: owner name match (for records without territory)
    const ownerLower = r.owner.toLowerCase()
    const ownerParts = ownerLower.split(/\s+/)
    const ownerFirst = ownerParts[0] ?? ''
    const ownerLast = ownerParts.slice(1).join(' ')
    return aeParts.some(ae =>
      ae.full === ownerLower ||
      (ae.last === ownerLast && ae.last !== '' && (ownerFirst.startsWith(ae.first) || ae.first.startsWith(ownerFirst)))
    )
  })
}

// BKL-UX117: Filter cached pipeline records to a single AE by owner-name match.
// Applied AFTER filterToAEs so the whitelist still runs first.
function filterToSingleAE(records: PipelineRecord[], aeParam: string): PipelineRecord[] {
  const needle = aeParam.trim().toLowerCase()
  return records.filter(r => r.owner.toLowerCase() === needle)
}

// ── Route registration ────────────────────────────────────────────────────────

export function createCustomerRouter(): Hono {
  const router = new Hono()

  // ── Customer data endpoints ───────────────────────────────────────────────

  // GET /api/briefs — Brief summaries for all customers (from cache)
  router.get('/api/briefs', (c) => {
    const result: Record<string, { overview: string; talkingPoints: string[]; openCasesNote: string; cachedAt: string; date: string }> = {}
    for (const customer of customers) {
      const cached = readLatestBriefCache(customer.name)
      if (cached?.text) {
        result[customer.name] = { ...extractBriefSummary(cached.text), cachedAt: cached.cachedAt, date: cached.date }
      }
    }
    return c.json(result)
  })

  // POST /api/briefs/pregen-all — non-blocking batch pre-generation of briefs for customers missing cache
  // BKL-BOOT-AI: Triggered after bootstrap to warm brief cache for all newly bootstrapped customers.
  // Returns immediately; generation runs in background at 10s/customer to stay within Drive API quota.
  // NOTE: registered BEFORE /api/briefs/:name pattern routes to avoid slug collision
  router.post('/api/briefs/pregen-all', async (c) => {
    // Per-POD dedup: two concurrent requests for the same POD would otherwise
    // each spin up a background loop over the same customer list. Caller may
    // pass podId via JSON body or `?podId=` query; absent that, dedupe globally.
    let podId: string | undefined
    try {
      const body = c.req.header('content-length') ? await c.req.json().catch(() => ({})) : {}
      if (body && typeof body === 'object' && typeof (body as any).podId === 'string') {
        podId = (body as any).podId
      }
    } catch { /* no body / invalid JSON — fall through to query/global key */ }
    if (!podId) podId = c.req.query('podId') || undefined
    const dedupKey = podId ?? '__global__'
    if (_pregenInFlight.has(dedupKey)) {
      return c.json({ status: 'already running for this pod', podId: podId ?? null }, 200)
    }

    const customerList = [...customers]
    const missing = customerList.filter(cu => !readBriefCache(cu.name))
    if (missing.length === 0) {
      return c.json({ message: 'All customers already have briefs cached', queued: 0 })
    }
    // Mark in-flight BEFORE spawning background work so a second request
    // arriving during the same tick sees the guard.
    _pregenInFlight.add(dedupKey)
    // Fire-and-forget background generation
    ;(async () => {
      try {
        console.log(`[briefs/pregen-all] starting background brief pre-generation for ${missing.length} customers (podId=${dedupKey})`)
        for (const customer of missing) {
          if (readBriefCache(customer.name)) continue  // already generated by another request
          try {
            const cachedSheet = readSheetCache(customer.name)
            const [meetings, emails, docs, cases, subscriptions, products] = await Promise.all([
              fetchCustomerMeetings(customer).catch(() => []),
              fetchCustomerEmails(customer).catch(() => []),
              fetchCustomerDocs(customer).catch(() => []),
              fetchCustomerCases(customer).catch(() => []),
              fetchCustomerSubscriptions(customer).catch(() => []),
              cachedSheet ? Promise.resolve(cachedSheet.rows) : fetchCustomerSheetData(customer).catch(() => []),
            ])
            const customerSlug = customer.name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '')
            writeCustomerDocsCorpus(customerSlug, docs as any[])
            const customerNeedle = normalizeForQuery(customer.name)
            const pipelineRecords = (readPipelineCache()?.records ?? []).filter(r => normalizeForQuery(r.accountName).includes(customerNeedle) || customerNeedle.includes(normalizeForQuery(r.accountName)))
            const ccspRecords = (readCCSPCache()?.records ?? []).filter(r => normalizeForQuery(r.accountName).includes(customerNeedle) || customerNeedle.includes(normalizeForQuery(r.accountName)))
            // BKL-ADR013-P2: compute input fingerprint so pre-generated briefs can be served
            // without a Gemini re-run on the next request if inputs haven't changed.
            const fingerprintSource = JSON.stringify({
              emails: (emails as any[]).map(e => `${e.date}|${e.from}|${e.subject}`),
              meetings: (meetings as any[]).map(m => `${m.start}|${m.title}`),
              docs: (docs as any[]).map(d => d.id ?? `${d.name}|${d.modifiedTime ?? ''}`),
              cases: (cases as any[]).map(r => r.caseNumber),
              subscriptions: (subscriptions as any[]).map(s => `${s.subscriptionNumber}|${s.status}|${s.endDate}`),
              products: (products as any[]).map(p => `${p.sku}|${p.status}|${p.endDate ?? ''}`),
              pipeline: pipelineRecords.map(r => r.oppId ?? r.oppNumber ?? r.accountName),
              ccsp: ccspRecords.map(r => `${r.accountName}|${r.cloudPartner}|${r.quarter ?? ''}`),
            })
            const inputFingerprint = createHash('sha256').update(fingerprintSource).digest('hex')
            const text = await generateBrief(customer, meetings as any, emails as any, docs as any, cases as any, subscriptions as any, products as any, pipelineRecords, ccspRecords)
            const lastEmail = (emails as any[])?.[0]?.date ? new Date((emails as any[])[0].date) : undefined
            const lastMeeting = (meetings as any[])?.[0]?.start ? new Date((meetings as any[])[0].start) : undefined
            const lastActivity = [lastEmail, lastMeeting].filter((d): d is Date => !!d).sort((a, b) => b.getTime() - a.getTime())[0]
            // BKL-AI-FP-09: build corpus snapshot for delta detection on next miss
            const corpusSnapshot: Record<string, string> = {}
            for (const d of (docs as any[])) { if (d.id) corpusSnapshot[d.id] = d.modifiedTime ?? '' }
            writeBriefCache(customer.name, text, lastActivity, inputFingerprint, corpusSnapshot)
            console.log(`[briefs/pregen-all] ${customer.name}: done`)
          } catch (e: any) {
            console.warn(`[briefs/pregen-all] ${customer.name}: ${e?.message}`)
          }
          await new Promise(r => setTimeout(r, 10_000))
        }
        console.log('[briefs/pregen-all] complete')
      } finally {
        // Always release the in-flight guard so future requests for this POD
        // can pick up newly-missing customers.
        _pregenInFlight.delete(dedupKey)
      }
    })().catch(e => console.error('[briefs/pregen-all] background task failed:', e?.message))
    return c.json({ message: 'Brief pre-generation started', queued: missing.length, podId: podId ?? null })
  })

  // GET /api/ccsp — Cloud spend data aggregated from CCSP Raw Data tabs
  // Optional ?products=OCP,RHEL filters records by productOfferingGroup before aggregating (LOG-06)
  // Optional ?ae=AE+Name filters records to a single AE (case-insensitive exact match)
  router.get('/api/ccsp', async (c) => {
    const force = c.req.query('force') === 'true'
    const productsParam = c.req.query('products')
    const aeParam = c.req.query('ae') ?? null
    const cached = readCCSPCache()

    // Map frontend product labels to actual productOfferingGroup values
    const PRODUCT_GROUP_MAP: Record<string, string> = {
      OCP: 'OPENSHIFT',
      RHEL: 'RHEL',
      AAP: 'AAP',
      Storage: 'STORAGE',
      'App Services': 'APPLICATION SERVICES',
    }
    // Build set of productOfferingGroup values to keep (case-insensitive matching)
    const productFilter = productsParam
      ? productsParam.split(',').map(p => (PRODUCT_GROUP_MAP[p.trim()] ?? p.trim()).toUpperCase()).filter(Boolean)
      : null

    function filterRecords(recs: CCSPRecord[]): CCSPRecord[] {
      let out = recs
      if (aeParam) {
        const ae = aeParam.trim().toLowerCase()
        out = out.filter(r => r.ae?.toLowerCase() === ae)
      }
      if (productFilter && productFilter.length > 0) {
        out = out.filter(r => r.productOfferingGroup && productFilter.includes(r.productOfferingGroup.toUpperCase()))
      }
      return out
    }

    // BKL-CCSP-03: Check if AE set changed since cache was written — if so, treat as stale
    const currentCcspSheetIds = aes.filter(a => a.ccspSheetId).map(a => a.ccspSheetId!)
    const cacheIsStale = isCCSPCacheStale(currentCcspSheetIds)
    // Use cache if available, not forced, and not stale (data doesn't change hourly)
    if (cached && !force && !cacheIsStale) {
      return c.json(buildCCSPSummary(filterRecords(cached.records), cached.cachedAt, !!lastCcspError))
    }
    try {
      const { records, fileIds } = await fetchCCSPData(aes.filter(a => a.ccspSheetId).map(a => ({ sheetId: a.ccspSheetId!, aeName: a.name })))
      // Stale-overwrite guard: don't replace populated cache with empty results
      // (empty usually means Tableau scraper wrote summary-view data without Account Name column)
      // BKL-CCSP-03: bypass guard when cache is stale from AE change — 0 records is valid for new AE set
      if (records.length === 0 && (cached?.records?.length ?? 0) > 0 && !cacheIsStale) {
        console.warn(`[ccsp] force-refresh returned 0 records but cache has ${cached!.records.length} — keeping existing cache`)
        return c.json(buildCCSPSummary(filterRecords(cached!.records), cached!.cachedAt, true))
      }
      writeCCSPCache(records, fileIds)
      return c.json(buildCCSPSummary(filterRecords(records), new Date().toISOString(), false))
    } catch (e: any) {
      console.error('[ccsp] fetchCCSPData failed:', e.message)
      if (cached) return c.json(buildCCSPSummary(filterRecords(cached.records), cached.cachedAt, true))
      return c.json({ error: 'CCSP data fetch failed', byCustomer: [], byQuarter: [], byPartner: [], totalAcv: 0, cachedAt: null, sourceWarning: true }, 500)
    }
  })

  router.get('/api/pipeline', async (c) => {
    const force = c.req.query('force') === 'true'
    const aeParam = c.req.query('ae') ?? null
    const cached = readPipelineCache()

    function applyFilters(records: PipelineRecord[]): PipelineRecord[] {
      let out = filterToAEs(records)
      if (aeParam) out = filterToSingleAE(out, aeParam)
      return out
    }

    // Serve from cache if available and not forced — no env var needed for cache hits
    if (cached && !force) {
      return c.json({ ...buildPipelineSummary(applyFilters(cached.records), cached.cachedAt), sourceWarning: !!sfSyncError })
    }
    if (!process.env.PIPELINE_FILE_ID) {
      return c.json({ totalAcv: 0, openCount: 0, renewalAcv: 0, newAcv: 0, byStage: [], byOwner: [], topOpps: [], cachedAt: null, sourceWarning: false })
    }
    try {
      const { records, fileIds } = await fetchPipelineData()
      writePipelineCache(records, fileIds)
      return c.json({ ...buildPipelineSummary(applyFilters(records), new Date().toISOString()), sourceWarning: false })
    } catch (e: any) {
      if (cached) return c.json({ ...buildPipelineSummary(applyFilters(cached.records), cached.cachedAt), sourceWarning: true })
      return c.json({ error: sanitizeErr(e), totalAcv: 0, openCount: 0, renewalAcv: 0, newAcv: 0, byStage: [], byOwner: [], topOpps: [], cachedAt: null, sourceWarning: true }, 500)
    }
  })

  // GET /api/calendar — Calendar events with range filter; ?all=true returns every event
  router.get('/api/calendar', async (c) => {
    const range = (c.req.query('range') ?? 'week') as 'today' | 'week'
    const includeAll = c.req.query('all') === 'true'
    // Short-circuit if Google OAuth token doesn't exist yet
    if (!existsSync(GOOGLE_UNIFIED_TOKEN_PATH)) {
      return c.json({ events: [], range, error: 'not_configured' })
    }
    try {
      const events = await fetchCalendar(customers, includeAll)
      return c.json({ events, range })
    } catch (e: any) {
      const msg = e.message ?? ''
      if (msg.includes('invalid_client') || msg.includes('invalid_grant') || msg.includes('No refresh token') || msg.includes('ENOENT')) {
        return c.json({ events: [], range, error: 'not_configured' })
      }
      return c.json({ events: [], range, error: sanitizeErr(e) }, 500)
    }
  })

  // GET /api/cases/all — Support cases across ALL accounts
  // ?includeAll=true returns closed/resolved cases too (default: open only)
  // ?account=NNNN filters to a specific account number
  router.get('/api/cases/all', async (c) => {
    try {
      const includeAll = c.req.query('includeAll') === 'true'
      const accountFilter = c.req.query('account')

      let allCases = await fetchCases({ includeAll }).catch(() => [])

      // BKL-SEC-25: validate ?account= is numeric before filtering
      if (accountFilter && !/^\d+$/.test(accountFilter)) {
        return c.json({ cases: [], totalCount: 0 })
      }
      if (accountFilter) {
        allCases = allCases.filter((sc) => String(sc.accountNumber) === accountFilter)
      }

      // BKL-CACHE-STALE-01: build an account-number set from the in-memory
      // customer store and exclude any case whose accountNumber doesn't match
      // a customer currently in customers.json. The disk cache may still hold
      // cases from previous POD/AE configurations after a reset; without this
      // filter those cases bleed through into /api/cases/all.
      // BKL-CASES-MATCH-01: only active customers — inactive customers are removed AEs;
      // their cases should not appear in the live feed (consistent with /api/accounts).
      const activeCustomers = customers.filter(cu => !cu.inactive)
      const currentAccountNums = new Set<string>()
      for (const cu of activeCustomers) {
        for (const num of cu.accountNumbers ?? []) {
          currentAccountNums.add(String(num))
        }
      }

      // Enrich with customer name by matching accountNumber, then drop
      // cases that don't belong to a customer currently in customers.json.
      const enriched = allCases
        .map((sc) => {
          const matched = activeCustomers.find((cu) =>
            (cu.accountNumbers ?? []).map(String).includes(String(sc.accountNumber))
          )
          return { ...sc, customerName: matched?.name ?? sc.customerName ?? 'Unknown', _matched: !!matched }
        })
        .filter((sc) => sc._matched || currentAccountNums.has(String(sc.accountNumber)))
        .map(({ _matched, ...sc }) => sc)

      return c.json({ cases: enriched, totalCount: enriched.length })
    } catch (e: any) {
      return c.json({ cases: [], totalCount: 0, error: sanitizeErr(e) }, 500)
    }
  })

  // GET /api/cases/:caseNumber/latest-comment — most recent comment for a case
  router.get('/api/cases/:caseNumber/latest-comment', async (c) => {
    const caseNumber = c.req.param('caseNumber')
    if (!/^\d{8}$/.test(caseNumber)) return c.json({ error: 'Invalid case number — must be 8 digits' }, 400)
    const comment = await fetchCaseLatestComment(caseNumber).catch(() => null)
    return c.json({ comment })
  })

  // ── Customer detail endpoints ─────────────────────────────────────────────

  // GET /customer/:name/brief — Customer brief from cache
  router.get('/customer/:name/brief', async (c) => {
    const rawName = decodeURIComponent(c.req.param('name'))
    const customer = customers.find((cu) => cu.name.toLowerCase() === rawName.toLowerCase())
    if (!customer) return c.json({ error: 'Customer not found' }, 404)

    const force = c.req.query('force') === 'true'

    try {
      // BKL-ADR013-P2: fetch all inputs first, then fingerprint, then compare to cached
      // fingerprint BEFORE calling generateBrief(). Underlying input fetchers are all
      // Tier-2/Tier-3 cached (ADR-013), so this is cheap. Gemini calls only happen on mismatch.
      const cachedSheet = readSheetCache(customer.name)
      const [meetings, emails, docs, cases, subscriptions, products] = await Promise.all([
        fetchCustomerMeetings(customer).catch(() => []),
        fetchCustomerEmails(customer).catch(() => []),
        fetchCustomerDocs(customer).catch(() => []),
        fetchCustomerCases(customer).catch(() => []),
        fetchCustomerSubscriptions(customer).catch(() => []),
        cachedSheet ? Promise.resolve(cachedSheet.rows) : fetchCustomerSheetData(customer).catch(() => []),
      ])
      // Wave 5: cache customer Drive docs corpus for product intel use
      const customerSlug = customer.name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '')
      writeCustomerDocsCorpus(customerSlug, docs)

      // BKL-AI21: filter pipeline + CCSP records for this customer before passing to brief
      const needle = normalizeForQuery(customer.name.toLowerCase())
      const pipelineCache = readPipelineCache()
      const pipelineRecords = pipelineCache
        ? pipelineCache.records.filter(r => {
            const hay = normalizeForQuery(r.accountName)
            return hay.length > 0 && (hay.includes(needle) || needle.includes(hay))
          }).filter(r => r.forecastCategory.toLowerCase() !== 'closed')
        : []
      const ccspCache = readCCSPCache()
      // BKL-CCSP-03: don't feed stale CCSP data into brief generation
      const ccspStale = isCCSPCacheStale(aes.filter(a => a.ccspSheetId).map(a => a.ccspSheetId!))
      const ccspRecords = (ccspCache && !ccspStale)
        ? ccspCache.records.filter(r => {
            const hay = normalizeForQuery(r.accountName)
            return hay.length > 0 && (hay.includes(needle) || needle.includes(hay))
          })
        : []

      // BKL-ADR013-P2: compute SHA256 fingerprint of all brief inputs. If unchanged
      // from the cached fingerprint, skip generateBrief() entirely (zero Gemini calls).
      const fingerprintSource = JSON.stringify({
        emails: emails.map(e => `${e.date}|${e.from}|${e.subject}`),
        meetings: meetings.map(m => `${m.start}|${m.title}`),
        docs: docs.map(d => d.id ?? `${d.name}|${d.modifiedTime ?? ''}`),
        cases: cases.map(caseRow => caseRow.caseNumber),
        subscriptions: subscriptions.map(s => `${s.subscriptionNumber}|${s.status}|${s.endDate}`),
        products: products.map(p => `${p.sku}|${p.status}|${p.endDate ?? ''}`),
        pipeline: pipelineRecords.map(r => r.oppId ?? r.oppNumber ?? r.accountName),
        ccsp: ccspRecords.map(r => `${r.accountName}|${r.cloudPartner}|${r.quarter ?? ''}`),
      })
      const inputFingerprint = createHash('sha256').update(fingerprintSource).digest('hex')

      // BKL-ADR013-P2: fingerprint check — serve cached brief when inputs unchanged.
      // `force=true` bypasses the check and forces regeneration.
      if (!force) {
        const cached = readBriefCache(customer.name)
        if (cached && cached.inputFingerprint === inputFingerprint) {
          console.log(`[brief] fingerprint match for ${customer.name} — serving from cache (no Gemini calls)`)
          return c.json({
            text: cached.text,
            cachedAt: cached.cachedAt,
            fromCache: true,
            fingerprintMatch: true,
          })
        }
      }

      const text = await generateBrief(customer, meetings, emails, docs, cases, subscriptions, products, pipelineRecords, ccspRecords)
      // BKL-ADR013-P2: persist fingerprint alongside brief so next call can short-circuit on match.
      const lastEmail = emails?.[0]?.date ? new Date(emails[0].date) : undefined
      const lastMeeting = meetings?.[0]?.start ? new Date(meetings[0].start) : undefined
      const lastActivity = [lastEmail, lastMeeting].filter((d): d is Date => !!d).sort((a, b) => b.getTime() - a.getTime())[0]
      // BKL-AI-FP-09: build corpus snapshot for delta detection on next miss
      const corpusSnapshot: Record<string, string> = {}
      for (const d of docs) { if (d.id) corpusSnapshot[d.id] = d.modifiedTime ?? '' }
      writeBriefCache(customer.name, text, lastActivity, inputFingerprint, corpusSnapshot)
      const freshCache = readBriefCache(customer.name)
      return c.json({ text, cachedAt: freshCache?.cachedAt ?? new Date().toISOString(), fromCache: false })
    } catch (e: any) {
      return c.json({ error: sanitizeErr(e) }, 500)
    }
  })

  // GET /customer/:name/ccsp — CCSP cloud spend for a single customer (from cache)
  router.get('/customer/:name/ccsp', (c) => {
    const rawName = decodeURIComponent(c.req.param('name')).toLowerCase()
    const cached = readCCSPCache()
    // BKL-CCSP-03: treat stale cache (AE set changed) as empty
    const ccspSheetIds = aes.filter(a => a.ccspSheetId).map(a => a.ccspSheetId!)
    if (!cached || isCCSPCacheStale(ccspSheetIds)) return c.json({ totalAcv: 0, byQuarter: [], byPartner: [] })

    // Fuzzy match: strip legal suffixes, check substring overlap
    const needle = normalizeForQuery(rawName)

    const byQuarter  = new Map<string, number>()
    const byPartner  = new Map<string, number>()
    let totalAcv = 0

    for (const r of cached.records) {
      const hay = normalizeForQuery(r.accountName)
      if (hay.length === 0 || (!hay.includes(needle) && !needle.includes(hay))) continue
      totalAcv += r.acvPlus
      if (r.quarter) byQuarter.set(r.quarter, (byQuarter.get(r.quarter) ?? 0) + r.acvPlus)
      byPartner.set(r.cloudPartner, (byPartner.get(r.cloudPartner) ?? 0) + r.acvPlus)
    }

    return c.json({
      totalAcv,
      cachedAt: cached.cachedAt,
      byQuarter: [...byQuarter.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([quarter, acv]) => ({ quarter, acv })),
      byPartner: [...byPartner.entries()].sort((a, b) => b[1] - a[1]).map(([partner, acv]) => ({ partner, acv })),
    })
  })

  // GET /customer/:name/pipeline — Pipeline opps for a single customer (from cache)
  router.get('/customer/:name/pipeline', (c) => {
    const rawName = decodeURIComponent(c.req.param('name')).toLowerCase()
    const cached = readPipelineCache()
    if (!cached) return c.json({ totalAcv: 0, openCount: 0, opps: [], closedOpps: [], cachedAt: null })

    const needle = normalizeForQuery(rawName)

    const open: typeof cached.records = []
    const closed: typeof cached.records = []

    for (const r of cached.records) {
      const hay = normalizeForQuery(r.accountName)
      if (hay.length === 0 || (!hay.includes(needle) && !needle.includes(hay))) continue
      if (r.forecastCategory.toLowerCase() === 'closed') closed.push(r)
      else open.push(r)
    }

    const totalAcv = open.reduce((s, r) => s + r.acv, 0)

    return c.json({
      totalAcv,
      openCount: open.length,
      opps: open.sort((a, b) => b.acv - a.acv),
      closedOpps: closed.sort((a, b) => b.closeDate.localeCompare(a.closeDate)),
      cachedAt: cached.cachedAt,
    })
  })

  // GET /customer/:name/events — SSE stream of customer data sections
  router.get('/customer/:name/events', (c) => {
    const rawName = decodeURIComponent(c.req.param('name'))
    const customer = customers.find(
      (cu) => cu.name.toLowerCase() === rawName.toLowerCase()
    )
    if (!customer) return c.text('Customer not found', 404)

    return streamSSE(c, async (stream) => {
      // Helper: write SSE event, swallowing errors so one failed write
      // doesn't kill the stream and prevent subsequent events (BKL-UI-02)
      const safeWrite = async (event: string, data: string) => {
        try {
          await stream.writeSSE({ event, data })
        } catch (e: any) {
          console.warn(`[sse] write failed for event="${event}":`, e.message)
        }
      }

      try {
        // Ensure account numbers are populated before fetching cases/subscriptions
        if (!customer.accountNumbers?.length) {
          // Scope sheet IDs to the customer's own AE — prevents cross-AE tab name collisions
          const aeMatch = customer.ae ? aes.find(a => a.name === customer.ae) : undefined
          const supportableIds = aeMatch?.supportableSheetId
            ? [aeMatch.supportableSheetId]
            : aes.map(a => a.supportableSheetId).filter((id): id is string => Boolean(id))
          const discovered = await fetchCustomerAccountNumbers(customer, supportableIds.length ? supportableIds : undefined).catch(() => [] as string[])
          if (discovered.length) {
            customer.accountNumbers = discovered
            // Persist back to customers.json so future loads don't need to re-fetch
            try {
              const updated = customers.map((cu) =>
                cu.name === customer.name ? { ...cu, accountNumbers: discovered } : cu
              )
              writeJsonAtomic(CUSTOMERS_PATH, { customers: updated })
              customers.splice(0, customers.length, ...updated)
            } catch (e: any) { console.warn('[discovery] account numbers persist failed:', e.message) }
          }
        }

        // Meta (send after account numbers are resolved so client gets the latest)
        await safeWrite('meta', JSON.stringify(customer))

        // Fetch all sections in parallel
        const [meetings, emails, docs, cases, subscriptions] = await Promise.all([
          fetchCustomerMeetings(customer).catch(() => []),
          fetchCustomerEmails(customer).catch(() => []),
          fetchCustomerDocs(customer).catch(() => []),
          fetchCustomerCases(customer).catch(() => []),
          fetchCustomerSubscriptions(customer).catch(() => []),
        ])

        await safeWrite('meetings',      JSON.stringify(meetings))
        await safeWrite('emails',        JSON.stringify(emails))
        await safeWrite('drive',         JSON.stringify(docs))
        await safeWrite('cases',         JSON.stringify(cases))
        await safeWrite('subscriptions', JSON.stringify(subscriptions))
      } catch (e: any) {
        console.error('[sse] stream handler error:', e.message)
      } finally {
        // Always send complete so the frontend exits loading state (BKL-UI-02)
        await safeWrite('complete', JSON.stringify({ timestamp: new Date().toISOString() }))
      }
    })
  })

  // GET /customer/:name/sheetdata — Sheet data with cache support
  router.get('/customer/:name/sheetdata', async (c) => {
    const rawName = decodeURIComponent(c.req.param('name'))
    const customer = customers.find((cu) => cu.name.toLowerCase() === rawName.toLowerCase())
    if (!customer) return c.json({ error: 'Customer not found' }, 404)

    const force = c.req.query('force') === 'true'

    if (!force) {
      const cached = readSheetCache(customer.name)
      if (cached) return c.json({ rows: cached.rows, cachedAt: cached.cachedAt, fromCache: true })
    }

    try {
      const supportableIds = aes.map(a => a.supportableSheetId).filter((id): id is string => Boolean(id))
      const rows = await fetchCustomerSheetData(customer, supportableIds.length ? supportableIds : undefined)
      writeSheetCache(customer.name, rows)
      return c.json({ rows, fromCache: false })
    } catch (e: any) {
      return c.json({ error: sanitizeErr(e) }, 500)
    }
  })

  // GET /customer/:name/sheetdebug — Raw sheet rows before normalization
  router.get('/customer/:name/sheetdebug', async (c) => {
    if (process.env.NODE_ENV === 'production') return c.json({ error: 'Not available' }, 404)
    const rawName = decodeURIComponent(c.req.param('name'))
    const customer = customers.find((cu) => cu.name.toLowerCase() === rawName.toLowerCase())
    if (!customer) return c.json({ error: 'Customer not found' }, 404)
    try {
      const result = await fetchCustomerSheetRaw(customer)
      return c.json(result)
    } catch (e: any) {
      return c.json({ error: sanitizeErr(e) }, 500)
    }
  })

  // ── Account Intelligence (BKL-AI01–AI04) ──────────────────────────────────

  router.post('/api/customer/:name/generate-intelligence', async (c) => {
    const rawName = decodeURIComponent(c.req.param('name'))
    const customer = customers.find((cu) => cu.name.toLowerCase() === rawName.toLowerCase())
    if (!customer) return c.json({ error: 'Customer not found' }, 404)

    const force = c.req.query('force') === 'true'
    try {
      const jobId = await runIntelligencePipeline(customer.name, force)
      return c.json({ jobId, status: 'running', message: `Intelligence generation started for ${customer.name}` })
    } catch (e: any) {
      return c.json({ error: sanitizeErr(e) }, 500)
    }
  })

  // BKL-AI-INTEL-02: Drive discovery fallback. After a cache wipe, getJobStatus
  // returns nothing because both in-memory jobs and disk cache are empty — even
  // when intelligence docs already exist in the customer's Drive folder. The UI
  // then shows only "Generate", prompting a destructive Gemini regeneration
  // that overwrites Drive docs. This handler falls back to a cheap Drive scan
  // (2 files.list calls, gated by a 7-day staleness check on the disk cache)
  // so existing docs are surfaced without touching Gemini.
  const INTEL_DISCOVERY_STALE_MS = 7 * 24 * 60 * 60 * 1000
  // BKL-AI-INTEL-03: Cooldown after an auto-trigger to prevent a re-trigger storm
  // for customers whose pipeline completed via the "skipped (no data)" path. Those
  // pipelines complete with status:'complete' but write no companyDocUrl /
  // industryDocUrl and no discoveredAt — so without a cooldown, every poll sees
  // "no URLs in cache" → "Drive scan misses" → "alreadyActive is false (status
  // === 'complete')" → fires runIntelligencePipeline again. The cooldown gates
  // the fire on recent startedAt, and a stub discoveredAt cache write (below)
  // shortcuts subsequent polls before they reach the Drive scan.
  const INTEL_RETRY_COOLDOWN_MS = 10 * 60 * 1000
  router.get('/api/customer/:name/intelligence-status', async (c) => {
    const rawName = decodeURIComponent(c.req.param('name'))
    const customer = customers.find((cu) => cu.name.toLowerCase() === rawName.toLowerCase())
    if (!customer) return c.json({ error: 'Customer not found' }, 404)

    // 1. In-memory + existing disk cache fast path (unchanged behavior).
    //    getJobStatus already falls back to readIntelligenceCache (REG-071 /
    //    BKL-AI-INTEL-01), so when URLs exist on disk from a generation run
    //    this returns status:'complete' with the URLs immediately.
    const status = getJobStatus(customer.name)
    if (status?.companyDocUrl || status?.industryDocUrl) {
      return c.json(status)
    }

    // 2. No URLs in memory or existing cache. Check disk cache age to decide
    //    whether a Drive scan is warranted. Fresh scan if:
    //      - no cache at all, OR
    //      - cache has no discoveredAt (never scanned), OR
    //      - discoveredAt is older than 7 days.
    const cacheEntry = getIntelligenceCacheEntry(customer.name)
    const lastDiscoveredAt = cacheEntry?.discoveredAt
      ? new Date(cacheEntry.discoveredAt).getTime()
      : 0
    const shouldScan = !cacheEntry || !lastDiscoveredAt
      || (Date.now() - lastDiscoveredAt) > INTEL_DISCOVERY_STALE_MS

    if (!shouldScan) {
      // Recent scan returned nothing — avoid re-hitting Drive on every poll.
      if (!status) return c.json({ status: 'none', message: 'No intelligence generation job found for this customer' })
      return c.json(status)
    }

    // 3. Drive scan — best-effort, swallows all errors to the log.
    let discovered: { companyDocUrl?: string; industryDocUrl?: string } | null = null
    try {
      discovered = await discoverExistingIntelDocs(customer)
    } catch (e: any) {
      console.warn(`[intel-status] discoverExistingIntelDocs threw for ${customer.name}:`, e?.message ?? e)
      discovered = null
    }

    if (discovered && (discovered.companyDocUrl || discovered.industryDocUrl)) {
      // Persist so the next poll takes the fast path.
      writeIntelligenceDiscoveryCache(customer.name, discovered)
      return c.json({
        status: 'complete',
        ...(discovered.companyDocUrl  ? { companyDocUrl:  discovered.companyDocUrl  } : {}),
        ...(discovered.industryDocUrl ? { industryDocUrl: discovered.industryDocUrl } : {}),
        completedAt: new Date().toISOString(),
        source: 'drive-discovery',
      })
    }

    // 4. Drive scan found nothing — auto-kick generation instead of returning
    //    status:'none'. The previous behavior forced the user to click Generate
    //    after a cache wipe, which is extra friction for an obvious next step.
    //
    //    Guard against duplicate triggers: if a job is already running/pending
    //    for this customer, or a different customer's job is actively running,
    //    return existing status untouched — runIntelligencePipeline is async and
    //    long-lived, and we must not spawn a parallel run.
    const running = getRunningJob()
    // BKL-AI-INTEL-03: The base guard blocks re-trigger while a job is actively
    // running/pending. We also treat the following as "already active" to
    // prevent a re-trigger storm on every poll:
    //   - status:'complete' + step contains 'skipped' → no-data customer, the
    //     pipeline intentionally produced no docs; re-running won't help.
    //   - status:'complete' but no doc URLs → graceful exit without content;
    //     same reasoning, re-running will just repeat the same no-op.
    //   - startedAt within INTEL_RETRY_COOLDOWN_MS → cooldown window, regardless
    //     of terminal status. Prevents rapid re-fire even for legitimately
    //     failed ('error') pipelines.
    const completedNoData =
      status?.status === 'complete' &&
      (
        (typeof status.step === 'string' && status.step.toLowerCase().includes('skipped')) ||
        (!status.companyDocUrl && !status.industryDocUrl)
      )
    const lastStartedAt = status?.startedAt ? new Date(status.startedAt).getTime() : 0
    const inCooldown = lastStartedAt > 0 && (Date.now() - lastStartedAt) < INTEL_RETRY_COOLDOWN_MS

    const alreadyActive =
      status?.status === 'running' ||
      status?.status === 'pending' ||
      (running && running.customerName === customer.name) ||
      completedNoData ||
      inCooldown

    if (!alreadyActive) {
      // BKL-AI-INTEL-03: Write a stub discoveredAt cache entry BEFORE firing so
      // subsequent polls during the Gemini run see discoveredAt from just-now
      // (< 7 days) and short-circuit the Drive scan via the staleness gate
      // above. Without this, each poll re-scans Drive for a customer that will
      // repeatedly scan to empty until the pipeline completes.
      writeIntelligenceDiscoveryCache(customer.name, { companyDocUrl: null, industryDocUrl: null })

      // Fire-and-forget — pipeline is long-running (Gemini + Drive writes);
      // caller polls this endpoint to observe status transitions.
      runIntelligencePipeline(customer.name).catch((e: any) => {
        console.warn(`[intel-status] auto-generate runIntelligencePipeline failed for ${customer.name}:`, e?.message ?? e)
      })
      return c.json({
        status: 'running',
        startedAt: new Date().toISOString(),
        source: 'auto-generate',
      })
    }

    // A job is already running/pending for this customer — return existing
    // status so the poller observes the in-flight work without triggering a dup.
    if (!status) return c.json({ status: 'none', message: 'No intelligence generation job found for this customer' })
    return c.json(status)
  })

  // ── BKL-PRODINTEL-04: Expansion Opportunities (cross-product proactive recommendations) ──
  router.get('/api/customer/:name/expansion-opportunities', (c) => {
    const rawName = decodeURIComponent(c.req.param('name'))
    const customer = customers.find((cu) => cu.name.toLowerCase() === rawName.toLowerCase())
    if (!customer) return c.json({ error: 'Customer not found' }, 404)
    const slug = toExpansionSlug(customer.name)
    const cached = getCachedExpansionOpportunities(slug)
    if (!cached) return c.json(null)
    return c.json(cached)
  })

  router.post('/api/customer/:name/expansion-opportunities', async (c) => {
    const rawName = decodeURIComponent(c.req.param('name'))
    const customer = customers.find((cu) => cu.name.toLowerCase() === rawName.toLowerCase())
    if (!customer) return c.json({ error: 'Customer not found' }, 404)
    try {
      const slug = toExpansionSlug(customer.name)
      const result = await generateExpansionOpportunities(slug)
      return c.json(result)
    } catch (e: any) {
      console.error(`[expansion-opps] POST /api/customer/${rawName}/expansion-opportunities error:`, sanitizeErr(e))
      return c.json({ error: sanitizeErr(e) }, 500)
    }
  })

  // GET /api/intelligence/status — global intelligence run status (polled by AdminPage)
  router.get('/api/intelligence/status', (c) => {
    const running = getRunningJob()
    return c.json(running ?? { status: 'idle' })
  })

  // ── BKL-AI06: Batch intelligence generation ──────────────────────────────

  router.post('/api/intelligence/generate-all', (c) => {
    if (!getAiConfig().intelligenceEnabled) {
      return c.json({ error: 'Intelligence generation is disabled — set intelligenceEnabled=true in AI settings to enable' }, 503)
    }

    if (_batchState.running) {
      return c.json({ error: 'Batch generation already running', state: _batchState }, 409)
    }

    const customerList = [...customers]
    if (customerList.length === 0) {
      return c.json({ error: 'No customers configured' }, 400)
    }

    // Reset state and start
    _batchState = {
      running: true,
      total: customerList.length,
      completed: 0,
      failed: 0,
      current: null,
      startedAt: new Date().toISOString(),
      completedAt: null,
      errors: [],
    }

    // BKL-AI-05: Run with concurrency cap to prevent Gemini API spike on large PODs
    const MAX_CONCURRENT = 2
    let inFlight = 0

    console.log(`[intelligence] generate-all: queuing ${customerList.length} customers (max ${MAX_CONCURRENT} concurrent)`)

    async function withConcurrencyLimit<T>(fn: () => Promise<T>): Promise<T> {
      while (inFlight >= MAX_CONCURRENT) {
        await new Promise(r => setTimeout(r, 200))
      }
      inFlight++
      try {
        return await fn()
      } finally {
        inFlight--
      }
    }

    async function processCustomer(customer: { name: string }) {
      try {
        await runIntelligencePipeline(customer.name)
        // Poll getJobStatus until it resolves to complete or error
        let settled = false
        for (let i = 0; i < 600; i++) { // max ~10 min per customer
          const jobStatus = getJobStatus(customer.name)
          if (jobStatus && (jobStatus.status === 'complete' || jobStatus.status === 'error')) {
            if (jobStatus.status === 'error') {
              _batchState.failed++
              _batchState.errors.push({ customer: customer.name, error: jobStatus.error ?? 'Unknown error' })
            }
            settled = true
            break
          }
          await new Promise(r => setTimeout(r, 1000))
        }
        if (!settled) {
          _batchState.failed++
          _batchState.errors.push({ customer: customer.name, error: 'Timed out after 10 minutes' })
        }
      } catch (e: any) {
        _batchState.failed++
        _batchState.errors.push({ customer: customer.name, error: String(e?.message ?? e).slice(0, 300) })
      }
      _batchState.completed++
    }

    ;(async () => {
      const tasks = customerList.map(customer =>
        withConcurrencyLimit(() => processCustomer(customer))
      )
      await Promise.all(tasks)
      _batchState.running = false
      _batchState.current = null
      _batchState.completedAt = new Date().toISOString()
      console.log(`[acct-intel] Batch generation complete: ${_batchState.completed - _batchState.failed} succeeded, ${_batchState.failed} failed out of ${_batchState.total}`)
    })()

    return c.json({ message: 'Batch generation started', total: customerList.length })
  })

  router.get('/api/intelligence/generate-all/status', (c) => {
    const startedAt = _batchState.startedAt ? new Date(_batchState.startedAt).getTime() : null
    const elapsedMs = startedAt && _batchState.running ? Date.now() - startedAt : null
    const elapsedSeconds = elapsedMs !== null ? Math.floor(elapsedMs / 1000) : null
    let estimatedSecondsRemaining: number | null = null
    if (_batchState.running && _batchState.completed > 0 && elapsedMs && _batchState.total > 0) {
      const msPerCustomer = elapsedMs / _batchState.completed
      estimatedSecondsRemaining = Math.ceil(msPerCustomer * (_batchState.total - _batchState.completed) / 1000)
    }
    const percentComplete = _batchState.total > 0 ? Math.round((_batchState.completed / _batchState.total) * 100) : 0
    return c.json({ ..._batchState, elapsedSeconds, estimatedSecondsRemaining, percentComplete })
  })

  // ── BKL-INTEL-03: Batch intelligence doc validation ──────────────────────────

  router.post('/api/intelligence/validate-all', async (c) => {
    const completeJobs = getAllJobs().filter(
      j => j.status === 'complete' && j.companyDocUrl && j.industryDocUrl
    )

    let validated = 0
    let flagged = 0
    const requeued: string[] = []

    for (const job of completeJobs) {
      const docsToCheck = [
        { docId: job.companyDocUrl!.match(/\/d\/([^/]+)\//)?.[1], docName: `${job.customerName} - Company Intelligence` },
        { docId: job.industryDocUrl!.match(/\/d\/([^/]+)\//)?.[1], docName: `${job.customerName} - Industry Analysis` },
      ].filter(d => d.docId)

      try {
        // BKL-INTEL-09: Before line-count validation, verify the Drive docs still
        // exist and aren't trashed. Without this, trashed docs silently pass the
        // line-count check (which only runs on docs Drive returns) and the customer
        // is reported as validated — users then click the stored URL and see the
        // "in the trash" banner. Trashed / 403 / 404 → flag and requeue.
        const trashStatus = await checkStoredDocsTrashed(
          job.customerName,
          job.companyDocUrl,
          job.industryDocUrl,
        )
        if (trashStatus.trashed) {
          flagged++
          requeueJob(job.customerName)
          requeued.push(job.customerName)
          console.warn(`[acct-intel] validate-all: ${job.customerName} flagged (trashed/missing docs) — ${trashStatus.reason}`)
          continue
        }

        const results = await Promise.all(
          docsToCheck.map(({ docId, docName }) => validateIntelligenceDocContent(docId!, docName))
        )
        validated += results.length
        const hasThin = results.some(r => !r.valid)
        if (hasThin) {
          flagged++
          requeueJob(job.customerName)
          requeued.push(job.customerName)
        }
      } catch (e: any) {
        // BKL-INTEL-09: Any Drive/Docs error during validation (404 from a trashed
        // doc, 403 on a moved file, transient 5xx) must flag+requeue — not silently
        // skip. Silent skip was the original bug: customer counted as validated OK
        // while the doc link pointed at a trashed file.
        console.warn(`[acct-intel] validate-all: failed to validate docs for ${job.customerName} — flagging for requeue:`, e?.message ?? e)
        flagged++
        requeueJob(job.customerName)
        requeued.push(job.customerName)
      }
    }

    console.log(`[acct-intel] validate-all complete: validated=${validated} flagged=${flagged}`)
    return c.json({ validated, flagged, requeued })
  })

  // ── Account Plan generation ──────────────────────────────────────────────────

  const _accountPlanInFlight = new Set<string>()

  router.post('/api/customers/:id/account-plan/generate', async (c) => {
    const rawName = decodeURIComponent(c.req.param('id'))
    const customer = customers.find((cu) => cu.name.toLowerCase() === rawName.toLowerCase())
      || customers.find((cu) => toSlug(cu.name) === rawName)
    if (!customer) return c.json({ error: 'Customer not found' }, 404)

    const slug = toSlug(customer.name)
    if (_accountPlanInFlight.has(slug)) {
      return c.json({ error: 'Generation already in progress for this customer' }, 409)
    }

    _accountPlanInFlight.add(slug)
    try {
      const configDir = process.env.CONFIG_DIR ?? ''
      const result = await generateAndSaveAccountPlan(customer, CACHE_DIR, configDir)
      return c.json({ ok: true, generatedAt: result.generatedAt, driveUrl: result.driveUrl })
    } catch (e: any) {
      console.error(`[acct-plan] Generation failed for ${customer.name}:`, e.message)
      return c.json({ error: sanitizeErr(e) }, 500)
    } finally {
      _accountPlanInFlight.delete(slug)
    }
  })

  router.get('/api/customers/:id/account-plan', (c) => {
    const rawName = decodeURIComponent(c.req.param('id'))
    const customer = customers.find((cu) => cu.name.toLowerCase() === rawName.toLowerCase())
      || customers.find((cu) => toSlug(cu.name) === rawName)
    if (!customer) return c.json({ error: 'Customer not found' }, 404)

    const slug = toSlug(customer.name)
    const plan = readAccountPlan(slug, CACHE_DIR)
    if (!plan) return c.json({ notGenerated: true })
    return c.json({ markdown: plan.markdown, generatedAt: plan.generatedAt, driveUrl: plan.driveUrl })
  })

  // ── BKL-AI16: Product Q&A — grounded Gemini query for RHEL / OCP / AAP ─────

  router.post('/api/product-query', async (c) => {
    let body: any
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400)
    }

    const { product, question, customerName } = body as {
      product: ProductKey
      question: string
      customerName?: string
    }

    if (!product || !['rhel', 'ocp', 'aap'].includes(product)) {
      return c.json({ error: "product must be 'rhel', 'ocp', or 'aap'" }, 400)
    }
    if (!question || typeof question !== 'string' || question.trim().length === 0) {
      return c.json({ error: 'question is required' }, 400)
    }
    if (question.length > 500) {
      return c.json({ error: 'question must be 500 characters or fewer' }, 400)
    }
    // Validate customerName against known customers — prevents prompt injection via free-form text
    const validatedCustomerName = customerName && customers.some(c => c.name === customerName)
      ? customerName
      : undefined

    try {
      const result = await queryProductIntelligence(product, question.trim(), validatedCustomerName)
      return c.json(result)
    } catch (e: any) {
      return c.json({ error: sanitizeErr(e) }, 500)
    }
  })

  return router
}
