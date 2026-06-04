/**
 * dashboard/src/pages/PortfolioTriagePage.tsx
 * Portfolio Triage View — GitHub Issue #623
 *
 * Cross-customer motion prioritization page that ranks all customers by urgency.
 * Reads from GET /api/portfolio/triage (cached graph data, no Gemini calls).
 */

import { useState, useMemo } from 'react'
import { Link } from 'react-router-dom'
import { useApi } from '../hooks/useApi'
import { AlertTriangle, Activity, ArrowRight, Filter } from 'lucide-react'

// ── Types ────────────────────────────────────────────────────────────────────

type UrgencyLevel = 'critical' | 'high' | 'medium' | 'low'

interface TriageEntry {
  customerName: string
  customerSlug: string
  topMotion: {
    title: string
    urgency: UrgencyLevel
    phaseCount: number
    confidence: number
  } | null
  signalChangeCount: number
  graphNodeCount: number
}

interface TriageResponse {
  entries: TriageEntry[]
  total: number
  computedAt: string
}

// ── Urgency Badge ────────────────────────────────────────────────────────────

const urgencyConfig: Record<UrgencyLevel, { label: string; bg: string; text: string; dot: string }> = {
  critical: { label: 'Critical', bg: 'bg-red-500/15', text: 'text-red-400', dot: 'bg-red-500' },
  high:     { label: 'High',     bg: 'bg-orange-500/15', text: 'text-orange-400', dot: 'bg-orange-500' },
  medium:   { label: 'Medium',   bg: 'bg-yellow-500/15', text: 'text-yellow-400', dot: 'bg-yellow-500' },
  low:      { label: 'Low',      bg: 'bg-green-500/15', text: 'text-green-400', dot: 'bg-green-500' },
}

function UrgencyBadge({ urgency }: { urgency: UrgencyLevel }) {
  const cfg = urgencyConfig[urgency]
  return (
    <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium ${cfg.bg} ${cfg.text}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${cfg.dot}`} />
      {cfg.label}
    </span>
  )
}

// ── Loading Skeleton ─────────────────────────────────────────────────────────

function SkeletonRow() {
  return (
    <div className="flex items-center gap-4 px-4 py-3.5 border-b border-border/50 animate-pulse">
      <div className="w-40 h-4 bg-surface-hover rounded" />
      <div className="w-64 h-4 bg-surface-hover rounded" />
      <div className="w-16 h-5 bg-surface-hover rounded-full" />
      <div className="w-10 h-4 bg-surface-hover rounded" />
      <div className="w-16 h-4 bg-surface-hover rounded" />
    </div>
  )
}

// ── Main Page ────────────────────────────────────────────────────────────────

export function PortfolioTriagePage() {
  const { data, loading, error } = useApi<TriageResponse>('/api/portfolio/triage')
  const [urgencyFilter, setUrgencyFilter] = useState<UrgencyLevel | 'all'>('all')

  const filteredEntries = useMemo(() => {
    if (!data?.entries) return []
    if (urgencyFilter === 'all') return data.entries
    return data.entries.filter(e => e.topMotion?.urgency === urgencyFilter)
  }, [data, urgencyFilter])

  // Count entries per urgency level for filter chips
  const urgencyCounts = useMemo(() => {
    if (!data?.entries) return { critical: 0, high: 0, medium: 0, low: 0 }
    const counts = { critical: 0, high: 0, medium: 0, low: 0 }
    for (const e of data.entries) {
      if (e.topMotion?.urgency) counts[e.topMotion.urgency]++
    }
    return counts
  }, [data])

  return (
    <main className="flex-1 overflow-y-auto p-6">
      <div className="max-w-5xl mx-auto">
        {/* Header */}
        <div className="mb-6">
          <div className="flex items-center gap-3 mb-1">
            <AlertTriangle className="w-5 h-5 text-accent" />
            <h1 className="text-lg font-semibold text-text-primary">Portfolio Triage</h1>
          </div>
          <p className="text-sm text-text-secondary">
            Cross-customer prioritization ranked by urgency signals — cases, renewals, and active motions.
          </p>
        </div>

        {/* Urgency Filter */}
        <div className="flex items-center gap-2 mb-4">
          <Filter className="w-3.5 h-3.5 text-text-secondary" />
          <span className="text-xs text-text-secondary mr-1">Urgency:</span>
          {(['all', 'critical', 'high', 'medium', 'low'] as const).map(level => {
            const isActive = urgencyFilter === level
            const count = level === 'all' ? (data?.total ?? 0) : urgencyCounts[level]
            return (
              <button
                key={level}
                onClick={() => setUrgencyFilter(level)}
                className={`text-xs px-2.5 py-1 rounded-full border transition-colors ${
                  isActive
                    ? 'border-accent ring-1 ring-accent bg-accent/10 text-accent font-medium'
                    : 'border-border text-text-secondary hover:text-text-primary hover:border-text-secondary'
                }`}
              >
                {level === 'all' ? 'All' : urgencyConfig[level].label}
                {count > 0 && <span className="ml-1 opacity-70">{count}</span>}
              </button>
            )
          })}
        </div>

        {/* Error State */}
        {error && (
          <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-4 text-red-400 text-sm">
            Failed to load triage data: {error}
          </div>
        )}

        {/* Loading State */}
        {loading && (
          <div className="bg-surface border border-border rounded-lg overflow-hidden">
            <div className="px-4 py-2.5 border-b border-border bg-surface-hover/50">
              <div className="flex items-center gap-4 text-xs font-medium text-text-secondary uppercase tracking-wider">
                <span className="w-40">Customer</span>
                <span className="flex-1">Top Motion</span>
                <span className="w-20">Urgency</span>
                <span className="w-16 text-right">Signals</span>
                <span className="w-16 text-right">Nodes</span>
                <span className="w-12" />
              </div>
            </div>
            {Array.from({ length: 8 }).map((_, i) => <SkeletonRow key={i} />)}
          </div>
        )}

        {/* Empty State */}
        {!loading && !error && filteredEntries.length === 0 && (
          <div className="bg-surface border border-border rounded-lg p-12 text-center">
            <Activity className="w-10 h-10 text-text-secondary/40 mx-auto mb-3" />
            <h3 className="text-sm font-medium text-text-primary mb-1">
              {urgencyFilter !== 'all'
                ? `No customers with ${urgencyConfig[urgencyFilter].label.toLowerCase()} urgency`
                : 'No customers with motions found'}
            </h3>
            <p className="text-xs text-text-secondary">
              {urgencyFilter !== 'all'
                ? 'Try changing the urgency filter or generate intelligence graphs from the Admin page.'
                : 'Generate intelligence graphs from the Admin page to populate triage data.'}
            </p>
          </div>
        )}

        {/* Data Table */}
        {!loading && !error && filteredEntries.length > 0 && (
          <div className="bg-surface border border-border rounded-lg overflow-hidden">
            {/* Table Header */}
            <div className="px-4 py-2.5 border-b border-border bg-surface-hover/50">
              <div className="flex items-center gap-4 text-xs font-medium text-text-secondary uppercase tracking-wider">
                <span className="w-40">Customer</span>
                <span className="flex-1">Top Motion</span>
                <span className="w-20">Urgency</span>
                <span className="w-16 text-right">Signals</span>
                <span className="w-16 text-right">Nodes</span>
                <span className="w-12" />
              </div>
            </div>

            {/* Table Rows */}
            {filteredEntries.map((entry) => (
              <Link
                key={entry.customerSlug}
                to={`/dashboard/customer/${encodeURIComponent(entry.customerName)}`}
                className="flex items-center gap-4 px-4 py-3 border-b border-border/50 last:border-b-0 hover:bg-surface-hover/50 transition-colors group"
              >
                {/* Customer Name */}
                <span className="w-40 text-sm font-medium text-text-primary truncate group-hover:text-accent transition-colors" title={entry.customerName}>
                  {entry.customerName}
                </span>

                {/* Motion Title */}
                <span className="flex-1 text-sm text-text-secondary truncate" title={entry.topMotion?.title ?? 'No motion'}>
                  {entry.topMotion?.title ?? 'No motion'}
                  {entry.topMotion && entry.topMotion.phaseCount > 0 && (
                    <span className="ml-1.5 text-xs text-text-secondary/60">
                      ({entry.topMotion.phaseCount} phase{entry.topMotion.phaseCount !== 1 ? 's' : ''})
                    </span>
                  )}
                </span>

                {/* Urgency Badge */}
                <span className="w-20">
                  {entry.topMotion ? (
                    <UrgencyBadge urgency={entry.topMotion.urgency} />
                  ) : (
                    <span className="text-xs text-text-secondary/50">--</span>
                  )}
                </span>

                {/* Signal Change Count */}
                <span className="w-16 text-right text-sm tabular-nums text-text-secondary">
                  {entry.signalChangeCount > 0 ? (
                    <span className="text-accent">{entry.signalChangeCount}</span>
                  ) : (
                    <span className="text-text-secondary/40">0</span>
                  )}
                </span>

                {/* Graph Node Count */}
                <span className="w-16 text-right text-sm tabular-nums text-text-secondary/60">
                  {entry.graphNodeCount}
                </span>

                {/* View Arrow */}
                <span className="w-12 flex justify-end">
                  <ArrowRight className="w-3.5 h-3.5 text-text-secondary/30 group-hover:text-accent transition-colors" />
                </span>
              </Link>
            ))}
          </div>
        )}

        {/* Footer */}
        {data && !loading && (
          <div className="mt-3 flex items-center justify-between text-xs text-text-secondary/60">
            <span>
              {filteredEntries.length} of {data.total} customer{data.total !== 1 ? 's' : ''}
              {urgencyFilter !== 'all' && ` (filtered: ${urgencyConfig[urgencyFilter].label})`}
            </span>
            <span>
              Updated {new Date(data.computedAt).toLocaleTimeString()}
            </span>
          </div>
        )}
      </div>
    </main>
  )
}
