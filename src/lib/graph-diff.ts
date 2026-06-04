/**
 * src/lib/graph-diff.ts
 * Temporal diff narrative — surfaces "what changed since last rebuild" per customer.
 *
 * GitHub Issue #603 — Temporal diff narrative
 * Depends on: #601 (temporal signal persistence — history.appeared/lastSeen/status)
 *
 * Reads node history fields to produce human-readable change descriptions:
 * - New nodes: history.status === 'active' AND appeared after previousGraph.builtAt
 * - Disappeared nodes: history.status === 'historical'
 * - Reactivated nodes: was historical in previousGraph, now active in currentGraph
 */

import type { CustomerGraph, IntelligenceNode, IntelligenceNodeType } from './intelligence-graph-types.ts'

// ── Types ─────────────────────────────────────────────────────────────────────

export interface GraphDiffChange {
  /** What happened: new signal appeared, one disappeared, or one came back */
  changeType: 'new' | 'disappeared' | 'reactivated'
  /** Node type (subscription, case, product, etc.) */
  nodeType: IntelligenceNodeType
  /** Human-readable node name */
  nodeName: string
  /** Node ID */
  nodeId: string
  /** Human-readable description of the change */
  description: string
  /** ISO timestamp of when the change was detected */
  timestamp: string
}

export interface GraphDiff {
  /** Customer identifier */
  customerSlug: string
  /** ISO timestamp of the current graph build */
  currentBuiltAt: string
  /** ISO timestamp of the previous graph build (if known) */
  previousBuiltAt?: string
  /** Ordered list of changes (new first, then reactivated, then disappeared) */
  changes: GraphDiffChange[]
  /** Human-readable summary of all changes */
  summary: string
}

// ── Human-readable labels ───────────────────────────────────────────────────

const NODE_TYPE_LABELS: Record<string, string> = {
  subscription: 'Subscription',
  case: 'Support Case',
  product: 'Technology',
  deal: 'Pipeline Opportunity',
  program: 'Program',
  play: 'Solution Play',
  engagement: 'Engagement',
  intel: 'Intelligence',
  lifecycle: 'Product Lifecycle',
  event: 'Event',
  evidence: 'Evidence',
  partner: 'Partner',
  person: 'Person',
  persona: 'Persona',
  initiative: 'Initiative',
  motion: 'Motion',
}

function nodeTypeLabel(type: string): string {
  return NODE_TYPE_LABELS[type] ?? type
}

// ── Description builders ────────────────────────────────────────────────────

function describeNew(node: IntelligenceNode): string {
  const label = nodeTypeLabel(node.type)
  return `New ${label.toLowerCase()} appeared: ${node.name}`
}

function describeDisappeared(node: IntelligenceNode): string {
  const label = nodeTypeLabel(node.type)
  return `${label} no longer active: ${node.name}`
}

function describeReactivated(node: IntelligenceNode): string {
  const label = nodeTypeLabel(node.type)
  return `${label} reappeared: ${node.name}`
}

// ── Sort order ──────────────────────────────────────────────────────────────

const CHANGE_TYPE_ORDER: Record<string, number> = {
  new: 0,
  reactivated: 1,
  disappeared: 2,
}

// ── Main function ───────────────────────────────────────────────────────────

/**
 * Compute a temporal diff for a customer intelligence graph.
 *
 * @param currentGraph - The current customer graph (must have history fields from #601)
 * @param previousGraph - The previous graph for comparison. If not provided,
 *   all non-customer nodes are treated as "new". If provided, enables
 *   reactivation detection (historical -> active).
 * @returns GraphDiff with ordered changes and a summary string
 */
export function computeGraphDiff(
  currentGraph: CustomerGraph,
  previousGraph?: CustomerGraph | null,
): GraphDiff {
  const changes: GraphDiffChange[] = []
  const previousBuiltAt = previousGraph?.builtAt
  const previousTs = previousBuiltAt ? new Date(previousBuiltAt).getTime() : 0

  for (const node of Object.values(currentGraph.nodes)) {
    // Skip customer hub node — it's always present
    if (node.type === 'customer') continue

    const history = node.history
    if (!history) continue

    const appearedTs = new Date(history.appeared).getTime()

    if (history.status === 'historical') {
      // Node disappeared from the signal feed — only report if it was
      // active in the previous graph (i.e., it disappeared in THIS rebuild)
      if (!previousGraph) {
        // No previous graph — can't tell when it disappeared, skip
        continue
      }
      const prevNode = previousGraph.nodes[node.id]
      if (prevNode?.history?.status === 'active' || !prevNode?.history) {
        // Was active (or had no history = legacy active) in previous graph, now historical
        changes.push({
          changeType: 'disappeared',
          nodeType: node.type,
          nodeName: node.name,
          nodeId: node.id,
          description: describeDisappeared(node),
          timestamp: history.lastSeen,
        })
      }
      // If it was already historical in the previous graph, don't re-report
    } else if (history.status === 'active') {
      if (!previousGraph) {
        // No previous graph — everything is new
        changes.push({
          changeType: 'new',
          nodeType: node.type,
          nodeName: node.name,
          nodeId: node.id,
          description: describeNew(node),
          timestamp: history.appeared,
        })
      } else {
        const prevNode = previousGraph.nodes[node.id]

        if (!prevNode) {
          // Node didn't exist in the previous graph at all — it's new
          changes.push({
            changeType: 'new',
            nodeType: node.type,
            nodeName: node.name,
            nodeId: node.id,
            description: describeNew(node),
            timestamp: history.appeared,
          })
        } else if (prevNode.history?.status === 'historical') {
          // Node was historical in previous graph, now active — reactivated
          changes.push({
            changeType: 'reactivated',
            nodeType: node.type,
            nodeName: node.name,
            nodeId: node.id,
            description: describeReactivated(node),
            timestamp: history.lastSeen,
          })
        }
        // If node was active in previous graph and still active — no change
      }
    }
  }

  // Sort: new first, then reactivated, then disappeared
  changes.sort((a, b) => (CHANGE_TYPE_ORDER[a.changeType] ?? 3) - (CHANGE_TYPE_ORDER[b.changeType] ?? 3))

  // Build summary
  const newCount = changes.filter(c => c.changeType === 'new').length
  const disappearedCount = changes.filter(c => c.changeType === 'disappeared').length
  const reactivatedCount = changes.filter(c => c.changeType === 'reactivated').length

  const parts: string[] = []
  if (newCount > 0) parts.push(`${newCount} new signal${newCount === 1 ? '' : 's'}`)
  if (reactivatedCount > 0) parts.push(`${reactivatedCount} reappeared`)
  if (disappearedCount > 0) parts.push(`${disappearedCount} went inactive`)

  const summary = parts.length > 0
    ? `Since last rebuild: ${parts.join(', ')}`
    : 'No changes since last rebuild'

  return {
    customerSlug: currentGraph.customerId,
    currentBuiltAt: currentGraph.builtAt,
    previousBuiltAt,
    changes,
    summary,
  }
}
