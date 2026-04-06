import { useState } from 'react'
import { Link } from 'react-router-dom'
import { RefreshCw, ExternalLink } from 'lucide-react'
import { renderMarkdownInline } from '../lib/markdown'

export interface ProductSummary {
  slug: string
  displayName: string
  shortName: string
  currentVersion: string | null
  gaDate: string | null
  eolDate: string | null
  summaryText: string
  summaryBullets: string[]
  sources: string[]
  contentHash: string
  synthesizedAt: string
  refreshedAt: string
}

export interface ProductAlert {
  id: string
  slug: string
  version: string
  detectedAt: string
  acknowledged: boolean
  deckAdded: boolean
}

interface ProductCardProps {
  summary: ProductSummary
  alert: ProductAlert | null
  onRefreshed?: (updated: ProductSummary) => void
}

export function ProductCard({ summary, alert, onRefreshed }: ProductCardProps) {
  const [refreshing, setRefreshing] = useState(false)
  const [refreshError, setRefreshError] = useState<string | null>(null)

  const hasNewVersion = alert && !alert.acknowledged

  async function handleRefresh() {
    setRefreshing(true)
    setRefreshError(null)
    try {
      const res = await fetch(`/api/products/${summary.slug}/refresh`, { method: 'POST' })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d.error ?? `HTTP ${res.status}`)
      }
      const updated: ProductSummary = await res.json()
      onRefreshed?.(updated)
    } catch (e: any) {
      setRefreshError(e?.message ?? 'Refresh failed')
    } finally {
      setRefreshing(false)
    }
  }

  const visibleSources = summary.sources
  const visibleBullets = summary.summaryBullets

  return (
    <div className="relative bg-surface border border-border rounded-xl p-5 flex flex-col gap-3">
      {/* New version badge */}
      {hasNewVersion && (
        <span className="absolute top-4 right-4 bg-amber-500/20 text-amber-400 border border-amber-500/40 text-xs font-medium px-2 py-0.5 rounded-full">
          New version
        </span>
      )}

      {/* Header */}
      <div>
        <div className="flex items-center gap-2 pr-24">
          <h3 className="text-lg font-semibold text-text-primary">{summary.shortName}</h3>
          {summary.currentVersion && (
            <span className="bg-surface-hover text-text-secondary border border-border text-xs px-2 py-0.5 rounded-full font-mono">
              v{summary.currentVersion}
            </span>
          )}
        </div>
        <p className="text-xs text-text-secondary mt-0.5">{summary.displayName}</p>
      </div>

      {/* Dates */}
      {(summary.gaDate || summary.eolDate) && (
        <p className="text-xs text-text-secondary">
          {summary.gaDate && <span>GA: {summary.gaDate}</span>}
          {summary.gaDate && summary.eolDate && <span className="mx-1.5">|</span>}
          {summary.eolDate && <span>EOL: {summary.eolDate}</span>}
        </p>
      )}

      {/* Summary text */}
      {summary.summaryText && (
        <p className="text-sm text-text-primary leading-relaxed">{renderMarkdownInline(summary.summaryText)}</p>
      )}

      {/* Bullets */}
      {visibleBullets.length > 0 && (
        <ul className="space-y-1">
          {visibleBullets.map((bullet, i) => (
            <li key={i} className="flex gap-2 text-xs text-text-secondary">
              <span className="text-accent shrink-0 mt-0.5">•</span>
              <span>{renderMarkdownInline(bullet)}</span>
            </li>
          ))}
        </ul>
      )}

      {/* Sources */}
      {visibleSources.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {visibleSources.map((src, i) => {
            let label = src
            try { label = new URL(src).hostname.replace('www.', '') } catch {}
            return (
              <a
                key={i}
                href={src}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1 text-xs text-accent hover:underline"
              >
                <ExternalLink className="w-3 h-3 shrink-0" />
                {label}
              </a>
            )
          })}
        </div>
      )}

      {/* Footer */}
      <div className="flex items-center justify-between mt-auto pt-1">
        <span className="text-xs text-text-secondary">
          Refreshed {new Date(summary.refreshedAt).toLocaleDateString()}
        </span>
        <div className="flex items-center gap-3">
          <Link
            to={`/dashboard/products/${summary.slug}`}
            className="text-xs text-accent hover:underline"
          >
            View Details →
          </Link>
          <button
            onClick={handleRefresh}
            disabled={refreshing}
            className="flex items-center gap-1.5 text-xs text-text-secondary hover:text-text-primary transition-colors disabled:opacity-50"
            title="Refresh product data"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? 'animate-spin' : ''}`} />
            {refreshing ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
      </div>

      {refreshError && (
        <p className="text-xs text-critical">{refreshError}</p>
      )}
    </div>
  )
}
