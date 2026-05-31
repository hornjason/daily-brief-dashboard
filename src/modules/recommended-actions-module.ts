/**
 * src/modules/recommended-actions-module.ts — ADR-032 §2
 *
 * Registered feature module that produces composite recommended actions
 * by cross-referencing ALL customer signals against the solution portfolio.
 *
 * Uses collectAllSignalsUnbudgeted() to get the full signal set (ADR-032 §3).
 * The module's own output is budget-capped by the registry (5 per customer).
 *
 * Pure computation — no cache of its own, no refresh interval.
 * Depends on upstream modules for fresh data.
 */

import { FeatureModuleRegistry, type Signal } from '../feature-module-registry.ts'
import { collectAllSignalsUnbudgeted } from '../lib/signal-loader.ts'
import { getRecommendations, type RecommendedAction } from '../lib/signal-query.ts'
import { loadAllEcosystemPartners } from '../lib/ecosystem-catalog.ts'
import { readFileSync, existsSync } from 'fs'
import { resolve } from 'path'

// ── Data loaders ──────────────────────────────────────────────────────────────

function getConfigDir(): string {
  return process.env.CONFIG_DIR ?? 'config'
}

function getCacheDir(): string {
  return process.env.CACHE_DIR ?? 'data/cache'
}

function loadSolutionPlays(): any[] {
  const paths = [
    resolve(getConfigDir(), 'solution-plays.json'),
    resolve('config-templates', 'solution-plays.json'),
  ]
  for (const p of paths) {
    try {
      if (existsSync(p)) {
        const data = JSON.parse(readFileSync(p, 'utf-8'))
        return data.plays ?? []
      }
    } catch { /* try next */ }
  }
  return []
}

function loadCloudMarketplace(): any {
  try {
    const p = resolve(getCacheDir(), 'cloud-marketplace', 'latest.json')
    if (!existsSync(p)) return null
    return JSON.parse(readFileSync(p, 'utf-8'))
  } catch { return null }
}

function loadSaleshubKnowledge(): any {
  const paths = [
    resolve(getConfigDir(), 'saleshub-knowledge.json'),
    resolve('config-templates', 'saleshub-knowledge.json'),
  ]
  for (const p of paths) {
    try {
      if (existsSync(p)) return JSON.parse(readFileSync(p, 'utf-8'))
    } catch { /* try next */ }
  }
  return null
}

// ── Result cache (5-min in-memory, per-customer) ──────────────────────────────

const _resultCache = new Map<string, { actions: RecommendedAction[]; cachedAt: number }>()
const RESULT_CACHE_TTL_MS = 5 * 60 * 1000

// ── Helper to extract Red Hat products from a recommendation ──────────────────

function extractProducts(ra: RecommendedAction): string[] {
  // Check trigger signals for redHatProducts metadata
  const products = new Set<string>()
  for (const signal of ra.triggerSignals) {
    const m = signal.metadata ?? {}
    if (Array.isArray(m.redHatProducts)) {
      for (const p of m.redHatProducts) products.add(String(p))
    }
  }
  return [...products]
}

// ── Module registration ───────────────────────────────────────────────────────

FeatureModuleRegistry.register({
  name: 'recommended-actions',
  displayName: 'Recommended Actions',
  refreshEndpoint: '/api/customer/_global/modules/recommended-actions/sync',
  scope: 'customer',
  signalRole: 'trigger',
  signalAudience: 'customer-specific',
  cacheTtlMs: undefined, // no TTL — pure computation, no cache of its own

  async ensureFresh(_customerSlug: string): Promise<void> {
    // No-op — read-only computation from other module caches
  },

  cachePaths: () => [],

  async signals(customerSlug: string): Promise<Signal[]> {
    // Check result cache
    const cached = _resultCache.get(customerSlug)
    if (cached && Date.now() - cached.cachedAt < RESULT_CACHE_TTL_MS) {
      return cached.actions.map(ra => toSignal(ra, customerSlug))
    }

    // Get ALL signals (no budget caps) — ADR-032 §3
    const allSignals = await collectAllSignalsUnbudgeted(customerSlug)

    // Load solution portfolio
    const solutionPlays = loadSolutionPlays()
    const ecosystemPartners = loadAllEcosystemPartners()
    const cloudMarketplace = loadCloudMarketplace()
    const saleshubKnowledge = loadSaleshubKnowledge()

    // Cross-reference
    const actions = getRecommendations(
      allSignals,
      solutionPlays,
      ecosystemPartners,
      cloudMarketplace,
      saleshubKnowledge,
    )

    // Cache result
    _resultCache.set(customerSlug, { actions, cachedAt: Date.now() })

    return actions.map(ra => toSignal(ra, customerSlug))
  },

  async fetch() {},
  async cleanup() { _resultCache.clear() },
  async syncNow() { _resultCache.clear() },
})

// ── TDP data cleanup helpers (#498) ──────────────────────────────────────────

const SCRAPER_ARTIFACTS = ['arrow up', 'arrow down', 'arrow left', 'arrow right', 'displaying slide', 'item(s) selected', 'select case studies from', 'real customer stories and proven outcomes']

function isScraperArtifact(name: string): boolean {
  const lower = name.toLowerCase().trim()
  if (lower.length < 3) return true
  return SCRAPER_ARTIFACTS.some(a => lower.includes(a))
}

function resolveSaleshubUrl(url: string | undefined): string | undefined {
  if (!url) return undefined
  if (url.startsWith('https://') || url.startsWith('http://')) return url
  if (url.startsWith('/apps/')) return `https://saleshub.redhat.com${url}`
  return url
}

function cleanTdpItems(items: any[]): Array<{ name: string; url?: string }> {
  return (items ?? [])
    .filter((w: any) => w.name && !isScraperArtifact(w.name))
    .map((w: any) => ({ name: w.name, url: resolveSaleshubUrl(w.url) || undefined }))
}

// ── Play→TDP content join (#498) ─────────────────────────────────────────────

function findPlayData(solutionName: string): { play: any; tdp: any } | null {
  const plays = loadSolutionPlays()
  const play = plays.find(p => p.name === solutionName)
  if (!play?.tdp) return play ? { play, tdp: null } : null

  const knowledge = loadSaleshubKnowledge()
  const tdps = knowledge?.tdps ?? []
  const tdp = tdps.find((t: any) => t.name.toLowerCase() === play.tdp.toLowerCase())
  return { play, tdp: tdp ?? null }
}

// ── Signal conversion ─────────────────────────────────────────────────────────

function buildTriggerSummary(triggerSignals: Signal[]): Array<{ source: string; headline: string }> {
  const seen = new Set<string>()
  const result: Array<{ source: string; headline: string }> = []
  for (const s of triggerSignals) {
    const key = `${s.source}:${s.headline.slice(0, 40)}`
    if (seen.has(key)) continue
    seen.add(key)
    result.push({ source: s.source, headline: s.headline.slice(0, 80) })
  }
  return result.slice(0, 8)
}

function toSignal(ra: RecommendedAction, customerSlug: string): Signal {
  const playData = ra.solution.type === 'play' ? findPlayData(ra.solution.name) : null
  const play = playData?.play
  const tdp = playData?.tdp

  return {
    source: 'recommended-actions',
    type: 'recommendation',
    headline: ra.action,
    detail: ra.narrative ?? play?.summary ?? ra.solution.name,
    rawRelevance: ra.confidence === 'high' ? 0.95
               : ra.confidence === 'medium' ? 0.75
               : 0.55,
    timestamp: new Date().toISOString(),
    url: tdp?.cheatsheetUrl ?? ra.solution.url,
    metadata: {
      customerSlug,
      solutionType: ra.solution.type,
      solutionName: ra.solution.name,
      triggerSignalCount: ra.triggerSignals.length,
      confidence: ra.confidence.toUpperCase(),
      redHatProducts: play?.redHatProducts ?? extractProducts(ra),
      actions: ra.actions,
      assets: ra.solution.assets,
      triggerSignals: buildTriggerSummary(ra.triggerSignals),
      play: play ? {
        summary: play.summary,
        valueProps: play.valueProps ?? [],
        cloudAmplifiers: play.cloudAmplifiers ?? [],
        relatedPlays: play.relatedPlays ?? [],
        category: play.category,
      } : undefined,
      tdp: tdp ? {
        name: tdp.name,
        cheatsheetUrl: resolveSaleshubUrl(tdp.cheatsheetUrl),
        customerDeckUrl: resolveSaleshubUrl(tdp.customerDeckUrl),
        whatToSay: cleanTdpItems(tdp.whatToSay).slice(0, 5),
        whatToShare: cleanTdpItems(tdp.whatToShare).slice(0, 5),
        whatToShow: cleanTdpItems(tdp.whatToShow).slice(0, 5),
        customerWins: cleanTdpItems(tdp.customerWins).slice(0, 3),
        tactics: (tdp.tactics ?? []).filter((t: string) => typeof t === 'string' && !isScraperArtifact(t)).slice(0, 5),
        documentCount: (tdp.documents ?? []).length,
        serviceCount: (tdp.services ?? []).length,
      } : undefined,
    },
  }
}
