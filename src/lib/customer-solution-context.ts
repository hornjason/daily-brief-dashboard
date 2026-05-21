/**
 * Customer Solution Context Utility (ADR-030)
 *
 * Cross-references customer tech-stack detections against the solution-plays.json
 * catalog to produce actionable solution play recommendations.
 *
 * Phase 1: activeSolutionPlays only. Phases 2-3 will add marketplaceOpportunities,
 * versionCorrelations, and crossSellSignals.
 */

import { readFileSync, existsSync } from 'fs'
import { resolve } from 'path'

function getConfigDir(): string {
  return process.env.CONFIG_DIR ?? 'config'
}

function getCacheDir(): string {
  return process.env.CACHE_DIR ?? 'data/cache'
}

// ── Types ────────────────────────────────────────────────────────────────────

export interface CustomerSolutionContext {
  activeSolutionPlays: ActiveSolutionPlay[]
  marketplaceOpportunities: MarketplaceOpportunity[]
  versionCorrelations: VersionCorrelation[]
  crossSellSignals: CrossSellSignal[]
}

export interface ActiveSolutionPlay {
  playId: string
  playName: string
  tdp: string
  matchedTechnologies: string[]
  confidence: 'HIGH' | 'MEDIUM' | 'LOW'
  redHatProducts: string[]
  valueProps: string[]
  cloudAmplifier?: { provider: string; spend: number }
  category: string
}

export interface MarketplaceOpportunity {
  provider: string
  currentSpend: number
  eligiblePrograms: string[]
  privateOfferEligible: boolean
  movableSubscriptions: string[]
}

export interface VersionCorrelation {
  product: string
  subscriptionVersion: string
  activeCases: number
  lifecycleEvent?: string
  amplified: boolean
}

export interface CrossSellSignal {
  pipelineProduct: string
  relatedTech: string
  crossSellProduct: string
  stage: string
}

// ── Solution Play Catalog ──────────────────────────────────────────────────

interface SolutionPlay {
  id: string
  name: string
  tdp: string
  summary: string
  triggerTechnologies: string[]
  redHatProducts: string[]
  valueProps: string[]
  cloudAmplifiers?: string[]
  relatedPlays?: string[]
  category: string
}

interface SolutionPlayCatalog {
  version: number
  plays: SolutionPlay[]
}

let _catalogCache: SolutionPlayCatalog | null = null

function loadSolutionPlayCatalog(): SolutionPlayCatalog {
  if (_catalogCache) return _catalogCache

  const paths = [
    resolve(getConfigDir(), 'solution-plays.json'),
    resolve('config-templates', 'solution-plays.json'),
  ]

  for (const p of paths) {
    try {
      if (existsSync(p)) {
        _catalogCache = JSON.parse(readFileSync(p, 'utf-8'))
        return _catalogCache!
      }
    } catch { /* try next */ }
  }

  return { version: 1, plays: [] }
}

// ── Tech Stack Cache ──────────────────────────────────────────────────────

interface TechEntry {
  name: string
  category: string
  context: string
  confidence: 'HIGH' | 'MEDIUM' | 'LOW'
  redHatProducts: string[]
  infrastructure: string[]
}

interface TechStackCache {
  technologies: TechEntry[]
}

function readTechStackCache(customerSlug: string): TechEntry[] {
  try {
    const p = resolve(getCacheDir(), 'tech-stack', `${customerSlug}.json`)
    if (!existsSync(p)) return []
    const data: TechStackCache = JSON.parse(readFileSync(p, 'utf-8'))
    return data.technologies ?? []
  } catch {
    return []
  }
}

// ── Result Cache (per-customer, TTL-based) ─────────────────────────────

const _resultCache = new Map<string, { result: CustomerSolutionContext; cachedAt: number }>()
const RESULT_CACHE_TTL_MS = 5 * 60 * 1000 // 5 minutes

// ── Cross-Reference Engine ──────────────────────────────────────────────

function matchTechnologies(
  detectedTechs: TechEntry[],
  triggerTechnologies: string[]
): { matched: string[]; bestConfidence: 'HIGH' | 'MEDIUM' | 'LOW' } {
  const matched: string[] = []
  let bestConfidence: 'HIGH' | 'MEDIUM' | 'LOW' = 'LOW'
  const confidenceOrder = { HIGH: 3, MEDIUM: 2, LOW: 1 }

  const triggerSet = new Set(triggerTechnologies.map(t => t.toLowerCase()))

  for (const tech of detectedTechs) {
    const techNameLower = tech.name.toLowerCase()
    if (triggerSet.has(techNameLower)) {
      matched.push(tech.name)
      if (confidenceOrder[tech.confidence] > confidenceOrder[bestConfidence]) {
        bestConfidence = tech.confidence
      }
    }
    // Also check infrastructure array for matches
    for (const infra of tech.infrastructure ?? []) {
      if (triggerSet.has(infra.toLowerCase()) && !matched.includes(infra)) {
        matched.push(infra)
      }
    }
  }

  return { matched, bestConfidence }
}

// ── Main Function ────────────────────────────────────────────────────────

export function getCustomerSolutionContext(customerSlug: string): CustomerSolutionContext {
  const cached = _resultCache.get(customerSlug)
  if (cached && Date.now() - cached.cachedAt < RESULT_CACHE_TTL_MS) {
    return cached.result
  }

  const catalog = loadSolutionPlayCatalog()
  const detectedTechs = readTechStackCache(customerSlug)

  const activeSolutionPlays: ActiveSolutionPlay[] = []

  if (detectedTechs.length > 0 && catalog.plays.length > 0) {
    for (const play of catalog.plays) {
      const { matched, bestConfidence } = matchTechnologies(detectedTechs, play.triggerTechnologies)

      if (matched.length > 0) {
        activeSolutionPlays.push({
          playId: play.id,
          playName: play.name,
          tdp: play.tdp,
          matchedTechnologies: matched,
          confidence: bestConfidence,
          redHatProducts: play.redHatProducts,
          valueProps: play.valueProps,
          category: play.category,
        })
      }
    }

    // Sort by confidence (HIGH first) then by number of matched technologies
    const confidenceOrder = { HIGH: 3, MEDIUM: 2, LOW: 1 }
    activeSolutionPlays.sort((a, b) => {
      const confDiff = confidenceOrder[b.confidence] - confidenceOrder[a.confidence]
      if (confDiff !== 0) return confDiff
      return b.matchedTechnologies.length - a.matchedTechnologies.length
    })
  }

  const result: CustomerSolutionContext = {
    activeSolutionPlays,
    marketplaceOpportunities: [],
    versionCorrelations: [],
    crossSellSignals: [],
  }

  _resultCache.set(customerSlug, { result, cachedAt: Date.now() })
  return result
}

/** Reset the catalog cache (for testing) */
export function resetCatalogCache(): void {
  _catalogCache = null
  _resultCache.clear()
}
