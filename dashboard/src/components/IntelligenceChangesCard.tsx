/**
 * IntelligenceChangesCard.tsx
 * Shows "what changed since last rebuild" per customer using the intelligence graph.
 *
 * GitHub Issue #603 — Temporal diff narrative
 * Depends on: #601 (temporal signal persistence)
 *
 * Fetches from GET /api/customer/:slug/intelligence-changes
 * Displays new, disappeared, and reactivated signals.
 */

import { Activity, Plus, Minus, RotateCcw } from 'lucide-react'
import { useApi } from '../hooks/useApi'

interface GraphDiffChange {
  changeType: 'new' | 'disappeared' | 'reactivated'
  nodeType: string
  nodeName: string
  nodeId: string
  description: string
  timestamp: string
}

interface GraphDiffResponse {
  customerSlug: string
  currentBuiltAt: string | null
  previousBuiltAt?: string
  changes: GraphDiffChange[]
  summary: string
}

const CHANGE_ICONS: Record<string, typeof Plus> = {
  new: Plus,
  disappeared: Minus,
  reactivated: RotateCcw,
}

const CHANGE_COLORS: Record<string, string> = {
  new: 'bg-health-green/10 text-health-green',
  disappeared: 'bg-health-red/10 text-health-red',
  reactivated: 'bg-health-amber/10 text-health-amber',
}

const CHANGE_LABELS: Record<string, string> = {
  new: 'new',
  disappeared: 'inactive',
  reactivated: 'returned',
}

export function IntelligenceChangesCard({ customerSlug }: { customerSlug: string }) {
  const { data, loading, error } = useApi<GraphDiffResponse>(
    `/api/customer/${encodeURIComponent(customerSlug)}/intelligence-changes`
  )

  if (loading) {
    return (
      <div className="rounded-lg border border-border-primary bg-surface-primary px-4 py-3 animate-pulse">
        <div className="h-4 w-48 bg-border-primary/40 rounded" />
      </div>
    )
  }

  if (error || !data) {
    return null // Silent failure — don't clutter the page
  }

  // No graph yet or no changes
  if (!data.currentBuiltAt || !data.changes?.length) {
    return null
  }

  return (
    <div className="rounded-lg border border-border-primary bg-surface-primary overflow-hidden">
      <div className="px-4 py-2.5 border-b border-border-primary/60 flex items-center gap-2">
        <Activity className="w-3.5 h-3.5 text-text-secondary" />
        <h3 className="text-xs font-medium text-text-primary">
          Intelligence Changes
        </h3>
        <span className="ml-auto text-[10px] text-text-secondary bg-border-primary/30 px-1.5 py-0.5 rounded-full">
          {data.summary}
        </span>
      </div>
      <ul className="divide-y divide-border-primary/40">
        {data.changes.map((change, i) => {
          const Icon = CHANGE_ICONS[change.changeType] ?? Plus
          const colorClass = CHANGE_COLORS[change.changeType] ?? ''
          const label = CHANGE_LABELS[change.changeType] ?? change.changeType
          return (
            <li key={i} className="px-4 py-2">
              <div className="flex items-center gap-2">
                <span className={`inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded ${colorClass}`}>
                  <Icon className="w-2.5 h-2.5" />
                  {label}
                </span>
                <span className="text-[10px] text-text-secondary capitalize">
                  {change.nodeType}
                </span>
                <span className="text-[11px] text-text-primary truncate">
                  {change.nodeName}
                </span>
              </div>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
