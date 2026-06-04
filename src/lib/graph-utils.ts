/**
 * src/lib/graph-utils.ts
 * Shared utility functions for the intelligence graph.
 *
 * GitHub Issue #511 — Intelligence Graph: types + engine + unit tests
 *
 * Focused utilities only — no business logic.
 * - computeContentHash: MD5 8-char hash (same as PAI GraphBuilder)
 * - bfsTraverse: breadth-first traversal within N hops
 * - findNodesByType: filter nodes by type
 * - getEdgesFrom / getEdgesTo: edge queries
 * - rankByEdgeStrength: sort nodes by connected edge strength
 */

import { createHash } from 'crypto'
import type {
  CustomerGraph,
  IntelligenceNode,
  IntelligenceNodeType,
  IntelligenceEdge,
} from './intelligence-graph-types.ts'

/**
 * Compute an 8-character MD5 hash of the input string.
 * Same pattern as PAI GraphBuilder.ts computeContentHash().
 */
export function computeContentHash(data: string): string {
  return createHash('md5').update(data).digest('hex').slice(0, 8)
}

/**
 * Breadth-first traversal from startNodeId, returning connected nodes within maxHops.
 * Returns nodes in BFS order (closest first). Does NOT include the start node.
 */
export function bfsTraverse(
  graph: CustomerGraph,
  startNodeId: string,
  maxHops: number,
): IntelligenceNode[] {
  const visited = new Set<string>([startNodeId])
  const result: IntelligenceNode[] = []
  let frontier = [startNodeId]

  for (let hop = 0; hop < maxHops && frontier.length > 0; hop++) {
    const nextFrontier: string[] = []

    for (const nodeId of frontier) {
      // Find all edges connected to this node (in either direction)
      for (const edge of graph.edges) {
        let neighbor: string | null = null
        if (edge.from === nodeId && !visited.has(edge.to)) {
          neighbor = edge.to
        } else if (edge.to === nodeId && !visited.has(edge.from)) {
          neighbor = edge.from
        }

        if (neighbor && graph.nodes[neighbor]) {
          visited.add(neighbor)
          nextFrontier.push(neighbor)
          result.push(graph.nodes[neighbor])
        }
      }
    }

    frontier = nextFrontier
  }

  return result
}

/**
 * Filter nodes by type.
 */
export function findNodesByType(
  graph: CustomerGraph,
  type: IntelligenceNodeType,
): IntelligenceNode[] {
  return Object.values(graph.nodes).filter(n => n.type === type)
}

/**
 * Filter nodes by type, excluding historical nodes (#601).
 * Use this in scoring/query logic that should only consider active signals.
 */
export function findActiveNodesByType(
  graph: CustomerGraph,
  type: IntelligenceNodeType,
): IntelligenceNode[] {
  return Object.values(graph.nodes).filter(
    n => n.type === type && n.history?.status !== 'historical',
  )
}

/**
 * All edges originating FROM a node.
 */
export function getEdgesFrom(
  graph: CustomerGraph,
  nodeId: string,
): IntelligenceEdge[] {
  return graph.edges.filter(e => e.from === nodeId)
}

/**
 * All edges pointing TO a node.
 */
export function getEdgesTo(
  graph: CustomerGraph,
  nodeId: string,
): IntelligenceEdge[] {
  return graph.edges.filter(e => e.to === nodeId)
}

/**
 * Exponential decay weight based on age.
 * Engagement signals (emails, meetings) should use 30-day half-life; others 90-day.
 * @param createdAt ISO timestamp
 * @param halfLifeDays Days until weight halves (default 90)
 * @returns Weight between 0.0 and 1.0
 */
export function recencyWeight(createdAt: string, halfLifeDays: number = 90): number {
  const ageMs = Date.now() - new Date(createdAt).getTime()
  const ageDays = ageMs / (1000 * 60 * 60 * 24)
  return Math.pow(0.5, ageDays / halfLifeDays)
}

/**
 * Sort nodes by the sum of connected edge strengths (descending).
 * Nodes with stronger/more connections rank higher.
 */
export function rankByEdgeStrength(
  nodes: IntelligenceNode[],
  edges: IntelligenceEdge[],
): IntelligenceNode[] {
  const strengthMap = new Map<string, number>()

  for (const node of nodes) {
    let total = 0
    for (const edge of edges) {
      if (edge.from === node.id || edge.to === node.id) {
        total += edge.strength
      }
    }
    strengthMap.set(node.id, total)
  }

  return [...nodes].sort(
    (a, b) => (strengthMap.get(b.id) ?? 0) - (strengthMap.get(a.id) ?? 0),
  )
}
