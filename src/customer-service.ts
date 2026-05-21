/**
 * Customer Service — Domain Logic for Customer Data Operations
 *
 * Pure business logic extracted from customer-routes.ts.
 * All brief generation, CCSP/pipeline aggregation, filtering, and batch operations live here.
 *
 * Routes file (customer-routes.ts) is now a thin HTTP adapter.
 */

import { readFileSync, existsSync } from 'fs'
import { createHash } from 'crypto'
import { fetchCalendar, GOOGLE_UNIFIED_TOKEN_PATH } from './google.ts'
import { fetchCases, fetchCustomerCases, fetchCustomerSubscriptions, fetchCaseLatestComment } from './redhat.ts'
import { fetchCustomerMeetings, fetchCustomerEmails, fetchCustomerDocs, generateBrief } from './customer.ts'
import { fetchCustomerSheetData, fetchCustomerSheetRaw, fetchCCSPData, fetchCustomerAccountNumbers } from './sheets.ts'
import type { CCSPRecord } from './sheets.ts'
import { buildPipelineSummary, fetchPipelineData } from './pipeline.ts'
import type { PipelineRecord } from './pipeline.ts'
import { customers, aes, CUSTOMERS_PATH } from './server-state.ts'
import { getScraperStatus } from './scraper-status-store.ts'
import { runIntelligencePipeline, getJobStatus, getRunningJob, getAllJobs, requeueJob, validateIntelligenceDocContent, checkStoredDocsTrashed, discoverExistingIntelDocs, getIntelligenceCacheEntry, writeIntelligenceDiscoveryCache } from './account-intelligence.ts'
import { queryProductIntelligence } from './product-intelligence.ts'
import type { ProductKey } from './product-intelligence.ts'
import { readBriefCache, writeBriefCache, readLatestBriefCache, readSheetCache, writeSheetCache, readCCSPCache, writeCCSPCache, readPipelineCache, writePipelineCache, BRIEF_CACHE_TTL_MS, toSlug, isCCSPCacheStale, isPipelineCacheStale } from './cache-layer.ts'
import { sanitizeErr, normalizeForQuery } from './utils.ts'
import { getCachedExpansionOpportunities, generateExpansionOpportunities, toCustomerSlug as toExpansionSlug } from './expansion-opportunities.ts'
import { writeCustomerDocsCorpus } from './customer-docs-corpus.ts'
import { generateAndSaveAccountPlan, readAccountPlan } from './account-plan.ts'
import { getAiConfig } from './ai-config.ts'
import type { Customer } from './types.ts'

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

// ── Config ────────────────────────────────────────────────────────────────────

export function initCustomerService(opts: {
  cacheDir: string
}): void {
  CACHE_DIR = opts.cacheDir
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface BriefSummary {
  overview: string
  talkingPoints: string[]
  openCasesNote: string
  cachedAt: string
  date: string
}

export interface CCSPSummary {
  totalAcv: number
  cachedAt: string
  sourceWarning: boolean
  byCustomer: Array<{
    name: string
    acv: number
    partners: Array<{ partner: string; acv: number }>
  }>
  byQuarter: Array<{ quarter: string; acv: number }>
  byPartner: Array<{ partner: string; acv: number }>
  byAE: Array<{
    ae: string
    acv: number
    byQuarter: Array<{ quarter: string; acv: number }>
    topAccounts: Array<{ name: string; acv: number }>
  }>
}

// ── Brief Operations ──────────────────────────────────────────────────────────

export function extractBriefSummary(text: string): { overview: string; talkingPoints: string[]; openCasesNote: string } {
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

export function getAllBriefSummaries(): Record<string, BriefSummary> {
  const result: Record<string, BriefSummary> = {}
  for (const customer of customers) {
    const cached = readLatestBriefCache(customer.name)
    if (cached?.text) {
      result[customer.name] = { ...extractBriefSummary(cached.text), cachedAt: cached.cachedAt, date: cached.date }
    }
  }
  return result
}

export async function pregenAllBriefs(podId?: string): Promise<{ status?: string; queued: number; podId: string | null; message?: string }> {
  const dedupKey = podId ?? '__global__'
  if (_pregenInFlight.has(dedupKey)) {
    return { status: 'already running for this pod', queued: 0, podId: podId ?? null }
  }

  const customerList = [...customers]
  const missing = customerList.filter(cu => !readBriefCache(cu.name))
  if (missing.length === 0) {
    return { message: 'All customers already have briefs cached', status: 'cached', queued: 0, podId: podId ?? null }
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

  return { message: 'Brief pre-generation started', queued: missing.length, podId: podId ?? null }
}

// ── CCSP Operations ───────────────────────────────────────────────────────────

export function buildCCSPSummary(records: CCSPRecord[], cachedAt: string, sourceWarning: boolean): CCSPSummary {
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

export function filterCCSPByProducts(records: CCSPRecord[], productsParam: string | null): CCSPRecord[] {
  if (!productsParam) return records

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
    .split(',')
    .map(p => (PRODUCT_GROUP_MAP[p.trim()] ?? p.trim()).toUpperCase())
    .filter(Boolean)

  if (productFilter.length === 0) return records

  return records.filter(r => r.productOfferingGroup && productFilter.includes(r.productOfferingGroup.toUpperCase()))
}

export function filterCCSPByAE(records: CCSPRecord[], aeParam: string): CCSPRecord[] {
  const ae = aeParam.trim().toLowerCase()
  return records.filter(r => r.ae?.toLowerCase() === ae)
}

export async function getCCSPData(force: boolean, productsParam: string | null, aeParam: string | null): Promise<CCSPSummary | { error: string }> {
  const cached = readCCSPCache()

  function applyFilters(recs: CCSPRecord[]): CCSPRecord[] {
    let out = recs
    if (aeParam) out = filterCCSPByAE(out, aeParam)
    if (productsParam) out = filterCCSPByProducts(out, productsParam)
    return out
  }

  // ADR-019: Use cached data if available. The refresh engine handles CSV discovery.
  if (cached && !force && cached.records.length > 0) {
    return buildCCSPSummary(applyFilters(cached.records), cached.cachedAt, !!getScraperStatus('ccsp').lastError)
  }

  try {
    const { refreshCCSP } = await import('./refresh-engine.ts')
    await refreshCCSP(force)
    const fresh = readCCSPCache()
    const records = fresh?.records ?? []
    return buildCCSPSummary(applyFilters(records), fresh?.cachedAt ?? new Date().toISOString(), false)
  } catch (e: any) {
    console.error('[ccsp] refresh failed:', e.message)
    if (cached) return buildCCSPSummary(applyFilters(cached.records), cached.cachedAt, true)
    return { error: 'CCSP data fetch failed' }
  }
}

// ── Pipeline Operations ───────────────────────────────────────────────────────

// BKL-SF-01: Filter cached pipeline records to configured AEs.
// Primary: match record.territory against ae.tableauTerritories (exact, case-insensitive).
// Fallback: owner-name prefix match for records without a territory field (backward compat with pre-territory cache).
export function filterToAEs(records: PipelineRecord[]): PipelineRecord[] {
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
export function filterToSingleAE(records: PipelineRecord[], aeParam: string): PipelineRecord[] {
  const needle = aeParam.trim().toLowerCase()
  return records.filter(r => r.owner.toLowerCase() === needle)
}

export async function getPipelineData(force: boolean, aeParam: string | null): Promise<any> {
  const cached = readPipelineCache()

  function applyFilters(records: PipelineRecord[]): PipelineRecord[] {
    let out = filterToAEs(records)
    if (aeParam) out = filterToSingleAE(out, aeParam)
    return out
  }

  // ADR-019: Use cached data if available. The refresh engine handles CSV discovery
  // and cache writes via refreshPipeline(). This endpoint just reads the cache.
  if (cached && !force && cached.records.length > 0) {
    return { ...buildPipelineSummary(applyFilters(cached.records), cached.cachedAt), sourceWarning: !!getScraperStatus('sf-pipeline').lastError }
  }

  // Force refresh or no cache: trigger refreshPipeline and re-read
  try {
    const { refreshPipeline } = await import('./refresh-engine.ts')
    await refreshPipeline(force)
    const fresh = readPipelineCache()
    const records = fresh?.records ?? []
    return { ...buildPipelineSummary(applyFilters(records), fresh?.cachedAt ?? new Date().toISOString()), sourceWarning: false }
  } catch (e: any) {
    if (cached) return { ...buildPipelineSummary(applyFilters(cached.records), cached.cachedAt), sourceWarning: true }
    return { error: sanitizeErr(e), totalAcv: 0, openCount: 0, renewalAcv: 0, newAcv: 0, byStage: [], byOwner: [], topOpps: [], cachedAt: null, sourceWarning: true }
  }
}

// ── Calendar Operations ───────────────────────────────────────────────────────

export async function getCalendarEvents(range: 'today' | 'week', includeAll: boolean): Promise<{ events: any[]; range: string; error?: string }> {
  // Short-circuit if Google OAuth token doesn't exist yet
  if (!existsSync(GOOGLE_UNIFIED_TOKEN_PATH)) {
    return { events: [], range, error: 'not_configured' }
  }

  try {
    const events = await fetchCalendar(customers, includeAll)
    return { events, range }
  } catch (e: any) {
    const msg = e.message ?? ''
    if (msg.includes('invalid_client') || msg.includes('invalid_grant') || msg.includes('No refresh token') || msg.includes('ENOENT')) {
      return { events: [], range, error: 'not_configured' }
    }
    throw e
  }
}

// ── Cases Operations ──────────────────────────────────────────────────────────

export async function getAllCases(includeAll: boolean, accountFilter?: string): Promise<{ cases: any[]; totalCount: number; error?: string }> {
  try {
    let allCases = await fetchCases({ includeAll }).catch(() => [])

    // BKL-SEC-25: validate ?account= is numeric before filtering
    if (accountFilter && !/^\d+$/.test(accountFilter)) {
      return { cases: [], totalCount: 0 }
    }
    if (accountFilter) {
      allCases = allCases.filter((sc) => String(sc.accountNumber) === accountFilter)
    }

    // BKL-CACHE-STALE-01: build an account-number set from the in-memory
    // customer store and exclude any case whose accountNumber doesn't match
    // a customer currently in customers.json. The disk cache may still hold
    // cases from previous POD/AE configurations after a reset; without this
    // filter those cases bleed through into /api/cases/all.
    // BKL-CASES-MATCH-01: only current customers — ADR-018 safety net in server-state.ts
    // filters inactive at load time; this filters to current customer accounts.
    const currentAccountNums = new Set<string>()
    for (const cu of customers) {
      for (const num of cu.accountNumbers ?? []) {
        currentAccountNums.add(String(num))
      }
    }

    // Enrich with customer name by matching accountNumber, then drop
    // cases that don't belong to a customer currently in customers.json.
    const enriched = allCases
      .map((sc) => {
        const matched = customers.find((cu) =>
          (cu.accountNumbers ?? []).map(String).includes(String(sc.accountNumber))
        )
        return { ...sc, customerName: matched?.name ?? sc.customerName ?? 'Unknown', _matched: !!matched }
      })
      .filter((sc) => sc._matched || currentAccountNums.has(String(sc.accountNumber)))
      .map(({ _matched, ...sc }) => sc)

    return { cases: enriched, totalCount: enriched.length }
  } catch (e: any) {
    return { cases: [], totalCount: 0, error: sanitizeErr(e) }
  }
}

// ── Batch Intelligence Operations ─────────────────────────────────────────────

export function getBatchIntelligenceState() {
  return { ..._batchState }
}

export function startBatchIntelligenceGeneration() {
  if (_batchState.running) {
    return { status: 'already running', ..._batchState }
  }

  const eligible = customers.filter(c => !c.inactive && c.accountNumbers && c.accountNumbers.length > 0)
  _batchState = {
    running: true,
    total: eligible.length,
    completed: 0,
    failed: 0,
    current: null,
    startedAt: new Date().toISOString(),
    completedAt: null,
    errors: [],
  }

  // Fire-and-forget background processing
  ;(async () => {
    try {
      for (const customer of eligible) {
        _batchState.current = customer.name
        try {
          await runIntelligencePipeline(customer.name)
          _batchState.completed++
        } catch (e: any) {
          console.error(`[intelligence/generate-all] ${customer.name}: ${e?.message}`)
          _batchState.failed++
          _batchState.errors.push({ customer: customer.name, error: e?.message ?? 'unknown error' })
        }
      }
    } finally {
      _batchState.running = false
      _batchState.current = null
      _batchState.completedAt = new Date().toISOString()
    }
  })().catch(e => {
    console.error('[intelligence/generate-all] batch failed:', e?.message)
    _batchState.running = false
    _batchState.current = null
    _batchState.completedAt = new Date().toISOString()
  })

  return { status: 'started', ..._batchState }
}

export function getBatchIntelligenceStatusWithProgress() {
  const startedAt = _batchState.startedAt ? new Date(_batchState.startedAt).getTime() : null
  const elapsedMs = startedAt && _batchState.running ? Date.now() - startedAt : null
  const elapsedSeconds = elapsedMs !== null ? Math.floor(elapsedMs / 1000) : null
  let estimatedSecondsRemaining: number | null = null
  if (_batchState.running && _batchState.completed > 0 && elapsedMs && _batchState.total > 0) {
    const msPerCustomer = elapsedMs / _batchState.completed
    estimatedSecondsRemaining = Math.ceil(msPerCustomer * (_batchState.total - _batchState.completed) / 1000)
  }
  const percentComplete = _batchState.total > 0 ? Math.round((_batchState.completed / _batchState.total) * 100) : 0
  return { ..._batchState, elapsedSeconds, estimatedSecondsRemaining, percentComplete }
}

// ── Single Customer Operations ────────────────────────────────────────────────

export function getCustomerCCSP(customerName: string): { totalAcv: number; cachedAt: string | null; byQuarter: any[]; byPartner: any[] } {
  const cached = readCCSPCache()
  if (!cached) return { totalAcv: 0, cachedAt: null, byQuarter: [], byPartner: [] }

  const needle = normalizeForQuery(customerName.toLowerCase())

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

  return {
    totalAcv,
    cachedAt: cached.cachedAt,
    byQuarter: [...byQuarter.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([quarter, acv]) => ({ quarter, acv })),
    byPartner: [...byPartner.entries()].sort((a, b) => b[1] - a[1]).map(([partner, acv]) => ({ partner, acv })),
  }
}

export function getCustomerPipeline(customerName: string): { totalAcv: number; openCount: number; opps: any[]; closedOpps: any[]; cachedAt: string | null } {
  const cached = readPipelineCache()
  if (!cached) return { totalAcv: 0, openCount: 0, opps: [], closedOpps: [], cachedAt: null }

  const needle = normalizeForQuery(customerName.toLowerCase())

  const open: typeof cached.records = []
  const closed: typeof cached.records = []

  for (const r of cached.records) {
    const hay = normalizeForQuery(r.accountName)
    if (hay.length === 0 || (!hay.includes(needle) && !needle.includes(hay))) continue
    if (r.forecastCategory.toLowerCase() === 'closed') closed.push(r)
    else open.push(r)
  }

  const totalAcv = open.reduce((s, r) => s + r.acv, 0)

  return {
    totalAcv,
    openCount: open.length,
    opps: open.sort((a, b) => b.acv - a.acv),
    closedOpps: closed.sort((a, b) => b.closeDate.localeCompare(a.closeDate)),
    cachedAt: cached.cachedAt,
  }
}

// ── Account Intelligence Validation ───────────────────────────────────────────

export async function validateAllIntelligenceDocs(): Promise<{ validated: number; flagged: number; requeued: string[] }> {
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
      // exist and aren't trashed.
      const trashStatus = await checkStoredDocsTrashed(
        job.customerName,
        job.companyDocUrl,
        job.industryDocUrl
      )

      if (trashStatus.trashed) {
        console.warn(`[validate-all] ${job.customerName}: docs missing or trashed — requeueing (reason=${trashStatus.reason})`)
        await requeueJob(job.customerName)
        requeued.push(job.customerName)
        continue
      }

      // BKL-INTEL-03: At least one stored doc fails the 10-line test (placeholder doc from error)
      // — requeue the intelligence job for this customer so we regenerate with valid content.
      let hasPlaceholder = false
      for (const { docId, docName } of docsToCheck) {
        const isValid = await validateIntelligenceDocContent(docId!, docName)
        if (!isValid.valid) {
          console.warn(`[validate-all] ${docName} failed line count validation (< 10 lines)`)
          hasPlaceholder = true
        }
      }

      if (hasPlaceholder) {
        console.log(`[validate-all] Requeueing ${job.customerName} due to placeholder doc(s)`)
        await requeueJob(job.customerName)
        requeued.push(job.customerName)
        flagged++
      } else {
        validated++
      }
    } catch (e: any) {
      console.error(`[validate-all] ${job.customerName} validation error:`, sanitizeErr(e))
    }
  }

  return { validated, flagged, requeued }
}

// ── Customer Discovery Operations ─────────────────────────────────────────────

export async function discoverAndPersistCustomerDocs(customer: Customer): Promise<{ discovered: number; updated: boolean; error?: string }> {
  try {
    const result = await discoverExistingIntelDocs(customer)
    if (!result) {
      return { discovered: 0, updated: false }
    }

    const discovered = (result.companyDocUrl ? 1 : 0) + (result.industryDocUrl ? 1 : 0)
    console.log(`[discover-docs] ${customer.name}: found ${discovered} existing intelligence doc(s)`)

    // BKL-INTEL-11: write docs to cache so they're picked up on next page load
    // without a full intelligence re-run (getIntelligenceCacheEntry reads this file).
    if (discovered > 0) {
      writeIntelligenceDiscoveryCache(customer.name, result)
    }

    return { discovered, updated: true }
  } catch (e: any) {
    console.error(`[discover-docs] ${customer.name}: ${sanitizeErr(e)}`)
    return { discovered: 0, updated: false, error: sanitizeErr(e) }
  }
}

// ── Product Query Operations ──────────────────────────────────────────────────

export async function queryProduct(product: ProductKey, question: string, customerName?: string): Promise<any> {
  if (!['rhel', 'ocp', 'aap'].includes(product)) {
    throw new Error("product must be 'rhel', 'ocp', or 'aap'")
  }
  if (!question || typeof question !== 'string' || question.trim().length === 0) {
    throw new Error('question is required')
  }
  if (question.length > 500) {
    throw new Error('question must be 500 characters or fewer')
  }

  // Validate customerName against known customers — prevents prompt injection via free-form text
  const validatedCustomerName = customerName && customers.some(c => c.name === customerName)
    ? customerName
    : undefined

  return await queryProductIntelligence(product, question.trim(), validatedCustomerName)
}
