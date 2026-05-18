// Route: /dashboard/products/:slug
// Full drill-down view for a single product — Issue #249 enhancements:
// - "What's New" Gemini-synthesized sales talking points
// - Release Notes link to official Red Hat docs
// - Feature list grouped by status (GA, Tech Preview, Deprecated)

import { useState, useEffect, useMemo, useCallback } from 'react'
import { useParams, Link } from 'react-router-dom'
import { ExternalLink, RefreshCw, Sparkles, ChevronRight } from 'lucide-react'
import type { ProductSummary, ProductAlert } from '../components/ProductCard'
import { getReleaseNotesUrl } from '../lib/release-notes-url'
import { useAction } from '../hooks/useAction'

interface WhatsNewData {
  summary: string[]
  version: string
  generatedAt: string
  cached: boolean
}

interface ProductFeature {
  id: string
  name: string
  status: 'GA' | 'Tech Preview' | 'Roadmap' | 'Deprecated'
  description: string
  enrichedDescription: string | null
  versionIntroduced: string | null
  versionCurrent: string | null
  sourceUrls: string[]
  tags: string[]
  confidence: string
}

interface FeatureCache {
  slug: string
  displayName: string
  features: ProductFeature[]
  extractedAt: string
  enrichedAt: string | null
}

export function ProductDetailPage() {
  const { slug } = useParams<{ slug: string }>()

  const [summary, setSummary] = useState<ProductSummary | null>(null)
  const [alert, setAlert] = useState<ProductAlert | null>(null)
  const [whatsNew, setWhatsNew] = useState<WhatsNewData | null>(null)
  const [features, setFeatures] = useState<FeatureCache | null>(null)
  const [expandedFeatures, setExpandedFeatures] = useState<Set<string>>(new Set())

  const [summaryLoading, setSummaryLoading] = useState(true)
  const [summaryError, setSummaryError] = useState<string | null>(null)
  const [whatsNewLoading, setWhatsNewLoading] = useState(false)
  const [whatsNewError, setWhatsNewError] = useState<string | null>(null)

  const [acknowledging, setAcknowledging] = useState(false)
  const ackAction = useAction()

  const toggleFeature = useCallback((id: string) => {
    setExpandedFeatures(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  // Fetch product summary
  useEffect(() => {
    if (!slug) return
    setSummaryLoading(true)
    setSummaryError(null)
    fetch(`/api/products/${slug}`)
      .then(async res => {
        if (!res.ok) {
          const d = await res.json().catch(() => ({}))
          throw new Error(d.error ?? `HTTP ${res.status}`)
        }
        return res.json() as Promise<ProductSummary>
      })
      .then(data => setSummary(data))
      .catch(e => setSummaryError(e?.message ?? 'Failed to load product'))
      .finally(() => setSummaryLoading(false))
  }, [slug])

  // Fetch alerts
  useEffect(() => {
    if (!slug) return
    fetch('/api/products/alerts')
      .then(async res => {
        if (!res.ok) return
        const alerts: ProductAlert[] = await res.json()
        const match = alerts.find(a => a.slug === slug && !a.acknowledged)
        setAlert(match ?? null)
      })
      .catch(() => {})
  }, [slug])

  // Fetch What's New data
  useEffect(() => {
    if (!slug) return
    setWhatsNewLoading(true)
    setWhatsNewError(null)
    fetch(`/api/products/${slug}/whats-new`)
      .then(async res => {
        if (!res.ok) {
          if (res.status === 404) return null // No feature data yet — not an error
          const d = await res.json().catch(() => ({}))
          throw new Error(d.error ?? `HTTP ${res.status}`)
        }
        return res.json() as Promise<WhatsNewData>
      })
      .then(data => setWhatsNew(data))
      .catch(e => setWhatsNewError(e?.message ?? 'Failed to load'))
      .finally(() => setWhatsNewLoading(false))
  }, [slug])

  // Fetch feature cache
  useEffect(() => {
    if (!slug) return
    fetch(`/api/products/${slug}/features`)
      .then(async res => {
        if (!res.ok) return
        return res.json() as Promise<FeatureCache>
      })
      .then(data => { if (data) setFeatures(data) })
      .catch(() => {})
  }, [slug])

  // Group features by status
  const groupedFeatures = useMemo(() => {
    if (!features?.features) return null
    const groups: Record<string, ProductFeature[]> = {
      'GA': [],
      'Tech Preview': [],
      'Deprecated': [],
    }
    for (const f of features.features) {
      const status = f.status
      if (status in groups) {
        groups[status].push(f)
      } else {
        // Roadmap or unknown — skip from display
      }
    }
    return groups
  }, [features])

  // Release notes URL
  const releaseNotesUrl = useMemo(() => {
    if (!slug || !summary?.currentVersion) return null
    return getReleaseNotesUrl(slug, summary.currentVersion)
  }, [slug, summary?.currentVersion])

  async function handleRegenerateWhatsNew() {
    if (!slug) return
    setWhatsNewLoading(true)
    setWhatsNewError(null)
    try {
      const res = await fetch(`/api/products/${slug}/whats-new?refresh=true`)
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d.error ?? `HTTP ${res.status}`)
      }
      const data: WhatsNewData = await res.json()
      setWhatsNew(data)
    } catch (e: any) {
      setWhatsNewError(e?.message ?? 'Failed to regenerate')
    } finally {
      setWhatsNewLoading(false)
    }
  }

  async function handleAcknowledge() {
    if (!alert) return
    setAcknowledging(true)
    const result = await ackAction.execute(`/api/products/alerts/${alert.id}/acknowledge`, { method: 'POST' })
    if (result) setAlert(null)
    setAcknowledging(false)
  }

  if (summaryLoading) {
    return (
      <div className="flex-1 text-text-primary overflow-y-auto">
        <div className="px-6 py-10">
          <div className="animate-pulse space-y-4">
            <div className="h-4 bg-surface rounded w-32" />
            <div className="h-8 bg-surface rounded w-64" />
            <div className="h-4 bg-surface rounded w-48" />
            <div className="h-24 bg-surface rounded" />
          </div>
        </div>
      </div>
    )
  }

  if (summaryError || !summary) {
    return (
      <div className="flex-1 text-text-primary overflow-y-auto">
        <div className="px-6 py-10">
          <p className="text-critical text-sm">{summaryError ?? 'Product not found.'}</p>
          <Link to="/dashboard/products" className="text-accent text-sm hover:underline mt-2 inline-block">
            Back to Products
          </Link>
        </div>
      </div>
    )
  }

  /** Render a list of features with expand/collapse + optional source link */
  function FeatureRow({ f }: { f: ProductFeature }) {
    const hasLink = f.sourceUrls?.length > 0 && /^https?:\/\//.test(f.sourceUrls[0])
    return (
      <li>
        <div className="flex items-center gap-2 text-sm w-full text-left py-1 group">
          <button
            onClick={() => toggleFeature(f.id)}
            className="shrink-0 p-0 bg-transparent border-0 cursor-pointer"
            aria-label={expandedFeatures.has(f.id) ? 'Collapse' : 'Expand'}
          >
            <ChevronRight className={`w-3.5 h-3.5 text-text-secondary transition-transform ${expandedFeatures.has(f.id) ? 'rotate-90' : ''}`} />
          </button>
          {hasLink ? (
            <a
              href={f.sourceUrls[0]}
              target="_blank"
              rel="noopener noreferrer"
              className="text-accent font-medium hover:underline flex items-center gap-1"
              onClick={e => e.stopPropagation()}
            >
              {f.name}
              <ExternalLink className="w-3 h-3 opacity-50" />
            </a>
          ) : (
            <button
              onClick={() => toggleFeature(f.id)}
              className="text-accent font-medium group-hover:underline bg-transparent border-0 cursor-pointer text-left p-0"
            >
              {f.name}
            </button>
          )}
        </div>
        {expandedFeatures.has(f.id) && f.description && (
          <p className="text-sm text-text-secondary ml-[22px] pb-2">{f.description}</p>
        )}
      </li>
    )
  }

  function FeatureGroup({ features, expandedFeatures: _ef, toggleFeature: _tf }: {
    features: ProductFeature[]
    expandedFeatures: Set<string>
    toggleFeature: (id: string) => void
  }) {
    return (
      <ul className="space-y-1">
        {features.map(f => <FeatureRow key={f.id} f={f} />)}
      </ul>
    )
  }

  return (
    <div className="min-h-screen bg-bg text-text-primary">
      <div className="px-6 py-10 space-y-8">

        {/* Breadcrumb */}
        <nav className="text-sm text-text-secondary flex items-center gap-1.5">
          <Link to="/dashboard/products" className="hover:text-accent transition-colors">Products</Link>
          <span>/</span>
          <span className="text-text-primary">{summary.shortName}</span>
        </nav>

        {/* Header */}
        <div>
          <div className="flex items-center gap-3 flex-wrap">
            <h1 className="text-2xl font-bold text-text-primary">{summary.shortName}</h1>
            {summary.currentVersion && (
              <span className="bg-surface-hover text-text-secondary border border-border text-xs px-2 py-0.5 rounded-full font-mono">
                v{summary.currentVersion}
              </span>
            )}
          </div>
          <p className="text-text-secondary mt-1">{summary.displayName}</p>
          {(summary.gaDate || summary.eolDate) && (
            <p className="text-xs text-text-secondary mt-1.5">
              {summary.gaDate && <span>GA: {summary.gaDate}</span>}
              {summary.gaDate && summary.eolDate && <span className="mx-1.5">|</span>}
              {summary.eolDate && <span>EOL: {summary.eolDate}</span>}
            </p>
          )}
        </div>

        {/* Alert banner */}
        {alert && (
          <div className="bg-amber-900/30 border border-amber-700/50 rounded-lg px-4 py-3 flex items-center justify-between gap-4">
            <div>
              <p className="text-amber-400 font-medium text-sm">New version detected: {alert.version}</p>
              <p className="text-amber-300/70 text-xs mt-0.5">Detected {new Date(alert.detectedAt).toLocaleDateString()}</p>
            </div>
            <div className="shrink-0">
              <button
                onClick={handleAcknowledge}
                disabled={acknowledging}
                className="bg-amber-700 hover:bg-amber-600 disabled:opacity-50 text-white px-3 py-1 rounded text-xs font-medium transition-colors"
              >
                {acknowledging ? 'Acknowledging...' : 'Acknowledge'}
              </button>
              {ackAction.error && <p className="text-xs text-warning mt-1">{ackAction.error}</p>}
            </div>
          </div>
        )}

        {/* What's New section — Issue #249 */}
        <section className="space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-text-secondary uppercase tracking-wide flex items-center gap-2">
              <Sparkles className="w-4 h-4 text-accent" />
              What's New in v{whatsNew?.version ?? summary.currentVersion ?? ''}
            </h2>
            <button
              onClick={handleRegenerateWhatsNew}
              disabled={whatsNewLoading}
              className="text-xs text-text-secondary hover:text-text-primary transition-colors disabled:opacity-50 flex items-center gap-1"
              title="Regenerate talking points"
            >
              <RefreshCw className={`w-3 h-3 ${whatsNewLoading ? 'animate-spin' : ''}`} />
              Regenerate
            </button>
          </div>

          {whatsNewLoading && !whatsNew && (
            <div className="animate-pulse space-y-2">
              <div className="h-3 bg-surface rounded w-full" />
              <div className="h-3 bg-surface rounded w-5/6" />
              <div className="h-3 bg-surface rounded w-4/6" />
            </div>
          )}

          {whatsNewError && (
            <p className="text-xs text-text-secondary italic">Summary unavailable — click Regenerate to retry</p>
          )}

          {whatsNew && whatsNew.summary.length > 0 && (
            <ul className="space-y-3">
              {whatsNew.summary.map((point, i) => {
                // Parse **Feature Name**: description pattern
                const boldMatch = point.match(/^\*\*(.+?)\*\*[:\s]*(.*)/)
                // Also handle "Feature Name:" without markdown bold
                const colonMatch = !boldMatch ? point.match(/^([^:]{5,60}):\s*(.+)/) : null
                const featureName = boldMatch?.[1] || colonMatch?.[1] || null
                const description = boldMatch?.[2] || colonMatch?.[2] || point

                return (
                  <li key={i} className="flex gap-2 text-sm leading-relaxed">
                    <span className="text-accent shrink-0 mt-0.5">•</span>
                    <span>
                      {featureName && (
                        <span className="font-semibold text-accent">{featureName}: </span>
                      )}
                      <span className="text-text-primary">{description}</span>
                    </span>
                  </li>
                )
              })}
            </ul>
          )}

          {whatsNew && whatsNew.summary.length === 0 && !whatsNewLoading && (
            <p className="text-xs text-text-secondary italic">Summary unavailable — click Regenerate to retry</p>
          )}

          {whatsNew?.cached && (
            <p className="text-xs text-text-secondary">Cached result</p>
          )}
        </section>

        {/* Release Notes link — Issue #249 */}
        {releaseNotesUrl && (
          <a
            href={releaseNotesUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-2 bg-surface hover:bg-surface-hover border border-border rounded-lg px-4 py-3 text-sm text-accent hover:text-accent transition-colors group"
          >
            <ExternalLink className="w-4 h-4 shrink-0" />
            <span className="font-medium">View Official Release Notes</span>
            <span className="text-text-secondary ml-auto group-hover:translate-x-0.5 transition-transform">&rarr;</span>
          </a>
        )}

        {/* Feature list grouped by status — Issue #249 */}
        {groupedFeatures && (
          <section className="space-y-4">
            <div className="flex items-center gap-3 flex-wrap">
              <h2 className="text-sm font-semibold text-text-secondary uppercase tracking-wide">Features</h2>
              {Object.entries(groupedFeatures).map(([status, list]) =>
                list.length > 0 ? (
                  <span
                    key={status}
                    className={`text-xs px-2 py-0.5 rounded-full border ${
                      status === 'GA'
                        ? 'border-green-700/50 text-green-400 bg-green-900/20'
                        : status === 'Tech Preview'
                        ? 'border-blue-700/50 text-blue-400 bg-blue-900/20'
                        : 'border-red-700/50 text-red-400 bg-red-900/20'
                    }`}
                  >
                    {status} ({list.length})
                  </span>
                ) : null
              )}
            </div>

            {/* GA features */}
            {groupedFeatures['GA'].length > 0 && (
              <div className="space-y-2">
                <h3 className="text-xs font-medium text-green-400 uppercase tracking-wide">Generally Available</h3>
                <FeatureGroup features={groupedFeatures['GA']} expandedFeatures={expandedFeatures} toggleFeature={toggleFeature} />
              </div>
            )}

            {/* Tech Preview features */}
            {groupedFeatures['Tech Preview'].length > 0 && (
              <div className="space-y-2">
                <h3 className="text-xs font-medium text-blue-400 uppercase tracking-wide">Tech Preview</h3>
                <FeatureGroup features={groupedFeatures['Tech Preview']} expandedFeatures={expandedFeatures} toggleFeature={toggleFeature} />
              </div>
            )}

            {/* Deprecated features */}
            {groupedFeatures['Deprecated'].length > 0 && (
              <div className="space-y-2">
                <h3 className="text-xs font-medium text-red-400 uppercase tracking-wide">Deprecated</h3>
                <FeatureGroup features={groupedFeatures['Deprecated']} expandedFeatures={expandedFeatures} toggleFeature={toggleFeature} />
              </div>
            )}
          </section>
        )}

      </div>
    </div>
  )
}
