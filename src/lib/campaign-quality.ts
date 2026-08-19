/**
 * Campaign Quality Assessment — Signal quality gate + footprint derivation
 * Extracted from campaign-service.ts (#1172).
 */

import { SIGNAL_TIERS } from './signal-loader.ts'
import type { Signal } from '../feature-module-registry.ts'
import type { PersonaBrief } from './persona-selector.ts'
import { isFreeTierProduct } from '../campaign-html-template.ts'

// ── Threat/solution derivation (ADR-044 Phase 2) ───────────────────────────

const THREAT_PATTERNS: Array<{ pattern: RegExp; threat: string }> = [
  { pattern: /saas tax|sb 122|sales tax/, threat: 'the SaaS tax' },
  { pattern: /security breach|data breach|cyber attack/, threat: 'security breach exposure' },
  { pattern: /vendor lock-in|vmware|broadcom/, threat: 'vendor lock-in and rising licensing costs' },
  { pattern: /cloud cost|cloud spend|cloud migration/, threat: 'uncontrolled cloud costs' },
  { pattern: /compliance|regulation|audit/, threat: 'compliance requirements' },
  { pattern: /technical debt|legacy|moderniz/, threat: 'technical debt' },
]

const SOLUTION_PATTERNS: Array<{ pattern: RegExp; solution: string }> = [
  { pattern: /ansible|automation/, solution: 'self-managed automation' },
  { pattern: /openshift|container|kubernetes/, solution: 'a unified container platform' },
  { pattern: /rhel|enterprise linux/, solution: 'a standardized enterprise Linux foundation' },
  { pattern: /security|acs|stackrox/, solution: 'integrated security across the stack' },
  { pattern: /ai|ml|model/, solution: 'an enterprise AI platform' },
]

export function deriveThreatSolution(materialTitle: string, materialContent: string): { threat: string; solution: string } {
  const lower = (materialTitle + ' ' + materialContent).toLowerCase()
  const matched = THREAT_PATTERNS.find(tp => tp.pattern.test(lower))
  const threat = matched?.threat || 'rising infrastructure costs'
  const solMatched = SOLUTION_PATTERNS.find(sp => sp.pattern.test(lower))
  const solution = solMatched?.solution || 'consolidated infrastructure'
  return { threat, solution }
}

const SPECULATION_PATTERN = /\b(likely|suggests|indicates|probably|appears|implies|may include|current use|operational reliance|technical requirements|infrastructure strategy)\b|existing\s.*(?:portfolio|tools|automation)|e\.g\.,/i

export function isSpeculativeInstalledBase(text: string, customerName?: string): boolean {
  if (customerName) {
    if (text.includes(customerName)) return true
    const firstName = customerName.split(/\s+/)[0]
    if (firstName.length > 2 && text.startsWith(firstName + ' ')) return true
  }
  if (text.length > 40 && SPECULATION_PATTERN.test(text)) return true
  if (text.length > 120 && !text.includes(',')) return true
  return false
}

export function deriveFootprint(
  pass0Briefs: PersonaBrief[],
  subSignals: Signal[],
  registrySignals: Signal[],
  customerName?: string,
): { current: string; expansion: string } | undefined {
  const rawSubProducts = subSignals.map(s => s.metadata?.product as string ?? s.headline).filter(Boolean)
  if (rawSubProducts.length > 0) {
    const subProducts = [...new Set(rawSubProducts.map(p => p.replace(/\s*\d+\s*subscriptions?\s*total\s*/gi, '').trim()))].filter(p => !isFreeTierProduct(p))

    let expansion = ''

    if (pass0Briefs.length > 0) {
      const valueProps = pass0Briefs.map(b => b.valueProposition).filter(Boolean)
      if (valueProps.length > 0) {
        expansion = valueProps[0]
      }
    }

    if (!expansion) {
      const intelSignals = registrySignals.filter(s => s.source === 'intelligence')
      if (intelSignals.length > 0) {
        expansion = intelSignals.slice(0, 3).map(s => s.headline).join(', ')
      }
    }

    if (!expansion) {
      expansion = 'Expansion opportunities under evaluation'
    }

    return {
      current: subProducts.join(', '),
      expansion,
    }
  }

  if (pass0Briefs.length > 0) {
    const installedBases = pass0Briefs.map(b => b.installedBase).filter(Boolean)
      .filter(b => !isSpeculativeInstalledBase(b, customerName))
    const uniqueBases = [...new Set(installedBases)]
    const expansions = pass0Briefs.map(b => b.valueProposition).filter(Boolean)
    const competitive = pass0Briefs
      .map(b => b.competitiveContext)
      .filter((c): c is string => c !== null && c.length > 0)

    if (uniqueBases.length > 0) {
      return {
        current: uniqueBases.join(' · '),
        expansion: competitive.length > 0
          ? `${expansions[0] || 'Expansion under evaluation'} (Competitive: ${competitive[0]})`
          : expansions[0] || 'Expansion opportunities under evaluation',
      }
    }
  }

  return undefined
}

// ── Structured HTML quality scoring (parallel validation) ───────────────────
export function scoreStructuredOutput(html: string): { sections: number; emails: number; words: number } {
  const sections = (html.match(/<h[23][^>]*>/g) || []).length
  const emails = (html.match(/📧/g) || []).length
  const words = html.replace(/<[^>]*>/g, '').split(/\s+/).filter(w => w.length > 0).length
  return { sections, emails, words }
}

// ── Signal Quality Gate (#1120) ──────────────────────────────────────────────
export interface SignalQualityAssessment {
  disposition: 'PROCEED' | 'DEGRADED' | 'BLOCKED'
  signalCompleteness: number
  missing: string[]
  stale: string[]
  reasons: Record<string, string>
}

export class CampaignQualityGateError extends Error {
  constructor(
    public assessment: SignalQualityAssessment,
    public customerName: string,
  ) {
    const missingList = assessment.missing.map(s => `  - ${s}: ${assessment.reasons[s] || 'not available'}`).join('\n')
    super(`Campaign generation blocked for ${customerName} — missing critical signals:\n${missingList}\n\nTo override: add forceGenerate: true to request. Warning banner will be injected into output.`)
    this.name = 'CampaignQualityGateError'
  }
}

export function assessSignalQuality(
  loaded: string[],
  missing: string[],
): SignalQualityAssessment {
  const loadedSet = new Set(loaded)
  const missingSet = new Set(missing)
  const reasons: Record<string, string> = {}
  const stale: string[] = []

  const criticalMissing: string[] = []
  for (const source of SIGNAL_TIERS.CRITICAL) {
    if (missingSet.has(source) || !loadedSet.has(source)) {
      criticalMissing.push(source)
      reasons[source] = 'not loaded — no data available for this customer'
    }
  }

  const contextMissing: string[] = []
  for (const source of SIGNAL_TIERS.CONTEXT) {
    if (missingSet.has(source) || !loadedSet.has(source)) {
      contextMissing.push(source)
      reasons[source] = 'not loaded'
    }
  }

  const criticalScore = ((SIGNAL_TIERS.CRITICAL.length - criticalMissing.length) / SIGNAL_TIERS.CRITICAL.length) * 60
  const contextScore = ((SIGNAL_TIERS.CONTEXT.length - contextMissing.length) / SIGNAL_TIERS.CONTEXT.length) * 30
  const enrichmentTotal = SIGNAL_TIERS.ENRICHMENT.length
  const enrichmentLoaded = SIGNAL_TIERS.ENRICHMENT.filter(s => loadedSet.has(s)).length
  const enrichmentScore = (enrichmentLoaded / enrichmentTotal) * 10
  const signalCompleteness = Math.round(criticalScore + contextScore + enrichmentScore)

  let disposition: 'PROCEED' | 'DEGRADED' | 'BLOCKED'
  if (criticalMissing.length > 0) {
    disposition = 'BLOCKED'
  } else if (contextMissing.length > 0) {
    disposition = 'DEGRADED'
  } else {
    disposition = 'PROCEED'
  }

  return {
    disposition,
    signalCompleteness,
    missing: [...criticalMissing, ...contextMissing],
    stale,
    reasons,
  }
}
