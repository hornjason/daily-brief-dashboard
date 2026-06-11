import { useState, useEffect } from 'react'
import { Code, RefreshCw } from 'lucide-react'
import SignalWithAging from './SignalWithAging'

// ── Types (flat structured view from server — #779 Layer 3 compliance) ───────

interface TechStackItemView {
  name: string
  confidence: 'HIGH' | 'MEDIUM' | 'LOW' | 'UNKNOWN'
  context: 'using' | 'evaluating' | 'migrating_from' | 'developing' | 'unknown'
  category: 'proprietary' | 'industry-tool' | 'unknown'
  infrastructure: string[]
  redHatProducts: string[]
  detail: string
  timestamp: string
}

interface TechStackView {
  items: TechStackItemView[]
  proprietaryCount: number
  industryToolCount: number
  migratingCount: number
  evaluatingCount: number
}

interface TechStackSectionProps {
  customerName: string
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function confidenceColor(conf: string): string {
  if (conf === 'HIGH') return 'bg-success/10 text-success border-success/20'
  if (conf === 'MEDIUM') return 'bg-warning/10 text-warning border-warning/20'
  return 'bg-border/40 text-text-secondary border-border'
}

function contextLabel(ctx: string): string {
  if (ctx === 'using') return 'In Use'
  if (ctx === 'evaluating') return 'Evaluating'
  if (ctx === 'migrating_from') return 'Migrating From'
  if (ctx === 'developing') return 'Developing'
  return 'Unknown'
}

// ── Component ──────────────────────────────────────────────────────────────────

export function TechStackSection({ customerName }: TechStackSectionProps) {
  const [view, setView] = useState<TechStackView | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)

  const fetchData = async () => {
    try {
      const res = await fetch(`/api/customer/${encodeURIComponent(customerName)}/tech-stack`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json: TechStackView = await res.json()
      setView(json)
    } catch (e) {
      console.error('[TechStackSection] fetch error:', e)
      setView(null)
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }

  useEffect(() => {
    fetchData()
  }, [customerName])

  const handleRefresh = async () => {
    setRefreshing(true)
    try {
      await fetch(`/api/refresh/tech-stack?customer=${encodeURIComponent(customerName)}`, { method: 'POST' })
    } catch { /* ignore refresh errors */ }
    await fetchData()
  }

  const items = view?.items ?? []

  return (
    <div className="bg-surface border border-border rounded-xl overflow-hidden">
      <div className="px-5 py-4 border-b border-border/60 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Code className="w-4 h-4 text-accent" />
          <h2 className="text-base font-semibold text-text-primary">Technology Stack</h2>
          {!loading && items.length > 0 && (
            <span className="text-xs text-text-secondary">{items.length} detected</span>
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

        {!loading && items.length === 0 && (
          <div className="text-center py-6">
            <p className="text-sm text-text-secondary">No technology data detected.</p>
            <p className="text-xs text-text-secondary/60 mt-1">Click Refresh to scan customer intelligence, docs, and news.</p>
          </div>
        )}

        {!loading && items.length > 0 && (
          <div className="space-y-3">
            {items.map((item, i) => (
              <SignalWithAging key={i} timestamp={item.timestamp} className="bg-bg-secondary/30 border border-border/60 rounded-lg p-3 space-y-2">
                {/* Header row: name + confidence */}
                <div className="flex items-center justify-between gap-2">
                  <h3 className="text-sm font-semibold text-text-primary truncate" title={item.name}>
                    {item.name}
                  </h3>
                  <span className={`text-xs px-2 py-0.5 rounded border font-medium shrink-0 ${confidenceColor(item.confidence)}`}>
                    {item.confidence}
                  </span>
                </div>

                {/* Context + detail */}
                {item.context !== 'unknown' && (
                  <p className="text-xs text-text-secondary">
                    <span className="font-medium">{contextLabel(item.context)}</span>
                    {item.detail && <span> · {item.detail}</span>}
                  </p>
                )}

                {/* Infrastructure pills */}
                {item.infrastructure.length > 0 && (
                  <div className="flex flex-wrap items-center gap-1">
                    <span className="text-xs text-text-secondary/75 font-medium">Infrastructure:</span>
                    {item.infrastructure.map((infra, idx) => (
                      <span key={idx} className="text-xs px-1.5 py-0.5 rounded bg-border/40 text-text-primary">
                        {infra}
                      </span>
                    ))}
                  </div>
                )}

                {/* Red Hat Products pills */}
                {item.redHatProducts.length > 0 && (
                  <div className="flex flex-wrap items-center gap-1">
                    <span className="text-xs text-text-secondary/75 font-medium">Red Hat:</span>
                    {item.redHatProducts.map((product, idx) => (
                      <span key={idx} className="text-xs px-1.5 py-0.5 rounded bg-accent/10 text-accent border border-accent/20">
                        {product}
                      </span>
                    ))}
                  </div>
                )}
              </SignalWithAging>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
