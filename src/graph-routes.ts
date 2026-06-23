/**
 * src/graph-routes.ts
 * Intelligence Graph API Routes — GitHub Issue #516
 *
 * Two endpoints:
 * - GET /api/customer/:slug/expansion-motion — returns StrategicMotion or { motion: null }
 * - GET /api/customer/:slug/graph/debug — returns node/edge counts and edge type distribution
 *
 * Follows the established createXRouter(): Hono factory pattern.
 */

import { Hono } from 'hono'
import { getExpansionMotion, getGraphDebug, generateAllGraphs, type GenerateAllResult } from './lib/expansion-motion-service.ts'
import { generateMotionCampaigns } from './lib/motion-campaign-service.ts'
import { detectActionTriggers } from './lib/motion-action-triggers.ts'
import { computeGraphDiff } from './lib/graph-diff.ts'
import { loadGraph } from './lib/intelligence-graph.ts'
import { getSimilarCustomers } from './lib/customer-similarity.ts'
import { FeatureModuleRegistry } from './feature-module-registry.ts'
import type { Signal } from './feature-module-registry.ts'
import { customers } from './server-state.ts'
import { toSlug } from './cache-layer.ts'
import { sanitizeErr } from './utils.ts'
import { computeCustomerGraphHealth, computePortfolioHealth, type CustomerHealthReport } from './lib/graph-health.ts'
import { getSignalConfigKeys } from './lib/signal-config-keys.ts'

// ── Helpers ────────────────────────────────────────────────────────────────

function findCustomerBySlug(slug: string): { name: string; slug: string } | null {
  for (const c of customers) {
    if (toSlug(c.name) === slug) {
      return { name: c.name, slug }
    }
  }
  return null
}

/**
 * Collect SalesHub play/tactic signals from the registry.
 * These are portfolio-wide signals (audience: 'all').
 */
async function collectSalesHubSignals(): Promise<{ playSignals: Signal[]; tacticSignals: Signal[] }> {
  const saleshubModule = FeatureModuleRegistry.get('saleshub')

  const playSignals: Signal[] = []
  const tacticSignals: Signal[] = []

  if (saleshubModule?.signals) {
    try {
      const signals = await saleshubModule.signals('_global')
      for (const s of signals) {
        const m = s.metadata ?? {}
        if (m.tdpAlignment) {
          playSignals.push(s)
        } else if (m.parentTdp !== undefined) {
          tacticSignals.push(s)
        }
      }
    } catch (e: any) {
      console.warn('[graph-routes] Failed to collect SalesHub signals:', e?.message)
    }
  }

  // Also check saleshub-content for additional tactic signals
  const saleshubContentModule = FeatureModuleRegistry.get('saleshub-content')
  if (saleshubContentModule?.signals) {
    try {
      const signals = await saleshubContentModule.signals('_global')
      tacticSignals.push(...signals.filter(s => s.metadata?.parentTdp))
    } catch (e: any) {
      console.warn('[graph-routes] Failed to collect SalesHub tactic signals:', e?.message)
    }
  }

  return { playSignals, tacticSignals }
}

// ── Router ─────────────────────────────────────────────────────────────────

export function createGraphRouter(): Hono {
  const router = new Hono()

  // ── GET /api/customer/:slug/expansion-motion ──────────────────────────

  router.get('/api/customer/:slug/expansion-motion', async (c) => {
    const slug = c.req.param('slug')
    const customer = findCustomerBySlug(slug)

    if (!customer) {
      return c.json({ error: `Customer "${slug}" not found` }, 404)
    }

    try {
      // Collect SalesHub signals for motion building
      const { playSignals, tacticSignals } = await collectSalesHubSignals()

      const motion = await getExpansionMotion(
        slug,
        customer.name,
        {
          collectSignals: (customerSlug) => FeatureModuleRegistry.collectAllSignals(customerSlug),
          playSignals,
          tacticSignals,
        },
      )

      // Return 200 with { motion: null } when insufficient data — NOT 404
      return c.json({ motion })
    } catch (e: any) {
      console.error(`[graph-routes] Expansion motion failed for ${slug}:`, e?.message)
      return c.json({ error: sanitizeErr(e) }, 500)
    }
  })

  // ── GET /api/customer/:slug/graph/debug ───────────────────────────────

  router.get('/api/customer/:slug/graph/debug', async (c) => {
    const slug = c.req.param('slug')
    const customer = findCustomerBySlug(slug)

    if (!customer) {
      return c.json({ error: `Customer "${slug}" not found` }, 404)
    }

    try {
      const debug = getGraphDebug(slug)
      return c.json(debug)
    } catch (e: any) {
      console.error(`[graph-routes] Graph debug failed for ${slug}:`, e?.message)
      return c.json({ error: sanitizeErr(e) }, 500)
    }
  })

  // ── GET /api/customer/:slug/intelligence-changes (#603) ────────────────

  router.get('/api/customer/:slug/intelligence-changes', async (c) => {
    const slug = c.req.param('slug')
    const customer = findCustomerBySlug(slug)

    if (!customer) {
      return c.json({ error: `Customer "${slug}" not found` }, 404)
    }

    try {
      const { CACHE_DIR } = await import('./lib/paths.ts')
      const graph = loadGraph(slug, CACHE_DIR)
      if (!graph) {
        return c.json({
          customerSlug: slug,
          currentBuiltAt: null,
          changes: [],
          summary: 'No intelligence graph available yet',
        })
      }

      // Load the previous graph snapshot (#671)
      // persistGraph() saves the prior version as .previous.json before each write.
      let previousGraph: import('./lib/intelligence-graph-types.ts').CustomerGraph | null = null
      try {
        const { existsSync, readFileSync } = await import('fs')
        const { resolve } = await import('path')
        const prevPath = resolve(CACHE_DIR, slug, 'intelligence-graph.previous.json')
        if (existsSync(prevPath)) {
          previousGraph = JSON.parse(readFileSync(prevPath, 'utf-8'))
        }
      } catch {
        // If previous snapshot is unreadable, fall back to no previous
      }

      const diff = computeGraphDiff(graph, previousGraph)

      return c.json(diff)
    } catch (e: any) {
      console.error(`[graph-routes] Intelligence changes failed for ${slug}:`, e?.message)
      return c.json({ error: sanitizeErr(e) }, 500)
    }
  })

  // ── POST /api/customer/:slug/expansion-motion/campaigns ───────────────

  router.post('/api/customer/:slug/expansion-motion/campaigns', async (c) => {
    const slug = c.req.param('slug')
    const customer = findCustomerBySlug(slug)

    if (!customer) {
      return c.json({ error: `Customer "${slug}" not found` }, 404)
    }

    try {
      const body = await c.req.json().catch(() => ({}))
      const { playSignals, tacticSignals } = await collectSalesHubSignals()
      const motion = await getExpansionMotion(slug, customer.name, {
        collectSignals: (s: string) => FeatureModuleRegistry.collectAllSignals(s),
        playSignals,
        tacticSignals,
      })

      if (!motion) {
        return c.json({ error: 'No expansion motion available for this customer' }, 400)
      }

      const result = await generateMotionCampaigns({
        motion,
        customerSlug: slug,
        customerName: customer.name,
        phases: body.phases,
      })

      return c.json(result)
    } catch (e: any) {
      console.error(`[graph-routes] Campaign generation failed for ${slug}:`, e?.message)
      return c.json({ error: sanitizeErr(e) }, 500)
    }
  })

  // ── Generate All Graphs (#524) ──────────────────────────────────────────

  let generateAllState: { status: 'idle' | 'running' | 'complete'; result?: GenerateAllResult; startedAt?: string } = { status: 'idle' }

  router.post('/api/intelligence-graph/generate-all', async (c) => {
    if (generateAllState.status === 'running') {
      return c.json({ error: 'Graph generation already in progress', startedAt: generateAllState.startedAt }, 409)
    }

    generateAllState = { status: 'running', startedAt: new Date().toISOString() }

    const { playSignals, tacticSignals } = await collectSalesHubSignals()

    generateAllGraphs({
      customers: customers.map(c => ({ name: c.name })),
      getExpansionMotion,
      deps: {
        collectSignals: (slug: string) => FeatureModuleRegistry.collectAllSignals(slug),
        playSignals,
        tacticSignals,
      },
    }).then(result => {
      generateAllState = { status: 'complete', result, startedAt: generateAllState.startedAt }
      console.log(`[graph-routes] Generate all complete: ${result.graphsBuilt} graphs, ${result.motionsGenerated} motions, ${result.errors.length} errors in ${result.durationMs}ms`)
    }).catch(e => {
      generateAllState = { status: 'complete', result: { total: 0, graphsBuilt: 0, motionsGenerated: 0, errors: [{ customer: 'system', error: String(e?.message ?? e) }], durationMs: 0 }, startedAt: generateAllState.startedAt }
    })

    return c.json({ status: 'running', startedAt: generateAllState.startedAt }, 202)
  })

  router.get('/api/intelligence-graph/generate-all/status', (c) => {
    return c.json(generateAllState)
  })

  // ── GET /api/action-triggers (#546) ────────────────────────────────────

  router.get('/api/action-triggers', async (c) => {
    try {
      const { playSignals, tacticSignals } = await collectSalesHubSignals()
      const allTriggers: Array<ReturnType<typeof detectActionTriggers>[number]> = []

      for (const customer of customers) {
        const slug = toSlug(customer.name)
        try {
          const signals = await FeatureModuleRegistry.collectAllSignals(slug)
          const motion = await getExpansionMotion(slug, customer.name, {
            collectSignals: () => Promise.resolve(signals),
            playSignals,
            tacticSignals,
          })
          const triggers = detectActionTriggers(slug, customer.name, motion, signals)
          allTriggers.push(...triggers)
        } catch { /* skip customer on error */ }
      }

      allTriggers.sort((a, b) => {
        const urgencyOrder = { critical: 0, high: 1, medium: 2 }
        return (urgencyOrder[a.urgency] ?? 3) - (urgencyOrder[b.urgency] ?? 3)
      })

      return c.json({ triggers: allTriggers, count: allTriggers.length })
    } catch (e: any) {
      return c.json({ error: sanitizeErr(e) }, 500)
    }
  })

  // ── Usage tracking (#586) ──────────────────────────────────────────────

  router.post('/api/usage/track', async (c) => {
    const body = await c.req.json().catch(() => ({}))
    const { trackUsage } = await import('./lib/usage-tracker.ts')
    trackUsage({
      type: body.type ?? 'material_click',
      materialUrl: body.materialUrl,
      materialTitle: body.materialTitle,
      customerSlug: body.customerSlug ?? 'unknown',
      context: body.context,
      timestamp: new Date().toISOString(),
    })
    return c.json({ ok: true })
  })

  router.get('/api/admin/usage-summary', async (c) => {
    const { getUsageSummary } = await import('./lib/usage-tracker.ts')
    return c.json(getUsageSummary())
  })

  // ── GET /api/customer/:slug/similar (#612) ───────────────────────────────

  router.get('/api/customer/:slug/similar', async (c) => {
    const slug = c.req.param('slug')
    const customer = findCustomerBySlug(slug)

    if (!customer) {
      return c.json({ error: `Customer "${slug}" not found` }, 404)
    }

    try {
      const { CACHE_DIR } = await import('./lib/paths.ts')

      // Load all customer graphs from cache
      const allGraphs = new Map<string, import('./lib/intelligence-graph-types.ts').CustomerGraph>()
      for (const c of customers) {
        const customerSlug = toSlug(c.name)
        const graph = loadGraph(customerSlug, CACHE_DIR)
        if (graph) {
          allGraphs.set(customerSlug, graph)
        }
      }

      const similar = getSimilarCustomers(slug, allGraphs)

      return c.json({
        customer: customer.name,
        similar,
        computedAt: new Date().toISOString(),
      })
    } catch (e: any) {
      console.error(`[graph-routes] Similar customers failed for ${slug}:`, e?.message)
      return c.json({ error: sanitizeErr(e) }, 500)
    }
  })

  // ── GET /api/portfolio/triage (#623) ──────────────────────────────────────

  router.get('/api/portfolio/triage', async (c) => {
    try {
      const { CACHE_DIR } = await import('./lib/paths.ts')
      const urgencyOrder = { critical: 0, high: 1, medium: 2, low: 3 } as const
      type UrgencyLevel = keyof typeof urgencyOrder

      interface TriageEntry {
        customerName: string
        customerSlug: string
        topMotion: { title: string; urgency: UrgencyLevel; phaseCount: number; confidence: number } | null
        signalChangeCount: number
        graphNodeCount: number
      }

      const entries: TriageEntry[] = []

      for (const customer of customers) {
        const slug = toSlug(customer.name)
        const graph = loadGraph(slug, CACHE_DIR)

        if (!graph) continue

        // Derive urgency from graph signals without calling Gemini
        let urgency: UrgencyLevel = 'low'
        let confidence = 0.3
        let motionTitle = ''

        // Check motion history for the latest active/pinned motion
        const activeMotions = (graph.history ?? [])
          .filter(h => h.status === 'active' || h.status === 'pinned')
          .sort((a, b) => new Date(b.lastSeenAt).getTime() - new Date(a.lastSeenAt).getTime())
        const latestMotion = activeMotions[0]

        if (latestMotion) {
          motionTitle = latestMotion.title
          confidence = 0.7
        }

        // Count urgency-driving signals from graph nodes
        let criticalCaseCount = 0
        let highSevCaseCount = 0
        let expiredSubCount = 0
        let dealCount = 0
        const nodeValues = Object.values(graph.nodes)

        for (const node of nodeValues) {
          if (node.type === 'case') {
            const sev = String(node.properties?.severity ?? '')
            if (sev === '1' || sev === 'Urgent') criticalCaseCount++
            else if (sev === '2' || sev === 'High') highSevCaseCount++
          }
          if (node.type === 'subscription') {
            const status = String(node.properties?.status ?? '').toLowerCase()
            if (status === 'expired' || status === 'expiring') expiredSubCount++
          }
          if (node.type === 'deal') {
            dealCount++
          }
        }

        // Compute urgency from signal indicators
        if (criticalCaseCount > 0) {
          urgency = 'critical'
          confidence = 0.9
        } else if (highSevCaseCount >= 2 || expiredSubCount >= 3) {
          urgency = 'high'
          confidence = 0.8
        } else if (highSevCaseCount > 0 || expiredSubCount > 0 || dealCount > 0) {
          urgency = 'medium'
          confidence = 0.6
        }

        if (!motionTitle) {
          motionTitle = urgency === 'critical' ? 'Critical support escalation'
            : urgency === 'high' ? 'Renewal risk or escalation'
            : urgency === 'medium' ? 'Active engagement opportunity'
            : 'Monitoring'
        }

        // Count signal changes — nodes that appeared in the last 7 days
        const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000
        let signalChangeCount = 0
        for (const node of nodeValues) {
          if (node.history?.appeared) {
            const appeared = new Date(node.history.appeared).getTime()
            if (appeared > sevenDaysAgo) signalChangeCount++
          }
        }

        entries.push({
          customerName: customer.name,
          customerSlug: slug,
          topMotion: {
            title: motionTitle,
            urgency,
            phaseCount: latestMotion?.phaseCount ?? 0,
            confidence,
          },
          signalChangeCount,
          graphNodeCount: graph.nodeCount,
        })
      }

      // Sort by urgency (critical first), then by signal change count descending
      entries.sort((a, b) => {
        const aUrg = a.topMotion ? urgencyOrder[a.topMotion.urgency] : 4
        const bUrg = b.topMotion ? urgencyOrder[b.topMotion.urgency] : 4
        if (aUrg !== bUrg) return aUrg - bUrg
        return b.signalChangeCount - a.signalChangeCount
      })

      return c.json({
        entries,
        total: entries.length,
        computedAt: new Date().toISOString(),
      })
    } catch (e: any) {
      console.error('[graph-routes] Portfolio triage failed:', e?.message)
      return c.json({ error: sanitizeErr(e) }, 500)
    }
  })

  // ── GET /api/admin/graph-health (#875) ────────────────────────────────────

  router.get('/api/admin/graph-health', async (c) => {
    try {
      const { CACHE_DIR } = await import('./lib/paths.ts')
      const { existsSync, readFileSync } = await import('fs')
      const { resolve } = await import('path')
      const signalConfigKeys = getSignalConfigKeys()
      const reports: CustomerHealthReport[] = []

      for (const customer of customers) {
        const slug = toSlug(customer.name)
        const graph = loadGraph(slug, CACHE_DIR)
        if (!graph) continue

        // Load cached motion if exists (read-only, no generation)
        let motion: import('./lib/motion-builder.ts').StrategicMotion | null = null
        try {
          const motionPath = resolve(CACHE_DIR, 'intelligence', `${slug}-expansion.json`)
          if (existsSync(motionPath)) {
            motion = JSON.parse(readFileSync(motionPath, 'utf-8'))
          }
        } catch {
          // Skip motion — report still valid without it
        }

        const report = computeCustomerGraphHealth(graph, signalConfigKeys, motion)
        reports.push(report)
      }

      return c.json(reports)
    } catch (e: any) {
      console.error('[graph-routes] Graph health failed:', e?.message)
      return c.json({ error: sanitizeErr(e) }, 500)
    }
  })

  // ── GET /api/admin/graph-health/portfolio (#875) ────────────────────────

  router.get('/api/admin/graph-health/portfolio', async (c) => {
    try {
      const { CACHE_DIR } = await import('./lib/paths.ts')
      const { existsSync, readFileSync } = await import('fs')
      const { resolve } = await import('path')
      const signalConfigKeys = getSignalConfigKeys()
      const reports: CustomerHealthReport[] = []

      for (const customer of customers) {
        const slug = toSlug(customer.name)
        const graph = loadGraph(slug, CACHE_DIR)
        if (!graph) continue

        let motion: import('./lib/motion-builder.ts').StrategicMotion | null = null
        try {
          const motionPath = resolve(CACHE_DIR, 'intelligence', `${slug}-expansion.json`)
          if (existsSync(motionPath)) {
            motion = JSON.parse(readFileSync(motionPath, 'utf-8'))
          }
        } catch {
          // Skip motion
        }

        const report = computeCustomerGraphHealth(graph, signalConfigKeys, motion)
        reports.push(report)
      }

      const portfolio = computePortfolioHealth(reports)
      return c.json(portfolio)
    } catch (e: any) {
      console.error('[graph-routes] Portfolio health failed:', e?.message)
      return c.json({ error: sanitizeErr(e) }, 500)
    }
  })

  return router
}
