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
import { FeatureModuleRegistry } from './feature-module-registry.ts'
import type { Signal } from './feature-module-registry.ts'
import { customers } from './server-state.ts'
import { toSlug } from './cache-layer.ts'
import { sanitizeErr } from './utils.ts'

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

      // Load the previous graph snapshot if it exists
      // The previous graph state is embedded in the current graph's nodes
      // via history fields. We can compute the diff from just the current graph
      // by using null as previousGraph (shows all active as new) or by loading
      // a separate previous snapshot.
      //
      // For now, compute diff from the current graph alone. Nodes with
      // history.status === 'historical' are surfaced as disappeared.
      // New nodes are detected by checking if they appeared after the graph's
      // own builtAt minus a reasonable window (7 days).
      //
      // Better approach: use the graph itself as both current and previous
      // by reading history fields. No separate snapshot needed.
      const diff = computeGraphDiff(graph)

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

  return router
}
