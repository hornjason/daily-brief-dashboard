// Route: /dashboard/products/:slug
// Full drill-down view for a single product

import { useState, useEffect } from 'react'
import { useParams, Link } from 'react-router-dom'
import type { ProductSummary, ProductAlert } from '../components/ProductCard'
import { renderMarkdownInline } from '../lib/markdown'
import { useAction } from '../hooks/useAction'

interface ProductConfig {
  slug: string
  customSources: string[]
  followLinks: boolean
}

export function ProductDetailPage() {
  const { slug } = useParams<{ slug: string }>()

  const [summary, setSummary] = useState<ProductSummary | null>(null)
  const [alert, setAlert] = useState<ProductAlert | null>(null)
  const [config, setConfig] = useState<ProductConfig | null>(null)

  const [summaryLoading, setSummaryLoading] = useState(true)
  const [summaryError, setSummaryError] = useState<string | null>(null)

  const [newSource, setNewSource] = useState('')
  const [sourceSaving, setSourceSaving] = useState(false)
  const [sourceError, setSourceError] = useState<string | null>(null)

  const [refreshing, setRefreshing] = useState(false)
  const [refreshError, setRefreshError] = useState<string | null>(null)

  const [acknowledging, setAcknowledging] = useState(false)
  const ackAction = useAction()
  const followLinksAction = useAction<ProductConfig>()

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

  // Fetch config
  useEffect(() => {
    if (!slug) return
    fetch('/api/products/config')
      .then(async res => {
        if (!res.ok) return
        const configs: ProductConfig[] = await res.json()
        const match = configs.find(c => c.slug === slug)
        setConfig(match ?? { slug, customSources: [], followLinks: false })
      })
      .catch(() => {})
  }, [slug])

  async function handleAcknowledge() {
    if (!alert) return
    setAcknowledging(true)
    const result = await ackAction.execute(`/api/products/alerts/${alert.id}/acknowledge`, { method: 'POST' })
    if (result) setAlert(null)
    setAcknowledging(false)
  }

  async function handleAddSource() {
    if (!slug || !newSource.trim()) return
    setSourceSaving(true)
    setSourceError(null)
    try {
      const updated = [...(config?.customSources ?? []), newSource.trim()]
      const res = await fetch(`/api/products/${slug}/sources`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ customSources: updated }),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d.error ?? `HTTP ${res.status}`)
      }
      const next: ProductConfig = await res.json()
      setConfig(next)
      setNewSource('')
    } catch (e: any) {
      setSourceError(e?.message ?? 'Failed to add source')
    } finally {
      setSourceSaving(false)
    }
  }

  async function handleRemoveSource(src: string) {
    if (!slug || !config) return
    setSourceSaving(true)
    setSourceError(null)
    try {
      const updated = config.customSources.filter(s => s !== src)
      const res = await fetch(`/api/products/${slug}/sources`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ customSources: updated }),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d.error ?? `HTTP ${res.status}`)
      }
      const next: ProductConfig = await res.json()
      setConfig(next)
    } catch (e: any) {
      setSourceError(e?.message ?? 'Failed to remove source')
    } finally {
      setSourceSaving(false)
    }
  }

  async function handleFollowLinksToggle(value: boolean) {
    if (!slug) return
    const result = await followLinksAction.execute(`/api/products/${slug}/sources`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ followLinks: value }),
    })
    if (result) setConfig(result)
  }

  async function handleRefreshNow() {
    if (!slug) return
    setRefreshing(true)
    setRefreshError(null)
    try {
      const res = await fetch(`/api/products/${slug}/refresh`, { method: 'POST' })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d.error ?? `HTTP ${res.status}`)
      }
      const updated: ProductSummary = await res.json()
      setSummary(updated)
    } catch (e: any) {
      setRefreshError(e?.message ?? 'Refresh failed')
    } finally {
      setRefreshing(false)
    }
  }

  if (summaryLoading) {
    return (
      <div className="flex-1 text-text-primary overflow-y-auto">
        <div className="max-w-3xl mx-auto px-4 py-10">
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
        <div className="max-w-3xl mx-auto px-4 py-10">
          <p className="text-critical text-sm">{summaryError ?? 'Product not found.'}</p>
          <Link to="/dashboard/products" className="text-accent text-sm hover:underline mt-2 inline-block">
            Back to Products
          </Link>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-bg text-text-primary">
      <div className="max-w-3xl mx-auto px-4 py-10 space-y-8">

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
                {acknowledging ? 'Acknowledging…' : 'Acknowledge'}
              </button>
              {ackAction.error && <p className="text-xs text-warning mt-1">{ackAction.error}</p>}
            </div>
          </div>
        )}

        {/* Summary */}
        <section className="space-y-3">
          <h2 className="text-sm font-semibold text-text-secondary uppercase tracking-wide">Summary</h2>
          {summary.summaryText && (
            <p className="text-sm text-text-primary leading-relaxed">{renderMarkdownInline(summary.summaryText)}</p>
          )}
          {summary.summaryBullets.length > 0 && (
            <ul className="space-y-1.5">
              {summary.summaryBullets.map((bullet, i) => (
                <li key={i} className="flex gap-2 text-sm text-text-secondary">
                  <span className="text-accent shrink-0 mt-0.5">•</span>
                  <span>{renderMarkdownInline(bullet)}</span>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* Sources */}
        {summary.sources.length > 0 && (
          <section className="space-y-2">
            <h2 className="text-sm font-semibold text-text-secondary uppercase tracking-wide">Sources</h2>
            <ul className="space-y-1">
              {summary.sources.map((src, i) => (
                <li key={i}>
                  <a
                    href={src}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-sm text-accent hover:underline break-all"
                  >
                    {src}
                  </a>
                </li>
              ))}
            </ul>
          </section>
        )}

        {/* Custom Sources */}
        <section className="space-y-3">
          <h2 className="text-sm font-semibold text-text-secondary uppercase tracking-wide">Custom Sources</h2>
          {config && config.customSources.length > 0 && (
            <ul className="space-y-1.5">
              {config.customSources.map((src, i) => (
                <li key={i} className="flex items-center justify-between gap-2">
                  <a
                    href={src}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-sm text-accent hover:underline break-all"
                  >
                    {src}
                  </a>
                  <button
                    onClick={() => handleRemoveSource(src)}
                    disabled={sourceSaving}
                    className="text-text-secondary hover:text-critical transition-colors disabled:opacity-50 shrink-0 text-xs"
                    title="Remove source"
                  >
                    x
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="flex gap-2">
            <input
              type="url"
              value={newSource}
              onChange={e => setNewSource(e.target.value)}
              placeholder="https://..."
              className="flex-1 bg-surface border border-border rounded px-3 py-1.5 text-sm text-text-primary placeholder-text-secondary focus:outline-none focus:border-accent"
              onKeyDown={e => { if (e.key === 'Enter') handleAddSource() }}
            />
            <button
              onClick={handleAddSource}
              disabled={sourceSaving || !newSource.trim()}
              className="bg-accent text-white px-3 py-1.5 rounded text-sm font-medium hover:opacity-90 disabled:opacity-50 transition-opacity"
            >
              Add
            </button>
          </div>
          {sourceError && <p className="text-xs text-critical">{sourceError}</p>}

          {/* Follow links toggle */}
          <label className="flex items-center gap-2 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={config?.followLinks ?? false}
              onChange={e => handleFollowLinksToggle(e.target.checked)}
              className="accent-accent"
            />
            <span className="text-sm text-text-secondary">
              Follow embedded .redhat.com links for deeper context (slower)
            </span>
          </label>
          {followLinksAction.error && <p className="text-xs text-warning mt-1">{followLinksAction.error}</p>}

          {/* Refresh Now */}
          <div>
            <button
              onClick={handleRefreshNow}
              disabled={refreshing}
              className="text-sm text-text-secondary hover:text-text-primary transition-colors disabled:opacity-50"
            >
              {refreshing ? 'Refreshing…' : 'Refresh Now'}
            </button>
            {refreshError && <p className="text-xs text-critical mt-1">{refreshError}</p>}
          </div>
        </section>

        {/* Metadata footer */}
        <footer className="border-t border-border pt-4 space-y-1">
          <p className="text-xs text-text-secondary">Last synthesized: {new Date(summary.synthesizedAt).toLocaleString()}</p>
          <p className="text-xs text-text-secondary">Last refreshed: {new Date(summary.refreshedAt).toLocaleString()}</p>
        </footer>

      </div>
    </div>
  )
}
