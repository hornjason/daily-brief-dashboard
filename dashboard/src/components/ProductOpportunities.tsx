/**
 * ProductOpportunities.tsx
 * Shows saleshub-products signals on the customer detail page.
 * GitHub Issue #821
 */

import { useState, useEffect, useCallback } from 'react'
import { ChevronDown, ChevronRight, Sparkles, RefreshCw, User, ExternalLink, BookOpen, Wrench } from 'lucide-react'

interface ActionStep {
  step: string
  url?: string
}

interface ResourceItem {
  name: string
  url: string
}

interface SignalMetadata {
  cloudProvider?: string
  contactName?: string
  actionableSteps?: ActionStep[]
  calculatorUrl?: string
  workshopUrl?: string
  resourceType?: string
  items?: ResourceItem[]
  links?: ResourceItem[]
  [key: string]: unknown
}

interface ProductSignal {
  type: string
  headline: string
  score: number
  rawRelevance?: number
  metadata: SignalMetadata
}

interface ProductOpportunitiesProps {
  customerName: string
}

const CLOUD_BADGE: Record<string, { bg: string; text: string; label: string }> = {
  aws:    { bg: 'bg-orange-500/15', text: 'text-orange-400', label: 'AWS' },
  azure:  { bg: 'bg-blue-500/15',   text: 'text-blue-400',  label: 'Azure' },
  google: { bg: 'bg-green-500/15',  text: 'text-green-400', label: 'Google' },
  gcp:    { bg: 'bg-green-500/15',  text: 'text-green-400', label: 'GCP' },
}

function scoreColor(score: number): string {
  if (score > 0.3) return 'bg-green-400'
  if (score > 0.15) return 'bg-yellow-400'
  return 'bg-text-secondary/40'
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  return text.slice(0, max - 1) + '…'
}

export function ProductOpportunities({ customerName }: ProductOpportunitiesProps) {
  const [signals, setSignals] = useState<ProductSignal[]>([])
  const [loading, setLoading] = useState(true)
  const [expanded, setExpanded] = useState(true)
  const [showAll, setShowAll] = useState(false)
  const [expandedCard, setExpandedCard] = useState<number | null>(null)

  const fetchSignals = useCallback(() => {
    fetch(`/api/customer/${encodeURIComponent(customerName)}/signals/debug?source=saleshub-products`)
      .then(r => r.ok ? r.json() : { signals: [] })
      .then(data => {
        const sorted = (data.signals ?? [])
          .sort((a: ProductSignal, b: ProductSignal) => b.score - a.score)
        setSignals(sorted)
      })
      .catch(() => setSignals([]))
      .finally(() => setLoading(false))
  }, [customerName])

  useEffect(() => {
    setLoading(true)
    fetchSignals()
    const interval = setInterval(fetchSignals, 30_000)
    return () => clearInterval(interval)
  }, [fetchSignals])

  // Empty state
  if (!loading && signals.length === 0) {
    return (
      <div className="bg-bg-secondary/30 rounded-lg border border-border p-3">
        <div className="flex items-center gap-2">
          <Sparkles className="w-4 h-4 text-text-secondary" />
          <span className="text-sm font-medium text-text-primary">Product Opportunities</span>
          <span className="text-xs text-text-secondary">0 signals</span>
        </div>
        <p className="text-xs text-text-secondary mt-2">No product opportunity signals found for this customer.</p>
      </div>
    )
  }

  // Loading skeleton
  if (loading) {
    return (
      <div className="bg-bg-secondary/30 rounded-lg border border-border p-3">
        <div className="flex items-center gap-2">
          <Sparkles className="w-4 h-4 text-text-secondary" />
          <span className="text-sm font-medium text-text-primary">Product Opportunities</span>
        </div>
        <div className="mt-2 space-y-2">
          {[1, 2, 3].map(i => (
            <div key={i} className="bg-bg-tertiary/40 rounded-md p-2 animate-pulse-slow">
              <div className="h-3.5 bg-border/40 rounded w-3/4 mb-1" />
              <div className="h-3 bg-border/40 rounded w-1/3" />
            </div>
          ))}
        </div>
      </div>
    )
  }

  const top3 = signals.slice(0, 3)
  const rest = signals.slice(3)
  const visible = showAll ? signals : top3

  return (
    <div className="bg-bg-secondary/30 rounded-lg border border-border p-3">
      {/* Header */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center justify-between w-full text-left"
      >
        <div className="flex items-center gap-2">
          <Sparkles className="w-4 h-4 text-text-secondary" />
          <span className="text-sm font-medium text-text-primary">Product Opportunities</span>
          <span className="text-xs text-text-secondary">
            {signals.length} signal{signals.length !== 1 ? 's' : ''}
          </span>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={(e) => { e.stopPropagation(); fetchSignals() }}
            className="p-0.5 text-text-secondary/50 hover:text-accent transition-colors"
            title="Refresh product opportunities"
          >
            <RefreshCw className="w-3 h-3" />
          </button>
          <ChevronDown className={`w-4 h-4 text-text-secondary transition-transform ${expanded ? 'rotate-180' : ''}`} />
        </div>
      </button>

      {/* Signal cards */}
      {expanded && (
        <div className="mt-2 space-y-1.5">
          {visible.map((signal, i) => {
            const cloud = signal.metadata.cloudProvider?.toLowerCase()
            const badge = cloud && cloud !== 'unknown' ? CLOUD_BADGE[cloud] : null

            const isExpanded = expandedCard === i
            const steps = signal.metadata.actionableSteps ?? []
            const items = signal.metadata.items ?? signal.metadata.links ?? []
            const hasDetail = steps.length > 0 || items.length > 0 || signal.metadata.contactName || signal.metadata.calculatorUrl

            return (
              <div key={i} className="bg-bg-tertiary/40 rounded-md p-2 space-y-1">
                <button
                  onClick={() => setExpandedCard(isExpanded ? null : i)}
                  className="flex items-start gap-2 w-full text-left"
                >
                  {/* Score indicator */}
                  <span
                    className={`mt-1.5 w-2 h-2 rounded-full shrink-0 ${scoreColor(signal.score)}`}
                    title={`Score: ${signal.score.toFixed(2)}`}
                  />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-text-primary leading-snug">
                      {truncate(signal.headline, 80)}
                    </p>
                    <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                      {badge && (
                        <span className={`text-xs px-1.5 py-0.5 rounded ${badge.bg} ${badge.text} font-medium`}>
                          {badge.label}
                        </span>
                      )}
                      {signal.metadata.contactName && (
                        <span className="flex items-center gap-1 text-xs text-text-secondary">
                          <User className="w-3 h-3" />
                          {signal.metadata.contactName}
                        </span>
                      )}
                      {hasDetail && !isExpanded && (
                        <ChevronRight className="w-3 h-3 text-text-secondary/50" />
                      )}
                    </div>
                  </div>
                </button>

                {/* Inline expand — steps, links, resources */}
                {isExpanded && (
                  <div className="ml-4 mt-1.5 space-y-2 border-l border-border/50 pl-3">
                    {steps.length > 0 && (
                      <div>
                        <p className="text-xs font-medium text-text-secondary mb-1">Engagement Steps</p>
                        <ol className="text-xs text-text-primary space-y-0.5 list-decimal list-inside">
                          {steps.slice(0, 5).map((s, j) => (
                            <li key={j}>
                              {s.url && s.url.startsWith('http') ? (
                                <a href={s.url} target="_blank" rel="noopener" className="text-accent hover:underline">
                                  {s.step}
                                </a>
                              ) : s.step}
                            </li>
                          ))}
                        </ol>
                      </div>
                    )}
                    {items.length > 0 && (
                      <div>
                        <p className="text-xs font-medium text-text-secondary mb-1">
                          {signal.metadata.resourceType === 'training' ? 'Training Courses' : 'Resources'}
                        </p>
                        <ul className="text-xs space-y-0.5">
                          {items.slice(0, 5).map((item, j) => (
                            <li key={j} className="flex items-center gap-1">
                              {item.url ? (
                                <a href={item.url} target="_blank" rel="noopener" className="text-accent hover:underline flex items-center gap-1">
                                  <ExternalLink className="w-3 h-3 shrink-0" />
                                  {truncate(item.name, 60)}
                                </a>
                              ) : (
                                <span className="text-text-primary">{truncate(item.name, 60)}</span>
                              )}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                    {signal.metadata.calculatorUrl && (
                      <a href={signal.metadata.calculatorUrl as string} target="_blank" rel="noopener"
                        className="inline-flex items-center gap-1 text-xs text-accent hover:underline">
                        <Wrench className="w-3 h-3" /> ROI Calculator
                      </a>
                    )}
                  </div>
                )}
              </div>
            )
          })}

          {/* Show more toggle */}
          {rest.length > 0 && !showAll && (
            <button
              onClick={() => setShowAll(true)}
              className="text-xs text-accent hover:underline mt-1"
            >
              Show {rest.length} more
            </button>
          )}
          {showAll && rest.length > 0 && (
            <button
              onClick={() => setShowAll(false)}
              className="text-xs text-accent hover:underline mt-1"
            >
              Show less
            </button>
          )}
        </div>
      )}
    </div>
  )
}
