// src/lib/signal-loader.ts
// GitHub Issue #171 — Universal signal loading for content generation
// Combines registry signal collection + legacy cache fallback

import { FeatureModuleRegistry, type Signal } from '../feature-module-registry.ts'

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
 */
export async function loadCustomerSignals(customerSlug: string, customerName?: string): Promise<SignalLoadResult> {
  const signals: CustomerSignals = {}  // Empty — deprecated, consumers should use registrySignals
  const loaded: string[] = []
  const missing: string[] = []
  let registrySignals: Signal[] = []

  // Collect signals from all registered modules (single path)
  try {
    registrySignals = await FeatureModuleRegistry.collectAllSignals(customerSlug)
  } catch (e: any) {
    console.warn(`[signal-loader] Registry collection failed for ${customerSlug}:`, e.message)
    // Return empty result on registry failure — don't block generation
    return { signals, registrySignals: [], loaded, missing }
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

  // TODO: Track registered modules that returned zero signals for missing array
  // This requires the registry to expose a list of all registered module names
  // For now, missing will be empty unless we add that capability to the registry

  console.log(`[signal-loader] Signal stack for ${customerSlug}: loaded=[${loaded.join(',')}] missing=[${missing.join(',')}] registry=${registrySignals.length}`)
  return { signals, registrySignals, loaded, missing }
}
