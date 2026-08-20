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

export interface ProductFitEntry {
  product: string
  businessNeed: string
  redHatFit: string
}

export interface CustomerObjectiveProfile {
  financial: ObjectiveEntry[]
  security: ObjectiveEntry[]
  operational: ObjectiveEntry[]
  innovation: ObjectiveEntry[]
  growth: ObjectiveEntry[]
  productFit?: ProductFitEntry[]
}

const CACHE_DIR = process.env.CACHE_DIR ?? 'data/cache'
const INTELLIGENCE_TTL_MS = 14 * 24 * 60 * 60 * 1000  // 14 days

export function parseSections(text: string): Record<string, string> {
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

export const CATEGORY_KEYWORDS: Record<ObjectiveCategory, RegExp> = {
  security: /\b(security|threat|firewall|vulnerabilit|cyber|protection|zero[\s-]trust|compliance|CISO)\b/i,
  financial: /\b(cost|margin|EBITDA|cash|fiscal|dividend|EPS|capital|balance\s*sheet|profitab|net\s*income|debt|CFO|controller|treasurer)\b/i,
  operational: /\b(automat|efficien|operation|infrastructure|management|consolidat|streamline|overhead|manual|CIO|COO)\b/i,
  growth: /\b(revenue|growth|expansion|market|acqui|partnership|scale|go[\s-]to[\s-]market|guidance|outlook|CEO|president)\b/i,
  innovation: /\b(AI|ML|machine\s*learning|digital\s*transform|R&D|innovat|platform|next[\s-]gen|moderniz|CTO)\b/i,
}

function classifyObjective(text: string): ObjectiveCategory {
  for (const [cat, re] of Object.entries(CATEGORY_KEYWORDS) as [ObjectiveCategory, RegExp][]) {
    if (re.test(text)) return cat
  }
  return 'operational'
}

function derivePriority(category: string, metric: string | null): 'HIGH' | 'MED' | 'LOW' | null {
  if (!metric) return null
  const cat = category.toLowerCase()
  if (cat.includes('revenue') || cat.includes('profitability') || cat.includes('growth')) return 'HIGH'
  if (cat.includes('margin') || cat.includes('eps') || cat.includes('net income')) return 'HIGH'
  if (cat.includes('cash') || cat.includes('outlook') || cat.includes('guidance')) return 'MED'
  return 'MED'
}

function parseFinancialHealth(sectionText: string): ObjectiveEntry[] {
  const entries: ObjectiveEntry[] = []
  const seen = new Set<string>()
  let currentCategory = ''

  function add(objective: string, metric: string) {
    if (seen.has(metric)) {
      const existing = entries.find(e => e.metric === metric)
      if (existing && objective.length > existing.objective.length) existing.objective = objective
      return
    }
    seen.add(metric)
    const priority = derivePriority(currentCategory, metric)
    entries.push({ objective, metric, priority, source: 'Financial Health', confidence: 'HIGH' })
  }

  const bullets = sectionText.split(/\n\*\s+/).filter(b => b.trim())
  for (const bullet of bullets) {
    const titleMatch = bullet.match(/\*\*([^*]+)\*\*[:\s]*(.+)/s)
    if (!titleMatch) continue
    const category = titleMatch[1].replace(/:$/, '').trim()
    currentCategory = category
    const text = titleMatch[2].replace(/\n/g, ' ').trim()

    for (const m of text.matchAll(/(?:revenue of |revenue )\$?([\d,.]+)\s*(million|billion|M|B)/gi)) {
      const suffix = /^[mb]$/i.test(m[2]) ? m[2].toUpperCase() : (m[2].toLowerCase() === 'million' ? 'M' : 'B')
      add(`${category}: $${m[1]}${suffix} revenue`, `$${m[1]}${suffix}`)
    }
    for (const m of text.matchAll(/(\d+\.?\d*%)\s*(?:increase|growth|YoY|over \d{4})/gi)) {
      add(`${category}: ${m[1]} growth`, m[1])
    }
    for (const m of text.matchAll(/(?:up |of )\$?([\d,.]+)\s*(million|M)\s*\((?:up )?([\d.]+%)\s*YoY\)/gi)) {
      const suffix = /^m$/i.test(m[2]) ? 'M' : 'M'
      add(`${category}: $${m[1]}${suffix} (+${m[3]} YoY)`, m[3])
    }
    for (const m of text.matchAll(/(?:non-GAAP\s+)?(operating|gross|EBITDA|net)\s*margin\s*(?:of\s*)?([\d.]+%)/gi)) {
      add(`${m[1]} margin of ${m[2]}`, m[2])
    }
    for (const m of text.matchAll(/guidance\s+(?:from\s+[\d\-–]+%\s+)?to\s+(\d+[\-–]\d+%)/gi)) {
      add(`${category}: guidance raised to ${m[1]}`, m[1])
    }
    // outlook pattern removed — guidance pattern above already captures this
    for (const m of text.matchAll(/\$([\d,.]+)\s*(million|billion|M|B)\s*(?:in\s+)?(?:cash|marketable|securities)/gi)) {
      const suffix = /^[mb]$/i.test(m[2]) ? m[2].toUpperCase() : (m[2].toLowerCase() === 'million' ? 'M' : 'B')
      add(`${category}: $${m[1]}${suffix} cash position`, `$${m[1]}${suffix}`)
    }
    for (const m of text.matchAll(/net income\s+(?:was\s+)?\$([\d,.]+)\s*(million|M)/gi)) {
      add(`${category}: $${m[1]}M net income`, `$${m[1]}M`)
    }
    for (const m of text.matchAll(/free cash flow\s+(?:to\s+)?(?:exceed\s+)?(?:the\s+)?~?\$([\d,.]+)\s*(million|M)/gi)) {
      add(`${category}: ~$${m[1]}M free cash flow`, `~$${m[1]}M`)
    }
    for (const m of text.matchAll(/EPS\s+growth\s+(?:to\s+)?(\d+[\-–]\d+%)/gi)) {
      add(`EPS growth ${m[1]}`, m[1])
    }
    for (const m of text.matchAll(/up\s+([\d.]+%)/gi)) {
      if (!seen.has(`${m[1]}|${category}`)) {
        add(`${category}: ${m[1]} growth`, m[1])
      }
    }
  }
  return entries
}

function parseStrategicInitiatives(sectionText: string): ObjectiveEntry[] {
  const entries: ObjectiveEntry[] = []
  const initiatives = sectionText.split(/\n\*\s+\*\*(?=[A-Z])/).filter(b => b.trim())
  for (const init of initiatives) {
    const titleMatch = init.match(/\*?\*?([^*]+?)(?:\s*\([^)]+\))?\s*:\*\*\s*(.+)/s)
    if (!titleMatch) {
      const altMatch = init.match(/(.+?):\*\*\s*(.+)/s)
      if (!altMatch) continue
      const rawTitle = altMatch[1].replace(/\*+/g, '').trim()
      const body = altMatch[2].replace(/\n/g, ' ').trim()
      const urgency = body.match(/\*\*Buying Urgency:\s*(HIGH|MEDIUM|LOW)\b/i)
      const priority = urgency ? (urgency[1].toUpperCase() === 'MEDIUM' ? 'MED' : urgency[1].toUpperCase() as 'HIGH' | 'LOW') : null
      const cleanBody = cleanMarkdown(body)
      const shortDesc = cleanBody.split(/[.!]/).filter(s => s.trim())[0]?.trim() || ''
      const objective = shortDesc ? truncateAtSentence(`${rawTitle} — ${shortDesc}`, 200) : truncateAtSentence(rawTitle, 200)
      entries.push({
        objective,
        metric: extractMetric(cleanBody),
        priority,
        source: 'Strategic Initiatives',
        confidence: 'HIGH',
      })
      continue
    }
    const rawTitle = titleMatch[1].trim()
    const body = titleMatch[2].replace(/\n/g, ' ').trim()
    const urgency = body.match(/\*\*Buying Urgency:\s*(HIGH|MEDIUM|LOW)\b/i)
    const priority = urgency ? (urgency[1].toUpperCase() === 'MEDIUM' ? 'MED' : urgency[1].toUpperCase() as 'HIGH' | 'LOW') : null
    const cleanBody = cleanMarkdown(body)
    const shortDesc = cleanBody.split(/[.!]/).filter(s => s.trim())[0]?.trim() || ''
    const objective = shortDesc ? truncateAtSentence(`${rawTitle} — ${shortDesc}`, 200) : truncateAtSentence(rawTitle, 200)
    entries.push({
      objective,
      metric: extractMetric(cleanBody),
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

/**
 * Truncate text at the last complete sentence within maxChars.
 * Prevents mid-word truncation (#1147).
 */
function truncateAtSentence(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text

  // Find the last sentence boundary (. ! ?) within the limit
  const upToLimit = text.slice(0, maxChars)
  const boundaries = [
    upToLimit.lastIndexOf('. '),
    upToLimit.lastIndexOf('! '),
    upToLimit.lastIndexOf('? ')
  ]
  const lastBoundary = Math.max(...boundaries)

  if (lastBoundary > 0) {
    // Return text up to and including the punctuation (but not the space after)
    return text.slice(0, lastBoundary + 1)
  }

  // No sentence boundary found - truncate at last word boundary to avoid mid-word cut
  const lastSpace = upToLimit.lastIndexOf(' ')
  if (lastSpace > maxChars * 0.5) {
    // Only use word boundary if we're at least halfway through the limit
    return upToLimit.slice(0, lastSpace) + '…'
  }

  // Last resort: just truncate at limit with ellipsis
  return upToLimit + '…'
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
      objective: truncateAtSentence(factText, 200),
      metric: extractMetric(factText),
      priority: 'MED',
      source,
      confidence,
    })
  }
  return entries
}

function parseProductFit(sections: Record<string, string>): ProductFitEntry[] {
  const fits: ProductFitEntry[] = []
  const fitKeys: Array<[string, string]> = [
    ['RHEL Fit', 'RHEL'],
    ['OpenShift Fit', 'OpenShift'],
    ['Ansible Fit', 'Ansible'],
    ['Red Hat AI Fit', 'Red Hat AI'],
  ]
  for (const [sectionName, product] of fitKeys) {
    const text = sections[sectionName]
    if (!text) continue
    const needMatch = text.match(/\*\*Business Need:\*\*\s*(.+?)(?=\n\s*\*\*|\n*$)/s)
    const fitMatch = text.match(/\*\*Red Hat Fit:\*\*\s*(.+?)(?=\n\s*\*\*|\n*$)/s)
    if (!needMatch && !fitMatch) continue
    const firstSentence = (t: string) => (t.split(/\.\s/)[0]?.trim() || t.trim()).replace(/\n/g, ' ')
    fits.push({
      product,
      businessNeed: needMatch ? firstSentence(needMatch[1]) : '',
      redHatFit: fitMatch ? firstSentence(fitMatch[1]) : '',
    })
  }
  return fits
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

  const productFit = parseProductFit(sections)
  if (productFit.length > 0) {
    profile.productFit = productFit
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
    if (fact) objectives.push(truncateAtSentence(fact[1].trim(), 200))
  }

  const strengthsText = sections['Strengths (Internal, Positive)'] ?? ''
  for (const line of strengthsText.split('\n')) {
    const fact = line.match(/\*\*Specific Fact:\*\*\s*(.+)/i)
    if (fact) initiatives.push(truncateAtSentence(fact[1].trim(), 200))
  }

  const techText = sections['Technological'] ?? ''
  const techStrategy = truncateAtSentence(techText.trim(), 500) || null

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
