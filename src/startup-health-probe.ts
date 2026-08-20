/**
 * Startup Health Probe System (Issue #746, Slice 2)
 *
 * Registers diagnostic probes that run at startup, report pass/fail/healed,
 * and optionally auto-fix known problems. Results are cached in memory
 * and served via GET /api/admin/health.
 *
 * Built-in probes:
 *   - gemini-model: validates configured Gemini model against org policy
 *   - stale-empty-caches: finds and deletes empty tech-stack cache files
 *   - google-auth: tests Gemini token acquisition
 */

import { existsSync, readdirSync, readFileSync, unlinkSync } from 'fs'
import { resolve, join } from 'path'
import { CACHE_DIR } from './lib/paths.ts'

// ── Types ────────────────────────────────────────────────────────────────────

export interface HealthProbe {
  name: string
  category: 'critical' | 'warning' | 'info'
  test: () => Promise<{ passed: boolean; message: string }>
  heal?: () => Promise<string>
}

export interface HealthResult {
  name: string
  category: 'critical' | 'warning' | 'info'
  status: 'pass' | 'fail' | 'healed'
  message: string
  healAction?: string
  timestamp: string
}

// ── Registry ─────────────────────────────────────────────────────────────────

const probes: HealthProbe[] = []
let lastResults: HealthResult[] = []

export function registerProbe(probe: HealthProbe): void {
  probes.push(probe)
}

export function getHealthResults(): HealthResult[] {
  return lastResults
}

/** Test-only: clear probes and results for isolation */
export function _resetProbesForTesting(): void {
  probes.length = 0
  lastResults = []
}

// ── Runner ───────────────────────────────────────────────────────────────────

export async function runHealthProbes(): Promise<HealthResult[]> {
  const results: HealthResult[] = []

  for (const probe of probes) {
    try {
      const { passed, message } = await probe.test()
      if (passed) {
        results.push({
          name: probe.name,
          category: probe.category,
          status: 'pass',
          message,
          timestamp: new Date().toISOString(),
        })
      } else if (probe.heal) {
        try {
          const healAction = await probe.heal()
          results.push({
            name: probe.name,
            category: probe.category,
            status: 'healed',
            message,
            healAction,
            timestamp: new Date().toISOString(),
          })
        } catch (healErr: any) {
          results.push({
            name: probe.name,
            category: probe.category,
            status: 'fail',
            message: `${message} (heal failed: ${healErr.message})`,
            timestamp: new Date().toISOString(),
          })
        }
      } else {
        results.push({
          name: probe.name,
          category: probe.category,
          status: 'fail',
          message,
          timestamp: new Date().toISOString(),
        })
      }
    } catch (e: any) {
      results.push({
        name: probe.name,
        category: probe.category,
        status: 'fail',
        message: e.message,
        timestamp: new Date().toISOString(),
      })
    }
  }

  lastResults = results

  // Log summary
  const passed = results.filter(r => r.status === 'pass').length
  const healed = results.filter(r => r.status === 'healed').length
  const failed = results.filter(r => r.status === 'fail').length
  console.log(`[health] Startup probe: ${passed} pass, ${healed} healed, ${failed} fail`)
  for (const r of results) {
    if (r.status !== 'pass') {
      console.log(`[health]   ${r.status.toUpperCase()}: ${r.name} — ${r.message}${r.healAction ? ` (healed: ${r.healAction})` : ''}`)
    }
  }

  return results
}

// ── Built-in Probes ──────────────────────────────────────────────────────────

/**
 * Probe: gemini-model (critical)
 * Tests whether the configured Gemini model is allowed by org policy.
 * Auto-heals by falling back to gemini-2.5-pro if the current model is blocked.
 */
registerProbe({
  name: 'gemini-model',
  category: 'critical',
  test: async () => {
    try {
      const { callGemini } = await import('./gemini-call.ts')
      await callGemini(
        'You are a health check probe.',
        'Say hello',
        { callType: 'health-probe', timeoutMs: 15_000 }
      )
      return { passed: true, message: 'Gemini model responding' }
    } catch (e: any) {
      const msg = e.message ?? String(e)
      if (msg.includes('allowedModels') || msg.includes('not allowed') || msg.includes('400')) {
        return { passed: false, message: `Model blocked by org policy: ${msg.slice(0, 200)}` }
      }
      // Non-policy errors (auth, network) — still fail but different message
      return { passed: false, message: `Gemini call failed: ${msg.slice(0, 200)}` }
    }
  },
  heal: async () => {
    // Try falling back to gemini-3.5-flash then gemini-2.5-pro
    for (const fallback of ['gemini-3.5-flash', 'gemini-2.5-pro']) {
      process.env.GEMINI_MODEL = fallback
      try {
        const { callGemini } = await import('./gemini-call.ts')
        await callGemini(
          'You are a health check probe.',
          'Say hello',
          { callType: 'health-probe', timeoutMs: 15_000 }
        )
        return `Set GEMINI_MODEL=${fallback} (org policy fallback)`
      } catch { /* try next */ }
    }
    throw new Error('All model fallbacks failed (gemini-3.5-flash, gemini-2.5-pro)')
    }
  },
})

/**
 * Probe: stale-empty-caches (warning)
 * Scans tech-stack cache for files with empty technologies arrays.
 * Auto-heals by deleting empty files so ensureFresh triggers re-extraction.
 */
registerProbe({
  name: 'stale-empty-caches',
  category: 'warning',
  test: async () => {
    const emptyFiles: string[] = []

    // Scan tech-stack cache
    const techStackDir = resolve(CACHE_DIR, 'tech-stack')
    if (existsSync(techStackDir)) {
      try {
        const files = readdirSync(techStackDir).filter(f => f.endsWith('.json'))
        for (const file of files) {
          try {
            const content = JSON.parse(readFileSync(join(techStackDir, file), 'utf-8'))
            if (Array.isArray(content.technologies) && content.technologies.length === 0) {
              emptyFiles.push(`tech-stack/${file}`)
            }
          } catch { /* skip unparseable files */ }
        }
      } catch { /* dir read failed */ }
    }

    // Scan cloud-marketplace
    const marketplaceFile = resolve(CACHE_DIR, 'cloud-marketplace', 'latest.json')
    if (existsSync(marketplaceFile)) {
      try {
        const content = JSON.parse(readFileSync(marketplaceFile, 'utf-8'))
        if (content.providers && Array.isArray(content.providers)) {
          const emptyProviders = content.providers.filter(
            (p: any) => Array.isArray(p.offerings) && p.offerings.length === 0 && p.name
          )
          if (emptyProviders.length > 0) {
            emptyFiles.push(`cloud-marketplace/latest.json (${emptyProviders.length} empty providers)`)
          }
        }
      } catch { /* skip */ }
    }

    if (emptyFiles.length > 0) {
      return { passed: false, message: `${emptyFiles.length} stale empty cache files: ${emptyFiles.join(', ')}` }
    }
    return { passed: true, message: 'No stale empty caches found' }
  },
  heal: async () => {
    let deleted = 0
    const techStackDir = resolve(CACHE_DIR, 'tech-stack')
    if (existsSync(techStackDir)) {
      try {
        const files = readdirSync(techStackDir).filter(f => f.endsWith('.json'))
        for (const file of files) {
          try {
            const filePath = join(techStackDir, file)
            const content = JSON.parse(readFileSync(filePath, 'utf-8'))
            if (Array.isArray(content.technologies) && content.technologies.length === 0) {
              unlinkSync(filePath)
              deleted++
            }
          } catch { /* skip */ }
        }
      } catch { /* dir read failed */ }
    }
    return `Deleted ${deleted} empty tech-stack cache files`
  },
})

/**
 * Probe: google-auth (critical)
 * Tests Gemini token acquisition via getGeminiToken().
 * No auto-heal — user must fix auth config.
 */
registerProbe({
  name: 'google-auth',
  category: 'critical',
  test: async () => {
    try {
      const { getGeminiToken } = await import('./gemini-auth.ts')
      const token = await getGeminiToken()
      if (!token) {
        return { passed: false, message: 'getGeminiToken() returned empty token' }
      }
      return { passed: true, message: 'Google auth token acquired' }
    } catch (e: any) {
      return { passed: false, message: `Token acquisition failed: ${e.message?.slice(0, 200)}` }
    }
  },
})

/**
 * Probe: intelligence graph freshness (#878)
 * Checks how many customer graphs have builtAt >48h old.
 * Returns 'warn' if >50% are stale.
 */
registerProbe({
  name: 'intelligence-graph-freshness',
  category: 'warning',
  test: async () => {
    try {
      const { loadGraph } = await import('./lib/intelligence-graph.ts')
      const { customers } = await import('./server-state.ts')
      const { toSlug } = await import('./cache-layer.ts')

      if (!customers || customers.length === 0) {
        return { passed: true, message: 'No customers configured — skipping intelligence graph freshness check' }
      }

      const FORTY_EIGHT_HOURS = 48 * 60 * 60 * 1000
      const now = Date.now()
      let staleCount = 0
      let graphCount = 0

      for (const customer of customers) {
        const slug = toSlug(customer.name)
        const graph = loadGraph(slug, CACHE_DIR)
        if (!graph) continue
        graphCount++
        const builtAtMs = new Date(graph.builtAt).getTime()
        if (now - builtAtMs > FORTY_EIGHT_HOURS) {
          staleCount++
        }
      }

      if (graphCount === 0) {
        return { passed: true, message: 'No intelligence graphs found — graphs not yet built' }
      }

      if (staleCount > graphCount / 2) {
        return {
          passed: false,
          message: `${staleCount}/${graphCount} intelligence graphs are >48h stale — graph rebuild may be stalled`,
        }
      }

      return {
        passed: true,
        message: `Intelligence graph freshness OK: ${graphCount - staleCount}/${graphCount} graphs are <48h old`,
      }
    } catch (e: any) {
      return { passed: false, message: `Intelligence graph freshness check failed: ${e.message?.slice(0, 200)}` }
    }
  },
})
