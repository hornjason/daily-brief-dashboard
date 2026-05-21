/**
 * Account Plan Module — GitHub Issue #274
 * Migrates legacy account plan cache to registry signal contract.
 * GitHub Issue #328 — ensureFresh implementation
 */

import { FeatureModuleRegistry, type Signal } from '../feature-module-registry.ts'
import { existsSync, readFileSync, statSync } from 'fs'
import { resolve } from 'path'

const CACHE_DIR = process.env.CACHE_DIR ?? 'data/cache'
const ACCOUNT_PLAN_TTL_MS = 7 * 24 * 60 * 60 * 1000  // 7 days

/**
 * Check if account plan cache exists and is fresh.
 */
function isAccountPlanFresh(customerSlug: string): boolean {
  const path = resolve(CACHE_DIR, 'intelligence', `${customerSlug}-account-plan.md`)
  if (!existsSync(path)) return false

  try {
    const age = Date.now() - statSync(path).mtime.getTime()
    return age < ACCOUNT_PLAN_TTL_MS
  } catch {
    return false
  }
}

FeatureModuleRegistry.register({
  name: 'account-plan',
  scope: 'customer',
  cachePaths: () => [],
  cacheTtlMs: ACCOUNT_PLAN_TTL_MS,
  async fetch(): Promise<void> {},
  async cleanup(): Promise<void> {},
  async syncNow(): Promise<void> {},

  async ensureFresh(customerSlug: string): Promise<void> {
    if (isAccountPlanFresh(customerSlug)) {
      return  // Cache is fresh
    }

    // Cache is stale or missing — trigger generation
    const { generateAndSaveAccountPlan } = await import('../account-plan.ts')
    const { customers } = await import('../server-state.ts')
    const { toSlug } = await import('../cache-layer.ts')
    const customer = customers.find(c => toSlug(c.name) === customerSlug)

    if (!customer) {
      console.warn(`[account-plan-module] ensureFresh: customer not found for slug ${customerSlug}`)
      return
    }

    const cacheDir = process.env.CACHE_DIR ?? 'data/cache'
    const configDir = process.env.CONFIG_DIR ?? 'config'
    await generateAndSaveAccountPlan(customer, cacheDir, configDir)
  },

  async signals(customerSlug: string): Promise<Signal[]> {
    const path = resolve(CACHE_DIR, 'intelligence', `${customerSlug}-account-plan.md`)
    if (!existsSync(path)) return []

    let content: string
    try {
      content = readFileSync(path, 'utf-8')
    } catch { return [] }

    if (!content.trim()) return []

    const mtime = statSync(path).mtime.toISOString()
    const firstLine = content.split('\n').find(l => l.trim()) ?? 'Account Plan'

    return [{
      source: 'account-plan',
      type: 'account-plan',
      headline: firstLine.replace(/^#+\s*/, '').substring(0, 80),
      detail: content.substring(0, 300),
      rawRelevance: 0.7,
      timestamp: mtime,
      metadata: {
        customerSlug,
        contentLength: content.length,
      },
    }]
  },
})
