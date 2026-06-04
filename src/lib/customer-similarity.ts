/**
 * src/lib/customer-similarity.ts
 * Cross-customer pattern detection — computes similarity from intelligence graph node overlap.
 *
 * GitHub Issue #612 — Cross-Customer Pattern Detection
 *
 * Compares customer intelligence graphs by examining shared nodes (products,
 * case patterns, partners, plays, programs) and computing a normalized
 * overlap score. Excludes the customer hub node from comparison.
 *
 * Node types considered for similarity:
 *   - product (shared subscriptions/products)
 *   - case (shared severity levels, product categories)
 *   - partner (shared partner ecosystem)
 *   - play (shared play/program alignment)
 *   - program (shared cloud spend programs)
 *   - subscription (shared subscription types)
 *
 * Historical nodes (history.status === 'historical') are excluded from comparison.
 */

import type { CustomerGraph, IntelligenceNode } from './intelligence-graph-types.ts'

// ── Types ───────────────────────────────────────────────────────────────────

export interface CustomerSimilarity {
  slug: string
  name: string
  overlapScore: number  // 0.0-1.0
  sharedProducts: string[]
  sharedCasePatterns: string[]
  sharedNodeTypes: string[]
  totalSharedNodes: number
}

// ── Constants ───────────────────────────────────────────────────────────────

/** Node types to compare for similarity. Customer node is always excluded. */
const COMPARABLE_TYPES = new Set([
  'product', 'case', 'partner', 'play', 'program', 'subscription',
])

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Extract the set of comparable node IDs from a graph,
 * excluding the customer hub node and historical nodes.
 */
function getComparableNodeIds(graph: CustomerGraph): Set<string> {
  const ids = new Set<string>()
  for (const node of Object.values(graph.nodes)) {
    if (node.type === 'customer') continue
    if (node.history?.status === 'historical') continue
    if (!COMPARABLE_TYPES.has(node.type)) continue
    ids.add(node.id)
  }
  return ids
}

/**
 * Get comparable nodes as a map for detail extraction.
 */
function getComparableNodes(graph: CustomerGraph): Map<string, IntelligenceNode> {
  const map = new Map<string, IntelligenceNode>()
  for (const node of Object.values(graph.nodes)) {
    if (node.type === 'customer') continue
    if (node.history?.status === 'historical') continue
    if (!COMPARABLE_TYPES.has(node.type)) continue
    map.set(node.id, node)
  }
  return map
}

// ── Core Functions ──────────────────────────────────────────────────────────

/**
 * Compute similarity between two customer graphs based on node overlap.
 *
 * Uses Jaccard similarity: |A intersection B| / |A union B|
 * Only considers comparable node types (products, cases, partners, plays, programs).
 * Excludes customer hub nodes and historical nodes.
 *
 * @returns 0.0-1.0 similarity score
 */
export function computeSimilarity(graphA: CustomerGraph, graphB: CustomerGraph): number {
  const nodesA = getComparableNodeIds(graphA)
  const nodesB = getComparableNodeIds(graphB)

  if (nodesA.size === 0 || nodesB.size === 0) return 0

  // Compute intersection
  let intersectionCount = 0
  for (const id of nodesA) {
    if (nodesB.has(id)) intersectionCount++
  }

  if (intersectionCount === 0) return 0

  // Jaccard similarity: |A ∩ B| / |A ∪ B|
  const unionCount = nodesA.size + nodesB.size - intersectionCount
  return intersectionCount / unionCount
}

/**
 * Get top N similar customers for a given target customer.
 *
 * Iterates all customer graphs, computes similarity with the target,
 * and returns the top matches sorted by overlap score descending.
 * Excludes customers with zero overlap.
 *
 * @param targetSlug - The customer slug to find similar customers for
 * @param allGraphs - Map of all customer graphs keyed by slug
 * @param topN - Maximum number of results to return (default 5)
 */
export function getSimilarCustomers(
  targetSlug: string,
  allGraphs: Map<string, CustomerGraph>,
  topN: number = 5,
): CustomerSimilarity[] {
  const targetGraph = allGraphs.get(targetSlug)
  if (!targetGraph) return []

  const targetNodes = getComparableNodes(targetGraph)
  if (targetNodes.size === 0) return []

  const results: CustomerSimilarity[] = []

  for (const [slug, graph] of allGraphs) {
    // Skip the target customer itself
    if (slug === targetSlug) continue

    const score = computeSimilarity(targetGraph, graph)
    if (score === 0) continue

    // Compute detailed overlap information
    const otherNodes = getComparableNodes(graph)
    const sharedProducts: string[] = []
    const sharedCasePatterns: string[] = []
    const sharedNodeTypesSet = new Set<string>()
    let totalSharedNodes = 0

    for (const [nodeId, node] of targetNodes) {
      if (otherNodes.has(nodeId)) {
        totalSharedNodes++
        sharedNodeTypesSet.add(node.type)

        if (node.type === 'product' || node.type === 'subscription') {
          sharedProducts.push(node.name)
        }

        if (node.type === 'case') {
          const severity = node.properties.severity
          const product = node.properties.product
          const pattern = severity
            ? `Sev ${severity}${product ? ` - ${product}` : ''}`
            : node.name
          sharedCasePatterns.push(pattern)
        }
      }
    }

    results.push({
      slug,
      name: graph.customerName,
      overlapScore: Math.round(score * 1000) / 1000, // 3 decimal precision
      sharedProducts: [...new Set(sharedProducts)],
      sharedCasePatterns: [...new Set(sharedCasePatterns)],
      sharedNodeTypes: [...sharedNodeTypesSet],
      totalSharedNodes,
    })
  }

  // Sort by overlap score descending
  results.sort((a, b) => b.overlapScore - a.overlapScore)

  return results.slice(0, topN)
}
