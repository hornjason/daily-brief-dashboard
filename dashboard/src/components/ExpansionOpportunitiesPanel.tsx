import { useState, useEffect } from 'react'
import { TrendingUp, RefreshCw, ChevronDown, ChevronUp, AlertCircle } from 'lucide-react'
import { formatRelTime } from '../lib/format'
import { usePolledStatus } from '../hooks/usePolledStatus'
import type { ExpansionRecommendation, ExpansionOpportunitiesResult } from '../../../src/expansion-opportunities'

interface ExpansionOpportunitiesPanelProps {
  customerName: string
}

interface ExpansionResponse {
  customerName?: string
  recommendations?: ExpansionRecommendation[]
  generatedAt?: string
  allProductsCovered?: boolean
  error?: string
}

export function ExpansionOpportunitiesPanel({ customerName }: ExpansionOpportunitiesPanelProps) {
  const [collapsed, setCollapsed] = useState(true)
  const [data, setData] = useState<ExpansionOpportunitiesResult | null>(null)
  const [generating, setGenerating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [expandedCards, setExpandedCards] = useState<Set<number>>(new Set())

  // Fetch current state on mount
  useEffect(() => {
    if (!customerName) return
    fetch(`/api/customers/${encodeURIComponent(customerName)}/expansion-opportunities`)
      .then(r => {
        if (!r.ok) return null
        return r.json()
      })
      .then((d: ExpansionResponse | null) => {
        if (d && d.recommendations) {
          setData({
            customerName: d.customerName ?? customerName,
            recommendations: d.recommendations,
            generatedAt: d.generatedAt ?? new Date().toISOString(),
            allProductsCovered: d.allProductsCovered ?? false,
          })
        }
      })
      .catch(() => {})
  }, [customerName])

  // Poll for updates during generation
  const { data: polledData } = usePolledStatus<ExpansionResponse>(
    `/api/customers/${encodeURIComponent(customerName)}/expansion-opportunities`,
    {
      intervalMs: 3000,
      enabled: generating,
      until: d => !!d?.recommendations,
    },
  )

  useEffect(() => {
    if (!polledData?.recommendations) return
    setData({
      customerName: polledData.customerName ?? customerName,
      recommendations: polledData.recommendations,
      generatedAt: polledData.generatedAt ?? new Date().toISOString(),
      allProductsCovered: polledData.allProductsCovered ?? false,
    })
    setGenerating(false)
  }, [polledData, customerName])

  async function handleGenerate() {
    setGenerating(true)
    setError(null)
    try {
      const res = await fetch(
        `/api/customers/${encodeURIComponent(customerName)}/expansion-opportunities`,
        { method: 'POST' }
      )
      let respData: any
      try {
        respData = await res.json()
      } catch {
        setError(`Server error (${res.status} ${res.statusText}) — check server logs`)
        setGenerating(false)
        return
      }
      if (respData.ok || respData.recommendations) {
        // Generation complete
        if (respData.recommendations) {
          setData({
            customerName: respData.customerName ?? customerName,
            recommendations: respData.recommendations,
            generatedAt: respData.generatedAt ?? new Date().toISOString(),
            allProductsCovered: respData.allProductsCovered ?? false,
          })
          setGenerating(false)
        }
      } else if (respData.error) {
        setError(respData.error)
        setGenerating(false)
      } else {
        setError(`Unexpected response from server (status ${res.status})`)
        setGenerating(false)
      }
    } catch (e: any) {
      setError(`Network error: ${e?.message ?? 'Could not reach server'}`)
      setGenerating(false)
    }
  }

  function toggleCard(index: number) {
    setExpandedCards(prev => {
      const next = new Set(prev)
      if (next.has(index)) {
        next.delete(index)
      } else {
        next.add(index)
      }
      return next
    })
  }

  function getConfidenceColor(confidence: 'HIGH' | 'MEDIUM' | 'LOW'): string {
    switch (confidence) {
      case 'HIGH':
        return 'text-green-500'
      case 'MEDIUM':
        return 'text-yellow-500'
      case 'LOW':
        return 'text-gray-400'
      default:
        return 'text-gray-400'
    }
  }

  const hasData = data && data.recommendations && data.recommendations.length > 0

  return (
    <div className="bg-surface border border-border rounded-xl overflow-hidden">
      <button
        onClick={() => setCollapsed(v => !v)}
        aria-expanded={!collapsed}
        className="w-full px-5 py-4 flex items-center justify-between border-b border-border/60 hover:bg-surface-hover transition-colors"
      >
        <div className="flex items-center gap-2">
          <TrendingUp className="w-4 h-4 text-accent" />
          <h3 className="text-sm font-semibold text-text-primary">Expansion Opportunities</h3>
          {generating && (
            <RefreshCw className="w-3.5 h-3.5 animate-spin text-accent" />
          )}
        </div>
        {collapsed
          ? <ChevronDown className="w-3.5 h-3.5 text-text-secondary" />
          : <ChevronUp className="w-3.5 h-3.5 text-text-secondary" />
        }
      </button>

      {!collapsed && (
        <div className="px-5 py-4 space-y-3">
          {/* Generating state */}
          {generating && (
            <div className="flex items-center gap-2 text-xs text-text-secondary">
              <RefreshCw className="w-3.5 h-3.5 animate-spin text-accent" />
              <span>Analyzing expansion opportunities...</span>
            </div>
          )}

          {/* Error state */}
          {error && !generating && (
            <div className="flex items-start gap-2 p-3 bg-red-500/10 border border-red-500/20 rounded-lg">
              <AlertCircle className="w-4 h-4 text-red-500 flex-shrink-0 mt-0.5" />
              <div className="text-xs text-red-400">{error}</div>
            </div>
          )}

          {/* Empty state */}
          {!hasData && !generating && !error && (
            <div className="text-xs text-text-secondary text-center py-4">
              No expansion opportunities available
            </div>
          )}

          {/* Data display */}
          {hasData && !generating && (
            <div className="space-y-3">
              <div className="flex items-center justify-between text-xs text-text-secondary">
                <span>{data.recommendations.length} recommendation{data.recommendations.length === 1 ? '' : 's'}</span>
                {data.generatedAt && (
                  <span className="text-text-tertiary">
                    Generated {formatRelTime(data.generatedAt)}
                  </span>
                )}
              </div>

              {/* Recommendation cards */}
              <div className="space-y-2">
                {data.recommendations.map((rec, idx) => {
                  const isExpanded = expandedCards.has(idx)
                  const displayFeatures = isExpanded ? rec.features : rec.features.slice(0, 3)
                  const hasMoreFeatures = rec.features.length > 3

                  return (
                    <div
                      key={idx}
                      className="border border-border rounded-lg overflow-hidden"
                    >
                      <button
                        onClick={() => toggleCard(idx)}
                        className="w-full px-4 py-3 flex items-start justify-between hover:bg-surface-hover transition-colors"
                      >
                        <div className="flex items-start gap-3 flex-1">
                          <div className={`mt-0.5 ${getConfidenceColor(rec.confidence)}`}>
                            <TrendingUp className="w-4 h-4" />
                          </div>
                          <div className="flex-1 text-left">
                            {rec.productSlug ? (
                              <a
                                href={`/dashboard/products/${rec.productSlug}`}
                                className="text-sm font-semibold text-accent hover:underline"
                                onClick={e => e.stopPropagation()}
                              >
                                {rec.product}
                              </a>
                            ) : (
                              <div className="text-sm font-semibold text-text-primary">
                                {rec.product}
                              </div>
                            )}
                            <div className="text-xs text-text-secondary mt-1">
                              {rec.why}
                            </div>
                          </div>
                        </div>
                        {isExpanded
                          ? <ChevronUp className="w-3.5 h-3.5 text-text-secondary flex-shrink-0 mt-1" />
                          : <ChevronDown className="w-3.5 h-3.5 text-text-secondary flex-shrink-0 mt-1" />
                        }
                      </button>

                      {/* Features list (visible when expanded OR showing first 3) */}
                      {displayFeatures.length > 0 && (
                        <div className="px-4 pb-3 pl-11">
                          <ul className="text-xs text-text-tertiary space-y-1">
                            {displayFeatures.map((feature, fidx) => (
                              <li key={fidx} className="flex items-start gap-2">
                                <span className="text-accent">•</span>
                                <span>{feature}</span>
                              </li>
                            ))}
                          </ul>
                          {!isExpanded && hasMoreFeatures && (
                            <div className="text-xs text-text-tertiary mt-1">
                              + {rec.features.length - 3} more feature{rec.features.length - 3 === 1 ? '' : 's'}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          {/* Action buttons */}
          <div className="flex items-center gap-2 pt-2">
            <button
              onClick={handleGenerate}
              disabled={generating}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-accent/10 hover:bg-accent/20 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${generating ? 'animate-spin' : ''}`} />
              <span className="text-xs font-medium text-accent">
                {generating ? 'Generating...' : 'Refresh'}
              </span>
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
