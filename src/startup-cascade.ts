// src/startup-cascade.ts
// GitHub Issue #310 — Post-bootstrap refresh cascade
// After bootstrap completes (or on fresh startup with no manifest timestamps),
// refresh data sources in dependency order with rate limiting to avoid spikes.

import { FeatureModuleRegistry } from './feature-module-registry.ts'
import { refreshSubscriptions, refreshCCSP, refreshPipeline } from './refresh-engine.ts'

// ── Dependency tiers (from GitHub Issue #310 design section) ────────────────

const TIER_0_MODULES = ['subscriptions', 'partners']  // bootstrap already writes these
const TIER_1_MODULES = ['pipeline', 'ccsp', 'rh-cases']  // needs customers + subscriptions
const TIER_2_MODULES = ['product-lifecycle', 'product-intel', 'value-maps', 'rh-rss']  // needs Tier 1
const TIER_3_MODULES = ['intelligence', 'news-radar', 'customer-product-intel']  // needs everything above

// ── Concurrency semaphore ───────────────────────────────────────────────────

class Semaphore {
  private permits: number
  private waiting: Array<() => void> = []

  constructor(permits: number) {
    this.permits = permits
  }

  async acquire(): Promise<void> {
    if (this.permits > 0) {
      this.permits--
      return
    }
    return new Promise(resolve => {
      this.waiting.push(resolve)
    })
  }

  release(): void {
    if (this.waiting.length > 0) {
      const resolve = this.waiting.shift()
      resolve?.()
    } else {
      this.permits++
    }
  }
}

// ── Refresh runner per module ───────────────────────────────────────────────

async function refreshModule(moduleName: string, sem: Semaphore): Promise<{ success: boolean; error?: string }> {
  await sem.acquire()
  try {
    console.log(`[startup-cascade] Starting ${moduleName}`)

    // Special-case handling for refresh-engine modules (not in FeatureModuleRegistry)
    if (moduleName === 'subscriptions') {
      await refreshSubscriptions(true)
      return { success: true }
    }
    if (moduleName === 'ccsp') {
      await refreshCCSP(true)
      return { success: true }
    }
    if (moduleName === 'pipeline') {
      await refreshPipeline(true)
      return { success: true }
    }

    // Handle modules in FeatureModuleRegistry
    const module = FeatureModuleRegistry.get(moduleName)
    if (!module) {
      console.warn(`[startup-cascade] Module ${moduleName} not registered — skipping`)
      return { success: false, error: 'Module not registered' }
    }

    // Call module's fetch method with empty string (portfolio-level)
    await module.fetch('')

    // Record success in registry
    FeatureModuleRegistry.recordOutcome(moduleName, { success: true })

    console.log(`[startup-cascade] Completed ${moduleName}`)
    return { success: true }
  } catch (e: any) {
    const errorMsg = e?.message ?? String(e)
    console.warn(`[startup-cascade] ${moduleName} failed: ${errorMsg}`)
    FeatureModuleRegistry.recordOutcome(moduleName, { success: false, error: errorMsg })
    return { success: false, error: errorMsg }
  } finally {
    sem.release()
  }
}

// ── Main cascade runner ─────────────────────────────────────────────────────

export async function runStartupCascade(): Promise<{
  completed: string[]
  skipped: string[]
  failed: string[]
}> {
  console.log('[startup-cascade] Starting post-bootstrap refresh cascade')

  const completed: string[] = []
  const skipped: string[] = []
  const failed: string[] = []

  // Check which sources have NO manifest timestamp (never been run)
  const allModuleStatus = FeatureModuleRegistry.getAllStatus()
  const registeredModules = new Set(FeatureModuleRegistry.list().map(m => m.name))
  const freshModules = new Set<string>()

  for (const moduleName of [...TIER_0_MODULES, ...TIER_1_MODULES, ...TIER_2_MODULES, ...TIER_3_MODULES]) {
    // Only consider modules that are actually registered (or are refresh-engine modules)
    const isRefreshEngineModule = ['subscriptions', 'ccsp', 'pipeline'].includes(moduleName)
    if (!isRefreshEngineModule && !registeredModules.has(moduleName)) {
      continue
    }

    const status = allModuleStatus[moduleName]
    if (!status?.lastChecked) {
      freshModules.add(moduleName)
    }
  }

  // If all have timestamps, skip cascade (normal restart, not fresh install)
  if (freshModules.size === 0) {
    console.log('[startup-cascade] All modules have timestamps — skipping cascade (normal restart)')
    return { completed, skipped: [...TIER_0_MODULES, ...TIER_1_MODULES, ...TIER_2_MODULES, ...TIER_3_MODULES], failed }
  }

  console.log(`[startup-cascade] ${freshModules.size} modules have no timestamp — running cascade`)

  // Concurrency limit: max 2 concurrent API calls
  const sem = new Semaphore(2)

  // Helper: run tier in parallel with concurrency limit
  const runTier = async (tierName: string, modules: string[]): Promise<void> => {
    const tierModules = modules.filter(m => freshModules.has(m))
    if (tierModules.length === 0) {
      console.log(`[startup-cascade] ${tierName}: all modules have timestamps — skipping`)
      return
    }

    console.log(`[startup-cascade] ${tierName}: running ${tierModules.length} modules: ${tierModules.join(', ')}`)

    const results = await Promise.allSettled(
      tierModules.map(m => refreshModule(m, sem))
    )

    for (let i = 0; i < tierModules.length; i++) {
      const moduleName = tierModules[i]
      const result = results[i]

      if (result.status === 'fulfilled') {
        if (result.value.success) {
          completed.push(moduleName)
        } else {
          failed.push(moduleName)
          console.warn(`[startup-cascade] ${moduleName} failed: ${result.value.error}`)
        }
      } else {
        failed.push(moduleName)
        console.warn(`[startup-cascade] ${moduleName} rejected: ${result.reason}`)
      }
    }
  }

  // Run tiers sequentially: Tier 0 → wait → Tier 1 → wait → Tier 2 → wait → Tier 3
  // Tier 0 (subscriptions, partners) — bootstrap already writes these, skip
  for (const m of TIER_0_MODULES) {
    if (freshModules.has(m)) skipped.push(m)
  }

  await runTier('Tier 1', TIER_1_MODULES)
  await runTier('Tier 2', TIER_2_MODULES)
  await runTier('Tier 3', TIER_3_MODULES)

  const total = completed.length + skipped.length + failed.length
  console.log(`[startup-cascade] Complete: ${completed.length} succeeded, ${skipped.length} skipped, ${failed.length} failed (${total} total)`)

  return { completed, skipped, failed }
}
