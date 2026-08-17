// src/lib/signal-loader.ts
// GitHub Issue #171 — Universal signal loading for content generation
// Combines registry signal collection + legacy cache fallback
// GitHub Issue #328 — Universal pre-flight signal refresh

import { FeatureModuleRegistry, scoreSignal, applyTimeDecay, type Signal } from '../feature-module-registry.ts'

// ── Signal Tiers (GitHub Issue #1118) ───────────────────────────────────────

export const SIGNAL_TIERS = {
  CRITICAL: ['intelligence', 'subscriptions'] as const,
  CONTEXT: ['cases', 'emails', 'meeting-context', 'account-plan'] as const,
  ENRICHMENT: ['product-intel', 'competitive-intel', 'news-radar', 'rh-events', 'customer-docs', 'customer-product-intel', 'ecosystem-catalog', 'cloud-marketplace', 'ccsp', 'mergers-acquisitions', 'partner-catalog', 'partner-detected', 'pipeline', 'playbook', 'product-lifecycle', 'recommended-actions', 'rh-rss', 'saleshub-plays', 'saleshub-products', 'saleshub-tactics', 'solution-intelligence', 'tech-stack', 'value-maps'] as const,
} as const

export type SignalTier = 'CRITICAL' | 'CONTEXT' | 'ENRICHMENT'

export function getSignalTier(source: string): SignalTier {
  if ((SIGNAL_TIERS.CRITICAL as readonly string[]).includes(source)) return 'CRITICAL'
  if ((SIGNAL_TIERS.CONTEXT as readonly string[]).includes(source)) return 'CONTEXT'
  return 'ENRICHMENT'
}

// ── Types ────────────────────────────────────────────────────────────────────

/**
 * Legacy signal structure (backward compatibility with campaigns-routes.ts)
 * New feature modules contribute via FeatureModuleRegistry.collectAllSignals(),
 * but existing consumers still expect this shape.
 */
export interface CustomerSignals {
  productIntel?: any
  intelligence?: any
  customerDocs?: any
  accountPlan?: string
  dailyBrief?: any
  subscriptions?: any
  emails?: any
  cases?: any
}

export interface SignalLoadResult {
  signals: CustomerSignals
  registrySignals: Signal[]  // Flat array from collectAllSignals()
  loaded: string[]
  missing: string[]
  refreshResult?: { refreshed: string[]; skipped: string[]; failed: string[] }
}

// ── Pre-flight signal refresh ────────────────────────────────────────────────

/**
 * Ensure all signal sources are current before content generation.
 * Calls ensureFresh() on all registered modules that implement it.
 * Runs all refreshes in parallel with a 30-second timeout.
 * Fail-open: errors are logged but don't block.
 * GitHub Issue #328
 */
export async function ensureSignalsCurrent(
  customerSlug: string,
  customerName?: string
): Promise<{ refreshed: string[]; skipped: string[]; failed: string[] }> {
  const MAX_WAIT_CRITICAL_MS = 90_000
  const MAX_WAIT_MS = 30_000
  const refreshed: string[] = []
  const skipped: string[] = []
  const failed: string[] = []

  const modules = FeatureModuleRegistry.getRegisteredModules()
  const criticalPromises: Promise<void>[] = []
  const otherPromises: Promise<void>[] = []

  for (const module of modules) {
    if (!module.ensureFresh) {
      skipped.push(module.name)
      continue
    }

    const promise = module.ensureFresh(customerSlug)
      .then(() => {
        refreshed.push(module.name)
        console.log(`[signal-preflight] ${module.name} refreshed for ${customerSlug}`)
      })
      .catch((e: any) => {
        console.warn(`[signal-preflight] ${module.name} failed for ${customerSlug}:`, e?.message ?? e)
        failed.push(module.name)
      })

    const tier = getSignalTier(module.name)
    if (tier === 'CRITICAL') {
      criticalPromises.push(promise)
    } else {
      otherPromises.push(promise)
    }
  }

  const startTime = performance.now()

  if (criticalPromises.length > 0) {
    await Promise.race([
      Promise.allSettled(criticalPromises),
      new Promise(r => setTimeout(r, MAX_WAIT_CRITICAL_MS)),
    ])
  }

  if (otherPromises.length > 0) {
    await Promise.race([
      Promise.allSettled(otherPromises),
      new Promise(r => setTimeout(r, MAX_WAIT_MS)),
    ])
  }

  if (criticalPromises.length > 0 || otherPromises.length > 0) {
    const elapsed = performance.now() - startTime
    console.log(
      `[signal-preflight] ensureSignalsCurrent for ${customerSlug}: ${refreshed.length} refreshed, ${skipped.length} skipped, ${failed.length} failed (${elapsed.toFixed(0)}ms)`
    )
  }

  return { refreshed, skipped, failed }
}

// ── Unbounded signal collection (ADR-032 §3) ────────────────────────────────

/**
 * Collect ALL signals from all registered modules WITHOUT budget caps.
 * Used exclusively by cross-referencing modules (recommended-actions) that need
 * the full signal set for comprehensive cross-referencing.
 *
 * Same as collectAllSignals() but skips the per-source budget cap step.
 * Signals are still scored and time-decayed — just not capped.
 *
 * GitHub Issue #482, ADR-032 §3
 */
export async function collectAllSignalsUnbudgeted(
  customerSlug: string,
): Promise<Signal[]> {
  const allSignals: Signal[] = []
  const modules = FeatureModuleRegistry.getRegisteredModules()

  for (const module of modules) {
    if (!module.signals) continue
    // Skip the recommended-actions module to avoid circular dependency
    if (module.name === 'recommended-actions') continue

    try {
      const rawSignals = await module.signals(customerSlug)
      // ADR-032a: Stamp signals with module's declared role/audience if not already set
      const moduleRole = module.signalRole
      const moduleAudience = module.signalAudience
      const stampedSignals = rawSignals.map(s => ({
        ...s,
        role: s.role ?? moduleRole,
        audience: s.audience ?? moduleAudience,
      }))
      allSignals.push(...stampedSignals)
    } catch (e: any) {
      console.warn(
        `[signal-loader] collectAllSignalsUnbudgeted: ${module.name} failed for ${customerSlug}:`,
        e?.message ?? e,
      )
    }
  }

  // Score and apply time decay (same as collectAllSignals) but NO budget cap
  return allSignals.map(scoreSignal).map(applyTimeDecay)
}

// ── Signal loading ───────────────────────────────────────────────────────────

/**
 * Load all customer signal sources from feature modules via registry.
 *
 * GitHub Issue #274 migrated all 8 legacy sources (intelligence, customerDocs, dailyBrief,
 * subscriptions, emails, cases, productIntel, accountPlan) to registry modules.
 * This function now uses the registry as the single source of truth.
 *
 * Returns signals in the registry format plus empty legacy signals object for backward compatibility.
 * Missing sources are logged but don't block generation.
 *
 * GitHub Issue #328: When options.ensureFresh is true, calls ensureSignalsCurrent() before
 * collecting signals to ensure all sources are current.
 */
export async function loadCustomerSignals(
  customerSlug: string,
  customerName?: string,
  options?: { ensureFresh?: boolean }
): Promise<SignalLoadResult> {
  const signals: CustomerSignals = {}  // Empty — deprecated, consumers should use registrySignals
  const loaded: string[] = []
  const missing: string[] = []
  let registrySignals: Signal[] = []
  let refreshResult: { refreshed: string[]; skipped: string[]; failed: string[] } | undefined

  // Pre-flight refresh if requested
  if (options?.ensureFresh) {
    try {
      refreshResult = await ensureSignalsCurrent(customerSlug, customerName)
    } catch (e: any) {
      console.warn(`[signal-loader] Pre-flight refresh failed for ${customerSlug}:`, e.message)
      // Continue to signal collection even if refresh failed (fail-open)
    }
  }

  // Collect signals from all registered modules (single path)
  try {
    registrySignals = await FeatureModuleRegistry.collectAllSignals(customerSlug)
  } catch (e: any) {
    console.warn(`[signal-loader] Registry collection failed for ${customerSlug}:`, e.message)
    // Return empty result on registry failure — don't block generation
    return { signals, registrySignals: [], loaded, missing, refreshResult }
  }

  // Build loaded/missing lists from registry signals
  // Group signals by source module to identify which modules contributed
  const sourceModules = new Set<string>()
  for (const signal of registrySignals) {
    if (signal.source) {
      sourceModules.add(signal.source)
    }
  }

  // Modules that returned signals go into loaded
  loaded.push(...sourceModules)

  const modules = FeatureModuleRegistry.getRegisteredModules()
  for (const module of modules) {
    if (module.signals && !sourceModules.has(module.name)) {
      missing.push(module.name)
    }
  }

  console.log(`[signal-loader] Signal stack for ${customerSlug}: loaded=[${loaded.join(',')}] missing=[${missing.join(',')}] registry=${registrySignals.length}`)
  return { signals, registrySignals, loaded, missing, refreshResult }
}
