/**
 * TemporalDiffStrip.tsx
 * Compact horizontal strip showing intelligence change summary on customer landing.
 * GitHub Issue #619 — Progressive disclosure: temporal diff strip
 *
 * Sits below the customer header, above tabs.
 * Fetches from GET /api/customer/:slug/intelligence-changes
 * Shows summary like "3 signals changed since Monday"
 * Clicking expands inline to show change details.
 * Renders nothing when no data is available.
 */

import { useState } from 'react'
import { Activity, ChevronDown, ChevronUp, Plus, Minus, RotateCcw, Info } from 'lucide-react'
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

function formatRelativeDate(iso: string): string {
  try {
    const date = new Date(iso)
    const now = new Date()
    const diffMs = now.getTime() - date.getTime()
    const diffHours = Math.floor(diffMs / (1000 * 60 * 60))
    const diffDays = Math.floor(diffHours / 24)

    if (diffHours < 1) return 'just now'
    if (diffHours < 24) return `${diffHours}h ago`
    if (diffDays === 1) return 'yesterday'
    if (diffDays < 7) {
      const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
      return dayNames[date.getDay()]
    }
    return `${diffDays}d ago`
  } catch {
    return ''
  }
}

export function TemporalDiffStrip({ customerSlug }: { customerSlug: string }) {
  const [expanded, setExpanded] = useState(false)
  const { data, loading, error } = useApi<GraphDiffResponse>(
    `/api/customer/${encodeURIComponent(customerSlug)}/intelligence-changes`
  )

  // Don't render during loading, on error, or when no data
  if (loading || error || !data) return null

  // No graph built yet or no changes — render nothing
  if (!data.currentBuiltAt || !data.changes?.length) return null

  const changeCount = data.changes.length
  const sinceLabel = data.previousBuiltAt
    ? formatRelativeDate(data.previousBuiltAt)
    : ''

  return (
    <div className="bg-surface/80 border-b border-border/40">
      <div className="px-6">
        <button
          onClick={() => setExpanded(v => !v)}
          className="w-full flex items-center gap-2 py-2 text-left group"
        >
          <Info className="w-3.5 h-3.5 text-text-secondary shrink-0" />
          <span className="text-xs text-text-secondary">
            <span className="font-medium text-text-primary">{changeCount} signal{changeCount !== 1 ? 's' : ''} changed</span>
            {sinceLabel && <> since {sinceLabel}</>}
          </span>
          <span className="ml-auto text-text-secondary/50 group-hover:text-text-secondary transition-colors">
            {expanded
              ? <ChevronUp className="w-3.5 h-3.5" />
              : <ChevronDown className="w-3.5 h-3.5" />
            }
          </span>
        </button>

        {expanded && (
          <div className="pb-3 space-y-1">
            {data.changes.map((change, i) => {
              const Icon = CHANGE_ICONS[change.changeType] ?? Plus
              const colorClass = CHANGE_COLORS[change.changeType] ?? ''
              const label = CHANGE_LABELS[change.changeType] ?? change.changeType
              return (
                <div key={i} className="flex items-center gap-2 py-1 pl-5">
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
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
