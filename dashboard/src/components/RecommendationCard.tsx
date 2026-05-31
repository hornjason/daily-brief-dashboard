/**
 * RecommendationCard — Shared card component for displaying a single
 * intelligence recommendation. Used in both Morning Summary and
 * Customer Detail page.
 *
 * Council design decisions (Aditi, 2026-05-30):
 * - Progressive disclosure: headline visible, evidence collapsed
 * - Confidence badges: HIGH = emerald, MEDIUM = amber, EMERGING = blue
 * - Action buttons are stubs for now (styled, non-functional)
 * - No more than 3-5 visible at once in any context
 *
 * GitHub Issue #484
 */
import { useState, useEffect } from 'react'
import { ChevronDown, ChevronUp, Zap, Lightbulb } from 'lucide-react'

export interface RecommendationCardProps {
  headline: string
  detail: string
  confidence: 'HIGH' | 'MEDIUM' | 'EMERGING'
  solutionName: string
  solutionType: string
  triggerSignalCount: number
  redHatProducts: string[]
  actions: string[]
  /** #494: Customer slug for action button navigation */
  customerSlug?: string
  /** #494: Solution URL for "View play deck" action */
  solutionUrl?: string
}

const CONFIDENCE_STYLES: Record<string, { dot: string; text: string; bg: string; border: string; label: string }> = {
  HIGH: {
    dot: 'bg-emerald-500',
    text: 'text-emerald-400',
    bg: 'bg-emerald-500/10',
    border: 'border-emerald-500/20',
    label: 'High',
  },
  MEDIUM: {
    dot: 'bg-amber-500',
    text: 'text-amber-400',
    bg: 'bg-amber-500/10',
    border: 'border-amber-500/20',
    label: 'Medium',
  },
  EMERGING: {
    dot: 'bg-blue-500',
    text: 'text-blue-400',
    bg: 'bg-blue-500/10',
    border: 'border-blue-500/20',
    label: 'Emerging',
  },
}

/** #494: Route action button clicks to appropriate pages */
function handleAction(action: string, customerSlug?: string, solutionUrl?: string) {
  const actionLower = action.toLowerCase()

  if (actionLower.includes('draft email')) {
    if (customerSlug) {
      window.location.href = `/dashboard/campaigns?customer=${encodeURIComponent(customerSlug)}`
    }
    return
  }

  if (actionLower.includes('prep meeting')) {
    if (customerSlug) {
      window.location.href = `/dashboard/meeting-prep?customer=${encodeURIComponent(customerSlug)}`
    }
    return
  }

  if (actionLower.includes('view play deck') || actionLower.includes('view partner solution') || actionLower.includes('view program details')) {
    if (solutionUrl) {
      window.open(solutionUrl, '_blank')
    } else if (customerSlug) {
      window.location.href = `/dashboard/customer/${encodeURIComponent(customerSlug)}`
    }
    return
  }

  // Fallback: navigate to customer detail if we have a slug
  if (customerSlug) {
    window.location.href = `/dashboard/customer/${encodeURIComponent(customerSlug)}`
  }
}

export function RecommendationCard({
  headline,
  detail,
  confidence,
  solutionName,
  solutionType,
  triggerSignalCount,
  redHatProducts,
  actions,
  customerSlug,
  solutionUrl,
}: RecommendationCardProps) {
  const [expanded, setExpanded] = useState(false)
  const style = CONFIDENCE_STYLES[confidence] ?? CONFIDENCE_STYLES.EMERGING

  // Truncate headline to ~80 chars
  const displayHeadline = headline.length > 80
    ? headline.slice(0, 77) + '...'
    : headline

  return (
    <div className="bg-bg-secondary/30 rounded-lg border border-border overflow-hidden">
      {/* Clickable header */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full text-left px-3 py-2.5 flex items-start gap-2 hover:bg-border/10 transition-colors"
      >
        {/* Confidence dot */}
        <span className={`w-2 h-2 rounded-full shrink-0 mt-1.5 ${style.dot}`} />

        <div className="flex-1 min-w-0">
          {/* Top row: confidence badge + solution type */}
          <div className="flex items-center gap-1.5 mb-1 flex-wrap">
            <span className={`text-xs px-1.5 py-0.5 rounded ${style.bg} ${style.text} ${style.border} border font-medium`}>
              {style.label}
            </span>
            <span className="text-xs px-1.5 py-0.5 rounded bg-accent/10 text-accent border border-accent/20 font-medium">
              {solutionType}
            </span>
            {triggerSignalCount > 0 && (
              <span className="text-xs text-text-secondary flex items-center gap-0.5">
                <Zap className="w-3 h-3" />
                {triggerSignalCount} signals
              </span>
            )}
          </div>

          {/* Headline */}
          <p className="text-sm font-medium text-text-primary leading-snug" title={headline}>
            {displayHeadline}
          </p>

          {/* Solution name */}
          <p className="text-xs text-text-secondary mt-0.5">
            {solutionName}
          </p>
        </div>

        {/* Expand chevron */}
        <span className="shrink-0 mt-1">
          {expanded
            ? <ChevronUp className="w-3.5 h-3.5 text-text-secondary" />
            : <ChevronDown className="w-3.5 h-3.5 text-text-secondary" />
          }
        </span>
      </button>

      {/* Expanded detail */}
      {expanded && (
        <div className="px-3 pb-3 space-y-2 border-t border-border/40">
          {/* Detail text */}
          {detail && (
            <p className="text-xs text-text-secondary leading-relaxed pt-2">
              {detail}
            </p>
          )}

          {/* Red Hat products */}
          {redHatProducts.length > 0 && (
            <div className="flex items-center gap-1 flex-wrap">
              <span className="text-xs text-text-secondary">Products:</span>
              {redHatProducts.map(p => (
                <span
                  key={p}
                  className="text-xs px-1.5 py-0.5 rounded bg-accent/10 text-accent border border-accent/20 font-medium uppercase"
                >
                  {p}
                </span>
              ))}
            </div>
          )}

          {/* Action buttons (#494: wired to navigation) */}
          {actions.length > 0 && (
            <div className="flex items-center gap-1.5 pt-1 flex-wrap">
              {actions.map(action => (
                <button
                  key={action}
                  onClick={(e) => {
                    e.stopPropagation()
                    handleAction(action, customerSlug, solutionUrl)
                  }}
                  className="text-xs px-2.5 py-1 rounded-lg border border-border text-text-secondary hover:text-text-primary hover:border-text-secondary transition-colors"
                >
                  {action}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/** Parse a raw signal object from the debug endpoint into RecommendationCardProps */
export function signalToRecommendation(s: any): RecommendationCardProps {
  return {
    headline: s.headline ?? '',
    detail: s.detail ?? '',
    confidence: (s.metadata?.confidence ?? 'EMERGING') as 'HIGH' | 'MEDIUM' | 'EMERGING',
    solutionName: s.metadata?.solutionName ?? '',
    solutionType: s.metadata?.solutionType ?? 'play',
    triggerSignalCount: s.metadata?.triggerSignalCount ?? 0,
    redHatProducts: s.metadata?.redHatProducts ?? [],
    actions: s.metadata?.actions ?? [],
    customerSlug: s.metadata?.customerSlug ?? '',
    solutionUrl: s.metadata?.solutionUrl ?? '',
  }
}

/**
 * useRecommendations — Hook to fetch recommendations for a customer
 * from the signals/debug endpoint filtered to recommended-actions source.
 */
export function useRecommendations(customerName: string) {
  const [recommendations, setRecommendations] = useState<RecommendationCardProps[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!customerName) {
      setRecommendations([])
      setLoading(false)
      return
    }

    setLoading(true)
    fetch(`/api/customer/${encodeURIComponent(customerName)}/signals/debug`)
      .then(r => r.ok ? r.json() : { signals: [] })
      .then(data => {
        const recSignals = (data.signals ?? [])
          .filter((s: any) => s.source === 'recommended-actions' && s.type === 'recommendation')
          .sort((a: any, b: any) => (b.metadata?.triggerSignalCount ?? 0) - (a.metadata?.triggerSignalCount ?? 0))
          .map(signalToRecommendation)
        setRecommendations(recSignals)
      })
      .catch(() => setRecommendations([]))
      .finally(() => setLoading(false))
  }, [customerName])

  return { recommendations, loading }
}

/**
 * IntelligenceInsightsCard — Self-contained card for the Customer Detail
 * page sidebar. Fetches and displays top recommendations.
 */
export function IntelligenceInsightsCard({ customerName }: { customerName: string }) {
  const { recommendations, loading } = useRecommendations(customerName)
  const [showAll, setShowAll] = useState(false)

  if (loading) {
    return (
      <div className="bg-surface border border-border rounded-xl p-5">
        <div className="flex items-center gap-2 mb-3">
          <Lightbulb className="w-4 h-4 text-accent" />
          <h2 className="text-base font-semibold text-text-primary">Intelligence Insights</h2>
        </div>
        <div className="space-y-2">
          <div className="bg-border/40 rounded animate-pulse-slow h-16" />
          <div className="bg-border/40 rounded animate-pulse-slow h-16" />
        </div>
      </div>
    )
  }

  if (recommendations.length === 0) {
    return (
      <div className="bg-surface border border-border rounded-xl p-5">
        <div className="flex items-center gap-2 mb-3">
          <Lightbulb className="w-4 h-4 text-text-secondary" />
          <h2 className="text-base font-semibold text-text-primary">Intelligence Insights</h2>
        </div>
        <p className="text-xs text-text-secondary">
          No recommendations yet — signals are building
        </p>
      </div>
    )
  }

  const maxVisible = 3
  const visible = showAll ? recommendations : recommendations.slice(0, maxVisible)
  const hasMore = recommendations.length > maxVisible

  return (
    <div className="bg-surface border border-border rounded-xl p-5">
      <div className="flex items-center gap-2 mb-3">
        <Lightbulb className="w-4 h-4 text-accent" />
        <h2 className="text-base font-semibold text-text-primary">Intelligence Insights</h2>
        <span className="text-xs text-text-secondary">{recommendations.length}</span>
      </div>
      <div className="space-y-2">
        {visible.map((rec, i) => (
          <RecommendationCard key={i} {...rec} />
        ))}
      </div>
      {hasMore && (
        <button
          onClick={() => setShowAll(!showAll)}
          className="mt-2 flex items-center gap-1 text-xs text-accent hover:opacity-80 transition-opacity"
        >
          {showAll
            ? <><ChevronUp className="w-3.5 h-3.5" /> Show less</>
            : <><ChevronDown className="w-3.5 h-3.5" /> Show {recommendations.length - maxVisible} more</>
          }
        </button>
      )}
    </div>
  )
}
