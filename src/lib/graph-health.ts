/**
 * src/lib/graph-health.ts
 * Pure computation functions for intelligence graph health auditing.
 *
 * GitHub Issue #875 — Intelligence Graph Health Audit
 *
 * Zero Gemini calls. Zero graph rebuilds. Read-only computation from cached data.
 * All functions are pure — they take a graph and return a report.
 */

import type {
  CustomerGraph,
  IntelligenceNodeType,
} from './intelligence-graph-types.ts'
import type { StrategicMotion } from './motion-builder.ts'

// ── By-design null sources (intentionally produce no nodes) ──────────────────

export const BY_DESIGN_NULL_SOURCES = new Set([
  'intelligence', 'account-plan', 'saleshub-plays', 'saleshub-tactics',
  'recommended-actions', 'playbook', 'SalesHub Content', 'solution-intelligence',
])

// ── Node type enumeration (all 17 from IntelligenceNodeType) ────────────────

const ALL_NODE_TYPES: IntelligenceNodeType[] = [
  'customer', 'person', 'persona', 'product', 'case', 'subscription',
  'deal', 'play', 'program', 'initiative', 'motion', 'engagement',
  'intel', 'lifecycle', 'event', 'evidence', 'partner',
]

// ── Report Types ────────────────────────────────────────────────────────────

export interface SignalSourceEntry {
  source: string
  nodeCount: number
  edgeCount: number
  lastSignalTimestamp: string | null
  isByDesign: boolean
}

export interface MotionCoverageInfo {
  domainCoverage: number      // percentage: TDP domains with evidence / active TDP domains
  signalBreadth: number       // count: distinct source types contributing evidence
  activeDomains: number       // how many TDP domains the customer has
  domainsWithEvidence: number // how many have >=1 evidence item
}

export interface CustomerHealthReport {
  customerSlug: string
  customerName: string
  builtAt: string
  freshnessMs: number
  freshnessBadge: 'green' | 'yellow' | 'red'
  nodeCountByType: Record<string, number>
  edgeCountByRelation: Record<string, number>
  totalNodes: number
  totalEdges: number
  disconnectedNodeCount: number
  staleEdgeCount: number
  /** Context note for stale edges — explains they are filtered at query time (#877) */
  staleEdgeNote: string
  signalSourceCoverage: SignalSourceEntry[]
  coverageFraction: string
  isThinGraph: boolean
  motionCoverage: MotionCoverageInfo | null
  /** Who triggered the last graph rebuild (#877) */
  lastRebuiltBy: string
  /** Signal yield: finalEvidenceCount / signalsIngested as percentage (#886) */
  signalYield: number | null
}

export interface GraphHealthAlert {
  type: 'staleness' | 'persist_error' | 'scheduler_stall' | 'evidence_regression'
  message: string
  severity: 'critical' | 'warning'
  count: number
}

export interface PortfolioHealthReport {
  customers: CustomerHealthReport[]
  medianNodeCount: number
  medianEdgeCount: number
  customersWithFreshGraphs: number
  percentFresh: string
  signalSourceGaps: string[]
  thinGraphCustomers: string[]
  alerts: GraphHealthAlert[]
  persistErrorCount: number
}

export interface MotionCoverageReport {
  customerSlug: string
  referencedNodes: number
  totalNodes: number
  percentage: number
  unreferencedNodeIds: string[]
}

// ── Core computation ────────────────────────────────────────────────────────

/**
 * Compute health report for a single customer graph.
 * Pure function — no side effects, no IO.
 */
export function computeCustomerGraphHealth(
  graph: CustomerGraph,
  signalConfigKeys: string[],
  motion?: StrategicMotion | null,
): CustomerHealthReport {
  const now = Date.now()
  const builtAtMs = new Date(graph.builtAt).getTime()
  const freshnessMs = now - builtAtMs

  // Freshness badge
  const FOUR_HOURS = 4 * 60 * 60 * 1000
  const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000
  let freshnessBadge: 'green' | 'yellow' | 'red'
  if (freshnessMs < FOUR_HOURS) freshnessBadge = 'green'
  else if (freshnessMs < TWENTY_FOUR_HOURS) freshnessBadge = 'yellow'
  else freshnessBadge = 'red'

  // Node counts by type (include all 17 types, even zeros)
  const nodeCountByType: Record<string, number> = {}
  for (const t of ALL_NODE_TYPES) nodeCountByType[t] = 0
  for (const node of Object.values(graph.nodes)) {
    nodeCountByType[node.type] = (nodeCountByType[node.type] ?? 0) + 1
  }

  // Edge counts by relation
  const edgeCountByRelation: Record<string, number> = {}
  for (const edge of graph.edges) {
    edgeCountByRelation[edge.relation] = (edgeCountByRelation[edge.relation] ?? 0) + 1
  }

  // Disconnected nodes: nodes with zero edges (neither from nor to)
  const connectedNodeIds = new Set<string>()
  for (const edge of graph.edges) {
    connectedNodeIds.add(edge.from)
    connectedNodeIds.add(edge.to)
  }
  const allNodeIds = Object.keys(graph.nodes)
  const disconnectedNodeCount = allNodeIds.filter(id => !connectedNodeIds.has(id)).length

  // Stale edges: edges where scoredAt < max(fromNode.updatedAt, toNode.updatedAt)
  let staleEdgeCount = 0
  for (const edge of graph.edges) {
    const scoredAtMs = new Date(edge.scoredAt).getTime()
    const fromNode = graph.nodes[edge.from]
    const toNode = graph.nodes[edge.to]
    const fromUpdated = fromNode ? new Date(fromNode.updatedAt).getTime() : 0
    const toUpdated = toNode ? new Date(toNode.updatedAt).getTime() : 0
    const maxNodeUpdated = Math.max(fromUpdated, toUpdated)
    if (scoredAtMs < maxNodeUpdated) staleEdgeCount++
  }

  // Signal source coverage: one entry per SIGNAL_CONFIGS key
  const sourceNodeCounts = new Map<string, number>()
  const sourceEdgeCounts = new Map<string, number>()
  const sourceLastTimestamp = new Map<string, string>()

  for (const node of Object.values(graph.nodes)) {
    const src = node.sourceModule
    sourceNodeCounts.set(src, (sourceNodeCounts.get(src) ?? 0) + 1)
    if (node.updatedAt) {
      const existing = sourceLastTimestamp.get(src)
      if (!existing || node.updatedAt > existing) {
        sourceLastTimestamp.set(src, node.updatedAt)
      }
    }
  }

  for (const edge of graph.edges) {
    const src = edge.sourceType
    sourceEdgeCounts.set(src, (sourceEdgeCounts.get(src) ?? 0) + 1)
  }

  const signalSourceCoverage: SignalSourceEntry[] = signalConfigKeys.map(source => ({
    source,
    nodeCount: sourceNodeCounts.get(source) ?? 0,
    edgeCount: sourceEdgeCounts.get(source) ?? 0,
    lastSignalTimestamp: sourceLastTimestamp.get(source) ?? null,
    isByDesign: BY_DESIGN_NULL_SOURCES.has(source),
  }))

  // Coverage fraction excludes by-design sources from the denominator
  const activeSources = signalSourceCoverage.filter(s => !s.isByDesign)
  const sourcesWithNodes = activeSources.filter(s => s.nodeCount > 0).length
  const totalSources = activeSources.length
  const coverageFraction = `${sourcesWithNodes}/${totalSources}`

  // Thin graph: true if >=5 non-by-design sources produced 0 nodes
  const sourcesWithZeroNodes = activeSources.filter(s => s.nodeCount === 0).length
  const isThinGraph = sourcesWithZeroNodes >= 5

  // Motion coverage
  let motionCoverage: MotionCoverageInfo | null = null
  if (motion) {
    motionCoverage = computeMotionCoverageFromMotion(graph, motion)
  }

  // Signal yield (#886): percentage of ingested signals that become final evidence
  let signalYield: number | null = null
  if (motion?.flowLedger) {
    const { signalsIngested, finalEvidenceCount } = motion.flowLedger
    signalYield = signalsIngested > 0
      ? Math.round((finalEvidenceCount / signalsIngested) * 100)
      : 0
  }

  return {
    customerSlug: graph.customerId,
    customerName: graph.customerName,
    builtAt: graph.builtAt,
    freshnessMs,
    freshnessBadge,
    nodeCountByType,
    edgeCountByRelation,
    totalNodes: Object.keys(graph.nodes).length,
    totalEdges: graph.edges.length,
    disconnectedNodeCount,
    staleEdgeCount,
    staleEdgeNote: 'filtered at query time',
    signalSourceCoverage,
    coverageFraction,
    isThinGraph,
    motionCoverage,
    lastRebuiltBy: graph.rebuiltBy ?? 'unknown',
    signalYield,
  }
}

/**
 * Compute motion coverage: TDP domain coverage and signal breadth (#882).
 * Replaces node-counting approach with domain-level coverage.
 */
function computeMotionCoverageFromMotion(
  _graph: CustomerGraph,
  motion: StrategicMotion,
): MotionCoverageInfo {
  const activeDomains = new Set<string>()
  const domainsWithEvidence = new Set<string>()
  const sourceTypes = new Set<string>()

  for (const phase of motion.phases) {
    // Each phase covers a TDP domain (extracted from phase name)
    const phaseTdp = phase.name.replace(/^(Anchor: Protect|Anchor|Expand|Transform|Displace):\s*/, '').trim()
    if (phaseTdp) activeDomains.add(phaseTdp)

    if (phase.evidence.length > 0 && phaseTdp) {
      domainsWithEvidence.add(phaseTdp)
    }

    for (const ev of phase.evidence) {
      sourceTypes.add(ev.module)
    }
  }

  const domainCoverage = activeDomains.size > 0
    ? Math.round((domainsWithEvidence.size / activeDomains.size) * 100)
    : 0

  return {
    domainCoverage,
    signalBreadth: sourceTypes.size,
    activeDomains: activeDomains.size,
    domainsWithEvidence: domainsWithEvidence.size,
  }
}

/**
 * Compute motion coverage with full details (#882 — domain coverage).
 */
export function computeMotionCoverage(
  graph: CustomerGraph,
  motion: StrategicMotion,
): MotionCoverageReport {
  const info = computeMotionCoverageFromMotion(graph, motion)
  return {
    customerSlug: graph.customerId,
    referencedNodes: info.domainsWithEvidence,
    totalNodes: info.activeDomains,
    percentage: info.domainCoverage,
    unreferencedNodeIds: [], // Domain-level coverage replaces node-level tracking
  }
}

/**
 * Motion evidence snapshot for regression detection (#886).
 * Callers read current from the just-built motion's flowLedger,
 * and previous from the persisted motion.json file.
 */
export interface MotionEvidenceSnapshot {
  customerSlug: string
  signalsIngested: number
  finalEvidenceCount: number
}

/**
 * Compute alerts based on portfolio-level health signals (#878).
 * Pure function — no IO, no side effects.
 *
 * @param currentMotions — optional current motion evidence for regression detection (#886)
 * @param previousMotions — optional previous motion evidence for regression detection (#886)
 */
export function computeAlerts(
  reports: CustomerHealthReport[],
  persistErrorCount: number,
  schedulerLastRun: string | null,
  currentMotions?: MotionEvidenceSnapshot[],
  previousMotions?: MotionEvidenceSnapshot[],
): GraphHealthAlert[] {
  const alerts: GraphHealthAlert[] = []

  // Staleness: >50% red = critical
  const redCount = reports.filter(r => r.freshnessBadge === 'red').length
  if (reports.length > 0 && redCount > reports.length / 2) {
    alerts.push({
      type: 'staleness',
      message: `${redCount} of ${reports.length} graphs are >24h stale`,
      severity: 'critical',
      count: redCount,
    })
  }

  // Persist errors
  if (persistErrorCount > 0) {
    alerts.push({
      type: 'persist_error',
      message: `${persistErrorCount} graph persist failure${persistErrorCount > 1 ? 's' : ''} since container start`,
      severity: 'warning',
      count: persistErrorCount,
    })
  }

  // Scheduler stall: hasn't run in >12h
  if (schedulerLastRun) {
    const hoursSince = (Date.now() - new Date(schedulerLastRun).getTime()) / 3600000
    if (hoursSince > 12) {
      alerts.push({
        type: 'scheduler_stall',
        message: `Graph rebuild scheduler hasn't run in ${Math.round(hoursSince)}h (expected every 6h)`,
        severity: 'warning',
        count: Math.round(hoursSince),
      })
    }
  } else {
    alerts.push({
      type: 'scheduler_stall',
      message: 'Graph rebuild scheduler has never run',
      severity: 'warning',
      count: 0,
    })
  }

  // Evidence regression (#886): fire when current finalEvidenceCount < 50% of previous
  // and previous signalsIngested >= 10 (small graphs fluctuate naturally)
  if (currentMotions && previousMotions && previousMotions.length > 0) {
    const prevBySlug = new Map(previousMotions.map(p => [p.customerSlug, p]))
    const currBySlug = new Map(currentMotions.map(c => [c.customerSlug, c]))
    const regressionCustomers: string[] = []
    for (const [slug, curr] of currBySlug) {
      const prev = prevBySlug.get(slug)
      if (!prev || prev.signalsIngested < 10 || prev.finalEvidenceCount === 0) continue
      if (curr.finalEvidenceCount < prev.finalEvidenceCount * 0.5) {
        regressionCustomers.push(slug)
      }
    }
    if (regressionCustomers.length > 0) {
      alerts.push({
        type: 'evidence_regression',
        message: `Evidence dropped >50% for: ${regressionCustomers.join(', ')}`,
        severity: 'warning',
        count: regressionCustomers.length,
      })
    }
  }

  return alerts
}

/**
 * Compute portfolio-level health summary from individual customer reports.
 * Customers sorted ascending by totalEdges (sparsest first).
 */
export function computePortfolioHealth(
  reports: CustomerHealthReport[],
  opts?: { alerts?: GraphHealthAlert[]; persistErrorCount?: number },
): PortfolioHealthReport {
  // Sort by total edges ascending (sparsest first)
  const sorted = [...reports].sort((a, b) => a.totalEdges - b.totalEdges)

  // Median calculations
  const nodeValues = sorted.map(r => r.totalNodes).sort((a, b) => a - b)
  const edgeValues = sorted.map(r => r.totalEdges).sort((a, b) => a - b)
  const medianNodeCount = median(nodeValues)
  const medianEdgeCount = median(edgeValues)

  // Fresh graph count
  const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000
  const customersWithFreshGraphs = sorted.filter(r => r.freshnessMs < TWENTY_FOUR_HOURS).length
  const percentFresh = sorted.length > 0
    ? `${Math.round((customersWithFreshGraphs / sorted.length) * 100)}%`
    : '0%'

  // Signal source gaps: non-by-design sources that produce 0 nodes for >50% of customers
  const sourceGapCounts = new Map<string, number>()
  for (const report of sorted) {
    for (const entry of report.signalSourceCoverage) {
      if (entry.nodeCount === 0 && !entry.isByDesign) {
        sourceGapCounts.set(entry.source, (sourceGapCounts.get(entry.source) ?? 0) + 1)
      }
    }
  }
  const halfCustomers = Math.ceil(sorted.length / 2)
  const signalSourceGaps = [...sourceGapCounts.entries()]
    .filter(([, count]) => count > halfCustomers)
    .map(([source]) => source)
    .sort()

  // Thin graph customers
  const thinGraphCustomers = sorted
    .filter(r => r.isThinGraph)
    .map(r => r.customerName)

  return {
    customers: sorted,
    medianNodeCount,
    medianEdgeCount,
    customersWithFreshGraphs,
    percentFresh,
    signalSourceGaps,
    thinGraphCustomers,
    alerts: opts?.alerts ?? [],
    persistErrorCount: opts?.persistErrorCount ?? 0,
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? Math.round((sorted[mid - 1] + sorted[mid]) / 2)
    : sorted[mid]
}
