/**
 * src/lib/graph-context.ts
 * Serializes a CustomerGraph into structured text context for Gemini enhanced inference.
 *
 * GitHub Issue #613 — Deeper Gemini inference
 *
 * Produces a token-efficient, structured text dump of all active nodes
 * and edges in the graph, grouped by type. Designed to give Gemini
 * full visibility into the intelligence graph for discovering non-obvious
 * signal connections.
 *
 * Dependencies:
 *   - intelligence-graph-types.ts — CustomerGraph, IntelligenceNode
 */

import type { CustomerGraph, IntelligenceNode, IntelligenceEdge } from './intelligence-graph-types.ts'

/** Max output length in characters (~8000 tokens) */
const MAX_CHARS = 32_000

/**
 * Properties worth including for each node type.
 * Only listed properties are serialized to keep output token-efficient.
 */
const TYPE_PROPERTIES: Record<string, string[]> = {
  subscription: ['product', 'productDescription', 'endDate', 'urgency', 'status', 'sku'],
  case: ['product', 'severity', 'status', 'summary'],
  deal: ['amount', 'stage', 'closeDate', 'product'],
  play: ['productAlignment', 'domain', 'summary'],
  program: ['programType', 'cloudPartner', 'provider', 'acvPlus'],
  product: ['techName', 'isRedHat', 'domain'],
  engagement: ['channel', 'summary', 'participants'],
  intel: ['intelType', 'competitor', 'summary', 'domain'],
  lifecycle: ['product', 'eolDate', 'version'],
  event: ['eventType', 'date', 'summary'],
  evidence: ['summary', 'domain', 'source'],
  partner: ['partnerType', 'domain', 'certifications'],
  initiative: ['summary', 'domain', 'status'],
  motion: ['summary', 'status'],
  person: ['title', 'role', 'email'],
  persona: ['role', 'department'],
}

/**
 * Format age of a timestamp as a short recency string.
 */
function formatAge(isoTimestamp: string): string {
  const ageMs = Date.now() - new Date(isoTimestamp).getTime()
  const hours = ageMs / (1000 * 60 * 60)
  if (hours < 1) return '<1h ago'
  if (hours < 24) return `${Math.round(hours)}h ago`
  const days = Math.round(hours / 24)
  if (days <= 30) return `${days}d ago`
  return `${Math.round(days / 30)}mo ago`
}

/**
 * Serialize a node's key properties into a compact one-line representation.
 */
function serializeNodeProperties(node: IntelligenceNode): string {
  const propsToInclude = TYPE_PROPERTIES[node.type] ?? []
  const parts: string[] = []

  for (const key of propsToInclude) {
    const val = node.properties[key]
    if (val === undefined || val === null || val === '') continue
    if (Array.isArray(val)) {
      parts.push(`${key}=[${val.slice(0, 5).join(', ')}]`)
    } else {
      parts.push(`${key}=${String(val)}`)
    }
  }

  return parts.join(', ')
}

/**
 * Build a full graph context string for Gemini enhanced inference.
 *
 * Serializes all active nodes grouped by type, plus all edges with
 * their relation types, evidence, and recency. Excludes historical nodes.
 * Caps output at MAX_CHARS to stay within token budget.
 *
 * @param graph - The customer intelligence graph
 * @returns Structured text suitable for a Gemini prompt
 */
export function buildFullGraphContext(graph: CustomerGraph): string {
  const lines: string[] = []

  lines.push(`=== Intelligence Graph: ${graph.customerName} ===`)
  lines.push(`Built: ${graph.builtAt ? formatAge(graph.builtAt) : 'unknown'}`)
  lines.push('')

  // ── Group active nodes by type ────────────────────────────────────────────
  const activeNodes = Object.values(graph.nodes).filter(
    n => n.history?.status !== 'historical'
  )

  const byType = new Map<string, IntelligenceNode[]>()
  for (const node of activeNodes) {
    if (node.type === 'customer') continue // Skip the root customer node from listing
    const list = byType.get(node.type) ?? []
    list.push(node)
    byType.set(node.type, list)
  }

  // Add customer name as context header
  const customerNode = activeNodes.find(n => n.type === 'customer')
  if (customerNode) {
    lines.push(`Customer: ${customerNode.name}`)
    lines.push('')
  }

  // ── Serialize nodes by type ───────────────────────────────────────────────
  lines.push('--- NODES ---')
  for (const [type, nodes] of byType) {
    lines.push(`[${type}] (${nodes.length})`)
    for (const node of nodes) {
      const props = serializeNodeProperties(node)
      const age = formatAge(node.updatedAt)
      const propsStr = props ? ` | ${props}` : ''
      lines.push(`  - ${node.name}${propsStr} (updated ${age})`)
    }
    lines.push('')
  }

  // ── Serialize edges ───────────────────────────────────────────────────────
  // Only include edges connecting active nodes
  const activeNodeIds = new Set(activeNodes.map(n => n.id))
  const activeEdges = graph.edges.filter(
    e => activeNodeIds.has(e.from) && activeNodeIds.has(e.to)
  )

  if (activeEdges.length > 0) {
    lines.push('--- RELATIONSHIPS ---')
    for (const edge of activeEdges) {
      const fromNode = graph.nodes[edge.from]
      const toNode = graph.nodes[edge.to]
      if (!fromNode || !toNode) continue

      const fromLabel = `${fromNode.type}:${fromNode.name}`
      const toLabel = `${toNode.type}:${toNode.name}`
      const age = formatAge(edge.createdAt)
      const evidenceStr = edge.evidence.length > 0
        ? ` [${edge.evidence.slice(0, 2).join('; ')}]`
        : ''

      lines.push(`  ${fromLabel} --[${edge.relation}]--> ${toLabel} (str=${edge.strength}, ${edge.tier}, ${age})${evidenceStr}`)
    }
    lines.push('')
  }

  // ── Signal density summary ────────────────────────────────────────────────
  const nodeTypes = new Set(activeNodes.map(n => n.type).filter(t => t !== 'customer'))
  lines.push(`Signal density: ${nodeTypes.size} types, ${activeNodes.length - (customerNode ? 1 : 0)} active nodes, ${activeEdges.length} edges`)

  // ── Cap at MAX_CHARS ──────────────────────────────────────────────────────
  let output = lines.join('\n')
  if (output.length > MAX_CHARS) {
    output = output.slice(0, MAX_CHARS - 50) + '\n\n[...truncated for token budget]'
  }

  return output
}
