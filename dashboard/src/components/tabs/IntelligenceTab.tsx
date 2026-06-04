/**
 * GitHub Issue #200: Intelligence tab shell + Red Hat News section
 * GitHub Issue #201: Product Roadmap section
 * GitHub Issue #202: Events section
 * Feature: Red Hat intelligence surfaces — news, product lifecycle, events
 */

import { Newspaper, RefreshCw, ExternalLink, Loader2, Copy, Check, Calendar, ChevronDown, ChevronUp, MapPin, Users } from 'lucide-react'
import { useState, useEffect, useMemo } from 'react'
import SignalWithAging from '../SignalWithAging'

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

interface ProductLifecycle {
  slug: string
  displayName: string
  currentVersion: string
  latestPatch: string
  nextVersion: string | null
  nextExpected: string | null
  gaDate: string
  eolDate: string
  eusAvailable: boolean
  supportEnd: string
  docsUrl?: string
}

interface RHEvent {
  name: string
  date: string
  format: 'in-person' | 'virtual' | 'hybrid'
  location: string | null
  region: string
  productTags: string[]
  registrationUrl: string | null
  description?: string
  enrichedDescription?: string | null
}

interface SimilarCustomer {
  slug: string
  name: string
  overlapScore: number
  sharedProducts: string[]
  sharedCasePatterns: string[]
  sharedNodeTypes: string[]
  totalSharedNodes: number
}

export function IntelligenceTab({ customerName }: IntelligenceTabProps) {
  const [articles, setArticles] = useState<NewsItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selectedProduct, setSelectedProduct] = useState<string>('all')
  const [showMore, setShowMore] = useState(false)
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null)

  const [products, setProducts] = useState<ProductLifecycle[]>([])
  const [roadmapLoading, setRoadmapLoading] = useState(true)
  const [roadmapError, setRoadmapError] = useState<string | null>(null)
  const [expandedRow, setExpandedRow] = useState<string | null>(null)

  const [events, setEvents] = useState<RHEvent[]>([])
  const [eventsLoading, setEventsLoading] = useState(true)
  const [eventsError, setEventsError] = useState<string | null>(null)
  const [copiedEventIndex, setCopiedEventIndex] = useState<number | null>(null)

  const [similarCustomers, setSimilarCustomers] = useState<SimilarCustomer[]>([])
  const [similarLoading, setSimilarLoading] = useState(true)
  const [similarError, setSimilarError] = useState<string | null>(null)

  // Collapsible section state
  const [newsExpanded, setNewsExpanded] = useState(true)
  const [roadmapExpanded, setRoadmapExpanded] = useState(false)
  const [eventsExpanded, setEventsExpanded] = useState(false)
  const [similarExpanded, setSimilarExpanded] = useState(false)

  const fetchArticles = async () => {
    try {
      // Trigger module sync first
      await fetch(`/api/customer/${encodeURIComponent(customerName)}/modules/news-radar/sync`, {
        method: 'POST'
      }).catch(() => {})

      // Then re-fetch data
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

  const fetchRoadmap = async () => {
    try {
      const res = await fetch(`/api/customer/${encodeURIComponent(customerName)}/intelligence/roadmap`)
      if (!res.ok) {
        const errorData = await res.json().catch(() => ({ error: 'Failed to fetch roadmap' }))
        throw new Error(errorData.error || 'Failed to fetch roadmap')
      }
      const data = await res.json()
      setProducts(data.products || [])
      setRoadmapError(null)
    } catch (e: any) {
      setRoadmapError(e.message || 'Failed to fetch roadmap')
    } finally {
      setRoadmapLoading(false)
    }
  }

  const fetchEvents = async () => {
    try {
      const res = await fetch(`/api/customer/${encodeURIComponent(customerName)}/intelligence/events`)
      if (!res.ok) {
        const errorData = await res.json().catch(() => ({ error: 'Failed to fetch events' }))
        throw new Error(errorData.error || 'Failed to fetch events')
      }
      const data = await res.json()
      setEvents(data.events || [])
      setEventsError(null)
    } catch (e: any) {
      setEventsError(e.message || 'Failed to fetch events')
    } finally {
      setEventsLoading(false)
    }
  }

  const fetchSimilarCustomers = async () => {
    try {
      const slug = customerName.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '')
      const res = await fetch(`/api/customer/${encodeURIComponent(slug)}/similar`)
      if (!res.ok) {
        const errorData = await res.json().catch(() => ({ error: 'Failed to fetch similar customers' }))
        throw new Error(errorData.error || 'Failed to fetch similar customers')
      }
      const data = await res.json()
      setSimilarCustomers(data.similar || [])
      setSimilarError(null)
    } catch (e: any) {
      setSimilarError(e.message || 'Failed to fetch similar customers')
    } finally {
      setSimilarLoading(false)
    }
  }

  useEffect(() => {
    fetchArticles()
    fetchRoadmap()
    fetchEvents()
    fetchSimilarCustomers()
  }, [customerName])

  // Auto-expand news section when articles arrive
  useEffect(() => {
    setNewsExpanded(articles.length > 0)
  }, [articles])

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

  const getEOLWarning = (eolDate: string) => {
    if (eolDate === 'N/A') {
      return { color: '', countdown: null }
    }

    try {
      const eol = new Date(eolDate)
      const now = new Date()
      const diffMs = eol.getTime() - now.getTime()
      const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24))

      if (diffDays < 0) {
        return { color: 'text-zinc-500', countdown: null }
      } else if (diffDays < 90) {
        return { color: 'text-red-400 font-medium', countdown: `⚠️ ${diffDays} days` }
      } else if (diffDays < 180) {
        return { color: 'text-yellow-400', countdown: `${diffDays} days` }
      } else {
        return { color: '', countdown: null }
      }
    } catch {
      return { color: '', countdown: null }
    }
  }

  const formatEOLDate = (eolDate: string) => {
    if (eolDate === 'N/A') return 'N/A'
    try {
      const date = new Date(eolDate)
      return new Intl.DateTimeFormat('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      }).format(date)
    } catch {
      return eolDate
    }
  }

  const handleCopyToClipboard = async (article: NewsItem, index: number) => {
    const snippet = `📰 Customer News: ${article.headline}

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

  const formatEventDate = (isoDate: string) => {
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

  const getFormatBadge = (format: string) => {
    if (format === 'virtual') {
      return (
        <span className="inline-flex items-center px-2 py-1 rounded text-xs font-medium bg-green-500/20 text-green-400">
          Virtual
        </span>
      )
    } else if (format === 'hybrid') {
      return (
        <span className="inline-flex items-center px-2 py-1 rounded text-xs font-medium bg-yellow-500/20 text-yellow-400">
          Hybrid
        </span>
      )
    } else {
      return (
        <span className="inline-flex items-center px-2 py-1 rounded text-xs font-medium bg-accent/20 text-accent">
          In-Person
        </span>
      )
    }
  }

  const handleCopyEventToClipboard = async (event: RHEvent, index: number) => {
    const snippet = `📅 Red Hat Event: ${event.name}
📍 ${event.location ?? 'Virtual'} | ${formatEventDate(event.date)}${event.registrationUrl ? `
Register: ${event.registrationUrl}` : ''}`

    try {
      await navigator.clipboard.writeText(snippet)
      setCopiedEventIndex(index)
      setTimeout(() => setCopiedEventIndex(null), 2000)
    } catch (e) {
      console.error('Failed to copy event to clipboard:', e)
    }
  }

  return (
    <div className="max-w-4xl mx-auto p-8 space-y-6">
      {/* Customer News removed — see News tab (#227) */}

      {/* Product Roadmap Section */}
      <div className="bg-surface border border-border rounded-xl overflow-hidden">
        {/* Header */}
        <div
          className="px-6 py-4 cursor-pointer hover:bg-border/10 transition-colors flex items-center justify-between"
          onClick={() => setRoadmapExpanded(!roadmapExpanded)}
        >
          <div className="flex items-center gap-3">
            <Calendar className="w-5 h-5 text-accent" />
            <h2 className="text-xl font-semibold text-text-primary">Product Roadmap</h2>
            {!roadmapLoading && !roadmapError && products.length > 0 && (
              <span className="bg-accent/10 text-accent text-xs px-2 py-0.5 rounded-full font-medium">
                {products.length}
              </span>
            )}
          </div>
          {roadmapExpanded ? (
            <ChevronUp className="w-5 h-5 text-text-secondary" />
          ) : (
            <ChevronDown className="w-5 h-5 text-text-secondary" />
          )}
        </div>

        {/* Collapsed preview */}
        {!roadmapExpanded && !roadmapLoading && !roadmapError && products.length > 0 && (
          <div className="px-6 py-4 border-t border-border/60">
            <div className="text-sm text-text-secondary">
              {products.length} product{products.length !== 1 ? 's' : ''} tracked
            </div>
          </div>
        )}

        {roadmapExpanded && (
          <div className="p-6">
            {/* Loading state */}
            {roadmapLoading && (
            <div className="py-12 text-center space-y-4">
              <Loader2 className="w-12 h-12 text-accent mx-auto animate-spin" />
              <p className="text-sm text-text-secondary">Loading product roadmap...</p>
            </div>
          )}

          {/* Error state */}
          {!roadmapLoading && roadmapError && (
            <div className="bg-surface border border-red-500/50 rounded-xl p-6 space-y-3">
              <p className="text-sm font-medium text-red-400">Error loading roadmap</p>
              <p className="text-xs text-text-secondary">{roadmapError}</p>
              <button
                onClick={fetchRoadmap}
                className="px-4 py-2 rounded-lg border border-border text-xs text-accent hover:border-accent/50 transition-colors"
              >
                Retry
              </button>
            </div>
          )}

          {/* Empty state */}
          {!roadmapLoading && !roadmapError && products.length === 0 && (
            <div className="py-12 text-center space-y-4">
              <div className="relative mx-auto w-20 h-20">
                <div className="absolute inset-0 bg-accent/10 rounded-full" />
                <Calendar className="w-12 h-12 text-accent absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2" />
              </div>
              <div className="space-y-2">
                <p className="text-base font-medium text-text-primary">No product lifecycle data available</p>
                <p className="text-sm text-text-secondary max-w-md mx-auto">
                  Product roadmap data will appear here for this customer's subscriptions.
                </p>
              </div>
            </div>
          )}

          {/* Product table - Desktop */}
          {!roadmapLoading && !roadmapError && products.length > 0 && (
            <div className="hidden md:block overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-border">
                    <th className="text-left px-4 py-3 text-xs font-semibold text-text-secondary uppercase tracking-wider">
                      Product
                    </th>
                    <th className="text-left px-4 py-3 text-xs font-semibold text-text-secondary uppercase tracking-wider">
                      Current Version
                    </th>
                    <th className="text-left px-4 py-3 text-xs font-semibold text-text-secondary uppercase tracking-wider">
                      Next Version
                    </th>
                    <th className="text-left px-4 py-3 text-xs font-semibold text-text-secondary uppercase tracking-wider">
                      EOL
                    </th>
                    <th className="w-8"></th>
                  </tr>
                </thead>
                <tbody>
                  {products.map((product, idx) => {
                    const eolWarning = getEOLWarning(product.eolDate)
                    const isExpanded = expandedRow === product.slug

                    return (
                      <tr key={product.slug} className={idx % 2 === 0 ? 'bg-surface' : 'bg-surface/50'}>
                        <td colSpan={5} className="p-0">
                          <div
                            className="cursor-pointer hover:bg-border/20 transition-colors"
                            onClick={() => setExpandedRow(isExpanded ? null : product.slug)}
                          >
                            <div className="grid grid-cols-[1fr,1fr,1fr,1fr,auto] gap-4 px-4 py-3">
                              <div className="text-sm font-medium text-text-primary">
                                {product.docsUrl ? (
                                  <a
                                    href={product.docsUrl}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="text-accent hover:underline"
                                    onClick={(e) => e.stopPropagation()}
                                  >
                                    {product.displayName}
                                  </a>
                                ) : (
                                  product.displayName
                                )}
                              </div>
                              <div className="text-sm text-text-secondary">{product.currentVersion}</div>
                              <div className="text-sm text-text-secondary">
                                {product.nextVersion ? `${product.nextVersion}` : 'N/A'}
                                {product.nextExpected && (
                                  <span className="text-xs text-text-secondary ml-1">
                                    ({new Intl.DateTimeFormat('en-US', { month: 'short', year: 'numeric' }).format(new Date(product.nextExpected))})
                                  </span>
                                )}
                              </div>
                              <div className={`text-sm ${eolWarning.color}`}>
                                {formatEOLDate(product.eolDate)}
                                {eolWarning.countdown && (
                                  <div className="text-xs mt-0.5">{eolWarning.countdown}</div>
                                )}
                              </div>
                              <div className="flex items-center justify-center">
                                {isExpanded ? (
                                  <ChevronUp className="w-4 h-4 text-text-secondary" />
                                ) : (
                                  <ChevronDown className="w-4 h-4 text-text-secondary" />
                                )}
                              </div>
                            </div>
                          </div>

                          {/* Expanded details */}
                          {isExpanded && (
                            <div className="bg-border/10 p-4 border-t border-border space-y-2">
                              <div className="grid grid-cols-2 gap-4 text-sm">
                                <div>
                                  <span className="text-text-secondary">Latest Patch:</span>{' '}
                                  <span className="text-text-primary font-medium">{product.latestPatch}</span>
                                </div>
                                <div>
                                  <span className="text-text-secondary">Support End:</span>{' '}
                                  <span className="text-text-primary">{formatEOLDate(product.supportEnd)}</span>
                                </div>
                                <div>
                                  <span className="text-text-secondary">GA Date:</span>{' '}
                                  <span className="text-text-primary">{formatEOLDate(product.gaDate)}</span>
                                </div>
                                <div>
                                  <span className="text-text-secondary">EUS Available:</span>{' '}
                                  <span className="text-text-primary">{product.eusAvailable ? 'Yes' : 'No'}</span>
                                </div>
                              </div>
                            </div>
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}

          {/* Product cards - Mobile */}
          {!roadmapLoading && !roadmapError && products.length > 0 && (
            <div className="md:hidden space-y-4">
              {products.map((product) => {
                const eolWarning = getEOLWarning(product.eolDate)
                const isExpanded = expandedRow === product.slug

                return (
                  <div
                    key={product.slug}
                    className="bg-surface border border-border rounded-lg overflow-hidden"
                  >
                    <div
                      className="p-4 cursor-pointer hover:bg-border/20 transition-colors"
                      onClick={() => setExpandedRow(isExpanded ? null : product.slug)}
                    >
                      <div className="flex items-start justify-between mb-3">
                        <h3 className="text-base font-semibold text-text-primary">
                          {product.docsUrl ? (
                            <a
                              href={product.docsUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-accent hover:underline"
                              onClick={(e) => e.stopPropagation()}
                            >
                              {product.displayName}
                            </a>
                          ) : (
                            product.displayName
                          )}
                        </h3>
                        {isExpanded ? (
                          <ChevronUp className="w-5 h-5 text-text-secondary flex-shrink-0" />
                        ) : (
                          <ChevronDown className="w-5 h-5 text-text-secondary flex-shrink-0" />
                        )}
                      </div>
                      <div className="space-y-2 text-sm">
                        <div className="flex justify-between">
                          <span className="text-text-secondary">Current Version</span>
                          <span className="text-text-primary font-medium">{product.currentVersion}</span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-text-secondary">Next Version</span>
                          <span className="text-text-primary">
                            {product.nextVersion ? `${product.nextVersion}` : 'N/A'}
                            {product.nextExpected && (
                              <span className="text-xs text-text-secondary ml-1">
                                ({new Intl.DateTimeFormat('en-US', { month: 'short', year: 'numeric' }).format(new Date(product.nextExpected))})
                              </span>
                            )}
                          </span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-text-secondary">EOL</span>
                          <div className={`text-right ${eolWarning.color}`}>
                            <div>{formatEOLDate(product.eolDate)}</div>
                            {eolWarning.countdown && <div className="text-xs mt-0.5">{eolWarning.countdown}</div>}
                          </div>
                        </div>
                      </div>
                    </div>

                    {/* Expanded details */}
                    {isExpanded && (
                      <div className="bg-border/10 p-4 border-t border-border space-y-2 text-sm">
                        <div className="flex justify-between">
                          <span className="text-text-secondary">Latest Patch</span>
                          <span className="text-text-primary font-medium">{product.latestPatch}</span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-text-secondary">Support End</span>
                          <span className="text-text-primary">{formatEOLDate(product.supportEnd)}</span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-text-secondary">GA Date</span>
                          <span className="text-text-primary">{formatEOLDate(product.gaDate)}</span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-text-secondary">EUS Available</span>
                          <span className="text-text-primary">{product.eusAvailable ? 'Yes' : 'No'}</span>
                        </div>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}
          </div>
        )}
      </div>

      {/* Events Section */}
      <div className="bg-surface border border-border rounded-xl overflow-hidden">
        {/* Header */}
        <div
          className="px-6 py-4 cursor-pointer hover:bg-border/10 transition-colors flex items-center justify-between"
          onClick={() => setEventsExpanded(!eventsExpanded)}
        >
          <div className="flex items-center gap-3">
            <MapPin className="w-5 h-5 text-accent" />
            <h2 className="text-xl font-semibold text-text-primary">Events Near This Customer</h2>
            {!eventsLoading && !eventsError && events.length > 0 && (
              <span className="bg-accent/10 text-accent text-xs px-2 py-0.5 rounded-full font-medium">
                {events.length}
              </span>
            )}
          </div>
          {eventsExpanded ? (
            <ChevronUp className="w-5 h-5 text-text-secondary" />
          ) : (
            <ChevronDown className="w-5 h-5 text-text-secondary" />
          )}
        </div>

        {/* Collapsed preview */}
        {!eventsExpanded && !eventsLoading && !eventsError && events.length > 0 && (
          <div className="px-6 py-4 border-t border-border/60">
            <div className="text-sm text-text-secondary">
              {events[0].name} • {formatEventDate(events[0].date)}
            </div>
          </div>
        )}

        {eventsExpanded && (
          <div className="p-6">
            {/* Loading state */}
            {eventsLoading && (
            <div className="py-12 text-center space-y-4">
              <Loader2 className="w-12 h-12 text-accent mx-auto animate-spin" />
              <p className="text-sm text-text-secondary">Loading events...</p>
            </div>
          )}

          {/* Error state */}
          {!eventsLoading && eventsError && (
            <div className="bg-surface border border-red-500/50 rounded-xl p-6 space-y-3">
              <p className="text-sm font-medium text-red-400">Error loading events</p>
              <p className="text-xs text-text-secondary">{eventsError}</p>
              <button
                onClick={fetchEvents}
                className="px-4 py-2 rounded-lg border border-border text-xs text-accent hover:border-accent/50 transition-colors"
              >
                Retry
              </button>
            </div>
          )}

          {/* Empty state */}
          {!eventsLoading && !eventsError && events.length === 0 && (
            <div className="py-12 text-center space-y-4">
              <div className="relative mx-auto w-20 h-20">
                <div className="absolute inset-0 bg-accent/10 rounded-full" />
                <MapPin className="w-12 h-12 text-accent absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2" />
              </div>
              <div className="space-y-2">
                <p className="text-base font-medium text-text-primary">No upcoming Red Hat events in your region</p>
                <p className="text-sm text-text-secondary max-w-md mx-auto">
                  Virtual events and in-person events matching this customer's region will appear here.
                </p>
              </div>
            </div>
          )}

          {/* Event cards */}
          {!eventsLoading && !eventsError && events.length > 0 && (
            <div className="space-y-4">
              {events.map((event, idx) => (
                <SignalWithAging
                  key={idx}
                  timestamp={event.date}
                  showTimestamp={false}
                  className="bg-surface border border-border rounded-lg p-6 space-y-4 hover:border-accent/50 transition-colors"
                >
                  {/* Event name */}
                  <h3 className="text-lg font-bold text-text-primary">{event.name}</h3>

                  {/* Description */}
                  {(event.enrichedDescription || event.description) && (
                    <p className="text-sm text-text-secondary leading-relaxed">
                      {event.enrichedDescription || event.description}
                    </p>
                  )}

                  {/* Badges */}
                  <div className="flex items-center gap-2 flex-wrap">
                    {getFormatBadge(event.format)}
                    <span className="inline-flex items-center px-2 py-1 rounded text-xs font-medium text-text-secondary">
                      {formatEventDate(event.date)}
                    </span>
                    {event.location && (
                      <span className="inline-flex items-center gap-1 px-2 py-1 rounded text-xs font-medium text-text-secondary">
                        <MapPin className="w-3 h-3" />
                        {event.location}
                      </span>
                    )}
                    {event.productTags && event.productTags.length > 0 && (
                      event.productTags.map((tag, i) => (
                        <span key={i} className="inline-flex items-center px-2 py-1 rounded text-xs font-medium bg-blue-500/20 text-blue-400">
                          {tag}
                        </span>
                      ))
                    )}
                  </div>

                  {/* Footer: actions */}
                  <div className="flex items-center justify-end gap-2 pt-3 border-t border-border">
                    <button
                      onClick={() => handleCopyEventToClipboard(event, idx)}
                      className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-surface border border-border text-xs text-text-secondary font-medium hover:border-accent/50 hover:text-accent transition-colors"
                    >
                      {copiedEventIndex === idx ? (
                        <>
                          <Check className="w-3 h-3" />
                          Copied
                        </>
                      ) : (
                        <>
                          <Copy className="w-3 h-3" />
                          Share
                        </>
                      )}
                    </button>
                    {event.registrationUrl && (
                      <a
                        href={event.registrationUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-accent/10 text-xs text-accent font-medium hover:bg-accent/20 transition-colors"
                      >
                        Register
                        <ExternalLink className="w-3 h-3" />
                      </a>
                    )}
                  </div>
                </SignalWithAging>
              ))}
            </div>
          )}
          </div>
        )}
      </div>

      {/* Similar Customers Section (#612) */}
      <div className="bg-surface border border-border rounded-xl overflow-hidden">
        {/* Header */}
        <div
          className="px-6 py-4 cursor-pointer hover:bg-border/10 transition-colors flex items-center justify-between"
          onClick={() => setSimilarExpanded(!similarExpanded)}
        >
          <div className="flex items-center gap-3">
            <Users className="w-5 h-5 text-accent" />
            <h2 className="text-xl font-semibold text-text-primary">Similar Customers</h2>
            {!similarLoading && !similarError && similarCustomers.length > 0 && (
              <span className="bg-accent/10 text-accent text-xs px-2 py-0.5 rounded-full font-medium">
                {similarCustomers.length}
              </span>
            )}
          </div>
          {similarExpanded ? (
            <ChevronUp className="w-5 h-5 text-text-secondary" />
          ) : (
            <ChevronDown className="w-5 h-5 text-text-secondary" />
          )}
        </div>

        {/* Collapsed preview */}
        {!similarExpanded && !similarLoading && !similarError && similarCustomers.length > 0 && (
          <div className="px-6 py-4 border-t border-border/60">
            <div className="text-sm text-text-secondary">
              {similarCustomers.length} similar customer{similarCustomers.length !== 1 ? 's' : ''} found
            </div>
          </div>
        )}

        {similarExpanded && (
          <div className="p-6">
            {/* Loading state */}
            {similarLoading && (
              <div className="py-12 text-center space-y-4">
                <Loader2 className="w-12 h-12 text-accent mx-auto animate-spin" />
                <p className="text-sm text-text-secondary">Analyzing customer similarity...</p>
              </div>
            )}

            {/* Error state */}
            {!similarLoading && similarError && (
              <div className="bg-surface border border-red-500/50 rounded-xl p-6 space-y-3">
                <p className="text-sm font-medium text-red-400">Error loading similar customers</p>
                <p className="text-xs text-text-secondary">{similarError}</p>
                <button
                  onClick={fetchSimilarCustomers}
                  className="px-4 py-2 rounded-lg border border-border text-xs text-accent hover:border-accent/50 transition-colors"
                >
                  Retry
                </button>
              </div>
            )}

            {/* Empty state */}
            {!similarLoading && !similarError && similarCustomers.length === 0 && (
              <div className="py-8 text-center">
                <p className="text-sm text-text-secondary">No similar customers found</p>
              </div>
            )}

            {/* Similar customer cards */}
            {!similarLoading && !similarError && similarCustomers.length > 0 && (
              <div className="space-y-3">
                {similarCustomers.slice(0, 5).map((sim) => (
                  <a
                    key={sim.slug}
                    href={`/customer/${encodeURIComponent(sim.name)}`}
                    className="block bg-surface border border-border rounded-lg p-4 hover:border-accent/50 transition-colors"
                  >
                    <div className="flex items-start justify-between mb-2">
                      <h3 className="text-sm font-semibold text-text-primary">{sim.name}</h3>
                      <span className="inline-flex items-center px-2 py-1 rounded text-xs font-medium bg-accent/10 text-accent">
                        {Math.round(sim.overlapScore * 100)}% match
                      </span>
                    </div>
                    {sim.sharedProducts.length > 0 && (
                      <div className="flex items-center gap-1 flex-wrap mt-2">
                        <span className="text-xs text-text-secondary mr-1">Shared:</span>
                        {sim.sharedProducts.slice(0, 4).map((product, i) => (
                          <span
                            key={i}
                            className="inline-flex items-center px-2 py-0.5 rounded text-xs bg-blue-500/10 text-blue-400"
                          >
                            {product}
                          </span>
                        ))}
                        {sim.sharedProducts.length > 4 && (
                          <span className="text-xs text-text-secondary">
                            +{sim.sharedProducts.length - 4} more
                          </span>
                        )}
                      </div>
                    )}
                    <div className="text-xs text-text-secondary mt-2">
                      {sim.totalSharedNodes} shared signal{sim.totalSharedNodes !== 1 ? 's' : ''} across {sim.sharedNodeTypes.join(', ')}
                    </div>
                  </a>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
