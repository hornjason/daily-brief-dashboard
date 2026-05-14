/**
 * GitHub Issue #200: Intelligence tab shell + Red Hat News section
 * Feature: Red Hat intelligence surfaces — news, product lifecycle, events
 * Phase 1: Red Hat News section with product filter chips
 */

import { Newspaper, RefreshCw, ExternalLink, Loader2, Copy, Check } from 'lucide-react'
import { useState, useEffect, useMemo } from 'react'

interface IntelligenceTabProps {
  customerName: string
}

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

export function IntelligenceTab({ customerName }: IntelligenceTabProps) {
  const [articles, setArticles] = useState<NewsItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selectedProduct, setSelectedProduct] = useState<string>('all')
  const [showMore, setShowMore] = useState(false)
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null)

  const fetchArticles = async () => {
    try {
      const res = await fetch(`/api/customer/${encodeURIComponent(customerName)}/intelligence/news`)
      if (!res.ok) {
        const errorData = await res.json().catch(() => ({ error: 'Failed to fetch intelligence' }))
        throw new Error(errorData.error || 'Failed to fetch intelligence')
      }
      const data = await res.json()
      setArticles(data.articles || [])
      setError(null)
    } catch (e: any) {
      setError(e.message || 'Failed to fetch intelligence')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchArticles()
  }, [customerName])

  // Extract unique product tags from articles
  const productFilters = useMemo(() => {
    const tags = new Set<string>()
    for (const article of articles) {
      if (article.productTags) {
        for (const tag of article.productTags) {
          tags.add(tag)
        }
      }
    }
    return ['all', ...Array.from(tags).sort()]
  }, [articles])

  // Filter articles by selected product
  const filteredArticles = useMemo(() => {
    if (selectedProduct === 'all') {
      return articles
    }
    return articles.filter(a => a.productTags?.includes(selectedProduct))
  }, [articles, selectedProduct])

  // Sort by significance score descending
  const sortedArticles = useMemo(() => {
    return [...filteredArticles].sort((a, b) => b.significanceScore - a.significanceScore)
  }, [filteredArticles])

  // Limit display to 5 by default, 15 with "Show More"
  const visibleArticles = showMore ? sortedArticles.slice(0, 15) : sortedArticles.slice(0, 5)

  const getSignificanceBadge = (score: number) => {
    if (score >= 7) {
      return (
        <span className="inline-flex items-center px-2 py-1 rounded text-xs font-medium bg-red-500/20 text-red-400">
          Critical
        </span>
      )
    } else if (score >= 4) {
      return (
        <span className="inline-flex items-center px-2 py-1 rounded text-xs font-medium bg-yellow-500/20 text-yellow-400">
          Notable
        </span>
      )
    } else {
      return (
        <span className="inline-flex items-center px-2 py-1 rounded text-xs font-medium bg-zinc-500/20 text-zinc-400">
          Minor
        </span>
      )
    }
  }

  const formatDate = (isoDate: string) => {
    try {
      const date = new Date(isoDate)
      const now = new Date()
      const diffMs = now.getTime() - date.getTime()
      const diffHours = Math.floor(diffMs / (1000 * 60 * 60))
      const diffDays = Math.floor(diffHours / 24)

      if (diffHours < 1) return 'Just now'
      if (diffHours < 24) return `${diffHours} hour${diffHours !== 1 ? 's' : ''} ago`
      if (diffDays < 7) return `${diffDays} day${diffDays !== 1 ? 's' : ''} ago`

      return new Intl.DateTimeFormat('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      }).format(date)
    } catch {
      return isoDate
    }
  }

  const handleCopyToClipboard = async (article: NewsItem, index: number) => {
    const snippet = `📰 Red Hat News: ${article.headline}

${article.summary}

Read more: ${article.sourceUrl}`

    try {
      await navigator.clipboard.writeText(snippet)
      setCopiedIndex(index)
      setTimeout(() => setCopiedIndex(null), 2000)
    } catch (e) {
      console.error('Failed to copy to clipboard:', e)
    }
  }

  return (
    <div className="max-w-4xl mx-auto p-8 space-y-6">
      {/* Red Hat News Section */}
      <div className="bg-surface border border-border rounded-xl overflow-hidden">
        {/* Header */}
        <div className="px-6 py-4 border-b border-border/60 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Newspaper className="w-5 h-5 text-accent" />
            <h2 className="text-xl font-semibold text-text-primary">Red Hat News</h2>
            <span className="text-sm text-text-secondary">(Matched to this Customer)</span>
          </div>
          <button
            onClick={fetchArticles}
            disabled={loading}
            className="flex items-center gap-2 px-4 py-2 rounded-lg bg-accent/10 text-accent text-sm font-medium hover:bg-accent/20 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </button>
        </div>

        <div className="p-6 space-y-6">
          {/* Product Filter Chips */}
          {!loading && !error && productFilters.length > 1 && (
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-xs text-text-secondary font-medium">Filter:</span>
              {productFilters.map(product => (
                <button
                  key={product}
                  onClick={() => setSelectedProduct(product)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                    selectedProduct === product
                      ? 'bg-accent/10 text-accent border border-accent/30'
                      : 'bg-surface border border-border text-text-secondary hover:text-text-primary hover:border-text-secondary'
                  }`}
                >
                  {product === 'all' ? 'All Products' : product}
                </button>
              ))}
            </div>
          )}

          {/* Loading state */}
          {loading && (
            <div className="py-12 text-center space-y-4">
              <Loader2 className="w-12 h-12 text-accent mx-auto animate-spin" />
              <p className="text-sm text-text-secondary">Loading Red Hat news...</p>
            </div>
          )}

          {/* Error state */}
          {!loading && error && (
            <div className="bg-surface border border-red-500/50 rounded-xl p-6 space-y-3">
              <p className="text-sm font-medium text-red-400">Error loading intelligence</p>
              <p className="text-xs text-text-secondary">{error}</p>
              <button
                onClick={fetchArticles}
                className="px-4 py-2 rounded-lg border border-border text-xs text-accent hover:border-accent/50 transition-colors"
              >
                Retry
              </button>
            </div>
          )}

          {/* Empty state */}
          {!loading && !error && sortedArticles.length === 0 && (
            <div className="py-12 text-center space-y-4">
              <div className="relative mx-auto w-20 h-20">
                <div className="absolute inset-0 bg-accent/10 rounded-full" />
                <Newspaper className="w-12 h-12 text-accent absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2" />
              </div>
              <div className="space-y-2">
                <p className="text-base font-medium text-text-primary">No Red Hat news matched to this customer's products</p>
                <p className="text-sm text-text-secondary max-w-md mx-auto">
                  News radar checks daily at 5:30am ET.
                </p>
              </div>
            </div>
          )}

          {/* Article list */}
          {!loading && !error && visibleArticles.length > 0 && (
            <div className="space-y-4">
              {visibleArticles.map((article, idx) => (
                <div
                  key={idx}
                  className="bg-surface border border-border rounded-lg p-6 space-y-4 hover:border-accent/50 transition-colors"
                >
                  {/* Headline */}
                  <h3 className="text-lg font-bold text-text-primary">{article.headline}</h3>

                  {/* Badges */}
                  <div className="flex items-center gap-2 flex-wrap">
                    {article.productTags && article.productTags.length > 0 && (
                      article.productTags.map((tag, i) => (
                        <span key={i} className="inline-flex items-center px-2 py-1 rounded text-xs font-medium bg-blue-500/20 text-blue-400">
                          {tag}
                        </span>
                      ))
                    )}
                    {getSignificanceBadge(article.significanceScore)}
                    <span className="inline-flex items-center px-2 py-1 rounded text-xs font-medium text-text-secondary">
                      {formatDate(article.publishedDate)}
                    </span>
                  </div>

                  {/* Summary */}
                  <p className="text-sm text-text-secondary leading-relaxed">{article.summary}</p>

                  {/* Footer: source + actions */}
                  <div className="flex items-center justify-between pt-3 border-t border-border">
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-text-secondary">{article.sourceName}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => handleCopyToClipboard(article, idx)}
                        className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-surface border border-border text-xs text-text-secondary font-medium hover:border-accent/50 hover:text-accent transition-colors"
                      >
                        {copiedIndex === idx ? (
                          <>
                            <Check className="w-3 h-3" />
                            Copied
                          </>
                        ) : (
                          <>
                            <Copy className="w-3 h-3" />
                            Share with Customer
                          </>
                        )}
                      </button>
                      <a
                        href={article.sourceUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-accent/10 text-xs text-accent font-medium hover:bg-accent/20 transition-colors"
                      >
                        Read Article
                        <ExternalLink className="w-3 h-3" />
                      </a>
                    </div>
                  </div>
                </div>
              ))}

              {/* Show More / Show Less button */}
              {sortedArticles.length > 5 && (
                <div className="pt-2">
                  <button
                    onClick={() => setShowMore(!showMore)}
                    className="w-full px-4 py-2 rounded-lg border border-border text-sm text-accent hover:border-accent/50 transition-colors"
                  >
                    {showMore ? 'Show Less' : `Show More (${Math.min(sortedArticles.length - 5, 10)} more)`}
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
