/**
 * Red Hat News Page — Full News List
 * GitHub Issue #220 (Fix 5)
 *
 * Displays all cached RSS items with filtering by product.
 * Replaces external newsroom link with internal full-list view.
 */

import { useState, useEffect, useMemo } from 'react'
import { Newspaper, Calendar, Filter, ExternalLink, RefreshCw } from 'lucide-react'

interface RSSItem {
  title: string
  link: string
  description: string
  pubDate: string
  source: 'blog' | 'press-release' | 'developer-blog'
  productTags?: string[]
}

interface RSSCache {
  items: RSSItem[]
  fetchedAt: string
}

function formatDate(isoDate: string): string {
  try {
    return new Intl.DateTimeFormat('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    }).format(new Date(isoDate))
  } catch {
    return isoDate
  }
}

function getSourceLabel(source: string): string {
  switch (source) {
    case 'blog':
      return 'Red Hat Blog'
    case 'press-release':
      return 'Press Release'
    case 'developer-blog':
      return 'Developer Blog'
    default:
      return source
  }
}

export function RedHatNewsPage() {
  const [data, setData] = useState<RSSCache | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [productFilter, setProductFilter] = useState<string>('all')

  const fetchData = async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/rss/feeds')
      if (!res.ok) {
        throw new Error('Failed to fetch RSS feeds')
      }
      const json = await res.json()
      setData(json)
    } catch (e: any) {
      setError(e.message || 'Failed to load news')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchData()
  }, [])

  // Discover all product tags
  const allProductTags = useMemo(() => {
    if (!data?.items) return []
    const tags = new Set<string>()
    for (const item of data.items) {
      if (item.productTags) {
        for (const tag of item.productTags) {
          tags.add(tag)
        }
      }
    }
    return ['AAP', 'OCP', 'RHEL', 'General'].filter(t => tags.has(t))
  }, [data])

  // Filter items by product
  const filteredItems = useMemo(() => {
    if (!data?.items) return []
    if (productFilter === 'all') return data.items
    return data.items.filter(item =>
      item.productTags?.includes(productFilter)
    )
  }, [data, productFilter])

  return (
    <div className="min-h-screen bg-bg">
      {/* Header */}
      <div className="sticky top-0 z-10 bg-surface border-b border-border">
        <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Newspaper className="w-6 h-6 text-accent" />
            <h1 className="text-2xl font-semibold text-text-primary">Red Hat News</h1>
          </div>
          <button
            onClick={fetchData}
            disabled={loading}
            className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-surface border border-border text-sm text-text-secondary hover:text-text-primary hover:border-text-secondary transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="max-w-6xl mx-auto px-6 py-8">
        {/* Loading State */}
        {loading && (
          <div className="py-20 text-center">
            <RefreshCw className="w-8 h-8 text-accent mx-auto animate-spin mb-3" />
            <p className="text-sm text-text-secondary">Loading news...</p>
          </div>
        )}

        {/* Error State */}
        {!loading && error && (
          <div className="py-20 text-center space-y-3">
            <p className="text-sm font-medium text-red-400">Failed to load news</p>
            <p className="text-xs text-text-secondary">{error}</p>
            <button
              onClick={fetchData}
              className="px-4 py-2 rounded-lg border border-border text-xs text-accent hover:border-accent/50 transition-colors"
            >
              Retry
            </button>
          </div>
        )}

        {/* Product Filter */}
        {!loading && !error && allProductTags.length > 0 && (
          <div className="mb-6 flex items-center gap-2 flex-wrap">
            <Filter className="w-4 h-4 text-text-secondary" />
            <span className="text-sm text-text-secondary">Filter:</span>
            <button
              onClick={() => setProductFilter('all')}
              className={`text-sm px-3 py-1 rounded-full border transition-colors ${
                productFilter === 'all'
                  ? 'border-accent bg-accent/10 text-accent font-medium'
                  : 'border-border text-text-secondary hover:text-text-primary'
              }`}
            >
              All
            </button>
            {allProductTags.map(tag => (
              <button
                key={tag}
                onClick={() => setProductFilter(tag)}
                className={`text-sm px-3 py-1 rounded-full border transition-colors ${
                  productFilter === tag
                    ? 'border-accent bg-accent/10 text-accent font-medium'
                    : 'border-border text-text-secondary hover:text-text-primary'
                }`}
              >
                {tag}
              </button>
            ))}
          </div>
        )}

        {/* News List */}
        {!loading && !error && filteredItems.length > 0 && (
          <div className="space-y-4">
            {filteredItems.map((item, idx) => (
              <div
                key={idx}
                className="bg-surface border border-border rounded-lg p-5 hover:border-accent/50 transition-colors"
              >
                <div className="flex items-start justify-between gap-4 mb-2">
                  <a
                    href={item.link}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-lg font-semibold text-text-primary hover:text-accent transition-colors flex-1"
                  >
                    {item.title}
                  </a>
                  <ExternalLink className="w-4 h-4 text-text-secondary shrink-0 mt-1" />
                </div>

                <div className="flex items-center gap-4 text-xs text-text-secondary mb-3">
                  <span className="flex items-center gap-1">
                    <Calendar className="w-3.5 h-3.5" />
                    {formatDate(item.pubDate)}
                  </span>
                  <span className="px-2 py-0.5 rounded bg-surface-hover border border-border">
                    {getSourceLabel(item.source)}
                  </span>
                  {item.productTags && item.productTags.length > 0 && (
                    <div className="flex items-center gap-1">
                      {item.productTags.map(tag => (
                        <span
                          key={tag}
                          className="px-2 py-0.5 rounded bg-accent/10 border border-accent/30 text-accent"
                        >
                          {tag}
                        </span>
                      ))}
                    </div>
                  )}
                </div>

                {item.description && (
                  <p className="text-sm text-text-secondary line-clamp-2">
                    {item.description}
                  </p>
                )}
              </div>
            ))}
          </div>
        )}

        {/* Empty State */}
        {!loading && !error && filteredItems.length === 0 && (
          <div className="py-20 text-center">
            <Newspaper className="w-12 h-12 text-accent/30 mx-auto mb-3" />
            <p className="text-sm text-text-secondary">
              {productFilter === 'all'
                ? 'No news items available'
                : `No news items tagged with ${productFilter}`}
            </p>
          </div>
        )}

        {/* Footer */}
        {!loading && !error && data && (
          <div className="mt-8 pt-6 border-t border-border text-center text-xs text-text-secondary">
            Last updated: {formatDate(data.fetchedAt)}
          </div>
        )}
      </div>
    </div>
  )
}
