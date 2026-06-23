/**
 * dashboard/src/pages/GraphHealthPage.tsx
 * Intelligence Graph Health Audit — GitHub Issue #875
 *
 * Portfolio-level graph health dashboard. Shows node/edge density, signal source
 * coverage, staleness, disconnected nodes, and motion retrieval coverage.
 * Reads from GET /api/admin/graph-health (cached graph data, no Gemini calls).
 */

import { useState, useMemo } from 'react'
import { useApi } from '../hooks/useApi'
import { Activity, ChevronDown, ChevronRight, AlertCircle, Database } from 'lucide-react'

// ── Types ────────────────────────────────────────────────────────────────────

interface SignalSourceEntry {
  source: string
  nodeCount: number
  edgeCount: number
  lastSignalTimestamp: string | null
  isByDesign: boolean
}

interface MotionCoverageInfo {
  referencedNodes: number
  totalNodes: number
  percentage: number
}

interface CustomerHealthReport {
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
  staleEdgeNote?: string
  signalSourceCoverage: SignalSourceEntry[]
  coverageFraction: string
  isThinGraph: boolean
  motionCoverage: MotionCoverageInfo | null
  lastRebuiltBy?: string
}

interface EdgeDetail {
  from: string
  to: string
  relation: string
  tier: 'factual' | 'derived'
  strength: number
  evidence: string[]
  scoredAt: string
  sourceType: string
}

// ── Badge Components ────────────────────────────────────────────────────────

const freshnessColors: Record<string, { bg: string; text: string; dot: string }> = {
  green:  { bg: 'bg-green-500/15',  text: 'text-green-400',  dot: 'bg-green-500' },
  yellow: { bg: 'bg-yellow-500/15', text: 'text-yellow-400', dot: 'bg-yellow-500' },
  red:    { bg: 'bg-red-500/15',    text: 'text-red-400',    dot: 'bg-red-500' },
}

function FreshnessBadge({ badge }: { badge: 'green' | 'yellow' | 'red' }) {
  const cfg = freshnessColors[badge]
  const labels = { green: '<4h', yellow: '<24h', red: '>24h' }
  return (
    <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium ${cfg.bg} ${cfg.text}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${cfg.dot}`} />
      {labels[badge]}
    </span>
  )
}

// ── Loading Skeleton ────────────────────────────────────────────────────────

function SkeletonRow() {
  return (
    <div className="flex items-center gap-4 px-4 py-3 border-b border-border/50 animate-pulse">
      <div className="w-36 h-4 bg-surface-hover rounded" />
      <div className="w-12 h-4 bg-surface-hover rounded" />
      <div className="w-12 h-4 bg-surface-hover rounded" />
      <div className="w-16 h-5 bg-surface-hover rounded-full" />
      <div className="w-12 h-4 bg-surface-hover rounded" />
      <div className="w-12 h-4 bg-surface-hover rounded" />
      <div className="w-16 h-4 bg-surface-hover rounded" />
    </div>
  )
}

// ── Customer Detail Panel ───────────────────────────────────────────────────

function CustomerDetail({ report }: { report: CustomerHealthReport }) {
  const [edgeSortField, setEdgeSortField] = useState<'strength' | 'relation'>('strength')
  const [edgeSortAsc, setEdgeSortAsc] = useState(false)

  // Node type histogram
  const nodeTypes = Object.entries(report.nodeCountByType)
    .sort((a, b) => b[1] - a[1])
  const maxNodeCount = Math.max(...nodeTypes.map(([, c]) => c), 1)

  // Edge type histogram
  const edgeTypes = Object.entries(report.edgeCountByRelation)
    .sort((a, b) => b[1] - a[1])
  const maxEdgeCount = Math.max(...edgeTypes.map(([, c]) => c), 1)

  return (
    <div className="px-4 py-4 bg-surface-hover/30 border-t border-border/30 space-y-5">
      {/* Row 1: Node + Edge Histograms side by side */}
      <div className="grid grid-cols-2 gap-4">
        {/* Node Type Histogram */}
        <div>
          <h4 className="text-xs font-medium text-text-secondary uppercase tracking-wider mb-2">
            Node Types ({report.totalNodes} total)
          </h4>
          <div className="space-y-1">
            {nodeTypes.map(([type, count]) => (
              <div key={type} className="flex items-center gap-2 text-xs">
                <span className="w-24 text-text-secondary truncate" title={type}>{type}</span>
                <div className="flex-1 h-3 bg-gray-800 rounded-sm overflow-hidden">
                  <div
                    className={`h-full rounded-sm ${count > 0 ? 'bg-accent/60' : ''}`}
                    style={{ width: `${(count / maxNodeCount) * 100}%` }}
                  />
                </div>
                <span className="w-8 text-right tabular-nums text-text-secondary/70">{count}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Edge Type Histogram */}
        <div>
          <h4 className="text-xs font-medium text-text-secondary uppercase tracking-wider mb-2">
            Edge Relations ({report.totalEdges} total)
          </h4>
          {edgeTypes.length === 0 ? (
            <p className="text-xs text-text-secondary/50">No edges</p>
          ) : (
            <div className="space-y-1">
              {edgeTypes.map(([relation, count]) => (
                <div key={relation} className="flex items-center gap-2 text-xs">
                  <span className="w-32 text-text-secondary truncate" title={relation}>{relation}</span>
                  <div className="flex-1 h-3 bg-gray-800 rounded-sm overflow-hidden">
                    <div
                      className="h-full bg-blue-500/50 rounded-sm"
                      style={{ width: `${(count / maxEdgeCount) * 100}%` }}
                    />
                  </div>
                  <span className="w-8 text-right tabular-nums text-text-secondary/70">{count}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Row 2: Signal Source Coverage */}
      <div>
        <h4 className="text-xs font-medium text-text-secondary uppercase tracking-wider mb-2">
          Signal Source Coverage ({report.coverageFraction} active)
          {(() => {
            const byDesignCount = report.signalSourceCoverage.filter(s => s.isByDesign).length
            return byDesignCount > 0
              ? <span className="ml-1 text-text-secondary/50 normal-case">({byDesignCount} by design)</span>
              : null
          })()}
        </h4>
        <div className="bg-surface border border-border rounded overflow-hidden">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-border bg-surface-hover/50">
                <th className="text-left px-3 py-1.5 font-medium text-text-secondary">Source</th>
                <th className="text-right px-3 py-1.5 font-medium text-text-secondary">Nodes</th>
                <th className="text-right px-3 py-1.5 font-medium text-text-secondary">Edges</th>
                <th className="text-right px-3 py-1.5 font-medium text-text-secondary">Last Signal</th>
              </tr>
            </thead>
            <tbody>
              {report.signalSourceCoverage.map(entry => {
                const isGap = entry.nodeCount === 0 && !entry.isByDesign
                const isByDesignNull = entry.nodeCount === 0 && entry.isByDesign
                return (
                  <tr
                    key={entry.source}
                    className={`border-b border-border/30 last:border-b-0 ${
                      isGap ? 'bg-red-500/5' : ''
                    }`}
                  >
                    <td className={`px-3 py-1.5 ${
                      isGap ? 'text-red-400' :
                      isByDesignNull ? 'text-text-secondary/50' :
                      'text-text-primary'
                    }`}>
                      {entry.source}
                      {isGap && (
                        <span className="ml-1.5 text-red-400/70">(no data)</span>
                      )}
                      {isByDesignNull && (
                        <span className="ml-1.5 text-text-secondary/40">(by design)</span>
                      )}
                    </td>
                    <td className={`text-right px-3 py-1.5 tabular-nums ${
                      isGap ? 'text-red-400/60' :
                      isByDesignNull ? 'text-text-secondary/40' :
                      'text-text-secondary'
                    }`}>
                      {entry.nodeCount}
                    </td>
                    <td className={`text-right px-3 py-1.5 tabular-nums ${
                      isByDesignNull ? 'text-text-secondary/40' : 'text-text-secondary'
                    }`}>
                      {entry.edgeCount}
                    </td>
                    <td className="text-right px-3 py-1.5 text-text-secondary/60">
                      {entry.lastSignalTimestamp
                        ? new Date(entry.lastSignalTimestamp).toLocaleDateString()
                        : '--'}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Row 3: Motion Coverage */}
      {report.motionCoverage && (
        <div>
          <h4 className="text-xs font-medium text-text-secondary uppercase tracking-wider mb-2">
            Motion Coverage
          </h4>
          <div className="flex items-center gap-3">
            <div className="flex-1 h-4 bg-gray-800 rounded-full overflow-hidden">
              <div
                className={`h-full rounded-full transition-all ${
                  report.motionCoverage.percentage < 25 ? 'bg-red-500/60' :
                  report.motionCoverage.percentage < 50 ? 'bg-yellow-500/60' :
                  'bg-green-500/60'
                }`}
                style={{ width: `${report.motionCoverage.percentage}%` }}
              />
            </div>
            <span className={`text-sm font-medium tabular-nums ${
              report.motionCoverage.percentage < 25 ? 'text-red-400' :
              report.motionCoverage.percentage < 50 ? 'text-yellow-400' :
              'text-green-400'
            }`}>
              {report.motionCoverage.referencedNodes}/{report.motionCoverage.totalNodes} nodes ({report.motionCoverage.percentage}%)
            </span>
            {report.motionCoverage.percentage < 25 && (
              <span className="text-xs text-red-400/70">Low coverage</span>
            )}
          </div>
        </div>
      )}

      {/* Row 4: Health Stats Summary */}
      <div className="flex items-center gap-6 text-xs text-text-secondary/70 pt-2 border-t border-border/30">
        <span>Disconnected nodes: <span className={report.disconnectedNodeCount > 0 ? 'text-yellow-400' : 'text-text-secondary'}>{report.disconnectedNodeCount}</span></span>
        <span>Stale edges: <span className={report.staleEdgeCount > 0 ? 'text-yellow-400' : 'text-text-secondary'}>{report.staleEdgeCount}{report.staleEdgeNote ? ` (${report.staleEdgeNote})` : ''}</span></span>
        <span>Built: {new Date(report.builtAt).toLocaleString()}</span>
        {report.lastRebuiltBy && report.lastRebuiltBy !== 'unknown' && (
          <span className="text-text-secondary/50">via {report.lastRebuiltBy}</span>
        )}
      </div>
    </div>
  )
}

// ── Main Page ───────────────────────────────────────────────────────────────

export function GraphHealthPage() {
  const { data, loading, error } = useApi<CustomerHealthReport[]>('/api/admin/graph-health')
  const [expandedSlug, setExpandedSlug] = useState<string | null>(null)
  const [sortField, setSortField] = useState<'edges' | 'nodes' | 'freshness' | 'coverage'>('edges')

  const sorted = useMemo(() => {
    if (!data) return []
    const copy = [...data]
    switch (sortField) {
      case 'edges':
        return copy.sort((a, b) => a.totalEdges - b.totalEdges)
      case 'nodes':
        return copy.sort((a, b) => a.totalNodes - b.totalNodes)
      case 'freshness':
        return copy.sort((a, b) => b.freshnessMs - a.freshnessMs)
      case 'coverage':
        return copy.sort((a, b) => {
          const ac = a.coverageFraction.split('/').map(Number)
          const bc = b.coverageFraction.split('/').map(Number)
          return (ac[0] / (ac[1] || 1)) - (bc[0] / (bc[1] || 1))
        })
      default:
        return copy
    }
  }, [data, sortField])

  // Portfolio stats
  const stats = useMemo(() => {
    if (!data || data.length === 0) return null
    const totalNodes = data.reduce((s, r) => s + r.totalNodes, 0)
    const totalEdges = data.reduce((s, r) => s + r.totalEdges, 0)
    const freshCount = data.filter(r => r.freshnessBadge !== 'red').length
    const thinCount = data.filter(r => r.isThinGraph).length
    return { totalNodes, totalEdges, freshCount, thinCount, total: data.length }
  }, [data])

  const handleSort = (field: typeof sortField) => {
    setSortField(field)
  }

  return (
    <main className="flex-1 overflow-y-auto p-6">
      <div className="max-w-6xl mx-auto">
        {/* Header */}
        <div className="mb-6">
          <div className="flex items-center gap-3 mb-1">
            <Database className="w-5 h-5 text-accent" />
            <h1 className="text-lg font-semibold text-text-primary">Intelligence Graph Health</h1>
          </div>
          <p className="text-sm text-text-secondary">
            Node/edge density, signal source coverage, staleness, and motion retrieval across all customers.
          </p>
        </div>

        {/* Portfolio KPIs */}
        {stats && (
          <div className="grid grid-cols-4 gap-3 mb-5">
            <div className="bg-surface border border-border rounded-lg px-4 py-3">
              <div className="text-xs text-text-secondary uppercase tracking-wider mb-1">Customers</div>
              <div className="text-xl font-semibold text-text-primary tabular-nums">{stats.total}</div>
            </div>
            <div className="bg-surface border border-border rounded-lg px-4 py-3">
              <div className="text-xs text-text-secondary uppercase tracking-wider mb-1">Total Nodes</div>
              <div className="text-xl font-semibold text-text-primary tabular-nums">{stats.totalNodes.toLocaleString()}</div>
            </div>
            <div className="bg-surface border border-border rounded-lg px-4 py-3">
              <div className="text-xs text-text-secondary uppercase tracking-wider mb-1">Fresh Graphs</div>
              <div className="text-xl font-semibold tabular-nums">
                <span className={stats.freshCount === stats.total ? 'text-green-400' : 'text-yellow-400'}>{stats.freshCount}</span>
                <span className="text-text-secondary/50 text-sm">/{stats.total}</span>
              </div>
            </div>
            <div className="bg-surface border border-border rounded-lg px-4 py-3">
              <div className="text-xs text-text-secondary uppercase tracking-wider mb-1">Thin Graphs</div>
              <div className={`text-xl font-semibold tabular-nums ${stats.thinCount > 0 ? 'text-red-400' : 'text-green-400'}`}>
                {stats.thinCount}
              </div>
            </div>
          </div>
        )}

        {/* Error State */}
        {error && (
          <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-4 text-red-400 text-sm flex items-center gap-2">
            <AlertCircle className="w-4 h-4 shrink-0" />
            Failed to load graph health: {error}
          </div>
        )}

        {/* Loading State */}
        {loading && (
          <div className="bg-surface border border-border rounded-lg overflow-hidden">
            <div className="px-4 py-2.5 border-b border-border bg-surface-hover/50">
              <div className="flex items-center gap-4 text-xs font-medium text-text-secondary uppercase tracking-wider">
                <span className="w-8" />
                <span className="w-36">Customer</span>
                <span className="w-16 text-right">Nodes</span>
                <span className="w-16 text-right">Edges</span>
                <span className="w-20">Freshness</span>
                <span className="w-20 text-right">Coverage</span>
                <span className="w-24 text-right">Motion</span>
                <span className="flex-1 text-right">Status</span>
              </div>
            </div>
            {Array.from({ length: 8 }).map((_, i) => <SkeletonRow key={i} />)}
          </div>
        )}

        {/* Empty State */}
        {!loading && !error && sorted.length === 0 && (
          <div className="bg-surface border border-border rounded-lg p-12 text-center">
            <Activity className="w-10 h-10 text-text-secondary/40 mx-auto mb-3" />
            <h3 className="text-sm font-medium text-text-primary mb-1">No graph data available</h3>
            <p className="text-xs text-text-secondary">
              Generate intelligence graphs from the Admin page to see health metrics.
            </p>
          </div>
        )}

        {/* Data Table */}
        {!loading && !error && sorted.length > 0 && (
          <div className="bg-surface border border-border rounded-lg overflow-hidden">
            {/* Table Header */}
            <div className="px-4 py-2.5 border-b border-border bg-surface-hover/50">
              <div className="flex items-center gap-4 text-xs font-medium text-text-secondary uppercase tracking-wider">
                <span className="w-6" />
                <span className="w-36">Customer</span>
                <button
                  onClick={() => handleSort('nodes')}
                  className={`w-16 text-right cursor-pointer hover:text-text-primary transition-colors ${sortField === 'nodes' ? 'text-accent' : ''}`}
                >
                  Nodes
                </button>
                <button
                  onClick={() => handleSort('edges')}
                  className={`w-16 text-right cursor-pointer hover:text-text-primary transition-colors ${sortField === 'edges' ? 'text-accent' : ''}`}
                >
                  Edges
                </button>
                <button
                  onClick={() => handleSort('freshness')}
                  className={`w-20 cursor-pointer hover:text-text-primary transition-colors ${sortField === 'freshness' ? 'text-accent' : ''}`}
                >
                  Freshness
                </button>
                <button
                  onClick={() => handleSort('coverage')}
                  className={`w-20 text-right cursor-pointer hover:text-text-primary transition-colors ${sortField === 'coverage' ? 'text-accent' : ''}`}
                >
                  Coverage
                </button>
                <span className="w-24 text-right">Motion</span>
                <span className="flex-1 text-right">Status</span>
              </div>
            </div>

            {/* Table Rows */}
            {sorted.map((report) => {
              const isExpanded = expandedSlug === report.customerSlug
              return (
                <div key={report.customerSlug}>
                  <button
                    onClick={() => setExpandedSlug(isExpanded ? null : report.customerSlug)}
                    className="w-full flex items-center gap-4 px-4 py-3 border-b border-border/50 last:border-b-0 hover:bg-surface-hover/50 transition-colors text-left"
                  >
                    {/* Expand Icon */}
                    <span className="w-6 flex items-center justify-center text-text-secondary/50">
                      {isExpanded
                        ? <ChevronDown className="w-3.5 h-3.5" />
                        : <ChevronRight className="w-3.5 h-3.5" />}
                    </span>

                    {/* Customer Name */}
                    <span className="w-36 text-sm font-medium text-text-primary truncate" title={report.customerName}>
                      {report.customerName}
                    </span>

                    {/* Nodes */}
                    <span className="w-16 text-right text-sm tabular-nums text-text-secondary">
                      {report.totalNodes}
                    </span>

                    {/* Edges */}
                    <span className="w-16 text-right text-sm tabular-nums text-text-secondary">
                      {report.totalEdges}
                    </span>

                    {/* Freshness */}
                    <span className="w-20">
                      <FreshnessBadge badge={report.freshnessBadge} />
                    </span>

                    {/* Signal Coverage */}
                    <span className="w-20 text-right text-sm tabular-nums text-text-secondary">
                      {report.coverageFraction}
                    </span>

                    {/* Motion Coverage */}
                    <span className="w-24 text-right text-sm tabular-nums">
                      {report.motionCoverage ? (
                        <span className={
                          report.motionCoverage.percentage < 25 ? 'text-red-400' :
                          report.motionCoverage.percentage < 50 ? 'text-yellow-400' :
                          'text-green-400'
                        }>
                          {report.motionCoverage.percentage}%
                        </span>
                      ) : (
                        <span className="text-text-secondary/40">--</span>
                      )}
                    </span>

                    {/* Status Flags */}
                    <span className="flex-1 flex items-center justify-end gap-2">
                      {report.lastRebuiltBy && report.lastRebuiltBy !== 'unknown' && (
                        <span className="text-xs text-text-secondary/40">
                          via {report.lastRebuiltBy}
                        </span>
                      )}
                      {report.isThinGraph && (
                        <span className="text-xs px-2 py-0.5 rounded bg-red-500/15 text-red-400 font-medium">
                          Thin
                        </span>
                      )}
                      {report.disconnectedNodeCount > 0 && (
                        <span className="text-xs px-2 py-0.5 rounded bg-yellow-500/10 text-yellow-400/70" title={`${report.disconnectedNodeCount} disconnected nodes`}>
                          {report.disconnectedNodeCount} disc.
                        </span>
                      )}
                    </span>
                  </button>

                  {/* Expanded Detail */}
                  {isExpanded && <CustomerDetail report={report} />}
                </div>
              )
            })}
          </div>
        )}

        {/* Footer */}
        {data && !loading && (
          <div className="mt-3 text-xs text-text-secondary/60">
            {data.length} customer{data.length !== 1 ? 's' : ''} with graph data
          </div>
        )}
      </div>
    </main>
  )
}
