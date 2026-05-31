/**
 * Account Intelligence Module — GitHub Issue #274
 * Migrates legacy intelligence cache to registry signal contract.
 * GitHub Issue #328 — ensureFresh implementation
 */

import { FeatureModuleRegistry, type Signal } from '../feature-module-registry.ts'
import { existsSync, readFileSync } from 'fs'
import { resolve } from 'path'

const CACHE_DIR = process.env.CACHE_DIR ?? 'data/cache'
const INTELLIGENCE_TTL_MS = 14 * 24 * 60 * 60 * 1000  // 14 days

function extractStructuredFields(companyText: string): {
  businessObjectives: string[]
  initiatives: string[]
  technologyStrategy: string | null
} {
  const sections: Record<string, string> = {}
  let current: string | null = null
  for (const line of companyText.split('\n')) {
    const match = line.match(/^#+\s+(.+)/)
    if (match) {
      current = match[1].trim()
      sections[current] = ''
    } else if (current) {
      sections[current] += line + '\n'
    }
  }

  const objectives: string[] = []
  const initiatives: string[] = []

  const oppsText = sections['Opportunities (External, Positive — informed by PESTLE)'] ?? ''
  for (const line of oppsText.split('\n')) {
    const fact = line.match(/\*\*Specific Fact:\*\*\s*(.+)/i)
    if (fact) objectives.push(fact[1].trim().slice(0, 200))
  }

  const strengthsText = sections['Strengths (Internal, Positive)'] ?? ''
  for (const line of strengthsText.split('\n')) {
    const fact = line.match(/\*\*Specific Fact:\*\*\s*(.+)/i)
    if (fact) initiatives.push(fact[1].trim().slice(0, 200))
  }

  const techText = sections['Technological'] ?? ''
  const techStrategy = techText.trim().slice(0, 500) || null

  return {
    businessObjectives: objectives.slice(0, 5),
    initiatives: initiatives.slice(0, 5),
    technologyStrategy: techStrategy,
  }
}

/**
 * Check if intelligence cache exists and is fresh.
 */
function isIntelligenceFresh(customerSlug: string): boolean {
  const path = resolve(CACHE_DIR, 'intelligence', `${customerSlug}.json`)
  if (!existsSync(path)) return false

  try {
    const data = JSON.parse(readFileSync(path, 'utf-8'))
    if (data.noData) return false  // Treat noData as stale
    const age = Date.now() - new Date(data.cachedAt).getTime()
    return age < INTELLIGENCE_TTL_MS
  } catch {
    return false
  }
}

FeatureModuleRegistry.register({
  name: 'intelligence',
  displayName: 'Intelligence',
  refreshEndpoint: '/api/intelligence/generate-all',
  scope: 'customer',
  cachePaths: () => [],
  cacheTtlMs: INTELLIGENCE_TTL_MS,
  async fetch(): Promise<void> {},
  async cleanup(): Promise<void> {},
  async syncNow(): Promise<void> {},

  async ensureFresh(customerSlug: string): Promise<void> {
    if (isIntelligenceFresh(customerSlug)) {
      return  // Cache is fresh
    }

    // Cache is stale or missing — trigger pipeline
    const { runIntelligencePipeline } = await import('../account-intelligence.ts')
    const { customers } = await import('../server-state.ts')
    const { toSlug } = await import('../cache-layer.ts')
    const customer = customers.find(c => toSlug(c.name) === customerSlug)

    if (!customer) {
      console.warn(`[intelligence-module] ensureFresh: customer not found for slug ${customerSlug}`)
      return
    }

    await runIntelligencePipeline(customer.name, false)  // force=false to respect internal TTL checks
  },

  async signals(customerSlug: string): Promise<Signal[]> {
    const path = resolve(CACHE_DIR, 'intelligence', `${customerSlug}.json`)
    if (!existsSync(path)) return []

    let data: any
    try {
      data = JSON.parse(readFileSync(path, 'utf-8'))
    } catch { return [] }

    if (data.noData) return []

    const signals: Signal[] = []

    if (data.company) {
      const structured = extractStructuredFields(data.company)
      signals.push({
        source: 'intelligence',
        type: 'intelligence',
        headline: `Company intelligence for ${data.customerName ?? customerSlug}`,
        detail: data.company.substring(0, 300),
        rawRelevance: 0.7,  // ADR-027
        timestamp: data.cachedAt ?? new Date().toISOString(),
        url: data.companyDocUrl,
        metadata: {
          customerSlug,  // ADR-027: Mark as customer-specific
          docType: 'company',
          length: data.company.length,
          docUrl: data.companyDocUrl,
          ...structured,
        },
      })
    }

    if (data.industry) {
      signals.push({
        source: 'intelligence',
        type: 'intelligence',
        headline: `Industry analysis: ${data.industryClassification ?? 'unclassified'}`,
        detail: data.industry.substring(0, 300),
        rawRelevance: 0.6,  // ADR-027
        timestamp: data.cachedAt ?? new Date().toISOString(),
        url: data.industryDocUrl,
        metadata: {
          customerSlug,  // ADR-027: Mark as customer-specific
          docType: 'industry',
          length: data.industry.length,
          docUrl: data.industryDocUrl,
          industrySegment: data.industryClassification ?? null,
        },
      })
    }

    return signals
  },
})
