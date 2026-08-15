/**
 * Account Intelligence Module — GitHub Issue #274
 * Migrates legacy intelligence cache to registry signal contract.
 * GitHub Issue #328 — ensureFresh implementation
 */

import { FeatureModuleRegistry, type Signal } from '../feature-module-registry.ts'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { resolve } from 'path'

export type ObjectiveCategory = 'financial' | 'security' | 'operational' | 'innovation' | 'growth'

export interface ObjectiveEntry {
  objective: string
  metric: string | null
  priority: 'HIGH' | 'MED' | 'LOW' | null
  source: string
  confidence: 'HIGH' | 'MEDIUM' | 'LOW'
}

export interface CustomerObjectiveProfile {
  financial: ObjectiveEntry[]
  security: ObjectiveEntry[]
  operational: ObjectiveEntry[]
  innovation: ObjectiveEntry[]
  growth: ObjectiveEntry[]
}

const CACHE_DIR = process.env.CACHE_DIR ?? 'data/cache'
const INTELLIGENCE_TTL_MS = 14 * 24 * 60 * 60 * 1000  // 14 days

function parseSections(text: string): Record<string, string> {
  const sections: Record<string, string> = {}
  let current: string | null = null
  for (const line of text.split('\n')) {
    const match = line.match(/^#+\s+(.+)/)
    if (match) {
      current = match[1].trim()
      sections[current] = ''
    } else if (current) {
      sections[current] += line + '\n'
    }
  }
  return sections
}

function extractMetric(text: string): string | null {
  const pctRange = text.match(/(\d+[\-–]\d+%)/)?.[1]
  if (pctRange) return pctRange
  const pct = text.match(/(\d+\.?\d*%)/)?.[1]
  if (pct) return pct
  const dollar = text.match(/(\$[\d,.]+\s*(?:million|billion|M|B)?)/i)?.[1]
  if (dollar) return dollar
  return null
}

const CATEGORY_KEYWORDS: Record<ObjectiveCategory, RegExp> = {
  security: /\b(security|threat|firewall|vulnerabilit|cyber|protection|zero[\s-]trust|compliance)\b/i,
  financial: /\b(cost|margin|EBITDA|cash|fiscal|dividend|EPS|capital|balance\s*sheet|profitab|net\s*income|debt)\b/i,
  operational: /\b(automat|efficien|operation|infrastructure|management|consolidat|streamline|overhead|manual)\b/i,
  growth: /\b(revenue|growth|expansion|market|acqui|partnership|scale|go[\s-]to[\s-]market|guidance|outlook)\b/i,
  innovation: /\b(AI|ML|machine\s*learning|digital\s*transform|R&D|innovat|platform|next[\s-]gen|moderniz)\b/i,
}

function classifyObjective(text: string): ObjectiveCategory {
  for (const [cat, re] of Object.entries(CATEGORY_KEYWORDS) as [ObjectiveCategory, RegExp][]) {
    if (re.test(text)) return cat
  }
  return 'operational'
}

function parseFinancialHealth(sectionText: string): ObjectiveEntry[] {
  const entries: ObjectiveEntry[] = []
  const bullets = sectionText.split(/\n\*\s+/).filter(b => b.trim())
  for (const bullet of bullets) {
    const titleMatch = bullet.match(/\*\*([^*]+)\*\*[:\s]*(.+)/s)
    if (!titleMatch) continue
    const fullText = titleMatch[2].replace(/\n/g, ' ').trim()
    entries.push({
      objective: fullText.slice(0, 200),
      metric: extractMetric(fullText),
      priority: null,
      source: 'Financial Health',
      confidence: 'HIGH',
    })
  }
  return entries
}

function parseStrategicInitiatives(sectionText: string): ObjectiveEntry[] {
  const entries: ObjectiveEntry[] = []
  const initiatives = sectionText.split(/\n\*\s+\*\*(?=[A-Z])/).filter(b => b.trim())
  for (const init of initiatives) {
    const titleMatch = init.match(/\*?\*?([^*]+?)(?:\([^)]+\))?:\*\*\s*(.+)/s)
    if (!titleMatch) {
      const altMatch = init.match(/(.+?):\*\*\s*(.+)/s)
      if (!altMatch) continue
      const title = altMatch[1].replace(/\*+/g, '').trim()
      const body = altMatch[2].replace(/\n/g, ' ').trim()
      const urgency = body.match(/\*\*Buying Urgency:\s*(HIGH|MEDIUM|LOW)\b/i)
      const priority = urgency ? (urgency[1].toUpperCase() === 'MEDIUM' ? 'MED' : urgency[1].toUpperCase() as 'HIGH' | 'LOW') : null
      const objective = `${title}: ${body.replace(/\*\*Buying Urgency:.*?\*\*[^*]*/g, '').trim()}`.slice(0, 200)
      entries.push({
        objective,
        metric: extractMetric(objective),
        priority,
        source: 'Strategic Initiatives',
        confidence: 'HIGH',
      })
      continue
    }
    const title = titleMatch[1].trim()
    const body = titleMatch[2].replace(/\n/g, ' ').trim()
    const urgency = body.match(/\*\*Buying Urgency:\s*(HIGH|MEDIUM|LOW)\b/i)
    const priority = urgency ? (urgency[1].toUpperCase() === 'MEDIUM' ? 'MED' : urgency[1].toUpperCase() as 'HIGH' | 'LOW') : null
    const cleanBody = cleanMarkdown(body)
    const objective = `${title}: ${cleanBody}`.slice(0, 200)
    entries.push({
      objective,
      metric: extractMetric(objective),
      priority,
      source: 'Strategic Initiatives',
      confidence: 'HIGH',
    })
  }
  return entries
}

function cleanMarkdown(text: string): string {
  return text
    .replace(/\*\*Buying Urgency:.*?\*\*[^*]*/g, '')
    .replace(/\*{1,2}/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

function parseFacts(sectionText: string, source: string): ObjectiveEntry[] {
  const entries: ObjectiveEntry[] = []
  const blocks = sectionText.split(/\n\*\s+\*\*Fact:\*\*/).filter(b => b.trim())
  for (const block of blocks) {
    const lines = block.split('\n')
    let factText = ''
    let confidence: 'HIGH' | 'MEDIUM' | 'LOW' = 'MEDIUM'
    for (const line of lines) {
      const confMatch = line.match(/\*\*Confidence:\*\*\s*(HIGH|MEDIUM|LOW)/i)
      if (confMatch) {
        confidence = confMatch[1].toUpperCase() as 'HIGH' | 'MEDIUM' | 'LOW'
        break
      }
      if (!line.match(/\*\*Counter-Risk:|^\s*$|\*\*Barrier to Capture:/)) {
        factText += ' ' + line
      }
    }
    factText = cleanMarkdown(factText).replace(/^Fact:\s*/i, '')
    if (!factText) continue
    entries.push({
      objective: factText.slice(0, 200),
      metric: extractMetric(factText),
      priority: null,
      source,
      confidence,
    })
  }
  return entries
}

export function extractObjectiveProfile(companyText: string): CustomerObjectiveProfile {
  const profile: CustomerObjectiveProfile = {
    financial: [],
    security: [],
    operational: [],
    innovation: [],
    growth: [],
  }
  if (!companyText) return profile

  const sections = parseSections(companyText)

  const financialText = sections['Financial Health'] ?? ''
  if (financialText) {
    for (const entry of parseFinancialHealth(financialText)) {
      profile.financial.push(entry)
    }
  }

  const initiativesText = sections['Strategic Initiatives & Trigger Events'] ?? ''
  if (initiativesText) {
    for (const entry of parseStrategicInitiatives(initiativesText)) {
      const cat = classifyObjective(entry.objective)
      profile[cat].push(entry)
    }
  }

  const strengthsText = sections['Strengths (Internal, Positive)'] ?? ''
  if (strengthsText) {
    for (const entry of parseFacts(strengthsText, 'Strengths')) {
      const cat = classifyObjective(entry.objective)
      profile[cat].push(entry)
    }
  }

  const oppsText = sections['Opportunities (External, Positive — informed by PESTLE)'] ?? ''
  if (oppsText) {
    for (const entry of parseFacts(oppsText, 'Opportunities')) {
      const cat = classifyObjective(entry.objective)
      profile[cat].push(entry)
    }
  }

  return profile
}

function extractStructuredFields(companyText: string): {
  businessObjectives: string[]
  initiatives: string[]
  technologyStrategy: string | null
} {
  const sections = parseSections(companyText)

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
  signalRole: 'trigger',
  signalAudience: 'customer-specific',
  cachePaths: () => [],
  cacheTtlMs: INTELLIGENCE_TTL_MS,
  async fetch(): Promise<void> {},
  async cleanup(): Promise<void> {},
  async syncNow(): Promise<void> {},

  async ensureFresh(customerSlug: string): Promise<void> {
    if (isIntelligenceFresh(customerSlug)) {
      return  // Cache is fresh
    }

    // Heavy Gemini call — skip regen during preflight (ADR-040 OOM prevention)
    console.log(`[intelligence-module] ensureFresh: stale — skipping regen`)
    return
    // DISABLED:
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
      const objectiveProfile = extractObjectiveProfile(data.company)

      const objDir = resolve(CACHE_DIR, 'intelligence')
      try {
        mkdirSync(objDir, { recursive: true })
        writeFileSync(
          resolve(objDir, `${customerSlug}-objectives.json`),
          JSON.stringify(objectiveProfile, null, 2),
        )
      } catch { /* non-fatal — profile still in metadata */ }

      signals.push({
        source: 'intelligence',
        type: 'intelligence',
        headline: `Company intelligence for ${data.customerName ?? customerSlug}`,
        detail: data.company.substring(0, 300),
        rawRelevance: 0.7,  // ADR-027
        timestamp: data.cachedAt ?? new Date().toISOString(),
        url: data.companyDocUrl || undefined,
        metadata: {
          customerSlug,  // ADR-027: Mark as customer-specific
          docType: 'company',
          length: data.company.length,
          companyDocUrl: data.companyDocUrl,
          objectiveProfile,
          detectedTechs: (() => {
            try {
              const techPath = resolve(CACHE_DIR, 'tech-stack', `${customerSlug}.json`)
              if (existsSync(techPath)) {
                const techData = JSON.parse(readFileSync(techPath, 'utf-8'))
                return (techData.technologies ?? []).map((t: any) => t.name)
              }
            } catch {}
            return []
          })(),
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
        url: data.industryDocUrl || undefined,
        metadata: {
          customerSlug,  // ADR-027: Mark as customer-specific
          docType: 'industry',
          length: data.industry.length,
          industryDocUrl: data.industryDocUrl,
          industrySegment: data.industryClassification ?? null,
        },
      })
    }

    return signals
  },
})
