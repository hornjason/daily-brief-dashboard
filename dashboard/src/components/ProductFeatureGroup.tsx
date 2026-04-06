import { useState } from 'react'
import { ChevronDown, ChevronRight, RefreshCw } from 'lucide-react'
import { FeatureListRow } from './FeatureListRow'
import type { ProductSummary } from './ProductCard'

interface ProductFeature {
  id: string
  featureSlug: string
  name: string
  status: 'GA' | 'Tech Preview' | 'Roadmap' | 'Deprecated'
  versionIntroduced: string | null
  versionCurrent: string | null
  description: string
  enrichedDescription: string | null
  sourceUrls: string[]
  enrichmentUrls: string[]
  tags: string[]
  confidence: 'HIGH' | 'MEDIUM' | 'LOW'
  slideSource: string
  releaseNotesSection?: string | null
}

interface ProductFeatureGroupProps {
  summary: ProductSummary
  features: ProductFeature[]
  allFeatures: ProductFeature[]
  currentVersion: string | null
  onFeatureSelect: (f: ProductFeature) => void
  onTagClick: (tag: string) => void
  onRefresh: (slug: string) => void
  refreshing: boolean
  extractedAt: string | null
}

const PAGE_SIZE = 10

export function ProductFeatureGroup({
  summary,
  features,
  allFeatures,
  currentVersion,
  onFeatureSelect,
  onTagClick,
  onRefresh,
  refreshing,
  extractedAt,
}: ProductFeatureGroupProps) {
  const [collapsed, setCollapsed] = useState(false)
  const [showAll, setShowAll] = useState(false)

  const isFiltered = features.length !== allFeatures.length
  const techPreviewCount = features.filter(f => f.status === 'Tech Preview').length
  const visibleFeatures = showAll ? features : features.slice(0, PAGE_SIZE)

  function isNew(f: ProductFeature): boolean {
    return !!(currentVersion && f.versionIntroduced?.includes(currentVersion))
  }

  return (
    <div className="py-1">
      {/* Group header */}
      <div
        className="flex items-center gap-3 py-3 px-1 cursor-pointer select-none"
        onClick={() => setCollapsed(c => !c)}
      >
        {/* Collapse toggle */}
        {collapsed
          ? <ChevronRight className="w-4 h-4 text-text-secondary shrink-0" />
          : <ChevronDown className="w-4 h-4 text-text-secondary shrink-0" />
        }

        {/* Product name */}
        <span className="text-sm font-semibold text-text-primary">
          {summary.displayName}
        </span>

        {/* Version badge */}
        {currentVersion && (
          <span className="text-xs font-mono bg-surface-hover border border-border px-2 py-0.5 rounded-full text-text-secondary shrink-0">
            v{currentVersion}
          </span>
        )}

        {/* Feature count */}
        <span className="text-xs text-text-secondary shrink-0">
          {isFiltered ? `${features.length} of ${allFeatures.length}` : `${features.length}`} features
        </span>

        {/* Extraction timestamp */}
        {extractedAt && (
          <span className="text-[10px] text-text-secondary hidden md:block">
            Extracted {new Date(extractedAt).toLocaleDateString()}
          </span>
        )}

        {/* Tech Preview count badge — pushed right */}
        {techPreviewCount > 0 && (
          <span className="ml-auto text-xs bg-amber-500/15 text-amber-400 border border-amber-500/30 px-1.5 py-0.5 rounded shrink-0">
            {techPreviewCount} Tech Preview
          </span>
        )}

        {/* Refresh button */}
        <button
          onClick={e => { e.stopPropagation(); onRefresh(summary.slug) }}
          disabled={refreshing}
          className="p-1.5 rounded border border-border text-text-secondary hover:text-text-primary hover:border-border/80 transition-colors disabled:opacity-50 shrink-0"
          title="Refresh features"
          aria-label="Refresh features"
        >
          <RefreshCw className={`w-3 h-3 ${refreshing ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {/* Feature rows */}
      {!collapsed && (
        <div className="pl-7">
          {features.length === 0 ? (
            <p className="text-xs text-text-secondary py-3 px-3">
              {allFeatures.length === 0 ? 'No features extracted yet.' : 'No features match the current filter.'}
            </p>
          ) : (
            <>
              {visibleFeatures.map(f => (
                <FeatureListRow
                  key={f.id}
                  feature={f}
                  isNew={isNew(f)}
                  onSelect={() => onFeatureSelect(f)}
                  onTagClick={onTagClick}
                />
              ))}
              {!showAll && features.length > PAGE_SIZE && (
                <button
                  onClick={e => { e.stopPropagation(); setShowAll(true) }}
                  className="mt-1 ml-3 text-xs text-accent hover:underline"
                >
                  Show all {features.length} features
                </button>
              )}
              {showAll && features.length > PAGE_SIZE && (
                <button
                  onClick={e => { e.stopPropagation(); setShowAll(false) }}
                  className="mt-1 ml-3 text-xs text-text-secondary hover:text-text-primary"
                >
                  Show fewer
                </button>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}
