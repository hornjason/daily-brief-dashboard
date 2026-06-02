/**
 * src/lib/intelligence-graph.ts
 * Intelligence Graph Engine — the "deep module" with narrow interface, rich internal logic.
 *
 * GitHub Issue #511 — Intelligence Graph: types + engine + unit tests
 * References: ADR-032, PAI KnowledgeGraph.ts + GraphBuilder.ts (pattern sources)
 *
 * Builds a customer intelligence property graph from flat Signal[] data.
 * The Customer node is always the hub — all other nodes connect to it.
 *
 * Signal-to-node mapping:
 *   subscriptions → Subscription node
 *   cases         → Case node
 *   ccsp          → Program node (cloud spend)
 *   tech-stack    → Product node (isRedHat: false)
 *   pipeline      → Deal node
 *   solution-intelligence → MATCHES_PLAY derived edges
 *   cloud-marketplace     → Program node
 *   ecosystem-catalog     → Program node (partner type)
 *   intelligence          → Customer node enrichment metadata
 *   Other sources         → skipped
 */

import { existsSync, readFileSync } from 'fs'
import { resolve } from 'path'
import type { Signal } from '../feature-module-registry.ts'
import type {
  CustomerGraph,
  IntelligenceNode,
  IntelligenceEdge,
  MotionHistoryEntry,
} from './intelligence-graph-types.ts'
import { computeContentHash, bfsTraverse, rankByEdgeStrength } from './graph-utils.ts'
import { writeJsonAtomic } from './atomic-write.ts'

// ── Constants ─────────────────────────────────────────────────────────────────

const GRAPH_VERSION = '1.0'
const MAX_GRAPH_SIZE_BYTES = 200 * 1024 // 200KB ceiling (50KB was too small for customers with 100+ signals)

// ── Helpers ───────────────────────────────────────────────────────────────────

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}

function makeNodeId(type: string, identifier: string): string {
  return `${type}:${slugify(identifier)}`
}

function nowIso(): string {
  return new Date().toISOString()
}

// ── Signal-to-Node Mapping ────────────────────────────────────────────────────

function signalToNode(signal: Signal): IntelligenceNode | null {
  const m = signal.metadata ?? {}
  const hash = computeContentHash(JSON.stringify(signal))
  const ts = nowIso()

  switch (signal.source) {
    case 'subscriptions': {
      const desc = String(m.productDescription ?? m.product ?? signal.headline)
      return {
        id: makeNodeId('subscription', desc),
        type: 'subscription',
        name: desc,
        properties: {
          sku: m.sku,
          quantity: m.quantity,
          status: m.status ?? m.urgency,
          urgency: m.urgency,
          startDate: m.startDate,
          endDate: m.endDate,
          productDescription: m.productDescription ?? m.product,
          url: signal.url,
        },
        sourceModule: signal.source,
        contentHash: hash,
        updatedAt: ts,
      }
    }

    case 'cases': {
      const caseNum = String(m.caseNumber ?? 'unknown')
      return {
        id: makeNodeId('case', caseNum),
        type: 'case',
        name: signal.headline,
        properties: {
          caseNumber: m.caseNumber,
          severity: m.severity,
          status: m.status,
          product: m.product,
          url: signal.url,
        },
        sourceModule: signal.source,
        contentHash: hash,
        updatedAt: ts,
      }
    }

    case 'ccsp': {
      const partner = String(m.cloudPartner ?? 'unknown')
      return {
        id: makeNodeId('program', `ccsp-${partner}`),
        type: 'program',
        name: `CCSP: ${partner}`,
        properties: {
          cloudPartner: m.cloudPartner,
          acvPlus: m.acvPlus,
          programType: 'cloud-spend',
          url: signal.url,
        },
        sourceModule: signal.source,
        contentHash: hash,
        updatedAt: ts,
      }
    }

    case 'tech-stack': {
      const techName = String(m.techName ?? signal.headline)
      return {
        id: makeNodeId('product', techName),
        type: 'product',
        name: techName,
        properties: {
          techName: m.techName,
          category: m.category,
          context: m.context,
          isRedHat: false,
        },
        sourceModule: signal.source,
        contentHash: hash,
        updatedAt: ts,
      }
    }

    case 'pipeline': {
      const opp = String(m.opportunityName ?? signal.headline)
      return {
        id: makeNodeId('deal', opp),
        type: 'deal',
        name: opp,
        properties: {
          stage: m.stage,
          amount: m.amount,
          closeDate: m.closeDate,
        },
        sourceModule: signal.source,
        contentHash: hash,
        updatedAt: ts,
      }
    }

    case 'cloud-marketplace': {
      const provider = String(m.provider ?? 'unknown')
      return {
        id: makeNodeId('program', `marketplace-${provider}`),
        type: 'program',
        name: `Marketplace: ${provider}`,
        properties: {
          provider: m.provider,
          offeringCount: m.offeringCount,
          programCount: m.programCount,
          programType: 'marketplace',
        },
        sourceModule: signal.source,
        contentHash: hash,
        updatedAt: ts,
      }
    }

    case 'ecosystem-catalog': {
      const partnerName = String(m.partnerName ?? signal.headline)
      return {
        id: makeNodeId('program', `ecosystem-${partnerName}`),
        type: 'program',
        name: `Ecosystem: ${partnerName}`,
        properties: {
          partnerName: m.partnerName,
          partnerType: m.partnerType,
          programType: 'ecosystem',
        },
        sourceModule: signal.source,
        contentHash: hash,
        updatedAt: ts,
      }
    }

    case 'solution-intelligence':
      // Does not create a node — creates derived edges instead
      return null

    case 'intelligence':
      // Enriches the Customer node — handled separately
      return null

    default:
      // Other sources are skipped
      return null
  }
}

// ── Edge Creation ─────────────────────────────────────────────────────────────

function createFactualEdge(
  customerNodeId: string,
  node: IntelligenceNode,
  signal: Signal,
): IntelligenceEdge {
  const relationMap: Record<string, string> = {
    subscription: 'HAS_SUBSCRIPTION',
    case: 'HAS_CASE',
    product: 'USES_PRODUCT',
    deal: 'HAS_DEAL',
    program: 'PARTICIPATES_IN',
  }

  return {
    from: customerNodeId,
    to: node.id,
    relation: relationMap[node.type] ?? 'RELATED_TO',
    tier: 'factual',
    strength: signal.score ?? signal.rawRelevance ?? 0.5,
    evidence: [signal.headline],
    sourceUrl: signal.url,
    scoredAt: nowIso(),
  }
}

function createDerivedEdges(
  customerNodeId: string,
  signal: Signal,
  existingNodes: Record<string, IntelligenceNode>,
): IntelligenceEdge[] {
  const edges: IntelligenceEdge[] = []
  const m = signal.metadata ?? {}

  if (signal.source === 'solution-intelligence') {
    const solutionName = String(m.solutionName ?? signal.headline)
    const playNodeId = makeNodeId('play', solutionName)

    // Create the play node if it doesn't exist (side effect)
    if (!existingNodes[playNodeId]) {
      existingNodes[playNodeId] = {
        id: playNodeId,
        type: 'play',
        name: solutionName,
        properties: {
          productAlignment: m.productAlignment,
          matchedTechnologies: m.matchedTechnologies,
          url: signal.url,
        },
        sourceModule: signal.source,
        contentHash: computeContentHash(JSON.stringify(signal)),
        updatedAt: nowIso(),
      }
    }

    // Customer → Play edge
    edges.push({
      from: customerNodeId,
      to: playNodeId,
      relation: 'MATCHES_PLAY',
      tier: 'derived',
      strength: signal.score ?? signal.rawRelevance ?? 0.7,
      evidence: [signal.headline],
      sourceUrl: signal.url,
      scoredAt: nowIso(),
    })

    // If matched technologies reference existing product nodes, link play → product
    const matchedTechs = (m.matchedTechnologies as string[]) ?? []
    for (const tech of matchedTechs) {
      const productNodeId = makeNodeId('product', tech)
      if (existingNodes[productNodeId]) {
        edges.push({
          from: playNodeId,
          to: productNodeId,
          relation: 'TARGETS_PRODUCT',
          tier: 'derived',
          strength: 0.8,
          evidence: [signal.headline],
          sourceUrl: signal.url,
          scoredAt: nowIso(),
        })
      }
    }
  }

  return edges
}

// ── Build ─────────────────────────────────────────────────────────────────────

/**
 * Build a complete customer intelligence graph from flat Signal[] data.
 *
 * The Customer node is always created as the hub.
 * Signal sources map to node types per the mapping table in this module's header.
 * Content-hash caching: if a signal hasn't changed (same hash), reuse existing node.
 */
export function buildCustomerGraph(
  customerSlug: string,
  customerName: string,
  signals: Signal[],
  existingGraph?: CustomerGraph | null,
): CustomerGraph {
  const ts = nowIso()
  const customerNodeId = makeNodeId('customer', customerSlug)

  // Build existing hash lookup for cache reuse
  const existingHashes = new Map<string, IntelligenceNode>()
  if (existingGraph) {
    for (const node of Object.values(existingGraph.nodes)) {
      existingHashes.set(`${node.id}:${node.contentHash}`, node)
    }
  }

  // Customer node is always the hub
  const nodes: Record<string, IntelligenceNode> = {
    [customerNodeId]: {
      id: customerNodeId,
      type: 'customer',
      name: customerName,
      properties: {},
      sourceModule: 'intelligence-graph',
      contentHash: computeContentHash(customerSlug),
      updatedAt: ts,
    },
  }

  const edges: IntelligenceEdge[] = []

  // Process signals: create nodes and factual edges
  for (const signal of signals) {
    // Enrich customer node with intelligence metadata
    if (signal.source === 'intelligence') {
      const m = signal.metadata ?? {}
      Object.assign(nodes[customerNodeId].properties, m)
      continue
    }

    const node = signalToNode(signal)
    if (node) {
      // Content-hash caching: reuse existing node if hash matches
      const cacheKey = `${node.id}:${node.contentHash}`
      const cached = existingHashes.get(cacheKey)
      if (cached) {
        nodes[node.id] = cached
      } else {
        nodes[node.id] = node
      }

      // Create factual edge from customer → node
      edges.push(createFactualEdge(customerNodeId, node, signal))
    }

    // Create derived edges (e.g., solution-intelligence → MATCHES_PLAY)
    const derivedEdges = createDerivedEdges(customerNodeId, signal, nodes)
    edges.push(...derivedEdges)
  }

  const graph: CustomerGraph = {
    customerId: customerSlug,
    customerName,
    version: GRAPH_VERSION,
    builtAt: ts,
    nodeCount: Object.keys(nodes).length,
    edgeCount: edges.length,
    nodes,
    edges,
  }

  return graph
}

// ── Persist / Load ────────────────────────────────────────────────────────────

/**
 * Persist graph to {dataDir}/{customerSlug}/intelligence-graph.json.
 * Enforces <50KB ceiling — throws if exceeded.
 * Uses writeJsonAtomic for crash-safe writes.
 */
export function persistGraph(graph: CustomerGraph, dataDir: string): void {
  if (/[^a-zA-Z0-9_-]/.test(graph.customerId)) {
    throw new Error(`[intelligence-graph] unsafe customerId: ${graph.customerId}`)
  }
  const json = JSON.stringify(graph, null, 2)

  if (Buffer.byteLength(json, 'utf-8') > MAX_GRAPH_SIZE_BYTES) {
    throw new Error(
      `Intelligence graph for ${graph.customerId} exceeds 50KB ceiling ` +
      `(${Buffer.byteLength(json, 'utf-8')} bytes). ` +
      `Reduce node/edge count or prune stale data.`,
    )
  }

  const filePath = resolve(dataDir, graph.customerId, 'intelligence-graph.json')
  writeJsonAtomic(filePath, graph)
}

/**
 * Load persisted graph. Returns null if file doesn't exist.
 */
export function loadGraph(
  customerSlug: string,
  dataDir: string,
): CustomerGraph | null {
  if (/[^a-zA-Z0-9_-]/.test(customerSlug)) {
    throw new Error(`[intelligence-graph] unsafe customerSlug: ${customerSlug}`)
  }
  const filePath = resolve(dataDir, customerSlug, 'intelligence-graph.json')

  if (!existsSync(filePath)) {
    return null
  }

  try {
    const raw = readFileSync(filePath, 'utf-8')
    return JSON.parse(raw) as CustomerGraph
  } catch {
    return null
  }
}

// ── History & Staleness (#522) ────────────────────────────────────────────

const HISTORY_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000 // 90 days

/**
 * Merge previous motion history into a rebuilt graph.
 * Preserves dismissed/pinned status from the previous cycle.
 * Updates lastSeenAt for entries that still exist; carries forward
 * all others unchanged.
 *
 * Returns the graph with the merged history array set.
 */
export function mergeHistory(
  graph: CustomerGraph,
  previousHistory: MotionHistoryEntry[],
): CustomerGraph {
  const ts = nowIso()
  const merged = new Map<string, MotionHistoryEntry>()

  // Carry forward all previous entries
  for (const entry of previousHistory) {
    merged.set(entry.motionId, { ...entry, lastSeenAt: ts })
  }

  // Prune before attaching
  const prunedHistory = pruneHistory([...merged.values()])
  graph.history = prunedHistory

  return graph
}

/**
 * Remove history entries older than 90 days (based on firstSeenAt).
 * Keeps the graph file under the 50KB ceiling.
 */
export function pruneHistory(history: MotionHistoryEntry[]): MotionHistoryEntry[] {
  const cutoff = Date.now() - HISTORY_MAX_AGE_MS
  return history.filter(entry => new Date(entry.firstSeenAt).getTime() > cutoff)
}

/**
 * Filter out stale derived edges from a graph.
 *
 * A derived edge is stale when its scoredAt timestamp is older than the
 * updatedAt of any source node referenced in its evidence[] array or
 * connected via from/to.
 *
 * Only filters derived edges; factual edges pass through unchanged.
 */
export function filterStaleEdges(graph: CustomerGraph): IntelligenceEdge[] {
  return graph.edges.filter(edge => {
    // Only check derived edges for staleness
    if (edge.tier === 'factual') return true

    const scoredAtMs = new Date(edge.scoredAt).getTime()

    // Check if either endpoint node has been updated after the edge was scored
    const fromNode = graph.nodes[edge.from]
    const toNode = graph.nodes[edge.to]

    if (fromNode) {
      const fromUpdatedMs = new Date(fromNode.updatedAt).getTime()
      if (fromUpdatedMs > scoredAtMs) return false
    }

    if (toNode) {
      const toUpdatedMs = new Date(toNode.updatedAt).getTime()
      if (toUpdatedMs > scoredAtMs) return false
    }

    return true
  })
}

// ── Query ─────────────────────────────────────────────────────────────────────

/**
 * Start at customer node, BFS 2-3 hops, return Play nodes ranked by
 * converging edge strength.
 *
 * A play with 3 signals pointing at it ranks higher than one with 1 signal.
 */
export function queryPlays(graph: CustomerGraph): IntelligenceNode[] {
  const customerNodeId = Object.values(graph.nodes).find(
    n => n.type === 'customer',
  )?.id

  if (!customerNodeId) return []

  // BFS 3 hops from customer to find all reachable nodes
  const reachable = bfsTraverse(graph, customerNodeId, 3)

  // Filter to play nodes only
  const plays = reachable.filter(n => n.type === 'play')

  if (plays.length === 0) return []

  // Rank by converging edge strength (sum of all edges touching each play)
  return rankByEdgeStrength(plays, graph.edges)
}
