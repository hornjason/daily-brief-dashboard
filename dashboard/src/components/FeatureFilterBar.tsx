import { Search, X } from 'lucide-react'

export type StatusFilter = 'All' | 'GA' | 'Tech Preview' | 'Coming Soon' | 'Deprecated'

const STATUS_PILLS: StatusFilter[] = ['All', 'GA', 'Tech Preview', 'Coming Soon', 'Deprecated']

interface FeatureFilterBarProps {
  products: { slug: string; displayName: string; shortName: string }[]
  selectedProduct: string | null
  onProductChange: (slug: string | null) => void
  selectedStatus: StatusFilter
  onStatusChange: (s: StatusFilter) => void
  search: string
  onSearchChange: (s: string) => void
  versionFilter: string
  onVersionChange: (v: string) => void
  versions: string[]
  activeTags: string[]
  onRemoveTag: (tag: string) => void
}

export function FeatureFilterBar({
  products,
  selectedProduct,
  onProductChange,
  selectedStatus,
  onStatusChange,
  search,
  onSearchChange,
  versionFilter,
  onVersionChange,
  versions,
  activeTags,
  onRemoveTag,
}: FeatureFilterBarProps) {
  const activePill = 'bg-accent/20 text-accent border border-accent/40'
  const inactivePill = 'text-text-secondary border border-transparent hover:border-border'

  return (
    <div className="flex flex-col gap-2">
      {/* Row 1 */}
      <div className="flex items-center gap-2 flex-wrap">
        {/* Product pills */}
        <button
          onClick={() => onProductChange(null)}
          className={`text-xs px-3 py-1 rounded-full transition-colors ${selectedProduct === null ? activePill : inactivePill}`}
        >
          All
        </button>
        {products.map(p => (
          <button
            key={p.slug}
            onClick={() => onProductChange(p.slug)}
            className={`text-xs px-3 py-1 rounded-full transition-colors ${selectedProduct === p.slug ? activePill : inactivePill}`}
          >
            {p.shortName}
          </button>
        ))}

        {/* Divider */}
        <span className="w-px h-4 bg-border/60 shrink-0" />

        {/* Status pills */}
        {STATUS_PILLS.map(s => (
          <button
            key={s}
            onClick={() => onStatusChange(s)}
            className={`text-xs px-3 py-1 rounded-full transition-colors ${selectedStatus === s ? activePill : inactivePill}`}
          >
            {s}
          </button>
        ))}

        {/* Search input */}
        <div className="relative ml-auto">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3 h-3 text-text-secondary" />
          <input
            type="text"
            placeholder="Search features..."
            value={search}
            onChange={e => onSearchChange(e.target.value)}
            className="bg-surface border border-border rounded-lg pl-7 pr-3 py-1.5 text-xs text-text-primary placeholder-text-secondary focus:outline-none focus:border-accent/50 w-52"
          />
        </div>

        {/* Version dropdown */}
        {versions.length > 1 && (
          <select
            value={versionFilter}
            onChange={e => onVersionChange(e.target.value)}
            className="text-xs bg-surface border border-border rounded-lg px-2 py-1.5 text-text-secondary focus:outline-none focus:border-accent/50"
          >
            {versions.map(v => (
              <option key={v} value={v}>{v === 'All' ? 'All Versions' : `v${v}`}</option>
            ))}
          </select>
        )}
      </div>

      {/* Row 2 — active tags */}
      {activeTags.length > 0 && (
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs text-text-secondary">Active tags:</span>
          {activeTags.map(tag => (
            <span
              key={tag}
              className="flex items-center gap-1 text-xs bg-accent/10 text-accent border border-accent/30 px-2 py-0.5 rounded-full"
            >
              {tag}
              <button
                onClick={() => onRemoveTag(tag)}
                className="hover:text-accent/60 transition-colors"
                aria-label={`Remove tag ${tag}`}
              >
                <X className="w-3 h-3" />
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  )
}
