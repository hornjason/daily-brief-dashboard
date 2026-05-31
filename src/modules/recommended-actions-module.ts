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
      play: play ? {
        summary: play.summary,
        valueProps: play.valueProps ?? [],
        cloudAmplifiers: play.cloudAmplifiers ?? [],
        relatedPlays: play.relatedPlays ?? [],
        category: play.category,
      } : undefined,
      tdp: tdp ? {
        name: tdp.name,
        cheatsheetUrl: tdp.cheatsheetUrl,
        customerDeckUrl: tdp.customerDeckUrl,
        whatToSay: (tdp.whatToSay ?? []).filter((w: any) => w.name && w.name !== 'arrow down').slice(0, 5),
        whatToShare: (tdp.whatToShare ?? []).filter((w: any) => w.name).slice(0, 5),
        whatToShow: (tdp.whatToShow ?? []).filter((w: any) => w.name).slice(0, 5),
        customerWins: (tdp.customerWins ?? []).filter((w: any) => w.name && !w.name.includes('item(s) selected')).slice(0, 3),
        tactics: (tdp.tactics ?? []).slice(0, 5),
        documentCount: (tdp.documents ?? []).length,
        serviceCount: (tdp.services ?? []).length,
      } : undefined,
    },
  }
}
