import { useState, useEffect } from 'react'
import { Code, RefreshCw, Building2, Wrench, ChevronDown, ChevronRight, ExternalLink } from 'lucide-react'
import SignalWithAging from '../SignalWithAging'

// ── Types ──────────────────────────────────────────────────────────────────────

interface TechSignal {
  source: string
  type: string
  headline: string
  detail: string
  timestamp: string
  metadata: {
    category?: 'proprietary' | 'industry-tool'
    context?: 'using' | 'evaluating' | 'migrating_from' | 'developing'
    infrastructure?: string[]
    redHatProducts?: string[]
    confidence?: 'HIGH' | 'MEDIUM' | 'LOW'
    why?: string
    source?: string
    solutionPlayId?: string
    solutionPlayName?: string
    solutionTdp?: string
    valueProps?: string[]
  }
}

interface TechStackTabProps {
  customerName: string
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function confidenceColor(conf: string | undefined): string {
  if (conf === 'HIGH') return 'bg-success/10 text-success border-success/20'
  if (conf === 'MEDIUM') return 'bg-warning/10 text-warning border-warning/20'
  return 'bg-border/40 text-text-secondary border-border'
}

function contextLabel(ctx: string | undefined): string {
  if (ctx === 'using') return 'Using'
  if (ctx === 'evaluating') return 'Evaluating'
  if (ctx === 'migrating_from') return 'Migrating From'
  if (ctx === 'developing') return 'Developing'
  return 'Unknown'
}

function contextColor(ctx: string | undefined): string {
  if (ctx === 'evaluating') return 'bg-warning/10 text-warning border-warning/20'
  if (ctx === 'migrating_from') return 'bg-error/10 text-error border-error/20'
  if (ctx === 'developing') return 'bg-accent/10 text-accent border-accent/20'
  return 'bg-border/40 text-text-secondary border-border'
}

// ── Tier 2 Card (Proprietary) ─────────────────────────────────────────────────

function ProprietaryTechCard({ signal }: { signal: TechSignal }) {
  const techName = signal.headline.split(' (')[0] || signal.headline
  const { confidence, context, infrastructure, redHatProducts } = signal.metadata
  const positioning = signal.detail.split('Red Hat positioning:')[1]?.trim() || ''
  const description = signal.detail.split('Red Hat positioning:')[0]?.trim() || signal.detail

  return (
    <SignalWithAging timestamp={signal.timestamp} className="bg-surface border border-border rounded-xl p-4 space-y-3">
      {/* Header: name + confidence badge */}
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-base font-semibold text-text-primary">{techName}</h3>
        <span className={`text-xs px-2 py-0.5 rounded border font-medium shrink-0 ${confidenceColor(confidence)}`}>
          {confidence ?? 'UNKNOWN'}
        </span>
      </div>

      {/* Context badge */}
      {context && (
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-text-secondary">Status:</span>
          <span className="text-xs px-2 py-0.5 rounded bg-accent/10 text-accent border border-accent/20">
            {contextLabel(context)}
          </span>
        </div>
      )}

      {/* Description */}
      {description && (
        <p className="text-sm text-text-primary leading-relaxed">{description}</p>
      )}

      {/* Red Hat Positioning */}
      {positioning && (
        <div className="bg-accent/5 border border-accent/20 rounded-lg p-3">
          <p className="text-xs font-semibold text-accent mb-1">Red Hat Positioning</p>
          <p className="text-sm text-text-primary leading-relaxed">{positioning}</p>
        </div>
      )}

      {/* Infrastructure dependencies */}
      {infrastructure && infrastructure.length > 0 && (
        <div className="space-y-1">
          <p className="text-xs font-semibold text-text-secondary">Infrastructure Dependencies</p>
          <div className="flex flex-wrap gap-1">
            {infrastructure.map((infra, idx) => (
              <span key={idx} className="text-xs px-2 py-0.5 rounded bg-border/40 text-text-primary border border-border">
                {infra}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Red Hat Products */}
      {redHatProducts && redHatProducts.length > 0 && (
        <div className="space-y-1">
          <p className="text-xs font-semibold text-text-secondary">Complementary Red Hat Products</p>
          <div className="flex flex-wrap gap-1">
            {redHatProducts.map((product, idx) => (
              <span key={idx} className="text-xs px-2 py-0.5 rounded bg-success/10 text-success border border-success/20 uppercase font-medium">
                {product}
              </span>
            ))}
          </div>
        </div>
      )}
    </SignalWithAging>
  )
}

// ── Tier 1 Row (Industry Tools) ───────────────────────────────────────────────

function IndustryToolRow({ signal }: { signal: TechSignal }) {
  const [expanded, setExpanded] = useState(false)
  const techName = signal.headline.split(' (')[0] || signal.headline
  const { confidence, context, why, source, redHatProducts, infrastructure } = signal.metadata
  const description = signal.detail.split('Red Hat positioning:')[0]?.trim() || signal.detail
  const hasExpandContent = !!(why || (source && source.startsWith('http')) || description || (redHatProducts && redHatProducts.length > 0) || (infrastructure && infrastructure.length > 0))

  return (
    <SignalWithAging timestamp={signal.timestamp} showTimestamp={!expanded} className="border-b border-border/40 last:border-0">
      {/* Compact row — always visible */}
      <button
        type="button"
        onClick={() => hasExpandContent && setExpanded(!expanded)}
        className={`flex items-center justify-between py-2 w-full text-left ${hasExpandContent ? 'cursor-pointer hover:bg-border/20 -mx-2 px-2 rounded transition-colors' : 'cursor-default'}`}
      >
        <div className="flex items-center gap-2 flex-1 min-w-0">
          {hasExpandContent && (
            expanded
              ? <ChevronDown className="w-3.5 h-3.5 text-text-secondary shrink-0" />
              : <ChevronRight className="w-3.5 h-3.5 text-text-secondary shrink-0" />
          )}
          <span className="text-sm font-medium text-text-primary truncate" title={techName}>{techName}</span>
          {context && (
            <span className={`text-xs px-1.5 py-0.5 rounded border shrink-0 ${contextColor(context)}`}>
              {contextLabel(context)}
            </span>
          )}
        </div>
        <span className={`text-xs px-2 py-0.5 rounded border font-medium shrink-0 ${confidenceColor(confidence)}`}>
          {confidence ?? 'UNKNOWN'}
        </span>
      </button>

      {/* Expanded detail */}
      {expanded && (
        <div className="bg-surface border border-border rounded-xl p-4 mb-2 space-y-3">
          {why && (
            <div>
              <p className="text-xs font-semibold text-text-secondary mb-0.5">Why</p>
              <p className="text-sm text-text-primary leading-relaxed">{why}</p>
            </div>
          )}

          {source && source.startsWith('http') && (
            <div>
              <p className="text-xs font-semibold text-text-secondary mb-0.5">Source</p>
              <a
                href={source}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-sm text-accent hover:text-accent/80 hover:underline transition-colors"
              >
                <ExternalLink className="w-3.5 h-3.5" />
                {new URL(source).hostname}
              </a>
            </div>
          )}

          {description && (
            <div>
              <p className="text-xs font-semibold text-text-secondary mb-0.5">Description</p>
              <p className="text-sm text-text-primary leading-relaxed">{description}</p>
            </div>
          )}

          {redHatProducts && redHatProducts.length > 0 && (
            <div className="space-y-1">
              <p className="text-xs font-semibold text-text-secondary">Red Hat Products</p>
              <div className="flex flex-wrap gap-1">
                {redHatProducts.map((product, idx) => (
                  <span key={idx} className="text-xs px-2 py-0.5 rounded bg-success/10 text-success border border-success/20 uppercase font-medium">
                    {product}
                  </span>
                ))}
              </div>
            </div>
          )}

          {infrastructure && infrastructure.length > 0 && (
            <div className="space-y-1">
              <p className="text-xs font-semibold text-text-secondary">Infrastructure</p>
              <div className="flex flex-wrap gap-1">
                {infrastructure.map((infra, idx) => (
                  <span key={idx} className="text-xs px-2 py-0.5 rounded bg-border/40 text-text-primary border border-border">
                    {infra}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </SignalWithAging>
  )
}

// ── Main Component ─────────────────────────────────────────────────────────────

export function TechStackTab({ customerName }: TechStackTabProps) {
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
      console.error('[TechStackTab] fetch error:', e)
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

  // Separate Tier 1 (industry tools) and Tier 2 (proprietary)
  const proprietaryTech = signals.filter(s => s.metadata.category === 'proprietary')
  const industryTools = signals.filter(s => s.metadata.category === 'industry-tool')

  return (
    <div className="min-h-screen bg-bg p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Code className="w-5 h-5 text-accent" />
          <h1 className="text-xl font-bold text-text-primary">Technology Stack</h1>
          {!loading && signals.length > 0 && (
            <span className="text-sm text-text-secondary">
              {proprietaryTech.length} proprietary · {industryTools.length} industry tools
            </span>
          )}
        </div>
        <button
          onClick={handleRefresh}
          disabled={refreshing}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-border text-sm text-text-secondary hover:text-text-primary hover:border-text-secondary transition-all disabled:opacity-50"
        >
          <RefreshCw className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} />
          {refreshing ? 'Scanning...' : 'Refresh'}
        </button>
      </div>

      {/* Loading state */}
      {loading && (
        <div className="space-y-6">
          <div className="space-y-3">
            <div className="bg-border/40 rounded-lg h-6 w-48 animate-pulse-slow" />
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              {[1, 2, 3, 4].map((i) => (
                <div key={i} className="bg-border/40 rounded-xl h-48 animate-pulse-slow" />
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Empty state */}
      {!loading && signals.length === 0 && (
        <div className="bg-surface border border-border rounded-xl p-12 text-center">
          <Code className="w-12 h-12 text-text-secondary/50 mx-auto mb-3" />
          <p className="text-base text-text-primary mb-1">No technology data detected</p>
          <p className="text-sm text-text-secondary">Click Refresh to scan customer intelligence, documents, and news.</p>
        </div>
      )}

      {/* Tier 2: Proprietary Technologies */}
      {!loading && proprietaryTech.length > 0 && (
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <Building2 className="w-4 h-4 text-accent" />
            <h2 className="text-lg font-semibold text-text-primary">Proprietary Technologies</h2>
            <span className="text-xs text-text-secondary">Customer-specific or custom-built</span>
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {proprietaryTech.map((signal, i) => (
              <ProprietaryTechCard key={i} signal={signal} />
            ))}
          </div>
        </div>
      )}

      {/* Tier 1: Industry Tools */}
      {!loading && industryTools.length > 0 && (
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <Wrench className="w-4 h-4 text-text-secondary" />
            <h2 className="text-lg font-semibold text-text-primary">Industry Tools</h2>
            <span className="text-xs text-text-secondary">Widely-used platforms & tools</span>
          </div>
          <div className="bg-surface border border-border rounded-xl p-4">
            {industryTools.map((signal, i) => (
              <IndustryToolRow key={i} signal={signal} />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
