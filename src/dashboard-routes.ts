import { readFileSync, writeFileSync, existsSync, statSync } from 'fs'
import { readdir } from 'fs/promises'
import { resolve } from 'path'
import { google } from 'googleapis'
import type { Hono } from 'hono'
import { customers } from './server-state.ts'
import { toSlug, readPipelineCache, readLatestBriefCache, readSheetCache } from './cache-layer.ts'
import { computeAllHealthScores, isFreeOrTrial } from './health-score.ts'
import { fetchCases } from './redhat.ts'
import { fetchCustomerEmails } from './customer.ts'
import { makeAuth, GOOGLE_UNIFIED_TOKEN_PATH, fetchCalendar } from './google.ts'
import { getRecentHistory } from './kpi-history.ts'
import { sanitizeErr } from './utils.ts'
import { buildContactHistory, detectGoneSilent } from './email-extraction.ts'

// ── Module state ─────────────────────────────────────────────────────────────
let CACHE_DIR = ''
let RH_CASES_CACHE_PATH = ''
let DATA_SOURCES_PATH = ''

export function initDashboardRoutes(opts: {
  cacheDir: string
  rhCasesCachePath: string
  dataSourcesPath: string
}): void {
  CACHE_DIR = opts.cacheDir
  RH_CASES_CACHE_PATH = opts.rhCasesCachePath
  DATA_SOURCES_PATH = opts.dataSourcesPath
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
  const model    = process.env.GEMINI_MODEL ?? 'gemini-2.5-flash'
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

  const systemPrompt = `You are a Red Hat Account Solution Architect's AI assistant. Your job is to synthesize portfolio signals into a crisp daily briefing.`
  const userPrompt   = `Today's portfolio signals (${signals.length} total: ${criticalCount} critical, ${highCount} high, ${mediumCount} medium):\n\n${signalLines}\n\nWrite a 3-5 sentence morning summary covering: (1) the most urgent issues requiring action today, (2) any patterns across customers, (3) top 3 recommended actions for the day. Be specific. No fluff.`

  const url = `https://${location}-aiplatform.googleapis.com/v1/projects/${project}/locations/${location}/publishers/google/models/${model}:generateContent`
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
      generationConfig: { temperature: 0.4, maxOutputTokens: 1024 },
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

// ── Route registration ────────────────────────────────────────────────────────

export function registerDashboardRoutes(app: Hono): void {

  // ── Health Score endpoints (R04) ──────────────────────────────────────────

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

  // ── Morning Summary + Priority Action (R06/R13) ──────────────────────────

  app.get('/api/morning-summary', async (c) => {
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

  // ── Stakeholder engagement (R31) ──────────────────────────────────────────
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

  // ── Temporal delta (R33) ──────────────────────────────────────────────────
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

  // ── BKL-M39: Dashboard freshness endpoint ─────────────────────────────────
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

  // ── R05: KPI history / sparkline data ────────────────────────────────────
  app.get('/api/kpis/history', (c) => {
    const days = parseInt(c.req.query('days') ?? '30', 10)
    try {
      const history = getRecentHistory(Math.min(Math.max(days, 1), 90))
      return c.json({ snapshots: history })
    } catch (e) {
      return c.json({ error: sanitizeErr(e) }, 500)
    }
  })

  // ── GET /api/kpis — Aggregated KPIs for the dashboard ────────────────────
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

  // ── GET /api/territory-names?pod=WEST_COMM_CORP_NORTHWEST ────────────────
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

  // ── GET /api/territory-lookup?territory=WEST_COMM_CORP_NORTHWEST_TERR01 ──
  // Reads the territory Google Sheet live and returns { aeName, accounts } for
  // the requested territory. Does not require aes.json to be populated.
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
}
