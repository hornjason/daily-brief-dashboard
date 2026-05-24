/**
 * GitHub Issue #154: News tab UI — article list with summaries + source links
 * Feature: Customer news radar with Gemini-scored significance
 * Status: Phase 2 — full backend integration with manual refresh
 */

import { Newspaper, RefreshCw, ExternalLink, Loader2 } from 'lucide-react'
import { useState, useEffect } from 'react'
import SignalWithAging from '../SignalWithAging'

interface NewsTabProps {
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
}

export function NewsTab({ customerName }: NewsTabProps) {
  const [articles, setArticles] = useState<NewsItem[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const fetchArticles = async () => {
    try {
      const res = await fetch(`/api/customer/${encodeURIComponent(customerName)}/news`)
      if (!res.ok) {
        const errorData = await res.json().catch(() => ({ error: 'Failed to fetch news' }))
        throw new Error(errorData.error || 'Failed to fetch news')
      }
      const data = await res.json()
      setArticles(data.articles || [])
      setError(null)
    } catch (e: any) {
      setError(e.message || 'Failed to fetch news')
    } finally {
      setLoading(false)
    }
  }

  const handleRefresh = async () => {
    setRefreshing(true)
    setError(null)
    try {
      const res = await fetch(`/api/customer/${encodeURIComponent(customerName)}/news/refresh`, {
        method: 'POST',
      })
      if (!res.ok) {
        const errorData = await res.json().catch(() => ({ error: 'Refresh failed' }))
        throw new Error(errorData.error || 'Refresh failed')
      }
      await fetchArticles()
    } catch (e: any) {
      setError(e.message || 'Refresh failed')
    } finally {
      setRefreshing(false)
    }
  }

  useEffect(() => {
    fetchArticles()
  }, [customerName])

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
      return new Intl.DateTimeFormat('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      }).format(date)
    } catch {
      return isoDate
    }
  }

  const sortedArticles = [...articles].sort((a, b) => b.significanceScore - a.significanceScore)

  return (
    <div className="max-w-4xl mx-auto p-8 space-y-6">
      {/* Header */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Newspaper className="w-5 h-5 text-accent" />
            <h1 className="text-2xl font-bold text-text-primary">Customer News</h1>
          </div>
          <button
            onClick={handleRefresh}
            disabled={refreshing}
            className="flex items-center gap-2 px-4 py-2 rounded-lg bg-accent/10 text-accent text-sm font-medium hover:bg-accent/20 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <RefreshCw className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} />
            {refreshing ? 'Refreshing...' : 'Refresh'}
          </button>
        </div>
        <p className="text-sm text-text-secondary">
          Daily news articles about {customerName}, scored for significance. Articles with high scores (7+) also appear in your morning brief. Powered by Gemini grounded search.
        </p>
      </div>

      {/* Loading state */}
      {loading && (
        <div className="bg-surface border border-border rounded-xl p-12 text-center space-y-4">
          <Loader2 className="w-12 h-12 text-accent mx-auto animate-spin" />
          <p className="text-sm text-text-secondary">Loading news articles...</p>
        </div>
      )}

      {/* Error state */}
      {!loading && error && (
        <div className="bg-surface border border-red-500/50 rounded-xl p-6 space-y-3">
          <p className="text-sm font-medium text-red-400">Error loading news</p>
          <p className="text-xs text-text-secondary">{error}</p>
          <button
            onClick={fetchArticles}
            className="px-4 py-2 rounded-lg border border-border text-xs text-accent hover:border-accent/50 transition-colors"
          >
            Try Again
          </button>
        </div>
      )}

      {/* Empty state */}
      {!loading && !error && sortedArticles.length === 0 && (
        <div className="bg-surface border border-border rounded-xl p-12 text-center space-y-4">
          <div className="relative mx-auto w-20 h-20">
            <div className="absolute inset-0 bg-accent/10 rounded-full" />
            <Newspaper className="w-12 h-12 text-accent absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2" />
          </div>
          <div className="space-y-2">
            <p className="text-base font-medium text-text-primary">No news stories found</p>
            <p className="text-sm text-text-secondary max-w-md mx-auto">
              News radar checks daily at 5:30am ET.
            </p>
          </div>
        </div>
      )}

      {/* Article list */}
      {!loading && !error && sortedArticles.length > 0 && (
        <div className="space-y-4">
          {sortedArticles.map((article, idx) => (
            <SignalWithAging key={idx} timestamp={article.publishedDate} showTimestamp={false} className="bg-surface border border-border rounded-xl p-6 space-y-4 hover:border-accent/50 transition-colors">
              {/* Headline */}
              <h3 className="text-lg font-bold text-text-primary">{article.headline}</h3>

              {/* Badges */}
              <div className="flex items-center gap-2 flex-wrap">
                {getSignificanceBadge(article.significanceScore)}
                <span className="inline-flex items-center px-2 py-1 rounded text-xs font-medium bg-surface border border-border text-text-secondary">
                  {article.signalType}
                </span>
              </div>

              {/* Summary */}
              <p className="text-sm text-text-secondary leading-relaxed">{article.summary}</p>

              {/* Footer: source + date */}
              <div className="flex items-center justify-between pt-3 border-t border-border">
                <div className="flex items-center gap-2">
                  <span className="text-xs text-text-secondary">{article.sourceName}</span>
                  <span className="text-xs text-text-secondary">•</span>
                  <span className="text-xs text-text-secondary">{formatDate(article.publishedDate)}</span>
                </div>
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
            </SignalWithAging>
          ))}
        </div>
      )}
    </div>
  )
}
