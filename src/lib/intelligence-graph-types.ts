/**
 * src/lib/intelligence-graph-types.ts
 * Type definitions for the customer intelligence property graph.
 *
 * GitHub Issue #511 — Intelligence Graph: types + engine + unit tests
 * References: ADR-032, PAI KnowledgeGraph.ts (pattern source)
 *
 * The intelligence graph represents a customer's complete signal profile
 * as a property graph: nodes are entities (subscriptions, cases, products,
 * deals, plays, programs) and edges are relationships between them.
 * The Customer node is always the hub.
 */

// ── Node Types ────────────────────────────────────────────────────────────────

/**
 * 11 node types as a discriminated union.
 * Each maps to a signal source or derived concept.
 */
export type IntelligenceNodeType =
  | 'customer'
  | 'person'
  | 'persona'
  | 'product'
  | 'case'
  | 'subscription'
  | 'deal'
  | 'play'
  | 'program'
  | 'initiative'
  | 'motion'
  | 'engagement'
  | 'intel'
  | 'lifecycle'
  | 'event'
  | 'evidence'
  | 'partner'

// ── Node ──────────────────────────────────────────────────────────────────────

export interface IntelligenceNode {
  /** Unique identifier: "{type}:{slug}" e.g. "subscription:rh00003" */
  id: string
  /** Node type from the discriminated union */
  type: IntelligenceNodeType
  /** Human-readable name */
  name: string
  /** Type-specific data (sku, quantity, severity, stage, etc.) */
  properties: Record<string, unknown>
  /** Which module created this node */
  sourceModule: string
  /** MD5(8 chars) for incremental rebuild — same pattern as PAI GraphBuilder */
  contentHash: string
  /** ISO timestamp of last update */
  updatedAt: string
}

// ── Edge ──────────────────────────────────────────────────────────────────────

export interface IntelligenceEdge {
  /** Source node id */
  from: string
  /** Target node id */
  to: string
  /** Relationship label: USES_PRODUCT, HAS_CASE, MATCHES_PLAY, etc. */
  relation: string
  /** Whether this edge is from raw data or derived from cross-referencing */
  tier: 'factual' | 'derived'
  /** Confidence/relevance 0.0-1.0 */
  strength: number
  /** Signal IDs (headlines or source identifiers) that created this edge */
  evidence: string[]
  /** Clickable link to source artifact */
  sourceUrl?: string
  /** ISO timestamp — for staleness protection */
  scoredAt: string
  /** ISO timestamp of when the source signal was originally generated */
  createdAt: string
  /** Which signal module created this edge (e.g., 'subscriptions', 'cases') */
  sourceType: string
}

// ── Motion History ────────────────────────────────────────────────────────────

/**
 * Tracks a motion's lifecycle across graph rebuilds.
 * Preserves dismissed/pinned state so motions don't resurface after being
 * actioned by the user.
 */
export interface MotionHistoryEntry {
  /** Unique motion identifier */
  motionId: string
  /** Human-readable motion title */
  title: string
  /** Number of phases in the motion */
  phaseCount: number
  /** User-set status: active (default), dismissed (won't show), pinned (always show) */
  status: 'active' | 'dismissed' | 'pinned'
  /** ISO timestamp — when this motion was first generated */
  firstSeenAt: string
  /** ISO timestamp — most recent generation */
  lastSeenAt: string
}

// ── Customer Graph ────────────────────────────────────────────────────────────

export interface CustomerGraph {
  /** Slug identifier for the customer */
  customerId: string
  /** Human-readable customer name */
  customerName: string
  /** Schema version */
  version: string
  /** ISO timestamp of when the graph was built */
  builtAt: string
  /** Count of nodes (denormalized for quick access) */
  nodeCount: number
  /** Count of edges (denormalized for quick access) */
  edgeCount: number
  /** All nodes keyed by node id */
  nodes: Record<string, IntelligenceNode>
  /** All edges */
  edges: IntelligenceEdge[]
  /** Motion history — accumulated across graph rebuilds (#522) */
  history?: MotionHistoryEntry[]
}
