import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { bodyLimit } from 'hono/body-limit'
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, unlinkSync, statSync } from 'fs'
import { readdir } from 'fs/promises'
import { writeFileSync as writeFileSyncRaw, renameSync } from 'fs'
import { resolve } from 'path'
import { google } from 'googleapis'
import { fetchEmail, fetchDrive, fetchCalendar, makeAuth, GOOGLE_UNIFIED_TOKEN_PATH, OAUTH_KEYS_PATH } from './src/google.ts'
import { fetchCases, fetchCustomerCases, fetchCustomerSubscriptions, fetchCaseLatestComment } from './src/redhat.ts'
import { fetchCustomerMeetings, fetchCustomerEmails, fetchCustomerDocs, generateBrief, getBriefProvider, isBriefConfigured } from './src/customer.ts'
import { fetchCustomerSheetData, fetchCustomerSheetRaw, fetchCCSPData, fetchCustomerAccountNumbers, normalizeForMatch } from './src/sheets.ts'
import type { CCSPRecord } from './src/sheets.ts'
import { fetchPipelineData, buildPipelineSummary } from './src/pipeline.ts'
import type { PipelineRecord } from './src/pipeline.ts'
import type { Customer, AE } from './src/types.ts'
import { inferCustomerDomain } from './src/domains.ts'
import { rebuildFolderMap, getWatcherState } from './src/drive-watcher.ts'
import { startLoginBrowser, cancelLoginBrowser, getRhStatus, recordScrapeExpired, lastScraped } from './src/rh-auth.ts'
import { runRhScrape, SessionExpiredError, closeScrapeContext, getScrapeContext, getLivePage, setSessionExpiredCallback } from './src/rh-scraper.ts'

import { runSfPipelineSync, getSfContext, sfSyncError } from './src/sf-scraper.ts'
import { startSfLoginBrowser, cancelSfLoginBrowser } from './src/sf-auth.ts'
import { runSupportableScrape, runSupportableDiscoverAndScrape, writeSupportableSheet, supportableScrapeRunning } from './src/supportable-scraper.ts'
import type { SupportableCustomer } from './src/supportable-scraper.ts'
import { runCcspScrape, writeCcspSheet, ccspScrapeRunning, lastCcspError } from './src/ccsp-scraper.ts'
import { NORMAL_SCOPES, BOOTSTRAP_SCOPES, getScopeLevel, type StoredToken } from './src/oauth-scopes.ts'
import { initCacheLayer, registerCacheRoutes, readBriefCache, writeBriefCache, readLatestBriefCache, readSheetCache, writeSheetCache, readCCSPCache, writeCCSPCache, readPipelineCache, writePipelineCache, toSlug } from './src/cache-layer.ts'
import { initSettingsApi, registerSettingsRoutes } from './src/settings-api.ts'
// ── M02 extracted modules ───────────────────────────────────────────────────
import { loadServerState, aes, customers, saveAes, setAes, setCustomers, patchAe, AES_PATH, CUSTOMERS_PATH } from './src/server-state.ts'
import { initRefreshEngine, registerRefreshRoutes, refreshSubscriptions, refreshCCSP, refreshPipeline } from './src/refresh-engine.ts'
import { computeAllHealthScores, isFreeOrTrial } from './src/health-score.ts'
import { initScraperManager, registerScraperRoutes, runRhScrapeWithState, runSfSyncForAes, ccspInFlight, setCcspInFlight } from './src/scraper-manager.ts'
import { initScrapeApi, registerScrapeRoutes } from './src/scrape-api.ts'
import { buildContactHistory, detectGoneSilent } from './src/email-extraction.ts'
import { rescheduleRefreshTimers, initBackgroundScheduler, enqueueScraperTask } from './src/background-scheduler.ts'
import { getRecentHistory } from './src/kpi-history.ts'
// ── M03 extracted modules ───────────────────────────────────────────────────
import { registerBootstrapRoutes, startAccountDiscovery } from './src/bootstrap-orchestrator.ts'
// ── M04 extracted modules ───────────────────────────────────────────────────
import { registerSheetImportRoutes } from './src/sheet-import.ts'
import { registerDriveSourcesRoutes } from './src/drive-sources.ts'
import { runIntelligencePipeline, getJobStatus } from './src/account-intelligence.ts'
import { sanitizeErr, sanitizeText, isValidDriveFolderId, notify, liveProbe } from './src/utils.ts'

// Safety net: log unhandled promise rejections instead of crashing Bun
// (council decision 2026-04-03 — Playwright download promises can reject after page death)
process.on('unhandledRejection', (reason: any) => {
  console.error('[server] unhandled rejection:', reason?.message ?? reason)
})

// ── Load shared state from server-state.ts ──────────────────────────────────
loadServerState()

/** Extract Tableau territory segment from a full Tableau dashboard URL. */
function extractTableauTerritory(url: string): string | null {
  // URL form: .../CloudConsumption/{guid}/{territory}?...
  const match = url.match(/\/CloudConsumption\/[^/]+\/([^?#]+)/)
  return match?.[1] ?? null
}

// ── Cache helpers ─────────────────────────────────────────────────────────────
const CACHE_DIR = process.env.CACHE_DIR ?? resolve(import.meta.dir, 'cache')
mkdirSync(CACHE_DIR, { recursive: true })

const SHEETS_SYNC_PATH = process.env.CONFIG_DIR
  ? resolve(process.env.CONFIG_DIR, 'sheets-sync.json')
  : resolve(import.meta.dir, 'config/sheets-sync.json')

const DATA_SOURCES_PATH = process.env.CONFIG_DIR
  ? resolve(process.env.CONFIG_DIR, 'data-sources.json')
  : resolve(import.meta.dir, 'config/data-sources.json')

// Load data-sources config (sets AE_PARENT_FOLDER_IDS from saved setup)
try {
  const ds = JSON.parse(readFileSync(DATA_SOURCES_PATH, 'utf-8'))
  // Support both new array format and old single-folder format
  const folders: { folderId: string }[] = ds.aeFolders ?? (ds.aeFolderID ? [{ folderId: ds.aeFolderID }] : [])
  const ids = folders.map((f: { folderId: string }) => f.folderId).filter(Boolean)
  if (ids.length) {
    if (!process.env.AE_PARENT_FOLDER_IDS) process.env.AE_PARENT_FOLDER_IDS = ids.join(',')
    if (!process.env.AE_PARENT_FOLDER_ID) process.env.AE_PARENT_FOLDER_ID = ids[0]
  }
} catch (e: any) { console.warn('[startup] could not read AE folder IDs:', e.message) }

const SRV_CONFIG_DIR = process.env.CONFIG_DIR ?? resolve(import.meta.dir, 'config')
const SHEETS_TOKEN_PATH_SRV = process.env.SHEETS_TOKEN
  ?? resolve(SRV_CONFIG_DIR, '.sheets-token.json')
const GDRIVE_TOKEN_PATH_SRV = process.env.GDRIVE_TOKEN
  ?? resolve(SRV_CONFIG_DIR, '.gdrive-server-credentials.json')

const GOOGLE_OAUTH_KEYS_PATH = process.env.GOOGLE_OAUTH_KEYS
  ?? resolve(SRV_CONFIG_DIR, 'gcp-oauth.keys.json')

const OAUTH_STATE_PATH = resolve(SRV_CONFIG_DIR, 'oauth-state.json')

const RH_SESSION_PATH = process.env.RH_SESSION
  ?? resolve(SRV_CONFIG_DIR, '.rh-session.json')
const RH_PROFILE_DIR = process.env.RH_PROFILE_DIR
  ?? resolve(SRV_CONFIG_DIR, '.rh-chrome-profile')
const RH_CASES_CACHE_PATH = resolve(CACHE_DIR, 'cases.json')
initCacheLayer(CACHE_DIR, RH_CASES_CACHE_PATH)
initSettingsApi(DATA_SOURCES_PATH)
const ADMIN_EMAIL = process.env.ADMIN_EMAIL ?? 'your-admin@example.com'
const SF_REPORT_ID   = process.env.SF_REPORT_ID ?? ''
const SF_SESSION_PATH = process.env.SF_SESSION
  ?? resolve(SRV_CONFIG_DIR, '.sf-session.json')

// CSRF state tokens — Map keyed by token, with mode + expiry (replaces single-slot variable)
const pendingOAuthStates = new Map<string, { mode: string; createdAt: number }>()

const app = new Hono()

// BKL-M05: Display-oriented normalizer — differs from normalizeForMatch by stripping state codes, parentheticals, and applying title case (needed for Drive folder names).
/**
 * Normalize a customer name for use as a Drive folder name and search key.
 * Strips state suffixes, legal entity suffixes, and parentheticals; applies title case.
 * Input:  "DROPBOX, INC. - CA"  →  Output: "Dropbox"
 * Input:  "FRED HUTCHINSON CANCER CENTER"  →  Output: "Fred Hutchinson Cancer Center"
 * Input:  "A10 NETWORKS, INC."  →  Output: "A10 Networks"
 */
function normalizeCustomerName(raw: string): string {
  let name = raw.trim()
  // Strip state suffix " - XX" or " - XX/XX"
  name = name.replace(/\s+-\s+[A-Z]{2}(\/[A-Z]{2})?$/, '')
  // Strip parentheticals like "(REI)" or "(HostGator)"
  name = name.replace(/\s*\([^)]*\)\s*$/, '')
  // Strip legal entity suffixes (with or without leading comma)
  const legalSuffixes = [
    /,?\s+L\.?L\.?P\.?$/i,
    /,?\s+P\.?T\.?Y\.?\s+LTD\.?$/i,
    /,?\s+L\.?P\.?$/i,
    /,?\s+INC\.?$/i,
    /,?\s+LLC\.?$/i,
    /,?\s+LTD\.?$/i,
    /,?\s+CORP\.?$/i,
    /,?\s+CO\.?$/i,
    /,?\s+PLC\.?$/i,
  ]
  for (const re of legalSuffixes) name = name.replace(re, '')
  name = name.trim().replace(/,+$/, '').trim()
  // Title case: preserve words with digits (A10, H2O) or internal dots (U.S.) or already mixed case
  name = name.split(/\s+/).map(word => {
    if (/\d/.test(word) || /[a-z]/.test(word) || /\.[a-zA-Z]/.test(word)) return word
    return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()
  }).join(' ')
  return name
}

/** Loose domain validation — allows subdomains, TLDs, IP-like strings, localhost. Rejects HTML. */
function isValidDomain(value: unknown): boolean {
  if (typeof value !== 'string') return true // optional field — absent is OK
  if (value === '') return true
  if (!/^[a-zA-Z0-9]([a-zA-Z0-9\-._]{0,251}[a-zA-Z0-9])?$/.test(value)) return false
  const parts = value.split('.')
  if (parts.length > 4) return false
  return true
}

/** Salesforce report/object ID — alphanumeric only, 15-18 chars. */
function isValidSfId(value: unknown): boolean {
  if (typeof value !== 'string') return true
  if (value === '') return true
  return /^[A-Za-z0-9]{15,18}$/.test(value)
}

/**
 * BKL-F07: Extract a bare SF report ID from a full Salesforce URL or return as-is if already bare.
 * Handles Lightning URLs (/lightning/r/Report/ID/view), Classic (/ID), and path variants.
 * Returns the extracted ID or the original string if no URL pattern matched.
 */
function extractSfReportId(raw: string): string {
  const trimmed = raw.trim()
  if (!trimmed) return ''
  // Already a bare ID — return as-is
  if (/^[A-Za-z0-9]{15,18}$/.test(trimmed)) return trimmed
  // URL pattern — extract last path segment that looks like a SF ID
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      const url = new URL(trimmed)
      const segments = url.pathname.split('/').filter(Boolean)
      // Walk segments in reverse to find the ID (handles /view suffix, etc.)
      for (let i = segments.length - 1; i >= 0; i--) {
        if (/^[A-Za-z0-9]{15,18}$/.test(segments[i])) return segments[i]
      }
    } catch { /* not a valid URL — fall through */ }
  }
  // Not a URL and not a bare ID — return as-is (will fail validation downstream)
  return trimmed
}

// ── Request body size limit ───────────────────────────────────────────────────
// Uses actual stream measurement — not spoofable via missing Content-Length header

app.use('*', bodyLimit({ maxSize: 1024 * 1024, onError: (c) => c.json({ error: 'Request body too large' }, 413) }))

// ── Security headers middleware ───────────────────────────────────────────────

app.use('*', async (c, next) => {
  await next()
  c.header('X-Frame-Options', 'DENY')
  c.header('X-Content-Type-Options', 'nosniff')
  c.header('Referrer-Policy', 'strict-origin-when-cross-origin')
  c.header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: https:; connect-src 'self'")
})

// Health check — used by container health probes and smoke tests
app.get('/health', (c) => c.json({
  status: 'ok',
  timestamp: new Date().toISOString(),
  aes: aes.length,
  customers: customers.length,
  session: !!getScrapeContext(),
  sfSession: !!getSfContext(),
  ccspSession: !!getScrapeContext(),   // ccsp shares RH SSO context
}))

registerCacheRoutes(app)

// ── Health Score endpoints (R04) ─────────────────────────────────────────────

app.get('/api/health-scores', (c) => {
  try {
    const scores = computeAllHealthScores(customers, RH_CASES_CACHE_PATH)
    return c.json(scores)
  } catch (e: any) {
    return c.json({ error: sanitizeErr(e) }, 500)
  }
})

app.get('/api/health-scores/:name', (c) => {
  try {
    const name = decodeURIComponent(c.req.param('name'))
    const customer = customers.find(
      cu => cu.name.toLowerCase() === name.toLowerCase(),
    )
    if (!customer) return c.json({ error: 'Customer not found' }, 404)

    const scores = computeAllHealthScores([customer], RH_CASES_CACHE_PATH)
    if (!scores.length) return c.json({ error: 'Could not compute health score' }, 500)
    return c.json(scores[0])
  } catch (e: any) {
    return c.json({ error: sanitizeErr(e) }, 500)
  }
})

// ── Morning Summary + Priority Action (R06/R13) ────────────────────────────

app.get('/api/morning-summary', (c) => {
  try {
    if (!customers.length) return c.json({ signals: [], summary: 'No customers configured.', customerCount: 0 })

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
    }

    const severityOrder: Record<string, number> = { critical: 0, high: 1, medium: 2 }
    signals.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity])

    const criticalCount = signals.filter(s => s.severity === 'critical').length
    const attentionCount = signals.filter(s => s.severity !== 'medium').length
    const summary = signals.length === 0
      ? `All clear across ${customers.length} accounts`
      : `${attentionCount} account${attentionCount !== 1 ? 's' : ''} need attention${criticalCount ? `, ${criticalCount} critical` : ''}`

    return c.json({ signals, summary, customerCount: customers.length })
  } catch (e) {
    return c.json({ error: sanitizeErr(e) }, 500)
  }
})

app.get('/api/customer/:name/priority-action', (c) => {
  try {
    const customerName = decodeURIComponent(c.req.param('name'))
    const customer = customers.find(cu => cu.name.toLowerCase() === customerName.toLowerCase())
    if (!customer) return c.json({ error: 'Customer not found' }, 404)

    const healthScores = computeAllHealthScores([customer], RH_CASES_CACHE_PATH)
    const hs = healthScores[0]
    if (!hs) return c.json({ action: null })

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
      const briefCache = readLatestBriefCache(customerName)
      if (briefCache?.text) {
        const match = briefCache.text.match(/^## Priority Action\n(.+)/m)
        if (match) {
          const text = match[1].replace(/^[-*]\s*/, '').trim()
          if (text) {
            action = { text, severity: 'medium', source: 'brief' }
          }
        }
      }
    }

    return c.json({ action })
  } catch (e) {
    return c.json({ error: sanitizeErr(e) }, 500)
  }
})

// ── Stakeholder engagement (R31) ────────────────────────────────────────────
app.get('/api/customer/:name/stakeholder-engagement', async (c) => {
  try {
    const customerName = decodeURIComponent(c.req.param('name'))
    const customer = customers.find(cu => cu.name.toLowerCase() === customerName.toLowerCase())
    if (!customer) return c.json({ error: 'Customer not found' }, 404)

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

    return c.json({ contacts })
  } catch (e) {
    return c.json({ error: sanitizeErr(e) }, 500)
  }
})

// ── Temporal delta (R33) ─────────────────────────────────────────────────────
app.get('/api/customer/:name/temporal-delta', async (c) => {
  try {
    const customerName = decodeURIComponent(c.req.param('name'))
    const slug = toSlug(customerName)

    // Async readdir to avoid blocking the event loop
    const files = (await readdir(CACHE_DIR))
      .filter((f) => f.startsWith(slug + '-') && !f.endsWith('-sheets.json') && f.endsWith('.json'))
      .sort()
      .reverse()

    if (files.length < 2) {
      return c.json({ hasPrevious: false, message: 'First brief — no prior data to compare' })
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
    const changes: { section: string; summary: string; details: string[] }[] = []

    // Extract key facts from section text for content-level diffs
    const extractFacts = (text: string): string[] => {
      const facts: string[] = []
      const lines = text.split('\n').map(l => l.trim()).filter(Boolean)
      for (const line of lines) {
        const clean = line.replace(/^[-*•]\s*/, '').replace(/^\d+\.\s*/, '').replace(/\*{1,2}/g, '')
        if (!clean || clean === '---') continue
        if (clean.match(/(?:case|sev\s*\d|severity\s*\d).{0,80}/i)) { facts.push(clean.slice(0, 100)); continue }
        if (clean.match(/\$[\d,.]+[KMB]?/i)) { facts.push(clean.slice(0, 100)); continue }
        if (clean.match(/(?:contact|meeting|spoke|scheduled|attendee|stakeholder).{0,60}/i)) { facts.push(clean.slice(0, 100)); continue }
        if (clean.match(/(?:renew|expir|pipeline|opportunity|close date|forecast).{0,60}/i)) { facts.push(clean.slice(0, 100)); continue }
        if (line.match(/^[-*•]/) && clean.length > 10) { facts.push(clean.slice(0, 100)) }
      }
      return facts.slice(0, 5)
    }

    // Check for new or changed sections
    for (const [heading, body] of currentSections) {
      const prevBody = previousSections.get(heading)
      if (prevBody === undefined) {
        const details = extractFacts(body)
        changes.push({ section: heading, summary: 'New section added', details })
      } else if (prevBody !== body) {
        const prevLines = new Set(prevBody.split('\n').map(l => l.trim()).filter(Boolean))
        const newLines = body.split('\n').map(l => l.trim()).filter(Boolean).filter(l => !prevLines.has(l))
        const details = extractFacts(newLines.join('\n'))
        if (details.length === 0) details.push('Minor content update')
        changes.push({ section: heading, summary: 'Content updated', details })
      }
    }

    // Check for removed sections
    for (const heading of previousSections.keys()) {
      if (!currentSections.has(heading)) {
        changes.push({ section: heading, summary: 'Section removed', details: [] })
      }
    }

    return c.json({ hasPrevious: true, lastBriefDate: prevDate, changes })
  } catch (e) {
    return c.json({ error: sanitizeErr(e) }, 500)
  }
})

// Redirect root to command center
app.get('/', (c) => c.redirect('/dashboard'))

// Customer list for landing page
app.get('/customers', (c) => c.json(customers))

// ── Google OAuth browser flow ─────────────────────────────────────────────────

// GET /oauth/start — Redirect browser to Google consent screen
app.get('/oauth/start', (c) => {
  if (!existsSync(GOOGLE_OAUTH_KEYS_PATH)) {
    return c.html(`<html><body style="font-family:sans-serif;padding:2rem;background:#0f172a;color:#f1f5f9">
      <h2 style="color:#f1f5f9">OAuth Keys Not Found</h2>
      <p style="color:#94a3b8">Place your GCP OAuth credentials file at:</p>
      <code style="background:#1e293b;padding:.5rem 1rem;border-radius:.5rem;display:block;margin:1rem 0;color:#e2e8f0">gcp-oauth.keys.json</code>
      <p style="color:#94a3b8">Or set the <code>GOOGLE_OAUTH_KEYS</code> environment variable.</p>
      <p><a href="/dashboard/setup" style="color:#818cf8">← Back to Setup</a></p>
    </body></html>`, 400)
  }

  // Default to bootstrap (full) scopes; only use normal (read-only) scopes if user explicitly requests downgrade
  const mode = c.req.query('mode') === 'normal' ? 'normal' : 'bootstrap'
  const scopes = mode === 'normal' ? NORMAL_SCOPES : BOOTSTRAP_SCOPES

  const keys = JSON.parse(readFileSync(GOOGLE_OAUTH_KEYS_PATH, 'utf-8'))
  const { client_id, client_secret } = keys.installed ?? keys.web
  const redirectUri = `http://localhost:${process.env.PORT ?? 7777}/oauth/callback`

  const oauth2Client = new google.auth.OAuth2(client_id, client_secret, redirectUri)

  const csrfToken = crypto.randomUUID().replace(/-/g, '')
  pendingOAuthStates.set(csrfToken, { mode, createdAt: Date.now() })
  // Expire tokens older than 10 minutes
  const cutoff = Date.now() - 10 * 60 * 1000
  for (const [k, v] of pendingOAuthStates) { if (v.createdAt < cutoff) pendingOAuthStates.delete(k) }

  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    state: `${csrfToken}:${mode}`,
    scope: [...scopes],
  })

  return c.redirect(authUrl)
})

// GET /oauth/callback — Handle Google redirect, exchange code for tokens
app.get('/oauth/callback', async (c) => {
  const code  = c.req.query('code')
  const state = c.req.query('state')
  const error = c.req.query('error')

  const escHtml = (s: string) => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')
  const errorPage = (msg: string, detail?: string) => c.html(`
    <html><body style="font-family:sans-serif;padding:2rem;background:#0f172a;color:#f1f5f9">
      <h2 style="color:#f87171">Authentication Failed</h2>
      <p style="color:#94a3b8">${escHtml(msg)}</p>
      ${detail ? `<code style="background:#1e293b;padding:.5rem 1rem;border-radius:.5rem;display:block;margin:1rem 0;color:#fca5a5">${escHtml(detail)}</code>` : ''}
      <p><a href="/dashboard/setup" style="color:#818cf8">← Back to Setup</a></p>
    </body></html>`, 400)

  if (error) {
    if (error === 'access_denied') {
      return c.html(`
        <html><body style="font-family:sans-serif;padding:2rem;background:#0f172a;color:#f1f5f9;max-width:600px;margin:0 auto">
          <h2 style="color:#fbbf24">Access Denied</h2>
          <p style="color:#94a3b8">Your Google account hasn't been added as a test user yet.</p>
          <p style="color:#94a3b8">Email <strong style="color:#f1f5f9">${escHtml(ADMIN_EMAIL)}</strong> and ask to be added, then try again.</p>
          <p style="margin-top:1.5rem">
            <a href="mailto:${escHtml(ADMIN_EMAIL)}?subject=Dashboard%20Access%20Request&body=Please%20add%20my%20Google%20account%20as%20a%20test%20user.%0A%0AMy%20email%3A%20%5Byour%40email.com%5D"
               style="background:#4f46e5;color:white;padding:.75rem 1.5rem;border-radius:.5rem;text-decoration:none;display:inline-block">
              Request Access via Email
            </a>
            &nbsp;
            <a href="/dashboard/setup" style="color:#818cf8;margin-left:1rem">← Back to Setup</a>
          </p>
          <hr style="border-color:#1e293b;margin:2rem 0">
          <p style="color:#64748b;font-size:.875rem">
            💡 If you're the admin: switching the GCP OAuth consent screen from <strong style="color:#94a3b8">External → Internal</strong>
            means any @redhat.com user can connect without being added individually.
          </p>
        </body></html>`, 403)
    }
    return errorPage('Google returned an error', error)
  }

  if (!code) return errorPage('No authorization code received')
  const [stateToken] = (state ?? '').split(':')
  const pendingState = pendingOAuthStates.get(stateToken)
  if (!pendingState) return errorPage('Invalid or expired state parameter — please try authorizing again')
  pendingOAuthStates.delete(stateToken)
  const scopeMode = pendingState.mode === 'bootstrap' ? 'bootstrap' : 'normal'

  try {
    const keys = JSON.parse(readFileSync(GOOGLE_OAUTH_KEYS_PATH, 'utf-8'))
    const { client_id, client_secret } = keys.installed ?? keys.web
    const redirectUri = `http://localhost:${process.env.PORT ?? 7777}/oauth/callback`
    const oauth2Client = new google.auth.OAuth2(client_id, client_secret, redirectUri)

    const { tokens } = await oauth2Client.getToken(code)
    const tokenData = { ...tokens, configuredAt: new Date().toISOString(), scopeLevel: scopeMode }

    // Save to config dir (works both locally and in container via volume mount)
    const tokenPath = GOOGLE_UNIFIED_TOKEN_PATH
    writeFileSyncRaw(tokenPath, JSON.stringify(tokenData, null, 2), { mode: 0o600 })

    return c.html(`
      <html><body style="font-family:sans-serif;padding:2rem;background:#0f172a;color:#f1f5f9;max-width:600px;margin:0 auto">
        <h2 style="color:#34d399">✓ Google Workspace Connected</h2>
        <p style="color:#94a3b8">Calendar, Gmail, Drive, and Sheets access authorized.</p>
        <p style="color:#94a3b8">Redirecting to setup wizard…</p>
        <meta http-equiv="refresh" content="1;url=/dashboard/setup?step=2">
        <p><a href="/dashboard/setup?step=2" style="color:#818cf8">Continue →</a></p>
      </body></html>`)
  } catch (e: any) {
    return errorPage('Token exchange failed', sanitizeErr(e))
  }
})

// GET /api/oauth/status — Check if unified Google token exists
app.get('/api/oauth/status', async (c) => {
  if (!existsSync(GOOGLE_UNIFIED_TOKEN_PATH)) return c.json({ authorized: false })
  try {
    const token = JSON.parse(readFileSync(GOOGLE_UNIFIED_TOKEN_PATH, 'utf-8'))
    // Validate token is actually live
    let email: string | undefined
    let expired = false
    try {
      const auth = makeAuth(GOOGLE_UNIFIED_TOKEN_PATH)
      const gmail = google.gmail({ version: 'v1', auth })
      const profile = await gmail.users.getProfile({ userId: 'me' })
      email = profile.data.emailAddress ?? undefined
    } catch (e: any) {
      expired = e.message?.includes('invalid_grant') || e.message?.includes('Token has been expired') || e.message?.includes('invalid_token')
    }
    const scopeLevel = getScopeLevel(token as StoredToken)
    return c.json({ authorized: !expired, expired, email, configuredAt: token.configuredAt ?? null, scopeLevel })
  } catch {
    return c.json({ authorized: false })
  }
})

// ── Red Hat Portal auth endpoints ────────────────────────────────────────────

// GET /api/auth/redhat/status — Session health, scrape timestamps, login state
app.get('/api/auth/redhat/status', async (c) => {
  const status = getRhStatus(RH_SESSION_PATH)
  // hasSession requires both a session file AND a live browser context —
  // the file persists across restarts but the context must be active to scrape
  const liveReachable = await liveProbe('https://access.redhat.com/support/cases', 'rh')
  return c.json({ ...status, hasSession: status.hasSession && getScrapeContext() !== null, liveReachable })
})

// POST /api/auth/redhat/start — Launch headed browser for RH portal login
app.post('/api/auth/redhat/start', async (c) => {
  try {
    await startLoginBrowser(RH_SESSION_PATH, RH_PROFILE_DIR, () => {
      // BKL-S12: Run pre-warm as async, then hide browser AFTER it completes or times out.
      // onComplete is fire-and-forget from rh-auth.ts — making it async is safe (caller doesn't await).
      ;(async () => {
        // Pre-warm Supportable session in background immediately after RH login.
        // The auth.redhat.com SSO session is fresh — navigating to Supportable now
        // auto-completes SSO and saves the Supportable session cookie to the profile,
        // so subsequent headless bootstrap runs can access Supportable without re-auth.
        const ctx = getScrapeContext()
        if (ctx) {
          const SUPPORTABLE_PREWARM_URL = 'https://supportable.corp.redhat.com:4443/pls/rhapplications/f?p=304:1'
          const prewarm = (async () => {
            const p = await ctx.newPage()
            try {
              await p.goto(SUPPORTABLE_PREWARM_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {})
              if (!p.url().includes('supportable.corp.redhat.com')) {
                await p.waitForURL(/supportable\.corp\.redhat\.com/, { timeout: 30_000 }).catch(() => {})
              }
              console.log(`[supportable] pre-warm complete — session established (${p.url().includes('supportable') ? 'ok' : 'may need manual login'})`)
            } catch (e: any) {
              console.warn('[supportable] pre-warm failed:', e.message)
            } finally {
              await p.close().catch(() => {})
            }
          })()
          // Wait for pre-warm to settle (cap at 32s) before hiding browser — BKL-S12
          await Promise.race([prewarm, new Promise<void>(r => setTimeout(r, 32_000))])
        }
        // Pre-warm complete (or skipped/timed out) — now safe to hide the VNC window
        getLivePage()?.goto('about:blank').catch(() => {})
        console.log('[rh-auth] onComplete: enqueueing all scrapers after re-auth')
        enqueueScraperTask({
          name: 'rh-cases',
          run: () => runRhScrapeWithState(),
          source: 'manual',
          enqueuedAt: Date.now(),
        })
        const sfAes = aes.filter(a => a.sfReportId)
        if (sfAes.length) {
          enqueueScraperTask({
            name: 'sf-pipeline',
            run: async () => { await runSfSyncForAes(sfAes) },
            source: 'manual',
            enqueuedAt: Date.now(),
          })
        }
        enqueueScraperTask({
          name: 'supportable',
          run: async () => {
            if (supportableScrapeRunning) { console.log('[rh-auth] supportable: busy — skipping'); return }
            for (const ae of aes) {
              const aeCustomers = customers.filter(cu => cu.ae === ae.name && cu.accountNumbers?.length)
              if (!aeCustomers.length) continue
              try {
                const results = await runSupportableScrape(aeCustomers as SupportableCustomer[])
                const sheetId = await writeSupportableSheet(results, ae.name, ae.driveFolderId, ae.supportableSheetId || undefined)
                if (sheetId) patchAe(ae.name, { supportableSheetId: sheetId })
              } catch (e: any) {
                console.warn(`[rh-auth:supportable] ${ae.name} failed:`, e?.message ?? e)
              }
            }
            await refreshSubscriptions().catch(() => {})
          },
          source: 'manual',
          enqueuedAt: Date.now(),
        })
        const ccspAes = aes.filter(a => a.tableauTerritories?.length && a.driveFolderId)
        if (ccspAes.length) {
          enqueueScraperTask({
            name: 'ccsp',
            run: async () => {
              if (ccspScrapeRunning || ccspInFlight) { console.log('[rh-auth] ccsp: busy — skipping'); return }
              setCcspInFlight(true)
              try {
                const results = await runCcspScrape(ccspAes)
                for (const ae of ccspAes) {
                  const aeResults = results.filter(r => r.aeName === ae.name)
                  const sheetId = await writeCcspSheet(aeResults, ae.name, ae.driveFolderId, ae.ccspSheetId || undefined)
                  patchAe(ae.name, { ccspSheetId: sheetId })
                }
                await refreshCCSP().catch(() => {})
              } finally {
                setCcspInFlight(false)
              }
            },
            source: 'manual',
            enqueuedAt: Date.now(),
          })
        }
      })().catch((e: any) => console.error('[supportable] pre-warm block error:', e?.message ?? e))
    })
    return c.json({ started: true })
  } catch (e: any) {
    return c.json({ error: 'Login failed — check Red Hat Portal connection' }, 409)
  }
})

// DELETE /api/auth/redhat/session — Cancel in-progress login
app.delete('/api/auth/redhat/session', async (c) => {
  await cancelLoginBrowser()
  return c.json({ cancelled: true })
})

// POST /api/auth/redhat/sync — REMOVED (BKL-M25): use POST /api/scrape/rh instead
// POST /api/auth/redhat/discover — REMOVED: account discovery uses Supportable APEX only (POST /api/scrape/supportable/discover)

// POST /api/test/accountname-search — Call search/v2/cases API directly with accountName SOLR query
// Body: { customers: string[] }
app.post('/api/test/accountname-search', async (c) => {
  if (process.env.NODE_ENV === 'production') return c.json({ error: 'Not available' }, 404)
  const body = await c.req.json().catch(() => ({}))
  const customers: string[] = body.customers ?? ['A10 Networks', 'Dropbox', 'Crowdstrike']
  const ctx = getScrapeContext()
  if (!ctx) return c.json({ error: 'No active RH session' }, 409)
  const page = getLivePage() ?? await ctx.newPage()

  // Ensure we're on the portal so cookies are active
  if (!page.url().includes('access.redhat.com')) {
    await page.goto('https://access.redhat.com/support/cases/#/case/list', {
      waitUntil: 'domcontentloaded', timeout: 30_000,
    }).catch(() => {})
    await page.waitForTimeout(3_000)
  }

  const results: Record<string, any> = {}

  // Use the exact expression captured from portal network traffic
  const EXPRESSION = 'sort=case_lastModifiedDate%20desc&facet=true&facet.mincount=0&facet.pivot.mincount=0&facet.sort=index&f.case_product.facet.limit=-1&f.case_version.facet.pivot.limit=-1&f.case_version.facet.pivot.mincount=1&fl=case_createdByName%2Ccase_createdDate%2Ccase_lastModifiedDate%2Ccase_lastModifiedByName%2Cid%2Curi%2Ccase_summary%2Ccase_status%2Ccase_product%2Ccase_version%2Ccase_accountNumber%2Ccase_number%2Ccase_contactName%2Ccase_owner%2Ccase_severity%2Ccase_last_public_update_date%2Ccase_last_public_update_by%2Ccase_customer_escalation%2Ccase_folderName%2Ccase_alternate_id%2Ccase_type%2Ccase_closedDate&facet.field=%7B!ex%3Dc_product%7Dcase_product&facet.field=%7B!ex%3Dc_severity%7Dcase_severity&facet.field=%7B!ex%3Dc_status%7Dcase_status&facet.field=%7B!ex%3Dc_type%7Dcase_type&facet.pivot=%7B!ex%3Dc_product%7Dcase_product%2Ccase_version&fq=%7B!tag%3Dc_product%7D*%3A*'

  // Test queries: get all fields to discover the account name field name, then try variants
  const testQueries = customers.flatMap(name => [
    { label: `${name} [all-fields sample]`, q: '*:*', fl: '*' },
    { label: `${name} [accountName]`, q: `accountName: "${name}"`, fl: null },
    { label: `${name} [case_accountName]`, q: `case_accountName: "${name}"`, fl: null },
    { label: `${name} [account_name]`, q: `account_name: "${name}"`, fl: null },
    { label: `${name} [contactName]`, q: `contactName: "${name}"`, fl: null },
  ])

  for (const { label, q, fl } of testQueries) {
    const apiResult = await page.evaluate(async ({ q, fl, expression }: { q: string; fl: string | null; expression: string }) => {
      try {
        // Build expression: if fl override provided, replace the fl= portion
        let expr = expression
        if (fl) {
          expr = expr.replace(/fl=[^&]+/, `fl=${encodeURIComponent(fl)}`)
        }
        const res = await fetch(
          `https://access.redhat.com/hydra/rest/search/v2/cases?redhat_client=Portal%20Case%20Management%202.44.57&account_number=901532`,
          {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ q, start: 0, rows: 2, partnerSearch: false, expression: expr }),
          }
        )
        const text = await res.text()
        if (!res.ok) return { error: `HTTP ${res.status}: ${text.slice(0, 200)}` }
        return { data: JSON.parse(text) }
      } catch (e: any) {
        return { error: sanitizeErr(e) }
      }
    }, { q, fl: fl ?? null, expression: EXPRESSION })

    if (apiResult.error) { results[label] = { error: apiResult.error }; continue }

    const data = apiResult.data
    const docs: any[] = data?.response?.docs ?? []
    const numFound: number = data?.response?.numFound ?? 0
    const accountNumbers = [...new Set(docs.map((d: any) => d.case_accountNumber).filter(Boolean))]

    results[label] = {
      numFound,
      docCount: docs.length,
      accountNumbers,
      // For wildcard/all-fields queries: show sorted field names for discovery
      allFieldNames: fl ? docs.flatMap((d: any) => Object.keys(d)).filter((v, i, a) => a.indexOf(v) === i).sort() : undefined,
      sampleDoc: fl ? docs[0] ?? null : undefined,
    }

    // Skip wildcard for remaining customers (only needed once to confirm API works)
    if (q === '*:*' && Object.keys(results).length >= 1) {
      // Continue testing accountName/case_accountName queries for all customers
    }
  }

  return c.json(results)
})

// POST /api/test/supportable-customer-search — Search Supportable by customer name, return account numbers
// Body: { customerName: string }  e.g. { customerName: "Dropbox" }
app.post('/api/test/supportable-customer-search', async (c) => {
  if (process.env.NODE_ENV === 'production') return c.json({ error: 'Not available' }, 404)
  const body = await c.req.json().catch(() => ({}))
  const customerName: string = body.customerName ?? 'Dropbox'
  const ctx = getScrapeContext()
  if (!ctx) return c.json({ error: 'No active RH session' }, 409)

  const SUPPORTABLE_URL = 'https://supportable.corp.redhat.com:4443/pls/rhapplications/f?p=304:1'
  let page = await ctx.newPage()

  try {
    // Mirror the existing Supportable scraper's navigation + SSO handling exactly
    await page.goto(SUPPORTABLE_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    await page.waitForTimeout(3_000)

    if (!page.url().includes('supportable.corp.redhat.com')) {
      // SSO redirect — page will navigate back or close
      let pageClosedByApex = false
      const closePromise = new Promise<void>(resolve => { page.once('close', () => { pageClosedByApex = true; resolve() }) })
      await Promise.race([
        page.waitForURL(/supportable\.corp\.redhat\.com/, { timeout: 120_000 }).catch(() => {}),
        closePromise,
      ])
      if (pageClosedByApex) page = await ctx.newPage()
      // Fresh navigation after SSO
      await page.goto(SUPPORTABLE_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 })
      await page.waitForTimeout(3_000)
    }

    if (!page.url().includes('supportable.corp.redhat.com')) {
      await page.close()
      return c.json({ error: 'Supportable SSO failed', url: page.url() }, 409)
    }

    // Fill Customer Name field — APEX naming convention: P0_CUSTOMER_NAME
    // Wildcard % matches any suffix (standard Oracle LIKE syntax)
    let fieldId = 'P0_CUSTOMER_NAME'
    let filled = false
    for (const candidate of ['P0_CUSTOMER_NAME', 'P0_CUST_NAME', 'P0_CUSTOMER']) {
      const el = await page.$(`input#${candidate}`).catch(() => null)
      if (el) { fieldId = candidate; filled = true; break }
    }
    if (!filled) {
      // Dump visible inputs to help identify the right field
      const inputDump = await page.evaluate(() =>
        Array.from(document.querySelectorAll('input')).map(el => ({
          id: el.id, name: (el as HTMLInputElement).name,
          label: document.querySelector(`label[for="${el.id}"]`)?.textContent?.trim() ?? '',
        })).filter(f => f.id || f.name)
      ).catch(() => [])
      await page.close()
      return c.json({ error: 'Customer Name input not found — try one of these IDs', inputDump })
    }

    await page.fill(`input#${fieldId}`, `${customerName}%`)
    console.log(`[test/supportable] Filled #${fieldId} with "${customerName}%"`)
    await page.click('button.button-alt1')
    // APEX does a server-side POST + redirect chain — wait for full settle
    await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {})
    await page.waitForTimeout(5_000)

    // Scrape the results table — retry if APEX is still navigating
    let tableData: any = null
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        tableData = await page.evaluate(() => { return 'PROBE_OK' })
        break
      } catch {
        console.log(`[test/supportable] results page still navigating (attempt ${attempt + 1}) — waiting…`)
        await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {})
        await page.waitForTimeout(3_000)
      }
    }
    if (!tableData) { await page.close(); return c.json({ error: 'Results page never settled after 4 attempts' }) }

    tableData = await page.evaluate(() => {
      const tables = Array.from(document.querySelectorAll('table'))
      // APEX IR result tables use <th> headers — search for party/customer/entl headers
      for (const t of tables) {
        const ths = Array.from(t.querySelectorAll('th'))
          .map(el => el.textContent?.trim().replace(/\s+/g, ' ') ?? '')
        if (ths.some(h => /party.?number|customer.?number|entl/i.test(h))) {
          const rownumIdx = ths.indexOf('Rownum')
          const rows = Array.from(t.querySelectorAll('tr')).slice(1).flatMap(tr => {
            const cells = Array.from(tr.querySelectorAll('td')).map(td => td.textContent?.trim().replace(/\s+/g, ' ') ?? '')
            // Skip APEX count rows and empty rows — data rows have a numeric Rownum cell
            if (!cells.some(c => c)) return []
            if (rownumIdx >= 0 && !/^\d+$/.test(cells[rownumIdx] ?? '')) return []
            if (cells.length < ths.length - 2) return []  // too few cells
            const obj: Record<string, string> = {}
            ths.forEach((h, i) => { obj[h] = cells[i] ?? '' })
            return [obj]
          })
          return { headers: ths, rows }
        }
      }
      // Debug: show what tables exist and their header structures
      return {
        error: `No results table found (${tables.length} tables)`,
        tableCount: tables.length,
        tableDebug: tables.slice(0, 8).map(t => ({
          cls: t.className.slice(0, 60),
          ths: Array.from(t.querySelectorAll('th')).slice(0, 6).map(th => th.textContent?.trim().slice(0, 30) ?? ''),
        })),
      }
    })

    await page.close()

    if ('error' in tableData) return c.json({ customerName, fieldId, inputFields, tableData })

    // Filter: Country = Web or USA, Entl Active Cnt > 0
    const filtered = (tableData.rows as Record<string, string>[]).filter(row => {
      const country = (row['Country'] ?? '').trim()
      const entlActive = parseInt(row['Entl Active Cnt'] ?? row['Entl\nActive\nCnt'] ?? '0', 10)
      return (country === 'Web' || country === 'USA') && entlActive > 0
    })

    const accountNumbers = [...new Set(
      filtered.map(r => r['Customer Number'] ?? r['CustomerNumber'] ?? '').filter(Boolean)
    )]

    return c.json({
      customerName,
      fieldId,
      totalRows: (tableData.rows as any[]).length,
      filteredRows: filtered.length,
      accountNumbers,
      headers: tableData.headers,
      allRows: (tableData.rows as any[]).slice(0, 10),
    })
  } catch (e: any) {
    await page.close().catch(() => {})
    return c.json({ error: sanitizeErr(e) }, 500)
  }
})

// ── Salesforce login endpoints (kept in server.ts — depend on startSfLoginBrowser) ──

// POST /api/auth/salesforce/start — launch headed browser for SF login
// The SSO button auto-clicks; the SAML flow completes without user interaction
// as long as the RH SSO session is active in the profile.
app.post('/api/auth/salesforce/start', async (c) => {
  try {
    await startSfLoginBrowser(SF_SESSION_PATH, RH_PROFILE_DIR, () => {
      // Auto-trigger a pipeline sync for each configured AE after login
      const aesWithSf = aes.filter(a => a.sfReportId && a.driveFolderId)
      if (aesWithSf.length) {
        runSfSyncForAes(aesWithSf)
      } else if (SF_REPORT_ID && process.env.PIPELINE_FILE_ID) {
        // Fallback to env vars for backwards compatibility
        runSfPipelineSync(SF_REPORT_ID, RH_PROFILE_DIR, process.env.PIPELINE_FILE_ID).catch((e: any) => console.error('[sf-sync] env fallback failed:', e?.message ?? e))
      }
    })
    return c.json({ started: true })
  } catch (e: any) {
    return c.json({ error: 'Login failed — check Salesforce connection' }, 409)
  }
})

// DELETE /api/auth/salesforce/session — cancel in-progress login
app.delete('/api/auth/salesforce/session', async (c) => {
  await cancelSfLoginBrowser()
  return c.json({ cancelled: true })
})

// ── BKL-M39: Dashboard freshness endpoint ───────────────────────────────────
app.get('/api/status/freshness', (c) => {
  const freshness: Record<string, string | null> = {}

  // Read lastRun timestamps from schedulerConfig in data-sources.json
  try {
    const ds = JSON.parse(readFileSync(DATA_SOURCES_PATH, 'utf-8'))
    const cfg = ds.schedulerConfig ?? {}
    freshness.ccsp = cfg.ccspLastRun ?? null
    freshness.supportable = cfg.supportableLastRun ?? null
    freshness.territory = cfg.territoryLastRun ?? null
    freshness.sfPipeline = cfg.sfPipelineLastRun ?? null
    freshness.rhCases = cfg.rhLastRun ?? null
  } catch {
    // data-sources.json missing — all null
  }

  // Check cache file mtimes for additional staleness signals
  try {
    const stat = statSync(resolve(CACHE_DIR, 'pipeline-data.json'))
    freshness.pipelineCache = stat.mtime.toISOString()
  } catch { /* file may not exist yet */ }
  try {
    const stat = statSync(resolve(CACHE_DIR, 'ccsp-data.json'))
    freshness.ccspCache = stat.mtime.toISOString()
  } catch { /* file may not exist yet */ }
  try {
    const stat = statSync(resolve(CACHE_DIR, 'cases.json'))
    freshness.rhCasesCache = stat.mtime.toISOString()
  } catch { /* file may not exist yet */ }

  return c.json(freshness)
})

// ── R05: KPI history / sparkline data ────────────────────────────────────────
app.get('/api/kpis/history', (c) => {
  const days = parseInt(c.req.query('days') ?? '30', 10)
  try {
    const history = getRecentHistory(Math.min(Math.max(days, 1), 90))
    return c.json({ snapshots: history })
  } catch (e) {
    return c.json({ error: sanitizeErr(e) }, 500)
  }
})

// ── Scraper routes (M02 — registered from scraper-manager.ts) ──────────────
registerScraperRoutes(app)

// ── Unified scrape API (BKL-M25 — registered from scrape-api.ts) ───────────
registerScrapeRoutes(app)

// ── Auto-bootstrap + Tableau routes (M03 — registered from bootstrap-orchestrator.ts) ──
registerBootstrapRoutes(app)

// ── Drive data-sources + Sheet import routes (M04 — registered from drive-sources.ts + sheet-import.ts) ──
registerDriveSourcesRoutes(app)
registerSheetImportRoutes(app)


// ── Dashboard API endpoints ──────────────────────────────────────────────────

// GET /api/config — Dashboard configuration and provider status
// ── Territory live lookup ──────────────────────────────────────────────────────
// GET /api/territory-lookup?territory=WEST_COMM_CORP_NORTHWEST_TERR01
// Reads the territory Google Sheet live and returns { aeName, accounts } for
// the requested territory. Does not require aes.json to be populated.

const TERRITORY_SHEET_ID = '1wblku7v2dsnZ-DAlAq2yPkBiWsIxA6EvTcxblhjZwb8'

const territoryCacheMap = new Map<string, { data: unknown; cachedAt: number }>()
const TERRITORY_CACHE_TTL_MS = 60 * 60 * 1000
const territoryNamesCacheMap = new Map<string, { data: unknown; cachedAt: number }>()

function normalizeTerritoryCustomerName(raw: string): string {
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

function podPrefixFromTabTitle(tabTitle: string): string {
  const t = tabTitle.toLowerCase()
  if (t.includes('northwest') || t.includes('nw')) return 'WEST_COMM_CORP_NORTHWEST'
  if (t.includes('southwest') || t.includes('sw')) return 'WEST_COMM_CORP_SOUTHWEST'
  if (t.includes('north central') || t.includes('nc corp')) return 'WEST_COMM_CORP_NORTHCENTRAL'
  if (t.includes('south central') || t.includes('sc corp')) return 'WEST_COMM_CORP_SOUTHCENTRAL'
  return ''
}

// GET /api/territory-names?pod=WEST_COMM_CORP_NORTHWEST
// Returns all territories for a POD with AE names — used to populate the territory dropdown.
app.get('/api/territory-names', async (c) => {
  const pod = c.req.query('pod')?.trim()
  if (!pod || !/^[A-Z0-9_]+$/.test(pod)) return c.json({ error: 'Invalid pod format' }, 400)

  const forceRefresh = c.req.query('force') === 'true'
  if (!forceRefresh) {
    const cached = territoryNamesCacheMap.get(pod)
    if (cached && Date.now() - cached.cachedAt < TERRITORY_CACHE_TTL_MS) {
      return c.json(cached.data)
    }
  }

  const auth = makeAuth(GOOGLE_UNIFIED_TOKEN_PATH)
  if (!auth) return c.json({ error: 'Google auth not configured' }, 401)

  try {
    const sheetsClient = google.sheets({ version: 'v4', auth })
    const meta = await sheetsClient.spreadsheets.get({ spreadsheetId: TERRITORY_SHEET_ID })
    const tabNames = (meta.data.sheets ?? []).map(s => s.properties?.title ?? '')
    const corpTabs = tabNames.filter(t => {
      const lower = t.toLowerCase()
      return (lower.includes('corp') || lower.includes('northwest') || lower.includes('southwest')) &&
             !lower.includes('accounts a')
    })

    const territories: { num: string; aeName: string }[] = []

    for (const tabTitle of corpTabs) {
      const podPrefix = podPrefixFromTabTitle(tabTitle)
      if (podPrefix !== pod) continue

      const resp = await sheetsClient.spreadsheets.values.get({
        spreadsheetId: TERRITORY_SHEET_ID,
        range: `'${tabTitle}'!A1:Z60`,
      })
      const rows: string[][] = (resp.data.values ?? []).map((r: any[]) =>
        r.map((c: any) => String(c ?? '').trim())
      )

      let headerRowIdx = -1
      for (let r = 0; r < rows.length; r++) {
        if (rows[r].some(cell => cell === 'Account Executive')) { headerRowIdx = r; break }
      }
      if (headerRowIdx === -1) continue

      const aeNameRowIdx = headerRowIdx + 1
      const headerRow = rows[headerRowIdx] ?? []
      const aeNameRow = rows[aeNameRowIdx] ?? []
      const aeCols = headerRow.map((cell, idx) => ({ cell, idx }))
        .filter(({ cell }) => cell === 'Account Executive').map(({ idx }) => idx)

      for (const col of aeCols) {
        const aeCell = aeNameRow[col] ?? ''
        if (!aeCell) continue
        let aeName = aeCell; let terrCode = ''
        if (aeCell.includes('\n')) {
          const parts = aeCell.split('\n'); aeName = parts[0].trim(); terrCode = parts[1].trim()
        } else {
          const terrMatch = aeCell.match(/\bTerr(\d+)\b/i)
          if (terrMatch) { aeName = aeCell.replace(/\s*Terr\d+\s*/i, '').trim(); terrCode = terrMatch[0] }
        }
        if (!aeName || /^TBH$/i.test(aeName.trim())) continue
        const terrNumMatch = terrCode.match(/(\d+)/)
        if (!terrNumMatch) continue
        const num = terrNumMatch[1].padStart(2, '0')
        territories.push({ num, aeName })
      }
      break  // Found the matching tab, no need to check others
    }

    territories.sort((a, b) => a.num.localeCompare(b.num))
    console.log(`[territory-names] ${pod}: ${territories.length} territories`)
    const result = { territories }
    territoryNamesCacheMap.set(pod, { data: result, cachedAt: Date.now() })
    return c.json(result)
  } catch (e: any) {
    console.error('[territory-names] error:', e.message)
    return c.json({ error: sanitizeErr(e) }, 500)
  }
})

app.get('/api/territory-lookup', async (c) => {
  const requestedTerritory = c.req.query('territory')?.trim()
  if (!requestedTerritory || !/^[A-Z0-9_]+$/.test(requestedTerritory)) return c.json({ error: 'Invalid territory format' }, 400)

  const forceRefresh = c.req.query('force') === 'true'
  if (!forceRefresh) {
    const cached = territoryCacheMap.get(requestedTerritory)
    if (cached && Date.now() - cached.cachedAt < TERRITORY_CACHE_TTL_MS) {
      return c.json(cached.data)
    }
  }

  const auth = makeAuth(GOOGLE_UNIFIED_TOKEN_PATH)
  if (!auth) return c.json({ error: 'Google auth not configured' }, 401)

  try {
    const sheetsClient = google.sheets({ version: 'v4', auth })

    // Get all tab names
    const meta = await sheetsClient.spreadsheets.get({ spreadsheetId: TERRITORY_SHEET_ID })
    const tabNames = (meta.data.sheets ?? []).map(s => s.properties?.title ?? '')
    const corpTabs = tabNames.filter(t => {
      const lower = t.toLowerCase()
      return (lower.includes('corp') || lower.includes('northwest') || lower.includes('southwest')) &&
             !lower.includes('accounts a')
    })

    for (const tabTitle of corpTabs) {
      const podPrefix = podPrefixFromTabTitle(tabTitle)
      if (!podPrefix) continue
      // Quick skip: if requested territory doesn't start with this pod prefix, skip tab
      if (!requestedTerritory.startsWith(podPrefix)) continue

      const resp = await sheetsClient.spreadsheets.values.get({
        spreadsheetId: TERRITORY_SHEET_ID,
        range: `'${tabTitle}'!A1:Z60`,
      })
      const rows: string[][] = (resp.data.values ?? []).map((r: any[]) =>
        r.map((c: any) => String(c ?? '').trim())
      )

      // Find "Account Executive" header row
      let headerRowIdx = -1
      for (let r = 0; r < rows.length; r++) {
        if (rows[r].some(cell => cell === 'Account Executive')) { headerRowIdx = r; break }
      }
      if (headerRowIdx === -1) continue

      const aeNameRowIdx = headerRowIdx + 1
      const accountsStartIdx = aeNameRowIdx + 1
      const headerRow = rows[headerRowIdx] ?? []
      const aeNameRow = rows[aeNameRowIdx] ?? []

      const aeCols = headerRow
        .map((cell, idx) => ({ cell, idx }))
        .filter(({ cell }) => cell === 'Account Executive')
        .map(({ idx }) => idx)

      for (const col of aeCols) {
        const aeCell = aeNameRow[col] ?? ''
        if (!aeCell) continue

        let aeName = aeCell
        let terrCode = ''
        if (aeCell.includes('\n')) {
          const parts = aeCell.split('\n')
          aeName = parts[0].trim()
          terrCode = parts[1].trim()
        } else {
          const terrMatch = aeCell.match(/\bTerr(\d+)\b/i)
          if (terrMatch) {
            aeName = aeCell.replace(/\s*Terr\d+\s*/i, '').trim()
            terrCode = terrMatch[0]
          }
        }

        if (!aeName || /^TBH$/i.test(aeName.trim())) continue

        const terrNumMatch = terrCode.match(/(\d+)/)
        if (!terrNumMatch) continue
        const terrNum = terrNumMatch[1].padStart(2, '0')
        const tableauTerritory = `${podPrefix}_TERR${terrNum}`

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
        return c.json(lookupResult)
      }
    }

    return c.json({ error: `Territory ${requestedTerritory} not found in sheet` }, 404)
  } catch (e: any) {
    console.error('[territory-lookup] error:', e.message)
    return c.json({ error: sanitizeErr(e) }, 500)
  }
})

// ── Territory notifications API ───────────────────────────────────────────────

app.get('/api/territory/notifications', async (c) => {
  const notifPath = resolve(process.env.DATA_DIR ?? 'data', 'cache', 'territory-notifications.json')
  try {
    if (!existsSync(notifPath)) return c.json({ updatedAt: null, pending: [] })
    const data = JSON.parse(readFileSync(notifPath, 'utf-8'))
    return c.json(data)
  } catch (e: any) {
    return c.json({ error: sanitizeErr(e) }, 500)
  }
})

// ── Version API ───────────────────────────────────────────────────────────────

const APP_VERSION: string = (() => {
  try {
    const pkg = JSON.parse(readFileSync(resolve(import.meta.dir, 'package.json'), 'utf-8'))
    return pkg.version ?? '1.0.0'
  } catch { return '1.0.0' }
})()

app.get('/api/version', (c) => c.json({ version: APP_VERSION }))

// ── AE Config API ─────────────────────────────────────────────────────────────

app.get('/api/aes', (c) => c.json({ aes }))

app.post('/api/aes', async (c) => {
  try {
    const body = await c.req.json() as { aes: AE[] }
    if (!Array.isArray(body.aes)) return c.json({ error: 'aes must be an array' }, 400)
    if (body.aes.length > 50) return c.json({ error: 'aes array exceeds maximum of 50 entries' }, 400)

    // Validate each AE entry
    for (let i = 0; i < body.aes.length; i++) {
      const ae = body.aes[i]
      const name = sanitizeText(ae.name)
      if (!name) return c.json({ error: `aes[${i}].name is invalid or contains disallowed characters` }, 400)
      // BKL-F07: Accept full Salesforce URLs — extract bare ID before validation
      if (ae.sfReportId) ae.sfReportId = extractSfReportId(ae.sfReportId)
      if (ae.sfReportId && !isValidSfId(ae.sfReportId)) return c.json({ error: `aes[${i}].sfReportId must be a valid Salesforce report URL or 15-18 character ID` }, 400)
      if (Array.isArray(ae.tableauTerritories)) {
        for (const t of ae.tableauTerritories) {
          if (typeof t !== 'string' || t.length > 100) return c.json({ error: `aes[${i}].tableauTerritories entry exceeds 100 characters` }, 400)
        }
      }
      // Extract folder ID from full Google Drive URL if provided
      const rawFolderId = ae.driveFolderId ?? ''
      const folderIdMatch = rawFolderId.match(/\/folders\/([a-zA-Z0-9_-]{20,})/)
      const driveFolderId = folderIdMatch ? folderIdMatch[1] : rawFolderId.trim()
      // Write whitelisted fields only — drop anything not in the schema
      body.aes[i] = {
        name,
        driveFolderId,
        sfReportId:           ae.sfReportId           ?? '',
        tableauTerritories:   ae.tableauTerritories   ?? [],
        tableauUrl:           ae.tableauUrl           ?? undefined,
        supportableSheetId:   ae.supportableSheetId   ?? undefined,
        pipelineSheetId:      ae.pipelineSheetId      ?? undefined,
        ccspSheetId:          ae.ccspSheetId          ?? undefined,
      }
      // Strip undefined values to keep JSON clean
      Object.keys(body.aes[i]).forEach(k => (body.aes[i] as any)[k] === undefined && delete (body.aes[i] as any)[k])
    }

    saveAes(body.aes)
    // Rebuild flat customer list with denormalized ae names
    try {
      const raw = JSON.parse(readFileSync(CUSTOMERS_PATH, 'utf-8'))
      setCustomers(raw.customers ?? [])
    } catch (e: any) { console.warn('[wizard] customers reload failed:', e.message) }
    return c.json({ ok: true, count: aes.length })
  } catch (e: any) {
    return c.json({ error: sanitizeErr(e) }, 500)
  }
})

app.post('/api/aes/validate-folder', async (c) => {
  try {
    const { folderUrl } = await c.req.json() as { folderUrl: string }
    const match = folderUrl?.match(/\/folders\/([\w-]+)/)
    if (!match) return c.json({ error: 'Could not extract folder ID from URL' }, 400)
    const folderId = match[1]
    const auth = makeAuth(GOOGLE_UNIFIED_TOKEN_PATH)
    const drive = google.drive({ version: 'v3', auth })
    const res = await drive.files.get({
      fileId: folderId,
      supportsAllDrives: true,
      fields: 'id,name,mimeType',
    })
    if (res.data.mimeType !== 'application/vnd.google-apps.folder') {
      return c.json({ error: 'URL does not point to a folder' }, 400)
    }
    return c.json({ folderId, folderName: res.data.name ?? folderId })
  } catch (e: any) {
    return c.json({ error: sanitizeErr(e) }, 400)
  }
})

app.get('/api/config', (c) => {
  return c.json({
    briefProvider: getBriefProvider(),
    briefConfigured: isBriefConfigured(),
  })
})

app.get('/api/config/test', async (c) => {
  if (!isBriefConfigured()) {
    return c.json({ ok: false, error: `LLM_PROVIDER=${getBriefProvider()} is not configured. Check your .env file.` })
  }
  try {
    const result = await generateBrief(
      { name: 'Test Account', ae: 'Test', domain: '', accountNumbers: [], segment: '', region: '' } as any,
      [], [], [], [], [], []
    )
    return c.json({ ok: true, provider: getBriefProvider(), preview: result.slice(0, 120) })
  } catch (e: any) {
    return c.json({ ok: false, error: sanitizeErr(e) })
  }
})

// GET /api/accounts — All customers with cached sheet data merged
app.get('/api/accounts', (c) => {
  const result = customers.map((customer) => {
    const cached = readSheetCache(customer.name)
    const products = cached?.rows ?? []
    const distinctProducts = new Set(products.map((p) => p.productDescription)).size
    const totalLicenses = products.reduce((sum, p) => sum + p.quantity, 0)

    return {
      name: customer.name,
      domain: customer.domain ?? '',
      accountNumbers: customer.accountNumbers ?? [],
      ae: customer.ae ?? '',
      segment: customer.segment ?? '',
      products,
      productCount: distinctProducts,
      totalLicenses,
      cachedAt: cached?.cachedAt ?? null,
    }
  })
  return c.json({ customers: result })
})

// GET /api/setup/check-auth — Check Google OAuth token availability
app.get('/api/setup/check-auth', async (c) => {
  const check = (filename: string) => existsSync(resolve(SRV_CONFIG_DIR, filename))
  const unified = check('.google-token.json')
  const hasFile = {
    gmail:    unified || check('.gmail-token.json'),
    drive:    unified || check('.gdrive-server-credentials.json'),
    calendar: unified || check('.calendar-token.json'),
  }

  // Validate token is actually live with a lightweight Gmail profile call
  let valid = false
  let expired = false
  let email: string | undefined
  if (hasFile.gmail) {
    try {
      const auth = makeAuth(GOOGLE_UNIFIED_TOKEN_PATH)
      const gmail = google.gmail({ version: 'v1', auth })
      const profile = await gmail.users.getProfile({ userId: 'me' })
      email = profile.data.emailAddress ?? undefined
      valid = true
    } catch (e: any) {
      expired = e.message?.includes('invalid_grant') || e.message?.includes('Token has been expired')
    }
  }

  const tokens = {
    gmail:    hasFile.gmail,
    drive:    hasFile.drive,
    calendar: hasFile.calendar,
    allConfigured: Object.values(hasFile).every(Boolean),
  }
  return c.json({ tokens, valid, expired, email })
})

// GET /api/setup/oauth-keys-status — Check if OAuth keys file exists
app.get('/api/setup/oauth-keys-status', (c) => {
  return c.json({ exists: existsSync(GOOGLE_OAUTH_KEYS_PATH) })
})

// GET /api/setup/preflight — Return onboarding readiness checks
app.get('/api/setup/preflight', (c) => {
  const checks = [
    { name: 'Environment file',  ok: existsSync('.env') || existsSync('/data/.env'),                         detail: '.env file present' },
    { name: 'RH Portal token',   ok: !!process.env.REDHAT_OFFLINE_TOKEN,                                    detail: 'REDHAT_OFFLINE_TOKEN configured' },
    { name: 'OAuth keys',        ok: existsSync(resolve(SRV_CONFIG_DIR, 'gcp-oauth.keys.json')),            detail: 'Google OAuth keys uploaded' },
    { name: 'Config directory',  ok: existsSync(SRV_CONFIG_DIR),                                            detail: 'Config storage ready' },
    { name: 'Cache directory',   ok: existsSync(CACHE_DIR),                                                 detail: 'Cache storage ready' },
  ]
  return c.json({ checks, allPassed: checks.every(ch => ch.ok) })
})

// POST /api/setup/upload-oauth-keys — Save uploaded GCP OAuth keys JSON
app.post('/api/setup/upload-oauth-keys', async (c) => {
  try {
    const body = await c.req.json()
    if (!body || typeof body !== 'object') return c.json({ error: 'Invalid JSON' }, 400)
    const credType = body.installed ? 'installed' : body.web ? 'web' : null
    if (!credType) return c.json({ error: 'Keys file must have an "installed" or "web" key' }, 400)
    const raw = body[credType]
    const { client_id, client_secret } = raw ?? {}
    if (!client_id || !client_secret) return c.json({ error: 'Missing client_id or client_secret' }, 400)
    // Sanitize: only write known OAuth fields — never persist arbitrary keys
    const sanitized: Record<string, unknown> = { client_id, client_secret }
    for (const f of ['project_id','auth_uri','token_uri','auth_provider_x509_cert_url','client_x509_cert_url','redirect_uris','javascript_origins']) {
      if (raw[f] !== undefined) sanitized[f] = raw[f]
    }
    const dir = resolve(GOOGLE_OAUTH_KEYS_PATH, '..')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    writeFileSyncRaw(GOOGLE_OAUTH_KEYS_PATH, JSON.stringify({ [credType]: sanitized }, null, 2), { mode: 0o600 })
    return c.json({ ok: true })
  } catch (_e: any) {
    return c.json({ error: 'Failed to save OAuth keys — check file permissions' }, 500)
  }
})

// POST /api/setup/reset — Clear all config and cache for a clean setup
// ?full=true also removes the OAuth keys file (simulate brand new user)
app.post('/api/setup/reset', (c) => {
  console.warn('[reset] Factory reset triggered at', new Date().toISOString())
  if (c.req.query('confirm') !== 'true') {
    return c.json({ error: 'Destructive operation requires ?confirm=true' }, 400)
  }
  if (supportableScrapeRunning || ccspScrapeRunning || _rhScrapeRunning) {
    return c.json({ error: 'Cannot reset while scrape is in progress' }, 409)
  }
  const full = c.req.query('full') === 'true'
  const deleted: string[] = []
  const tryDelete = (p: string) => { try { if (existsSync(p)) { unlinkSync(p); deleted.push(p) } } catch {} }

  // Config files
  tryDelete(CUSTOMERS_PATH)
  tryDelete(SHEETS_SYNC_PATH)
  tryDelete(DATA_SOURCES_PATH)
  if (full) {
    tryDelete(GOOGLE_UNIFIED_TOKEN_PATH)
    tryDelete(GOOGLE_OAUTH_KEYS_PATH)
  }

  // All cache files
  try {
    readdirSync(CACHE_DIR).filter(f => f.endsWith('.json')).forEach(f => tryDelete(resolve(CACHE_DIR, f)))
  } catch {}

  // Reset in-memory state
  customers.splice(0, customers.length)
  aes.splice(0, aes.length)
  saveAes([])
  pendingOAuthStates.clear()
  if (process.env.AE_PARENT_FOLDER_ID) delete process.env.AE_PARENT_FOLDER_ID
  if (process.env.AE_PARENT_FOLDER_IDS) delete process.env.AE_PARENT_FOLDER_IDS

  return c.json({ ok: true, deleted: deleted.length })
})

// POST /api/setup/infer-domains — infer customer domains from Gmail + Calendar signal
app.post('/api/setup/infer-domains', async (c) => {
  if (customers.length === 0) return c.json({ error: 'No customers configured' }, 400)
  try {
    // Process in batches of 3 to avoid overwhelming Google API rate limits
    // (naive Promise.all on 19 customers fires ~950 concurrent Gmail calls)
    const results = []
    for (let i = 0; i < customers.length; i += 3) {
      const batch = customers.slice(i, i + 3)
      const batchResults = await Promise.all(
        batch.map((cu) =>
          inferCustomerDomain(cu, GOOGLE_UNIFIED_TOKEN_PATH).catch((e) => ({
            customerName: cu.name,
            candidates: [],
            currentDomain: cu.domain,
            error: sanitizeErr(e),
          }))
        )
      )
      results.push(...batchResults)
    }
    return c.json({ results })
  } catch (e: any) {
    return c.json({ error: sanitizeErr(e) }, 500)
  }
})

// POST /api/setup/save-domains — persist inferred/edited domains to customers.json
// Accepts optional domainOverride per customer (bypasses BLOCKLIST for that domain)
app.post('/api/setup/save-domains', async (c) => {
  const body = await c.req.json<{ domains: { name: string; domain: string; domainOverride?: string }[] }>()
  if (!body.domains?.length) return c.json({ error: 'No domains provided' }, 400)

  for (const d of body.domains) {
    if (!isValidDomain(d.domain)) return c.json({ error: `Invalid domain: ${d.domain}` }, 400)
    if (d.domainOverride !== undefined && d.domainOverride !== '' && !isValidDomain(d.domainOverride)) {
      return c.json({ error: `Invalid domainOverride: ${d.domainOverride}` }, 400)
    }
  }

  const domainMap = new Map(body.domains.map((d) => [d.name, d]))
  const updated = customers.map((cu) => {
    const entry = domainMap.get(cu.name)
    if (entry === undefined) return cu
    const patch: Record<string, unknown> = { domain: entry.domain }
    if (entry.domainOverride !== undefined) patch.domainOverride = entry.domainOverride || undefined
    return { ...cu, ...patch }
  })

  try {
    writeFileSyncRaw(CUSTOMERS_PATH + '.tmp', JSON.stringify({ customers: updated }, null, 2))
    renameSync(CUSTOMERS_PATH + '.tmp', CUSTOMERS_PATH)
    customers.splice(0, customers.length, ...updated)
    return c.json({ ok: true, updated: body.domains.length })
  } catch (e: any) {
    return c.json({ error: sanitizeErr(e) }, 500)
  }
})

// POST /api/setup/save-customers — replace entire customer list from Setup UI
app.post('/api/setup/save-customers', async (c) => {
  try {
    const body = await c.req.json<{ customers: Customer[] }>()
    if (!Array.isArray(body.customers)) return c.json({ error: 'customers must be an array' }, 400)
    if (body.customers.length > 200) return c.json({ error: 'customers array exceeds maximum of 200 entries' }, 400)

    // Validate each customer
    for (let i = 0; i < body.customers.length; i++) {
      const cx = body.customers[i]
      const name = sanitizeText(cx.name)
      if (!name) return c.json({ error: `customers[${i}].name is invalid or contains disallowed characters` }, 400)
      if (cx.domain !== undefined && !isValidDomain(cx.domain)) return c.json({ error: `customers[${i}].domain is not a valid domain` }, 400)
      // Write whitelisted fields only — drop anything not in the Customer schema
      const cleaned: Record<string, unknown> = { name }
      if (cx.domain          != null) cleaned.domain          = cx.domain
      if (cx.accountNumbers  != null) {
        if (!Array.isArray(cx.accountNumbers) || cx.accountNumbers.some((n: unknown) => typeof n !== 'string' || !/^\d{4,12}$/.test(n))) {
          return c.json({ error: `customers[${i}].accountNumbers must be an array of 4-12 digit strings` }, 400)
        }
        cleaned.accountNumbers  = cx.accountNumbers
      }
      if (cx.ae              != null) cleaned.ae              = cx.ae
      if (cx.segment         != null) cleaned.segment         = cx.segment
      if (cx.region          != null) cleaned.region          = cx.region
      if (cx.sheetTab        != null) cleaned.sheetTab        = cx.sheetTab
      if (cx.supportableName != null) cleaned.supportableName = cx.supportableName
      if (cx.aliases         != null) cleaned.aliases         = cx.aliases
      if (cx.aliasDomains    != null) cleaned.aliasDomains    = cx.aliasDomains
      if (cx.skipAccountDiscovery != null) cleaned.skipAccountDiscovery = cx.skipAccountDiscovery
      body.customers[i] = cleaned as Customer
    }

    writeFileSyncRaw(CUSTOMERS_PATH + '.tmp', JSON.stringify({ customers: body.customers }, null, 2))
    renameSync(CUSTOMERS_PATH + '.tmp', CUSTOMERS_PATH)
    customers.splice(0, customers.length, ...body.customers)
    return c.json({ ok: true, count: body.customers.length })
  } catch (e: any) {
    return c.json({ error: sanitizeErr(e) }, 500)
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

// ── Brief helpers ────────────────────────────────────────────────────────────
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
    const { records, fileIds } = await fetchCCSPData(aes.map(a => a.ccspSheetId).filter(Boolean) as string[])
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

function buildCCSPSummary(records: CCSPRecord[], cachedAt: string, sourceWarning: boolean) {
  const byCustomer    = new Map<string, number>()
  const byQuarter     = new Map<string, number>()
  const byPartner     = new Map<string, number>()
  const custPartner   = new Map<string, Map<string, number>>()
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
  }
}

// BKL-M05: Query-oriented normalizer — differs from normalizeForMatch by also stripping long business-line phrases (life and safety, digital media) for substring overlap matching against cached CCSP/pipeline records.
// Shared fuzzy name normalizer for customer URL-param queries against cached records.
// Strips common legal suffixes and punctuation for substring overlap matching.
function normalizeForQuery(s: string): string {
  return s.toLowerCase()
    .replace(/,?\s*(inc\.|llc|inc|corp|ltd|lp|co\.|u\.s\..*|life and safety.*|life & safety.*|digital media.*)$/i, '')
    .replace(/[,.]/g, '').trim()
}

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

// GET /api/pipeline — Open opportunity pipeline from Drive XLS
function filterToAEs(records: PipelineRecord[]): PipelineRecord[] {
  if (!aes.length) return records
  const names = new Set(aes.map(a => a.name.toLowerCase()))
  return records.filter(r => names.has(r.owner.toLowerCase()))
}

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

// GET /api/kpis — Aggregated KPIs for the dashboard
app.get('/api/kpis', async (c) => {
  try {
    // Fetch cases and calendar in parallel
    const [allCases, calendarEvents] = await Promise.all([
      fetchCases().catch(() => []),
      fetchCalendar(customers).catch(() => []),
    ])

    const sev1Count = allCases.filter((ca) => ca.severity === '1').length

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

    return c.json({
      openCasesTotal: allCases.length,
      sev1Count,
      meetingsToday,
      meetingsThisWeek,
      renewalsWithin90Days,
      totalAccounts: customers.length,
      totalProducts: allProductDescriptions.size,
      totalLicenses,
    })
  } catch (e: any) {
    return c.json({
      openCasesTotal: 0,
      sev1Count: 0,
      meetingsToday: 0,
      meetingsThisWeek: 0,
      renewalsWithin90Days: 0,
      totalAccounts: customers.length,
      totalProducts: 0,
      totalLicenses: 0,
    }, 500)
  }
})

// ── Serve React dashboard SPA ────────────────────────────────────────────────
const DASHBOARD_DIST = resolve(import.meta.dir, 'dashboard/dist')

// Serve static assets from dashboard build
app.get('/dashboard', async (c) => {
  const indexPath = resolve(DASHBOARD_DIST, 'index.html')
  if (existsSync(indexPath)) {
    return new Response(Bun.file(indexPath), {
      headers: { 'Content-Type': 'text/html' },
    })
  }
  return c.text('Dashboard not built. Run: cd dashboard && bun run build', 404)
})

app.get('/dashboard/*', async (c) => {
  let path = c.req.path.replace('/dashboard', '')
  if (!path || path === '/') path = '/index.html'
  const filePath = resolve(DASHBOARD_DIST, path.startsWith('/') ? path.slice(1) : path)

  // Path containment — ensure resolved path stays within DASHBOARD_DIST
  if (!filePath.startsWith(DASHBOARD_DIST + '/') && filePath !== DASHBOARD_DIST) {
    return c.text('Not found', 404)
  }

  // Try to serve the file, fall back to index.html for SPA routing
  try {
    if (existsSync(filePath) && !filePath.endsWith('/') && Bun.file(filePath).size > 0) {
      const file = Bun.file(filePath)
      const ext = filePath.split('.').pop() ?? ''
      const mimeTypes: Record<string, string> = {
        html: 'text/html',
        js: 'application/javascript',
        css: 'text/css',
        json: 'application/json',
        svg: 'image/svg+xml',
        png: 'image/png',
        ico: 'image/x-icon',
      }
      return new Response(file, {
        headers: { 'Content-Type': mimeTypes[ext] ?? 'application/octet-stream' },
      })
    }
    // SPA fallback — serve index.html for any unmatched path under /dashboard
    const indexPath = resolve(DASHBOARD_DIST, 'index.html')
    if (existsSync(indexPath)) {
      return new Response(Bun.file(indexPath), {
        headers: { 'Content-Type': 'text/html' },
      })
    }
    return c.text('Dashboard not built. Run: cd dashboard && bun run build', 404)
  } catch {
    return c.text('Dashboard not built. Run: cd dashboard && bun run build', 404)
  }
})

// /admin — serve SPA shell (React Router handles the route client-side)
app.get('/admin', async (c) => {
  const indexPath = resolve(DASHBOARD_DIST, 'index.html')
  if (existsSync(indexPath)) {
    return new Response(Bun.file(indexPath), { headers: { 'Content-Type': 'text/html' } })
  }
  return c.text('Dashboard not built. Run: cd dashboard && bun run build', 404)
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

// ── Customer intelligence pages ───────────────────────────────────────────────
app.get('/customer/:name/events', (c) => {
  const rawName = decodeURIComponent(c.req.param('name'))
  const customer = customers.find(
    (cu) => cu.name.toLowerCase() === rawName.toLowerCase()
  )
  if (!customer) return c.text('Customer not found', 404)

  return streamSSE(c, async (stream) => {
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
    await stream.writeSSE({ event: 'meta', data: JSON.stringify(customer) })

    // Fetch all sections in parallel
    const [meetings, emails, docs, cases, subscriptions] = await Promise.all([
      fetchCustomerMeetings(customer).catch(() => []),
      fetchCustomerEmails(customer).catch(() => []),
      fetchCustomerDocs(customer).catch(() => []),
      fetchCustomerCases(customer).catch(() => []),
      fetchCustomerSubscriptions(customer).catch(() => []),
    ])

    await stream.writeSSE({ event: 'meetings',      data: JSON.stringify(meetings) })
    await stream.writeSSE({ event: 'emails',        data: JSON.stringify(emails) })
    await stream.writeSSE({ event: 'drive',         data: JSON.stringify(docs) })
    await stream.writeSSE({ event: 'cases',         data: JSON.stringify(cases) })
    await stream.writeSSE({ event: 'subscriptions', data: JSON.stringify(subscriptions) })

    await stream.writeSSE({ event: 'complete', data: JSON.stringify({ timestamp: new Date().toISOString() }) })
  })
})

// ── Account Intelligence (BKL-AI01–AI04) ────────────────────────────────────

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



// ── Customer brief — cached, separate endpoint so subprocess doesn't block SSE ──
app.get('/customer/:name/brief', async (c) => {
  const rawName = decodeURIComponent(c.req.param('name'))
  const customer = customers.find((cu) => cu.name.toLowerCase() === rawName.toLowerCase())
  if (!customer) return c.json({ error: 'Customer not found' }, 404)

  const force = c.req.query('force') === 'true'

  // Check cache unless force refresh — auto-invalidate if underlying data is newer
  if (!force) {
    const cached = readBriefCache(customer.name)
    if (cached) {
      const sheetData = readSheetCache(customer.name)
      const briefTs = new Date(cached.cachedAt).getTime()
      const sheetTs = sheetData ? new Date(sheetData.cachedAt).getTime() : 0
      if (sheetTs <= briefTs) {
        return c.json({ text: cached.text, cachedAt: cached.cachedAt, fromCache: true })
      }
      // Brief is stale (sheet data is newer) — fall through to regenerate
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
    const text = await generateBrief(customer, meetings, emails, docs, cases, subscriptions, products)
    writeBriefCache(customer.name, text)
    return c.json({ text, fromCache: false })
  } catch (e: any) {
    return c.json({ error: sanitizeErr(e) }, 500)
  }
})

registerSettingsRoutes(app, { rescheduleRefreshTimers })

// ── Email delivery settings (BKL-E05) ────────────────────────────────────────

const EMAIL_SETTINGS_PATH = resolve(process.env.DATA_DIR ?? 'data', 'config', 'email-settings.json')

interface EmailSettings {
  enabled: boolean
  deliveryTime: string
  timezone: string
  schedule: string
  recipientEmail: string
  sections: {
    meetings: boolean
    emails: boolean
    cases: boolean
    pipeline: boolean
    brief: boolean
  }
}

const DEFAULT_EMAIL_SETTINGS: EmailSettings = {
  enabled: false,
  deliveryTime: '07:00',
  timezone: 'America/New_York',
  schedule: 'weekdays',
  recipientEmail: '',
  sections: { meetings: true, emails: true, cases: true, pipeline: true, brief: true },
}

function readEmailSettings(): EmailSettings {
  try {
    if (existsSync(EMAIL_SETTINGS_PATH)) {
      return { ...DEFAULT_EMAIL_SETTINGS, ...JSON.parse(readFileSync(EMAIL_SETTINGS_PATH, 'utf-8')) }
    }
  } catch {}
  return { ...DEFAULT_EMAIL_SETTINGS }
}

app.get('/api/settings/email', (c) => {
  return c.json(readEmailSettings())
})

app.put('/api/settings/email', async (c) => {
  try {
    const body = await c.req.json<Partial<EmailSettings>>().catch(() => ({}))
    const current = readEmailSettings()

    // Validate deliveryTime
    if (body.deliveryTime != null) {
      if (typeof body.deliveryTime !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(body.deliveryTime)) {
        return c.json({ error: 'deliveryTime must be HH:MM format' }, 400)
      }
    }
    // Validate timezone
    if (body.timezone != null) {
      if (typeof body.timezone !== 'string' || body.timezone.length < 2 || body.timezone.length > 50) {
        return c.json({ error: 'Invalid timezone' }, 400)
      }
      try { Intl.DateTimeFormat(undefined, { timeZone: body.timezone }) }
      catch { return c.json({ error: 'Invalid timezone identifier' }, 400) }
    }
    // Validate schedule
    if (body.schedule != null) {
      if (!['daily', 'weekdays'].includes(body.schedule as string)) {
        return c.json({ error: 'schedule must be "daily" or "weekdays"' }, 400)
      }
    }
    // Validate email
    if (body.recipientEmail != null) {
      if (typeof body.recipientEmail !== 'string' || (body.recipientEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.recipientEmail))) {
        return c.json({ error: 'Invalid email address format' }, 400)
      }
    }

    const updated: EmailSettings = {
      enabled: typeof body.enabled === 'boolean' ? body.enabled : current.enabled,
      deliveryTime: body.deliveryTime ?? current.deliveryTime,
      timezone: body.timezone ?? current.timezone,
      schedule: (body.schedule as string) ?? current.schedule,
      recipientEmail: body.recipientEmail ?? current.recipientEmail,
      sections: body.sections ? { ...current.sections, ...body.sections } : current.sections,
    }

    // Ensure config dir exists
    mkdirSync(resolve(process.env.DATA_DIR ?? 'data', 'config'), { recursive: true })
    const tmpPath = EMAIL_SETTINGS_PATH + '.tmp'
    writeFileSync(tmpPath, JSON.stringify(updated, null, 2), { mode: 0o600 })
    renameSync(tmpPath, EMAIL_SETTINGS_PATH)
    return c.json(updated)
  } catch (e: any) {
    return c.json({ error: sanitizeErr(e) }, 500)
  }
})

// ── Drive watcher endpoints ───────────────────────────────────────────────────

app.get('/api/drive-watcher/status', (c) => {
  const state = getWatcherState()
  if (!state) return c.json({ enabled: false, folderMap: [], lastChecked: null, builtAt: null })
  return c.json({
    enabled: state.enabled,
    folderMap: state.folderMap,
    lastChecked: state.lastChecked ?? null,
    builtAt: state.builtAt,
  })
})

app.post('/api/drive-watcher/rebuild', async (c) => {
  const parentIds = (process.env.AE_PARENT_FOLDER_IDS ?? process.env.AE_PARENT_FOLDER_ID ?? '').split(',').filter(Boolean)
  try {
    const folderMap = await rebuildFolderMap(customers, parentIds)
    return c.json({ rebuilt: true, folders: folderMap.length, map: folderMap })
  } catch (e: any) {
    return c.json({ error: sanitizeErr(e) }, 500)
  }
})

// Diagnostic: list contents of a Drive folder by ID
app.get('/api/drive/ls/:folderId', async (c) => {
  const folderId = c.req.param('folderId')
  try {
    const auth = makeAuth(GOOGLE_UNIFIED_TOKEN_PATH)
    const drive = google.drive({ version: 'v3', auth })
    const res = await drive.files.list({
      q: `'${folderId}' in parents and trashed = false`,
      fields: 'files(id,name,mimeType,modifiedTime)',
      pageSize: 100,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    })
    return c.json({ folderId, items: res.data.files ?? [] })
  } catch (e: any) {
    return c.json({ error: sanitizeErr(e) }, 500)
  }
})

// ── Refresh routes (M02 — registered from refresh-engine.ts) ────────────────
registerRefreshRoutes(app)

// ── Sheet data — permanent cache, force-refresh via ?force=true ───────────────
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

// ── Debug: raw sheet rows before normalization ────────────────────────────────
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

app.get('/debug/sheet-tabs/:fileId', async (c) => {
  if (process.env.NODE_ENV === 'production') return c.json({ error: 'Not available' }, 404)
  const fileId = c.req.param('fileId')
  if (!/^[a-zA-Z0-9_-]{10,60}$/.test(fileId ?? '')) return c.json({ error: 'Invalid file ID' }, 400)
  const { makeAuth } = await import('./src/google.ts')
  const { google } = await import('googleapis')
  const auth = makeAuth(SHEETS_TOKEN_PATH_SRV)
  const sheets = google.sheets({ version: 'v4', auth })
  try {
    const res = await sheets.spreadsheets.get({ spreadsheetId: fileId, fields: 'sheets.properties.title' })
    const tabs = (res.data.sheets ?? []).map(s => s.properties?.title ?? '')
    return c.json({ fileId, tabs })
  } catch (e: any) {
    return c.json({ error: sanitizeErr(e) }, 500)
  }
})

// SSE data stream — each section fires as its promise resolves
app.get('/events', (c) => {
  return streamSSE(c, async (stream) => {
    const sections: Array<[string, () => Promise<any>]> = [
      ['calendar', () => fetchCalendar(customers)],
      ['email',    () => fetchEmail(customers)],
      ['cases',    fetchCases],
      ['drive',    () => fetchDrive(customers)],
    ]

    await Promise.all(
      sections.map(async ([name, fetcher]) => {
        try {
          const data = await fetcher()
          await stream.writeSSE({
            event: 'section',
            data: JSON.stringify({ section: name, data }),
          })
        } catch (err: any) {
          await stream.writeSSE({
            event: 'section',
            data: JSON.stringify({ section: name, error: err.message }),
          })
        }
      })
    )

    await stream.writeSSE({
      event: 'complete',
      data: JSON.stringify({ timestamp: new Date().toISOString() }),
    })
  })
})

// Per-source refresh functions extracted to src/refresh-engine.ts (M02)


// Register keep-alive expiry → surface reconnect banner in dashboard
// Guard: if any scraper is actively running, defer context close — killing the shared
// context mid-scrape aborts Supportable, CCSP, and RH scrapers simultaneously.
// The scrapers will fail naturally when the expired session causes their next page
// operation to error; the mutex flags will self-release normally.
import { _rhScrapeRunning } from './src/scraper-manager.ts'
setSessionExpiredCallback(() => {
  recordScrapeExpired()
  notify('Red Hat Session Expired', 'RH Portal session expired — reconnect via dashboard', 'high').catch(() => {})
  if (supportableScrapeRunning || ccspScrapeRunning || _rhScrapeRunning) {
    console.warn('[session] RH session expired during active scrape — deferring context close to avoid mid-scrape abort')
    return
  }
  closeScrapeContext().catch(() => {})
})

// ── M02 module initialization ───────────────────────────────────────────────
initRefreshEngine(SHEETS_SYNC_PATH)
initScraperManager({
  rhSessionPath: RH_SESSION_PATH,
  rhProfileDir: RH_PROFILE_DIR,
  rhCasesCachePath: RH_CASES_CACHE_PATH,
  sfSessionPath: SF_SESSION_PATH,
  sfReportId: SF_REPORT_ID,
})
initScrapeApi({
  rhProfileDir: RH_PROFILE_DIR,
  sfReportId: SF_REPORT_ID,
})

const port = Number(process.env.PORT ?? 7777)
console.log(`\n🗂️  Daily Brief Dashboard`)
console.log(`   http://localhost:${port}`)
console.log(`   http://localhost:${port}/dashboard\n`)

// ── Background scheduler (timers, startup IIFEs, drive watcher) ─────────────
// Account discovery IIFE extracted to src/bootstrap-orchestrator.ts (M03)
startAccountDiscovery()

initBackgroundScheduler({
  rhSessionPath: RH_SESSION_PATH,
  rhProfileDir: RH_PROFILE_DIR,
  sfSessionPath: SF_SESSION_PATH,
})

// ── Test-only endpoints (never active in production) ──────────────────
if (process.env.NODE_ENV !== 'production') {
  // Snapshot current server config state for test isolation
  app.post('/api/__test/snapshot', async (c) => {
    try {
      let aesRaw: string
      try { aesRaw = readFileSync(AES_PATH, 'utf-8') } catch { aesRaw = '{"aes":[]}' }
      let customersRaw: string
      try { customersRaw = readFileSync(CUSTOMERS_PATH, 'utf-8') } catch { customersRaw = '{"customers":[]}' }
      return c.json({ aes: JSON.parse(aesRaw), customers: JSON.parse(customersRaw) })
    } catch (e) {
      return c.json({ error: 'snapshot failed' }, 500)
    }
  })

  // Restore config state from snapshot (test cleanup)
  app.post('/api/__test/restore', async (c) => {
    try {
      const snap = await c.req.json()
      const aesData = snap.aes ?? { aes: [] }
      const customersData = snap.customers ?? { customers: [] }
      writeFileSync(AES_PATH + '.tmp', JSON.stringify(aesData, null, 2))
      renameSync(AES_PATH + '.tmp', AES_PATH)
      writeFileSync(CUSTOMERS_PATH + '.tmp', JSON.stringify(customersData, null, 2))
      renameSync(CUSTOMERS_PATH + '.tmp', CUSTOMERS_PATH)
      // Reload in-memory state via setters (can't reassign imported bindings)
      setAes(aesData.aes ?? [])
      setCustomers(customersData.customers ?? [])
      return c.json({ ok: true })
    } catch (e) {
      return c.json({ error: 'restore failed' }, 500)
    }
  })
}

export default { port, fetch: app.fetch, idleTimeout: 120 }
