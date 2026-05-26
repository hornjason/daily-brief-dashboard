/**
 * NewsPage — Module page for customer news
 * GitHub Issue #241, #246
 *
 * Wraps NewsTab content in ModulePageShell.
 * Scope: 'both' — "All customers" shows aggregated news highlights,
 * selecting a customer shows that customer's news.
 * Route: /dashboard/news
 */

import { useState, useEffect } from 'react'
import { ModulePageShell, useModulePage } from '../components/ModulePageShell'
import { NewsTab } from '../components/tabs/NewsTab'
import { Newspaper, ExternalLink } from 'lucide-react'
import { useApi } from '../hooks/useApi'

interface NewsHighlight {
  customerName: string
  title: string
  summary: string
  url: string
  source: string
  score: number
  publishedAt?: string
  publishedDate?: string
  products: string[]
}

function AllCustomersNews() {
  const { data, loading, error } = useApi<{ highlights: NewsHighlight[] }>('/api/news/highlights')

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center p-8">
        <div className="animate-spin w-6 h-6 border-2 border-accent border-t-transparent rounded-full" />
      </div>
    )
  }

  if (error || !data?.highlights?.length) {
    return (
      <div className="flex-1 flex items-center justify-center p-8">
        <div className="text-center space-y-3 max-w-md">
          <Newspaper className="w-12 h-12 text-text-secondary mx-auto" />
          <p className="text-sm text-text-secondary">
            No customer news articles found. News is generated when customers are refreshed.
          </p>
        </div>
      </div>
    )
  }

  const grouped = data.highlights.reduce<Record<string, NewsHighlight[]>>((acc, item) => {
    const key = item.customerName || 'Unknown'
    if (!acc[key]) acc[key] = []
    acc[key].push(item)
    return acc
  }, {})

  return (
    <div className="p-6 space-y-6">
      {Object.entries(grouped).sort(([a], [b]) => a.localeCompare(b)).map(([customer, articles]) => (
        <div key={customer}>
          <h3 className="text-sm font-semibold text-text-primary mb-3 uppercase tracking-wider">{customer}</h3>
          <div className="space-y-2">
            {articles.map((article, i) => (
              <a
                key={i}
                href={article.url}
                target="_blank"
                rel="noopener noreferrer"
                className="block p-4 rounded-lg bg-surface/50 border border-border/50 hover:border-border transition-colors group"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-text-primary group-hover:text-white transition-colors">
                      {article.title}
                    </div>
                    {article.summary && (
                      <p className="text-xs text-text-secondary mt-1 line-clamp-2">{article.summary}</p>
                    )}
                    <div className="flex items-center gap-2 mt-2 flex-wrap">
                      <span className="text-xs text-text-secondary">{article.source}</span>
                      {(article.publishedAt || article.publishedDate) && (
                        <>
                          <span className="text-xs text-text-secondary/50">·</span>
                          <span className="text-xs text-text-secondary">
                            {new Date(article.publishedAt || article.publishedDate!).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                          </span>
                        </>
                      )}
                      {article.score > 0 && (
                        <span className={`text-xs px-1.5 py-0.5 rounded ${
                          article.score >= 7 ? 'bg-health-red-bg text-health-red' :
                          article.score >= 4 ? 'bg-health-amber-bg text-health-amber' :
                          'bg-surface-hover text-text-secondary'
                        }`}>
                          {article.score}/10
                        </span>
                      )}
                      {article.products?.map(p => (
                        <span key={p} className="text-xs px-1.5 py-0.5 rounded bg-accent/10 text-accent border border-accent/30">
                          {p}
                        </span>
                      ))}
                    </div>
                  </div>
                  <ExternalLink className="w-4 h-4 text-text-secondary group-hover:text-text-primary shrink-0 mt-1" />
                </div>
              </a>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

function NewsContent() {
  const { customer } = useModulePage()

  if (!customer) {
    return <AllCustomersNews />
  }

  return <NewsTab customerName={customer} />
}

export function NewsPage() {
  return (
    <ModulePageShell
      title="Customer News"
      icon="Newspaper"
      scope="both"
    >
      <NewsContent />
    </ModulePageShell>
  )
}
