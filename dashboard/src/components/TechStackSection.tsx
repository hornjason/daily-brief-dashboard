import { useState, useEffect } from 'react'
import { Code, RefreshCw } from 'lucide-react'

// ── Types ──────────────────────────────────────────────────────────────────────

interface TechSignal {
  source: string
  type: string
  headline: string
  detail: string
  metadata: {
    category?: 'proprietary' | 'industry-tool'
    context?: 'using' | 'evaluating' | 'migrating_from' | 'developing'
    infrastructure?: string[]
    redHatProducts?: string[]
    confidence?: 'HIGH' | 'MEDIUM' | 'LOW'
  }
}

interface TechStackSectionProps {
  customerName: string
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function confidenceColor(conf: string | undefined): string {
  if (conf === 'HIGH') return 'bg-success/10 text-success border-success/20'
  if (conf === 'MEDIUM') return 'bg-warning/10 text-warning border-warning/20'
  return 'bg-border/40 text-text-secondary border-border'
}

function contextLabel(ctx: string | undefined): string {
  if (ctx === 'using') return 'In Use'
  if (ctx === 'evaluating') return 'Evaluating'
  if (ctx === 'migrating_from') return 'Migrating From'
  if (ctx === 'developing') return 'Developing'
  return 'Unknown'
}

// ── Component ──────────────────────────────────────────────────────────────────

export function TechStackSection({ customerName }: TechStackSectionProps) {
  const [signals, setSignals] = useState<TechSignal[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)

  const fetchSignals = async () => {
    try {
      const res = await fetch(`/api/customer/${encodeURIComponent(customerName)}/signals/debug`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = await res.json()
      // Filter to tech-stack source only
      const techSignals = (json.signals ?? []).filter((s: TechSignal) => s.source === 'tech-stack')
      setSignals(techSignals)
    } catch (e) {
      console.error('[TechStackSection] fetch error:', e)
      setSignals([])
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }

  useEffect(() => {
    fetchSignals()
  }, [customerName])

  const handleRefresh = async () => {
    setRefreshing(true)
    // Trigger module refresh
    try {
      await fetch(`/api/refresh/tech-stack?customer=${encodeURIComponent(customerName)}`, { method: 'POST' })
    } catch { /* ignore refresh errors */ }
    // Re-fetch signals
    await fetchSignals()
  }

  return (
    <div className="bg-surface border border-border rounded-xl overflow-hidden">
      <div className="px-5 py-4 border-b border-border/60 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Code className="w-4 h-4 text-accent" />
          <h2 className="text-base font-semibold text-text-primary">Technology Stack</h2>
          {!loading && signals.length > 0 && (
            <span className="text-xs text-text-secondary">{signals.length} detected</span>
          )}
        </div>
        <button
          onClick={handleRefresh}
          disabled={refreshing}
          className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg border border-border text-xs text-text-secondary hover:text-text-primary hover:border-text-secondary transition-all disabled:opacity-50"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? 'animate-spin' : ''}`} />
          {refreshing ? 'Scanning...' : 'Refresh'}
        </button>
      </div>

      <div className="px-5 py-4">
        {loading && (
          <div className="space-y-3">
            {[1, 2, 3].map((i) => (
              <div key={i} className="bg-border/40 rounded-lg h-16 animate-pulse-slow" />
            ))}
          </div>
        )}

        {!loading && signals.length === 0 && (
          <div className="text-center py-6">
            <p className="text-sm text-text-secondary">No technology data detected.</p>
            <p className="text-xs text-text-secondary/60 mt-1">Click Refresh to scan customer intelligence, docs, and news.</p>
          </div>
        )}

        {!loading && signals.length > 0 && (
          <div className="space-y-3">
            {signals.map((signal, i) => {
              // Parse technology name from headline
              const techName = signal.headline.split(' (')[0] || signal.headline
              const { confidence, context, infrastructure, redHatProducts } = signal.metadata

              return (
                <div key={i} className="bg-bg-secondary/30 border border-border/60 rounded-lg p-3 space-y-2">
                  {/* Header row: name + confidence */}
                  <div className="flex items-center justify-between gap-2">
                    <h3 className="text-sm font-semibold text-text-primary truncate" title={techName}>
                      {techName}
                    </h3>
                    <span className={`text-xs px-2 py-0.5 rounded border font-medium shrink-0 ${confidenceColor(confidence)}`}>
                      {confidence ?? 'UNKNOWN'}
                    </span>
                  </div>

                  {/* Context + detail */}
                  {context && (
                    <p className="text-xs text-text-secondary">
                      <span className="font-medium">{contextLabel(context)}</span>
                      {signal.detail && <span> · {signal.detail}</span>}
                    </p>
                  )}

                  {/* Infrastructure pills */}
                  {infrastructure && infrastructure.length > 0 && (
                    <div className="flex flex-wrap items-center gap-1">
                      <span className="text-xs text-text-secondary/75 font-medium">Infrastructure:</span>
                      {infrastructure.map((infra, idx) => (
                        <span key={idx} className="text-xs px-1.5 py-0.5 rounded bg-border/40 text-text-primary">
                          {infra}
                        </span>
                      ))}
                    </div>
                  )}

                  {/* Red Hat Products pills */}
                  {redHatProducts && redHatProducts.length > 0 && (
                    <div className="flex flex-wrap items-center gap-1">
                      <span className="text-xs text-text-secondary/75 font-medium">Red Hat:</span>
                      {redHatProducts.map((product, idx) => (
                        <span key={idx} className="text-xs px-1.5 py-0.5 rounded bg-accent/10 text-accent border border-accent/20">
                          {product}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
