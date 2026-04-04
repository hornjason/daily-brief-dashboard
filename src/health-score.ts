import { readFileSync } from 'fs'
import type { SupportCase, ProductSubscription, CalendarEvent, EmailHighlight, Customer } from './types.ts'
import type { CCSPRecord } from './sheets.ts'
import type { PipelineRecord } from './pipeline.ts'
import { readSheetCache, readCCSPCache, readPipelineCache } from './cache-layer.ts'

// ── Types ────────────────────────────────────────────────────────────────────

export interface HealthBreakdown {
  cases:         { score: number; signal: string }
  subscriptions: { score: number; signal: string }
  meetings:      { score: number; signal: string }
  emails:        { score: number; signal: string }
  pipeline:      { score: number; signal: string }
  cloudSpend:    { score: number; signal: string }
}

export interface HealthScore {
  name:        string
  score:       number
  status:      'red' | 'yellow' | 'green'
  breakdown:   HealthBreakdown
  lastUpdated: Record<string, string | null>
}

// ── Weights ──────────────────────────────────────────────────────────────────

const WEIGHTS = {
  cases:         0.25,
  subscriptions: 0.20,
  meetings:      0.15,
  emails:        0.15,
  pipeline:      0.15,
  cloudSpend:    0.10,
}

// ── Subscore: Support Cases ──────────────────────────────────────────────────

function scoreCases(
  customerAccountNumbers: string[],
  allCases: SupportCase[],
): { score: number; signal: string } {
  if (!customerAccountNumbers.length) {
    return { score: 50, signal: 'No account numbers — cannot match cases' }
  }
  const acctSet = new Set(customerAccountNumbers)
  const matched = allCases.filter(c => acctSet.has(c.accountNumber))

  if (matched.length === 0) return { score: 100, signal: 'No open cases' }

  const hasSev1 = matched.some(c => c.severity === '1')
  const hasSev2 = matched.some(c => c.severity === '2')

  if (hasSev1) {
    const sev1Count = matched.filter(c => c.severity === '1').length
    return { score: 0, signal: `${sev1Count} Sev1 case${sev1Count > 1 ? 's' : ''} open` }
  }
  if (hasSev2) {
    const sev2Count = matched.filter(c => c.severity === '2').length
    return { score: 30, signal: `${sev2Count} Sev2 case${sev2Count > 1 ? 's' : ''} open` }
  }
  return { score: 60, signal: `${matched.length} open case${matched.length > 1 ? 's' : ''} (Sev3/4)` }
}

// ── Free / Beta / Trial filter (BKL-M45) ────────────────────────────────────
// Pattern-match on productDescription and sku keywords to identify non-paid
// subscriptions that should not trigger renewal alarms or health score penalties.

const FREE_TRIAL_RE = /\b(free|beta|trial|eval|evaluation|developer|self-support|no-support)\b/i

export function isFreeOrTrial(sub: ProductSubscription): boolean {
  return FREE_TRIAL_RE.test(sub.productDescription) || FREE_TRIAL_RE.test(sub.sku)
}

// ── Subscore: Subscriptions ──────────────────────────────────────────────────

function parseSubscriptionDate(raw: string): Date | null {
  // Supports "DD-MMM-YYYY" (e.g. "23-JAN-2024") and ISO "YYYY-MM-DD"
  if (!raw) return null

  const monthMap: Record<string, number> = {
    JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5,
    JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11,
  }
  const dmy = raw.match(/^(\d{1,2})-([A-Z]{3})-(\d{4})$/i)
  if (dmy) {
    const month = monthMap[dmy[2].toUpperCase()]
    if (month !== undefined) return new Date(Number(dmy[3]), month, Number(dmy[1]))
  }

  const d = new Date(raw)
  return isNaN(d.getTime()) ? null : d
}

function scoreSubscriptions(
  subscriptions: ProductSubscription[],
): { score: number; signal: string } {
  if (!subscriptions.length) return { score: 50, signal: 'No subscription data' }

  const now = new Date()
  let soonestDays = Infinity
  let expiredCount = 0

  for (const sub of subscriptions) {
    if (sub.status?.toLowerCase() !== 'active') continue
    if (!sub.endDate) continue
    // BKL-M45: skip free/trial subs from expiration penalty (still counted in total)
    if (isFreeOrTrial(sub)) continue

    const end = parseSubscriptionDate(sub.endDate)
    if (!end) continue

    const daysLeft = Math.ceil((end.getTime() - now.getTime()) / (1000 * 60 * 60 * 24))

    if (daysLeft < 0) {
      expiredCount++
    } else if (daysLeft < soonestDays) {
      soonestDays = daysLeft
    }
  }

  if (expiredCount > 0) {
    return { score: 10, signal: `${expiredCount} expired subscription${expiredCount > 1 ? 's' : ''}` }
  }
  if (soonestDays <= 30) {
    return { score: 20, signal: `Renewal due in ${soonestDays} days` }
  }
  if (soonestDays <= 60) {
    return { score: 50, signal: `Renewal in ${soonestDays} days` }
  }
  if (soonestDays <= 90) {
    return { score: 70, signal: `Renewal in ${soonestDays} days` }
  }
  return { score: 100, signal: soonestDays === Infinity ? 'No active end dates' : `Next renewal ${soonestDays}d out` }
}

// ── Subscore: Meetings ───────────────────────────────────────────────────────
// v1: meetings are not cached, use neutral score

function scoreMeetings(): { score: number; signal: string } {
  return { score: 50, signal: 'No cached meeting data (v1)' }
}

// ── Subscore: Emails ─────────────────────────────────────────────────────────
// v1: emails are not cached, use neutral score

function scoreEmails(): { score: number; signal: string } {
  return { score: 50, signal: 'No cached email data (v1)' }
}

// ── Subscore: Pipeline ───────────────────────────────────────────────────────

function scorePipeline(
  customerName: string,
  allPipeline: PipelineRecord[],
): { score: number; signal: string } {
  const normalName = customerName.toLowerCase()
  const matched = allPipeline.filter(p =>
    p.accountName.toLowerCase().includes(normalName) ||
    normalName.includes(p.accountName.toLowerCase()),
  )

  if (matched.length === 0) return { score: 70, signal: 'No pipeline opportunities' }

  // Check forecast categories
  const closedWon = matched.filter(p => p.forecastCategory === 'Closed')
  const commit    = matched.filter(p => p.forecastCategory === 'Commit')
  const bestCase  = matched.filter(p => p.forecastCategory === 'Best Case')
  const pipeline  = matched.filter(p => p.forecastCategory === 'Pipeline')
  const omitted   = matched.filter(p => p.forecastCategory === 'Omitted')

  const totalAcv = matched.reduce((sum, p) => sum + (p.acv || 0), 0)

  // Lots of committed/closed = healthy; lots of pipeline/omitted = needs attention
  if (commit.length > 0 || closedWon.length > 0) {
    return { score: 90, signal: `${matched.length} opp${matched.length > 1 ? 's' : ''} ($${(totalAcv / 1000).toFixed(0)}K ACV), ${commit.length} committed` }
  }
  if (bestCase.length > 0) {
    return { score: 70, signal: `${matched.length} opp${matched.length > 1 ? 's' : ''} ($${(totalAcv / 1000).toFixed(0)}K ACV), best case` }
  }
  if (omitted.length === matched.length) {
    return { score: 40, signal: `${omitted.length} opp${omitted.length > 1 ? 's' : ''} omitted from forecast` }
  }
  return { score: 60, signal: `${matched.length} opp${matched.length > 1 ? 's' : ''} in pipeline ($${(totalAcv / 1000).toFixed(0)}K ACV)` }
}

// ── Subscore: Cloud Spend (CCSP) ─────────────────────────────────────────────

function scoreCloudSpend(
  customerName: string,
  allCCSP: CCSPRecord[],
): { score: number; signal: string } {
  const normalName = customerName.toLowerCase()
  const matched = allCCSP.filter(r =>
    r.accountName.toLowerCase().includes(normalName) ||
    normalName.includes(r.accountName.toLowerCase()),
  )

  if (matched.length === 0) return { score: 50, signal: 'No cloud spend data' }

  // Sort by quarter descending to compare most recent vs previous
  const sorted = [...matched].sort((a, b) => b.quarter.localeCompare(a.quarter))
  const latestQ = sorted[0].quarter
  const latestRecords = sorted.filter(r => r.quarter === latestQ)
  const latestTotal = latestRecords.reduce((sum, r) => sum + (r.acvPlus || 0), 0)

  // Find previous quarter
  const prevRecords = sorted.filter(r => r.quarter !== latestQ)
  if (prevRecords.length === 0) {
    return { score: 70, signal: `Cloud spend $${(latestTotal / 1000).toFixed(0)}K (${latestQ}, single quarter)` }
  }

  const prevQ = prevRecords[0].quarter
  const prevQRecords = prevRecords.filter(r => r.quarter === prevQ)
  const prevTotal = prevQRecords.reduce((sum, r) => sum + (r.acvPlus || 0), 0)

  if (prevTotal === 0) {
    return { score: 70, signal: `Cloud spend $${(latestTotal / 1000).toFixed(0)}K (${latestQ})` }
  }

  const changePct = ((latestTotal - prevTotal) / prevTotal) * 100

  if (changePct >= 10) {
    return { score: 100, signal: `Cloud spend growing +${changePct.toFixed(0)}% ($${(latestTotal / 1000).toFixed(0)}K)` }
  }
  if (changePct >= -10) {
    return { score: 80, signal: `Cloud spend stable ($${(latestTotal / 1000).toFixed(0)}K, ${changePct >= 0 ? '+' : ''}${changePct.toFixed(0)}%)` }
  }
  if (changePct >= -20) {
    return { score: 40, signal: `Cloud spend declining ${changePct.toFixed(0)}% ($${(latestTotal / 1000).toFixed(0)}K)` }
  }
  return { score: 10, signal: `Cloud spend dropping ${changePct.toFixed(0)}% ($${(latestTotal / 1000).toFixed(0)}K)` }
}

// ── Composite health score ───────────────────────────────────────────────────

export function computeHealthScore(
  customer: Customer,
  allCases: SupportCase[],
  allPipeline: PipelineRecord[],
  allCCSP: CCSPRecord[],
  subscriptions: ProductSubscription[],
  sheetsUpdatedAt: string | null,
  casesUpdatedAt: string | null,
  pipelineUpdatedAt: string | null,
  ccspUpdatedAt: string | null,
): HealthScore {
  const cases         = scoreCases(customer.accountNumbers ?? [], allCases)
  const subs          = scoreSubscriptions(subscriptions)
  const meetings      = scoreMeetings()
  const emails        = scoreEmails()
  const pipeline      = scorePipeline(customer.name, allPipeline)
  const cloudSpend    = scoreCloudSpend(customer.name, allCCSP)

  const score = Math.round(
    cases.score      * WEIGHTS.cases +
    subs.score       * WEIGHTS.subscriptions +
    meetings.score   * WEIGHTS.meetings +
    emails.score     * WEIGHTS.emails +
    pipeline.score   * WEIGHTS.pipeline +
    cloudSpend.score * WEIGHTS.cloudSpend,
  )

  const status: 'red' | 'yellow' | 'green' = score >= 70 ? 'green' : score >= 40 ? 'yellow' : 'red'

  return {
    name: customer.name,
    score,
    status,
    breakdown: {
      cases,
      subscriptions: subs,
      meetings,
      emails,
      pipeline,
      cloudSpend,
    },
    lastUpdated: {
      cases: casesUpdatedAt,
      subscriptions: sheetsUpdatedAt,
      meetings: null,
      emails: null,
      pipeline: pipelineUpdatedAt,
      cloudSpend: ccspUpdatedAt,
    },
  }
}

// ── Bulk computation from cache ──────────────────────────────────────────────

interface CasesCache {
  scrapedAt?: string
  cases?: SupportCase[]
}

export function computeAllHealthScores(
  customers: Customer[],
  casesCachePath: string,
): HealthScore[] {
  // Read global caches once
  let allCases: SupportCase[] = []
  let casesUpdatedAt: string | null = null
  try {
    const raw: CasesCache = JSON.parse(readFileSync(casesCachePath, 'utf-8'))
    allCases = raw.cases ?? []
    casesUpdatedAt = raw.scrapedAt ?? null
  } catch { /* no cases cache */ }

  const ccspCache   = readCCSPCache()
  const allCCSP     = ccspCache?.records ?? []
  const ccspUpdated = ccspCache?.cachedAt ?? null

  const pipeCache       = readPipelineCache()
  const allPipeline     = pipeCache?.records ?? []
  const pipelineUpdated = pipeCache?.cachedAt ?? null

  const results: HealthScore[] = []
  for (const customer of customers) {
    const sheetCache = readSheetCache(customer.name)
    const subscriptions = sheetCache?.rows ?? []
    const sheetsUpdated = sheetCache?.cachedAt ?? null

    results.push(computeHealthScore(
      customer,
      allCases,
      allPipeline,
      allCCSP,
      subscriptions,
      sheetsUpdated,
      casesUpdatedAt,
      pipelineUpdated,
      ccspUpdated,
    ))
  }

  return results
}

// ── Confidence Score (BKL-AI28) ──────────────────────────────────────────────

export interface ConfidenceScoreBreakdown {
  subProximity:       { score: number; signal: string }
  interactionRecency: { score: number; signal: string }
  caseHealth:         { score: number; signal: string }
  pipelinePresence:   { score: number; signal: string }
  total:              number
}

/**
 * Compute a 0-100 confidence score measuring engagement health for a customer.
 *
 * Sub proximity:       0-40   (how close subscriptions are to expiry)
 * Interaction recency: 0-30   (days since last interaction)
 * Case health:         0-20   (open case severity)
 * Pipeline presence:   0-10   (has active pipeline)
 */
export function computeConfidenceScore(
  subscriptions: ProductSubscription[],
  lastInteractionDays: number,
  openCases: SupportCase[],
  hasPipeline: boolean,
): ConfidenceScoreBreakdown {
  // Sub proximity (0-40)
  let subScore = 40
  let subSignal = 'No active subscriptions'
  const now = new Date()
  let soonestDays = Infinity
  for (const sub of subscriptions) {
    if (sub.status?.toLowerCase() !== 'active') continue
    if (isFreeOrTrial(sub)) continue
    const end = sub.endDate ? new Date(sub.endDate) : null
    if (!end) continue
    const daysLeft = Math.ceil((end.getTime() - now.getTime()) / 86_400_000)
    if (daysLeft < soonestDays) soonestDays = daysLeft
  }
  if (soonestDays !== Infinity) {
    if (soonestDays < 0)  { subScore = 0;  subSignal = 'Subscription expired' }
    else if (soonestDays <= 30)  { subScore = 5;  subSignal = `Renewal in ${soonestDays}d` }
    else if (soonestDays <= 60)  { subScore = 15; subSignal = `Renewal in ${soonestDays}d` }
    else if (soonestDays <= 90)  { subScore = 25; subSignal = `Renewal in ${soonestDays}d` }
    else                         { subScore = 40; subSignal = `Next renewal ${soonestDays}d out` }
  }

  // Interaction recency (0-30)
  let interactionScore = 30
  let interactionSignal = 'No interaction data'
  if (lastInteractionDays >= 0) {
    if (lastInteractionDays > 90)      { interactionScore = 0;  interactionSignal = `No interaction in ${lastInteractionDays}d` }
    else if (lastInteractionDays > 60) { interactionScore = 8;  interactionSignal = `Last interaction ${lastInteractionDays}d ago` }
    else if (lastInteractionDays > 30) { interactionScore = 18; interactionSignal = `Last interaction ${lastInteractionDays}d ago` }
    else if (lastInteractionDays > 14) { interactionScore = 24; interactionSignal = `Last interaction ${lastInteractionDays}d ago` }
    else                               { interactionScore = 30; interactionSignal = `Active engagement (${lastInteractionDays}d ago)` }
  }

  // Case health (0-20)
  let caseScore = 20
  let caseSignal = 'No open cases'
  if (openCases.length > 0) {
    const hasSev1 = openCases.some(c => c.severity === '1')
    const hasSev2 = openCases.some(c => c.severity === '2')
    if (hasSev1)      { caseScore = 0;  caseSignal = `Sev1 case open` }
    else if (hasSev2) { caseScore = 8;  caseSignal = `Sev2 case open` }
    else              { caseScore = 14; caseSignal = `${openCases.length} open case(s) (Sev3/4)` }
  }

  // Pipeline presence (0-10)
  const pipelineScore  = hasPipeline ? 10 : 5
  const pipelineSignal = hasPipeline ? 'Active pipeline' : 'No pipeline opportunities'

  const total = subScore + interactionScore + caseScore + pipelineScore

  return {
    subProximity:       { score: subScore, signal: subSignal },
    interactionRecency: { score: interactionScore, signal: interactionSignal },
    caseHealth:         { score: caseScore, signal: caseSignal },
    pipelinePresence:   { score: pipelineScore, signal: pipelineSignal },
    total,
  }
}
