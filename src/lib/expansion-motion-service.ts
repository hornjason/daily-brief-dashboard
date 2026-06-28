/**
 * src/lib/expansion-motion-service.ts
 * Expansion Motion Service — GitHub Issue #516
 *
 * Consumer-facing facade for intelligence graph + motion building.
 * All 6 consumer surfaces call getExpansionMotion() — a single entry point
 * that handles graph loading, freshness checks, building, and persistence.
 *
 * Dependencies (all read-only — this file does NOT modify them):
 *   - intelligence-graph.ts — buildCustomerGraph, loadGraph, persistGraph
 *   - motion-builder.ts — buildMotion, StrategicMotion, MotionPhase
 *   - feature-module-registry.ts — Signal type (for dependency injection)
 */

import type { Signal } from '../feature-module-registry.ts'
import type { CustomerGraph } from './intelligence-graph-types.ts'
import type { StrategicMotion } from './motion-builder.ts'
import { buildCustomerGraph, loadGraph, persistGraph, filterStaleEdges } from './intelligence-graph.ts'
import { buildMotion } from './motion-builder.ts'
import { computePortfolioFrequency } from './tactic-scorer.ts'
import { loadOutcomeHistory } from './deal-outcome-history.ts'
import { getSimilarCustomers } from './customer-similarity.ts'
import { enrichPersonas } from './persona-enrichment.ts'
import { CACHE_DIR } from './paths.ts'
import { existsSync, readFileSync, statSync } from 'fs'
import { resolve } from 'path'

// ── Constants ──────────────────────────────────────────────────────────────

/** Graph is considered fresh if built within this window */
const GRAPH_FRESHNESS_MS = 60 * 60 * 1000 // 1 hour

/** Motion cache is considered fresh if written within this window */
const MOTION_FRESHNESS_MS = 4 * 60 * 60 * 1000 // 4 hours

/** Slugs currently being rebuilt — prevents duplicate concurrent rebuilds */
const _rebuildingInFlight = new Set<string>()

// ── Types ──────────────────────────────────────────────────────────────────

/**
 * Signal sources injected by the caller — avoids tight coupling to
 * FeatureModuleRegistry internals. Routes pass the registry's
 * collectAllSignals; tests pass mock signal arrays.
 */
export interface ExpansionMotionDeps {
  /** Collect customer-specific signals (subscriptions, cases, etc.) */
  collectSignals: (customerSlug: string) => Promise<Signal[]>
  /** SalesHub play signals (portfolio-wide) */
  playSignals: Signal[]
  /** SalesHub tactic signals (portfolio-wide) */
  tacticSignals: Signal[]
  /** Who triggered this build — stamped on persisted graph (#877) */
  rebuiltBy?: 'on-demand' | 'scheduled' | 'manual'
}

export interface GraphDebugNode {
  id: string
  type: string
  name: string
}

export interface GraphDebugEdge {
  from: string
  to: string
  relation: string
  tier: 'factual' | 'derived'
  strength: number
}

export interface GraphDebugInfo {
  nodeCount: number
  edgeCount: number
  edgeTypes: Record<string, number>
  builtAt?: string
  nodes: GraphDebugNode[]
  edges: GraphDebugEdge[]
  motionTitle?: string
}

// ── getExpansionMotion ──────────────────────────────────────────────────────

/**
 * Single consumer-facing function for all expansion motion surfaces.
 *
 * 1. Loads persisted graph (if exists)
 * 2. If no graph or graph is stale, rebuilds from signals
 * 3. Builds StrategicMotion from graph + play/tactic signals
 * 4. Returns StrategicMotion (or null if insufficient data)
 */
export async function getExpansionMotion(
  customerSlug: string,
  customerName: string,
  deps: ExpansionMotionDeps,
): Promise<StrategicMotion | null> {
  const dataDir = CACHE_DIR

  // ── Stale-while-revalidate: serve cached motion immediately (#904) ──────
  const cachedMotion = loadCachedMotion(customerSlug, dataDir)

  if (cachedMotion) {
    // Cached motion exists — return immediately
    // If graph is stale (> 1 hour), trigger background rebuild (fire-and-forget)
    const graph = loadGraph(customerSlug, dataDir)
    if (!graph || isGraphStale(graph)) {
      triggerBackgroundRebuild(customerSlug, customerName, deps)
    }
    return cachedMotion
  }

  // ── No cached motion — full synchronous build (first-time load) ─────────
  return buildMotionFull(customerSlug, customerName, deps)
}

/**
 * Load cached motion.json if it exists and is recent (< 4 hours old).
 */
function loadCachedMotion(customerSlug: string, dataDir: string): StrategicMotion | null {
  const motionPath = resolve(dataDir, customerSlug, 'motion.json')
  if (!existsSync(motionPath)) return null

  try {
    const stat = statSync(motionPath)
    const ageMs = Date.now() - stat.mtimeMs
    if (ageMs > MOTION_FRESHNESS_MS) return null

    return JSON.parse(readFileSync(motionPath, 'utf-8'))
  } catch {
    return null
  }
}

/**
 * Trigger a background rebuild — fire-and-forget, with in-flight guard.
 * Does not block the caller. Errors are logged and swallowed.
 */
function triggerBackgroundRebuild(
  customerSlug: string,
  customerName: string,
  deps: ExpansionMotionDeps,
): void {
  if (_rebuildingInFlight.has(customerSlug)) return
  _rebuildingInFlight.add(customerSlug)

  buildMotionFull(customerSlug, customerName, deps)
    .catch((e: any) => {
      console.warn(`[expansion-motion] Background rebuild failed for ${customerSlug}:`, e?.message)
    })
    .finally(() => {
      _rebuildingInFlight.delete(customerSlug)
    })
}

/**
 * Full synchronous motion build pipeline — graph + motion + enrichment + persist.
 * Used for first-time loads and background rebuilds.
 */
async function buildMotionFull(
  customerSlug: string,
  customerName: string,
  deps: ExpansionMotionDeps,
): Promise<StrategicMotion | null> {
  const dataDir = CACHE_DIR

  // #585: Ensure signal data is current before graph building
  try {
    const { ensureSignalsCurrent } = await import('../lib/signal-loader.ts')
    await ensureSignalsCurrent(customerSlug, customerName)
  } catch (e: any) {
    console.warn(`[expansion-motion] Pre-flight refresh failed for ${customerSlug}:`, e?.message)
  }

  // Step 1: Try loading existing graph
  let graph = loadGraph(customerSlug, dataDir)

  // Step 2: Rebuild if no graph or stale
  const stale = !graph || isGraphStale(graph)

  if (stale) {
    const signals = await deps.collectSignals(customerSlug)

    if (signals.length === 0) {
      return null
    }

    graph = buildCustomerGraph(customerSlug, customerName, signals, graph)

    // Stamp rebuiltBy on graph for health monitoring (#877)
    graph.rebuiltBy = deps.rebuiltBy ?? 'on-demand'

    // Persist the rebuilt graph
    try {
      persistGraph(graph, dataDir)
    } catch (e: any) {
      console.warn(`[expansion-motion] Failed to persist graph for ${customerSlug}:`, e?.message)
      // Continue — graph is in memory, motion can still be built
    }
  }

  // Guard: if graph is still null after all attempts, nothing to build from
  if (!graph) {
    return null
  }

  // Step 3: Filter stale derived edges before passing to motion builder (#522)
  const freshEdges = filterStaleEdges(graph)
  const filteredGraph: CustomerGraph = { ...graph, edges: freshEdges, edgeCount: freshEdges.length }

  // Step 3b: Compute portfolio-level tactic frequency for diversity penalty (#618)
  let portfolioFrequency: Map<string, number> | undefined
  try {
    const { customers: allCustomers } = await import('../server-state.ts')
    const { toSlug } = await import('../cache-layer.ts')
    const allGraphs = new Map<string, CustomerGraph>()
    for (const c of allCustomers) {
      const s = toSlug(c.name)
      const g = loadGraph(s, CACHE_DIR)
      if (g) allGraphs.set(s, g)
    }
    if (allGraphs.size >= 3) {
      const tacticList = deps.tacticSignals.map(s => ({
        name: s.headline,
        parentTdp: String(s.metadata?.parentTdp ?? ''),
        assets: [],
      }))
      portfolioFrequency = computePortfolioFrequency(allGraphs, tacticList)
    }
  } catch (e: any) {
    console.warn('[expansion-motion] Portfolio frequency computation failed:', e?.message)
  }

  // Step 3c: Load deal outcome history for tactic scoring (#622)
  let outcomeHistory: import('./deal-outcome-history.ts').TacticOutcome[] | undefined
  let similarCustomerSlugs: Set<string> | undefined
  try {
    outcomeHistory = loadOutcomeHistory(CACHE_DIR)
    if (outcomeHistory.length > 0) {
      // Find similar customers to boost outcomes from comparable accounts
      const { customers: allCustomers } = await import('../server-state.ts')
      const { toSlug } = await import('../cache-layer.ts')
      const allGraphs = new Map<string, CustomerGraph>()
      for (const c of allCustomers) {
        const s = toSlug(c.name)
        const g = loadGraph(s, CACHE_DIR)
        if (g) allGraphs.set(s, g)
      }
      if (allGraphs.size >= 2) {
        const similar = getSimilarCustomers(customerSlug, allGraphs, 10)
        if (similar.length > 0) {
          similarCustomerSlugs = new Set(similar.map(s => s.slug))
        }
      }
    }
  } catch (e: any) {
    console.warn('[expansion-motion] Outcome history loading failed:', e?.message)
  }

  // Step 4: Build motion from filtered graph + play/tactic signals
  const motion = await buildMotion(
    filteredGraph,
    customerSlug,
    customerName,
    deps.playSignals,
    deps.tacticSignals,
    portfolioFrequency,
    undefined, // teamContext — loaded by caller when available
    outcomeHistory,
    similarCustomerSlugs,
  )

  // Step 5: Enrich target personas with real contacts (#533)
  if (motion) {
    const allPersonas = [...new Set(motion.phases.flatMap(p => p.targetPersonas))]
    if (allPersonas.length > 0) {
      try {
        const enriched = enrichPersonas({
          customerSlug,
          customerName,
          targetPersonas: allPersonas,
          existingContacts: [],
          cacheDir: dataDir,
        })
        motion.enrichedContacts = enriched
          .filter(e => e.status === 'found')
          .map(e => ({
            persona: e.personaRole,
            name: e.contact?.name,
            email: e.contact?.email,
            title: e.contact?.title,
            linkedinUrl: e.contact?.linkedinUrl,
            source: e.contact?.source,
          }))
      } catch (e: any) {
        console.warn(`[expansion-motion] Persona enrichment failed for ${customerSlug}:`, e?.message)
        // Continue — motion is still valid without enriched contacts
      }
    }

    // Step 6: Populate unstructuredRecommendations when UNIFIED_INTELLIGENCE is enabled (#888)
    if (process.env.UNIFIED_INTELLIGENCE === 'true') {
      try {
        const { FeatureModuleRegistry } = await import('../feature-module-registry.ts')
        const recModule = FeatureModuleRegistry.get('recommended-actions')
        if (recModule?.signals) {
          const recSignals = await recModule.signals(customerSlug)
          // Extract solution names already in phase evidence to dedup
          const phaseEvidence = new Set(
            motion.phases.flatMap(p => p.evidence.map(e => e.fact.toLowerCase()))
          )

          motion.unstructuredRecommendations = recSignals
            .filter(s => !phaseEvidence.has(s.headline.toLowerCase()))
            .map(s => ({
              action: s.headline,
              confidence: (String(s.metadata?.confidence ?? 'emerging')).toLowerCase() as 'high' | 'medium' | 'emerging',
              triggerCount: Number(s.metadata?.triggerSignalCount ?? 0),
              solution: {
                name: String(s.metadata?.solutionName ?? ''),
                type: String(s.metadata?.solutionType ?? ''),
                url: s.url,
              },
              assets: s.metadata?.assets as Array<{ name: string; url: string; type: string }> | undefined,
            }))
            .slice(0, 10) // cap at 10 additional recommendations
        }
      } catch (e: any) {
        console.warn(`[expansion-motion] Recommended-actions failed for ${customerSlug}:`, e?.message)
      }
    }

    // Persist motion to disk for health monitoring (#877) + stale-while-revalidate cache (#904)
    try {
      const { writeJsonAtomic } = await import('./atomic-write.ts')
      const motionPath = resolve(dataDir, customerSlug, 'motion.json')
      writeJsonAtomic(motionPath, motion)
    } catch (e: any) {
      console.warn(`[expansion-motion] Failed to persist motion for ${customerSlug}:`, e?.message)
    }
  }

  return motion
}

// ── getGraphDebug ──────────────────────────────────────────────────────────

/**
 * Return raw graph stats for the debug endpoint.
 * Reads from persisted graph — does not trigger a rebuild.
 */
export function getGraphDebug(customerSlug: string): GraphDebugInfo {
  const dataDir = CACHE_DIR
  const graph = loadGraph(customerSlug, dataDir)

  if (!graph) {
    return { nodeCount: 0, edgeCount: 0, edgeTypes: {}, nodes: [], edges: [] }
  }

  // Count edge types
  const edgeTypes: Record<string, number> = {}
  for (const edge of graph.edges) {
    edgeTypes[edge.relation] = (edgeTypes[edge.relation] ?? 0) + 1
  }

  // Stripped node list
  const nodes: GraphDebugNode[] = Object.values(graph.nodes).map(n => ({
    id: n.id,
    type: n.type,
    name: n.name,
  }))

  // Stripped edge list — resolve node names for readability
  const edges: GraphDebugEdge[] = graph.edges.map(e => ({
    from: e.from,
    to: e.to,
    relation: e.relation,
    tier: e.tier,
    strength: e.strength,
  }))

  // Find most recent active motion title from history
  const activeMotions = (graph.history ?? []).filter(h => h.status === 'active')
  const latestMotion = activeMotions.sort((a, b) =>
    new Date(b.lastSeenAt).getTime() - new Date(a.lastSeenAt).getTime()
  )[0]

  return {
    nodeCount: graph.nodeCount,
    edgeCount: graph.edgeCount,
    edgeTypes,
    builtAt: graph.builtAt,
    nodes,
    edges,
    motionTitle: latestMotion?.title,
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Check if the graph's builtAt timestamp is older than GRAPH_FRESHNESS_MS.
 */
function isGraphStale(graph: CustomerGraph): boolean {
  if (!graph.builtAt) return true

  const builtAtMs = new Date(graph.builtAt).getTime()
  const ageMs = Date.now() - builtAtMs

  return ageMs > GRAPH_FRESHNESS_MS
}

// ── Generate All Graphs (#524) ────────────────────────────────────────────

export interface GenerateAllResult {
  total: number
  graphsBuilt: number
  motionsGenerated: number
  errors: Array<{ customer: string; error: string }>
  durationMs: number
}

export interface GenerateAllOptions {
  customers: Array<{ name: string; slug?: string }>
  getExpansionMotion: (slug: string, name: string, deps: ExpansionMotionDeps) => Promise<StrategicMotion | null>
  deps: ExpansionMotionDeps
}

export async function generateAllGraphs(opts: GenerateAllOptions): Promise<GenerateAllResult> {
  const start = Date.now()
  const { customers: customerList, getExpansionMotion: getMotion, deps } = opts
  const CONCURRENCY = 4

  let graphsBuilt = 0
  let motionsGenerated = 0
  const errors: Array<{ customer: string; error: string }> = []

  // Process in batches of CONCURRENCY
  for (let i = 0; i < customerList.length; i += CONCURRENCY) {
    const batch = customerList.slice(i, i + CONCURRENCY)
    const results = await Promise.allSettled(
      batch.map(async (customer) => {
        const slug = customer.slug ?? customer.name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '')
        const motion = await getMotion(slug, customer.name, deps)
        return { customer: customer.name, motion }
      })
    )

    for (const result of results) {
      if (result.status === 'fulfilled') {
        graphsBuilt++
        if (result.value.motion) motionsGenerated++
      } else {
        errors.push({ customer: 'unknown', error: String(result.reason?.message ?? result.reason).slice(0, 300) })
      }
    }
  }

  return { total: customerList.length, graphsBuilt, motionsGenerated, errors, durationMs: Date.now() - start }
}
