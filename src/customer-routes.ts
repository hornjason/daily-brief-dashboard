import { readFileSync, existsSync } from 'fs'
import { writeFileSync as writeFileSyncRaw, renameSync } from 'fs'
import { resolve } from 'path'
import { streamSSE } from 'hono/streaming'
import type { Hono } from 'hono'
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
import { runIntelligencePipeline, getJobStatus, getRunningJob } from './account-intelligence.ts'
import { queryProductIntelligence } from './product-intelligence.ts'
import type { ProductKey } from './product-intelligence.ts'
import { readBriefCache, writeBriefCache, readLatestBriefCache, readSheetCache, writeSheetCache, readCCSPCache, writeCCSPCache, readPipelineCache, writePipelineCache, BRIEF_CACHE_TTL_MS } from './cache-layer.ts'
import { sanitizeErr, normalizeForQuery } from './utils.ts'
import { writeCustomerDocsCorpus } from './customer-docs-corpus.ts'

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
function filterToAEs(records: PipelineRecord[]): PipelineRecord[] {
  if (!aes.length) return records
  const names = new Set(aes.map(a => a.name.toLowerCase()))
  return records.filter(r => names.has(r.owner.toLowerCase()))
}

// ── Route registration ────────────────────────────────────────────────────────

export function registerCustomerRoutes(app: Hono): void {

  // ── Customer data endpoints ───────────────────────────────────────────────

  // GET /api/briefs — Brief summaries for all customers (from cache)
  app.get('/api/briefs', (c) => {
    const result: Record<string, { overview: string; talkingPoints: string[]; openCasesNote: string; cachedAt: string; date: string }> = {}
    for (const customer of customers) {
      const cached = readLatestBriefCache(customer.name)
      if (cached?.text) {
        result[customer.name] = { ...extractBriefSummary(cached.text), cachedAt: cached.cachedAt, date: cached.date }
      }
    }
    return c.json(result)
  })

  // GET /api/ccsp — Cloud spend data aggregated from CCSP Raw Data tabs
  app.get('/api/ccsp', async (c) => {
    const force = c.req.query('force') === 'true'
    const cached = readCCSPCache()
    // Use cache if available and not forced (data doesn't change hourly)
    if (cached && !force) {
      return c.json(buildCCSPSummary(cached.records, cached.cachedAt, !!lastCcspError))
    }
    try {
      const { records, fileIds } = await fetchCCSPData(aes.filter(a => a.ccspSheetId).map(a => ({ sheetId: a.ccspSheetId!, aeName: a.name })))
      // Stale-overwrite guard: don't replace populated cache with empty results
      // (empty usually means Tableau scraper wrote summary-view data without Account Name column)
      if (records.length === 0 && (cached?.records?.length ?? 0) > 0) {
        console.warn(`[ccsp] force-refresh returned 0 records but cache has ${cached!.records.length} — keeping existing cache`)
        return c.json(buildCCSPSummary(cached!.records, cached!.cachedAt, true))
      }
      writeCCSPCache(records, fileIds)
      return c.json(buildCCSPSummary(records, new Date().toISOString(), false))
    } catch (e: any) {
      console.error('[ccsp] fetchCCSPData failed:', e.message)
      if (cached) return c.json(buildCCSPSummary(cached.records, cached.cachedAt, true))
      return c.json({ error: 'CCSP data fetch failed', byCustomer: [], byQuarter: [], byPartner: [], totalAcv: 0, cachedAt: null, sourceWarning: true }, 500)
    }
  })

  app.get('/api/pipeline', async (c) => {
    const force = c.req.query('force') === 'true'
    const cached = readPipelineCache()
    // Serve from cache if available and not forced — no env var needed for cache hits
    if (cached && !force) {
      return c.json({ ...buildPipelineSummary(filterToAEs(cached.records), cached.cachedAt), sourceWarning: !!sfSyncError })
    }
    if (!process.env.PIPELINE_FILE_ID) {
      return c.json({ totalAcv: 0, openCount: 0, renewalAcv: 0, newAcv: 0, byStage: [], byOwner: [], topOpps: [], cachedAt: null, sourceWarning: false })
    }
    try {
      const { records, fileIds } = await fetchPipelineData()
      writePipelineCache(records, fileIds)
      return c.json({ ...buildPipelineSummary(filterToAEs(records), new Date().toISOString()), sourceWarning: false })
    } catch (e: any) {
      if (cached) return c.json({ ...buildPipelineSummary(filterToAEs(cached.records), cached.cachedAt), sourceWarning: true })
      return c.json({ error: sanitizeErr(e), totalAcv: 0, openCount: 0, renewalAcv: 0, newAcv: 0, byStage: [], byOwner: [], topOpps: [], cachedAt: null, sourceWarning: true }, 500)
    }
  })

  // GET /api/calendar — Calendar events with range filter; ?all=true returns every event
  app.get('/api/calendar', async (c) => {
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
  app.get('/api/cases/all', async (c) => {
    try {
      const includeAll = c.req.query('includeAll') === 'true'
      const accountFilter = c.req.query('account')

      let allCases = await fetchCases({ includeAll }).catch(() => [])

      if (accountFilter) {
        allCases = allCases.filter((sc) => String(sc.accountNumber) === accountFilter)
      }

      // Enrich with customer name by matching accountNumber
      const enriched = allCases.map((sc) => {
        const matched = customers.find((cu) =>
          (cu.accountNumbers ?? []).map(String).includes(String(sc.accountNumber))
        )
        return { ...sc, customerName: matched?.name ?? 'Unknown' }
      })

      return c.json({ cases: enriched, totalCount: enriched.length })
    } catch (e: any) {
      return c.json({ cases: [], totalCount: 0, error: sanitizeErr(e) }, 500)
    }
  })

  // GET /api/cases/:caseNumber/latest-comment — most recent comment for a case
  app.get('/api/cases/:caseNumber/latest-comment', async (c) => {
    const caseNumber = c.req.param('caseNumber')
    if (!/^\d{8}$/.test(caseNumber)) return c.json({ error: 'Invalid case number — must be 8 digits' }, 400)
    const comment = await fetchCaseLatestComment(caseNumber).catch(() => null)
    return c.json({ comment })
  })

  // ── Customer detail endpoints ─────────────────────────────────────────────

  // GET /customer/:name/brief — Customer brief from cache
  app.get('/customer/:name/brief', async (c) => {
    const rawName = decodeURIComponent(c.req.param('name'))
    const customer = customers.find((cu) => cu.name.toLowerCase() === rawName.toLowerCase())
    if (!customer) return c.json({ error: 'Customer not found' }, 404)

    const force = c.req.query('force') === 'true'

    // Check cache unless force refresh — auto-invalidate if underlying data is newer or TTL expired (ADR-007)
    if (!force) {
      const cached = readBriefCache(customer.name)
      if (cached) {
        const sheetData = readSheetCache(customer.name)
        const briefTs = new Date(cached.cachedAt).getTime()
        const sheetTs = sheetData ? new Date(sheetData.cachedAt).getTime() : 0
        const ageMs = Date.now() - briefTs
        if (sheetTs <= briefTs && ageMs < BRIEF_CACHE_TTL_MS) {
          return c.json({ text: cached.text, cachedAt: cached.cachedAt, fromCache: true })
        }
        // Brief is stale (sheet data newer or 4h TTL expired) — fall through to regenerate
      }
    }

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
      // Wave 5: cache customer Drive docs corpus for product intel use
      const customerSlug = customer.name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '')
      writeCustomerDocsCorpus(customerSlug, docs)

      // BKL-AI21: filter pipeline + CCSP records for this customer before passing to brief
      const needle = normalizeForQuery(customer.name.toLowerCase())
      const pipelineCache = readPipelineCache()
      const pipeline = pipelineCache
        ? pipelineCache.records.filter(r => {
            const hay = normalizeForQuery(r.accountName)
            return hay.includes(needle) || needle.includes(hay)
          }).filter(r => r.forecastCategory.toLowerCase() !== 'closed')
        : []
      const ccspCache = readCCSPCache()
      const ccsp = ccspCache
        ? ccspCache.records.filter(r => {
            const hay = normalizeForQuery(r.accountName)
            return hay.includes(needle) || needle.includes(hay)
          })
        : []
      const text = await generateBrief(customer, meetings, emails, docs, cases, subscriptions, products, pipeline, ccsp)
      writeBriefCache(customer.name, text)
      const freshCache = readBriefCache(customer.name)
      return c.json({ text, cachedAt: freshCache?.cachedAt ?? new Date().toISOString(), fromCache: false })
    } catch (e: any) {
      return c.json({ error: sanitizeErr(e) }, 500)
    }
  })

  // GET /customer/:name/ccsp — CCSP cloud spend for a single customer (from cache)
  app.get('/customer/:name/ccsp', (c) => {
    const rawName = decodeURIComponent(c.req.param('name')).toLowerCase()
    const cached = readCCSPCache()
    if (!cached) return c.json({ totalAcv: 0, byQuarter: [], byPartner: [] })

    // Fuzzy match: strip legal suffixes, check substring overlap
    const needle = normalizeForQuery(rawName)

    const byQuarter  = new Map<string, number>()
    const byPartner  = new Map<string, number>()
    let totalAcv = 0

    for (const r of cached.records) {
      const hay = normalizeForQuery(r.accountName)
      if (!hay.includes(needle) && !needle.includes(hay)) continue
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
  app.get('/customer/:name/pipeline', (c) => {
    const rawName = decodeURIComponent(c.req.param('name')).toLowerCase()
    const cached = readPipelineCache()
    if (!cached) return c.json({ totalAcv: 0, openCount: 0, opps: [], closedOpps: [], cachedAt: null })

    const needle = normalizeForQuery(rawName)

    const open: typeof cached.records = []
    const closed: typeof cached.records = []

    for (const r of cached.records) {
      const hay = normalizeForQuery(r.accountName)
      if (!hay.includes(needle) && !needle.includes(hay)) continue
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
  app.get('/customer/:name/events', (c) => {
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
              writeFileSyncRaw(CUSTOMERS_PATH + '.tmp', JSON.stringify({ customers: updated }, null, 2))
              renameSync(CUSTOMERS_PATH + '.tmp', CUSTOMERS_PATH)
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
  app.get('/customer/:name/sheetdata', async (c) => {
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
  app.get('/customer/:name/sheetdebug', async (c) => {
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

  app.post('/api/customer/:name/generate-intelligence', async (c) => {
    const rawName = decodeURIComponent(c.req.param('name'))
    const customer = customers.find((cu) => cu.name.toLowerCase() === rawName.toLowerCase())
    if (!customer) return c.json({ error: 'Customer not found' }, 404)

    try {
      const jobId = await runIntelligencePipeline(customer.name)
      return c.json({ jobId, status: 'running', message: `Intelligence generation started for ${customer.name}` })
    } catch (e: any) {
      return c.json({ error: sanitizeErr(e) }, 500)
    }
  })

  app.get('/api/customer/:name/intelligence-status', (c) => {
    const rawName = decodeURIComponent(c.req.param('name'))
    const customer = customers.find((cu) => cu.name.toLowerCase() === rawName.toLowerCase())
    if (!customer) return c.json({ error: 'Customer not found' }, 404)

    const status = getJobStatus(customer.name)
    if (!status) return c.json({ status: 'none', message: 'No intelligence generation job found for this customer' })
    return c.json(status)
  })

  // GET /api/intelligence/status — global intelligence run status (polled by AdminPage)
  app.get('/api/intelligence/status', (c) => {
    const running = getRunningJob()
    return c.json(running ?? { status: 'idle' })
  })

  // ── BKL-AI06: Batch intelligence generation ──────────────────────────────

  app.post('/api/intelligence/generate-all', (c) => {
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

    // Run sequentially in background (no Promise.all — single Gemini call at a time)
    ;(async () => {
      for (const customer of customerList) {
        _batchState.current = customer.name
        try {
          await runIntelligencePipeline(customer.name)
          // Wait for the per-customer pipeline to finish (it runs in background via IIFE)
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
        // 2-second delay between customers for Gemini rate limits
        if (_batchState.completed < _batchState.total) {
          await new Promise(r => setTimeout(r, 2000))
        }
      }
      _batchState.running = false
      _batchState.current = null
      _batchState.completedAt = new Date().toISOString()
      console.log(`[acct-intel] Batch generation complete: ${_batchState.completed - _batchState.failed} succeeded, ${_batchState.failed} failed out of ${_batchState.total}`)
    })()

    return c.json({ message: 'Batch generation started', total: customerList.length })
  })

  app.get('/api/intelligence/generate-all/status', (c) => {
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

  // ── BKL-AI16: Product Q&A — grounded Gemini query for RHEL / OCP / AAP ─────

  app.post('/api/product-query', async (c) => {
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
}
