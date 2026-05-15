/**
 * Red Hat Pulse Card — Global Dashboard Surface
 * GitHub Issue #203
 *
 * Displays latest Red Hat ecosystem intelligence:
 * - Latest News (3 items)
 * - Product Releases (upcoming)
 * - Events (upcoming)
 *
 * Data source: GET /api/intelligence/global
 */

import { useState, useEffect } from 'react'
import { Newspaper, Calendar, Package, RefreshCw, ExternalLink } from 'lucide-react'

interface NewsItem {
  headline: string
  summary: string
  sourceUrl: string
  sourceName: string
  publishedDate: string
  significanceScore: number
  signalType: string
  productTags?: string[]
}

interface Release {
  product: string
  version: string
  gaDate: string
}

interface Event {
  name: string
  location: string
  date: string
  registrationUrl?: string | null
}

interface GlobalIntelligence {
  news: NewsItem[]
  releases: Release[]
  events: Event[]
  cachedAt: string
}

function formatTimeAgo(isoDate: string): string {
  try {
    const date = new Date(isoDate)
    const now = new Date()
    const diffMs = now.getTime() - date.getTime()
    const diffHours = Math.floor(diffMs / (1000 * 60 * 60))
    const diffDays = Math.floor(diffHours / 24)

    if (diffHours < 1) return 'Just now'
    if (diffHours === 1) return '1h ago'
    if (diffHours < 24) return `${diffHours}h ago`
    if (diffDays === 1) return '1d ago'
    if (diffDays < 7) return `${diffDays}d ago`

    return new Intl.DateTimeFormat('en-US', {
      month: 'short',
      day: 'numeric',
    }).format(date)
  } catch {
    return isoDate
  }
}

export function RedHatPulseCard() {
  const [data, setData] = useState<GlobalIntelligence | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const fetchData = async () => {
    setLoading(true)
    setError(null)
    try {
      // Trigger module syncs first (using _global as customer name for global modules)
      await fetch('/api/customer/_global/modules/rh-rss/sync', { method: 'POST' }).catch(() => {})
      await fetch('/api/customer/_global/modules/rh-events/sync', { method: 'POST' }).catch(() => {})

      // Then re-fetch data
      const res = await fetch('/api/intelligence/global')
      if (!res.ok) {
        throw new Error('Failed to fetch intelligence')
      }
      const json = await res.json()
      setData(json)
    } catch (e: any) {
      setError(e.message || 'Failed to load Red Hat Pulse')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchData()
  }, [])

  const isEmpty = data && data.news.length === 0 && data.releases.length === 0 && data.events.length === 0

  return (
    <div className="bg-surface border border-border rounded-xl overflow-hidden">
      {/* Header */}
      <div className="px-6 py-4 border-b border-border flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-red-500" aria-hidden="true" />
          <h2 className="text-lg font-semibold text-text-primary">Red Hat Pulse</h2>
        </div>
        <button
          onClick={fetchData}
          disabled={loading}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-surface border border-border text-xs text-text-secondary hover:text-text-primary hover:border-text-secondary transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          aria-label="Refresh Red Hat Pulse"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          Refresh
        </button>
      </div>

      {/* Content */}
      <div className="p-6">
        {/* Loading State */}
        {loading && (
          <div className="py-12 text-center">
            <RefreshCw className="w-8 h-8 text-accent mx-auto animate-spin mb-3" />
            <p className="text-sm text-text-secondary">Loading Red Hat intelligence...</p>
          </div>
        )}

        {/* Error State */}
        {!loading && error && (
          <div className="py-12 text-center space-y-3">
            <p className="text-sm font-medium text-red-400">Failed to load Red Hat Pulse</p>
            <p className="text-xs text-text-secondary">{error}</p>
            <button
              onClick={fetchData}
              className="px-4 py-2 rounded-lg border border-border text-xs text-accent hover:border-accent/50 transition-colors"
            >
              Retry
            </button>
          </div>
        )}

        {/* Empty State */}
        {!loading && !error && isEmpty && (
          <div className="py-12 text-center">
            <Newspaper className="w-12 h-12 text-accent/30 mx-auto mb-3" />
            <p className="text-sm text-text-secondary">
              No Red Hat intelligence updates in the last 7 days.
            </p>
          </div>
        )}

        {/* Three-Column Grid (Desktop) / Single Column (Mobile) */}
        {!loading && !error && data && !isEmpty && (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            {/* Latest News */}
            <div className="space-y-3">
              <div className="flex items-center gap-2 mb-3">
                <Newspaper className="w-4 h-4 text-accent" />
                <h3 className="text-sm font-semibold text-text-secondary uppercase tracking-wider">
                  Latest News
                </h3>
              </div>
              {data.news.length === 0 ? (
                <p className="text-xs text-text-secondary italic">No recent news</p>
              ) : (
                <div className="space-y-3">
                  {data.news.map((item, idx) => (
                    <div key={idx} className="space-y-1">
                      {item.sourceUrl && !item.sourceUrl.includes('vertexaisearch.cloud.google.com') ? (
                        <a
                          href={item.sourceUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-sm font-medium text-text-primary hover:text-accent transition-colors line-clamp-2"
                        >
                          {item.headline}
                        </a>
                      ) : (
                        <p className="text-sm font-medium text-text-primary line-clamp-2">
                          {item.headline}
                        </p>
                      )}
                      <p className="text-xs text-text-secondary">
                        {formatTimeAgo(item.publishedDate)}
                      </p>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Product Releases */}
            <div className="space-y-3">
              <div className="flex items-center gap-2 mb-3">
                <Package className="w-4 h-4 text-accent" />
                <h3 className="text-sm font-semibold text-text-secondary uppercase tracking-wider">
                  Product Releases
                </h3>
              </div>
              {data.releases.length === 0 ? (
                <p className="text-xs text-text-secondary italic">No upcoming releases</p>
              ) : (
                <div className="space-y-2">
                  {data.releases.map((rel, idx) => (
                    <div key={idx} className="text-sm">
                      <span className="font-medium text-text-primary">{rel.product} {rel.version}</span>
                      <span className="text-xs text-text-secondary ml-2">{rel.gaDate}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Upcoming Events */}
            <div className="space-y-3">
              <div className="flex items-center gap-2 mb-3">
                <Calendar className="w-4 h-4 text-accent" />
                <h3 className="text-sm font-semibold text-text-secondary uppercase tracking-wider">
                  Upcoming Events
                </h3>
              </div>
              {data.events.length === 0 ? (
                <p className="text-xs text-text-secondary italic">No upcoming events</p>
              ) : (
                <div className="space-y-2">
                  {data.events.map((evt, idx) => (
                    <div key={idx} className="space-y-1">
                      <p className="text-sm font-medium text-text-primary">{evt.name}</p>
                      <p className="text-xs text-text-secondary">
                        {evt.location} • {evt.date}
                      </p>
                      {evt.registrationUrl && (
                        <a
                          href={evt.registrationUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-xs text-accent hover:text-accent/80 transition-colors inline-flex items-center gap-1"
                        >
                          Register
                          <ExternalLink className="w-3 h-3" />
                        </a>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {/* Footer Link */}
        {!loading && !error && data && data.news.length > 0 && (
          <div className="mt-6 pt-4 border-t border-border text-center">
            <a
              href="/dashboard/rh-news"
              className="inline-flex items-center gap-1 text-sm text-accent hover:text-accent/80 transition-colors"
            >
              View All Red Hat News
              <ExternalLink className="w-3.5 h-3.5" />
            </a>
          </div>
        )}
      </div>
    </div>
  )
}
