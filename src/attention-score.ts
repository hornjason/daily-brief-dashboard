/**
 * BKL-UX52: Attention score computation.
 *
 * Score formula (0-100, capped):
 *   Any Sev1 open case:              +30
 *   Any Sev2 open case:              +15
 *   Pipeline closing within 30 days: +20
 *   Renewal expiring within 90 days: +15
 *   Customer brief older than 96h:   +10
 *
 * Computed server-side from cached data. Must add <5ms per customer at 200 customers.
 */
import type { SupportCase, ProductSubscription, Customer } from './types.ts'
import type { PipelineRecord } from './pipeline.ts'
import { readSheetCache, readLatestBriefCache } from './cache-layer.ts'
import { isFreeOrTrial } from './health-score.ts'

export interface AttentionResult {
  attentionScore: number
  attentionReasons: string[]
}

/**
 * Compute attention score for a single customer.
 * All data lookups use pre-loaded arrays for O(1) amortized access.
 */
export function computeAttentionScore(
  customer: Customer,
  customerCases: SupportCase[],
  customerPipeline: PipelineRecord[],
  subscriptions: ProductSubscription[],
  briefCachedAt: string | null,
): AttentionResult {
  let score = 0
  const reasons: string[] = []

  // Sev1 cases: +30
  const sev1Cases = customerCases.filter(c => c.severity === '1')
  if (sev1Cases.length > 0) {
    score += 30
    reasons.push(`Sev1 case open (${sev1Cases.length} case${sev1Cases.length > 1 ? 's' : ''})`)
  }

  // Sev2 cases: +15
  const sev2Cases = customerCases.filter(c => c.severity === '2')
  if (sev2Cases.length > 0) {
    score += 15
    reasons.push(`Sev2 case open (${sev2Cases.length} case${sev2Cases.length > 1 ? 's' : ''})`)
  }

  // Pipeline closing within 30 days: +20
  const now = new Date()
  const in30Days = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000)
  const closingSoon = customerPipeline.filter(p => {
    if (!p.closeDate) return false
    const close = new Date(p.closeDate)
    return close >= now && close <= in30Days
  })
  if (closingSoon.length > 0) {
    const totalAcv = closingSoon.reduce((sum, p) => sum + (p.acv || 0), 0)
    const daysOut = Math.ceil((new Date(closingSoon[0].closeDate).getTime() - now.getTime()) / (24 * 60 * 60 * 1000))
    reasons.push(`Pipeline $${(totalAcv / 1000).toFixed(0)}K closes in ${daysOut}d`)
    score += 20
  }

  // Renewal expiring within 90 days: +15
  const in90Days = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000)
  let soonestRenewalDays = Infinity
  let renewalCount = 0
  for (const sub of subscriptions) {
    if (sub.status?.toLowerCase() !== 'active') continue
    if (isFreeOrTrial(sub)) continue
    if (!sub.endDate) continue
    const end = parseDate(sub.endDate)
    if (!end) continue
    const daysLeft = Math.ceil((end.getTime() - now.getTime()) / (24 * 60 * 60 * 1000))
    if (daysLeft > 0 && daysLeft <= 90) {
      renewalCount++
      if (daysLeft < soonestRenewalDays) soonestRenewalDays = daysLeft
    }
  }
  if (renewalCount > 0) {
    score += 15
    reasons.push(`${renewalCount} subscription${renewalCount > 1 ? 's' : ''} expire${renewalCount === 1 ? 's' : ''} in ${soonestRenewalDays}d`)
  }

  // Brief older than 96 hours: +10
  if (briefCachedAt) {
    const briefAge = now.getTime() - new Date(briefCachedAt).getTime()
    const hours96 = 96 * 60 * 60 * 1000
    if (briefAge > hours96) {
      score += 10
      const hoursAgo = Math.round(briefAge / (60 * 60 * 1000))
      reasons.push(`Brief is ${hoursAgo}h old`)
    }
  } else {
    // No brief ever generated
    score += 10
    reasons.push('No brief generated')
  }

  return {
    attentionScore: Math.min(score, 100),
    attentionReasons: reasons,
  }
}

/**
 * Compute attention scores for all customers in bulk.
 * Pre-indexes cases and pipeline by account for O(1) per-customer lookups.
 */
export function computeAllAttentionScores(
  customers: Customer[],
  allCases: SupportCase[],
  allPipeline: PipelineRecord[],
): Map<string, AttentionResult> {
  // Pre-index cases by account number
  const casesByAccount = new Map<string, SupportCase[]>()
  for (const c of allCases) {
    const key = String(c.accountNumber)
    if (!casesByAccount.has(key)) casesByAccount.set(key, [])
    casesByAccount.get(key)!.push(c)
  }

  // Pre-index pipeline by normalized account name
  const pipelineByName = new Map<string, PipelineRecord[]>()
  for (const p of allPipeline) {
    const key = p.accountName.toLowerCase()
    if (!pipelineByName.has(key)) pipelineByName.set(key, [])
    pipelineByName.get(key)!.push(p)
  }

  const results = new Map<string, AttentionResult>()

  for (const customer of customers) {
    // Gather cases for this customer
    const acctNums = customer.accountNumbers ?? []
    const customerCases: SupportCase[] = []
    for (const num of acctNums) {
      const found = casesByAccount.get(String(num))
      if (found) customerCases.push(...found)
    }

    // Gather pipeline for this customer (name-based matching, same as health-score)
    const normalName = customer.name.toLowerCase()
    const customerPipeline: PipelineRecord[] = []
    for (const [key, records] of pipelineByName) {
      if (key.includes(normalName) || normalName.includes(key)) {
        customerPipeline.push(...records)
      }
    }

    // Read subscriptions from cache
    const sheetCache = readSheetCache(customer.name)
    const subscriptions = sheetCache?.rows ?? []

    // Read latest brief cache timestamp
    const briefCache = readLatestBriefCache(customer.name)
    const briefCachedAt = briefCache?.cachedAt ?? null

    results.set(customer.name, computeAttentionScore(
      customer,
      customerCases,
      customerPipeline,
      subscriptions,
      briefCachedAt,
    ))
  }

  return results
}

/** Parse subscription date — supports "DD-MMM-YYYY" and ISO "YYYY-MM-DD" */
function parseDate(raw: string): Date | null {
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
