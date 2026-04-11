import { useState, useEffect } from 'react'
import { ChevronDown, ChevronUp, RefreshCw, Sparkles, Loader2 } from 'lucide-react'
import { formatRelTime } from '../lib/format'
import { renderMarkdownInline } from '../lib/markdown'

// ── Types ────────────────────────────────────────────────────────────────────

interface CustomerProductIntel {
  product: string
  customer: string
  relevanceScore: 'HIGH' | 'MEDIUM' | 'LOW' | 'NONE'
  priorityAction: string
  featureTalkingPoints?: {
    feature: string
    status: string
    version: string | null
    reason: string
    signalSource: string
  }[]
  roadmapRelevance: {
    feature: string
    customerConnection: string
    talkingPoint: string
  }[]
  expansionOpportunities: {
    gap: string
    product: string
    rationale: string
  }[]
  caseAlignment: {
    caseNumber: string
    roadmapFix: string
    timeline: string
  }[]
  competitiveAngle: string | null
  generatedAt: string
  productCacheHash: string
}

export interface ProductIntelSectionProps {
  customerName: string
  customerSlug: string
}

// ── Constants ─────────────────────────────────────────────────────────────────

type ProductSlug = string

// Fallback labels for when config hasn't loaded yet or a slug has no displayName
const PRODUCT_LABEL_FALLBACKS: Record<string, string> = {
  rhel: 'RHEL',
  ocp: 'OpenShift',
  'ocp-virt': 'OCP Virt',
  aap: 'AAP',
  'rhel-ai': 'RHEL AI',
  'rh-ai-inference': 'AI Inference',
  rhoai: 'OpenShift AI',
}

function productLabel(slug: string, labels: Record<string, string>): string {
  return labels[slug] ?? PRODUCT_LABEL_FALLBACKS[slug] ?? slug
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function Skeleton({ className = '' }: { className?: string }) {
  return <div className={`animate-pulse bg-surface-hover rounded ${className}`} />
}

const RELEVANCE_STYLES: Record<'HIGH' | 'MEDIUM' | 'LOW' | 'NONE', { badge: string; dot: string }> = {
  HIGH:   { badge: 'bg-success/15 text-success border border-success/30',          dot: 'bg-success' },
  MEDIUM: { badge: 'bg-warning/15 text-warning border border-warning/30',          dot: 'bg-warning' },
  LOW:    { badge: 'bg-border/40 text-text-secondary border border-border',         dot: 'bg-text-secondary' },
  NONE:   { badge: 'bg-border/20 text-text-secondary/60 border border-border/40',  dot: 'bg-text-secondary/40' },
}

// ── ProductCard ───────────────────────────────────────────────────────────────

function ProductCard({
  slug,
  label,
  intel,
  onRegenerate,
  regenerating,
}: {
  slug: ProductSlug
  label: string
  intel: CustomerProductIntel
  onRegenerate: (slug: ProductSlug) => void
  regenerating: boolean
}) {
  const [collapsed, setCollapsed] = useState(true)
  const relevance = intel.relevanceScore as 'HIGH' | 'MEDIUM' | 'LOW' | 'NONE'
  const relStyle = RELEVANCE_STYLES[relevance] ?? RELEVANCE_STYLES.LOW

  return (
    <div className="bg-surface border border-border rounded-xl overflow-hidden">
      {/* Card header — always visible, clickable */}
      <button
        onClick={() => setCollapsed(v => !v)}
        aria-expanded={!collapsed}
        className="w-full px-4 py-3 flex items-center gap-3 hover:bg-surface-hover transition-colors text-left"
      >
        {/* Product badge */}
        <span className="shrink-0 px-2 py-0.5 rounded text-xs font-semibold bg-accent/20 text-accent">
          {label}
        </span>

        {/* Relevance badge */}
        <span className={`shrink-0 px-2 py-0.5 rounded text-xs font-medium ${relStyle.badge}`}>
          {relevance}
        </span>

        {/* Priority action — truncated */}
        <span className="flex-1 text-sm text-text-primary truncate min-w-0">
          {renderMarkdownInline(intel.priorityAction)}
        </span>

        {/* Chevron */}
        {collapsed
          ? <ChevronDown className="w-3.5 h-3.5 text-text-secondary shrink-0" />
          : <ChevronUp className="w-3.5 h-3.5 text-text-secondary shrink-0" />
        }
      </button>

      {/* Card body — expanded */}
      {!collapsed && (
        <div className="px-4 pb-4 pt-2 space-y-4">

          {/* Feature Talking Points */}
          {(intel.featureTalkingPoints?.length ?? 0) > 0 && (
            <div>
              <p className="text-xs text-text-secondary font-medium mb-1.5">Feature Talking Points</p>
              <ul className="space-y-2">
                {(intel.featureTalkingPoints ?? []).map((ftp, i) => (
                  <li key={i} className="text-sm text-text-primary flex gap-2">
                    <span className="text-text-secondary shrink-0 mt-0.5">•</span>
                    <span>
                      <span className="font-medium">{ftp.feature}</span>
                      {' '}
                      <span className="inline-block px-1.5 py-0 rounded text-[10px] font-medium bg-accent/20 text-accent">{label}</span>
                      {ftp.version && (
                        <>{' '}<span className="inline-block px-1.5 py-0 rounded text-[10px] font-medium bg-warning/15 text-warning">{ftp.version.replace(/^v/i, '')}</span></>
                      )}
                      {' '}
                      <span className={`inline-block px-1.5 py-0 rounded text-[10px] font-medium ${
                        ftp.status === 'GA' ? 'bg-success/15 text-success' :
                        ftp.status === 'Tech Preview' ? 'bg-warning/15 text-warning' :
                        'bg-accent/15 text-accent'
                      }`}>{ftp.status}</span>
                      <br />
                      <span>{ftp.reason}</span>
                      <br />
                      <span className="text-text-secondary text-xs">{ftp.signalSource}</span>
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Roadmap Relevance */}
          {(intel.roadmapRelevance?.length ?? 0) > 0 && (
            <div>
              <p className="text-xs text-text-secondary font-medium mb-1.5">Roadmap</p>
              <ul className="space-y-1">
                {(intel.roadmapRelevance ?? []).map((r, i) => (
                  <li key={i} className="text-sm text-text-primary flex gap-2">
                    <span className="text-text-secondary shrink-0 mt-0.5">•</span>
                    <span>
                      <span className="font-medium">{r.feature}</span>
                      {' — '}
                      {renderMarkdownInline(r.talkingPoint)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Expansion Opportunities */}
          {(intel.expansionOpportunities?.length ?? 0) > 0 && (
            <div>
              <p className="text-xs text-text-secondary font-medium mb-1.5">Opportunities</p>
              <ul className="space-y-1">
                {(intel.expansionOpportunities ?? []).map((o, i) => (
                  <li key={i} className="text-sm text-text-primary flex gap-2">
                    <span className="text-text-secondary shrink-0 mt-0.5">•</span>
                    <span>
                      {o.gap}
                      {' \u2192 '}
                      <span className="font-medium">{o.product}</span>
                      {': '}
                      {renderMarkdownInline(o.rationale)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Case Alignment */}
          {(intel.caseAlignment?.length ?? 0) > 0 && (
            <div>
              <p className="text-xs text-text-secondary font-medium mb-1.5">Case Alignment</p>
              <ul className="space-y-1">
                {(intel.caseAlignment ?? []).map((c, i) => (
                  <li key={i} className="text-sm text-text-primary flex gap-2">
                    <span className="text-text-secondary shrink-0 mt-0.5">•</span>
                    <span>
                      <span className="font-medium">Case {c.caseNumber}</span>
                      {': '}
                      {c.roadmapFix}
                      {' ('}
                      {c.timeline}
                      {')'}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Competitive Angle */}
          {intel.competitiveAngle && (
            <div>
              <p className="text-xs text-text-secondary font-medium mb-1.5">Competitive</p>
              <p className="text-sm text-text-primary">{renderMarkdownInline(intel.competitiveAngle)}</p>
            </div>
          )}

          {/* Footer */}
          <div className="flex items-center justify-between pt-2 border-t border-border/40">
            <p className="text-xs text-text-secondary">
              Generated {formatRelTime(intel.generatedAt)}
            </p>
            <button
              onClick={() => onRegenerate(slug)}
              disabled={regenerating}
              className="flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-lg bg-accent/10 text-accent hover:bg-accent/20 border border-accent/20 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {regenerating
                ? <Loader2 className="w-3 h-3 animate-spin" />
                : <RefreshCw className="w-3 h-3" />
              }
              Regenerate
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

// ── ProductIntelSection ───────────────────────────────────────────────────────

export function ProductIntelSection({ customerName, customerSlug }: ProductIntelSectionProps) {
  const [intel, setIntel] = useState<Partial<Record<ProductSlug, CustomerProductIntel | null>>>({})
  const [loading, setLoading] = useState(true)
  const [refreshKey, setRefreshKey] = useState(0)
  const [regenerating, setRegenerating] = useState<Set<ProductSlug>>(new Set())
  const [generatingAll, setGeneratingAll] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // BKL-MC06: product slugs and labels fetched from /api/products/config
  const [productSlugs, setProductSlugs] = useState<string[]>(['rhel', 'ocp', 'ocp-virt', 'aap', 'rhel-ai', 'rh-ai-inference', 'rhoai'])
  const [productLabels, setProductLabels] = useState<Record<string, string>>(PRODUCT_LABEL_FALLBACKS)

  useEffect(() => {
    fetch('/api/products/config')
      .then(r => r.ok ? r.json() : null)
      .then((config: { slug: string; displayName: string }[] | null) => {
        if (!config?.length) return
        setProductSlugs(config.map(p => p.slug))
        const labels: Record<string, string> = {}
        for (const p of config) { labels[p.slug] = p.displayName ?? PRODUCT_LABEL_FALLBACKS[p.slug] ?? p.slug }
        setProductLabels(labels)
      })
      .catch(() => { /* keep defaults */ })
  }, [])

  // Fetch all products' intel in parallel
  useEffect(() => {
    setLoading(true)

    const fetches = productSlugs.map(async (slug) => {
      try {
        const res = await fetch(`/api/products/${slug}/intel/${encodeURIComponent(customerSlug)}`)
        if (res.status === 404) return [slug, null] as const
        if (!res.ok) return [slug, null] as const
        const data: CustomerProductIntel = await res.json()
        return [slug, data] as const
      } catch {
        return [slug, null] as const
      }
    })

    Promise.all(fetches).then((results) => {
      const map: Partial<Record<ProductSlug, CustomerProductIntel | null>> = {}
      for (const [slug, data] of results) {
        map[slug] = data
      }
      setIntel(map)
      setLoading(false)
    })
  }, [customerSlug, refreshKey, productSlugs])

  async function handleRegenerate(slug: ProductSlug) {
    setRegenerating(prev => new Set(prev).add(slug))
    setError(null)
    try {
      // BKL-REG-11: Call generate directly using cached product summary.
      // Do NOT call /refresh first — refresh scrapes live URLs and can time out (30-90s),
      // silently blocking generation for all non-RHEL products. Product summaries are kept
      // fresh by the background scheduler; intel generation does not require a fresh scrape.
      const genRes = await fetch(`/api/products/${slug}/intel/${encodeURIComponent(customerSlug)}/generate`, {
        method: 'POST',
      })
      if (!genRes.ok) {
        const genErr = await genRes.json().catch(() => ({}))
        // If the error is "No cached summary", fall back to refreshing once
        if (genErr.error?.includes('No cached summary')) {
          const refreshRes = await fetch(`/api/products/${slug}/refresh`, { method: 'POST' })
          if (!refreshRes.ok) {
            const refreshErr = await refreshRes.json().catch(() => ({}))
            setError(`Failed to refresh ${productLabel(slug, productLabels)}: ${refreshErr.error ?? refreshRes.statusText}`)
            return
          }
          // Retry generate after refresh
          const retryRes = await fetch(`/api/products/${slug}/intel/${encodeURIComponent(customerSlug)}/generate`, {
            method: 'POST',
          })
          if (!retryRes.ok) {
            const retryErr = await retryRes.json().catch(() => ({}))
            setError(`Failed to generate ${productLabel(slug, productLabels)} intel: ${retryErr.error ?? retryRes.statusText}`)
            return
          }
        } else {
          setError(`Failed to generate ${productLabel(slug, productLabels)} intel: ${genErr.error ?? genRes.statusText}`)
          return
        }
      }
      // Fetch updated result (handles both successful generate and NONE-score results)
      const res = await fetch(`/api/products/${slug}/intel/${encodeURIComponent(customerSlug)}`)
      if (res.ok) {
        const data: CustomerProductIntel = await res.json()
        setIntel(prev => ({ ...prev, [slug]: data }))
      }
    } catch (e: any) {
      setError(`Error generating ${productLabel(slug, productLabels)} intel: ${e?.message ?? 'network error'}`)
    } finally {
      setRegenerating(prev => {
        const next = new Set(prev)
        next.delete(slug)
        return next
      })
    }
  }

  async function handleGenerateAll() {
    setGeneratingAll(true)
    setError(null)
    try {
      // BKL-REG-11: Call generate-all directly without pre-refreshing product summaries.
      // Summaries are kept fresh by background scheduler; pre-refresh causes serial 30-90s
      // scrape timeouts that block intel generation for all non-RHEL products.
      const genRes = await fetch(`/api/products/intel/${encodeURIComponent(customerSlug)}/generate-all`, {
        method: 'POST',
      })
      if (!genRes.ok) {
        const genErr = await genRes.json().catch(() => ({}))
        setError(`Generate all failed: ${genErr.error ?? genRes.statusText}`)
        return
      }
      // Re-fetch all cached intel after generation completes
      setRefreshKey(k => k + 1)
    } catch (e: any) {
      setError(`Error generating all intel: ${e?.message ?? 'network error'}`)
    } finally {
      setGeneratingAll(false)
    }
  }

  // Determine which products have visible intel (non-NONE cached) vs. uncached
  // BKL-REG-11: Include NONE-scored results in visible slugs so they render as "Not relevant"
  // rather than silently disappearing. Users need to see the result and be able to regenerate.
  const visibleSlugs = productSlugs.filter(slug => {
    const data = intel[slug]
    return data !== null && data !== undefined
  })
  const uncachedSlugs = productSlugs.filter(slug => intel[slug] === null || intel[slug] === undefined)

  // During loading — show skeleton
  if (loading) {
    return (
      <div className="bg-surface border border-border rounded-xl overflow-hidden">
        <div className="px-5 py-4 border-b border-border/60 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-accent" />
            <h2 className="text-sm font-semibold text-text-primary">Product Intelligence</h2>
          </div>
        </div>
        <div className="p-4 space-y-2">
          <Skeleton className="h-10" />
          <Skeleton className="h-10" />
          <Skeleton className="h-10" />
        </div>
      </div>
    )
  }

  return (
    <div className="bg-surface border border-border rounded-xl overflow-hidden">
      {/* Section header */}
      <div className="px-5 py-4 border-b border-border/60 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Sparkles className="w-4 h-4 text-accent" />
          <h2 className="text-sm font-semibold text-text-primary">Product Intelligence</h2>
          {visibleSlugs.filter(s => intel[s]?.relevanceScore !== 'NONE').length > 0 && (
            <span className="text-xs text-text-secondary">{visibleSlugs.filter(s => intel[s]?.relevanceScore !== 'NONE').length}</span>
          )}
        </div>
        <button
          onClick={handleGenerateAll}
          disabled={generatingAll}
          className="flex items-center gap-1.5 text-xs text-text-secondary hover:text-text-primary transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          title={`Generate intel for all products for ${customerName}`}
        >
          {generatingAll
            ? <Loader2 className="w-3 h-3 animate-spin" />
            : <Sparkles className="w-3 h-3" />
          }
          {generatingAll ? 'Generating...' : 'Generate All'}
        </button>
      </div>

      {/* Error banner */}
      {error && (
        <div className="mx-4 mt-3 px-3 py-2 bg-red-500/10 border border-red-500/30 rounded-lg flex items-start gap-2">
          <span className="text-red-400 text-xs flex-1">{error}</span>
          <button onClick={() => setError(null)} className="text-red-400/60 hover:text-red-400 text-xs shrink-0">dismiss</button>
        </div>
      )}

      {/* Product cards + uncached stubs */}
      <div className="p-4 space-y-3">
        {/* All cached product cards (including NONE-scored — visible so user can see result and regenerate) */}
        {visibleSlugs.length === 0 && uncachedSlugs.length === productSlugs.length && (
          <p className="text-xs text-text-secondary mb-3">
            Generate product talking points for {customerName} based on their subscriptions, cases, and product roadmaps.
          </p>
        )}
        {visibleSlugs.map(slug => (
          <ProductCard
            key={slug}
            slug={slug}
            label={productLabel(slug, productLabels)}
            intel={intel[slug]!}
            onRegenerate={handleRegenerate}
            regenerating={regenerating.has(slug)}
          />
        ))}

        {/* Uncached products — always visible with individual Generate button */}
        {uncachedSlugs.length > 0 && (
          <div className="space-y-2">
            {uncachedSlugs.map(slug => (
              <div key={slug} className="flex items-center justify-between py-2 px-3 bg-bg rounded-lg border border-border/60">
                <span className="text-sm font-medium text-text-secondary">{productLabel(slug, productLabels)}</span>
                <button
                  onClick={() => handleRegenerate(slug)}
                  disabled={regenerating.has(slug)}
                  className="flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-lg bg-accent/10 text-accent hover:bg-accent/20 border border-accent/20 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {regenerating.has(slug)
                    ? <Loader2 className="w-3 h-3 animate-spin" />
                    : <Sparkles className="w-3 h-3" />
                  }
                  Generate
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Neither cached nor uncached — should not happen, but guard */}
        {visibleSlugs.length === 0 && uncachedSlugs.length === 0 && (
          <p className="text-xs text-text-secondary">No products configured.</p>
        )}
      </div>
    </div>
  )
}
