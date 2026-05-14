import { useState, useEffect, useCallback, useMemo } from 'react'
import { ProductReleaseBanner } from '../components/ProductReleaseBanner'
import { FeatureFilterBar } from '../components/FeatureFilterBar'
import { SpotlightStrip } from '../components/SpotlightStrip'
import { ProductFeatureGroup } from '../components/ProductFeatureGroup'
import { FeatureDetailPanel } from '../components/FeatureDetailPanel'
import type { ProductSummary, ProductAlert } from '../components/ProductCard'
import type { StatusFilter } from '../components/FeatureFilterBar'
import { RefreshCw, FileText, Users, AlertTriangle } from 'lucide-react'

// ── Feature types ────────────────────────────────────────────────────────────

interface ProductFeature {
  id: string; featureSlug: string; name: string
  status: 'GA' | 'Tech Preview' | 'Roadmap' | 'Deprecated'
  versionIntroduced: string | null; versionCurrent: string | null
  description: string; enrichedDescription: string | null
  sourceUrls: string[]; enrichmentUrls: string[]; tags: string[]
  confidence: 'HIGH' | 'MEDIUM' | 'LOW'; slideSource: string
  releaseNotesSection?: string | null
}

interface ProductFeatureCache {
  slug: string; displayName: string; features: ProductFeature[]
  corpusHash: string; summaryHash: string; extractedAt: string; enrichedAt: string | null
}

// ── Territory summary types ──────────────────────────────────────────────

interface TerritorySummary {
  slug: string
  coverageCount: number
  totalCustomers: number
  coverageBreakdown: { HIGH: number; MEDIUM: number; LOW: number; NONE: number }
  topPriorityActions: { action: string; customer: string; confidence: string }[]
  lastUpdated: string | null
  slidesStatus: { filesIngested: number; lastRefreshed: string | null }
  featureStatus: { featureCount: number; extractedAt: string; enrichedAt: string | null } | null
}

// ── Territory Radar Card ─────────────────────────────────────────────────

function TerritoryRadarCard({
  summary,
  territorySummary,
  loading: cardLoading,
  onRefreshSlides,
  refreshingSlides,
}: {
  summary: ProductSummary
  territorySummary: TerritorySummary | null
  loading: boolean
  onRefreshSlides: (slug: string) => void
  refreshingSlides: boolean
}) {
  if (cardLoading) {
    return (
      <div className="bg-surface border border-border rounded-xl p-5 mb-4 animate-pulse">
        <div className="h-4 bg-surface-hover rounded w-1/3 mb-3" />
        <div className="h-3 bg-surface-hover rounded w-2/3" />
      </div>
    )
  }

  const ts = territorySummary
  const bd = ts?.coverageBreakdown ?? { HIGH: 0, MEDIUM: 0, LOW: 0, NONE: 0 }

  return (
    <div className="bg-surface border border-border rounded-xl p-5 mb-4">
      {/* Compact header */}
      <div className="flex items-center gap-3 mb-4">
        <h2 className="text-base font-semibold text-text-primary">{summary.displayName}</h2>
        {summary.currentVersion && (
          <span className="text-xs font-mono bg-surface-hover border border-border px-2 py-0.5 rounded-full text-text-secondary">
            v{summary.currentVersion}
          </span>
        )}
        {summary.gaDate && (
          <span className="text-xs text-text-secondary">GA {summary.gaDate}</span>
        )}
        {summary.eolDate && (
          <span className="text-xs text-critical/70">EOL {summary.eolDate}</span>
        )}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {/* Territory Coverage */}
        <div className="bg-surface-hover/50 border border-border/50 rounded-lg p-4">
          <div className="flex items-center gap-2 mb-2">
            <Users className="w-4 h-4 text-text-secondary" />
            <span className="text-xs font-medium text-text-secondary uppercase tracking-wide">Territory Coverage</span>
          </div>
          <div className="text-2xl font-bold text-text-primary mb-1">
            {ts?.coverageCount ?? 0} <span className="text-sm font-normal text-text-secondary">of {ts?.totalCustomers ?? 0}</span>
          </div>
          <div className="flex gap-2 text-xs">
            {bd.HIGH > 0 && <span className="text-emerald-400">{bd.HIGH} HIGH</span>}
            {bd.MEDIUM > 0 && <span className="text-amber-400">{bd.MEDIUM} MED</span>}
            {bd.LOW > 0 && <span className="text-text-secondary">{bd.LOW} LOW</span>}
            {bd.NONE > 0 && <span className="text-text-secondary/50">{bd.NONE} NONE</span>}
          </div>
          {ts?.lastUpdated && (
            <div className="text-[10px] text-text-secondary mt-2">
              Updated {new Date(ts.lastUpdated).toLocaleDateString()}
            </div>
          )}
        </div>

        {/* Top Priority Actions */}
        <div className="bg-surface-hover/50 border border-border/50 rounded-lg p-4">
          <div className="flex items-center gap-2 mb-2">
            <AlertTriangle className="w-4 h-4 text-text-secondary" />
            <span className="text-xs font-medium text-text-secondary uppercase tracking-wide">Top Priority Actions</span>
          </div>
          {ts?.topPriorityActions.length ? (
            <ul className="space-y-2">
              {ts.topPriorityActions.map((pa, i) => (
                <li key={i} className="text-xs text-text-primary leading-relaxed">
                  <span className={`inline-block w-1.5 h-1.5 rounded-full mr-1.5 ${
                    pa.confidence === 'HIGH' ? 'bg-emerald-400' : pa.confidence === 'MEDIUM' ? 'bg-amber-400' : 'bg-text-secondary'
                  }`} />
                  <span className="font-medium text-text-secondary">{pa.customer}:</span>{' '}
                  {pa.action}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-text-secondary">No priority actions generated yet.</p>
          )}
        </div>

        {/* Slide Corpus Status */}
        <div className="bg-surface-hover/50 border border-border/50 rounded-lg p-4">
          <div className="flex items-center gap-2 mb-2">
            <FileText className="w-4 h-4 text-text-secondary" />
            <span className="text-xs font-medium text-text-secondary uppercase tracking-wide">Slide Corpus</span>
          </div>
          <div className="text-sm text-text-primary mb-1">
            {ts?.slidesStatus.filesIngested ?? 0} files ingested
          </div>
          {ts?.slidesStatus.lastRefreshed && (
            <div className="text-[10px] text-text-secondary mb-2">
              Refreshed {new Date(ts.slidesStatus.lastRefreshed).toLocaleDateString()}
            </div>
          )}
          {ts?.featureStatus && (
            <div className="text-[10px] text-text-secondary">
              {ts.featureStatus.featureCount} features extracted
            </div>
          )}
          <button
            onClick={() => onRefreshSlides(summary.slug)}
            disabled={refreshingSlides}
            className="mt-2 flex items-center gap-1.5 text-xs text-accent hover:text-accent/80 disabled:opacity-50 transition-colors"
          >
            <RefreshCw className={`w-3 h-3 ${refreshingSlides ? 'animate-spin' : ''}`} />
            Refresh slides
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Component ────────────────────────────────────────────────────────────────

export function ProductsPage() {
  const [summaries, setSummaries] = useState<ProductSummary[]>([])
  const [alerts, setAlerts] = useState<ProductAlert[]>([])
  const [featureCaches, setFeatureCaches] = useState<ProductFeatureCache[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [refreshingSlug, setRefreshingSlug] = useState<string | null>(null)
  const [refreshingAll, setRefreshingAll] = useState(false)

  // Territory radar
  const [territorySummaries, setTerritorySummaries] = useState<Map<string, TerritorySummary>>(new Map())
  const [territoryLoading, setTerritoryLoading] = useState<Set<string>>(new Set())
  const [refreshingSlidesSlug, setRefreshingSlidesSlug] = useState<string | null>(null)

  // Filters
  const [selectedProduct, setSelectedProduct] = useState<string | null>(null)
  const [selectedStatus, setSelectedStatus] = useState<StatusFilter>('All')
  const [search, setSearch] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [versionFilter, setVersionFilter] = useState('All')
  const [activeTags, setActiveTags] = useState<string[]>([])

  // Detail panel
  const [selectedFeature, setSelectedFeature] = useState<(ProductFeature & {
    productSlug: string
    productDisplayName: string
    isNew: boolean
  }) | null>(null)

  // ── Data loading ─────────────────────────────────────────────────────────

  const fetchData = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [sumRes, alertRes, featRes] = await Promise.all([
        fetch('/api/products'),
        fetch('/api/products/alerts'),
        fetch('/api/products/features'),
      ])
      if (!sumRes.ok) throw new Error(`Failed to load product summaries (HTTP ${sumRes.status})`)
      if (!alertRes.ok) throw new Error(`Failed to load alerts (HTTP ${alertRes.status})`)
      setSummaries(await sumRes.json())
      setAlerts(await alertRes.json())
      if (featRes.ok) setFeatureCaches(await featRes.json())
    } catch (e: any) {
      setError(e?.message ?? 'Failed to load product data')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { fetchData() }, [fetchData])

  // Fetch territory summaries for all products once summaries are loaded
  useEffect(() => {
    if (summaries.length === 0) return
    for (const s of summaries) {
      if (territorySummaries.has(s.slug)) continue
      setTerritoryLoading(prev => new Set(prev).add(s.slug))
      fetch(`/api/products/${s.slug}/territory-summary`)
        .then(r => r.ok ? r.json() : null)
        .then((data: TerritorySummary | null) => {
          if (data) {
            setTerritorySummaries(prev => {
              const next = new Map(prev)
              next.set(s.slug, data)
              return next
            })
          }
        })
        .catch(() => {})
        .finally(() => {
          setTerritoryLoading(prev => {
            const next = new Set(prev)
            next.delete(s.slug)
            return next
          })
        })
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [summaries])

  useEffect(() => {
    document.title = 'Product Intelligence | ASA Command Center'
    return () => { document.title = 'ASA Command Center' }
  }, [])

  // ── Debounce search ───────────────────────────────────────────────────────

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 200)
    return () => clearTimeout(t)
  }, [search])

  // ── Handlers ─────────────────────────────────────────────────────────────

  async function handleRefreshAll() {
    setRefreshingAll(true)
    setError(null)
    try {
      // Refresh product summaries (scrape release notes)
      const res = await fetch('/api/products/refresh-all', { method: 'POST' })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d.error ?? `HTTP ${res.status}`)
      }
      const data = await res.json()
      setSummaries(data.products ?? [])

      // Re-extract features from updated summaries
      const featRefresh = await fetch('/api/products/features/refresh-all', { method: 'POST' })
      if (featRefresh.ok) {
        const featRes = await fetch('/api/products/features')
        if (featRes.ok) setFeatureCaches(await featRes.json())
      }
    } catch (e: any) {
      setError(e?.message ?? 'Refresh all failed')
    } finally {
      setRefreshingAll(false)
    }
  }

  function handleAcknowledge(id: string) {
    setAlerts(prev => prev.map(a => a.id === id ? { ...a, acknowledged: true } : a))
  }

  async function handleRefreshSlides(slug: string) {
    setRefreshingSlidesSlug(slug)
    try {
      const res = await fetch('/api/products/ingest-slides', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug }),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        console.error(`Slide refresh failed for ${slug}:`, d.error ?? `HTTP ${res.status}`)
      }
      // Re-fetch territory summary for this product
      const tsRes = await fetch(`/api/products/${slug}/territory-summary`)
      if (tsRes.ok) {
        const data: TerritorySummary = await tsRes.json()
        setTerritorySummaries(prev => {
          const next = new Map(prev)
          next.set(slug, data)
          return next
        })
      }
    } catch (e: any) {
      console.error(`Slide refresh failed for ${slug}:`, e?.message)
    } finally {
      setRefreshingSlidesSlug(null)
    }
  }

  async function handleRefreshFeatures(slug: string) {
    setRefreshingSlug(slug)
    try {
      const res = await fetch(`/api/products/${slug}/features/refresh`, { method: 'POST' })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d.error ?? `HTTP ${res.status}`)
      }
      const updated: ProductFeatureCache = await res.json()
      setFeatureCaches(prev => {
        const idx = prev.findIndex(c => c.slug === slug)
        if (idx >= 0) {
          const next = [...prev]
          next[idx] = updated
          return next
        }
        return [...prev, updated]
      })
    } catch (e: any) {
      console.error(`Feature refresh failed for ${slug}:`, e?.message)
    } finally {
      setRefreshingSlug(null)
    }
  }

  function handleTagClick(tag: string) {
    setActiveTags(prev => prev.includes(tag) ? prev : [...prev, tag])
    setSearch('')
  }

  function handleRemoveTag(tag: string) {
    setActiveTags(prev => prev.filter(t => t !== tag))
  }

  function handleFeatureSelect(
    f: ProductFeature & { productSlug: string; productDisplayName?: string; isNew: boolean }
  ) {
    const summary = summaries.find(s => s.slug === f.productSlug)
    setSelectedFeature({
      ...f,
      productDisplayName: f.productDisplayName ?? summary?.displayName ?? f.productSlug,
    })
  }

  // ── Derived data ──────────────────────────────────────────────────────────

  const featureMap = useMemo(() => {
    const m = new Map<string, ProductFeatureCache>()
    for (const c of featureCaches) m.set(c.slug, c)
    return m
  }, [featureCaches])

  // Visible summaries (respects selectedProduct filter)
  const visibleSummaries = useMemo(() => {
    if (!selectedProduct) return summaries
    return summaries.filter(s => s.slug === selectedProduct)
  }, [summaries, selectedProduct])

  // Filter function applied per product
  function filterFeatures(features: ProductFeature[], _currentVersion: string | null): ProductFeature[] {
    return features.filter(f => {
      if (selectedStatus !== 'All') {
        if (selectedStatus === 'Coming Soon' && f.status !== 'Roadmap') return false
        if (selectedStatus !== 'Coming Soon' && f.status !== selectedStatus) return false
      }
      if (versionFilter !== 'All' && f.versionIntroduced !== versionFilter) return false
      if (activeTags.length > 0 && !activeTags.some(t => f.tags.includes(t))) return false
      if (debouncedSearch) {
        const hay = `${f.name} ${f.description} ${f.enrichedDescription ?? ''} ${f.tags.join(' ')}`.toLowerCase()
        if (!hay.includes(debouncedSearch.toLowerCase())) return false
      }
      return true
    })
  }

  // All unique versions across visible products (or selected product)
  const versions = useMemo(() => {
    const sourceCaches = selectedProduct
      ? featureCaches.filter(c => c.slug === selectedProduct)
      : featureCaches
    const all = sourceCaches.flatMap(c => c.features.map(f => f.versionIntroduced).filter(Boolean) as string[])
    const unique = Array.from(new Set(all)).sort((a, b) => {
      const av = a.split('.').map(Number)
      const bv = b.split('.').map(Number)
      for (let i = 0; i < Math.max(av.length, bv.length); i++) {
        const d = (bv[i] ?? 0) - (av[i] ?? 0)
        if (d !== 0) return d
      }
      return 0
    })
    return ['All', ...unique]
  }, [featureCaches, selectedProduct])

  // Spotlight features — all features across visible products (or selected), scored
  const spotlightFeatures = useMemo(() => {
    const result: (ProductFeature & { productSlug: string; productShortName: string; isNew: boolean })[] = []
    const sourceSummaries = selectedProduct
      ? summaries.filter(s => s.slug === selectedProduct)
      : summaries
    for (const s of sourceSummaries) {
      const cache = featureMap.get(s.slug)
      if (!cache) continue
      const filtered = filterFeatures(cache.features, s.currentVersion)
      for (const f of filtered) {
        result.push({
          ...f,
          productSlug: s.slug,
          productShortName: s.shortName,
          isNew: !!(s.currentVersion && f.versionIntroduced?.includes(s.currentVersion)),
        })
      }
    }
    return result
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [summaries, featureMap, selectedProduct, selectedStatus, versionFilter, activeTags, debouncedSearch])

  // Products list for the filter bar
  const productPills = useMemo(() => summaries.map(s => ({
    slug: s.slug,
    displayName: s.displayName,
    shortName: s.shortName,
  })), [summaries])

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="flex-1 flex flex-col">
      <ProductReleaseBanner
        alerts={alerts}
        summaries={summaries}
        onAcknowledge={handleAcknowledge}
      />

      <main className="flex-1 overflow-y-auto p-6">
        <div className="flex items-center justify-between mb-4">
          <h1 className="text-xl font-semibold text-text-primary">Product Intelligence</h1>
          <button
            onClick={handleRefreshAll}
            disabled={refreshingAll}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-text-secondary hover:text-text-primary border border-border rounded-lg hover:bg-surface-hover transition-colors disabled:opacity-50"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${refreshingAll ? 'animate-spin' : ''}`} />
            {refreshingAll ? 'Refreshing all…' : 'Refresh All'}
          </button>
        </div>

        {/* Loading skeleton */}
        {loading && (
          <div className="space-y-4">
            {[0, 1, 2].map(i => (
              <div key={i} className="bg-surface border border-border rounded-xl p-5 h-24 animate-pulse" />
            ))}
          </div>
        )}

        {/* Error */}
        {error && (
          <div className="bg-critical/10 border border-critical/30 rounded-lg p-4 text-sm text-critical">
            {error}
            <button onClick={fetchData} className="ml-3 underline hover:no-underline">Retry</button>
          </div>
        )}

        {/* Empty */}
        {!loading && !error && summaries.length === 0 && (
          <div className="text-sm text-text-secondary">
            No product data cached yet. Use the Refresh button on a product or wait for the weekly sync.
          </div>
        )}

        {/* Main content */}
        {!loading && summaries.length > 0 && (
          <>
            <FeatureFilterBar
              products={productPills}
              selectedProduct={selectedProduct}
              onProductChange={setSelectedProduct}
              selectedStatus={selectedStatus}
              onStatusChange={setSelectedStatus}
              search={search}
              onSearchChange={setSearch}
              versionFilter={versionFilter}
              onVersionChange={setVersionFilter}
              versions={versions}
              activeTags={activeTags}
              onRemoveTag={handleRemoveTag}
            />

            {/* Spotlight strip */}
            {spotlightFeatures.length > 0 && (
              <div className="my-4">
                <SpotlightStrip
                  features={spotlightFeatures}
                  onSelect={f => {
                    const summary = summaries.find(s => s.slug === f.productSlug)
                    handleFeatureSelect({
                      ...f,
                      productDisplayName: summary?.displayName ?? f.productSlug,
                    })
                  }}
                />
              </div>
            )}

            {/* Territory Radar Cards */}
            <div className="mt-4">
              {visibleSummaries.map(s => (
                <TerritoryRadarCard
                  key={`radar-${s.slug}`}
                  summary={s}
                  territorySummary={territorySummaries.get(s.slug) ?? null}
                  loading={territoryLoading.has(s.slug)}
                  onRefreshSlides={handleRefreshSlides}
                  refreshingSlides={refreshingSlidesSlug === s.slug}
                />
              ))}
            </div>

            {/* Feature list grouped by product */}
            <div className="mt-4 divide-y divide-border/40">
              {visibleSummaries.map(summary => {
                const cache = featureMap.get(summary.slug)
                const allFeatures = cache?.features ?? []
                const filteredFeatures = filterFeatures(allFeatures, summary.currentVersion)

                return (
                  <ProductFeatureGroup
                    key={summary.slug}
                    summary={summary}
                    features={filteredFeatures}
                    allFeatures={allFeatures}
                    currentVersion={summary.currentVersion}
                    onFeatureSelect={f => handleFeatureSelect({
                      ...f,
                      productSlug: summary.slug,
                      productDisplayName: summary.displayName,
                      isNew: !!(summary.currentVersion && f.versionIntroduced?.includes(summary.currentVersion)),
                    })}
                    onTagClick={handleTagClick}
                    onRefresh={handleRefreshFeatures}
                    refreshing={refreshingSlug === summary.slug}
                    extractedAt={cache?.extractedAt ?? null}
                  />
                )
              })}
            </div>
          </>
        )}
      </main>

      <FeatureDetailPanel
        feature={selectedFeature}
        onClose={() => setSelectedFeature(null)}
        onTagClick={tag => { handleTagClick(tag); setSelectedFeature(null) }}
      />
    </div>
  )
}
