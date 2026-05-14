// src/lib/signal-loader.ts
// GitHub Issue #171 — Universal signal loading for content generation
// Combines registry signal collection + legacy cache fallback

import { FeatureModuleRegistry } from '../feature-module-registry.ts'
import { existsSync, readFileSync, readdirSync } from 'fs'
import { resolve } from 'path'

const CACHE_DIR = process.env.CACHE_DIR ?? resolve(import.meta.dir, '../../cache')

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
  loaded: string[]
  missing: string[]
}

// ── Signal loading ───────────────────────────────────────────────────────────

/**
 * Load all customer signal sources from:
 * 1. Feature modules that implement signals() (via registry)
 * 2. Legacy cache files (for sources not yet migrated to modules)
 *
 * Returns combined signals in the legacy CustomerSignals shape for backward compatibility.
 * Missing sources are logged but don't block generation.
 */
export function loadCustomerSignals(customerSlug: string, customerName?: string): SignalLoadResult {
  const signals: CustomerSignals = {}
  const loaded: string[] = []
  const missing: string[] = []

  // Helper for loading legacy cache files
  const tryLoad = (name: string, path: string, postProcess?: (data: any) => any) => {
    try {
      if (existsSync(path)) {
        let data = JSON.parse(readFileSync(path, 'utf-8'))
        if (postProcess) data = postProcess(data)
        ;(signals as any)[name] = data
        loaded.push(name)
      } else {
        missing.push(name)
      }
    } catch (e: any) {
      console.warn(`[signal-loader] Failed to load ${name} for ${customerSlug}:`, e.message)
      missing.push(name)
    }
  }

  // TODO (GitHub Issue #171): Once feature modules implement signals(),
  // call FeatureModuleRegistry.collectAllSignals(customerSlug) here
  // and populate CustomerSignals from the flat Signal[] result.
  // For now, only legacy cache loading is active.

  // Legacy cache loading (8 sources)

  // 1. Intelligence brief
  tryLoad('intelligence', resolve(CACHE_DIR, 'intelligence', `${customerSlug}.json`))

  // 2. Customer docs
  tryLoad('customerDocs', resolve(CACHE_DIR, 'product-intel', 'customer-docs', `${customerSlug}.json`))

  // 3. Daily brief (try today first, then most recent)
  const today = new Date().toISOString().slice(0, 10)
  const briefPath = resolve(CACHE_DIR, `${customerSlug}-${today}.json`)
  if (existsSync(briefPath)) {
    tryLoad('dailyBrief', briefPath)
  } else {
    // Scan for most recent brief
    try {
      const files = readdirSync(CACHE_DIR).filter(f => f.startsWith(`${customerSlug}-`) && f.match(/\d{4}-\d{2}-\d{2}\.json$/))
      if (files.length > 0) {
        files.sort().reverse()
        tryLoad('dailyBrief', resolve(CACHE_DIR, files[0]))
      } else {
        missing.push('dailyBrief')
      }
    } catch { missing.push('dailyBrief') }
  }

  // 4. Subscriptions
  tryLoad('subscriptions', resolve(CACHE_DIR, `${customerSlug}-sheets.json`))

  // 5. Emails
  tryLoad('emails', resolve(CACHE_DIR, `${customerSlug}-emails.json`))

  // 6. Cases (filter by customer name from global cases file)
  tryLoad('cases', resolve(CACHE_DIR, 'cases.json'), (data) => {
    if (!customerName || !Array.isArray(data)) return data
    return data.filter((c: any) => c.customer?.toLowerCase() === customerName.toLowerCase() || c.accountName?.toLowerCase() === customerName.toLowerCase())
  })

  // 7. Product intel (scan for any customer-specific product intel)
  try {
    const productIntelDir = resolve(CACHE_DIR, 'product-intel')
    if (existsSync(productIntelDir)) {
      const dirs = readdirSync(productIntelDir).filter(d => d.endsWith('-customer-intel'))
      const allIntel: any[] = []
      for (const dir of dirs) {
        const filePath = resolve(productIntelDir, dir, `${customerSlug}.json`)
        if (existsSync(filePath)) {
          allIntel.push(JSON.parse(readFileSync(filePath, 'utf-8')))
        }
      }
      if (allIntel.length > 0) {
        signals.productIntel = allIntel
        loaded.push('productIntel')
      } else {
        missing.push('productIntel')
      }
    } else {
      missing.push('productIntel')
    }
  } catch { missing.push('productIntel') }

  // 8. Account plan (markdown)
  try {
    const planPath = resolve(CACHE_DIR, 'intelligence', `${customerSlug}-account-plan.md`)
    if (existsSync(planPath)) {
      signals.accountPlan = readFileSync(planPath, 'utf-8')
      loaded.push('accountPlan')
    } else {
      missing.push('accountPlan')
    }
  } catch { missing.push('accountPlan') }

  console.log(`[signal-loader] Signal stack for ${customerSlug}: loaded=[${loaded.join(',')}] missing=[${missing.join(',')}]`)
  return { signals, loaded, missing }
}
