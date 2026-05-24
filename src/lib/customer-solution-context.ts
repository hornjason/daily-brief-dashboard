/**
 * Customer Solution Context Utility (ADR-030)
 *
 * Cross-references customer data across multiple caches to produce:
 * - Solution play recommendations (tech-stack × solution-plays catalog)
 * - Marketplace opportunities (CCSP spend × cloud-marketplace programs)
 * - Version correlations (subscriptions × cases × lifecycle)
 * - Cross-sell signals (pipeline × tech-stack)
 */

import { readFileSync, existsSync } from 'fs'
import { resolve } from 'path'
import { toSlug } from '../cache-layer.ts'
import { getTacticsByTdp, getAssetsByPlay } from './saleshub-knowledge-loader.ts'
import { isValidCustomerWin, isValidAsset } from './saleshub-filters.ts'

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
  talkTrack?: string
  customerWins?: string[]
  linkedAssets?: Array<{ name: string; url: string; type: string }>
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

// ── CCSP / Cloud Marketplace Cache (Phase 2) ───────────────────────────

interface CCSPRecord {
  accountName: string
  cloudPartner: string
  acvPlus: number
  productOfferingGroup?: string
}

interface CloudMarketplaceCache {
  clouds: Array<{
    provider: string
    programs: Array<{ name: string; description: string; eligibility?: string }>
  }>
  cachedAt: string
}

function readCCSPRecords(customerSlug: string): CCSPRecord[] {
  try {
    const p = resolve(getCacheDir(), 'ccsp.json')
    if (!existsSync(p)) return []
    const data = JSON.parse(readFileSync(p, 'utf-8'))
    return (data.records ?? []).filter((r: any) =>
      toSlug(r.accountName ?? '') === customerSlug
    )
  } catch { return [] }
}

function readCloudMarketplaceCache(): CloudMarketplaceCache | null {
  try {
    const p = resolve(getCacheDir(), 'cloud-marketplace', 'latest.json')
    if (!existsSync(p)) return null
    return JSON.parse(readFileSync(p, 'utf-8'))
  } catch { return null }
}

function readSubscriptionProducts(customerSlug: string): string[] {
  try {
    const p = resolve(getCacheDir(), `${customerSlug}-sheets.json`)
    if (!existsSync(p)) return []
    const data = JSON.parse(readFileSync(p, 'utf-8'))
    const rows = data.rows ?? data.subscriptions ?? (Array.isArray(data) ? data : [])
    const products = new Set<string>()
    for (const row of rows) {
      const desc = String(row.productDescription ?? row.product ?? '').toLowerCase()
      if (desc.includes('openshift')) products.add('OpenShift')
      if (desc.includes('enterprise linux') || desc.includes('rhel')) products.add('RHEL')
      if (desc.includes('ansible')) products.add('Ansible')
      if (desc.includes('satellite')) products.add('Satellite')
      if (desc.includes('quay')) products.add('Quay')
    }
    return Array.from(products)
  } catch { return [] }
}

// ── Cases / Lifecycle Cache (Phase 3) ──────────────────────────────────

interface CaseEntry {
  caseNumber: string
  severity: string
  product?: string
  version?: string
  status: string
}

interface LifecycleEvent {
  product: string
  version: string
  phase: string
  date: string
}

function readCustomerCases(customerSlug: string): CaseEntry[] {
  try {
    const p = resolve(getCacheDir(), 'rh-cases', `${customerSlug}.json`)
    if (!existsSync(p)) return []
    const data = JSON.parse(readFileSync(p, 'utf-8'))
    return (data.cases ?? data ?? []).filter((c: any) => c.status !== 'Closed')
  } catch { return [] }
}

function readLifecycleCache(): LifecycleEvent[] {
  try {
    const p = resolve(getCacheDir(), 'product-lifecycle.json')
    if (!existsSync(p)) return []
    const data = JSON.parse(readFileSync(p, 'utf-8'))
    return data.events ?? data ?? []
  } catch { return [] }
}

// ── Pipeline Cache (Phase 3) ───────────────────────────────────────────

interface PipelineDeal {
  oppName: string
  acv: number
  forecastCategory: string
  products: string[]
}

function readPipelineDeals(customerSlug: string): PipelineDeal[] {
  try {
    const p = resolve(getCacheDir(), 'pipeline.json')
    if (!existsSync(p)) return []
    const data = JSON.parse(readFileSync(p, 'utf-8'))
    return (data.records ?? []).filter((r: any) =>
      toSlug(r.accountName ?? '') === customerSlug
    )
  } catch { return [] }
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
    // Also check infrastructure array for matches — use parent tech's confidence
    for (const infra of tech.infrastructure ?? []) {
      if (triggerSet.has(infra.toLowerCase()) && !matched.includes(infra)) {
        matched.push(infra)
        if (confidenceOrder[tech.confidence] > confidenceOrder[bestConfidence]) {
          bestConfidence = tech.confidence
        }
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

    // Enrich with SalesHub knowledge base (talk tracks, customer wins, linked assets)
    for (const play of activeSolutionPlays) {
      const tactics = getTacticsByTdp(play.tdp)
      if (tactics.length > 0) {
        const bestTactic = tactics[0]
        if (bestTactic.talkTrack) play.talkTrack = bestTactic.talkTrack
        const allWins = tactics.flatMap(t => t.customerWins).filter(w => w.length > 0).filter(isValidCustomerWin)
        if (allWins.length > 0) play.customerWins = allWins
      }
      const assets = getAssetsByPlay(play.playId, play.tdp).filter(isValidAsset).slice(0, 10)
      if (assets.length > 0) play.linkedAssets = assets
    }

    // Sort by confidence (HIGH first) then by number of matched technologies
    const confidenceOrder = { HIGH: 3, MEDIUM: 2, LOW: 1 }
    activeSolutionPlays.sort((a, b) => {
      const confDiff = confidenceOrder[b.confidence] - confidenceOrder[a.confidence]
      if (confDiff !== 0) return confDiff
      return b.matchedTechnologies.length - a.matchedTechnologies.length
    })
  }

  // Phase 2: Marketplace opportunities (CCSP × cloud-marketplace × subscriptions)
  const marketplaceOpportunities = computeMarketplaceOpportunities(customerSlug)

  // Phase 3: Version correlations (subscriptions × cases × lifecycle)
  const versionCorrelations = computeVersionCorrelations(customerSlug)

  // Phase 3: Cross-sell signals (pipeline × tech-stack)
  const crossSellSignals = computeCrossSellSignals(customerSlug, detectedTechs, catalog)

  const result: CustomerSolutionContext = {
    activeSolutionPlays,
    marketplaceOpportunities,
    versionCorrelations,
    crossSellSignals,
  }

  _resultCache.set(customerSlug, { result, cachedAt: Date.now() })
  return result
}

// ── Phase 2: Marketplace Opportunities ──────────────────────────────────

function computeMarketplaceOpportunities(customerSlug: string): MarketplaceOpportunity[] {
  const ccspRecords = readCCSPRecords(customerSlug)
  if (ccspRecords.length === 0) return []

  const marketplaceCache = readCloudMarketplaceCache()
  const subscriptionProducts = readSubscriptionProducts(customerSlug)

  // Aggregate spend by cloud provider
  const spendByProvider = new Map<string, number>()
  for (const r of ccspRecords) {
    const current = spendByProvider.get(r.cloudPartner) ?? 0
    spendByProvider.set(r.cloudPartner, current + (r.acvPlus || 0))
  }

  const opportunities: MarketplaceOpportunity[] = []

  for (const [provider, spend] of spendByProvider) {
    if (spend <= 0) continue

    // Find eligible programs from marketplace cache
    const eligiblePrograms: string[] = []
    if (marketplaceCache) {
      const providerMap: Record<string, string> = { AWS: 'AWS', Google: 'Google', Microsoft: 'Microsoft' }
      const cloudSection = marketplaceCache.clouds.find(c =>
        providerMap[c.provider] === provider
      )
      if (cloudSection) {
        eligiblePrograms.push(...cloudSection.programs.map(p => p.name))
      }
    }

    // Private offer eligibility: spend > $100K threshold
    const privateOfferEligible = spend >= 100_000

    opportunities.push({
      provider,
      currentSpend: spend,
      eligiblePrograms,
      privateOfferEligible,
      movableSubscriptions: subscriptionProducts,
    })
  }

  return opportunities.sort((a, b) => b.currentSpend - a.currentSpend)
}

// ── Phase 3: Version Correlations ──────────────────────────────────────

function computeVersionCorrelations(customerSlug: string): VersionCorrelation[] {
  const cases = readCustomerCases(customerSlug)
  if (cases.length === 0) return []

  const lifecycle = readLifecycleCache()

  // Group cases by product
  const casesByProduct = new Map<string, CaseEntry[]>()
  for (const c of cases) {
    const product = c.product ?? 'Unknown'
    const existing = casesByProduct.get(product) ?? []
    existing.push(c)
    casesByProduct.set(product, existing)
  }

  const correlations: VersionCorrelation[] = []

  for (const [product, productCases] of casesByProduct) {
    // Find version from cases
    const versions = productCases.map(c => c.version).filter(Boolean)
    const primaryVersion = versions[0] ?? ''

    // Look for lifecycle event matching this product
    const lifecycleEvent = lifecycle.find(e =>
      product.toLowerCase().includes(e.product.toLowerCase()) ||
      e.product.toLowerCase().includes(product.toLowerCase())
    )

    const hasLifecycleEvent = !!lifecycleEvent
    const amplified = productCases.length >= 2 && hasLifecycleEvent

    if (productCases.length >= 2 || hasLifecycleEvent) {
      correlations.push({
        product,
        subscriptionVersion: primaryVersion,
        activeCases: productCases.length,
        lifecycleEvent: lifecycleEvent ? `${lifecycleEvent.phase} ${lifecycleEvent.date}` : undefined,
        amplified,
      })
    }
  }

  return correlations.sort((a, b) => b.activeCases - a.activeCases)
}

// ── Phase 3: Cross-Sell Signals ────────────────────────────────────────

function computeCrossSellSignals(
  customerSlug: string,
  detectedTechs: TechEntry[],
  catalog: SolutionPlayCatalog,
): CrossSellSignal[] {
  const deals = readPipelineDeals(customerSlug)
  if (deals.length === 0 || detectedTechs.length === 0) return []

  const signals: CrossSellSignal[] = []

  for (const deal of deals) {
    for (const dealProduct of deal.products) {
      // Find solution plays that involve this deal's product
      const relatedPlays = catalog.plays.filter(p =>
        p.redHatProducts.some(rp =>
          dealProduct.toLowerCase().includes(rp) || rp.includes(dealProduct.toLowerCase())
        )
      )

      for (const play of relatedPlays) {
        // Check if any trigger technology is detected
        const { matched } = matchTechnologies(detectedTechs, play.triggerTechnologies)
        if (matched.length > 0) {
          // Find cross-sell products from the play that aren't in the deal
          const crossSellProducts = play.redHatProducts.filter(p =>
            !deal.products.some(dp => dp.toLowerCase().includes(p))
          )

          for (const crossSellProduct of crossSellProducts) {
            signals.push({
              pipelineProduct: dealProduct,
              relatedTech: matched[0],
              crossSellProduct,
              stage: deal.forecastCategory,
            })
          }
        }
      }
    }
  }

  // Dedupe by crossSellProduct
  const seen = new Set<string>()
  return signals.filter(s => {
    const key = `${s.pipelineProduct}:${s.crossSellProduct}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/** Reset the catalog cache (for testing) */
export function resetCatalogCache(): void {
  _catalogCache = null
  _resultCache.clear()
}
