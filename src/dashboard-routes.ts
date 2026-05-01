import { readFileSync, writeFileSync, existsSync, statSync } from 'fs'
import { readdir } from 'fs/promises'
import { resolve } from 'path'
import { google } from 'googleapis'
import { Hono } from 'hono'
import { aes, customers } from './server-state.ts'
import { toSlug, readPipelineCache, readLatestBriefCache, readSheetCache } from './cache-layer.ts'
import { computeAllHealthScores, isFreeOrTrial } from './health-score.ts'
import { fetchCases } from './redhat.ts'
import { fetchCustomerEmails } from './customer.ts'
import { makeAuth, GOOGLE_UNIFIED_TOKEN_PATH, fetchCalendar } from './google.ts'
import { getRecentHistory } from './kpi-history.ts'
import { sanitizeErr } from './utils.ts'
import { getGeminiModelLite } from './settings-api.ts'
import { buildContactHistory, detectGoneSilent } from './email-extraction.ts'
import { normalizeSettings } from './region-config.ts'
import { isEnterpriseTab, extractEnterpriseAeMap, extractEnterpriseAeAccounts } from './territory-sync.ts'

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

// ── Product name normalization ─────────────────────────────────────────────────
// Strips "Red Hat " prefix and everything from the first comma onward.
// Kept local to avoid a cross-package import from the dashboard UI bundle.
function stripProductName(raw: string | string[]): string {
  const s = Array.isArray(raw) ? raw[0] ?? '' : raw
  return s.replace(/^Red Hat\s+/i, '').replace(/,.*$/, '').trim()
}

export function initDashboardRoutes(opts: {
  cacheDir: string
  rhCasesCachePath: string
  dataSourcesPath: string
}): void {
  CACHE_DIR = opts.cacheDir
  RH_CASES_CACHE_PATH = opts.rhCasesCachePath
  DATA_SOURCES_PATH = opts.dataSourcesPath
  SETTINGS_PATH = resolve(DATA_SOURCES_PATH, '..', 'settings.json')
}

// ── Morning synthesis cache (BKL-AI27) ────────────────────────────────────────

const MORNING_SYNTHESIS_TTL_MS = 4 * 60 * 60 * 1000 // 4 hours

async function synthesizeMorningSummary(signals: { customer: string; type: string; severity: string; text: string }[]): Promise<string> {
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

  const project  = process.env.GOOGLE_CLOUD_PROJECT
  const location = process.env.GOOGLE_CLOUD_LOCATION ?? 'us-central1'
  const model    = getGeminiModelLite()  // BKL-AI-COST-01: morning synthesis is high-volume, use lite model
  if (!project) throw new Error('GOOGLE_CLOUD_PROJECT not set — required for synthesis')

  let token: string | null | undefined
  const saKeyB64 = process.env.GEMINI_SERVICE_ACCOUNT_KEY
  if (saKeyB64) {
    const keyData = JSON.parse(Buffer.from(saKeyB64, 'base64').toString())
    const jwtAuth = new google.auth.JWT({
      email: keyData.client_email,
      key:   keyData.private_key,
      scopes: ['https://www.googleapis.com/auth/cloud-platform'],
    })
    token = (await jwtAuth.getAccessToken()).token
  } else {
    const { makeAuth, GOOGLE_UNIFIED_TOKEN_PATH: TOKEN_PATH } = await import('./google.ts')
    const auth = makeAuth(TOKEN_PATH)
    token = (await auth.getAccessToken()).token
  }
  if (!token) throw new Error('Failed to get access token for morning synthesis')

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

  const url = `https://${location}-aiplatform.googleapis.com/v1/projects/${project}/locations/${location}/publishers/google/models/${model}:generateContent`
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
      generationConfig: { temperature: 0.4, maxOutputTokens: 1024, thinkingConfig: { thinkingBudget: 0 } },
    }),
  })
  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Gemini API error ${res.status}: ${err.slice(0, 200)}`)
  }
  const json = await res.json() as any
  const synthesis: string = json.candidates?.[0]?.content?.parts?.[0]?.text ?? ''

  // Cache result
  try {
    writeFileSync(synthCachePath, JSON.stringify({ synthesis, cachedAt: new Date().toISOString() }), { mode: 0o600 })
  } catch { /* non-fatal */ }

  return synthesis
}

// ── Territory helpers ─────────────────────────────────────────────────────────

const TERRITORY_SHEET_ID_FALLBACK = '1wblku7v2dsnZ-DAlAq2yPkBiWsIxA6EvTcxblhjZwb8'

function getTerritorySheetId(): string {
  try {
    const ds = JSON.parse(readFileSync(DATA_SOURCES_PATH, 'utf-8'))
    return (ds.podConfig?.territorySheetId as string | undefined) ?? TERRITORY_SHEET_ID_FALLBACK
  } catch {
    return TERRITORY_SHEET_ID_FALLBACK
  }
}

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
  if (t.includes('north central') || t.includes('nc corp')) return 'WEST_COMM_CORP_NORTH_CENTRAL'
  if (t.includes('south central') || t.includes('sc corp')) return 'WEST_COMM_CORP_SOUTH_CENTRAL'
  return ''
}

/**
 * Derive a pod key from an East-style territory code embedded in an AE cell.
 * East codes: "East_Comm_Corp_Pod1_Terr01" → "EAST_COMM_CORP_POD01"
 * Returns empty string if the code doesn't contain a recognizable pod prefix.
 */
function podKeyFromTerritoryCode(terrCode: string): string {
  // Strip _Terr\d+ suffix (with or without leading underscore)
  const withoutTerr = terrCode.replace(/_?Terr?\d+$/i, '')
  if (!withoutTerr) return ''
  // Uppercase and normalize
  let key = withoutTerr.toUpperCase().replace(/-/g, '_')
  // Zero-pad single digit after POD: POD1 → POD01
  key = key.replace(/POD(\d)$/, (_, d) => `POD0${d}`)
  return key
}

function getSheetAndTypeForPod(pod: string): { sheetId: string; regionType: 'commercial' | 'enterprise' } {
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

// ── Route registration ────────────────────────────────────────────────────────

export function createDashboardRouter(): Hono {
  const router = new Hono()

  // ── Health Score endpoints (R04) ──────────────────────────────────────────

  router.get('/api/health-scores', (c) => {
    try {
      const scores = computeAllHealthScores(customers, RH_CASES_CACHE_PATH)
      return c.json(scores)
    } catch (e: any) {
      return c.json({ error: sanitizeErr(e) }, 500)
    }
  })

  router.get('/api/health-scores/:name', (c) => {
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

  // ── Morning Summary + Priority Action (R06/R13) ──────────────────────────

  router.get('/api/morning-summary', async (c) => {
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
        console.warn('[dashboard-routes] Morning synthesis failed (non-fatal):', e.message)
      }

      const response: Record<string, unknown> = { signals, summary, customerCount: customers.length }
      if (synthesis) response.synthesis = synthesis
      return c.json(response)
    } catch (e) {
      return c.json({ error: sanitizeErr(e) }, 500)
    }
  })

  router.get('/api/customer/:name/priority-action', (c) => {
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

  // ── Stakeholder engagement (R31) ──────────────────────────────────────────
  router.get('/api/customer/:name/stakeholder-engagement', async (c) => {
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

  // ── Temporal delta (R33) ──────────────────────────────────────────────────
  router.get('/api/customer/:name/temporal-delta', async (c) => {
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

      return c.json({ hasPrevious: true, lastBriefDate: prevDate, changes })
    } catch (e) {
      return c.json({ error: sanitizeErr(e) }, 500)
    }
  })

  // ── BKL-M39: Dashboard freshness endpoint ─────────────────────────────────
  router.get('/api/status/freshness', (c) => {
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

  // ── R05: KPI history / sparkline data ────────────────────────────────────
  router.get('/api/kpis/history', (c) => {
    const days = parseInt(c.req.query('days') ?? '30', 10)
    try {
      const history = getRecentHistory(Math.min(Math.max(days, 1), 90))
      return c.json({ snapshots: history })
    } catch (e) {
      return c.json({ error: sanitizeErr(e) }, 500)
    }
  })

  // ── GET /api/kpis — Aggregated KPIs for the dashboard ────────────────────
  router.get('/api/kpis', async (c) => {
    try {
      // Fetch cases and calendar in parallel
      const [allCases, calendarEvents] = await Promise.all([
        fetchCases().catch(() => []),
        fetchCalendar(customers).catch(() => []),
      ])

      // BKL-UI-02: apply the same attribution filter as KPICasesModal (BKL-CASES-01)
      // so the KPI card count matches the modal body count. Cases with no matching
      // active customer account are excluded (Portal sometimes echoes parent/subsidiary
      // account numbers that aren't in our customer list).
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

      return c.json({
        openCasesTotal: attributedCases.length,
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

  // ── GET /api/pod/summary — Aggregated POD-level KPIs ─────────────────────
  router.get('/api/pod/summary', (c) => {
    try {
      // Serve from 30s TTL cache
      if (_podSummaryCache && Date.now() - _podSummaryCache.at < POD_SUMMARY_TTL) {
        return c.json(_podSummaryCache.data)
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
      return c.json(data)
    } catch (e: any) {
      return c.json({ error: sanitizeErr(e) }, 500)
    }
  })

  // ── GET /api/territory-names?pod=WEST_COMM_CORP_NORTHWEST ────────────────
  // Returns all territories for a POD with AE names — used to populate the territory dropdown.
  router.get('/api/territory-names', async (c) => {
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
              const m = terrCode.match(/(\d+)/)
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
            // East-style: code embedded in cell (with or without \n)
            const terrCodeMatch = aeCell.match(/([A-Za-z][A-Za-z_]+_Terr?\d+)/i)
            if (terrCodeMatch) {
              tabPodKey = podKeyFromTerritoryCode(terrCodeMatch[1])
              if (tabPodKey) break
            }
          }
          // Fallback: tab-title keyword match for West-style tabs
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
            const terrNumMatch = terrCode.match(/(\d+)/)
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
      return c.json(result)
    } catch (e: any) {
      console.error('[territory-names] error:', e.message)
      return c.json({ error: sanitizeErr(e) }, 500)
    }
  })

  // ── GET /api/territory-lookup?territory=WEST_COMM_CORP_NORTHWEST_TERR01 ──
  // Reads the territory Google Sheet live and returns { aeName, accounts } for
  // the requested territory. Does not require aes.json to be populated.
  router.get('/api/territory-lookup', async (c) => {
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

      // Derive the pod key from the territory string (strip _TERR\d+ suffix)
      const podFromTerritory = requestedTerritory.replace(/_TERR\d+$/, '')
      const { sheetId, regionType } = getSheetAndTypeForPod(podFromTerritory)

      // Get all tab names
      const meta = await sheetsClient.spreadsheets.get({ spreadsheetId: sheetId })
      const tabNames = (meta.data.sheets ?? []).map(s => s.properties?.title ?? '')

      if (regionType === 'enterprise') {
        // Enterprise path: find the enterprise tab, extract AE map, match by terr number
        const terrNumMatch = requestedTerritory.match(/_TERR(\d+)$/)
        if (!terrNumMatch) return c.json({ error: `Cannot parse territory number from ${requestedTerritory}` }, 400)
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
            return c.json(lookupResult)
          }
          break // Only one enterprise tab expected
        }

        return c.json({ error: `Territory ${requestedTerritory} not found in enterprise sheet` }, 404)
      }

      // Commercial path (existing logic)
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
          spreadsheetId: sheetId,
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
          const terrNum: string = terrNumMatch[1].padStart(2, '0')
          const tableauTerritory: string = `${podPrefix}_TERR${terrNum}`

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

  return router
}
